//! One task per open board. It owns the board's `Authority` and handles commands one at a time,
//! so the engine needs no locking. Every acknowledgement or rejection is written to SQLite
//! before anyone hears about it (spec §9, "durable before ack").

use crate::store::{Store, StoreError};
use mapcro_engine::wire::{Base, CloseReason, LinkRole, PeerPresence, Presence, WireOut};
use mapcro_engine::{Authority, ClientMsg, ConnId, Effect, Role, ServerMsg};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

/// Outbound frames per connection. A client this far behind is dropped rather than letting it
/// stall the room.
const OUTBOX_DEPTH: usize = 4096;
/// A room with nobody in it unloads after this long (spec §9, room lifecycle).
pub const IDLE_UNLOAD: std::time::Duration = std::time::Duration::from_secs(300);

pub enum RoomCmd {
    Join {
        link_hash: String,
        role: LinkRole,
        want_base: bool,
        reply: oneshot::Sender<Result<Joined, CloseReason>>,
    },
    Msg { conn: ConnId, msg: ClientMsg },
    Presence { conn: ConnId, state: Presence },
    Leave { conn: ConnId },
    /// The board as it is now (for cloning).
    Snapshot { reply: oneshot::Sender<mapcro_schema::Doc> },
    Revoke { link_hash: String },
}

struct Peer {
    link_hash: String,
    role: LinkRole,
    out: mpsc::Sender<WireOut>,
    presence: Option<Presence>,
}

/// Presence is batched: changes collect for this long, then go out as one frame per peer.
const PRESENCE_BATCH: std::time::Duration = std::time::Duration::from_millis(50);

struct Room {
    id: String,
    store: Store,
    authority: Authority,
    base: Base,
    peers: HashMap<ConnId, Peer>,
    next_conn: u64,
    idle: std::time::Duration,
    /// Peers whose presence changed (or who left) since the last batch.
    presence_dirty: Vec<(u64, LinkRole)>,
    flush_at: Option<tokio::time::Instant>,
}

pub type Joined = (ConnId, mpsc::Receiver<WireOut>, Option<Base>);

/// Sessions per room. Beyond this, joins are refused (security review M1).
pub const MAX_SESSIONS: usize = 64;

#[derive(Clone)]
pub struct Rooms {
    store: Store,
    idle: std::time::Duration,
    open: Arc<Mutex<HashMap<String, mpsc::Sender<RoomCmd>>>>,
}

#[derive(Debug, thiserror::Error)]
pub enum RoomError {
    #[error("no such board")]
    NotFound,
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("stored log does not replay: {0}")]
    Replay(mapcro_schema::Reject),
    #[error("room unavailable")]
    Unavailable,
}

impl Rooms {
    pub fn new(store: Store, idle: std::time::Duration) -> Rooms {
        Rooms { store, idle, open: Arc::new(Mutex::new(HashMap::new())) }
    }

    /// The room for `board`, loading it from storage on first use.
    pub async fn get(&self, board: &str) -> Result<mpsc::Sender<RoomCmd>, RoomError> {
        if let Some(tx) = self.lookup(board) {
            return Ok(tx);
        }
        let stored = self.store.load_board(board.to_owned()).await?.ok_or(RoomError::NotFound)?;
        let mut authority = Authority::new(stored.base.clone());
        for tx in stored.log {
            authority.replay(tx).map_err(RoomError::Replay)?;
        }
        for (client, cseq, reason) in stored.rejections {
            authority.replay_rejection(client, cseq, reason);
        }
        for (client, secret_hash) in stored.clients {
            authority.replay_client(client, secret_hash);
        }
        // Two loads may race; the first to insert wins and the other's work is dropped.
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = open.get(board).filter(|t| !t.is_closed()) {
            return Ok(tx.clone());
        }
        let (tx, rx) = mpsc::channel(1024);
        let room = Room {
            id: board.to_owned(),
            store: self.store.clone(),
            authority,
            base: Base { doc: stored.base, seq: stored.base_seq },
            peers: HashMap::new(),
            next_conn: 0,
            idle: self.idle,
            presence_dirty: Vec::new(),
            flush_at: None,
        };
        let registry = self.clone();
        let sender = tx.clone();
        let id = board.to_owned();
        tokio::spawn(async move {
            room.run(rx).await;
            registry.forget(&id, &sender);
            tracing::info!(board = id, "room closed");
        });
        open.insert(board.to_owned(), tx.clone());
        tracing::info!(board, "room opened");
        Ok(tx)
    }

    /// The room if it's open, without loading it.
    pub fn lookup(&self, board: &str) -> Option<mpsc::Sender<RoomCmd>> {
        let open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        open.get(board).filter(|t| !t.is_closed()).cloned()
    }

    /// Join a board's room. Retries if the room unloaded between lookup and join.
    pub async fn join(
        &self,
        board: &str,
        link_hash: String,
        role: LinkRole,
        want_base: bool,
    ) -> Result<(mpsc::Sender<RoomCmd>, Result<Joined, CloseReason>), RoomError> {
        for _ in 0..3 {
            let room = self.get(board).await?;
            let (reply, joined) = oneshot::channel();
            let cmd = RoomCmd::Join { link_hash: link_hash.clone(), role, want_base, reply };
            if room.send(cmd).await.is_ok()
                && let Ok(j) = joined.await
            {
                return Ok((room, j));
            }
            self.forget(board, &room);
        }
        Err(RoomError::Unavailable)
    }

    fn forget(&self, board: &str, room: &mpsc::Sender<RoomCmd>) {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        if open.get(board).is_some_and(|t| t.same_channel(room)) {
            open.remove(board);
        }
    }

    /// The board's current document, loading the room if needed.
    pub async fn snapshot(&self, board: &str) -> Result<mapcro_schema::Doc, RoomError> {
        for _ in 0..3 {
            let room = self.get(board).await?;
            let (reply, rx) = oneshot::channel();
            if room.send(RoomCmd::Snapshot { reply }).await.is_ok()
                && let Ok(doc) = rx.await
            {
                return Ok(doc);
            }
            self.forget(board, &room);
        }
        Err(RoomError::Unavailable)
    }

    pub fn open_count(&self) -> usize {
        self.open.lock().map(|o| o.values().filter(|t| !t.is_closed()).count()).unwrap_or(0)
    }
}

impl Room {
    async fn run(mut self, mut rx: mpsc::Receiver<RoomCmd>) {
        loop {
            if let Some(at) = self.flush_at {
                tokio::select! {
                    cmd = rx.recv() => match cmd {
                        Some(cmd) => { if self.dispatch(cmd).await.is_err() { return self.fail_all(); } }
                        None => return,
                    },
                    _ = tokio::time::sleep_until(at) => self.flush_presence(),
                }
                continue;
            }
            let cmd = if self.peers.is_empty() {
                match tokio::time::timeout(self.idle, rx.recv()).await {
                    Ok(Some(cmd)) => cmd,
                    // Idle long enough, or every sender is gone: unload. Every acknowledged
                    // edit is already on disk, so there is nothing to flush.
                    Ok(None) | Err(_) => return,
                }
            } else {
                match rx.recv().await {
                    Some(cmd) => cmd,
                    None => return,
                }
            };
            if self.dispatch(cmd).await.is_err() {
                return self.fail_all();
            }
        }
    }

    /// Crash-only: if storage fails we cannot promise durability, so stop serving this board.
    /// Clients keep their pending work and reconnect to a fresh room.
    fn fail_all(&mut self) {
        tracing::error!(board = self.id, "storage failed; closing room");
        let all: Vec<ConnId> = self.peers.keys().copied().collect();
        for conn in all {
            self.close(conn, CloseReason::StorageFailure);
        }
    }

    async fn dispatch(&mut self, cmd: RoomCmd) -> Result<(), StoreError> {
        {
            let result = match cmd {
                RoomCmd::Join { link_hash, role, want_base, reply } => {
                    self.join(link_hash, role, want_base, reply);
                    Ok(())
                }
                RoomCmd::Msg { conn, msg } => self.message(conn, msg).await,
                RoomCmd::Presence { conn, mut state } => {
                    if let Some(peer) = self.peers.get_mut(&conn) {
                        if peer.role == LinkRole::View {
                            // The laser and drag previews are editing gestures (operator,
                            // 2026-11-06): a view link's are dropped, not relayed.
                            state.laser.clear();
                            state.drag = None;
                        }
                        peer.presence = Some(state);
                        let role = peer.role;
                        self.mark_presence(conn, role);
                    }
                    Ok(())
                }
                RoomCmd::Leave { conn } => {
                    self.forget_peer(conn);
                    Ok(())
                }
                RoomCmd::Snapshot { reply } => {
                    let _ = reply.send(self.authority.doc().clone());
                    Ok(())
                }
                RoomCmd::Revoke { link_hash } => {
                    let gone: Vec<ConnId> =
                        self.peers.iter().filter(|(_, p)| p.link_hash == link_hash).map(|(c, _)| *c).collect();
                    for conn in gone {
                        self.close(conn, CloseReason::Revoked);
                    }
                    Ok(())
                }
            };
            if let Err(e) = &result {
                tracing::error!(board = self.id, error = %e, "storage write failed");
            }
            result
        }
    }

    fn mark_presence(&mut self, conn: ConnId, role: LinkRole) {
        if !self.presence_dirty.iter().any(|(p, _)| *p == conn.0) {
            self.presence_dirty.push((conn.0, role));
        }
        self.flush_at.get_or_insert_with(|| tokio::time::Instant::now() + PRESENCE_BATCH);
    }

    /// A peer left: drop it from the engine and tell the others it's gone.
    fn forget_peer(&mut self, conn: ConnId) {
        self.authority.disconnect(conn);
        if let Some(peer) = self.peers.remove(&conn)
            && peer.presence.is_some()
        {
            self.mark_presence(conn, peer.role);
        }
    }

    fn flush_presence(&mut self) {
        self.flush_at = None;
        let batch: Vec<PeerPresence> = std::mem::take(&mut self.presence_dirty)
            .into_iter()
            .map(|(peer, role)| PeerPresence {
                peer,
                role,
                state: self.peers.get(&ConnId(peer)).and_then(|p| p.presence.clone()),
            })
            .collect();
        if batch.is_empty() {
            return;
        }
        // Everyone gets the batch minus their own entry.
        let slow: Vec<ConnId> = self
            .peers
            .iter()
            .filter(|(c, p)| {
                let mine: Vec<PeerPresence> = batch.iter().filter(|e| e.peer != c.0).cloned().collect();
                !mine.is_empty() && p.out.try_send(WireOut::Presence { peers: mine }).is_err()
            })
            .map(|(c, _)| *c)
            .collect();
        for conn in slow {
            self.close(conn, CloseReason::TooSlow);
        }
    }

    fn join(
        &mut self,
        link_hash: String,
        role: LinkRole,
        want_base: bool,
        reply: oneshot::Sender<Result<Joined, CloseReason>>,
    ) {
        let link_role = role;
        let role: Role = role.engine_role();
        if self.peers.len() >= MAX_SESSIONS {
            let _ = reply.send(Err(CloseReason::Full));
            return;
        }
        let conn = ConnId(self.next_conn);
        self.next_conn += 1;
        let (out, rx) = mpsc::channel(OUTBOX_DEPTH);
        self.authority.connect(conn, role);
        // Everyone already here, so the newcomer sees the room at once.
        let here: Vec<PeerPresence> = self
            .peers
            .iter()
            .filter_map(|(c, p)| p.presence.clone().map(|s| PeerPresence { peer: c.0, role: p.role, state: Some(s) }))
            .collect();
        if !here.is_empty() {
            let _ = out.try_send(WireOut::Presence { peers: here });
        }
        self.peers.insert(conn, Peer { link_hash, role: link_role, out, presence: None });
        let base = want_base.then(|| self.base.clone());
        if reply.send(Ok((conn, rx, base))).is_err() {
            self.forget_peer(conn);
        }
    }

    async fn message(&mut self, conn: ConnId, msg: ClientMsg) -> Result<(), StoreError> {
        let (outbox, effects) = self.authority.handle(conn, msg);
        for effect in &effects {
            match effect {
                Effect::Logged { seq } => {
                    let tx = &self.authority.log()[*seq as usize - 1];
                    self.store.append_op(self.id.clone(), *seq, tx).await?;
                }
                Effect::Rejected { client, cseq, reason } => {
                    self.store.add_rejection(self.id.clone(), *client, *cseq, reason).await?;
                }
                Effect::ClientRegistered { client, secret_hash } => {
                    self.store.add_client(self.id.clone(), *client, *secret_hash).await?;
                }
                Effect::RejectionsResolved { client, below } => {
                    self.store.prune_rejections(self.id.clone(), *client, *below).await?;
                }
            }
        }
        for (to, msg) in outbox {
            let fatal = matches!(msg, ServerMsg::Fatal(_));
            let Some(peer) = self.peers.get(&to) else { continue };
            if peer.out.try_send(WireOut::Msg { msg }).is_err() {
                self.close(to, CloseReason::TooSlow);
                continue;
            }
            if fatal {
                self.close(to, CloseReason::Protocol);
            }
        }
        Ok(())
    }

    fn close(&mut self, conn: ConnId, reason: CloseReason) {
        if let Some(peer) = self.peers.get(&conn) {
            // Best effort: if the outbox is full the socket task notices the channel closing.
            let _ = peer.out.try_send(WireOut::Closed { reason });
        }
        self.forget_peer(conn);
    }
}
