//! mapcro board schema: records, ops, transactions, validation and apply semantics.
//!
//! This crate is the single definition of what a board *is*. The server's authority and the
//! browser's replica both call [`apply_tx`], so they cannot disagree about what a transaction
//! does. It is pure: no I/O, no clocks, no randomness.

mod doc;
mod ids;
mod records;
mod validate;

pub use doc::{Doc, Entry};
pub use ids::{ClientId, HeroId, ObjectiveKey, OrderKey, RecordId};
pub use records::{
    Arrow, BoardMeta, Callout, Field, FieldValue, Note, ObjectiveState, ObjectiveStatus, PlayerState,
    Record, RecordKind, RosterSlot, Scene, Team, WorldPos,
};
pub use validate::{Limits, Reject, LIMITS};

use serde::{Deserialize, Serialize};

/// One change to the board. Field-level, so concurrent edits to different fields never conflict.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Op {
    /// Create a record with a fresh id.
    Create { id: RecordId, record: Record },
    /// Last-writer-wins write of one field. A write to a deleted record is a no-op.
    Set { id: RecordId, value: FieldValue },
    /// Write `value` only if the field currently equals `expect`. Undo uses this, so the check
    /// happens when the authority applies it, not when the client decides (journal 2026-11-06).
    SetIf { id: RecordId, expect: FieldValue, value: FieldValue },
    /// Tombstone a record. Its fields are kept so that `Restore` brings back everyone's edits.
    Delete { id: RecordId },
    /// Undelete a tombstoned record.
    Restore { id: RecordId },
}

/// Why a transaction exists. Carried on the wire so the UI and the simulation can tell edits
/// from undos without guessing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TxKind {
    Edit,
    /// Undo of this client's transaction `of`.
    Undo { of: u64 },
    /// Redo of this client's undo transaction `of`.
    Redo { of: u64 },
}

/// An atomic group of ops from one client. `(client, cseq)` identifies it everywhere, which is
/// what makes resending after a lost ack safe.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tx {
    pub client: ClientId,
    pub cseq: u64,
    pub kind: TxKind,
    pub ops: Vec<Op>,
}

/// What applying a transaction did, op by op. Lets a client explain "couldn't undo: changed by …".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpOutcome {
    Applied,
    /// A `Set`/`SetIf` on a deleted record, a `SetIf` whose expectation failed, a `Delete` of
    /// something already deleted, or a `Restore` of something live.
    Skipped,
}

/// Apply a transaction atomically: either every op is valid and the document changes, or the
/// document is untouched and the reason is returned.
pub fn apply_tx(doc: &mut Doc, tx: &Tx) -> Result<Vec<OpOutcome>, Reject> {
    if tx.ops.is_empty() {
        return Err(Reject::EmptyTx);
    }
    if tx.ops.len() > LIMITS.max_ops_per_tx {
        return Err(Reject::TooManyOps);
    }
    let mut scratch = doc.clone();
    let mut outcomes = Vec::with_capacity(tx.ops.len());
    for op in &tx.ops {
        outcomes.push(validate::apply_op(&mut scratch, op)?);
    }
    validate::check_invariants(&scratch)?;
    *doc = scratch;
    Ok(outcomes)
}

/// Check whole-board invariants on a document (for tests and for loading stored boards).
pub fn validate_doc(doc: &Doc) -> Result<(), Reject> {
    validate::check_invariants(doc)
}

/// Like [`apply_tx`], also returning the ops that would undo it, computed against the state each
/// op actually saw. Undo is built from these: `SetIf` for field writes (so the authority skips a
/// field someone else changed since), `Restore` for deletes, `Delete` for creates.
pub fn apply_tx_with_inverse(doc: &mut Doc, tx: &Tx) -> Result<(Vec<OpOutcome>, Vec<Op>), Reject> {
    if tx.ops.is_empty() {
        return Err(Reject::EmptyTx);
    }
    if tx.ops.len() > LIMITS.max_ops_per_tx {
        return Err(Reject::TooManyOps);
    }
    let mut scratch = doc.clone();
    let mut outcomes = Vec::with_capacity(tx.ops.len());
    let mut inverse = Vec::new();
    for op in &tx.ops {
        if let Some(inv) = inverse_of(&scratch, op) {
            inverse.push(inv);
        }
        outcomes.push(validate::apply_op(&mut scratch, op)?);
    }
    validate::check_invariants(&scratch)?;
    *doc = scratch;
    inverse.reverse();
    Ok((outcomes, inverse))
}

fn inverse_of(before: &Doc, op: &Op) -> Option<Op> {
    match op {
        // Player states live and die with their scene; undoing the scene's creation hides them.
        Op::Create { record: Record::PlayerState(_), .. } => None,
        Op::Create { id, .. } => Some(Op::Delete { id: *id }),
        Op::Set { id, value } => {
            let old = before.live(*id)?.get(value.field())?;
            (old != *value).then(|| Op::SetIf { id: *id, expect: value.clone(), value: old })
        }
        Op::SetIf { id, expect, value } => {
            let current = before.live(*id)?.get(value.field())?;
            (current == *expect && expect != value)
                .then(|| Op::SetIf { id: *id, expect: value.clone(), value: expect.clone() })
        }
        Op::Delete { id } => before.live(*id).map(|_| Op::Restore { id: *id }),
        Op::Restore { id } => before.get(*id).filter(|e| e.deleted).map(|_| Op::Delete { id: *id }),
    }
}

/// A fresh board: metadata, the 12 roster slots, and one scene with a player state per slot.
/// Ids are supplied by the caller so that creation is deterministic (the simulation seeds them;
/// the server draws them from its RNG).
pub fn genesis(mut next_id: impl FnMut() -> RecordId, title: &str) -> Doc {
    let mut doc = Doc::default();
    doc.insert(next_id(), Record::BoardMeta(BoardMeta { title: title.to_owned() }));
    let mut slots = Vec::new();
    for team in [Team::Amber, Team::Sapphire] {
        for slot in 0..records::SLOTS_PER_TEAM {
            let id = next_id();
            doc.insert(id, Record::RosterSlot(RosterSlot { team, slot, name: String::new(), hero: None }));
            slots.push((id, team, slot));
        }
    }
    let scene = next_id();
    doc.insert(scene, Record::Scene(Scene { name: "Scene 1".into(), order: OrderKey::first() }));
    for (slot_id, team, slot) in slots {
        doc.insert(next_id(), Record::PlayerState(PlayerState::starting(scene, slot_id, team, slot)));
    }
    debug_assert!(validate::check_invariants(&doc).is_ok(), "genesis must satisfy the invariants");
    doc
}
