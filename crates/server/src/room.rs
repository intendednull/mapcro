//! One task per open board. It owns the board's `Authority` and handles commands one at a time,
//! so the engine needs no locking. Every acknowledgement or rejection is written to SQLite
//! before anyone hears about it (spec §9, "durable before ack").

use crate::store::{Store, StoreError};
use mapcro_engine::wire::{Base, CloseReason, WireOut};
use mapcro_engine::{Authority, ClientMsg, ConnId, Effect, Role, ServerMsg};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

/// Outbound frames per connection. A client this far behind is dropped rather than letting it
/// stall the room.
const OUTBOX_DEPTH: usize = 4096;

pub enum RoomCmd {
    Join {
        link_hash: String,
        role: Role,
        want_base: bool,
        reply: oneshot::Sender<(ConnId, mpsc::Receiver<WireOut>, Option<Base>)>,
    },
    Msg { conn: ConnId, msg: ClientMsg },
    Leave { conn: ConnId },
    Revoke { link_hash: String },
}

struct Peer {
    link_hash: String,
    out: mpsc::Sender<WireOut>,
}

struct Room {
    id: String,
    store: Store,
    authority: Authority,
    base: Base,
    peers: HashMap<ConnId, Peer>,
    next_conn: u64,
}

#[derive(Clone)]
pub struct Rooms {
    store: Store,
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
}

impl Rooms {
    pub fn new(store: Store) -> Rooms {
        Rooms { store, open: Arc::new(Mutex::new(HashMap::new())) }
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
        };
        tokio::spawn(room.run(rx));
        open.insert(board.to_owned(), tx.clone());
        tracing::info!(board, "room opened");
        Ok(tx)
    }

    /// The room if it's open, without loading it.
    pub fn lookup(&self, board: &str) -> Option<mpsc::Sender<RoomCmd>> {
        let open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        open.get(board).filter(|t| !t.is_closed()).cloned()
    }

    pub fn open_count(&self) -> usize {
        self.open.lock().map(|o| o.values().filter(|t| !t.is_closed()).count()).unwrap_or(0)
    }
}

impl Room {
    async fn run(mut self, mut rx: mpsc::Receiver<RoomCmd>) {
        while let Some(cmd) = rx.recv().await {
            let result = match cmd {
                RoomCmd::Join { link_hash, role, want_base, reply } => {
                    self.join(link_hash, role, want_base, reply);
                    Ok(())
                }
                RoomCmd::Msg { conn, msg } => self.message(conn, msg).await,
                RoomCmd::Leave { conn } => {
                    self.peers.remove(&conn);
                    self.authority.disconnect(conn);
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
            if let Err(e) = result {
                // Crash-only: if storage fails we cannot promise durability, so stop serving
                // this board. Clients keep their pending work and reconnect to a fresh room.
                tracing::error!(board = self.id, error = %e, "storage failed; closing room");
                let all: Vec<ConnId> = self.peers.keys().copied().collect();
                for conn in all {
                    self.close(conn, CloseReason::StorageFailure);
                }
                return;
            }
        }
    }

    fn join(
        &mut self,
        link_hash: String,
        role: Role,
        want_base: bool,
        reply: oneshot::Sender<(ConnId, mpsc::Receiver<WireOut>, Option<Base>)>,
    ) {
        let conn = ConnId(self.next_conn);
        self.next_conn += 1;
        let (out, rx) = mpsc::channel(OUTBOX_DEPTH);
        self.authority.connect(conn, role);
        self.peers.insert(conn, Peer { link_hash, out });
        let base = want_base.then(|| self.base.clone());
        if reply.send((conn, rx, base)).is_err() {
            self.peers.remove(&conn);
            self.authority.disconnect(conn);
        }
    }

    async fn message(&mut self, conn: ConnId, msg: ClientMsg) -> Result<(), StoreError> {
        let (outbox, effect) = self.authority.handle(conn, msg);
        match &effect {
            Effect::None => {}
            Effect::Logged { seq } => {
                let tx = &self.authority.log()[*seq as usize - 1];
                self.store.append_op(self.id.clone(), *seq, tx).await?;
            }
            Effect::Rejected { client, cseq, reason } => {
                self.store.add_rejection(self.id.clone(), *client, *cseq, reason).await?;
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
        self.authority.disconnect(conn);
        if let Some(peer) = self.peers.remove(&conn) {
            // Best effort: if the outbox is full the socket task notices the channel closing.
            let _ = peer.out.try_send(WireOut::Closed { reason });
        }
    }
}
