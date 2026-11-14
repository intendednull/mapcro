//! The browser's handle on a board replica. Everything crosses the boundary as JSON strings
//! whose shapes are the generated TypeScript types in `web/src/gen`, so the two sides can't
//! drift. Edits are human-paced; a JSON round trip per call costs microseconds.
//!
//! Every call that can change the view returns an [`Update`]: the frames to send, and the
//! records that changed. The UI mirrors records; the core stays the source of truth.

use mapcro_engine::wire::{WireIn, WireOut};
use mapcro_engine::{Replica, ReplicaState, SaveStatus};
use mapcro_schema::{ClientId, Doc, Entry, Op, RecordId};
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

    /// `Op[]` as JSON, applied as one transaction (one undo step).
    pub fn edit(&mut self, ops_json: &str) -> Result<String, JsError> {
        let ops: Vec<Op> = serde_json::from_str(ops_json).map_err(js_err)?;
        let before = self.inner.view().clone();
        let result = self.inner.edit(ops);
        self.update(&before, result.as_ref().ok().cloned().flatten(), result.err().map(|e| e.to_string()))
    }

    /// `Op[]` as JSON, applied as one transaction that isn't the user's to undo (spec §6b, the
    /// live annotation layer): no undo step, and redo is kept.
    pub fn edit_silent(&mut self, ops_json: &str) -> Result<String, JsError> {
        let ops: Vec<Op> = serde_json::from_str(ops_json).map_err(js_err)?;
        let before = self.inner.view().clone();
        let result = self.inner.edit_silent(ops);
        self.update(&before, result.as_ref().ok().cloned().flatten(), result.err().map(|e| e.to_string()))
    }

    pub fn undo(&mut self) -> Result<String, JsError> {
        let before = self.inner.view().clone();
        let result = self.inner.undo();
        self.update(&before, result.as_ref().ok().cloned().flatten(), result.err().map(|e| e.to_string()))
    }

    pub fn redo(&mut self) -> Result<String, JsError> {
        let before = self.inner.view().clone();
        let result = self.inner.redo();
        self.update(&before, result.as_ref().ok().cloned().flatten(), result.err().map(|e| e.to_string()))
    }

    /// The socket opened and `Ready` arrived: frames to send (hello, then pending work).
    pub fn connect(&mut self) -> Result<String, JsError> {
        let before = self.inner.view().clone();
        let frames: Vec<WireIn> = self.inner.connect().into_iter().map(|msg| WireIn::Msg { msg }).collect();
        self.update_frames(&before, frames, None)
    }

    pub fn disconnect(&mut self) -> Result<String, JsError> {
        let before = self.inner.view().clone();
        self.inner.disconnect();
        self.update_frames(&before, Vec::new(), None)
    }

    /// A `WireOut` frame of kind `msg`. A protocol error means: drop the socket and reconnect;
    /// pending work is untouched.
    pub fn receive(&mut self, frame_json: &str) -> Result<String, JsError> {
        let frame: WireOut = serde_json::from_str(frame_json).map_err(unreadable)?;
        let WireOut::Msg { msg } = frame else {
            return Err(JsError::new("receive() takes only `msg` frames"));
        };
        let before = self.inner.view().clone();
        self.inner.receive(msg).map_err(js_err)?;
        self.update_frames(&before, Vec::new(), None)
    }
}

impl BoardReplica {
    fn update(&self, before: &Doc, msg: Option<mapcro_engine::ClientMsg>, refused: Option<String>) -> Result<String, JsError> {
        let frames = msg.into_iter().map(|msg| WireIn::Msg { msg }).collect();
        self.update_frames(before, frames, refused)
    }

    fn update_frames(&self, before: &Doc, frames: Vec<WireIn>, refused: Option<String>) -> Result<String, JsError> {
        let u = Update {
            frames,
            changed: diff(before, self.inner.view()),
            status: status(self.inner.status()),
            can_undo: self.inner.can_undo(),
            can_redo: self.inner.can_redo(),
            refused,
        };
        serde_json::to_string(&u).map_err(js_err)
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
    use mapcro_engine::{ClientMsg, ServerMsg};
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
        Op::Create { id: RecordId(id), record: Record::Callout(Callout { scene: SCENE, pos: WorldPos { x: 0, y: 0 }, text: text.into(), color: None }) }
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
        // A peer's entry under the pending redo: its write to 100 is hidden by the redo, its
        // new record shows.
        seq += 1;
        let (ids, _) = step(&mut r, "peer under pending", |r| r.receive(&entry(seq, peer(0, vec![text(100, "theirs"), note(200, "theirs")]))));
        assert_eq!(ids, vec![RecordId(200)]);
        // The redo is refused: what it wrote goes, and the peer's write to 100 shows.
        let cseq = redo[0].cseq;
        let rejected = serde_json::to_string(&WireOut::Msg { msg: ServerMsg::Rejected { cseq, reason: mapcro_schema::Reject::Immutable } }).expect("frame");
        let (ids, _) = step(&mut r, "rejected", |r| r.receive(&rejected));
        assert_eq!(ids, vec![RecordId(100), RecordId(101)]);
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
}
