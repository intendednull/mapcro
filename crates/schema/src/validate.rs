//! The board's rules. Every op is checked here before it touches the document, on both the
//! server and the client, so an invalid board cannot be built through the public API.

use crate::doc::{Doc, DocKind};
use crate::ids::RecordId;
use crate::map_state::Entity;
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
    /// A share link's label (the server's, not the document's).
    pub max_label: usize,
    pub max_stroke_points: usize,
    /// World coordinates are clamped to ±this (the map radius is ~10,752 units).
    pub max_coord: i32,
    /// A transaction's JSON encoding, in bytes. Twice the largest single op (an undo of a full
    /// note carries the note twice, about 32 KB), so any one legal op always fits, and the
    /// server's frame cap follows from this (security review 2026-11-07, C1).
    pub max_tx_bytes: usize,
    /// `Tab` records in one session, removed ones included (they are kept as tombstones):
    /// "no hard limit" in practice, and a bound on what one edit link can make the server hold
    /// (sessions spec §2.2, decided §12).
    pub max_tabs: usize,
    /// One record's `more` (its registry values, `map_state.rs`) as JSON, in bytes. Under a
    /// full stroke's 12.8 KB, so the largest document as JSON is still 5,000 strokes (what the
    /// store's decode limit and the snapshot cap are sized by). A scene is created with its
    /// twelve heroes and its `SceneState` in one transaction, so what binds a full save is
    /// `max_tx_bytes`; this bounds one record (map-state spec §4.4).
    pub max_more_bytes: usize,
    /// The list entries one record's `more` can hold: each entity's `Ints` rows, all full, sum
    /// to at most this (a test on the registry). It bounds a record's heap, 8 bytes an entry,
    /// which a room's memory budget counts (`Doc::approx_heap_bytes`).
    pub max_more_ints: usize,
}

impl Limits {
    /// An upper bound on one op's JSON encoding, from the other limits: the worst case is a
    /// `SetIf` that carries its value twice, on a note's text (each char up to 4 bytes of UTF-8)
    /// or on a registry value (each at most a whole `more`). (A full stroke is smaller: 512
    /// points of at most 25 bytes; so is a record created with a full `more`.) The 512 covers
    /// the op's framing, ids and field names. A test builds these ops and checks the bound holds.
    pub const fn max_op_bytes(&self) -> usize {
        let text = 2 * 4 * self.max_note;
        let stroke = self.max_stroke_points * 25;
        let more = 2 * self.max_more_bytes;
        let largest = if text > stroke { text } else { stroke };
        (if largest > more { largest } else { more }) + 512
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
    max_label: 40,
    max_stroke_points: 512,
    max_coord: 16384,
    max_tx_bytes: 64 * 1024,
    max_tabs: 2000,
    max_more_bytes: 8 * 1024,
    max_more_ints: 1280,
};

// Every legal op fits in a transaction on its own.
const _: () = assert!(LIMITS.max_op_bytes() <= LIMITS.max_tx_bytes);
// A record with a full `more` is smaller than a full stroke, so the largest document as JSON is
// still one of strokes: the store's decode limit and the snapshot cap are sized by it.
const _: () = assert!(LIMITS.max_more_bytes + 512 < LIMITS.max_stroke_points * 25);

impl Limits {
    /// These limits as a TypeScript module, `web/src/gen/limits.ts` (`just ts` writes it), so
    /// every text input caps itself at what the server accepts (QA 2026-11-08: a scene rename
    /// took 64 characters against 24, and the server dropped it as "Text too long").
    pub fn to_ts(&self) -> String {
        let fields = [
            ("max_ops_per_tx", self.max_ops_per_tx),
            ("max_records", self.max_records),
            ("max_scenes", self.max_scenes),
            ("max_name", self.max_name),
            ("max_title", self.max_title),
            ("max_callout", self.max_callout),
            ("max_note", self.max_note),
            ("max_label", self.max_label),
            ("max_stroke_points", self.max_stroke_points),
            ("max_tx_bytes", self.max_tx_bytes),
            ("max_tabs", self.max_tabs),
            ("max_more_bytes", self.max_more_bytes),
            ("max_more_ints", self.max_more_ints),
        ];
        let mut out = String::from("// Generated from crates/schema/src/validate.rs `LIMITS` by `just ts`. Do not edit.\n\n/** The schema's limits, in characters (Unicode scalar values) where they're text. */\nexport const LIMITS = {\n");
        for (k, v) in fields {
            out.push_str(&format!("  {k}: {v},\n"));
        }
        out.push_str(&format!("  max_coord: {},\n}} as const;\n", self.max_coord));
        out
    }
}

#[cfg(test)]
mod limits_ts {
    use super::LIMITS;
    const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/src/gen/limits.ts");

    #[cfg(feature = "ts")]
    #[test]
    fn export_bindings_limits() {
        std::fs::create_dir_all(std::path::Path::new(PATH).parent().expect("dir")).expect("gen dir");
        std::fs::write(PATH, LIMITS.to_ts()).expect("write limits.ts");
    }

    #[cfg(not(feature = "ts"))]
    #[test]
    fn the_web_client_has_these_limits() {
        assert_eq!(std::fs::read_to_string(PATH).expect("web/src/gen/limits.ts"), LIMITS.to_ts(), "stale: run `just ts`");
    }
}

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
    /// A session's record in a board, or a board's in a session (sessions spec §2.2).
    #[error("this record does not belong in this kind of document")]
    WrongDocKind,
    /// The session holds `Limits::max_tabs` tabs, removed ones included.
    #[error("session full")]
    SessionFull,
}

pub(crate) fn check_text(s: &str, max: usize) -> Result<(), Reject> {
    if s.chars().count() > max {
        return Err(Reject::TextTooLong);
    }
    // Newlines are fine in notes; other control characters are not.
    if s.chars().any(|c| c.is_control() && c != '\n') {
        return Err(Reject::BadText);
    }
    Ok(())
}

/// One line of text: a board's title. No control characters at all, newlines included, as
/// creation, clone and import (file.rs) ask.
pub(crate) fn check_line(s: &str, max: usize) -> Result<(), Reject> {
    check_text(s, max)?;
    if s.contains('\n') {
        return Err(Reject::BadText);
    }
    Ok(())
}

pub(crate) fn check_pos(p: WorldPos) -> Result<(), Reject> {
    let m = LIMITS.max_coord;
    if (-m..=m).contains(&p.x) && (-m..=m).contains(&p.y) { Ok(()) } else { Err(Reject::OutOfBounds) }
}

fn check_value(v: &FieldValue) -> Result<(), Reject> {
    use FieldValue as V;
    match v {
        V::Title(s) | V::SessionTitle(s) => check_line(s, LIMITS.max_title),
        V::TabName(s) => check_line(s, LIMITS.max_name),
        V::TabOrder(k) => if k.is_valid() { Ok(()) } else { Err(Reject::BadOrderKey) },
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
        // A registry value is checked against its row; clearing one needs no check.
        V::More { key, value } => value.as_ref().map_or(Ok(()), |v| v.check(key.row())),
        V::RosterHero(_) | V::PlayerAlive(_) | V::PlayerPlaced(_) | V::PlayerVisible(_) | V::ObjectiveStatus(_) | V::ArrowTeam(_) | V::SceneParent(_) => Ok(()),
    }
}

/// Field-level checks for a whole record, as created.
fn check_record(doc: &Doc, r: &Record) -> Result<(), Reject> {
    let live_scene = |id: RecordId| matches!(doc.live(id), Some(Record::Scene(_)));
    // A session's genesis record is never created by an edit, in either kind of document.
    if matches!(r, Record::SessionMeta(_)) {
        return Err(Reject::Immutable);
    }
    // Each kind of document holds only its own kinds of record (sessions spec §2.2).
    if r.kind().is_session() != (doc.kind() == DocKind::Session) {
        return Err(Reject::WrongDocKind);
    }
    match r {
        // Board metadata and the roster exist from genesis and are never created by an edit.
        Record::BoardMeta(_) | Record::RosterSlot(_) | Record::SessionMeta(_) => Err(Reject::Immutable),
        Record::Tab(t) => {
            // Shape only: whether the board and grant exist is the server's question, asked on
            // open (sessions spec §3.4); a made-up one is a tab that reads "No access".
            if !t.board.is_valid() || !t.grant.is_valid() {
                return Err(Reject::BadText);
            }
            check_line(&t.name, LIMITS.max_name)?;
            if t.order.is_valid() { Ok(()) } else { Err(Reject::BadOrderKey) }
        }
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
            p.more.check(Entity::Hero)?;
            check_pos(p.pos)
        }
        Record::ObjectiveState(o) => {
            if !live_scene(o.scene) {
                return Err(Reject::NoSuchScene);
            }
            o.more.check(Entity::Marker)?;
            if o.key.is_valid() { Ok(()) } else { Err(Reject::BadObjectiveKey) }
        }
        Record::SceneState(s) => {
            if !live_scene(s.scene) {
                return Err(Reject::NoSuchScene);
            }
            s.more.check(Entity::Scene)
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
            w.more.check(Entity::Lane)?;
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

/// A registry value about to be written to `record`: the record's `more` must still be within
/// `max_more_bytes` with it. (The value itself is already checked against its row.) Counted on
/// a copy, before anything is written; clearing a key can only shrink the map.
fn check_more_fits(record: &Record, value: &FieldValue) -> Result<(), Reject> {
    let FieldValue::More { key, value: Some(v) } = value else { return Ok(()) };
    let Some((_, more)) = record.more() else { return Ok(()) };
    let mut with = more.clone();
    with.put(*key, Some(v.clone()));
    with.check_size()
}

/// `unfit_skips`: what a `SetIf` on a registry value does when its expectation holds and the
/// record has no room for the value. Skipped (`true`) everywhere but at admission by a build
/// that doesn't admit it yet (`Admit::unfit_undo`), where it is refused as before.
pub(crate) fn apply_op(doc: &mut Doc, op: &Op, unfit_skips: bool) -> Result<OpOutcome, Reject> {
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
            check_more_fits(&entry.record, value)?;
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
            // Nor for the room it no longer has (review F4): someone cleared a list, others
            // filled the record's `more` since, and the undo that puts the list back is skipped
            // like one whose expectation failed, not refused with the rest of its transaction.
            // A plain `Set` that doesn't fit is still refused: its writer can see the record.
            if let Err(full) = check_more_fits(&entry.record, value) {
                return if unfit_skips { Ok(OpOutcome::Skipped) } else { Err(full) };
            }
            entry.record.set(value.clone());
            Ok(OpOutcome::Applied)
        }
        Op::Delete { id } => {
            let entry = doc.entry_mut(*id).ok_or(Reject::NoSuchRecord)?;
            match entry.record.kind() {
                // Player states live and die with their scene.
                RecordKind::BoardMeta | RecordKind::RosterSlot | RecordKind::PlayerState | RecordKind::SessionMeta => Err(Reject::Immutable),
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
    if doc.kind() == DocKind::Session {
        return check_session(doc);
    }
    if doc.iter().any(|(_, e)| e.record.kind().is_session()) {
        return Err(Reject::WrongDocKind);
    }
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
    // per objective key, one wave per lane, and one scene state.
    let mut players: BTreeMap<RecordId, BTreeSet<RecordId>> = BTreeMap::new();
    let mut notes = BTreeSet::new();
    let mut objectives = BTreeSet::new();
    let mut waves = BTreeSet::new();
    let mut states = BTreeSet::new();
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
            Record::SceneState(_) if !entry.deleted => {
                if !states.insert(scene) {
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

/// A session's invariants: exactly one live `SessionMeta`, only session records, and at most
/// `max_tabs` tabs, removed ones included.
fn check_session(doc: &Doc) -> Result<(), Reject> {
    let (mut metas, mut tabs) = (0, 0);
    for (_, e) in doc.iter() {
        match &e.record {
            Record::SessionMeta(_) if !e.deleted => metas += 1,
            Record::SessionMeta(_) => {}
            Record::Tab(_) => tabs += 1,
            _ => return Err(Reject::WrongDocKind),
        }
    }
    if metas != 1 {
        return Err(Reject::Immutable);
    }
    if tabs > LIMITS.max_tabs {
        return Err(Reject::SessionFull);
    }
    Ok(())
}

#[cfg(test)]
mod sessions {
    use crate::{
        BoardId, ClientId, DocKind, FieldValue, GrantId, Op, OrderKey, Record, RecordId, Reject, SessionMeta, Tab, Tx, TxKind,
        apply_tx, genesis, session_genesis, validate_doc, LIMITS,
    };

    fn ids(from: u128) -> impl FnMut() -> RecordId {
        let mut n = from;
        move || {
            n += 1;
            RecordId(n)
        }
    }

    fn tab(name: &str) -> Record {
        Record::Tab(Tab { board: BoardId("b".repeat(22)), grant: GrantId("g".repeat(22)), name: name.into(), order: OrderKey::first() })
    }

    fn tx(ops: Vec<Op>) -> Tx {
        Tx { client: ClientId(1), cseq: 0, kind: TxKind::Edit, ops }
    }

    fn session() -> crate::Doc {
        session_genesis(ids(0), "Scrims", &[(BoardId("a".repeat(22)), GrantId("c".repeat(22)), "Game 1".into())])
    }

    #[test]
    fn a_session_is_known_by_its_genesis_and_keeps_its_kind_through_json() {
        let s = session();
        assert_eq!(s.kind(), DocKind::Session);
        validate_doc(&s).expect("a fresh session is valid");
        let back: crate::Doc = serde_json::from_str(&serde_json::to_string(&s).expect("json")).expect("doc");
        assert_eq!(back.kind(), DocKind::Session);
        assert_eq!(back, s);
        assert_eq!(genesis(ids(100), "b").kind(), DocKind::Board);
    }

    #[test]
    fn tabs_are_added_renamed_reordered_removed_and_restored() {
        let mut s = session();
        let t = RecordId(50);
        apply_tx(&mut s, &tx(vec![Op::Create { id: t, record: tab("Game 2") }])).expect("add");
        apply_tx(&mut s, &tx(vec![Op::Set { id: t, value: FieldValue::TabName("Final".into()) }])).expect("rename");
        apply_tx(&mut s, &tx(vec![Op::Set { id: t, value: FieldValue::TabOrder(OrderKey("a".into())) }])).expect("reorder");
        apply_tx(&mut s, &tx(vec![Op::Delete { id: t }])).expect("remove");
        assert!(s.live(t).is_none());
        apply_tx(&mut s, &tx(vec![Op::Restore { id: t }])).expect("undo restores");
        let Some(Record::Tab(back)) = s.live(t) else { panic!("tab back") };
        assert_eq!((back.name.as_str(), back.board.0.as_str(), back.grant.0.as_str()), ("Final", "b".repeat(22).as_str(), "g".repeat(22).as_str()));
        let meta = s.iter_live().find(|(_, r)| matches!(r, Record::SessionMeta(_))).map(|(id, _)| id).expect("meta");
        apply_tx(&mut s, &tx(vec![Op::Set { id: meta, value: FieldValue::SessionTitle("Block B".into()) }])).expect("retitle");
    }

    #[test]
    fn each_kind_of_document_refuses_the_others_records() {
        let mut board = genesis(ids(0), "b");
        let scene = board.iter_live().find(|(_, r)| matches!(r, Record::Scene(_))).map(|(id, _)| id).expect("scene");
        assert_eq!(apply_tx(&mut board, &tx(vec![Op::Create { id: RecordId(900), record: tab("x") }])), Err(Reject::WrongDocKind));
        let meta = Record::SessionMeta(SessionMeta { title: "s".into(), version: 1 });
        assert_eq!(apply_tx(&mut board, &tx(vec![Op::Create { id: RecordId(901), record: meta.clone() }])), Err(Reject::Immutable));
        assert_eq!(board.kind(), DocKind::Board, "a refused SessionMeta leaves a board a board");

        let mut s = session();
        let note = Record::Note(crate::Note { scene, text: "n".into() });
        let stroke = Record::Stroke(crate::Stroke { scene, points: vec![Default::default(); 2], color: 0, width: 10, offset: Default::default() });
        let scene_rec = Record::Scene(crate::Scene { name: String::new(), order: OrderKey::first(), clock: None, source: None, live: false, parent: None });
        for r in [note, stroke, scene_rec] {
            assert_eq!(apply_tx(&mut s, &tx(vec![Op::Create { id: RecordId(902), record: r }])), Err(Reject::WrongDocKind));
        }
        assert_eq!(apply_tx(&mut s, &tx(vec![Op::Create { id: RecordId(903), record: meta }])), Err(Reject::Immutable));
        let smeta = s.iter_live().find(|(_, r)| matches!(r, Record::SessionMeta(_))).map(|(id, _)| id).expect("meta");
        assert_eq!(apply_tx(&mut s, &tx(vec![Op::Delete { id: smeta }])), Err(Reject::Immutable));
        // A board's field on a session's record, and the other way round.
        assert_eq!(apply_tx(&mut s, &tx(vec![Op::Set { id: smeta, value: FieldValue::Title("t".into()) }])), Err(Reject::WrongField));
        let bmeta = board.iter_live().find(|(_, r)| matches!(r, Record::BoardMeta(_))).map(|(id, _)| id).expect("meta");
        assert_eq!(apply_tx(&mut board, &tx(vec![Op::Set { id: bmeta, value: FieldValue::SessionTitle("t".into()) }])), Err(Reject::WrongField));
    }

    #[test]
    fn a_tab_is_checked_for_shape() {
        let mut s = session();
        let bad_board = Record::Tab(Tab { board: BoardId("short".into()), grant: GrantId("g".repeat(22)), name: "x".into(), order: OrderKey::first() });
        let bad_grant = Record::Tab(Tab { board: BoardId("b".repeat(22)), grant: GrantId("g/".repeat(11)), name: "x".into(), order: OrderKey::first() });
        let long = Record::Tab(Tab { board: BoardId("b".repeat(22)), grant: GrantId("g".repeat(22)), name: "n".repeat(LIMITS.max_name + 1), order: OrderKey::first() });
        let bad_order = Record::Tab(Tab { board: BoardId("b".repeat(22)), grant: GrantId("g".repeat(22)), name: "x".into(), order: OrderKey("i0".into()) });
        assert_eq!(apply_tx(&mut s, &tx(vec![Op::Create { id: RecordId(60), record: bad_board }])), Err(Reject::BadText));
        assert_eq!(apply_tx(&mut s, &tx(vec![Op::Create { id: RecordId(60), record: bad_grant }])), Err(Reject::BadText));
        assert_eq!(apply_tx(&mut s, &tx(vec![Op::Create { id: RecordId(60), record: long }])), Err(Reject::TextTooLong));
        assert_eq!(apply_tx(&mut s, &tx(vec![Op::Create { id: RecordId(60), record: bad_order }])), Err(Reject::BadOrderKey));
        assert_eq!(apply_tx(&mut s, &tx(vec![Op::Create { id: RecordId(60), record: tab("a\nb") }])), Err(Reject::BadText));
    }

    #[test]
    fn a_session_holds_at_most_max_tabs_removed_ones_included() {
        let mut s = session(); // one tab already
        let mut next = 1000u128;
        let mut created = Vec::new();
        while created.len() + 1 < LIMITS.max_tabs {
            let n = (LIMITS.max_tabs - 1 - created.len()).min(LIMITS.max_ops_per_tx);
            let ops: Vec<Op> = (0..n)
                .map(|_| {
                    next += 1;
                    created.push(RecordId(next));
                    Op::Create { id: RecordId(next), record: tab("t") }
                })
                .collect();
            apply_tx(&mut s, &tx(ops)).expect("under the cap");
        }
        // Removing tabs doesn't make room: tombstones count.
        apply_tx(&mut s, &tx(created[..10].iter().map(|id| Op::Delete { id: *id }).collect())).expect("remove");
        assert_eq!(apply_tx(&mut s, &tx(vec![Op::Create { id: RecordId(999_999), record: tab("one more") }])), Err(Reject::SessionFull));
    }
}
