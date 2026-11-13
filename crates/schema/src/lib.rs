//! mapcro board schema: records, ops, transactions, validation and apply semantics.
//!
//! This crate is the single definition of what a board *is*. The server's authority and the
//! browser's replica both call [`apply_tx`], so they cannot disagree about what a transaction
//! does. It is pure: no I/O, no clocks, no randomness.

mod doc;
mod file;
mod ids;
mod map_state;
mod records;
mod validate;

pub use doc::{Doc, DocKind, Entry};
pub use file::{export_records, import_records};
#[cfg(feature = "ts")]
pub use doc::DocPair;
pub use ids::{BoardId, ClientId, GrantId, HeroId, LaneKey, ObjectiveKey, OrderKey, RecordId, is_id22};
pub use map_state::{Entity, Kind, MAX_SAFE_INT, More, MoreValue, ROWS, Row, RowId, Status};
pub use records::{
    Arrow, BoardMeta, Callout, Field, FieldValue, Note, ObjectiveState, ObjectiveStatus, PlayerState,
    Record, RecordKind, RosterSlot, Scene, SceneSource, SceneState, SessionMeta, Stroke, Tab, Team, WAVE_T_MAX, Wave, WorldPos,
};
pub use validate::{Limits, Reject, LIMITS};

include!(concat!(env!("OUT_DIR"), "/build_id.rs"));

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

/// The session document's format (`SessionMeta::version`).
pub const SESSION_VERSION: u32 = 1;

/// A fresh session (sessions spec §2.2): its `SessionMeta`, and the given tabs as
/// `(board, grant, name)`, in order. Ids come from the caller, as for [`genesis`].
pub fn session_genesis(mut next_id: impl FnMut() -> RecordId, title: &str, tabs: &[(BoardId, GrantId, String)]) -> Doc {
    let mut doc = Doc::default();
    doc.insert(next_id(), Record::SessionMeta(SessionMeta { title: title.to_owned(), version: SESSION_VERSION }));
    let mut order: Option<OrderKey> = None;
    for (board, grant, name) in tabs {
        let key = OrderKey::between(order.as_ref(), None);
        doc.insert(next_id(), Record::Tab(Tab { board: board.clone(), grant: grant.clone(), name: name.clone(), order: key.clone() }));
        order = Some(key);
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
    doc.insert(scene, Record::Scene(Scene { name: String::new(), order: OrderKey::first(), clock: None, source: None, live: false, parent: None }));
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
    fn scenes_nest_without_cycles() {
        let (mut doc, a, player) = board();
        let scene = |id: u128, parent: Option<RecordId>| Op::Create {
            id: RecordId(id),
            record: Record::Scene(Scene { name: "s".into(), order: OrderKey::first(), clock: None, source: None, live: false, parent }),
        };
        let parent = |id: RecordId, p: Option<RecordId>| Op::Set { id, value: FieldValue::SceneParent(p) };
        // A scene needs player states to be complete: copy a's for each new scene.
        let base: Vec<PlayerState> = doc
            .iter_live()
            .filter_map(|(_, r)| match r {
                Record::PlayerState(p) if p.scene == a => Some(p.clone()),
                _ => None,
            })
            .collect();
        let players = |s: u128| -> Vec<Op> {
            base.iter()
                .enumerate()
                .map(|(i, p)| Op::Create { id: RecordId(s * 100 + i as u128), record: Record::PlayerState(PlayerState { scene: RecordId(s), ..p.clone() }) })
                .collect()
        };
        let (b, c) = (RecordId(2000), RecordId(3000));
        let mut ops = vec![scene(2000, Some(a))];
        ops.extend(players(2000));
        assert_eq!(apply_tx(&mut doc, &tx(ops)).map(|_| ()), Ok(()));
        let mut ops = vec![scene(3000, Some(b))];
        ops.extend(players(3000));
        assert_eq!(apply_tx(&mut doc, &tx(ops)).map(|_| ()), Ok(()));
        // Under itself, under its child or grandchild: refused. Under nothing, a player, a gone id: refused too.
        assert_eq!(apply_tx(&mut doc, &tx(vec![parent(a, Some(a))])), Err(Reject::SceneCycle));
        assert_eq!(apply_tx(&mut doc, &tx(vec![parent(a, Some(c))])), Err(Reject::SceneCycle));
        assert_eq!(apply_tx(&mut doc, &tx(vec![parent(b, Some(c))])), Err(Reject::SceneCycle));
        assert_eq!(apply_tx(&mut doc, &tx(vec![parent(a, Some(player))])), Err(Reject::NoSuchScene));
        assert_eq!(apply_tx(&mut doc, &tx(vec![parent(a, Some(RecordId(99_999)))])), Err(Reject::NoSuchScene));
        assert_eq!(apply_tx(&mut doc, &tx(vec![scene(4000, Some(RecordId(99_999)))])), Err(Reject::NoSuchScene));
        // Re-parent: c moves to the top; then a may nest under c.
        assert_eq!(apply_tx(&mut doc, &tx(vec![parent(c, None)])).map(|_| ()), Ok(()));
        assert_eq!(apply_tx(&mut doc, &tx(vec![parent(a, Some(c))])).map(|_| ()), Ok(()));
        // Deleting a parent: its child moves up in the same transaction (what the UI sends).
        assert_eq!(apply_tx(&mut doc, &tx(vec![parent(b, None), Op::Delete { id: a }])).map(|_| ()), Ok(()));
        assert!(matches!(doc.live(b), Some(Record::Scene(Scene { parent: None, .. }))));
        // An old scene loads without a parent.
        let old: Record = serde_json::from_str(r#"{"Scene":{"name":"x","order":"a","clock":null}}"#).expect("old scene");
        assert!(matches!(old, Record::Scene(Scene { parent: None, .. })));
    }

    /// Two scenes copied from `a` (each with its player states), as children of `parents`.
    fn add_scenes(doc: &mut Doc, a: RecordId, specs: &[(u128, Option<RecordId>)]) {
        let base: Vec<PlayerState> = doc
            .iter_live()
            .filter_map(|(_, r)| match r {
                Record::PlayerState(p) if p.scene == a => Some(p.clone()),
                _ => None,
            })
            .collect();
        for (s, parent) in specs {
            let mut ops = vec![Op::Create {
                id: RecordId(*s),
                record: Record::Scene(Scene { name: "s".into(), order: OrderKey::first(), clock: None, source: None, live: false, parent: *parent }),
            }];
            ops.extend(base.iter().enumerate().map(|(i, p)| Op::Create {
                id: RecordId(s * 100 + i as u128),
                record: Record::PlayerState(PlayerState { scene: RecordId(*s), ..p.clone() }),
            }));
            assert_eq!(apply_tx(doc, &tx(ops)).map(|_| ()), Ok(()));
        }
    }

    #[test]
    fn the_cycle_check_walks_through_deleted_scenes() {
        // a ─ b ─ c; b deleted (c still points at it). a under c would close a loop through b.
        let (mut doc, a, _) = board();
        let (b, c) = (RecordId(2000), RecordId(3000));
        add_scenes(&mut doc, a, &[(2000, Some(a)), (3000, Some(b))]);
        assert_eq!(apply_tx(&mut doc, &tx(vec![Op::Delete { id: b }])).map(|_| ()), Ok(()));
        let up = Op::Set { id: a, value: FieldValue::SceneParent(Some(c)) };
        assert_eq!(apply_tx(&mut doc, &tx(vec![up])), Err(Reject::SceneCycle));
    }

    #[test]
    fn an_undo_of_a_nest_that_would_be_skipped_is_not_rejected() {
        // x was under p; I nest x under q; a peer then moves x to the top and deletes p. My undo
        // (SetIf expect q → p) no longer matches, so it's skipped, not refused for p being gone.
        let (mut doc, a, _) = board();
        let (p, q, x) = (RecordId(2000), RecordId(3000), RecordId(4000));
        add_scenes(&mut doc, a, &[(2000, None), (3000, None), (4000, Some(p))]);
        let nest = Op::Set { id: x, value: FieldValue::SceneParent(Some(q)) };
        let (_, undo) = apply_tx_with_inverse(&mut doc, &tx(vec![nest])).expect("nest");
        let peer = vec![Op::Set { id: x, value: FieldValue::SceneParent(None) }, Op::Delete { id: p }];
        assert_eq!(apply_tx(&mut doc, &tx(peer)).map(|_| ()), Ok(()));
        assert_eq!(apply_tx(&mut doc, &tx(undo)), Ok(vec![OpOutcome::Skipped]));
        assert!(matches!(doc.live(x), Some(Record::Scene(Scene { parent: None, .. }))));
    }

    #[test]
    fn arrows_and_comments_take_a_palette_colour() {
        let (mut doc, scene, _) = board();
        let arrow = |id: u128, color| Op::Create {
            id: RecordId(id),
            record: Record::Arrow(Arrow { scene, from: WorldPos { x: 0, y: 0 }, to: WorldPos { x: 9, y: 9 }, team: None, color }),
        };
        let callout = |id: u128, color| Op::Create { id: RecordId(id), record: Record::Callout(Callout { scene, pos: WorldPos::default(), text: "x".into(), color }) };
        assert_eq!(apply_tx(&mut doc, &tx(vec![arrow(5000, Some(15)), callout(5001, Some(3))])).map(|_| ()), Ok(()));
        assert_eq!(apply_tx(&mut doc, &tx(vec![arrow(5002, Some(16))])), Err(Reject::OutOfBounds));
        assert_eq!(apply_tx(&mut doc, &tx(vec![callout(5003, Some(200))])), Err(Reject::OutOfBounds));
        let recolour = Op::Set { id: RecordId(5001), value: FieldValue::CalloutColor(Some(16)) };
        assert_eq!(apply_tx(&mut doc, &tx(vec![recolour])), Err(Reject::OutOfBounds));
        // Older records load with no colour: their kind's usual look.
        let old: Record = serde_json::from_str(r#"{"Arrow":{"scene":"00000000000000000000000000000001","from":{"x":0,"y":0},"to":{"x":1,"y":1},"team":null}}"#).expect("old arrow");
        assert!(matches!(old, Record::Arrow(Arrow { color: None, .. })));
    }

    #[test]
    fn inverse_undoes_exactly() {
        let (mut doc, scene, player) = board();
        let before = doc.clone();
        let ops = vec![
            mv(player, 42),
            Op::Create { id: RecordId(2000), record: Record::Callout(Callout { scene, pos: WorldPos { x: 1, y: 2 }, text: "smoke".into(), color: None }) },
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
    fn records_saved_before_vision_load_as_visible() {
        let old_player = r#"{"PlayerState":{"scene":"00000000000000000000000000000001","slot":"00000000000000000000000000000002","pos":{"x":1,"y":2},"alive":true,"placed":true,"souls":null,"ult_cooldown":null}}"#;
        let p: Record = serde_json::from_str(old_player).expect("old player loads");
        assert!(matches!(p, Record::PlayerState(PlayerState { visible: true, .. })));
    }

    #[test]
    fn camp_rift_and_mid_boss_keys_are_valid_objectives() {
        let (doc, scene, _) = board();
        for k in ["camp:neutral:lane1:10", "rift:neutral:lane6:1", "mid_boss:neutral:lane4:1", "base_guardian:amber:lane4"] {
            let op = Op::Create {
                id: RecordId(900),
                record: Record::ObjectiveState(ObjectiveState { scene, key: crate::ids::ObjectiveKey(k.into()), status: ObjectiveStatus::Destroyed, more: More::default() }),
            };
            apply_tx(&mut doc.clone(), &tx(vec![op])).expect(k);
        }
    }

    #[test]
    fn one_wave_per_lane_per_scene_and_its_position_is_bounded() {
        let (mut doc, scene, _) = board();
        let wave = |id: u128, lane: &str, t: u16| Op::Create {
            id: RecordId(id),
            record: Record::Wave(Wave { scene, lane: LaneKey(lane.into()), t, more: More::default() }),
        };
        apply_tx(&mut doc, &tx(vec![wave(900, "lane1", 500), wave(901, "lane4", 0)])).expect("two lanes");
        assert_eq!(apply_tx(&mut doc.clone(), &tx(vec![wave(902, "lane1", 10)])), Err(Reject::Duplicate));
        assert_eq!(apply_tx(&mut doc.clone(), &tx(vec![wave(903, "lane6", WAVE_T_MAX + 1)])), Err(Reject::OutOfBounds));
        assert_eq!(apply_tx(&mut doc.clone(), &tx(vec![wave(904, "Lane 6", 1)])), Err(Reject::BadObjectiveKey));
        let set = |t| tx(vec![Op::Set { id: RecordId(900), value: FieldValue::WavePos(t) }]);
        assert_eq!(apply_tx(&mut doc.clone(), &set(WAVE_T_MAX + 1)), Err(Reject::OutOfBounds));
        apply_tx(&mut doc, &set(WAVE_T_MAX)).expect("the Sapphire end");
        // Removed is "not tracked"; the lane can then be placed again.
        apply_tx(&mut doc, &tx(vec![Op::Delete { id: RecordId(900) }])).expect("delete");
        apply_tx(&mut doc, &tx(vec![wave(905, "lane1", 300)])).expect("placed again");
    }

    #[test]
    fn vision_is_a_field_like_any_other() {
        let (mut doc, _, player) = board();
        apply_tx(&mut doc, &tx(vec![Op::Set { id: player, value: FieldValue::PlayerVisible(false) }])).expect("set");
        assert!(matches!(doc.live(player), Some(Record::PlayerState(PlayerState { visible: false, .. }))));
    }

    fn key(k: &str) -> RowId {
        RowId::of(k).expect("a registry row")
    }

    fn more(k: &str, value: Option<MoreValue>) -> FieldValue {
        FieldValue::More { key: key(k), value }
    }

    fn state(scene: RecordId) -> Record {
        Record::SceneState(SceneState { scene, more: More::default() })
    }

    #[test]
    fn a_registry_value_is_set_replaced_and_cleared_like_any_field() {
        let (mut doc, _, player) = board();
        let hero = |doc: &Doc| match doc.live(player) {
            Some(Record::PlayerState(p)) => p.more.get(key("hero")).cloned(),
            _ => panic!("player"),
        };
        assert_eq!(hero(&doc), None);
        apply_tx(&mut doc, &tx(vec![Op::Set { id: player, value: more("hero", Some(MoreValue::Int(13))) }])).expect("set");
        assert_eq!(hero(&doc), Some(MoreValue::Int(13)));
        apply_tx(&mut doc, &tx(vec![Op::Set { id: player, value: more("hero", Some(MoreValue::Int(14))) }])).expect("replace");
        assert_eq!(hero(&doc), Some(MoreValue::Int(14)));
        // Two keys of one record are two fields: writing one leaves the other.
        apply_tx(&mut doc, &tx(vec![Op::Set { id: player, value: more("name", Some(MoreValue::Text("Solo".into()))) }])).expect("another key");
        assert_eq!(hero(&doc), Some(MoreValue::Int(14)));
        apply_tx(&mut doc, &tx(vec![Op::Set { id: player, value: more("hero", None) }])).expect("clear");
        assert_eq!(hero(&doc), None);
        let Some(Record::PlayerState(p)) = doc.live(player) else { panic!("player") };
        assert_eq!(p.more.iter().count(), 1, "the other key stays");
        // The typed fields beside it are untouched, and it's a field write: no invariant check.
        assert!(p.alive && p.visible);
        assert!(!affects_invariants(&Op::Set { id: player, value: more("hero", None) }));
    }

    #[test]
    fn a_registry_value_is_refused_off_its_row_its_entity_or_its_record() {
        let (mut doc, scene, player) = board();
        let before = doc.clone();
        let set = |value| tx(vec![Op::Set { id: player, value }]);
        assert_eq!(apply_tx(&mut doc, &set(more("hero", Some(MoreValue::Int(-1))))), Err(Reject::OutOfBounds));
        assert_eq!(apply_tx(&mut doc, &set(more("hero", Some(MoreValue::Text("13".into()))))), Err(Reject::WrongField));
        assert_eq!(apply_tx(&mut doc, &set(more("name", Some(MoreValue::Text("n".repeat(LIMITS.max_name + 1).into()))))), Err(Reject::TextTooLong));
        // A scene's key on a hero, a hero's key on the scene's state, any key on a note.
        assert_eq!(apply_tx(&mut doc, &set(more("has_builds", Some(MoreValue::Bool(true))))), Err(Reject::WrongField));
        assert_eq!(apply_tx(&mut doc, &set(more("has_builds", None))), Err(Reject::WrongField));
        apply_tx(&mut doc, &tx(vec![Op::Create { id: RecordId(900), record: state(scene) }, Op::Create { id: RecordId(901), record: Record::Note(Note { scene, text: "n".into() }) }])).expect("state and note");
        let on = |id: u128, value| tx(vec![Op::Set { id: RecordId(id), value }]);
        assert_eq!(apply_tx(&mut doc, &on(900, more("hero", Some(MoreValue::Int(1))))), Err(Reject::WrongField));
        assert_eq!(apply_tx(&mut doc, &on(901, more("hero", Some(MoreValue::Int(1))))), Err(Reject::WrongField));
        assert_eq!(apply_tx(&mut doc, &on(900, more("has_builds", Some(MoreValue::Bool(true))))).map(|_| ()), Ok(()));
        // A record created with a bad `more` is refused whole, for each kind that holds one.
        let hero_key: More = [(key("hero"), MoreValue::Int(1))].into_iter().collect();
        let out_of_row: More = [(key("rows"), MoreValue::Int(-1))].into_iter().collect();
        let slot = match doc.live(player) {
            Some(Record::PlayerState(p)) => p.slot,
            _ => panic!("player"),
        };
        let bad = [
            (Record::SceneState(SceneState { scene, more: hero_key.clone() }), Reject::WrongField),
            (Record::SceneState(SceneState { scene, more: out_of_row.clone() }), Reject::OutOfBounds),
            (Record::ObjectiveState(ObjectiveState { scene, key: ObjectiveKey("walker:amber:lane1:1".into()), status: ObjectiveStatus::Active, more: hero_key.clone() }), Reject::WrongField),
            (Record::Wave(Wave { scene, lane: LaneKey("lane1".into()), t: 1, more: hero_key }), Reject::WrongField),
            (Record::PlayerState(PlayerState { more: out_of_row, ..PlayerState::starting(scene, slot, Team::Amber, 0) }), Reject::WrongField),
        ];
        for (record, why) in bad {
            assert_eq!(apply_tx(&mut doc.clone(), &tx(vec![Op::Create { id: RecordId(950), record: record.clone() }])), Err(why), "{record:?}");
        }
        assert_eq!(before.live(player), doc.live(player), "nothing refused was written");
    }

    #[test]
    fn undo_restores_a_registry_value_set_replaced_or_cleared() {
        let (mut doc, _, player) = board();
        let start = doc.clone();
        // Set where there was none: undo clears it.
        let (_, undo_set) = apply_tx_with_inverse(&mut doc, &tx(vec![Op::Set { id: player, value: more("hero", Some(MoreValue::Int(13))) }])).expect("set");
        assert_eq!(undo_set, vec![Op::SetIf { id: player, expect: more("hero", Some(MoreValue::Int(13))), value: more("hero", None) }]);
        let set = doc.clone();
        // Replace, then clear: each undo puts back exactly what it saw.
        let (_, undo_replace) = apply_tx_with_inverse(&mut doc, &tx(vec![Op::Set { id: player, value: more("hero", Some(MoreValue::Int(14))) }])).expect("replace");
        let replaced = doc.clone();
        let (_, undo_clear) = apply_tx_with_inverse(&mut doc, &tx(vec![Op::Set { id: player, value: more("hero", None) }])).expect("clear");
        assert_eq!(undo_clear, vec![Op::SetIf { id: player, expect: more("hero", None), value: more("hero", Some(MoreValue::Int(14))) }]);
        assert_eq!(apply_tx(&mut doc, &tx(undo_clear)), Ok(vec![OpOutcome::Applied]));
        assert_eq!(doc, replaced);
        assert_eq!(apply_tx(&mut doc, &tx(undo_replace)), Ok(vec![OpOutcome::Applied]));
        assert_eq!(doc, set);
        assert_eq!(apply_tx(&mut doc, &tx(undo_set.clone())), Ok(vec![OpOutcome::Applied]));
        assert_eq!(doc, start);
        // Writing the value a key already has changes nothing, so there is nothing to undo.
        let (_, none) = apply_tx_with_inverse(&mut doc, &tx(vec![Op::Set { id: player, value: more("hero", None) }])).expect("no-op");
        assert_eq!(none, vec![]);
        // An undo whose value someone else changed since is skipped, and so is one on another key.
        apply_tx(&mut doc, &tx(vec![Op::Set { id: player, value: more("hero", Some(MoreValue::Int(20))) }])).expect("a peer's write");
        assert_eq!(apply_tx(&mut doc, &tx(undo_set)), Ok(vec![OpOutcome::Skipped]));
        let cross = Op::SetIf { id: player, expect: more("hero", Some(MoreValue::Int(20))), value: more("name", Some(MoreValue::Text("x".into()))) };
        assert_eq!(apply_tx(&mut doc, &tx(vec![cross])), Err(Reject::MismatchedSetIf));
    }

    #[test]
    fn a_scene_has_at_most_one_live_scene_state_and_it_deletes_and_restores() {
        let (mut doc, scene, _) = board();
        let create = |id: u128| Op::Create { id: RecordId(id), record: state(scene) };
        assert!(affects_invariants(&create(1)));
        let (_, undo) = apply_tx_with_inverse(&mut doc, &tx(vec![create(900)])).expect("the scene's state");
        assert_eq!(undo, vec![Op::Delete { id: RecordId(900) }]);
        assert_eq!(apply_tx(&mut doc, &tx(vec![create(901)])), Err(Reject::Duplicate));
        assert_eq!(apply_tx(&mut doc, &tx(vec![Op::Create { id: RecordId(902), record: state(RecordId(77)) }])), Err(Reject::NoSuchScene));
        // Deleted (an undo of its creation), the scene may get another; the first can't come back
        // beside it.
        apply_tx(&mut doc, &tx(undo)).expect("undo");
        assert!(doc.live(RecordId(900)).is_none());
        apply_tx(&mut doc, &tx(vec![create(901)])).expect("another");
        assert_eq!(apply_tx(&mut doc, &tx(vec![Op::Restore { id: RecordId(900) }])), Err(Reject::Duplicate));
        apply_tx(&mut doc, &tx(vec![Op::Delete { id: RecordId(901) }, Op::Restore { id: RecordId(900) }])).expect("swap back");
        validate_doc(&doc).expect("valid");
        // It belongs to its scene: exported with it, and its scene is `Record::scene`.
        assert_eq!(state(scene).scene(), Some(scene));
        assert_eq!(state(scene).kind(), RecordKind::SceneState);
        assert!(!RecordKind::SceneState.is_session());
        assert!(export_records(&doc).iter().any(|(id, _)| *id == RecordId(900)));
        // A session holds none.
        let mut session = session_genesis(|| RecordId(1), "s", &[]);
        assert_eq!(apply_tx(&mut session, &tx(vec![create(5)])), Err(Reject::WrongDocKind));
    }

    #[test]
    fn a_records_more_is_capped_as_json_on_create_and_on_every_write() {
        let (mut doc, _, player) = board();
        let list = |k: &str, n: usize| more(k, Some(MoreValue::ints(vec![4_294_967_295; n])));
        // Each list is within its row; together they pass the record's cap, at the write that crosses it.
        apply_tx(&mut doc, &tx(vec![Op::Set { id: player, value: list("build_order", 600) }, Op::Set { id: player, value: list("items", 128) }])).expect("two full lists fit");
        let before = doc.clone();
        assert_eq!(apply_tx(&mut doc, &tx(vec![Op::Set { id: player, value: list("abilities", 48) }])), Err(Reject::TxTooLarge));
        assert_eq!(doc, before);
        // The same through a SetIf whose expectation holds; one that doesn't hold is skipped first.
        let grow = |expect| Op::SetIf { id: player, expect, value: list("abilities", 48) };
        assert_eq!(apply_tx(&mut doc, &tx(vec![grow(more("abilities", None))])), Err(Reject::TxTooLarge));
        assert_eq!(apply_tx(&mut doc, &tx(vec![grow(list("abilities", 1))])), Ok(vec![OpOutcome::Skipped]));
        assert_eq!(doc, before);
        // Replacing the big list with a small one makes room; clearing always fits.
        apply_tx(&mut doc, &tx(vec![Op::Set { id: player, value: list("build_order", 10) }, Op::Set { id: player, value: list("abilities", 48) }])).expect("room now");
        apply_tx(&mut doc, &tx(vec![Op::Set { id: player, value: more("items", None) }])).expect("clear");
        // A write to a deleted record is skipped before it is measured, like any field's.
        let Some(Record::PlayerState(p)) = doc.live(player) else { panic!("player") };
        assert!(p.more.json_len() <= LIMITS.max_more_bytes);
    }

    #[test]
    fn the_largest_legal_registry_ops_fit_the_op_and_tx_bounds() {
        let (mut doc, scene, player) = board();
        // The fullest `more` a record may hold: its lists filled to the byte cap with the widest ints.
        let widest = |n: usize| MoreValue::ints(vec![4_294_967_295; n]);
        let filled = |n: usize| -> More { [(key("build_order"), widest(600)), (key("items"), widest(128)), (key("abilities"), widest(n))].into_iter().collect() };
        let fill = (1..=48usize).rev().find(|n| filled(*n).json_len() <= LIMITS.max_more_bytes).expect("fits");
        let full = filled(fill);
        assert!(full.json_len() > LIMITS.max_more_bytes - 12, "filled to within one more int of the cap: {}", full.json_len());
        full.check(Entity::Hero).expect("legal");
        let slot = match doc.live(player) {
            Some(Record::PlayerState(p)) => p.slot,
            _ => panic!("player"),
        };
        let mut hero = PlayerState::starting(scene, slot, Team::Sapphire, 5);
        hero.more = full.clone();
        hero.souls = Some(1_000_000);
        hero.respawn = Some(600);
        hero.ult_cooldown = Some(100);
        hero.pos = WorldPos { x: -LIMITS.max_coord, y: -LIMITS.max_coord };
        let ops = [
            // Not applied (a scene already has this slot's player): measured as a client sends it.
            Op::Create { id: RecordId(u128::MAX), record: Record::PlayerState(hero) },
            Op::SetIf { id: player, expect: more("build_order", Some(widest(600))), value: more("build_order", Some(widest(600))) },
        ];
        for op in ops {
            let t = Tx { client: ClientId(u128::MAX), cseq: u64::MAX, kind: TxKind::Redo { of: u64::MAX }, ops: vec![op] };
            let op_len = serde_json::to_vec(&t.ops[0]).expect("json").len();
            assert!(op_len <= LIMITS.max_op_bytes(), "{op_len} > {}", LIMITS.max_op_bytes());
            assert!(serde_json::to_vec(&t).expect("json").len() <= LIMITS.max_tx_bytes);
        }
        // And the SetIf is legal: the value fits the record it lands on.
        apply_tx(&mut doc, &tx(vec![Op::Set { id: player, value: more("build_order", Some(widest(600))) }])).expect("legal");
        assert!(LIMITS.to_ts().contains("max_more_bytes: 8192,") && LIMITS.to_ts().contains("max_more_ints: 1280,"));
    }

    #[test]
    fn the_heap_estimate_counts_registry_values_on_every_kind_that_holds_them() {
        let (mut doc, scene, player) = board();
        let ints = |n: usize| MoreValue::ints(vec![7; n]);
        let with: More = [(key("build"), MoreValue::Int(1))].into_iter().collect();
        let small = doc.approx_heap_bytes();
        apply_tx(&mut doc, &tx(vec![Op::Set { id: player, value: more("items", Some(ints(100))) }])).expect("hero");
        let hero = doc.approx_heap_bytes() - small;
        assert!((800 + 300..800 + 500).contains(&hero), "{hero} for 800 bytes of ints and a map node");
        let before = doc.approx_heap_bytes();
        apply_tx(&mut doc, &tx(vec![Op::Create { id: RecordId(900), record: Record::SceneState(SceneState { scene, more: More::default() }) }])).expect("state");
        let empty = doc.approx_heap_bytes() - before;
        apply_tx(&mut doc, &tx(vec![Op::Set { id: RecordId(900), value: more("build", Some(MoreValue::Int(1))) }])).expect("scene");
        let entry = doc.approx_heap_bytes() - before - empty;
        assert!(entry >= 11 * std::mem::size_of::<MoreValue>(), "the first entry counts its map node: {entry}");
        // A marker's and a lane's count the same entry on top of their key.
        for record in [
            Record::ObjectiveState(ObjectiveState { scene, key: ObjectiveKey("walker:amber:lane1:1".into()), status: ObjectiveStatus::Active, more: More::default() }),
            Record::Wave(Wave { scene, lane: LaneKey("lane1".into()), t: 1, more: More::default() }),
        ] {
            let mut plain = doc.clone();
            apply_tx(&mut plain, &tx(vec![Op::Create { id: RecordId(950), record: record.clone() }])).expect("plain");
            // No row belongs to a marker or a lane yet, so hold the map directly.
            let held = match record {
                Record::ObjectiveState(o) => Record::ObjectiveState(ObjectiveState { more: with.clone(), ..o }),
                Record::Wave(w) => Record::Wave(Wave { more: with.clone(), ..w }),
                _ => unreachable!(),
            };
            let mut filled = doc.clone();
            filled.insert(RecordId(950), held);
            assert_eq!(filled.approx_heap_bytes() - plain.approx_heap_bytes(), entry);
        }
    }

    #[test]
    fn every_field_value_names_a_field_in_all_and_every_row_is_a_field() {
        let all: Vec<Field> = Field::all().collect();
        assert_eq!(all.len(), Field::TYPED.len() + ROWS.len());
        assert!(RowId::all().all(|r| all.contains(&Field::More(r))));
        assert!(all.contains(&more("hero", None).field()));
        assert_eq!(more("hero", Some(MoreValue::Int(1))).field(), Field::More(key("hero")));
        assert_ne!(more("hero", None).field(), more("name", None).field(), "each key is its own field");
        // On the wire: the key by name, the value bare, `null` to clear.
        let json = r#"{"Set":{"id":"00000000000000000000000000000001","value":{"More":{"key":"items","value":[1,2]}}}}"#;
        let op: Op = serde_json::from_str(json).expect("parses");
        assert_eq!(op, Op::Set { id: RecordId(1), value: more("items", Some(MoreValue::ints(vec![1, 2]))) });
        assert_eq!(serde_json::to_string(&op).expect("json"), json);
        assert_eq!(serde_json::to_string(&more("hero", None)).expect("json"), r#"{"More":{"key":"hero","value":null}}"#);
        assert!(serde_json::from_str::<FieldValue>(r#"{"More":{"key":"no_such_row","value":1}}"#).is_err(), "an unknown key is not a transaction");
    }

    #[test]
    fn records_from_before_more_load_empty_and_an_empty_more_is_not_written() {
        let s = "00000000000000000000000000000001";
        for old in [
            format!(r#"{{"PlayerState":{{"scene":"{s}","slot":"{s}","pos":{{"x":1,"y":2}},"alive":true,"placed":true,"souls":null,"ult_cooldown":null,"visible":true,"respawn":null}}}}"#),
            format!(r#"{{"ObjectiveState":{{"scene":"{s}","key":"walker:amber:lane1:1","status":"Destroyed"}}}}"#),
            format!(r#"{{"Wave":{{"scene":"{s}","lane":"lane1","t":500}}}}"#),
            format!(r#"{{"SceneState":{{"scene":"{s}"}}}}"#),
        ] {
            let r: Record = serde_json::from_str(&old).expect("loads");
            assert!(r.more().expect("holds a map").1.is_empty());
            assert_eq!(serde_json::to_string(&r).expect("json"), old, "written back byte for byte");
        }
        let filled: Record = serde_json::from_str(&format!(r#"{{"SceneState":{{"scene":"{s}","more":{{"rows":3,"has_builds":true}}}}}}"#)).expect("loads");
        let (entity, map) = filled.more().expect("map");
        assert_eq!((entity, map.iter().count()), (Entity::Scene, 2));
        // The kinds that hold no registry values say so.
        assert!(Record::Note(Note { scene: RecordId(1), text: String::new() }).more().is_none());
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
                record: Record::Stroke(Stroke { scene, points: vec![corner; LIMITS.max_stroke_points], color: 15, width: 200, offset: WorldPos { x: -2 * LIMITS.max_coord, y: -2 * LIMITS.max_coord } }),
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

    #[test]
    fn the_heap_estimate_tracks_the_biggest_documents() {
        // A host budgets memory by this estimate, so it must not undercount the heaviest records.
        let (mut doc, scene, _) = board();
        let small = doc.approx_heap_bytes();
        let points = vec![WorldPos { x: 1, y: 2 }; LIMITS.max_stroke_points];
        let strokes: Vec<Op> = (0..100)
            .map(|k| Op::Create { id: RecordId(10_000 + k), record: Record::Stroke(Stroke { scene, points: points.clone(), color: 1, width: 20, offset: WorldPos::default() }) })
            .collect();
        apply_tx(&mut doc, &tx(strokes)).expect("valid");
        let grew = doc.approx_heap_bytes() - small;
        let raw = 100 * LIMITS.max_stroke_points * std::mem::size_of::<WorldPos>();
        assert!(grew >= raw && grew < raw + raw / 4, "{grew} for {raw} bytes of points");
    }
}
