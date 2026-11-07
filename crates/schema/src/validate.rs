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
    /// World coordinates are clamped to ±this (the map radius is ~10,752 units).
    pub max_coord: i32,
}

pub const LIMITS: Limits = Limits {
    max_ops_per_tx: 256,
    max_records: 5000,
    max_scenes: 64,
    max_name: 24,
    max_title: 80,
    max_callout: 80,
    max_note: 4000,
    max_coord: 16384,
};

/// Why a transaction was refused. Typed so the client can explain it and tests can assert it.
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
    #[error("this link can only view")]
    Forbidden,
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
        V::RosterHero(_) | V::PlayerAlive(_) | V::PlayerPlaced(_) | V::ObjectiveStatus(_) | V::ArrowTeam(_) => Ok(()),
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
            if s.order.is_valid() { Ok(()) } else { Err(Reject::BadOrderKey) }
        }
        Record::PlayerState(p) => {
            if !live_scene(p.scene) {
                return Err(Reject::NoSuchScene);
            }
            if !matches!(doc.live(p.slot), Some(Record::RosterSlot(_))) {
                return Err(Reject::NoSuchSlot);
            }
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
            check_pos(a.from)?;
            check_pos(a.to)
        }
        Record::Callout(c) => {
            if !live_scene(c.scene) {
                return Err(Reject::NoSuchScene);
            }
            check_text(&c.text, LIMITS.max_callout)?;
            check_pos(c.pos)
        }
        Record::Note(n) => {
            if !live_scene(n.scene) {
                return Err(Reject::NoSuchScene);
            }
            check_text(&n.text, LIMITS.max_note)
        }
    }
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
            let entry = doc.entry_mut(*id).ok_or(Reject::NoSuchRecord)?;
            let current = entry.record.get(value.field()).ok_or(Reject::WrongField)?;
            if entry.deleted || current != *expect {
                return Ok(OpOutcome::Skipped);
            }
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
