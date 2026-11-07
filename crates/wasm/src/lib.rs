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
        let base: mapcro_engine::wire::Base = serde_json::from_str(base_json).map_err(js_err)?;
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

    /// `Op[]` as JSON, applied as one transaction (one undo step).
    pub fn edit(&mut self, ops_json: &str) -> Result<String, JsError> {
        let ops: Vec<Op> = serde_json::from_str(ops_json).map_err(js_err)?;
        let before = self.inner.view().clone();
        let result = self.inner.edit(ops);
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
        let frame: WireOut = serde_json::from_str(frame_json).map_err(js_err)?;
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
#[wasm_bindgen(js_name = newRecordId)]
pub fn new_record_id() -> Result<String, JsError> {
    new_client_id()
}
