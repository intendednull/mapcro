use crate::protocol::{ClientMsg, Hello, ServerMsg};
use mapcro_schema::{ClientId, Doc, LIMITS, Reject, Tx, apply_tx};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// A transport connection, numbered by the caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ConnId(pub u64);

/// What a connection's link capability allows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    View,
    Edit,
}

/// Connection lifecycle. Only `Live` connections receive broadcasts: a connection becomes live
/// after its hello has been answered with rejections and catch-up. Broadcasting to a connection
/// before that is the reconnect race the Quint model found (journal 2026-11-06, finding 1).
#[derive(Clone, Copy, Debug)]
enum Conn {
    Connecting { role: Role },
    Live { role: Role, client: ClientId },
}

#[derive(Default)]
struct ClientRecord {
    secret_hash: Option<[u8; 32]>,
    /// Every `cseq` below this has been decided (applied or rejected).
    next_cseq: u64,
    /// Rejections the client may not have heard about yet. Pruned below its `pending_from`.
    rejected: BTreeMap<u64, Reject>,
}

/// How much one board may hold (security review 2026-11-07, C1 and H-B). Until snapshots and
/// compaction land (spec §9), the op log is the board's whole history, so it is capped; a full
/// board refuses edits with [`Reject::BoardFull`] and stays readable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quota {
    /// Logged transactions.
    pub max_log_ops: usize,
    /// Logged transactions' size as stored, summed: what storage holds and a cold load reads.
    /// The host says what a transaction costs to store ([`Authority::handle_stored`]); by default
    /// it's its JSON encoding.
    pub max_log_bytes: usize,
    /// Distinct client ids bound to a secret. Only editors register (view links never write).
    pub max_clients: usize,
    /// Stored rejections across all clients; past it, a refused transaction cuts its sender off
    /// instead of being stored, so the rejections table is bounded per board however many
    /// clients there are.
    pub max_rejections: usize,
}

impl Default for Quota {
    /// The spec's numbers (§9): 20,000 transactions and 4 MiB of history; 1024 editing
    /// clients; 4096 stored rejections (sixteen clients' worth of `MAX_REJECTIONS_PER_CLIENT`).
    /// The server raises the history caps (config.rs) because it stores history compressed and
    /// keeps none of it in memory.
    fn default() -> Quota {
        Quota { max_log_ops: 20_000, max_log_bytes: 4 * 1024 * 1024, max_clients: 1024, max_rejections: 4096 }
    }
}

/// The single source of truth for one board. Processes messages one at a time.
///
/// It holds the document, not the log: every logged transaction leaves as an
/// [`Effect::Logged`], and the host keeps the log (on disk, for the server) and serves catch-up
/// ranges from it. So a loaded board costs its document plus its client and connection tables,
/// not its history.
pub struct Authority {
    doc: Doc,
    /// Entries in the log.
    log_len: u64,
    /// The log's size as stored, summed (what `Quota::max_log_bytes` caps).
    log_bytes: usize,
    clients: BTreeMap<ClientId, ClientRecord>,
    /// Stored rejections across every client (what `Quota::max_rejections` caps).
    rejections: usize,
    conns: BTreeMap<ConnId, Conn>,
    quota: Quota,
    /// Set by the host when storage as a whole is full: valid edits are refused with
    /// [`Reject::ServerFull`].
    storage_full: bool,
}

/// One thing to send on a connection, in order.
#[derive(Clone, Debug, PartialEq)]
pub enum Outgoing {
    Msg(ServerMsg),
    /// Log entries `from..=to`, as `ServerMsg::Entry`, in this position relative to the
    /// connection's other messages: the catch-up for a hello. It's a range, not the entries: the
    /// host streams it from its log at the client's pace instead of queueing the whole history at
    /// once (security review 2026-11-07, H-A). Every entry in it has already been reported as
    /// `Effect::Logged`, so a durable host has it on disk.
    CatchUp { from: u64, to: u64 },
}

pub type Outbox = Vec<(ConnId, Outgoing)>;

/// What a message changed that must be made durable *before* the outbox is sent: an
/// acknowledgement or rejection the client hears about must survive a crash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    /// `tx` is log entry `seq`, new. The host appends it to its log.
    Logged { seq: u64, tx: Tx },
    Rejected { client: ClientId, cseq: u64, reason: Reject },
    /// A client id was claimed for the first time, with this secret hash.
    ClientRegistered { client: ClientId, secret_hash: [u8; 32] },
    /// The client has heard about every rejection below `below`; storage may forget them.
    RejectionsResolved { client: ClientId, below: u64 },
}

/// Stored rejections a client may accumulate before it is cut off. Honest clients rarely
/// exceed a handful; the cap bounds what anyone can make the server store.
pub const MAX_REJECTIONS_PER_CLIENT: usize = 256;

/// A transaction's size as stored and sent: its JSON encoding.
pub fn encoded_len(tx: &Tx) -> usize {
    serde_json::to_vec(tx).map(|v| v.len()).unwrap_or(usize::MAX)
}

pub fn secret_hash(secret: &str) -> [u8; 32] {
    Sha256::digest(secret.as_bytes()).into()
}

impl Authority {
    pub fn new(doc: Doc) -> Self {
        Authority::with_quota(doc, Quota::default())
    }

    pub fn with_quota(doc: Doc, quota: Quota) -> Self {
        Authority {
            doc,
            log_len: 0,
            log_bytes: 0,
            clients: BTreeMap::new(),
            rejections: 0,
            conns: BTreeMap::new(),
            quota,
            storage_full: false,
        }
    }

    /// Storage as a whole is (or is no longer) full. While it is, valid edits are refused.
    pub fn set_storage_full(&mut self, full: bool) {
        self.storage_full = full;
    }

    /// The log's size as stored, summed.
    pub fn log_bytes(&self) -> usize {
        self.log_bytes
    }

    /// Entries in the log: the seq of the newest.
    pub fn log_len(&self) -> u64 {
        self.log_len
    }

    /// Client ids known (registered, or seen in the log).
    pub fn clients_len(&self) -> usize {
        self.clients.len()
    }

    /// Stored rejections across all clients.
    pub fn rejections_len(&self) -> usize {
        self.rejections
    }

    pub fn doc(&self) -> &Doc {
        &self.doc
    }

    /// Rebuild from storage: re-apply a logged transaction (in log order) that takes
    /// `stored_len` bytes in storage. The transaction itself isn't kept.
    pub fn replay(&mut self, tx: &Tx, stored_len: usize) -> Result<(), Reject> {
        apply_tx(&mut self.doc, tx)?;
        let rec = self.clients.entry(tx.client).or_default();
        rec.next_cseq = rec.next_cseq.max(tx.cseq + 1);
        self.log_bytes += stored_len;
        self.log_len += 1;
        Ok(())
    }

    /// Rebuild from storage: a registered client.
    pub fn replay_client(&mut self, client: ClientId, secret_hash: [u8; 32]) {
        self.clients.entry(client).or_default().secret_hash = Some(secret_hash);
    }

    /// Rebuild from storage: a stored rejection.
    pub fn replay_rejection(&mut self, client: ClientId, cseq: u64, reason: Reject) {
        let rec = self.clients.entry(client).or_default();
        rec.next_cseq = rec.next_cseq.max(cseq + 1);
        if rec.rejected.insert(cseq, reason).is_none() {
            self.rejections += 1;
        }
    }

    /// Connections currently attached (any state).
    pub fn connections(&self) -> impl Iterator<Item = ConnId> + '_ {
        self.conns.keys().copied()
    }

    pub fn is_live(&self, conn: ConnId) -> bool {
        matches!(self.conns.get(&conn), Some(Conn::Live { .. }))
    }

    pub fn connect(&mut self, conn: ConnId, role: Role) {
        self.conns.insert(conn, Conn::Connecting { role });
    }

    pub fn disconnect(&mut self, conn: ConnId) {
        self.conns.remove(&conn);
    }

    /// Handle one message. Returns what to send, in order. A `Fatal` reply means the caller must
    /// close that connection (this authority has already forgotten it). A submitted transaction
    /// counts its JSON encoding against the byte quota.
    pub fn handle(&mut self, conn: ConnId, msg: ClientMsg) -> (Outbox, Vec<Effect>) {
        self.handle_inner(conn, msg, None)
    }

    /// Like [`handle`](Self::handle), for a host that stores transactions in another encoding: a
    /// `Submit`'s transaction will take `stored_len` bytes in storage, and that's what counts
    /// against the byte quota. Ignored for other messages.
    pub fn handle_stored(&mut self, conn: ConnId, msg: ClientMsg, stored_len: usize) -> (Outbox, Vec<Effect>) {
        self.handle_inner(conn, msg, Some(stored_len))
    }

    fn handle_inner(&mut self, conn: ConnId, msg: ClientMsg, stored_len: Option<usize>) -> (Outbox, Vec<Effect>) {
        let Some(state) = self.conns.get(&conn).copied() else {
            return (Vec::new(), Vec::new()); // message raced a disconnect
        };
        match (state, msg) {
            (Conn::Connecting { role }, ClientMsg::Hello(hello)) => self.hello(conn, role, hello),
            (Conn::Live { role, client }, ClientMsg::Submit(tx)) => self.submit(conn, role, client, tx, stored_len),
            (Conn::Connecting { .. }, ClientMsg::Submit(_)) => (self.fatal(conn, "submit before hello"), Vec::new()),
            (Conn::Live { .. }, ClientMsg::Hello(_)) => (self.fatal(conn, "second hello"), Vec::new()),
        }
    }

    fn fatal(&mut self, conn: ConnId, why: &str) -> Outbox {
        self.conns.remove(&conn);
        vec![(conn, Outgoing::Msg(ServerMsg::Fatal(why.to_owned())))]
    }

    fn hello(&mut self, conn: ConnId, role: Role, hello: Hello) -> (Outbox, Vec<Effect>) {
        let len = self.log_len;
        if hello.last_seq > len {
            return (self.fatal(conn, "client is ahead of the server's log"), Vec::new());
        }
        if hello.secret.is_empty() || hello.secret.len() > 128 {
            return (self.fatal(conn, "bad client secret"), Vec::new());
        }
        let mut effects = Vec::new();
        let presented = secret_hash(&hello.secret);
        match self.clients.get(&hello.client).and_then(|r| r.secret_hash) {
            Some(known) if known != presented => {
                // Someone else's id. Refuse; never supersede the real owner's connection.
                return (self.fatal(conn, "client id belongs to another client"), Vec::new());
            }
            Some(_) => {}
            // A view link never edits, so there is nothing to bind its id to: registering it
            // would let the lowest capability grow storage and memory without bound (security
            // review 2026-11-07, H-B). An id someone has registered is still checked above.
            None if role == Role::View => {}
            None => {
                if !self.clients.contains_key(&hello.client) && self.clients.len() >= self.quota.max_clients {
                    return (self.fatal(conn, "board has too many clients"), Vec::new());
                }
                self.clients.entry(hello.client).or_default().secret_hash = Some(presented);
                effects.push(Effect::ClientRegistered { client: hello.client, secret_hash: presented });
            }
        }
        let mut out: Outbox = Vec::new();
        if let Some(rec) = self.clients.get_mut(&hello.client) {
            // The client has resolved everything below `pending_from`, so forget those rejections.
            let before = rec.rejected.len();
            rec.rejected = rec.rejected.split_off(&hello.pending_from);
            if rec.rejected.len() != before {
                self.rejections -= before - rec.rejected.len();
                effects.push(Effect::RejectionsResolved { client: hello.client, below: hello.pending_from });
            }
            out.extend(
                rec.rejected
                    .iter()
                    .map(|(cseq, reason)| (conn, Outgoing::Msg(ServerMsg::Rejected { cseq: *cseq, reason: reason.clone() }))),
            );
        }

        // One live connection per client: a newer one supersedes the old.
        let stale: Vec<ConnId> = self
            .conns
            .iter()
            .filter(|(c, s)| **c != conn && matches!(s, Conn::Live { client, .. } if *client == hello.client))
            .map(|(c, _)| *c)
            .collect();
        for c in stale {
            self.conns.remove(&c);
            out.push((c, Outgoing::Msg(ServerMsg::Fatal("superseded by a newer connection".into()))));
        }

        if hello.last_seq < len {
            out.push((conn, Outgoing::CatchUp { from: hello.last_seq + 1, to: len }));
        }
        self.conns.insert(conn, Conn::Live { role, client: hello.client });
        (out, effects)
    }

    fn submit(&mut self, conn: ConnId, role: Role, client: ClientId, tx: Tx, stored_len: Option<usize>) -> (Outbox, Vec<Effect>) {
        if tx.client != client {
            return (self.fatal(conn, "transaction from another client"), Vec::new());
        }
        // A view link never edits: an honest UI doesn't offer it, so this is abuse. Closing
        // costs nothing durable, where storing a rejection would (security review, H2).
        if role == Role::View {
            return (self.fatal(conn, "view links cannot edit"), Vec::new());
        }
        let rec = self.clients.entry(client).or_default();
        if tx.cseq < rec.next_cseq {
            return (Vec::new(), Vec::new()); // a resend after reconnect; already decided and reported
        }
        if tx.cseq > rec.next_cseq {
            return (self.fatal(conn, "transaction sequence gap"), Vec::new());
        }
        // Admission before validity: size, then the board's and the server's room for it.
        let json_len = encoded_len(&tx);
        let size = stored_len.unwrap_or(json_len);
        let result = if json_len > LIMITS.max_tx_bytes {
            Err(Reject::TxTooLarge)
        } else if self.log_len >= self.quota.max_log_ops as u64 || self.log_bytes.saturating_add(size) > self.quota.max_log_bytes {
            Err(Reject::BoardFull)
        } else if self.storage_full {
            Err(Reject::ServerFull)
        } else {
            apply_tx(&mut self.doc, &tx).map(|_| ())
        };
        if result.is_err() && (rec.rejected.len() >= MAX_REJECTIONS_PER_CLIENT || self.rejections >= self.quota.max_rejections) {
            return (self.fatal(conn, "too many rejected transactions"), Vec::new());
        }
        rec.next_cseq += 1;
        match result {
            Ok(()) => {
                self.log_bytes += size;
                self.log_len += 1;
                let seq = self.log_len;
                let out = self
                    .conns
                    .iter()
                    .filter(|(_, s)| matches!(s, Conn::Live { .. }))
                    .map(|(c, _)| (*c, Outgoing::Msg(ServerMsg::Entry { seq, tx: tx.clone() })))
                    .collect();
                (out, vec![Effect::Logged { seq, tx }])
            }
            Err(reason) => {
                rec.rejected.insert(tx.cseq, reason.clone());
                self.rejections += 1;
                let effect = Effect::Rejected { client, cseq: tx.cseq, reason: reason.clone() };
                (vec![(conn, Outgoing::Msg(ServerMsg::Rejected { cseq: tx.cseq, reason }))], vec![effect])
            }
        }
    }
}
