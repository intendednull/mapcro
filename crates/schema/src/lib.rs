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
#[cfg(feature = "ts")]
pub use doc::DocPair;
pub use ids::{ClientId, HeroId, ObjectiveKey, OrderKey, RecordId};
pub use records::{
    Arrow, BoardMeta, Callout, Field, FieldValue, Note, ObjectiveState, ObjectiveStatus, PlayerState,
    Record, RecordKind, RosterSlot, Scene, Stroke, Team, WorldPos,
};
pub use validate::{Limits, Reject, LIMITS};

use serde::{Deserialize, Serialize};

/// One change to the board. Field-level, so concurrent edits to different fields never conflict.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
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
    apply_tx_with_inverse(doc, tx).map(|(outcomes, _)| outcomes)
}

/// Could this op change a whole-board invariant (record counts, one-per-scene rules)? Field
/// writes can't: they never change a record's kind, scene, slot or tombstone.
fn affects_invariants(op: &Op) -> bool {
    match op {
        Op::Set { .. } | Op::SetIf { .. } => false,
        Op::Create { record, .. } => !matches!(record, Record::Arrow(_) | Record::Callout(_) | Record::Stroke(_)),
        Op::Delete { .. } | Op::Restore { .. } => true,
    }
}

fn op_target(op: &Op) -> RecordId {
    match op {
        Op::Create { id, .. } | Op::Set { id, .. } | Op::SetIf { id, .. } | Op::Delete { id } | Op::Restore { id } => *id,
    }
}

/// Check whole-board invariants on a document (for tests and for loading stored boards).
pub fn validate_doc(doc: &Doc) -> Result<(), Reject> {
    validate::check_invariants(doc)
}

/// Like [`apply_tx`], also returning the ops that would undo it, computed against the state each
/// op actually saw. Undo is built from these: `SetIf` for field writes (so the authority skips a
/// field someone else changed since), `Restore` for deletes, `Delete` for creates.
///
/// Applies in place with a rollback log rather than cloning the board, so a transaction costs
/// what it touches (security review 2026-11-06, M3).
pub fn apply_tx_with_inverse(doc: &mut Doc, tx: &Tx) -> Result<(Vec<OpOutcome>, Vec<Op>), Reject> {
    if tx.ops.is_empty() {
        return Err(Reject::EmptyTx);
    }
    if tx.ops.len() > LIMITS.max_ops_per_tx {
        return Err(Reject::TooManyOps);
    }
    let mut undo_log: Vec<(RecordId, Option<Entry>)> = Vec::new();
    let mut outcomes = Vec::with_capacity(tx.ops.len());
    let mut inverse = Vec::new();
    let mut check = false;
    let result = (|| {
        for op in &tx.ops {
            let id = op_target(op);
            if !undo_log.iter().any(|(i, _)| *i == id) {
                undo_log.push((id, doc.get(id).cloned()));
            }
            if let Some(inv) = inverse_of(doc, op) {
                inverse.push(inv);
            }
            check |= affects_invariants(op);
            outcomes.push(validate::apply_op(doc, op)?);
        }
        if check {
            validate::check_invariants(doc)?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            inverse.reverse();
            Ok((outcomes, inverse))
        }
        Err(reason) => {
            for (id, entry) in undo_log.into_iter().rev() {
                doc.restore_entry(id, entry);
            }
            Err(reason)
        }
    }
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

/// The same board with a new title (used when cloning). Tombstones are kept: ids are never
/// reused, and a clone's undo stays meaningful to nobody, so this is purely cosmetic.
pub fn retitle(mut doc: Doc, title: &str) -> Doc {
    let meta = doc.iter_live().find(|(_, r)| matches!(r, Record::BoardMeta(_))).map(|(id, _)| id);
    if let Some(id) = meta
        && let Some(e) = doc.entry_mut(id)
    {
        e.record.set(FieldValue::Title(title.to_owned()));
    }
    doc
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
    doc.insert(scene, Record::Scene(Scene { name: "Scene 1".into(), order: OrderKey::first(), clock: None }));
    for (slot_id, team, slot) in slots {
        doc.insert(next_id(), Record::PlayerState(PlayerState::starting(scene, slot_id, team, slot)));
    }
    debug_assert!(validate::check_invariants(&doc).is_ok(), "genesis must satisfy the invariants");
    doc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board() -> (Doc, RecordId, RecordId) {
        let mut n = 0u128;
        let doc = genesis(
            || {
                n += 1;
                RecordId(n)
            },
            "t",
        );
        let scene = doc.iter_live().find(|(_, r)| matches!(r, Record::Scene(_))).map(|(id, _)| id).expect("scene");
        let player = doc.iter_live().find(|(_, r)| matches!(r, Record::PlayerState(_))).map(|(id, _)| id).expect("player");
        (doc, scene, player)
    }

    fn tx(ops: Vec<Op>) -> Tx {
        Tx { client: ClientId(1), cseq: 0, kind: TxKind::Edit, ops }
    }

    fn mv(id: RecordId, x: i32) -> Op {
        Op::Set { id, value: FieldValue::PlayerPos(WorldPos { x, y: 0 }) }
    }

    #[test]
    fn a_failing_op_rolls_back_the_ops_before_it() {
        let (mut doc, _, player) = board();
        let before = doc.clone();
        let r = apply_tx(&mut doc, &tx(vec![mv(player, 5), mv(RecordId(999_999), 1)]));
        assert_eq!(r, Err(Reject::NoSuchRecord));
        assert_eq!(doc, before, "the first op's write must be undone");
    }

    #[test]
    fn a_failed_invariant_rolls_back_the_whole_transaction() {
        let (mut doc, scene, player) = board();
        let before = doc.clone();
        let note = |id| Op::Create { id: RecordId(id), record: Record::Note(Note { scene, text: "x".into() }) };
        // Two notes in one scene: each create is valid alone; the invariant check rejects them.
        let r = apply_tx(&mut doc, &tx(vec![mv(player, 7), note(1000), note(1001)]));
        assert_eq!(r, Err(Reject::Duplicate));
        assert_eq!(doc, before, "creates and the write before them must all be undone");
        let r = apply_tx(&mut doc, &tx(vec![mv(player, 7), Op::Delete { id: scene }]));
        assert_eq!(r, Err(Reject::LastScene));
        assert_eq!(doc, before);
    }

    #[test]
    fn inverse_undoes_exactly() {
        let (mut doc, scene, player) = board();
        let before = doc.clone();
        let ops = vec![
            mv(player, 42),
            Op::Create { id: RecordId(2000), record: Record::Callout(Callout { scene, pos: WorldPos { x: 1, y: 2 }, text: "smoke".into() }) },
        ];
        let (_, inverse) = apply_tx_with_inverse(&mut doc, &tx(ops)).expect("valid");
        apply_tx(&mut doc, &tx(inverse)).expect("inverse applies");
        // The callout is tombstoned rather than removed (ids are never reused); everything else
        // is exactly as before.
        let live: Vec<_> = doc.iter_live().collect();
        let live_before: Vec<_> = before.iter_live().collect();
        assert_eq!(live, live_before);
    }

    #[test]
    fn records_saved_before_clock_and_souls_still_load() {
        let old_scene = r#"{"Scene":{"name":"8:00 mid","order":"i"}}"#;
        let old_player = r#"{"PlayerState":{"scene":"00000000000000000000000000000001","slot":"00000000000000000000000000000002","pos":{"x":1,"y":2},"alive":true,"placed":true}}"#;
        let s: Record = serde_json::from_str(old_scene).expect("old scene loads");
        let p: Record = serde_json::from_str(old_player).expect("old player loads");
        assert!(matches!(s, Record::Scene(Scene { clock: None, .. })));
        assert!(matches!(p, Record::PlayerState(PlayerState { souls: None, .. })));
    }

    #[test]
    fn field_writes_skip_the_invariant_check_but_structure_does_not() {
        assert!(!affects_invariants(&mv(RecordId(1), 0)));
        assert!(affects_invariants(&Op::Delete { id: RecordId(1) }));
        assert!(affects_invariants(&Op::Restore { id: RecordId(1) }));
    }

    #[test]
    fn the_largest_legal_ops_fit_the_op_and_tx_bounds() {
        // Build the worst cases the limits allow and check the bounds in `Limits` hold for them.
        let (mut doc, scene, _) = board();
        let widest = "\u{1F600}".repeat(LIMITS.max_note); // 4 bytes of UTF-8 per char
        let corner = WorldPos { x: -LIMITS.max_coord, y: -LIMITS.max_coord };
        let note = RecordId(u128::MAX);
        let ops = [
            Op::Create { id: note, record: Record::Note(Note { scene, text: widest.clone() }) },
            Op::SetIf { id: note, expect: FieldValue::NoteText(widest.clone()), value: FieldValue::NoteText(widest.clone()) },
            Op::Create {
                id: RecordId(u128::MAX - 1),
                record: Record::Stroke(Stroke { scene, points: vec![corner; LIMITS.max_stroke_points], color: 15, width: 200 }),
            },
        ];
        for op in ops {
            let t = Tx { client: ClientId(u128::MAX), cseq: u64::MAX, kind: TxKind::Redo { of: u64::MAX }, ops: vec![op] };
            apply_tx(&mut doc, &t).expect("the op is legal");
            let op_len = serde_json::to_vec(&t.ops[0]).expect("json").len();
            assert!(op_len <= LIMITS.max_op_bytes(), "{op_len} > {}", LIMITS.max_op_bytes());
            let tx_len = serde_json::to_vec(&t).expect("json").len();
            assert!(tx_len <= LIMITS.max_tx_bytes, "{tx_len}");
        }
    }
}
