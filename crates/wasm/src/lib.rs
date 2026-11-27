//! The browser's handle on a board replica. Everything crosses the boundary as JSON strings
//! whose shapes are the generated TypeScript types in `web/src/gen`, so the two sides can't
//! drift. A JSON round trip per call costs microseconds, and a call costs what it touches: a
//! drag makes one on every frame (map-state spec §6, "Edit cost").
//!
//! Every call that can change the view returns an [`Update`]: the frames to send, and the
//! records that changed. The UI mirrors records; the core stays the source of truth.

use mapcro_engine::wire::{WireIn, WireOut};
use mapcro_engine::{Replica, ReplicaState, SaveStatus, ServerMsg};
use mapcro_schema::{ClientId, Doc, Entry, Op, RecordId, op_target};
use serde::Serialize;
use wasm_bindgen::prelude::*;

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// A server message this build can't read (a newer build's records or messages): the tab
/// should reload, not retry. The session looks for this prefix.
fn unreadable(e: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("unreadable: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Update<'a> {
    /// `WireIn` frames to send now, in order.
    frames: Vec<WireIn>,
    /// Records whose view changed: `[id, entry]`, or `[id, null]` if it vanished.
    changed: Vec<(RecordId, Option<&'a Entry>)>,
    status: Status,
    can_undo: bool,
    can_redo: bool,
    /// Set when the call itself was refused locally (an invalid edit, nothing to undo).
    refused: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Status {
    Saved,
    Syncing { pending: usize },
    Offline { pending: usize },
}

fn status(s: SaveStatus) -> Status {
    match s {
        SaveStatus::Saved => Status::Saved,
        SaveStatus::Syncing(n) => Status::Syncing { pending: n },
        SaveStatus::Offline(n) => Status::Offline { pending: n },
    }
}

/// The records a call can change in the view, as the view holds them before it. A transaction
/// changes only the records its ops name (`op_target`), so comparing these afterwards finds
/// every change without a copy of the board (map-state spec §6, "Edit cost").
struct Held(Vec<(RecordId, Option<Entry>)>);

impl Held {
    fn of<'a>(view: &Doc, ops: impl IntoIterator<Item = &'a Op>) -> Held {
        let ids: std::collections::BTreeSet<RecordId> = ops.into_iter().map(op_target).collect();
        Held(ids.into_iter().map(|id| (id, view.get(id).cloned())).collect())
    }

    /// Those the view now holds differently, in `diff`'s order: the ones it has, by id, then
    /// the ones that vanished.
    fn changed<'a>(&self, view: &'a Doc) -> Vec<(RecordId, Option<&'a Entry>)> {
        let now = |id: &RecordId| view.get(*id);
        let mut out: Vec<_> = self.0.iter().filter(|(id, was)| now(id).is_some() && now(id) != was.as_ref()).map(|(id, _)| (*id, now(id))).collect();
        out.extend(self.0.iter().filter(|(id, was)| was.is_some() && now(id).is_none()).map(|(id, _)| (*id, None)));
        out
    }
}

/// What a call's `changed` is found against.
enum Before {
    /// The records the call can touch.
    Held(Held),
    /// The whole view: a rebase onto another board state can change anything.
    Whole(Doc),
}

/// Records that differ between two views.
fn diff<'a>(old: &Doc, new: &'a Doc) -> Vec<(RecordId, Option<&'a Entry>)> {
    let mut out: Vec<(RecordId, Option<&'a Entry>)> =
        new.iter().filter(|(id, e)| old.get(*id) != Some(*e)).map(|(id, e)| (id, Some(e))).collect();
    out.extend(old.iter().filter(|(id, _)| new.get(*id).is_none()).map(|(id, _)| (id, None)));
    out
}

#[wasm_bindgen]
pub struct BoardReplica {
    inner: Replica,
}

#[wasm_bindgen]
impl BoardReplica {
    /// A fresh replica from the server's `Ready.base` (`Base` as JSON). `secret` comes from
    /// `newClientSecret()` and is kept with the replica's state; it proves the id is ours.
    #[wasm_bindgen(constructor)]
    pub fn new(client: &str, secret: &str, base_json: &str) -> Result<BoardReplica, JsError> {
        let client: ClientId = serde_json::from_value(serde_json::Value::String(client.into())).map_err(js_err)?;
        let base: mapcro_engine::wire::Base = serde_json::from_str(base_json).map_err(unreadable)?;
        mapcro_schema::validate_doc(&base.doc).map_err(js_err)?;
        Ok(BoardReplica { inner: Replica::new(client, secret.to_owned(), base.doc, base.seq) })
    }

    /// Rebuild from `state()`, e.g. after a reload. The result is disconnected.
    pub fn restore(state_json: &str) -> Result<BoardReplica, JsError> {
        let state: ReplicaState = serde_json::from_str(state_json).map_err(js_err)?;
        Ok(BoardReplica { inner: Replica::from_state(state) })
    }

    /// Persist this (to IndexedDB) *before* sending the frames from an edit.
    pub fn state(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.inner.state()).map_err(js_err)
    }

    /// The whole view as `Doc` JSON (for the first render).
    pub fn view(&self) -> Result<String, JsError> {
        serde_json::to_string(self.inner.view()).map_err(js_err)
    }

    #[wasm_bindgen(js_name = lastSeq)]
    pub fn last_seq(&self) -> f64 {
        self.inner.last_seq() as f64
    }

    /// The cseq the next transaction gets: after an edit, that edit's is one less.
    #[wasm_bindgen(js_name = nextCseq)]
    pub fn next_cseq(&self) -> f64 {
        self.inner.next_cseq() as f64
    }

    /// How many transactions are pending (made here, not yet acknowledged): what a save status
    /// counts, read from the replica itself, also before any call has said a status.
    #[wasm_bindgen(js_name = pendingCount)]
    pub fn pending_count(&self) -> f64 {
        self.inner.pending().count() as f64
    }

    /// `Op[]` as JSON, applied as one transaction (one undo step).
    pub fn edit(&mut self, ops_json: &str) -> Result<String, JsError> {
        let ops: Vec<Op> = serde_json::from_str(ops_json).map_err(js_err)?;
        let before = Held::of(self.inner.view(), &ops);
        let result = self.inner.edit(ops);
        self.update(&before, result.as_ref().ok().cloned().flatten(), result.err().map(|e| e.to_string()))
    }

    /// `Op[]` as JSON, applied as one transaction that isn't the user's to undo (spec §6b, the
    /// live annotation layer): no undo step, and redo is kept.
    pub fn edit_silent(&mut self, ops_json: &str) -> Result<String, JsError> {
        let ops: Vec<Op> = serde_json::from_str(ops_json).map_err(js_err)?;
        let before = Held::of(self.inner.view(), &ops);
        let result = self.inner.edit_silent(ops);
        self.update(&before, result.as_ref().ok().cloned().flatten(), result.err().map(|e| e.to_string()))
    }

    pub fn undo(&mut self) -> Result<String, JsError> {
        let before = Held::of(self.inner.view(), self.inner.next_undo().unwrap_or_default());
        let result = self.inner.undo();
        self.update(&before, result.as_ref().ok().cloned().flatten(), result.err().map(|e| e.to_string()))
    }

    pub fn redo(&mut self) -> Result<String, JsError> {
        let before = Held::of(self.inner.view(), self.inner.next_redo().unwrap_or_default());
        let result = self.inner.redo();
        self.update(&before, result.as_ref().ok().cloned().flatten(), result.err().map(|e| e.to_string()))
    }

    /// The step the next `undo` would send, as `Op[]` JSON; `null` if there is none.
    #[wasm_bindgen(js_name = nextUndo)]
    pub fn next_undo(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.inner.next_undo()).map_err(js_err)
    }

    /// The step the next `redo` would send, as `Op[]` JSON; `null` if there is none.
    #[wasm_bindgen(js_name = nextRedo)]
    pub fn next_redo(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.inner.next_redo()).map_err(js_err)
    }

    /// Undo the next step as the caller re-decided it (`Op[]` JSON), keeping `carry_json`
    /// (`Op[]`) with the redo it leaves (engine `Replica::undo_as`). Empty ops drop the step.
    #[wasm_bindgen(js_name = undoAs)]
    pub fn undo_as(&mut self, ops_json: &str, carry_json: &str) -> Result<String, JsError> {
        let ops: Vec<Op> = serde_json::from_str(ops_json).map_err(js_err)?;
        let carry: Vec<Op> = serde_json::from_str(carry_json).map_err(js_err)?;
        let before = Held::of(self.inner.view(), &ops);
        let result = self.inner.undo_as(ops, carry);
        self.update(&before, result.as_ref().ok().cloned().flatten(), result.err().map(|e| e.to_string()))
    }

    /// [`undo_as`](Self::undo_as) for the next redo.
    #[wasm_bindgen(js_name = redoAs)]
    pub fn redo_as(&mut self, ops_json: &str, carry_json: &str) -> Result<String, JsError> {
        let ops: Vec<Op> = serde_json::from_str(ops_json).map_err(js_err)?;
        let carry: Vec<Op> = serde_json::from_str(carry_json).map_err(js_err)?;
        let before = Held::of(self.inner.view(), &ops);
        let result = self.inner.redo_as(ops, carry);
        self.update(&before, result.as_ref().ok().cloned().flatten(), result.err().map(|e| e.to_string()))
    }

    /// Strip local undo and redo entries whose inverse touches any of `ids_json` (`RecordId[]`).
    /// Purely local; emits no wire frames and changes no records.
    #[wasm_bindgen(js_name = dropHistoryFor)]
    pub fn drop_history_for(&mut self, ids_json: &str) -> Result<String, JsError> {
        let ids: Vec<RecordId> = serde_json::from_str(ids_json).map_err(js_err)?;
        self.inner.drop_history_for(&ids);
        let u = self.changes(Vec::new(), Vec::new(), None);
        serde_json::to_string(&u).map_err(js_err)
    }

    #[wasm_bindgen(js_name = canUndo)]
    pub fn can_undo(&self) -> bool {
        self.inner.can_undo()
    }

    #[wasm_bindgen(js_name = canRedo)]
    pub fn can_redo(&self) -> bool {
        self.inner.can_redo()
    }

    /// Find and remove the undo history entry for `cseq`, returning its inverse ops as JSON
    /// `Op[] | null`. Purely local; emits no wire frames.
    #[wasm_bindgen(js_name = takeUndoFor)]
    pub fn take_undo_for(&mut self, cseq: f64) -> Result<String, JsError> {
        serde_json::to_string(&self.inner.take_undo_for(cseq as u64)).map_err(js_err)
    }

    /// Take the server-applied inverse recorded when our own `Entry` for `cseq` applied to
    /// `confirmed` in `receive`, as JSON `Op[] | null`.
    #[wasm_bindgen(js_name = takeConfirmedInverse)]
    pub fn take_confirmed_inverse(&mut self, cseq: f64) -> Result<String, JsError> {
        serde_json::to_string(&self.inner.take_confirmed_inverse(cseq as u64)).map_err(js_err)
    }

    /// Server-confirmed `Scene.clock` for `scene_id` (or `undefined` when absent/deleted/null).
    #[wasm_bindgen(js_name = confirmedSceneClock)]
    pub fn confirmed_scene_clock(&self, scene_id: &str) -> Result<Option<u32>, JsError> {
        let id: RecordId = serde_json::from_value(serde_json::Value::String(scene_id.into())).map_err(js_err)?;
        Ok(match self.inner.confirmed().live(id) {
            Some(mapcro_schema::Record::Scene(s)) => s.clock,
            _ => None,
        })
    }

    /// The socket opened and `Ready` arrived: frames to send (hello, then pending work).
    pub fn connect(&mut self) -> Result<String, JsError> {
        let frames: Vec<WireIn> = self.inner.connect().into_iter().map(|msg| WireIn::Msg { msg }).collect();
        self.update_frames(&Before::Held(Held(Vec::new())), frames, None)
    }

    pub fn disconnect(&mut self) -> Result<String, JsError> {
        self.inner.disconnect();
        self.update_frames(&Before::Held(Held(Vec::new())), Vec::new(), None)
    }

    /// A `WireOut` frame of kind `msg`. A protocol error means: drop the socket and reconnect;
    /// pending work is untouched.
    pub fn receive(&mut self, frame_json: &str) -> Result<String, JsError> {
        let frame: WireOut = serde_json::from_str(frame_json).map_err(unreadable)?;
        let WireOut::Msg { msg } = frame else {
            return Err(JsError::new("receive() takes only `msg` frames"));
        };
        // The view is the confirmed state with the pending work on top: an entry or a
        // rejection can change only the records it names and the ones pending work names
        // (a pending transaction may start or stop applying).
        let pending = || self.inner.pending().flat_map(|tx| tx.ops.iter());
        let before = match &msg {
            ServerMsg::Entry { tx, .. } => Before::Held(Held::of(self.inner.view(), tx.ops.iter().chain(pending()))),
            ServerMsg::Rejected { .. } => Before::Held(Held::of(self.inner.view(), pending())),
            ServerMsg::Fatal(_) => Before::Held(Held(Vec::new())),
            ServerMsg::Rebase { .. } => Before::Whole(self.inner.view().clone()),
        };
        self.inner.receive(msg).map_err(js_err)?;
        self.update_frames(&before, Vec::new(), None)
    }
}

impl BoardReplica {
    fn update(&self, before: &Held, msg: Option<mapcro_engine::ClientMsg>, refused: Option<String>) -> Result<String, JsError> {
        let frames = msg.into_iter().map(|msg| WireIn::Msg { msg }).collect();
        let u = self.changes(before.changed(self.inner.view()), frames, refused);
        serde_json::to_string(&u).map_err(js_err)
    }

    fn update_frames(&self, before: &Before, frames: Vec<WireIn>, refused: Option<String>) -> Result<String, JsError> {
        let changed = match before {
            Before::Held(held) => held.changed(self.inner.view()),
            Before::Whole(doc) => diff(doc, self.inner.view()),
        };
        serde_json::to_string(&self.changes(changed, frames, refused)).map_err(js_err)
    }

    fn changes<'a>(&'a self, changed: Vec<(RecordId, Option<&'a Entry>)>, frames: Vec<WireIn>, refused: Option<String>) -> Update<'a> {
        Update { frames, changed, status: status(self.inner.status()), can_undo: self.inner.can_undo(), can_redo: self.inner.can_redo(), refused }
    }
}

/// A new random client id (one per tab, persisted with its replica).
#[wasm_bindgen(js_name = newClientId)]
pub fn new_client_id() -> Result<String, JsError> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(js_err)?;
    Ok(format!("{:032x}", u128::from_le_bytes(b)))
}

/// A new random client secret (256 bits, hex).
#[wasm_bindgen(js_name = newClientSecret)]
pub fn new_client_secret() -> Result<String, JsError> {
    Ok(format!("{}{}", new_client_id()?, new_client_id()?))
}

/// A new random record id, for creating records in the UI.
/// This build's protocol id (`mapcro_schema::BUILD_ID`), sent with Auth.
#[wasm_bindgen(js_name = buildId)]
pub fn build_id() -> String {
    mapcro_schema::BUILD_ID.to_owned()
}

/// Whether the server would take this presence frame (a `WireIn` as JSON): it parses as the
/// server parses it and passes `Presence::is_valid`. The server closes the socket as abuse on
/// one it can't take, and the reconnect would resend it, so the session checks first.
#[wasm_bindgen(js_name = presenceFrameOk)]
pub fn presence_frame_ok(frame_json: &str) -> bool {
    matches!(serde_json::from_str::<WireIn>(frame_json), Ok(WireIn::Presence { state }) if state.is_valid())
}

#[wasm_bindgen(js_name = newRecordId)]
pub fn new_record_id() -> Result<String, JsError> {
    new_client_id()
}

/// One patch's stat table (`mapcro_stats::StatTable`, a pack's `data/stats/<key>.json`), for the
/// Tab scoreboard's calculated stats. Parsed once; each call is one build in, its values out.
#[wasm_bindgen]
pub struct StatCalc {
    table: mapcro_stats::StatTable,
}

#[derive(Serialize)]
struct StatValues {
    /// The values the HUD shows (health truncated, the rest rounded).
    shown: mapcro_stats::Shown,
    calculated: mapcro_stats::Calculated,
}

#[wasm_bindgen]
impl StatCalc {
    /// Refuses a table in a format this build doesn't know.
    #[wasm_bindgen(constructor)]
    pub fn new(table_json: &str) -> Result<StatCalc, JsError> {
        let table: mapcro_stats::StatTable = serde_json::from_str(table_json).map_err(js_err)?;
        if table.format != mapcro_stats::TABLE_FORMAT {
            return Err(js_err(format!("stat table format {} (this build reads {})", table.format, mapcro_stats::TABLE_FORMAT)));
        }
        Ok(StatCalc { table })
    }

    /// A `mapcro_stats::Build` as JSON → `{ shown, calculated }`, or `null` for a hero the patch
    /// doesn't know.
    pub fn calculate(&self, build_json: &str) -> Result<String, JsError> {
        let build: mapcro_stats::Build = serde_json::from_str(build_json).map_err(js_err)?;
        let out = self.table.calculate(&build).map(|c| StatValues { shown: c.shown(), calculated: c });
        serde_json::to_string(&out).map_err(js_err)
    }
}

/// `Update.changed` against a whole-document diff taken around each call (map-state spec §6,
/// "Edit cost"): exactly the records whose view changed, through every call that can change it.
/// Native: nothing here takes an error path, which is the only place a `JsError` is made.
#[cfg(test)]
mod changed_tests {
    use super::*;
    use mapcro_engine::wire::Base;
    use mapcro_engine::ClientMsg;
    use mapcro_schema::{Callout, FieldValue, Record, Tx, TxKind, WorldPos, genesis};
    use serde_json::Value;

    const SCENE: RecordId = RecordId(14); // genesis: meta 1, slots 2..=13, then the scene
    const ME: &str = "00000000000000000000000000000007";

    fn doc() -> Doc {
        let mut n = 0u128;
        genesis(
            || {
                n += 1;
                RecordId(n)
            },
            "t",
        )
    }

    fn replica() -> BoardReplica {
        let base = serde_json::to_string(&Base { doc: doc(), seq: 0 }).expect("base");
        BoardReplica::new(ME, "secret", &base).unwrap_or_else(|_| panic!("a fresh replica"))
    }

    fn note(id: u128, text: &str) -> Op {
        Op::Create { id: RecordId(id), record: Record::Callout(Callout { scene: SCENE, pos: WorldPos { x: 0, y: 0 }, text: text.into(), color: None, side: Default::default() }) }
    }

    fn text(id: u128, text: &str) -> Op {
        Op::Set { id: RecordId(id), value: FieldValue::CalloutText(text.into()) }
    }

    fn ops(ops: &[Op]) -> String {
        serde_json::to_string(ops).expect("ops")
    }

    fn entry(seq: u64, tx: Tx) -> String {
        serde_json::to_string(&WireOut::Msg { msg: ServerMsg::Entry { seq, tx } }).expect("frame")
    }

    fn peer(cseq: u64, ops: Vec<Op>) -> Tx {
        Tx { client: ClientId(9), cseq, kind: TxKind::Edit, ops }
    }

    /// One call: its update, with `changed` held to the whole-document diff. Returns the ids
    /// it reported and the transactions it sent.
    fn step(r: &mut BoardReplica, what: &str, call: impl FnOnce(&mut BoardReplica) -> Result<String, JsError>) -> (Vec<RecordId>, Vec<Tx>) {
        let before = r.inner.view().clone();
        let Ok(out) = call(r) else { panic!("{what}: the call failed") };
        let update: Value = serde_json::from_str(&out).expect("update");
        let want = serde_json::to_value(diff(&before, r.inner.view())).expect("diff");
        assert_eq!(update["changed"], want, "{what}: changed is not the diff of the view");
        let ids = diff(&before, r.inner.view()).into_iter().map(|(id, _)| id).collect();
        let frames: Vec<WireIn> = serde_json::from_value(update["frames"].clone()).expect("frames");
        let sent = frames
            .into_iter()
            .filter_map(|f| match f {
                WireIn::Msg { msg: ClientMsg::Submit(tx) } => Some(tx),
                _ => None,
            })
            .collect();
        (ids, sent)
    }

    #[test]
    fn changed_is_the_diff_of_the_view_through_every_call() {
        let mut r = replica();
        assert!(step(&mut r, "connect", |r| r.connect()).0.is_empty());

        // Local edits, one of them to two records and one that changes nothing.
        let (ids, a) = step(&mut r, "create", |r| r.edit(&ops(&[note(100, "a")])));
        assert_eq!(ids, vec![RecordId(100)]);
        let (ids, b) = step(&mut r, "silent create", |r| r.edit_silent(&ops(&[note(101, "b")])));
        assert_eq!(ids, vec![RecordId(101)]);
        let (ids, c) = step(&mut r, "two sets", |r| r.edit(&ops(&[text(101, "d"), text(100, "c"), text(100, "c2")])));
        assert_eq!(ids, vec![RecordId(100), RecordId(101)], "each record once, in id order");
        let (ids, same) = step(&mut r, "a set to the value it has", |r| r.edit(&ops(&[text(100, "c2")])));
        assert!(ids.is_empty());
        // Refused: an id already taken, after an op that had applied.
        let (ids, none) = step(&mut r, "refused", |r| r.edit(&ops(&[text(100, "x"), note(100, "taken")])));
        assert!(ids.is_empty() && none.is_empty());

        // Undo and redo.
        let (ids, undo) = step(&mut r, "undo", |r| r.undo());
        assert_eq!(ids, vec![RecordId(100), RecordId(101)]);
        let (ids, redo) = step(&mut r, "redo", |r| r.redo());
        assert_eq!(ids, vec![RecordId(100), RecordId(101)]);
        assert!(step(&mut r, "nothing to redo", |r| r.redo()).0.is_empty());

        // Acks of this replica's own work, oldest first: the view already holds them.
        let mut seq = 0;
        for tx in [a, b, c, same, undo].into_iter().flatten() {
            seq += 1;
            assert!(step(&mut r, "own ack", |r| r.receive(&entry(seq, tx))).0.is_empty());
        }
        // A peer's entry under the pending redo: its new record shows, and so does its write
        // to 100, which the redo no longer covers (a redo is `SetIf` on the value it saw, so it
        // skips a field someone changed since). A record the entry doesn't name changed in the
        // view: the pending work's records are part of what a receive can touch.
        seq += 1;
        let (ids, _) = step(&mut r, "peer under pending", |r| r.receive(&entry(seq, peer(0, vec![text(100, "theirs"), note(200, "theirs")]))));
        assert_eq!(ids, vec![RecordId(100), RecordId(200)]);
        // The redo is refused: what it still wrote (101) goes.
        let cseq = redo[0].cseq;
        let rejected = serde_json::to_string(&WireOut::Msg { msg: ServerMsg::Rejected { cseq, reason: mapcro_schema::Reject::Immutable } }).expect("frame");
        let (ids, _) = step(&mut r, "rejected", |r| r.receive(&rejected));
        assert_eq!(ids, vec![RecordId(101)]);
        assert!(step(&mut r, "rejected again", |r| r.receive(&rejected)).0.is_empty());

        // A peer's entry with nothing pending, and one that deletes.
        seq += 1;
        let (ids, _) = step(&mut r, "peer", |r| r.receive(&entry(seq, peer(1, vec![text(200, "theirs 2"), note(201, "new")]))));
        assert_eq!(ids, vec![RecordId(200), RecordId(201)]);
        seq += 1;
        let (ids, _) = step(&mut r, "peer delete", |r| r.receive(&entry(seq, peer(2, vec![Op::Delete { id: RecordId(201) }]))));
        assert_eq!(ids, vec![RecordId(201)]);
        // An entry already held changes nothing.
        assert!(step(&mut r, "old entry", |r| r.receive(&entry(seq, peer(2, vec![Op::Delete { id: RecordId(201) }])))).0.is_empty());

        // A pending create whose record a peer's entry takes first: it leaves the view.
        let (_, mine) = step(&mut r, "create 300", |r| r.edit(&ops(&[note(300, "mine"), note(301, "mine too")])));
        seq += 1;
        let (ids, _) = step(&mut r, "peer takes the id", |r| r.receive(&entry(seq, peer(3, vec![note(300, "theirs")]))));
        assert_eq!(ids, vec![RecordId(300), RecordId(301)], "300 is the peer's now, 301 vanished");
        assert!(r.inner.view().get(RecordId(301)).is_none());
        drop(mine);

        // A rebase onto another board state: everything that differs, records that vanished included.
        let mut other = doc();
        mapcro_schema::apply_tx(&mut other, &peer(0, vec![note(900, "elsewhere")])).expect("apply");
        let rebase = serde_json::to_string(&WireOut::Msg { msg: ServerMsg::Rebase { doc: other, seq: 50, decided_below: 1_000 } }).expect("frame");
        let (ids, _) = step(&mut r, "rebase", |r| r.receive(&rebase));
        assert_eq!(ids, vec![RecordId(900), RecordId(100), RecordId(101), RecordId(200), RecordId(201), RecordId(300)]);
        assert!(step(&mut r, "disconnect", |r| r.disconnect()).0.is_empty());
    }

    #[test]
    fn drop_history_for_updates_flags_and_persists_across_restore() {
        let mut r = replica();
        let _ = r.edit(&ops(&[note(100, "keep")])).unwrap_or_else(|_| panic!("edit keep"));
        let _ = r.edit(&ops(&[note(101, "drop")])).unwrap_or_else(|_| panic!("edit drop"));
        let _ = r.undo().unwrap_or_else(|_| panic!("undo drop"));
        let ids_json = serde_json::to_string(&[RecordId(101)]).expect("ids");
        let out = r.drop_history_for(&ids_json).unwrap_or_else(|_| panic!("dropHistoryFor"));
        let update: Value = serde_json::from_str(&out).expect("update");
        assert_eq!(update["frames"], Value::Array(vec![]));
        assert_eq!(update["changed"], Value::Array(vec![]));
        assert_eq!(update["canUndo"], Value::Bool(true));
        assert_eq!(update["canRedo"], Value::Bool(false));

        let saved = r.state().unwrap_or_else(|_| panic!("state"));
        let restored = BoardReplica::restore(&saved).unwrap_or_else(|_| panic!("restore"));
        assert!(restored.inner.can_undo());
        assert!(!restored.inner.can_redo());
    }
}

#[cfg(test)]
mod rv_fuzz {
    use super::*;
    use mapcro_engine::ClientMsg;
    use mapcro_engine::wire::Base;
    use mapcro_schema::{Callout, FieldValue, Record, SceneState, Tx, TxKind, WorldPos, apply_tx, genesis};
    use serde_json::Value;
    use std::collections::VecDeque;

    const SCENE: RecordId = RecordId(14);
    const ME: &str = "00000000000000000000000000000007";

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    fn doc() -> Doc {
        let mut n = 0u128;
        genesis(
            || {
                n += 1;
                RecordId(n)
            },
            "t",
        )
    }

    fn rand_op(r: &mut Rng) -> Op {
        let id = RecordId(100 + u128::from(r.below(6)));
        let sid = RecordId(200 + u128::from(r.below(3)));
        let txt = |r: &mut Rng| format!("v{}", r.below(4));
        match r.below(12) {
            0..=2 => Op::Create {
                id,
                record: Record::Callout(Callout {
                    scene: SCENE,
                    pos: WorldPos { x: 0, y: 0 },
                    text: txt(r),
                    color: None,
                    side: Default::default(),
                }),
            },
            3 | 4 => Op::Set { id, value: FieldValue::CalloutText(txt(r)) },
            5 => Op::SetIf { id, expect: FieldValue::CalloutText(txt(r)), value: FieldValue::CalloutText(txt(r)) },
            6 => Op::Delete { id },
            7 => Op::Restore { id },
            8 | 9 => Op::Create { id: sid, record: Record::SceneState(SceneState { scene: SCENE, more: Default::default() }) },
            10 => Op::Delete { id: sid },
            _ => Op::Restore { id: sid },
        }
    }

    fn rand_ops(r: &mut Rng) -> Vec<Op> {
        (0..1 + r.below(3)).map(|_| rand_op(r)).collect()
    }

    fn call(r: &mut BoardReplica, what: &str, f: impl FnOnce(&mut BoardReplica) -> Result<String, JsError>) -> Vec<Tx> {
        let before = r.inner.view().clone();
        let Ok(out) = f(r) else { panic!("{what}: failed") };
        let update: Value = serde_json::from_str(&out).expect("update");
        let want = serde_json::to_value(diff(&before, r.inner.view())).expect("diff");
        assert_eq!(update["changed"], want, "{what}: changed is not the diff");
        assert!(r.inner.view_is_rebuilt(), "{what}: view drifted");
        let frames: Vec<WireIn> = serde_json::from_value(update["frames"].clone()).expect("frames");
        frames
            .into_iter()
            .filter_map(|f| match f {
                WireIn::Msg { msg: ClientMsg::Submit(tx) } => Some(tx),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn fuzz_changed_and_view() {
        let (mut edits, mut entries, mut rejects, mut rebases, mut refusedn) = (0u64, 0u64, 0u64, 0u64, 0u64);
        // 500 seeds (~8 s in debug, 60,000 steps) hits every path thoroughly while keeping `just test` snappy.
        for seed in 1..=500u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
            let base = serde_json::to_string(&Base { doc: doc(), seq: 0 }).expect("base");
            let mut r = BoardReplica::new(ME, "secret", &base).unwrap_or_else(|_| panic!("new"));
            let mut server = doc();
            let mut seq = 0u64;
            let mut decided = 0u64; // next cseq of ours the server will decide
            let mut up: VecDeque<Tx> = VecDeque::new(); // client -> server
            let mut down: VecDeque<String> = VecDeque::new(); // server -> client
            let mut peer_cseq = 0u64;
            call(&mut r, "connect", |r| r.connect());
            for _ in 0..120 {
                match rng.below(20) {
                    0..=4 => {
                        let o = rand_ops(&mut rng);
                        let silent = rng.below(4) == 0;
                        let sent = call(&mut r, "edit", |r| {
                            if silent {
                                r.edit_silent(&serde_json::to_string(&o).expect("o"))
                            } else {
                                r.edit(&serde_json::to_string(&o).expect("o"))
                            }
                        });
                        if sent.is_empty() {
                            refusedn += 1;
                        } else {
                            edits += 1;
                        }
                        up.extend(sent);
                    }
                    5 | 6 => up.extend(call(&mut r, "undo", |r| r.undo())),
                    7 => up.extend(call(&mut r, "redo", |r| r.redo())),
                    8..=10 => {
                        // a peer's transaction, decided by the server
                        let tx = Tx { client: ClientId(9), cseq: peer_cseq, kind: TxKind::Edit, ops: rand_ops(&mut rng) };
                        if apply_tx(&mut server, &tx).is_ok() {
                            peer_cseq += 1;
                            seq += 1;
                            down.push_back(serde_json::to_string(&WireOut::Msg { msg: ServerMsg::Entry { seq, tx } }).expect("f"));
                        }
                    }
                    11..=14 => {
                        // the server decides our oldest undecided transaction
                        if let Some(tx) = up.pop_front() {
                            assert_eq!(tx.cseq, decided);
                            decided += 1;
                            match apply_tx(&mut server, &tx) {
                                Ok(_) => {
                                    seq += 1;
                                    down.push_back(serde_json::to_string(&WireOut::Msg { msg: ServerMsg::Entry { seq, tx } }).expect("f"));
                                }
                                Err(reason) => down.push_back(serde_json::to_string(&WireOut::Msg { msg: ServerMsg::Rejected { cseq: tx.cseq, reason } }).expect("f")),
                            }
                        }
                    }
                    15..=18 => {
                        if let Some(f) = down.pop_front() {
                            let is_rej = f.contains("Rejected");
                            call(&mut r, "receive", |r| r.receive(&f));
                            if is_rej {
                                rejects += 1;
                            } else {
                                entries += 1;
                            }
                        }
                    }
                    _ => {
                        // reconnect with a rebase: everything in flight is lost
                        down.clear();
                        call(&mut r, "disconnect", |r| r.disconnect());
                        if rng.below(2) == 0 {
                            // edits made offline
                            let o = rand_ops(&mut rng);
                            call(&mut r, "offline edit", |r| r.edit(&serde_json::to_string(&o).expect("o")));
                        }
                        let rebase = serde_json::to_string(&WireOut::Msg {
                            msg: ServerMsg::Rebase { doc: server.clone(), seq, decided_below: decided },
                        })
                        .expect("f");
                        let resent = call(&mut r, "connect", |r| r.connect());
                        call(&mut r, "rebase", |r| r.receive(&rebase));
                        up = resent.into_iter().filter(|t| t.cseq >= decided).collect();
                        rebases += 1;
                    }
                }
            }
            // drain
            while let Some(tx) = up.pop_front() {
                match apply_tx(&mut server, &tx) {
                    Ok(_) => {
                        seq += 1;
                        down.push_back(serde_json::to_string(&WireOut::Msg { msg: ServerMsg::Entry { seq, tx } }).expect("f"));
                    }
                    Err(reason) => down.push_back(serde_json::to_string(&WireOut::Msg { msg: ServerMsg::Rejected { cseq: tx.cseq, reason } }).expect("f")),
                }
            }
            while let Some(f) = down.pop_front() {
                call(&mut r, "drain", |r| r.receive(&f));
            }
            assert_eq!(r.inner.view(), &server, "seed {seed}: quiescent view is not the server's");
            assert_eq!(r.inner.confirmed(), &server);
        }
        assert!(
            edits > 1000 && rejects > 100 && entries > 1000 && rebases > 100 && refusedn > 100,
            "edits {edits} refused {refusedn} entries {entries} rejects {rejects} rebases {rebases}"
        );
    }
}

#[cfg(test)]
mod rv_chunk {
    use mapcro_schema::*;

    #[test]
    fn a_scene_created_without_all_twelve_heroes_is_refused() {
        let mut n = 0u128;
        let mut doc = genesis(
            || {
                n += 1;
                RecordId(n)
            },
            "t",
        );
        let slots: Vec<(RecordId, Team, u8)> = doc
            .iter_live()
            .filter_map(|(id, r)| match r {
                Record::RosterSlot(s) => Some((id, s.team, s.slot)),
                _ => None,
            })
            .collect();
        assert_eq!(slots.len(), 12);
        let scene = RecordId(1000);
        let mk = |k: usize| {
            let mut ops = vec![Op::Create {
                id: scene,
                record: Record::Scene(Scene {
                    name: String::new(),
                    order: OrderKey::between(Some(&OrderKey::first()), None),
                    clock: None,
                    source: None,
                    live: false,
                    parent: None,
                }),
            }];
            for (i, (slot, team, idx)) in slots.iter().take(k).enumerate() {
                ops.push(Op::Create {
                    id: RecordId(2000 + i as u128),
                    record: Record::PlayerState(PlayerState::starting(scene, *slot, *team, *idx)),
                });
            }
            Tx { client: ClientId(7), cseq: 0, kind: TxKind::Edit, ops }
        };
        let r = apply_tx(&mut doc.clone(), &mk(7));
        assert_eq!(r.err(), Some(Reject::IncompleteScene));
        assert!(apply_tx(&mut doc, &mk(12)).is_ok());
    }
}
