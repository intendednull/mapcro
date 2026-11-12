//! One task per open board. It owns the board's `Authority` and handles commands one at a time,
//! so the engine needs no locking. Every acknowledgement or rejection is written to SQLite
//! before anyone hears about it (spec §9, "durable before ack").

use crate::codec;
use crate::store::{LoadCaps, Store, StoreError, Write};
use mapcro_engine::wire::{CloseReason, LinkRole, PeerPresence, Presence, WireOut};
use mapcro_engine::{Authority, ClientMsg, ConnId, Effect, Outgoing, Quota, Role, ServerMsg};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

/// Outbound frames per connection, and their bytes. A client this far behind live traffic is
/// dropped rather than letting it stall the room or pin memory. Catch-up doesn't count against
/// either: it's streamed at the client's pace (security review 2026-11-07, H-A). Small frames
/// meet the frame cap first (4096 of ~200 B is ~800 KB), big ones the byte cap (64 of 64 KiB).
/// 4 MiB holds many group-commit batches (each at most `MAX_BATCH_BYTES`), so a burst of large
/// edits acked together doesn't drop a client that's only briefly not reading; at 1 MiB, one
/// such burst could. Live entries are shared between peers, so a room's outboxes hold about its
/// slowest peer's backlog, and that backlog counts towards the room's memory weight.
const OUTBOX_DEPTH: usize = 4096;
pub const OUTBOX_BYTES: usize = 4 * 1024 * 1024;
/// Presence is skipped, not queued, for a peer already this far behind: it's ephemeral and the
/// next batch supersedes it, and each peer's presence frame is its own (not shared).
const PRESENCE_SKIP_BYTES: usize = 64 * 1024;
/// What a room costs in memory besides its document and outbox backlog: its tables and
/// channels. Rounded up from the measured ~0.3 MB a small room costs in all.
const ROOM_BASE_BYTES: usize = 64 * 1024;
/// Per stored client or rejection, in memory.
const ROW_BYTES: usize = 160;
/// A room's weight is re-estimated exactly every this many logged transactions, and grows by
/// each one's JSON size in between (an overestimate: most edits replace a value).
const REWEIGH_EVERY: u32 = 64;
/// A room with nobody in it unloads after this long (spec §9, room lifecycle).
pub const IDLE_UNLOAD: std::time::Duration = std::time::Duration::from_secs(300);
/// How long a load waits for an idle room it asked to unload.
const EVICT_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
/// A fresh client's base may be this many entries behind the log; it catches up the rest. So a
/// burst of joiners on a busy board shares one serialized snapshot.
const SNAPSHOT_STALE_ENTRIES: u64 = 256;
/// A board whose document is bigger than this as JSON isn't sent as a snapshot: a fresh client
/// gets the stored base and catches up from the start, in pages. A snapshot is one frame, so
/// it costs its size several times over while it's sent; the largest documents the schema
/// allows (~64 MB of JSON) would not fit the memory budget that way.
pub const SNAPSHOT_MAX_BYTES: usize = 8 * 1024 * 1024;

pub enum RoomCmd {
    Join {
        link_hash: String,
        role: LinkRole,
        /// The client holds no copy: send it the board as it is now (spec §5, fresh join).
        want_base: bool,
        reply: oneshot::Sender<Result<Joined, CloseReason>>,
    },
    Msg { conn: ConnId, msg: ClientMsg },
    /// Boxed as it arrives (`WireIn::Presence`): several times the other commands' size.
    Presence { conn: ConnId, state: Box<Presence> },
    Leave { conn: ConnId },
    /// The board as it is now (for cloning).
    Snapshot { reply: oneshot::Sender<mapcro_schema::Doc> },
    /// The board's size as JSON now, or `None` if it's over `SNAPSHOT_MAX_BYTES` (for a
    /// download, before anything is copied: boardfile.rs).
    DocBytes { reply: oneshot::Sender<Option<usize>> },
    Revoke { link_hash: String },
    /// Unload now if nobody is in the room (the server is at its open-room or memory cap).
    Unload,
}

/// Engine messages handled per durable write, at most (spec §9, group commit).
const MAX_BATCH: usize = 256;
/// And at most about this many bytes of submitted transactions per batch, so the acks and
/// broadcasts one commit releases stay a small part of any peer's outbox.
const MAX_BATCH_BYTES: usize = 256 * 1024;

/// A test-only crash point (`--features failpoints`, never in a release build): abort the process
/// at the Nth time `name` is reached, as `MAPCRO_FAILPOINT=name:N` says. An abort skips every
/// destructor and flush, like a kill -9 at exactly that line. It waits 200 ms first, as a slow
/// fsync would, so anything already handed to a socket has time to reach its client: a server
/// that acked before its commit would be caught.
#[cfg(feature = "failpoints")]
fn failpoint(name: &str) {
    static HITS: AtomicUsize = AtomicUsize::new(0);
    let Ok(spec) = std::env::var("MAPCRO_FAILPOINT") else { return };
    let Some((at, n)) = spec.split_once(':') else { return };
    if at == name && HITS.fetch_add(1, Ordering::SeqCst) + 1 == n.parse::<usize>().unwrap_or(0) {
        eprintln!("failpoint {name} hit {n} times: aborting");
        std::thread::sleep(std::time::Duration::from_millis(200));
        std::process::abort();
    }
}

#[cfg(not(feature = "failpoints"))]
fn failpoint(_: &str) {}

/// Test-only (`--features failpoints`): append each commit's size, in engine messages and
/// durable writes, to the file `MAPCRO_COMMIT_STATS` names, so a test can see the batches.
#[cfg(feature = "failpoints")]
fn record_commit(messages: usize, writes: usize) {
    use std::io::Write as _;
    if let Some(path) = std::env::var_os("MAPCRO_COMMIT_STATS")
        && let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path)
    {
        let _ = writeln!(f, "{messages} {writes}");
    }
}

#[cfg(not(feature = "failpoints"))]
fn record_commit(_: usize, _: usize) {}

/// Test-only (`--features failpoints`): wait `MAPCRO_PAUSE_<NAME>_MS` here, to fix the order of
/// events a test needs (a slow fsync, a slow catch-up reader).
#[cfg(feature = "failpoints")]
pub(crate) async fn pause(name: &str) {
    let key = format!("MAPCRO_PAUSE_{}_MS", name.to_ascii_uppercase());
    if let Some(ms) = std::env::var(key).ok().and_then(|v| v.parse::<u64>().ok()) {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }
}

#[cfg(not(feature = "failpoints"))]
pub(crate) async fn pause(_: &str) {}

/// Test-only (`--features failpoints`): whether `MAPCRO_INJECT` lists `name`, a failure to fake.
#[cfg(feature = "failpoints")]
fn injected(name: &str) -> bool {
    std::env::var("MAPCRO_INJECT").is_ok_and(|v| v.split(',').any(|n| n == name))
}

#[cfg(not(feature = "failpoints"))]
fn injected(_: &str) -> bool {
    false
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
    /// A frame that may be big (a rebase: the whole board). Not counted against the outbox's
    /// byte cap, which would drop the client for it on every reconnect; the socket sends it under
    /// the server-wide cap on big frames in flight instead.
    Large(Arc<str>),
}

fn frame(out: &WireOut) -> Arc<str> {
    serde_json::to_string(out).unwrap_or_default().into()
}

struct Peer {
    link_hash: String,
    role: LinkRole,
    out: mpsc::Sender<Out>,
    /// Bytes of frames queued in `out`; the socket task subtracts what it takes.
    queued: Arc<AtomicUsize>,
    presence: Option<Presence>,
    /// Peers whose presence changes this peer missed while it was too far behind (batches are
    /// skipped then, not queued). It gets their current state, or their leaving, once it catches
    /// up: presence is only sent on change, so a skipped batch would otherwise be stale for ever.
    missed: Vec<(u64, LinkRole)>,
}

impl Peer {
    /// Queue a frame unless the outbox is full (by count or bytes).
    fn offer(&self, item: Out) -> bool {
        let size = match &item {
            Out::Frame(f) => f.len(),
            Out::Closed(_) | Out::CatchUp { .. } | Out::Large(_) => 0,
        };
        if self.queued.load(Ordering::Relaxed) + size > OUTBOX_BYTES {
            return false;
        }
        self.queued.fetch_add(size, Ordering::Relaxed);
        if self.out.try_send(item).is_err() {
            self.queued.fetch_sub(size, Ordering::Relaxed);
            return false;
        }
        true
    }
}

/// Presence goes out at most once per this long, one frame per peer. A change after a quiet
/// spell goes out at once (the leading edge); changes inside the window wait for its end and go
/// out together. The window is room-wide, so with several people moving an update can wait for
/// someone else's: 20 ms bounds that wait and the jitter it adds to a drag's 60 ms steps, while
/// capping what a receiver handles at 50 frames a second (perf report 2026-11-07, "After the
/// client fixes"; at 50 ms, sent-to-received was 51 ms p50, and 25 ms with a 50 ms leading edge).
const PRESENCE_BATCH: std::time::Duration = std::time::Duration::from_millis(20);

struct Room {
    id: String,
    store: Store,
    rooms: Rooms,
    authority: Authority,
    /// This room's memory estimate, published for the registry's budget: `doc_weight` plus its
    /// slowest peer's outbox backlog.
    weight: Arc<AtomicUsize>,
    /// The document and tables, by estimate (re-estimated every `REWEIGH_EVERY` logged edits).
    doc_weight: usize,
    since_weighed: u32,
    peers: HashMap<ConnId, Peer>,
    /// `peers.len()`, published for the registry's eviction choice.
    occupancy: Arc<AtomicUsize>,
    next_conn: u64,
    idle: std::time::Duration,
    max_storage_bytes: u64,
    /// Peers whose presence changed (or who left) since the last batch.
    presence_dirty: Vec<(u64, LinkRole)>,
    flush_at: Option<tokio::time::Instant>,
    /// When presence last went out.
    last_flush: Option<tokio::time::Instant>,
    /// Asked to unload while empty.
    unload: bool,
    /// The last snapshot handed to a fresh client: the log position it's at and the document as
    /// JSON, or `None` if it was over `SNAPSHOT_MAX_BYTES`. Its size counts in the room's weight.
    snapshot: Option<(u64, Option<Arc<str>>)>,
    /// The log position the stored base document is at (the last compaction).
    base_seq: u64,
    /// After a failed compaction, the log length to try again at (so a persistent failure
    /// neither ends every batch nor logs on every one).
    compact_retry_at: u64,
    compaction: Compaction,
}

/// Where a fresh client starts.
pub enum FreshBase {
    /// The board as it was at this log position, as JSON (spec §5, fresh join).
    Snapshot(u64, Arc<str>),
    /// The board is too big to send as one frame: the stored base, then catch-up from its seq.
    Stored,
}

/// The counter is the outbox's queued bytes, which the socket task decrements as it sends. The
/// `u64` is the log length when the room took the join (Ready's `head`); everything up to it is
/// durable, as joins are handled between batches.
pub type Joined = (ConnId, mpsc::Receiver<Out>, Arc<AtomicUsize>, Option<FreshBase>, u64);

/// Sessions per room. Beyond this, joins are refused (security review M1).
pub const MAX_SESSIONS: usize = 64;

/// What the server holds in memory and on disk (spec §9 and §11; config.rs has the defaults).
#[derive(Clone, Copy, Debug)]
pub struct Caps {
    pub quota: Quota,
    pub max_open_rooms: usize,
    /// What open rooms may occupy in memory together, by their estimates.
    pub room_memory_bytes: usize,
    pub max_storage_bytes: u64,
}

struct Handle {
    tx: mpsc::Sender<RoomCmd>,
    occupancy: Arc<AtomicUsize>,
    weight: Arc<AtomicUsize>,
}

/// A room's memory estimate: its document, its tables, and a fixed base.
fn weigh(a: &Authority) -> usize {
    ROOM_BASE_BYTES + a.doc().approx_heap_bytes() + (a.clients_len() + a.rejections_len()) * ROW_BYTES
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
    compaction: Compaction,
    reg: Arc<Mutex<Registry>>,
}

/// When a room compacts its board's log, and what it keeps (spec §9). Read from the environment
/// here rather than config.rs: `BOARD_COMPACT_OPS` (10,000; 0 turns compaction off, leaving
/// only the history caps) and `BOARD_KEEP_OPS` (2,000).
#[derive(Clone, Copy, Debug)]
pub struct Compaction {
    /// Compact once this many entries have been logged since the base.
    pub every_ops: u64,
    /// Entries kept for clients slightly behind (catch-up rather than a rebase).
    pub keep_ops: usize,
}

impl Compaction {
    fn from_env() -> Compaction {
        let num = |k: &str, d: u64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        Compaction { every_ops: num("BOARD_COMPACT_OPS", 10_000), keep_ops: num("BOARD_KEEP_OPS", 2_000) as usize }
    }
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
    /// As many rooms are open as the server allows (by count or memory), none of them idle.
    #[error("too many boards open")]
    Busy,
}

impl Rooms {
    pub fn new(store: Store, idle: std::time::Duration, caps: Caps) -> Rooms {
        Rooms { store, idle, caps, compaction: Compaction::from_env(), reg: Arc::default() }
    }

    fn registry(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.reg.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The open rooms' memory estimates, summed.
    fn resident(&self) -> usize {
        self.registry().open.values().filter(|h| !h.tx.is_closed()).map(|h| h.weight.load(Ordering::Relaxed)).sum()
    }

    /// Ask one idle room to unload; true if there was one.
    fn nudge_idle(&self) -> Option<mpsc::Sender<RoomCmd>> {
        let reg = self.registry();
        let victim = reg.open.values().find(|h| h.occupancy.load(Ordering::Relaxed) == 0 && !h.tx.is_closed())?;
        victim.tx.try_send(RoomCmd::Unload).ok().map(|()| victim.tx.clone())
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
        let weight = Arc::new(AtomicUsize::new(weigh(&stored.authority)));
        let base_seq = stored.base_seq;
        let mut room = Some(stored.authority);
        // Admit it within the memory budget, unloading idle rooms to make room if needed.
        for _ in 0..8 {
            let victim = {
                let mut reg = self.registry();
                reg.open.retain(|_, h| !h.tx.is_closed());
                // Two loads may race; the first to insert wins and the other's work is dropped.
                if let Some(tx) = reg.open.get(board).map(|h| h.tx.clone()) {
                    drop(reg); // before `slot`, whose drop takes the lock
                    return Ok(tx);
                }
                let resident: usize = reg.open.values().map(|h| h.weight.load(Ordering::Relaxed)).sum();
                if reg.open.is_empty() || resident + weight.load(Ordering::Relaxed) <= self.caps.room_memory_bytes {
                    let authority = room.take().ok_or(RoomError::Unavailable)?;
                    let tx = self.spawn(board, authority, base_seq, weight.clone(), &mut reg);
                    // The reservation became the open room in one step under the lock.
                    reg.loading -= 1;
                    slot.held = false;
                    tracing::info!(board, "room opened");
                    return Ok(tx);
                }
                reg.open.values().find(|h| h.occupancy.load(Ordering::Relaxed) == 0).map(|h| h.tx.clone())
            };
            let Some(victim) = victim else { break };
            if victim.try_send(RoomCmd::Unload).is_ok() {
                let _ = tokio::time::timeout(EVICT_WAIT, victim.closed()).await;
            }
        }
        tracing::warn!(board, "room memory budget reached; join refused");
        Err(RoomError::Busy)
    }

    fn spawn(&self, board: &str, authority: Authority, base_seq: u64, weight: Arc<AtomicUsize>, reg: &mut Registry) -> mpsc::Sender<RoomCmd> {
        let (tx, rx) = mpsc::channel(1024);
        let occupancy = Arc::new(AtomicUsize::new(0));
        let room = Room {
            id: board.to_owned(),
            store: self.store.clone(),
            rooms: self.clone(),
            authority,
            doc_weight: weight.load(Ordering::Relaxed),
            weight: weight.clone(),
            since_weighed: 0,
            peers: HashMap::new(),
            occupancy: occupancy.clone(),
            next_conn: 0,
            idle: self.idle,
            max_storage_bytes: self.caps.max_storage_bytes,
            presence_dirty: Vec::new(),
            flush_at: None,
            last_flush: None,
            unload: false,
            snapshot: None,
            base_seq,
            compact_retry_at: 0,
            compaction: self.compaction,
        };
        let registry = self.clone();
        let sender = tx.clone();
        let id = board.to_owned();
        tokio::spawn(async move {
            room.run(rx).await;
            registry.forget(&id, &sender);
            tracing::info!(board = id, "room closed");
        });
        reg.open.insert(board.to_owned(), Handle { tx: tx.clone(), occupancy, weight });
        tx
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

    /// The board's current size as JSON, loading the room if needed: `None` if it's over
    /// `SNAPSHOT_MAX_BYTES`. Taken from the room's snapshot (taken again if the board has moved
    /// since), so nothing is copied.
    pub async fn doc_bytes(&self, board: &str) -> Result<Option<usize>, RoomError> {
        for _ in 0..3 {
            let room = self.get(board).await?;
            let (reply, rx) = oneshot::channel();
            if room.send(RoomCmd::DocBytes { reply }).await.is_ok()
                && let Ok(n) = rx.await
            {
                return Ok(n);
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
                        Some(cmd) => { if self.dispatch(cmd, &mut rx).await.is_err() { return self.fail_all(); } }
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
            if self.dispatch(cmd, &mut rx).await.is_err() {
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
        crate::metrics::failures::record(
            crate::metrics::failures::FailureKind::Storage,
            "room_closed",
            &[crate::metrics::failures::Part::Word("a room's write failed; the room closed")],
        );
        let all: Vec<ConnId> = self.peers.keys().copied().collect();
        for conn in all {
            self.close(conn, CloseReason::StorageFailure);
        }
    }

    /// Handle one command; engine messages go in a batch with any queued behind them, and a
    /// command that ends a batch is handled right after it.
    async fn dispatch(&mut self, cmd: RoomCmd, rx: &mut mpsc::Receiver<RoomCmd>) -> Result<(), StoreError> {
        let mut cmd = cmd;
        loop {
            if let RoomCmd::Msg { conn, msg } = cmd {
                match self.batch((conn, msg), rx).await {
                    Ok(Some(next)) => {
                        cmd = next;
                        continue;
                    }
                    Ok(None) => return Ok(()),
                    Err(e) => {
                        tracing::error!(board = self.id, error = %e, "storage write failed");
                        return Err(e);
                    }
                }
            }
            return self.dispatch_one(cmd).await;
        }
    }

    async fn dispatch_one(&mut self, cmd: RoomCmd) -> Result<(), StoreError> {
        let result = match cmd {
            RoomCmd::Join { link_hash, role, want_base, reply } => {
                self.join(link_hash, role, want_base, reply);
                Ok(())
            }
            RoomCmd::Msg { .. } => Ok(()), // engine messages go through `batch` (see `dispatch`)
            RoomCmd::Presence { conn, mut state } => {
                if let Some(peer) = self.peers.get_mut(&conn) {
                    if peer.role == LinkRole::View {
                        // A view link can't move or draw anything, so it has no drag or live
                        // ink to preview. (Its laser and pings are relayed: everyone gets those.)
                        state.drag = None;
                        state.ink = None;
                    }
                    peer.presence = Some(*state);
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
            RoomCmd::DocBytes { reply } => {
                self.snapshot_within(0);
                let _ = reply.send(self.snapshot.as_ref().and_then(|(_, doc)| doc.as_ref().map(|d| d.len())));
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
        if self.flush_at.is_none() {
            // Now, unless presence went out less than a batch ago: then when that batch ends.
            let now = tokio::time::Instant::now();
            self.flush_at = Some(self.last_flush.map_or(now, |t| (t + PRESENCE_BATCH).max(now)));
        }
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
        let dirty = std::mem::take(&mut self.presence_dirty);
        if dirty.is_empty() && self.peers.values().all(|p| p.missed.is_empty()) {
            return;
        }
        self.last_flush = Some(tokio::time::Instant::now());
        // The current entry for every peer anyone is owed: changed now, or missed before.
        let mut owed: Vec<(u64, LinkRole)> = dirty.clone();
        for p in self.peers.values() {
            for m in &p.missed {
                if !owed.iter().any(|(id, _)| *id == m.0) {
                    owed.push(*m);
                }
            }
        }
        let entries: HashMap<u64, PeerPresence> = owed
            .iter()
            .map(|(id, role)| {
                let state = self.peers.get(&ConnId(*id)).and_then(|p| p.presence.clone());
                (*id, PeerPresence { peer: *id, role: *role, state })
            })
            .collect();
        // Everyone gets the batch minus their own entry, plus anything they missed.
        let mut slow = Vec::new();
        let mut retry = false;
        for (c, p) in self.peers.iter_mut() {
            if p.queued.load(Ordering::Relaxed) > PRESENCE_SKIP_BYTES {
                // Behind: skip this batch rather than queue it, and owe it these peers.
                for d in dirty.iter().filter(|(id, _)| *id != c.0) {
                    if !p.missed.iter().any(|(id, _)| *id == d.0) {
                        p.missed.push(*d);
                    }
                }
                retry |= !p.missed.is_empty();
                continue;
            }
            let mut ids: Vec<u64> = dirty.iter().map(|(id, _)| *id).collect();
            ids.extend(p.missed.drain(..).map(|(id, _)| id));
            ids.sort_unstable();
            ids.dedup();
            let mine: Vec<PeerPresence> = ids.iter().filter(|id| **id != c.0).filter_map(|id| entries.get(id).cloned()).collect();
            if !mine.is_empty() && !p.offer(Out::Frame(frame(&WireOut::Presence { peers: mine }))) {
                slow.push(*c);
            }
        }
        for conn in slow {
            self.close(conn, CloseReason::TooSlow);
        }
        // A peer still behind is retried, so it's caught up even if nobody moves again.
        if retry {
            self.flush_at = Some(tokio::time::Instant::now() + PRESENCE_BATCH);
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
        let peer = Peer { link_hash, role: link_role, out, queued: Arc::default(), presence: None, missed: Vec::new() };
        self.authority.connect(conn, role);
        // Everyone already here, so the newcomer sees the room at once.
        let here: Vec<PeerPresence> = self
            .peers
            .iter()
            .filter_map(|(c, p)| p.presence.clone().map(|s| PeerPresence { peer: c.0, role: p.role, state: Some(s) }))
            .collect();
        if !here.is_empty() {
            peer.offer(Out::Frame(frame(&WireOut::Presence { peers: here })));
        }
        let queued = peer.queued.clone();
        self.peers.insert(conn, peer);
        self.occupancy.store(self.peers.len(), Ordering::Relaxed);
        let base = want_base.then(|| self.base_snapshot());
        let head = self.authority.log_len();
        if reply.send(Ok((conn, rx, queued, base, head))).is_err() {
            self.forget_peer(conn);
        }
    }

    /// The board as a fresh client starts from: the document and the log position it's at,
    /// taken together in this one step, so the client's hello (from that position) and its
    /// catch-up meet exactly. Reuses the last snapshot, at the position it was taken at, while it's
    /// at most `SNAPSHOT_STALE_ENTRIES` behind; the client catches up the difference.
    fn base_snapshot(&mut self) -> FreshBase {
        self.snapshot_within(SNAPSHOT_STALE_ENTRIES);
        match &self.snapshot {
            Some((seq, Some(doc))) => FreshBase::Snapshot(*seq, doc.clone()),
            _ => FreshBase::Stored,
        }
    }

    /// Take the snapshot again unless the last is at most `stale` log entries behind.
    fn snapshot_within(&mut self, stale: u64) {
        let len = self.authority.log_len();
        let fresh_enough = matches!(&self.snapshot, Some((seq, _)) if len - *seq <= stale);
        if !fresh_enough {
            let json = serde_json::to_string(self.authority.doc()).unwrap_or_default();
            let doc = (json.len() <= SNAPSHOT_MAX_BYTES).then(|| Arc::<str>::from(json));
            self.snapshot = Some((len, doc));
            self.publish_weight();
        }
    }

    /// Handle a run of engine messages with one durable write (spec §9, group commit): apply
    /// `first` and every message already queued behind it, in order, in memory; write all their
    /// effects in one transaction (one fsync); then, and only then, send what any of them
    /// produced. A batch stops at the first other command, which is returned to be handled
    /// after the commit: a join's snapshot, a clone or a catch-up range must never see what isn't
    /// on disk yet.
    async fn batch(&mut self, first: (ConnId, ClientMsg), rx: &mut mpsc::Receiver<RoomCmd>) -> Result<Option<RoomCmd>, StoreError> {
        let taken = std::time::Instant::now();
        let mut writes = Vec::new();
        let mut outboxes = Vec::new();
        let mut bytes = self.apply(first.0, first.1, &mut writes, &mut outboxes)?;
        let mut rest = None;
        // A batch also ends once compaction is due, so it runs before the quota could bite.
        while outboxes.len() < MAX_BATCH && bytes < MAX_BATCH_BYTES && !self.compaction_due() {
            match rx.try_recv() {
                Ok(RoomCmd::Msg { conn, msg }) => bytes += self.apply(conn, msg, &mut writes, &mut outboxes)?,
                Ok(other) => {
                    rest = Some(other);
                    break;
                }
                Err(_) => break,
            }
        }
        if !writes.is_empty() {
            let n = writes.len();
            pause("commit").await;
            failpoint("before_commit");
            let started = std::time::Instant::now();
            self.store.commit(self.id.clone(), writes).await?;
            let m = crate::metrics::get();
            m.commit_ms.observe_ms((), started);
            m.commit_batch_size.observe((), outboxes.len() as f64);
            failpoint("after_commit");
            record_commit(outboxes.len(), n);
        }
        let messages = outboxes.len();
        for outbox in outboxes {
            self.deliver(outbox);
        }
        // Every message in the batch is acked (or refused) now: one observation each.
        let ack_ms = taken.elapsed().as_secs_f64() * 1000.0;
        for _ in 0..messages {
            crate::metrics::get().op_ack_ms.observe((), ack_ms);
        }
        // The batch is committed; compaction is housekeeping. If it fails, say so and carry on:
        // the history caps are the backstop (review finding 5).
        if let Err(e) = self.maybe_compact().await {
            self.compact_retry_at = self.authority.log_len() + (self.compaction.every_ops / 10).max(1);
            tracing::error!(board = self.id, error = %e, retry_at = self.compact_retry_at, "compaction failed; continuing without it");
            crate::metrics::failures::record(
                crate::metrics::failures::FailureKind::Storage,
                "compaction",
                &[crate::metrics::failures::Part::Word("compaction failed; continuing without it")],
            );
        }
        self.publish_weight();
        Ok(rest)
    }

    /// Compact the log once enough has been logged since the base, or its kept bytes reach half
    /// the board's byte quota (spec §9): the board as it is becomes the base, the newest entries
    /// stay for catch-up, and clients older than them are rebased. So a board's history no longer
    /// grows without bound, and the quotas only backstop the kept tail. Runs after a commit, so
    /// the board it writes is all on disk already.
    fn compaction_due(&self) -> bool {
        let len = self.authority.log_len();
        self.compaction.every_ops > 0
            && len >= self.compact_retry_at
            && len > self.base_seq
            && (len - self.base_seq >= self.compaction.every_ops || self.authority.log_bytes() >= self.rooms.caps.quota.max_log_bytes / 2)
    }

    async fn maybe_compact(&mut self) -> Result<(), StoreError> {
        if !self.compaction_due() {
            return Ok(());
        }
        if injected("compact_error") {
            return Err(StoreError::Corrupt("injected compaction failure".into()));
        }
        let len = self.authority.log_len();
        let quota = self.rooms.caps.quota;
        let json = serde_json::to_string(self.authority.doc()).map_err(|e| StoreError::Corrupt(e.to_string()))?;
        let (codec, stored) = codec::encode(json.as_bytes());
        let seqs: Vec<_> = self.authority.client_seqs().collect();
        let keep_bytes = quota.max_log_bytes / 4;
        let (floor, kept) = self.store.compact(self.id.clone(), codec, stored, len, self.compaction.keep_ops, keep_bytes, seqs).await?;
        self.authority.compacted(floor, kept);
        self.base_seq = len;
        // The new base is also a fresh joiner's snapshot.
        self.snapshot = Some((len, (json.len() <= SNAPSHOT_MAX_BYTES).then(|| Arc::<str>::from(json))));
        tracing::info!(board = self.id, base = len, floor, kept, "compacted");
        Ok(())
    }

    /// One engine message, in memory: the authority's decision, and the durable writes it needs.
    /// Returns the submitted transaction's JSON size (0 for other messages), for the batch's cap.
    fn apply(&mut self, conn: ConnId, msg: ClientMsg, writes: &mut Vec<Write>, outboxes: &mut Vec<mapcro_engine::Outbox>) -> Result<usize, StoreError> {
        // Storage or memory full: refuse edits (`ServerFull`). Over the memory budget, ask an idle
        // room to make way, so the refusal lasts only until one has.
        let over_memory = matches!(msg, ClientMsg::Submit(_)) && self.rooms.resident() > self.rooms.caps.room_memory_bytes;
        if over_memory && self.rooms.nudge_idle().is_some() {
            tracing::info!(board = self.id, "room memory budget reached; unloading an idle room");
        }
        self.authority.set_storage_full(over_memory || self.store.bytes() >= self.max_storage_bytes);
        // Encode a submitted transaction as it would be stored: its stored size is what counts
        // against the board's byte quota, and if it's logged, these are the bytes written.
        let mut encoded = None;
        let mut size = 0;
        let (outbox, effects) = match msg {
            ClientMsg::Submit(tx) => {
                let json = serde_json::to_vec(&tx).map_err(|e| StoreError::Corrupt(e.to_string()))?;
                size = json.len();
                let (codec, stored) = codec::encode(&json);
                let len = stored.len();
                encoded = Some((codec, stored));
                self.authority.handle_stored(conn, ClientMsg::Submit(tx), len)
            }
            other => self.authority.handle(conn, other),
        };
        for effect in effects {
            writes.push(match effect {
                Effect::Logged { seq, tx } => {
                    let (codec, stored) = encoded.take().ok_or_else(|| StoreError::Corrupt("logged without a submit".into()))?;
                    self.since_weighed += 1;
                    if self.since_weighed >= REWEIGH_EVERY {
                        self.since_weighed = 0;
                        self.doc_weight = weigh(&self.authority);
                    } else {
                        self.doc_weight += mapcro_engine::encoded_len(&tx);
                    }
                    Write::Op { seq, codec, stored }
                }
                Effect::Rejected { client, cseq, reason } => {
                    crate::metrics::get().ops_rejected.inc(((&reason).into(),));
                    Write::Rejection { client, cseq, reason }
                }
                Effect::ClientRegistered { client, secret_hash } => Write::Client { client, secret_hash },
                Effect::RejectionsResolved { client, below } => {
                    Write::PruneRejections { client, below, next_cseq: self.authority.next_cseq(client) }
                }
            });
        }
        outboxes.push(outbox);
        Ok(size)
    }

    /// Send what a message produced (after its effects are durable).
    fn deliver(&mut self, outbox: mapcro_engine::Outbox) {
        // A broadcast is the same message to every peer in a row: serialize it once and share it.
        let mut last: Option<(ServerMsg, Arc<str>)> = None;
        for (to, out) in outbox {
            let (item, fatal) = match out {
                Outgoing::Msg(msg @ ServerMsg::Rebase { .. }) => (Out::Large(frame(&WireOut::Msg { msg })), false),
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
            if !peer.offer(item) {
                self.close(to, CloseReason::TooSlow);
                continue;
            }
            if fatal {
                self.close(to, CloseReason::Protocol);
            }
        }
    }

    /// Publish the room's weight: its document and tables, plus the largest outbox backlog
    /// (live entries are shared, so that's about what all the outboxes hold together).
    fn publish_weight(&self) {
        let backlog = self.peers.values().map(|p| p.queued.load(Ordering::Relaxed)).max().unwrap_or(0);
        let snapshot = match &self.snapshot {
            Some((_, Some(doc))) => doc.len(),
            _ => 0,
        };
        self.weight.store(self.doc_weight + backlog + snapshot, Ordering::Relaxed);
    }

    fn close(&mut self, conn: ConnId, reason: CloseReason) {
        if let Some(peer) = self.peers.get(&conn) {
            // Best effort: if the outbox is full the socket task notices the channel closing.
            let _ = peer.out.try_send(Out::Closed(reason));
        }
        self.forget_peer(conn);
    }
}
