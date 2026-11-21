use crate::protocol::{ClientMsg, Hello, ServerMsg};
use mapcro_schema::{ClientId, Doc, Op, Reject, Tx, TxKind, apply_tx, apply_tx_with_inverse, op_target};
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
    /// The ops the next `undo` (`redo`) would submit, if there is one: the records it can touch.
    pub fn next_undo(&self) -> Option<&[Op]> {
        self.undo.last().map(|e| e.inverse.as_slice())
    }
    pub fn next_redo(&self) -> Option<&[Op]> {
        self.redo.last().map(|e| e.inverse.as_slice())
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
        let msg = self.submit(ops, TxKind::Edit, Vec::new())?;
        self.redo.clear();
        Ok(msg)
    }

    /// Make an edit that isn't one of yours to undo (spec §6b: Player's live annotation layer,
    /// made and cleared by the app, not the user). To the undo and redo stacks it's like a
    /// remote peer's edit: no undo entry, and redo is kept. On the wire it's an ordinary edit.
    pub fn edit_silent(&mut self, ops: Vec<Op>) -> Result<Option<ClientMsg>, Reject> {
        let tx = Tx { client: self.client, cseq: self.next_cseq, kind: TxKind::Edit, ops };
        apply_tx(&mut self.view, &tx)?;
        self.next_cseq += 1;
        let msg = self.connected.then(|| ClientMsg::Submit(tx.clone()));
        self.pending.push_back(tx);
        Ok(msg)
    }

    /// Undo this client's most recent transaction that still has an undo entry.
    pub fn undo(&mut self) -> Result<Option<ClientMsg>, UndoError> {
        let entry = self.undo.pop().ok_or(UndoError::Empty)?;
        self.submit(entry.inverse, TxKind::Undo { of: entry.cseq }, Vec::new()).map_err(UndoError::Invalid)
    }

    pub fn redo(&mut self) -> Result<Option<ClientMsg>, UndoError> {
        let entry = self.redo.pop().ok_or(UndoError::Empty)?;
        self.submit(entry.inverse, TxKind::Redo { of: entry.cseq }, Vec::new()).map_err(UndoError::Invalid)
    }

    /// Undo the step [`next_undo`](Self::next_undo) shows, as the caller re-decided it from the
    /// view (TD-145: a hero's record in a scene that holds its heroes, whose `hero` and build
    /// must hold or fall together). `ops` go in the step's place, as its undo
    /// (`TxKind::Undo { of }`): on the wire an undo like any other, which the server applies as
    /// it does every transaction. Empty `ops`: the step no longer fits anywhere, and is dropped
    /// with nothing sent.
    ///
    /// `carry`: ops the redo step keeps besides the inverse of `ops`, ahead of it, for the
    /// records that inverse touches (the caller's assertions about what the step expects, such
    /// as a `SetIf` of a value onto itself; an inverse can't hold one, as a write that changes
    /// nothing has none). Sent as they are, by a plain `redo`, they must change nothing.
    pub fn undo_as(&mut self, ops: Vec<Op>, carry: Vec<Op>) -> Result<Option<ClientMsg>, UndoError> {
        let entry = self.undo.pop().ok_or(UndoError::Empty)?;
        if ops.is_empty() {
            return Ok(None);
        }
        self.submit(ops, TxKind::Undo { of: entry.cseq }, carry).map_err(UndoError::Invalid)
    }

    /// [`undo_as`](Self::undo_as) for the step [`next_redo`](Self::next_redo) shows.
    pub fn redo_as(&mut self, ops: Vec<Op>, carry: Vec<Op>) -> Result<Option<ClientMsg>, UndoError> {
        let entry = self.redo.pop().ok_or(UndoError::Empty)?;
        if ops.is_empty() {
            return Ok(None);
        }
        self.submit(ops, TxKind::Redo { of: entry.cseq }, carry).map_err(UndoError::Invalid)
    }

    fn submit(&mut self, ops: Vec<Op>, kind: TxKind, carry: Vec<Op>) -> Result<Option<ClientMsg>, Reject> {
        let tx = Tx { client: self.client, cseq: self.next_cseq, kind, ops };
        // In place: a refused transaction is rolled back by `apply_tx_with_inverse` itself, so
        // an edit costs what it touches, not a copy of the board (map-state spec §6).
        let (_, mut inverse) = apply_tx_with_inverse(&mut self.view, &tx)?;
        self.next_cseq += 1;
        // The carry goes with the records the step touches: none, if it has no step.
        let kept: Vec<Op> = carry.into_iter().filter(|c| inverse.iter().any(|o| op_target(o) == op_target(c))).collect();
        inverse.splice(0..0, kept);
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
                // The view is the confirmed state with the pending work on top. Two entries
                // leave it that without rebuilding it from a copy of the board (map-state
                // spec §6: a drag is an edit and its ack on every frame).
                if tx.client == self.client {
                    // Our oldest pending transaction, as we sent it: it applied to the
                    // confirmed state just now exactly as it had under the view, so the view
                    // holds it already. Anything else under our cseq is the server's to say.
                    if self.pending.pop_front().as_ref() != Some(&tx) {
                        self.rebase();
                    }
                } else if self.pending.is_empty() {
                    // Nothing pending: the view was the confirmed state, and takes the same
                    // transaction the same way.
                    if apply_tx(&mut self.view, &tx).is_err() {
                        self.rebase();
                    }
                } else {
                    self.rebase();
                }
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

    /// Whether the view is what it is defined to be: the confirmed state with each pending
    /// transaction applied on top. Edits and most entries change the view in place instead of
    /// rebuilding it, so the simulation asks this at every step.
    pub fn view_is_rebuilt(&self) -> bool {
        let mut view = self.confirmed.clone();
        for tx in &self.pending {
            let _ = apply_tx(&mut view, tx);
        }
        view == self.view
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

#[cfg(test)]
mod silent_tests {
    use super::*;
    use mapcro_schema::{Callout, FieldValue, Record, RecordId, WorldPos, genesis};

    const SCENE: RecordId = RecordId(14); // genesis: meta 1, slots 2..=13, then the scene

    fn replica() -> Replica {
        let mut n = 0u128;
        let doc = genesis(
            || {
                n += 1;
                RecordId(n)
            },
            "t",
        );
        assert!(matches!(doc.live(SCENE), Some(Record::Scene(_))));
        Replica::new(ClientId(7), "secret".into(), doc, 0)
    }

    fn note(id: u128, text: &str) -> Op {
        Op::Create { id: RecordId(id), record: Record::Callout(Callout { scene: SCENE, pos: WorldPos { x: 0, y: 0 }, text: text.into(), color: None, side: Default::default() }) }
    }

    fn text(r: &Replica, id: u128) -> Option<String> {
        match r.view().live(RecordId(id)) {
            Some(Record::Callout(c)) => Some(c.text.clone()),
            _ => None,
        }
    }

    #[test]
    fn an_undo_after_a_silent_edit_undoes_the_users_edit_only() {
        let mut r = replica();
        r.edit(vec![note(100, "mine")]).expect("edit");
        r.edit_silent(vec![note(101, "the app's")]).expect("silent");
        r.undo().expect("undo");
        assert_eq!(text(&r, 100), None);
        assert_eq!(text(&r, 101).as_deref(), Some("the app's"));
        assert!(!r.can_undo(), "the silent edit left no undo entry");
    }

    #[test]
    fn a_silent_edit_keeps_redo() {
        let mut r = replica();
        r.edit(vec![note(100, "mine")]).expect("edit");
        r.undo().expect("undo");
        assert!(r.can_redo());
        r.edit_silent(vec![note(101, "the app's")]).expect("silent");
        assert!(r.can_redo(), "unlike an edit, a silent edit keeps redo");
        r.redo().expect("redo");
        assert_eq!(text(&r, 100).as_deref(), Some("mine"));
    }

    #[test]
    fn a_redo_over_a_silent_write_behaves_as_over_a_remote_one() {
        // Two replicas: one sees a silent write, the other the same write as a remote peer's.
        let start = || {
            let mut r = replica();
            r.edit(vec![note(100, "x")]).expect("create");
            r.edit(vec![Op::Set { id: RecordId(100), value: FieldValue::CalloutText("a".into()) }]).expect("set");
            r.undo().expect("undo");
            r
        };
        let (mut a, mut b) = (start(), start());
        a.edit_silent(vec![Op::Set { id: RecordId(100), value: FieldValue::CalloutText("b".into()) }]).expect("silent");
        // The "remote" write: applied to b's view as another client's would be.
        let mut view = b.view.clone();
        let remote = Tx { client: ClientId(99), cseq: 1, kind: TxKind::Edit, ops: vec![Op::Set { id: RecordId(100), value: FieldValue::CalloutText("b".into()) }] };
        apply_tx(&mut view, &remote).expect("remote");
        b.view = view;
        let (ra, rb) = (a.redo().map(|_| ()), b.redo().map(|_| ()));
        assert_eq!(ra.is_ok(), rb.is_ok());
        assert_eq!(text(&a, 100), text(&b, 100));
    }
}

/// `undo_as` and `redo_as`: a step as the caller re-decided it (TD-145).
#[cfg(test)]
mod as_tests {
    use super::*;
    use mapcro_schema::{Callout, FieldValue, Record, RecordId, WorldPos, genesis};

    const SCENE: RecordId = RecordId(14);
    const A: RecordId = RecordId(100);
    const B: RecordId = RecordId(101);

    fn replica() -> Replica {
        let mut n = 0u128;
        let doc = genesis(
            || {
                n += 1;
                RecordId(n)
            },
            "t",
        );
        Replica::new(ClientId(7), "secret".into(), doc, 0)
    }
    fn text(v: &str) -> FieldValue {
        FieldValue::CalloutText(v.into())
    }
    fn set(id: RecordId, v: &str) -> Op {
        Op::Set { id, value: text(v) }
    }
    fn set_if(id: RecordId, from: &str, to: &str) -> Op {
        Op::SetIf { id, expect: text(from), value: text(to) }
    }
    fn read(r: &Replica, id: RecordId) -> Option<String> {
        match r.view().live(id) {
            Some(Record::Callout(c)) => Some(c.text.clone()),
            _ => None,
        }
    }
    /// Two notes made, then both written in one edit: its undo touches both.
    fn two_written() -> Replica {
        let mut r = replica();
        let note = |id| Op::Create { id, record: Record::Callout(Callout { scene: SCENE, pos: WorldPos { x: 0, y: 0 }, text: "x".into(), color: None, side: Default::default() }) };
        r.edit(vec![note(A), note(B)]).expect("create");
        r.edit(vec![set(A, "a"), set(B, "b")]).expect("write");
        r
    }
    fn sent(msg: Option<ClientMsg>) -> Tx {
        match msg {
            Some(ClientMsg::Submit(tx)) => tx,
            other => panic!("expected a submit, got {other:?}"),
        }
    }

    #[test]
    fn the_decided_ops_go_as_the_steps_undo_and_their_inverse_is_the_redo() {
        let mut r = two_written();
        r.connect();
        assert_eq!(r.next_undo(), Some(&[set_if(B, "b", "x"), set_if(A, "a", "x")][..]));
        let of = r.undo.last().expect("entry").cseq;
        let tx = sent(r.undo_as(vec![set(A, "x")], Vec::new()).expect("undo_as"));
        assert_eq!(tx.kind, TxKind::Undo { of });
        assert_eq!(tx.ops, vec![set(A, "x")]);
        // Only what was sent changed: B's part of the step was left out.
        assert_eq!((read(&r, A).as_deref(), read(&r, B).as_deref()), (Some("x"), Some("b")));
        assert_eq!(r.next_redo(), Some(&[set_if(A, "x", "a")][..]));
        // The step that was undone is gone; the one under it is next.
        assert_eq!(r.undo.len(), 1);
    }

    #[test]
    fn a_redo_after_undo_as_redoes_what_was_sent() {
        let mut r = two_written();
        r.undo_as(vec![set(A, "x")], Vec::new()).expect("undo_as");
        r.redo().expect("redo");
        assert_eq!((read(&r, A).as_deref(), read(&r, B).as_deref()), (Some("a"), Some("b")));
        // And it can be undone again, as any redo can.
        assert_eq!(r.next_undo(), Some(&[set_if(A, "a", "x")][..]));
        // redo_as, likewise, as the redo's own kind.
        r.undo().expect("undo");
        r.connect();
        let of = r.redo.last().expect("entry").cseq;
        let tx = sent(r.redo_as(vec![set(A, "a")], Vec::new()).expect("redo_as"));
        assert_eq!(tx.kind, TxKind::Redo { of });
        assert_eq!(read(&r, A).as_deref(), Some("a"));
        assert_eq!(r.next_undo(), Some(&[set_if(A, "a", "x")][..]));
        assert!(!r.can_redo());
    }

    #[test]
    fn steps_undone_as_decided_keep_the_redo_stack_in_order() {
        let mut r = two_written();
        r.undo_as(vec![set(A, "x"), set(B, "x")], Vec::new()).expect("first");
        r.undo_as(next_ops(&r), Vec::new()).expect("second");
        assert!(r.view().live(A).is_none(), "the creation undone");
        // Both are redone, last undone first, as plain undos would be.
        r.redo_as(next_redo_ops(&r), Vec::new()).expect("redo the creation");
        assert_eq!(read(&r, A).as_deref(), Some("x"));
        r.redo().expect("redo the write");
        assert_eq!((read(&r, A).as_deref(), read(&r, B).as_deref()), (Some("a"), Some("b")));
        assert!(!r.can_redo());
    }
    fn next_ops(r: &Replica) -> Vec<Op> {
        r.next_undo().expect("a step").to_vec()
    }
    fn next_redo_ops(r: &Replica) -> Vec<Op> {
        r.next_redo().expect("a step").to_vec()
    }

    #[test]
    fn the_carry_goes_ahead_of_the_inverse_for_the_records_it_touches_only() {
        let mut r = two_written();
        let mine = set_if(A, "x", "x");
        let other = set_if(B, "b", "b");
        r.undo_as(vec![set(A, "x")], vec![mine.clone(), other]).expect("undo_as");
        // B's assertion is dropped: the redo doesn't touch B.
        assert_eq!(r.next_redo(), Some(&[mine.clone(), set_if(A, "x", "a")][..]));
        // Sent as it is by a plain redo, the assertion changes nothing.
        r.redo().expect("redo");
        assert_eq!((read(&r, A).as_deref(), read(&r, B).as_deref()), (Some("a"), Some("b")));
        // A step whose inverse is empty keeps no carry: there is no step.
        r.undo().expect("undo");
        let undos = r.undo.len();
        r.redo_as(vec![set(A, "a"), set(A, "a")], vec![set_if(A, "a", "a")]).expect("redo_as");
        assert_eq!(r.undo.len(), undos + 1, "the redo changed A, so it has an undo");
        assert_eq!(r.next_undo(), Some(&[set_if(A, "a", "a"), set_if(A, "a", "x")][..]), "redo_as keeps its carry too");
        r.undo_as(vec![set(A, "a")], vec![set_if(A, "a", "a")]).expect("undo_as");
        assert!(!r.can_redo(), "an undo that wrote what was there has no redo, carry or not");
    }

    #[test]
    fn an_empty_decided_step_drops_the_step_and_sends_nothing() {
        let mut r = two_written();
        r.connect();
        let (cseq, pending, redo) = (r.next_cseq(), r.pending().count(), r.redo.len());
        let view = r.view().clone();
        assert_eq!(r.undo_as(Vec::new(), vec![set_if(A, "a", "a")]).expect("undo_as"), None);
        assert_eq!((r.next_cseq(), r.pending().count(), r.redo.len()), (cseq, pending, redo));
        assert_eq!(r.view(), &view);
        // The step is gone: the next undo is the one under it (the notes' creation).
        assert_eq!(r.undo.len(), 1);
        r.undo().expect("undo");
        assert_eq!(read(&r, A), None);
        // Likewise for redo.
        r.redo_as(Vec::new(), Vec::new()).expect("redo_as");
        assert!(!r.can_redo());
        assert_eq!(r.undo_as(Vec::new(), Vec::new()), Err(UndoError::Empty));
        assert_eq!(r.redo_as(vec![set(A, "a")], Vec::new()), Err(UndoError::Empty));
    }

    #[test]
    fn an_undo_that_no_longer_fits_is_skipped_as_any_undo_is() {
        let mut r = two_written();
        // Someone else wrote A since: the decided step still says what this client saw.
        let mut view = r.view.clone();
        apply_tx(&mut view, &Tx { client: ClientId(99), cseq: 0, kind: TxKind::Edit, ops: vec![set(A, "theirs")] }).expect("remote");
        r.view = view;
        r.undo_as(vec![set_if(A, "a", "x"), set_if(B, "b", "x")], Vec::new()).expect("undo_as");
        assert_eq!((read(&r, A).as_deref(), read(&r, B).as_deref()), (Some("theirs"), Some("x")));
        assert_eq!(r.next_redo(), Some(&[set_if(B, "x", "b")][..]));
        // A decided step refused locally is lost with its entry, as `undo`'s is.
        let undos = r.undo.len();
        assert!(matches!(r.undo_as(vec![set(RecordId(999), "x")], Vec::new()), Err(UndoError::Invalid(_))));
        assert_eq!(r.undo.len(), undos - 1);
    }
}

/// The view against its definition (the confirmed state with each pending transaction on top),
/// through every path that changes it without rebuilding it (map-state spec §6, "Edit cost").
#[cfg(test)]
mod view_tests {
    use super::*;
    use mapcro_schema::{Callout, FieldValue, Record, RecordId, WorldPos, genesis};

    const SCENE: RecordId = RecordId(14);

    fn replica(client: u128) -> Replica {
        let mut n = 0u128;
        let doc = genesis(
            || {
                n += 1;
                RecordId(n)
            },
            "t",
        );
        Replica::new(ClientId(client), "secret".into(), doc, 0)
    }

    fn note(id: u128, text: &str) -> Op {
        Op::Create { id: RecordId(id), record: Record::Callout(Callout { scene: SCENE, pos: WorldPos { x: 0, y: 0 }, text: text.into(), color: None, side: Default::default() }) }
    }

    fn text(id: u128, text: &str) -> Op {
        Op::Set { id: RecordId(id), value: FieldValue::CalloutText(text.into()) }
    }

    /// The view as its definition gives it.
    fn rebuilt(r: &Replica) -> Doc {
        let mut view = r.confirmed.clone();
        for tx in &r.pending {
            let _ = apply_tx(&mut view, tx);
        }
        view
    }

    fn sent(msg: Option<ClientMsg>) -> Tx {
        match msg {
            Some(ClientMsg::Submit(tx)) => tx,
            other => panic!("expected a submit, got {other:?}"),
        }
    }

    #[test]
    fn a_refused_edit_changes_nothing() {
        let mut r = replica(7);
        r.connect();
        r.edit(vec![note(100, "kept")]).expect("edit");
        let (view, pending, cseq) = (r.view().clone(), r.pending.clone(), r.next_cseq());
        // The first op is valid and applies before the second is refused: it must be rolled back.
        let bad = vec![text(100, "changed"), note(100, "an id already taken")];
        assert!(r.edit(bad.clone()).is_err());
        assert!(r.edit_silent(bad).is_err());
        assert_eq!(r.view(), &view);
        assert_eq!(r.pending, pending);
        assert_eq!(r.next_cseq(), cseq);
        assert_eq!(r.undo.len(), 1, "no undo entry for an edit that was refused");
        assert!(r.view_is_rebuilt());
    }

    #[test]
    fn local_edits_undo_and_redo_keep_the_view_rebuilt() {
        let mut r = replica(7);
        r.edit(vec![note(100, "a")]).expect("create");
        r.edit_silent(vec![note(101, "b")]).expect("silent");
        r.edit(vec![text(100, "c"), text(101, "d")]).expect("set");
        r.undo().expect("undo");
        r.redo().expect("redo");
        r.undo().expect("undo");
        assert_eq!(r.view(), &rebuilt(&r));
        assert!(r.view_is_rebuilt());
    }

    #[test]
    fn an_ack_of_the_oldest_pending_edit_leaves_the_view_as_it_was() {
        let mut r = replica(7);
        r.connect();
        let first = sent(r.edit(vec![note(100, "a")]).expect("first"));
        let second = sent(r.edit(vec![text(100, "b")]).expect("second"));
        let view = r.view().clone();
        r.receive(ServerMsg::Entry { seq: 1, tx: first }).expect("ack");
        assert_eq!(r.view(), &view);
        assert_eq!(r.view(), &rebuilt(&r));
        assert_ne!(r.view(), r.confirmed(), "the second edit is still only pending");
        r.receive(ServerMsg::Entry { seq: 2, tx: second }).expect("ack");
        assert_eq!(r.view(), &view);
        assert_eq!(r.view(), r.confirmed());
        assert_eq!(r.status(), SaveStatus::Saved);
    }

    #[test]
    fn an_ack_that_is_not_the_edit_as_sent_rebuilds_the_view_from_the_servers() {
        // A server never rewrites a transaction; if one did, its copy is the truth.
        let mut r = replica(7);
        r.connect();
        let mut tx = sent(r.edit(vec![note(100, "mine")]).expect("edit"));
        tx.ops = vec![note(100, "the server's")];
        r.receive(ServerMsg::Entry { seq: 1, tx }).expect("ack");
        assert_eq!(r.view(), r.confirmed());
        assert!(matches!(r.view().live(RecordId(100)), Some(Record::Callout(c)) if c.text == "the server's"));
    }

    #[test]
    fn a_peers_entry_reaches_the_view_with_and_without_pending_work() {
        let peer = |cseq: u64, ops: Vec<Op>| Tx { client: ClientId(9), cseq, kind: TxKind::Edit, ops };
        let mut r = replica(7);
        r.connect();
        // Nothing pending: the view is the confirmed state.
        r.receive(ServerMsg::Entry { seq: 1, tx: peer(0, vec![note(200, "theirs")]) }).expect("entry");
        assert_eq!(r.view(), r.confirmed());
        assert!(r.view().live(RecordId(200)).is_some());
        // Pending work on top: the peer's write is under it, and the pending edit wins the view.
        r.edit(vec![text(200, "mine, pending")]).expect("edit");
        r.receive(ServerMsg::Entry { seq: 2, tx: peer(1, vec![text(200, "theirs again"), note(201, "new")]) }).expect("entry");
        assert_eq!(r.view(), &rebuilt(&r));
        assert!(matches!(r.view().live(RecordId(200)), Some(Record::Callout(c)) if c.text == "mine, pending"));
        assert!(r.view().live(RecordId(201)).is_some());
        assert!(matches!(r.confirmed().live(RecordId(200)), Some(Record::Callout(c)) if c.text == "theirs again"));
    }

    #[test]
    fn a_peers_delete_under_a_pending_edit_drops_that_edit_from_the_view() {
        let mut r = replica(7);
        r.connect();
        r.receive(ServerMsg::Entry { seq: 1, tx: Tx { client: ClientId(9), cseq: 0, kind: TxKind::Edit, ops: vec![note(200, "theirs")] } }).expect("entry");
        r.edit(vec![note(300, "mine"), text(200, "mine")]).expect("edit");
        r.receive(ServerMsg::Entry { seq: 2, tx: Tx { client: ClientId(9), cseq: 1, kind: TxKind::Edit, ops: vec![Op::Delete { id: RecordId(200) }] } }).expect("entry");
        assert_eq!(r.view(), &rebuilt(&r));
        assert!(r.view().live(RecordId(200)).is_none());
        assert!(r.view_is_rebuilt());
    }

    #[test]
    fn the_rebuilt_check_tells_a_view_that_drifted() {
        let mut r = replica(7);
        r.edit(vec![note(100, "a")]).expect("edit");
        assert!(r.view_is_rebuilt());
        r.pending.clear();
        assert!(!r.view_is_rebuilt());
    }
}
