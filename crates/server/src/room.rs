//! One task per open board. It owns the board's `Authority` and handles commands one at a time,
//! so the engine needs no locking. Every acknowledgement or rejection is written to SQLite
//! before anyone hears about it (spec §9, "durable before ack").

use crate::codec;
use crate::store::{LoadCaps, Store, StoreError};
use mapcro_engine::wire::{Base, CloseReason, LinkRole, PeerPresence, Presence, WireOut};
use mapcro_engine::{Authority, ClientMsg, ConnId, Effect, Outgoing, Quota, Role, ServerMsg};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

/// Outbound frames per connection. A client this far behind live traffic is dropped rather than
/// letting it stall the room. Catch-up doesn't count against it: it's streamed at the client's
/// pace (security review 2026-11-07, H-A). Frames are shared between peers, so a full outbox
/// costs pointers, not copies.
const OUTBOX_DEPTH: usize = 4096;
/// A room with nobody in it unloads after this long (spec §9, room lifecycle).
pub const IDLE_UNLOAD: std::time::Duration = std::time::Duration::from_secs(300);
/// How long a load waits for an idle room it asked to unload.
const EVICT_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

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
    /// Unload now if nobody is in the room (the server is at its open-room cap).
    Unload,
}

/// What a connection's socket task sends, in order.
pub enum Out {
    /// A serialized frame, shared by every peer it goes to.
    Frame(Arc<str>),
    /// The server is closing the connection.
    Closed(CloseReason),
    /// Stream log entries `from..=to` here, reading them from storage (every one is durable by
    /// the time this is queued).
    CatchUp { from: u64, to: u64 },
}

fn frame(out: &WireOut) -> Arc<str> {
    serde_json::to_string(out).unwrap_or_default().into()
}

struct Peer {
    link_hash: String,
    role: LinkRole,
    out: mpsc::Sender<Out>,
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
    /// `peers.len()`, published for the registry's eviction choice.
    occupancy: Arc<AtomicUsize>,
    next_conn: u64,
    idle: std::time::Duration,
    max_storage_bytes: u64,
    /// Peers whose presence changed (or who left) since the last batch.
    presence_dirty: Vec<(u64, LinkRole)>,
    flush_at: Option<tokio::time::Instant>,
    /// Asked to unload while empty.
    unload: bool,
}

pub type Joined = (ConnId, mpsc::Receiver<Out>, Option<Base>);

/// Sessions per room. Beyond this, joins are refused (security review M1).
pub const MAX_SESSIONS: usize = 64;

/// What the server holds in memory and on disk (spec §9 and §11; config.rs has the defaults).
#[derive(Clone, Copy, Debug)]
pub struct Caps {
    pub quota: Quota,
    pub max_open_rooms: usize,
    pub max_storage_bytes: u64,
}

struct Handle {
    tx: mpsc::Sender<RoomCmd>,
    occupancy: Arc<AtomicUsize>,
}

#[derive(Default)]
struct Registry {
    open: HashMap<String, Handle>,
    /// Loads in progress: they count against the cap, so concurrent loads can't overshoot it.
    loading: usize,
}

#[derive(Clone)]
pub struct Rooms {
    store: Store,
    idle: std::time::Duration,
    caps: Caps,
    reg: Arc<Mutex<Registry>>,
}

/// A slot for one room being loaded; released on drop unless the room opened.
struct Reservation {
    reg: Arc<Mutex<Registry>>,
    held: bool,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if self.held {
            self.reg.lock().unwrap_or_else(|e| e.into_inner()).loading -= 1;
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RoomError {
    #[error("no such board")]
    NotFound,
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("room unavailable")]
    Unavailable,
    /// As many rooms are open as the server allows, and none of them is idle.
    #[error("too many boards open")]
    Busy,
}

impl Rooms {
    pub fn new(store: Store, idle: std::time::Duration, caps: Caps) -> Rooms {
        Rooms { store, idle, caps, reg: Arc::default() }
    }

    fn registry(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.reg.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Room for one more board: free below the cap, else unload an idle room to make some
    /// (security review 2026-11-07, M-B). An attacker can't pin memory by touching boards and
    /// leaving them; only rooms with people in them hold their place.
    async fn reserve(&self) -> Result<Reservation, RoomError> {
        for _ in 0..3 {
            let victim = {
                let mut reg = self.registry();
                reg.open.retain(|_, h| !h.tx.is_closed());
                if reg.open.len() + reg.loading < self.caps.max_open_rooms {
                    reg.loading += 1;
                    return Ok(Reservation { reg: self.reg.clone(), held: true });
                }
                reg.open.values().find(|h| h.occupancy.load(Ordering::Relaxed) == 0).map(|h| h.tx.clone())
            };
            let Some(victim) = victim else { break };
            if victim.try_send(RoomCmd::Unload).is_ok() {
                let _ = tokio::time::timeout(EVICT_WAIT, victim.closed()).await;
            }
        }
        Err(RoomError::Busy)
    }

    /// The room for `board`, loading it from storage on first use.
    pub async fn get(&self, board: &str) -> Result<mpsc::Sender<RoomCmd>, RoomError> {
        if let Some(tx) = self.lookup(board) {
            return Ok(tx);
        }
        let mut slot = self.reserve().await?;
        let q = self.caps.quota;
        let caps = LoadCaps { ops: q.max_log_ops, bytes: q.max_log_bytes, clients: q.max_clients, rejections: q.max_rejections };
        let stored = self.store.load_board(board.to_owned(), caps, q).await?.ok_or(RoomError::NotFound)?;
        // Two loads may race; the first to insert wins and the other's work is dropped.
        let mut reg = self.registry();
        if let Some(tx) = reg.open.get(board).filter(|h| !h.tx.is_closed()).map(|h| h.tx.clone()) {
            drop(reg); // before `slot`, whose drop takes the lock
            return Ok(tx);
        }
        let (tx, rx) = mpsc::channel(1024);
        let occupancy = Arc::new(AtomicUsize::new(0));
        let room = Room {
            id: board.to_owned(),
            store: self.store.clone(),
            authority: stored.authority,
            base: Base { doc: stored.base, seq: stored.base_seq },
            peers: HashMap::new(),
            occupancy: occupancy.clone(),
            next_conn: 0,
            idle: self.idle,
            max_storage_bytes: self.caps.max_storage_bytes,
            presence_dirty: Vec::new(),
            flush_at: None,
            unload: false,
        };
        let registry = self.clone();
        let sender = tx.clone();
        let id = board.to_owned();
        tokio::spawn(async move {
            room.run(rx).await;
            registry.forget(&id, &sender);
            tracing::info!(board = id, "room closed");
        });
        // The reservation becomes the open room in one step under the lock.
        reg.loading -= 1;
        slot.held = false;
        reg.open.insert(board.to_owned(), Handle { tx: tx.clone(), occupancy });
        tracing::info!(board, "room opened");
        Ok(tx)
    }

    /// The room if it's open, without loading it.
    pub fn lookup(&self, board: &str) -> Option<mpsc::Sender<RoomCmd>> {
        self.registry().open.get(board).filter(|h| !h.tx.is_closed()).map(|h| h.tx.clone())
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
        let mut reg = self.registry();
        if reg.open.get(board).is_some_and(|h| h.tx.same_channel(room)) {
            reg.open.remove(board);
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
        self.registry().open.values().filter(|h| !h.tx.is_closed()).count()
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
                if self.unload {
                    return;
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
            if self.unload {
                return;
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
        let result = match cmd {
            RoomCmd::Join { link_hash, role, want_base, reply } => {
                self.join(link_hash, role, want_base, reply);
                Ok(())
            }
            RoomCmd::Msg { conn, msg } => self.message(conn, msg).await,
            RoomCmd::Presence { conn, mut state } => {
                if let Some(peer) = self.peers.get_mut(&conn) {
                    if peer.role == LinkRole::View {
                        // A view link can't move anything, so it has no drag to preview.
                        // (Its laser is relayed: everyone gets the laser.)
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
                let gone: Vec<ConnId> = self.peers.iter().filter(|(_, p)| p.link_hash == link_hash).map(|(c, _)| *c).collect();
                for conn in gone {
                    self.close(conn, CloseReason::Revoked);
                }
                Ok(())
            }
            RoomCmd::Unload => {
                self.unload = self.peers.is_empty();
                Ok(())
            }
        };
        if let Err(e) = &result {
            tracing::error!(board = self.id, error = %e, "storage write failed");
        }
        result
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
        self.occupancy.store(self.peers.len(), Ordering::Relaxed);
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
                !mine.is_empty() && p.out.try_send(Out::Frame(frame(&WireOut::Presence { peers: mine }))).is_err()
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
            let _ = out.try_send(Out::Frame(frame(&WireOut::Presence { peers: here })));
        }
        self.peers.insert(conn, Peer { link_hash, role: link_role, out, presence: None });
        self.occupancy.store(self.peers.len(), Ordering::Relaxed);
        let base = want_base.then(|| self.base.clone());
        if reply.send(Ok((conn, rx, base))).is_err() {
            self.forget_peer(conn);
        }
    }

    async fn message(&mut self, conn: ConnId, msg: ClientMsg) -> Result<(), StoreError> {
        self.authority.set_storage_full(self.store.bytes() >= self.max_storage_bytes);
        // Encode a submitted transaction as it would be stored: its stored size is what counts
        // against the board's byte quota, and if it's logged, these are the bytes written.
        let mut encoded = None;
        let (outbox, effects) = match msg {
            ClientMsg::Submit(tx) => {
                let json = serde_json::to_vec(&tx).map_err(|e| StoreError::Corrupt(e.to_string()))?;
                let (codec, stored) = codec::encode(&json);
                let len = stored.len();
                encoded = Some((codec, stored));
                self.authority.handle_stored(conn, ClientMsg::Submit(tx), len)
            }
            other => self.authority.handle(conn, other),
        };
        for effect in &effects {
            match effect {
                Effect::Logged { seq, .. } => {
                    let (codec, stored) = encoded.take().ok_or_else(|| StoreError::Corrupt("logged without a submit".into()))?;
                    self.store.append_op(self.id.clone(), *seq, codec, stored).await?;
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
        // A broadcast is the same message to every peer in a row: serialize it once and share it.
        let mut last: Option<(ServerMsg, Arc<str>)> = None;
        for (to, out) in outbox {
            let (item, fatal) = match out {
                Outgoing::Msg(msg) => {
                    let fatal = matches!(msg, ServerMsg::Fatal(_));
                    let f = match &last {
                        Some((m, f)) if *m == msg => f.clone(),
                        _ => {
                            let f = frame(&WireOut::Msg { msg: msg.clone() });
                            last = Some((msg, f.clone()));
                            f
                        }
                    };
                    (Out::Frame(f), fatal)
                }
                Outgoing::CatchUp { from, to } => (Out::CatchUp { from, to }, false),
            };
            let Some(peer) = self.peers.get(&to) else { continue };
            if peer.out.try_send(item).is_err() {
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
            let _ = peer.out.try_send(Out::Closed(reason));
        }
        self.forget_peer(conn);
    }
}
