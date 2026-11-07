use crate::protocol::{ClientMsg, Hello, ServerMsg};
use mapcro_schema::{ClientId, Doc, Reject, Tx, apply_tx};
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
    /// Every `cseq` below this has been decided (applied or rejected).
    next_cseq: u64,
    /// Rejections the client may not have heard about yet. Pruned below its `pending_from`.
    rejected: BTreeMap<u64, Reject>,
}

/// The single source of truth for one board. Processes messages one at a time.
pub struct Authority {
    doc: Doc,
    log: Vec<Tx>,
    clients: BTreeMap<ClientId, ClientRecord>,
    conns: BTreeMap<ConnId, Conn>,
}

pub type Outbox = Vec<(ConnId, ServerMsg)>;

/// What a message changed that must be made durable *before* the outbox is sent: an
/// acknowledgement or rejection the client hears about must survive a crash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    None,
    /// `log()[seq - 1]` is new.
    Logged { seq: u64 },
    Rejected { client: ClientId, cseq: u64, reason: Reject },
}

impl Authority {
    pub fn new(doc: Doc) -> Self {
        Authority { doc, log: Vec::new(), clients: BTreeMap::new(), conns: BTreeMap::new() }
    }

    pub fn doc(&self) -> &Doc {
        &self.doc
    }

    /// The ordered log. Entry `seq` is `log[seq - 1]`.
    pub fn log(&self) -> &[Tx] {
        &self.log
    }

    /// Rebuild from storage: re-apply a logged transaction (in log order).
    pub fn replay(&mut self, tx: Tx) -> Result<(), Reject> {
        apply_tx(&mut self.doc, &tx)?;
        let rec = self.clients.entry(tx.client).or_default();
        rec.next_cseq = rec.next_cseq.max(tx.cseq + 1);
        self.log.push(tx);
        Ok(())
    }

    /// Rebuild from storage: a stored rejection.
    pub fn replay_rejection(&mut self, client: ClientId, cseq: u64, reason: Reject) {
        let rec = self.clients.entry(client).or_default();
        rec.next_cseq = rec.next_cseq.max(cseq + 1);
        rec.rejected.insert(cseq, reason);
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
    /// close that connection (this authority has already forgotten it).
    pub fn handle(&mut self, conn: ConnId, msg: ClientMsg) -> (Outbox, Effect) {
        let Some(state) = self.conns.get(&conn).copied() else {
            return (Vec::new(), Effect::None); // message raced a disconnect
        };
        match (state, msg) {
            (Conn::Connecting { role }, ClientMsg::Hello(hello)) => (self.hello(conn, role, hello), Effect::None),
            (Conn::Live { role, client }, ClientMsg::Submit(tx)) => self.submit(conn, role, client, tx),
            (Conn::Connecting { .. }, ClientMsg::Submit(_)) => (self.fatal(conn, "submit before hello"), Effect::None),
            (Conn::Live { .. }, ClientMsg::Hello(_)) => (self.fatal(conn, "second hello"), Effect::None),
        }
    }

    fn fatal(&mut self, conn: ConnId, why: &str) -> Outbox {
        self.conns.remove(&conn);
        vec![(conn, ServerMsg::Fatal(why.to_owned()))]
    }

    fn hello(&mut self, conn: ConnId, role: Role, hello: Hello) -> Outbox {
        let len = self.log.len() as u64;
        if hello.last_seq > len {
            return self.fatal(conn, "client is ahead of the server's log");
        }
        let rec = self.clients.entry(hello.client).or_default();
        // The client has resolved everything below `pending_from`, so forget those rejections.
        rec.rejected = rec.rejected.split_off(&hello.pending_from);
        let mut out: Outbox = rec
            .rejected
            .iter()
            .map(|(cseq, reason)| (conn, ServerMsg::Rejected { cseq: *cseq, reason: reason.clone() }))
            .collect();

        // One live connection per client: a newer one supersedes the old.
        let stale: Vec<ConnId> = self
            .conns
            .iter()
            .filter(|(c, s)| **c != conn && matches!(s, Conn::Live { client, .. } if *client == hello.client))
            .map(|(c, _)| *c)
            .collect();
        for c in stale {
            self.conns.remove(&c);
            out.push((c, ServerMsg::Fatal("superseded by a newer connection".into())));
        }

        for (i, tx) in self.log.iter().enumerate().skip(hello.last_seq as usize) {
            out.push((conn, ServerMsg::Entry { seq: i as u64 + 1, tx: tx.clone() }));
        }
        self.conns.insert(conn, Conn::Live { role, client: hello.client });
        out
    }

    fn submit(&mut self, conn: ConnId, role: Role, client: ClientId, tx: Tx) -> (Outbox, Effect) {
        if tx.client != client {
            return (self.fatal(conn, "transaction from another client"), Effect::None);
        }
        let rec = self.clients.entry(client).or_default();
        if tx.cseq < rec.next_cseq {
            return (Vec::new(), Effect::None); // a resend after reconnect; already decided and reported
        }
        if tx.cseq > rec.next_cseq {
            return (self.fatal(conn, "transaction sequence gap"), Effect::None);
        }
        rec.next_cseq += 1;

        let result = match role {
            Role::View => Err(Reject::Forbidden),
            Role::Edit => apply_tx(&mut self.doc, &tx).map(|_| ()),
        };
        match result {
            Ok(()) => {
                self.log.push(tx.clone());
                let seq = self.log.len() as u64;
                let out = self
                    .conns
                    .iter()
                    .filter(|(_, s)| matches!(s, Conn::Live { .. }))
                    .map(|(c, _)| (*c, ServerMsg::Entry { seq, tx: tx.clone() }))
                    .collect();
                (out, Effect::Logged { seq })
            }
            Err(reason) => {
                rec.rejected.insert(tx.cseq, reason.clone());
                let effect = Effect::Rejected { client, cseq: tx.cseq, reason: reason.clone() };
                (vec![(conn, ServerMsg::Rejected { cseq: tx.cseq, reason })], effect)
            }
        }
    }
}
