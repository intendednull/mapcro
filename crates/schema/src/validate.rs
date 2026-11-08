//! The board's rules. Every op is checked here before it touches the document, on both the
//! server and the client, so an invalid board cannot be built through the public API.

use crate::doc::Doc;
use crate::ids::RecordId;
use crate::records::{FieldValue, Record, RecordKind, SLOTS_PER_TEAM, WorldPos};
use crate::{Op, OpOutcome};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub struct Limits {
    pub max_ops_per_tx: usize,
    pub max_records: usize,
    pub max_scenes: usize,
    pub max_name: usize,
    pub max_title: usize,
    pub max_callout: usize,
    pub max_note: usize,
    pub max_stroke_points: usize,
    /// World coordinates are clamped to ±this (the map radius is ~10,752 units).
    pub max_coord: i32,
    /// A transaction's JSON encoding, in bytes. Twice the largest single op (an undo of a full
    /// note carries the note twice, about 32 KB), so any one legal op always fits, and the
    /// server's frame cap follows from this (security review 2026-11-07, C1).
    pub max_tx_bytes: usize,
}

impl Limits {
    /// An upper bound on one op's JSON encoding, from the other limits: the worst case is a
    /// `SetIf` on a note's text, which carries the text twice, each char up to 4 bytes of UTF-8.
    /// (A full stroke is smaller: 512 points of at most 25 bytes.) The 512 covers the op's
    /// framing, ids and field names. A test builds these ops and checks the bound holds.
    pub const fn max_op_bytes(&self) -> usize {
        let text = 2 * 4 * self.max_note;
        let stroke = self.max_stroke_points * 25;
        (if text > stroke { text } else { stroke }) + 512
    }
}

pub const LIMITS: Limits = Limits {
    max_ops_per_tx: 256,
    max_records: 5000,
    max_scenes: 64,
    max_name: 24,
    max_title: 80,
    max_callout: 80,
    max_note: 4000,
    max_stroke_points: 512,
    max_coord: 16384,
    max_tx_bytes: 64 * 1024,
};

// Every legal op fits in a transaction on its own.
const _: () = assert!(LIMITS.max_op_bytes() <= LIMITS.max_tx_bytes);

/// Why a transaction was refused. Typed so the client can explain it and tests can assert it.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
pub enum Reject {
    #[error("transaction has no ops")]
    EmptyTx,
    #[error("transaction has too many ops")]
    TooManyOps,
    #[error("board is full")]
    TooManyRecords,
    #[error("too many scenes")]
    TooManyScenes,
    #[error("record id already used")]
    IdTaken,
    #[error("no such record")]
    NoSuchRecord,
    #[error("this kind of record cannot be created or deleted by an edit")]
    Immutable,
    #[error("field does not belong to this kind of record")]
    WrongField,
    #[error("set_if must compare and write the same field")]
    MismatchedSetIf,
    #[error("text too long")]
    TextTooLong,
    #[error("text contains control characters")]
    BadText,
    #[error("position out of bounds")]
    OutOfBounds,
    #[error("invalid objective key")]
    BadObjectiveKey,
    #[error("invalid order key")]
    BadOrderKey,
    #[error("refers to a scene that does not exist")]
    NoSuchScene,
    #[error("refers to a roster slot that does not exist")]
    NoSuchSlot,
    #[error("duplicate record for this scene")]
    Duplicate,
    #[error("a scene must have exactly one player state per roster slot")]
    IncompleteScene,
    #[error("a board must keep at least one scene")]
    LastScene,
    /// A scene can't nest under itself or one of its own descendants.
    #[error("a scene can't nest under itself or its own scenes")]
    SceneCycle,
    #[error("this link can only view")]
    Forbidden,
    #[error("a stroke needs 2–512 points, a palette colour and a sane width")]
    BadStroke,
    /// The transaction's encoding is over `Limits::max_tx_bytes`.
    #[error("transaction is too large")]
    TxTooLarge,
    /// The board's history is at its quota (operations or bytes). Until snapshots and
    /// compaction ship (spec §9), a full board takes no more edits; a copy starts fresh.
    #[error("board history is full")]
    BoardFull,
    /// The server's storage is at its cap; no board takes edits until the operator makes room.
    #[error("server storage is full")]
    ServerFull,
}

fn check_text(s: &str, max: usize) -> Result<(), Reject> {
    if s.chars().count() > max {
        return Err(Reject::TextTooLong);
    }
    // Newlines are fine in notes; other control characters are not.
    if s.chars().any(|c| c.is_control() && c != '\n') {
        return Err(Reject::BadText);
    }
    Ok(())
}

fn check_pos(p: WorldPos) -> Result<(), Reject> {
    let m = LIMITS.max_coord;
    if (-m..=m).contains(&p.x) && (-m..=m).contains(&p.y) { Ok(()) } else { Err(Reject::OutOfBounds) }
}

fn check_value(v: &FieldValue) -> Result<(), Reject> {
    use FieldValue as V;
    match v {
        V::Title(s) => check_text(s, LIMITS.max_title),
        V::RosterName(s) | V::SceneName(s) => check_text(s, LIMITS.max_name),
        V::CalloutText(s) => check_text(s, LIMITS.max_callout),
        V::NoteText(s) => check_text(s, LIMITS.max_note),
        V::SceneOrder(k) => if k.is_valid() { Ok(()) } else { Err(Reject::BadOrderKey) },
        V::PlayerPos(p) | V::ArrowFrom(p) | V::ArrowTo(p) | V::CalloutPos(p) => check_pos(*p),
        // A palette index, like a stroke's colour.
        V::ArrowColor(c) | V::CalloutColor(c) => if c.is_none_or(|c| c < 16) { Ok(()) } else { Err(Reject::OutOfBounds) },
        // A shift, not a place: at most the board's width either way.
        V::StrokeOffset(d) => {
            let m = 2 * LIMITS.max_coord;
            if (-m..=m).contains(&d.x) && (-m..=m).contains(&d.y) { Ok(()) } else { Err(Reject::OutOfBounds) }
        }
        // A match clock up to four hours; souls up to a million.
        V::WavePos(t) => if *t <= crate::records::WAVE_T_MAX { Ok(()) } else { Err(Reject::OutOfBounds) },
        V::SceneClock(c) => if c.is_none_or(|c| c <= 4 * 3600) { Ok(()) } else { Err(Reject::OutOfBounds) },
        V::PlayerSouls(n) => if n.is_none_or(|n| n <= 1_000_000) { Ok(()) } else { Err(Reject::OutOfBounds) },
        V::PlayerUltCooldown(p) => if p.is_none_or(|p| p <= 100) { Ok(()) } else { Err(Reject::OutOfBounds) },
        // A respawn timer up to ten minutes.
        V::PlayerRespawn(s) => if s.is_none_or(|s| s <= 600) { Ok(()) } else { Err(Reject::OutOfBounds) },
        // A scene's parent is checked against the board (`check_parent`).
        V::RosterHero(_) | V::PlayerAlive(_) | V::PlayerPlaced(_) | V::PlayerVisible(_) | V::ObjectiveStatus(_) | V::ArrowTeam(_) | V::SceneParent(_) => Ok(()),
    }
}

/// Field-level checks for a whole record, as created.
fn check_record(doc: &Doc, r: &Record) -> Result<(), Reject> {
    let live_scene = |id: RecordId| matches!(doc.live(id), Some(Record::Scene(_)));
    match r {
        // Board metadata and the roster exist from genesis and are never created by an edit.
        Record::BoardMeta(_) | Record::RosterSlot(_) => Err(Reject::Immutable),
        Record::Scene(s) => {
            check_text(&s.name, LIMITS.max_name)?;
            check_value(&FieldValue::SceneClock(s.clock))?;
            if let Some(src) = &s.source
                && (src.match_id == 0 || src.match_id >= 1_000_000_000_000 || src.t > 86_400 || !(src.tier == "replay" || src.tier == "metadata"))
            {
                return Err(Reject::OutOfBounds);
            }
            if let Some(parent) = s.parent
                && !live_scene(parent)
            {
                return Err(Reject::NoSuchScene);
            }
            if s.order.is_valid() { Ok(()) } else { Err(Reject::BadOrderKey) }
        }
        Record::PlayerState(p) => {
            if !live_scene(p.scene) {
                return Err(Reject::NoSuchScene);
            }
            if !matches!(doc.live(p.slot), Some(Record::RosterSlot(_))) {
                return Err(Reject::NoSuchSlot);
            }
            check_value(&FieldValue::PlayerSouls(p.souls))?;
            check_value(&FieldValue::PlayerUltCooldown(p.ult_cooldown))?;
            check_value(&FieldValue::PlayerRespawn(p.respawn))?;
            check_pos(p.pos)
        }
        Record::ObjectiveState(o) => {
            if !live_scene(o.scene) {
                return Err(Reject::NoSuchScene);
            }
            if o.key.is_valid() { Ok(()) } else { Err(Reject::BadObjectiveKey) }
        }
        Record::Arrow(a) => {
            if !live_scene(a.scene) {
                return Err(Reject::NoSuchScene);
            }
            check_value(&FieldValue::ArrowColor(a.color))?;
            check_pos(a.from)?;
            check_pos(a.to)
        }
        Record::Callout(c) => {
            if !live_scene(c.scene) {
                return Err(Reject::NoSuchScene);
            }
            check_text(&c.text, LIMITS.max_callout)?;
            check_value(&FieldValue::CalloutColor(c.color))?;
            check_pos(c.pos)
        }
        Record::Wave(w) => {
            if !live_scene(w.scene) {
                return Err(Reject::NoSuchScene);
            }
            check_value(&FieldValue::WavePos(w.t))?;
            if w.lane.is_valid() { Ok(()) } else { Err(Reject::BadObjectiveKey) }
        }
        Record::Note(n) => {
            if !live_scene(n.scene) {
                return Err(Reject::NoSuchScene);
            }
            check_text(&n.text, LIMITS.max_note)
        }
        Record::Stroke(s) => {
            if !live_scene(s.scene) {
                return Err(Reject::NoSuchScene);
            }
            if s.points.len() < 2 || s.points.len() > LIMITS.max_stroke_points {
                return Err(Reject::BadStroke);
            }
            if s.color >= 16 || s.width == 0 || s.width > 200 {
                return Err(Reject::BadStroke);
            }
            check_value(&FieldValue::StrokeOffset(s.offset))?;
            s.points.iter().try_for_each(|p| check_pos(*p))
        }
    }
}

/// A scene nesting under `parent`: the parent must be a live scene, and not the scene itself or
/// one of its descendants (the walk up goes through deleted scenes too, which keep their parent).
fn check_parent(doc: &Doc, id: RecordId, value: &FieldValue) -> Result<(), Reject> {
    let FieldValue::SceneParent(Some(parent)) = value else { return Ok(()) };
    if !matches!(doc.live(*parent), Some(Record::Scene(_))) {
        return Err(Reject::NoSuchScene);
    }
    let mut at = Some(*parent);
    let mut steps = 0;
    while let Some(p) = at {
        if p == id {
            return Err(Reject::SceneCycle);
        }
        steps += 1;
        if steps > LIMITS.max_records {
            return Err(Reject::SceneCycle); // a loop that doesn't pass through `id`: refuse too
        }
        at = match doc.get(p).map(|e| &e.record) {
            Some(Record::Scene(s)) => s.parent,
            _ => None,
        };
    }
    Ok(())
}

pub(crate) fn apply_op(doc: &mut Doc, op: &Op) -> Result<OpOutcome, Reject> {
    match op {
        Op::Create { id, record } => {
            if doc.get(*id).is_some() {
                return Err(Reject::IdTaken); // live or tombstoned: ids are never reused
            }
            if doc.len() >= LIMITS.max_records {
                return Err(Reject::TooManyRecords);
            }
            check_record(doc, record)?;
            doc.insert(*id, record.clone());
            Ok(OpOutcome::Applied)
        }
        Op::Set { id, value } => {
            check_value(value)?;
            check_parent(doc, *id, value)?;
            let entry = doc.entry_mut(*id).ok_or(Reject::NoSuchRecord)?;
            if entry.record.get(value.field()).is_none() {
                return Err(Reject::WrongField);
            }
            if entry.deleted {
                return Ok(OpOutcome::Skipped);
            }
            entry.record.set(value.clone());
            Ok(OpOutcome::Applied)
        }
        Op::SetIf { id, expect, value } => {
            if expect.field() != value.field() {
                return Err(Reject::MismatchedSetIf);
            }
            check_value(value)?;
            let entry = doc.get(*id).ok_or(Reject::NoSuchRecord)?;
            let current = entry.record.get(value.field()).ok_or(Reject::WrongField)?;
            // A SetIf whose expectation fails is skipped before the board-level checks: an undo
            // that no longer applies must not be refused for what it would have written.
            if entry.deleted || current != *expect {
                return Ok(OpOutcome::Skipped);
            }
            check_parent(doc, *id, value)?;
            let entry = doc.entry_mut(*id).ok_or(Reject::NoSuchRecord)?;
            entry.record.set(value.clone());
            Ok(OpOutcome::Applied)
        }
        Op::Delete { id } => {
            let entry = doc.entry_mut(*id).ok_or(Reject::NoSuchRecord)?;
            match entry.record.kind() {
                // Player states live and die with their scene.
                RecordKind::BoardMeta | RecordKind::RosterSlot | RecordKind::PlayerState => Err(Reject::Immutable),
                _ if entry.deleted => Ok(OpOutcome::Skipped),
                _ => {
                    entry.deleted = true;
                    Ok(OpOutcome::Applied)
                }
            }
        }
        Op::Restore { id } => {
            let entry = doc.entry_mut(*id).ok_or(Reject::NoSuchRecord)?;
            if !entry.deleted {
                return Ok(OpOutcome::Skipped);
            }
            entry.deleted = false;
            Ok(OpOutcome::Applied)
        }
    }
}

/// Whole-board invariants, checked after every transaction.
#[allow(clippy::collapsible_match)] // one arm per record kind reads better here
pub(crate) fn check_invariants(doc: &Doc) -> Result<(), Reject> {
    let mut scenes = BTreeSet::new();
    let mut slots = BTreeSet::new();
    let (mut metas, mut amber, mut sapphire) = (0, 0, 0);
    for (id, r) in doc.iter_live() {
        match r {
            Record::BoardMeta(_) => metas += 1,
            Record::RosterSlot(s) => {
                slots.insert(id);
                match s.team {
                    crate::Team::Amber => amber += 1,
                    crate::Team::Sapphire => sapphire += 1,
                }
            }
            Record::Scene(_) => {
                scenes.insert(id);
            }
            _ => {}
        }
    }
    let full_team = usize::from(SLOTS_PER_TEAM);
    if metas != 1 || amber != full_team || sapphire != full_team {
        return Err(Reject::Immutable);
    }
    if scenes.is_empty() {
        return Err(Reject::LastScene);
    }
    if scenes.len() > LIMITS.max_scenes {
        return Err(Reject::TooManyScenes);
    }
    // Each live scene: exactly one player state per slot, at most one note, at most one state
    // per objective key.
    let mut players: BTreeMap<RecordId, BTreeSet<RecordId>> = BTreeMap::new();
    let mut notes = BTreeSet::new();
    let mut objectives = BTreeSet::new();
    let mut waves = BTreeSet::new();
    for (_, entry) in doc.iter() {
        let Some(scene) = entry.record.scene() else { continue };
        // Children of a deleted scene are hidden with it, but keep their structure for Restore.
        match &entry.record {
            Record::PlayerState(p) => {
                if !players.entry(scene).or_default().insert(p.slot) {
                    return Err(Reject::Duplicate);
                }
            }
            Record::Note(_) if !entry.deleted => {
                if !notes.insert(scene) {
                    return Err(Reject::Duplicate);
                }
            }
            Record::ObjectiveState(o) if !entry.deleted => {
                if !objectives.insert((scene, o.key.clone())) {
                    return Err(Reject::Duplicate);
                }
            }
            Record::Wave(w) if !entry.deleted => {
                if !waves.insert((scene, w.lane.clone())) {
                    return Err(Reject::Duplicate);
                }
            }
            _ => {}
        }
    }
    for scene in &scenes {
        if players.get(scene) != Some(&slots) {
            return Err(Reject::IncompleteScene);
        }
    }
    Ok(())
}
