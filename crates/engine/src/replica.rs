use crate::protocol::{ClientMsg, Hello, ServerMsg};
use mapcro_schema::{ClientId, Doc, Op, Reject, Tx, TxKind, apply_tx, apply_tx_with_inverse};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// What the UI's save indicator shows (spec §4). Never `Saved` while anything is pending.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaveStatus {
    Saved,
    Syncing(usize),
    Offline(usize),
}

/// The server broke the protocol. The caller drops the connection and reconnects; the replica's
/// pending work is untouched, so nothing is lost.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    #[error("entry {got} arrived but {expected} was next")]
    Gap { expected: u64, got: u64 },
    #[error("acknowledgement for cseq {got} but the oldest pending is {expected:?}")]
    AckMismatch { expected: Option<u64>, got: u64 },
    #[error("server entry {seq} does not apply locally: {reason}")]
    Diverged { seq: u64, reason: Reject },
    #[error("server closed the connection: {0}")]
    Fatal(String),
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum UndoError {
    #[error("nothing to undo")]
    Empty,
    #[error("undo is no longer valid here: {0}")]
    Invalid(Reject),
}

/// A history entry: the ops that invert transaction `cseq` of this client.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct HistoryEntry {
    cseq: u64,
    inverse: Vec<Op>,
}

/// Everything a replica must keep across a page reload: above all the pending queue, which is
/// written to IndexedDB before it is sent (spec §4).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReplicaState {
    client: ClientId,
    secret: String,
    confirmed: Doc,
    last_seq: u64,
    pending: VecDeque<Tx>,
    next_cseq: u64,
    undo: Vec<HistoryEntry>,
    redo: Vec<HistoryEntry>,
    rejected: Vec<(u64, Reject)>,
}

/// One client's replica of a board.
pub struct Replica {
    client: ClientId,
    secret: String,
    confirmed: Doc,
    last_seq: u64,
    pending: VecDeque<Tx>,
    next_cseq: u64,
    view: Doc,
    undo: Vec<HistoryEntry>,
    redo: Vec<HistoryEntry>,
    rejected: Vec<(u64, Reject)>,
    connected: bool,
}

impl Replica {
    /// Start from `doc`, which is the server's state at `last_seq`. `secret` is random, chosen
    /// once with the client id, and kept with the replica's state.
    pub fn new(client: ClientId, secret: String, doc: Doc, last_seq: u64) -> Self {
        Replica {
            client,
            secret,
            view: doc.clone(),
            confirmed: doc,
            last_seq,
            pending: VecDeque::new(),
            next_cseq: 0,
            undo: Vec::new(),
            redo: Vec::new(),
            rejected: Vec::new(),
            connected: false,
        }
    }

    /// The state to persist. Restoring it gives back a disconnected replica with the same
    /// pending work, ready to `connect`.
    pub fn state(&self) -> ReplicaState {
        ReplicaState {
            client: self.client,
            secret: self.secret.clone(),
            confirmed: self.confirmed.clone(),
            last_seq: self.last_seq,
            pending: self.pending.clone(),
            next_cseq: self.next_cseq,
            undo: self.undo.clone(),
            redo: self.redo.clone(),
            rejected: self.rejected.clone(),
        }
    }

    pub fn from_state(s: ReplicaState) -> Replica {
        let mut r = Replica {
            client: s.client,
            secret: s.secret,
            view: s.confirmed.clone(),
            confirmed: s.confirmed,
            last_seq: s.last_seq,
            pending: s.pending,
            next_cseq: s.next_cseq,
            undo: s.undo,
            redo: s.redo,
            rejected: s.rejected,
            connected: false,
        };
        r.rebase();
        r
    }

    pub fn client(&self) -> ClientId {
        self.client
    }
    /// What the UI renders: confirmed state with pending work applied on top.
    pub fn view(&self) -> &Doc {
        &self.view
    }
    pub fn confirmed(&self) -> &Doc {
        &self.confirmed
    }
    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }
    pub fn pending(&self) -> impl Iterator<Item = &Tx> {
        self.pending.iter()
    }
    pub fn next_cseq(&self) -> u64 {
        self.next_cseq
    }
    /// Transactions the server refused, with reasons (for the UI and for tests).
    pub fn rejected(&self) -> &[(u64, Reject)] {
        &self.rejected
    }
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
    pub fn is_connected(&self) -> bool {
        self.connected
    }

    pub fn status(&self) -> SaveStatus {
        match (self.pending.len(), self.connected) {
            (0, _) => SaveStatus::Saved,
            (n, true) => SaveStatus::Syncing(n),
            (n, false) => SaveStatus::Offline(n),
        }
    }

    /// Make an edit. It applies to the view immediately; the returned message (if connected)
    /// sends it. Invalid edits are refused locally with the same rules the server uses.
    pub fn edit(&mut self, ops: Vec<Op>) -> Result<Option<ClientMsg>, Reject> {
        let msg = self.submit(ops, TxKind::Edit)?;
        self.redo.clear();
        Ok(msg)
    }

    /// Undo this client's most recent transaction that still has an undo entry.
    pub fn undo(&mut self) -> Result<Option<ClientMsg>, UndoError> {
        let entry = self.undo.pop().ok_or(UndoError::Empty)?;
        self.submit(entry.inverse, TxKind::Undo { of: entry.cseq }).map_err(UndoError::Invalid)
    }

    pub fn redo(&mut self) -> Result<Option<ClientMsg>, UndoError> {
        let entry = self.redo.pop().ok_or(UndoError::Empty)?;
        self.submit(entry.inverse, TxKind::Redo { of: entry.cseq }).map_err(UndoError::Invalid)
    }

    fn submit(&mut self, ops: Vec<Op>, kind: TxKind) -> Result<Option<ClientMsg>, Reject> {
        let tx = Tx { client: self.client, cseq: self.next_cseq, kind, ops };
        let mut view = self.view.clone();
        let (_, inverse) = apply_tx_with_inverse(&mut view, &tx)?;
        self.view = view;
        self.next_cseq += 1;
        let entry = HistoryEntry { cseq: tx.cseq, inverse };
        if !entry.inverse.is_empty() {
            match kind {
                TxKind::Edit | TxKind::Redo { .. } => self.undo.push(entry),
                TxKind::Undo { .. } => self.redo.push(entry),
            }
        }
        let msg = self.connected.then(|| ClientMsg::Submit(tx.clone()));
        self.pending.push_back(tx);
        Ok(msg)
    }

    /// The transport connected. Send these, in order: the hello, then every pending transaction
    /// (the server ignores any it already decided).
    pub fn connect(&mut self) -> Vec<ClientMsg> {
        self.connected = true;
        let pending_from = self.pending.front().map_or(self.next_cseq, |t| t.cseq);
        let hello = Hello { client: self.client, secret: self.secret.clone(), last_seq: self.last_seq, pending_from };
        std::iter::once(ClientMsg::Hello(hello))
            .chain(self.pending.iter().cloned().map(ClientMsg::Submit))
            .collect()
    }

    pub fn disconnect(&mut self) {
        self.connected = false;
    }

    pub fn receive(&mut self, msg: ServerMsg) -> Result<(), ProtocolError> {
        match msg {
            ServerMsg::Entry { seq, tx } => {
                if seq <= self.last_seq {
                    return Ok(()); // already have it
                }
                if seq != self.last_seq + 1 {
                    return Err(ProtocolError::Gap { expected: self.last_seq + 1, got: seq });
                }
                if tx.client == self.client {
                    let front = self.pending.front().map(|t| t.cseq);
                    if front != Some(tx.cseq) {
                        return Err(ProtocolError::AckMismatch { expected: front, got: tx.cseq });
                    }
                }
                apply_tx(&mut self.confirmed, &tx).map_err(|reason| ProtocolError::Diverged { seq, reason })?;
                self.last_seq = seq;
                if tx.client == self.client {
                    self.pending.pop_front();
                }
                self.rebase();
                Ok(())
            }
            ServerMsg::Rejected { cseq, reason } => {
                let before = self.pending.len();
                self.pending.retain(|t| t.cseq != cseq);
                if self.pending.len() != before {
                    self.undo.retain(|e| e.cseq != cseq);
                    self.redo.retain(|e| e.cseq != cseq);
                    self.rejected.push((cseq, reason));
                    self.rebase();
                }
                Ok(())
            }
            ServerMsg::Fatal(why) => Err(ProtocolError::Fatal(why)),
            ServerMsg::Rebase { doc, seq, decided_below } => {
                // Adopt the board. A pending transaction below `decided_below` is in it, or was
                // refused and its rejection came first (so it's gone already): drop it. The rest
                // stay pending, on top, and were resent with the hello. Undo history is kept, as
                // across any reconnect: undo is evaluated by the server (spec §7).
                self.confirmed = doc;
                self.last_seq = seq;
                self.pending.retain(|t| t.cseq >= decided_below);
                self.rebase();
                Ok(())
            }
        }
    }

    /// Recompute the view: confirmed state with each pending transaction re-applied. One that no
    /// longer applies is left out of the view; the server will reject it and say why.
    fn rebase(&mut self) {
        let mut view = self.confirmed.clone();
        for tx in &self.pending {
            let _ = apply_tx(&mut view, tx);
        }
        self.view = view;
    }
}
