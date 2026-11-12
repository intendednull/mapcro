//! A board as a file (`.mapcro.json`, spec §6): the records an export writes and the checks an
//! import passes them through. The file's envelope (header, version, migrations) is the
//! server's (`crates/server/src/boardfile.rs`); this is the part that needs the schema's own
//! rules.
//!
//! An export is the board as it reads: live records only. A deleted record, and everything in a
//! deleted scene, is history (undo's), not content, and someone who deleted it expects it gone.
//!
//! An import is untrusted. Every record goes through the same checks an edit's `Create` does,
//! plus the checks genesis makes true for the records no edit creates (the board's title and
//! the roster), and then the whole-board invariants. Every id is replaced by a fresh one, so a
//! file chooses none of the new board's ids.

use crate::doc::Doc;
use crate::ids::RecordId;
use crate::records::{Record, SLOTS_PER_TEAM};
use crate::validate::{self, LIMITS, Reject};
use crate::Op;
use std::collections::{BTreeMap, BTreeSet};

/// The board's live records, as a file holds them. A live scene under a deleted one is listed
/// under its nearest live ancestor, as the board shows it.
pub fn export_records(doc: &Doc) -> Vec<(RecordId, Record)> {
    let live_scene = |id: RecordId| matches!(doc.live(id), Some(Record::Scene(_)));
    doc.iter_live()
        .filter(|(_, r)| r.scene().is_none_or(live_scene))
        .map(|(id, r)| {
            let mut r = r.clone();
            if let Record::Scene(s) = &mut r {
                s.parent = live_ancestor(doc, s.parent);
            }
            (id, r)
        })
        .collect()
}

/// `parent`, or the first live scene above it (deleted scenes keep their own parent).
fn live_ancestor(doc: &Doc, parent: Option<RecordId>) -> Option<RecordId> {
    let mut at = parent;
    for _ in 0..=LIMITS.max_records {
        let p = at?;
        match doc.get(p).map(|e| (&e.record, e.deleted)) {
            Some((Record::Scene(_), false)) => return Some(p),
            Some((Record::Scene(s), true)) => at = s.parent,
            _ => return None,
        }
    }
    None
}

/// Build a new board from a file's records, under fresh ids from `next_id`, or say why not.
/// Nothing partial: the board is whole and valid, or there is no board.
pub fn import_records(records: Vec<(RecordId, Record)>, mut next_id: impl FnMut() -> RecordId) -> Result<Doc, Reject> {
    if records.len() > LIMITS.max_records {
        return Err(Reject::TooManyRecords);
    }
    if records.iter().filter(|(_, r)| matches!(r, Record::Scene(_))).count() > LIMITS.max_scenes {
        return Err(Reject::TooManyScenes);
    }
    // Fresh ids, one per record; an id the file uses twice is refused.
    let mut fresh: BTreeMap<RecordId, RecordId> = BTreeMap::new();
    let mut used = BTreeSet::new();
    for (old, _) in &records {
        let new = (0..8).map(|_| next_id()).find(|id| !used.contains(id)).ok_or(Reject::IdTaken)?;
        used.insert(new);
        if fresh.insert(*old, new).is_some() {
            return Err(Reject::IdTaken);
        }
    }
    let mut meta_roster = Vec::new();
    let mut scenes = Vec::new();
    let mut rest = Vec::new();
    for (old, mut r) in records {
        let id = fresh[&old];
        if let Some(scene) = r.scene_mut() {
            *scene = *fresh.get(scene).ok_or(Reject::NoSuchScene)?;
        }
        match &mut r {
            Record::PlayerState(p) => p.slot = *fresh.get(&p.slot).ok_or(Reject::NoSuchSlot)?,
            Record::Scene(s) => {
                if let Some(p) = s.parent {
                    s.parent = Some(*fresh.get(&p).ok_or(Reject::NoSuchScene)?);
                }
            }
            _ => {}
        }
        match r {
            Record::BoardMeta(_) | Record::RosterSlot(_) => meta_roster.push((id, r)),
            Record::Scene(_) => scenes.push((id, r)),
            _ => rest.push((id, r)),
        }
    }

    let mut doc = Doc::default();
    // The title and the roster: genesis makes them, so no edit's checks cover them.
    let mut seats = BTreeSet::new();
    for (id, r) in meta_roster {
        match &r {
            // A title is one line: no control characters at all, newlines included.
            Record::BoardMeta(m) => {
                validate::check_text(&m.title, LIMITS.max_title)?;
                if m.title.contains('\n') {
                    return Err(Reject::BadText);
                }
            }
            Record::RosterSlot(s) => {
                validate::check_text(&s.name, LIMITS.max_name)?;
                if s.slot >= SLOTS_PER_TEAM {
                    return Err(Reject::OutOfBounds);
                }
                if !seats.insert((s.team, s.slot)) {
                    return Err(Reject::Duplicate);
                }
            }
            _ => unreachable!("sorted above"),
        }
        doc.insert(id, r);
    }
    // Scenes, each after its parent (a `Create` needs the parent live). One that never gets
    // its turn is in a loop, or under something that isn't a scene.
    while !scenes.is_empty() {
        let before = scenes.len();
        let mut waiting = Vec::new();
        for (id, r) in scenes {
            let ready = match &r {
                Record::Scene(s) => s.parent.is_none_or(|p| doc.live(p).is_some()),
                _ => true,
            };
            if ready {
                validate::apply_op(&mut doc, &Op::Create { id, record: r })?;
            } else {
                waiting.push((id, r));
            }
        }
        if waiting.len() == before {
            return Err(Reject::SceneCycle);
        }
        scenes = waiting;
    }
    for (id, r) in rest {
        validate::apply_op(&mut doc, &Op::Create { id, record: r })?;
    }
    validate::check_invariants(&doc)?;
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::{BoardMeta, Callout, Note, PlayerState, Scene, Stroke, WorldPos};
    use crate::{OrderKey, Tx, TxKind, apply_tx, genesis};

    fn counter(start: u128) -> impl FnMut() -> RecordId {
        let mut n = start;
        move || {
            n += 1;
            RecordId(n)
        }
    }

    fn board() -> Doc {
        genesis(counter(0), "Scrim prep")
    }

    fn scene_of(doc: &Doc) -> RecordId {
        doc.iter_live().find(|(_, r)| matches!(r, Record::Scene(_))).map(|(id, _)| id).expect("scene")
    }

    fn edit(doc: &mut Doc, ops: Vec<Op>) {
        apply_tx(doc, &Tx { client: crate::ClientId(1), cseq: 0, kind: TxKind::Edit, ops }).expect("valid edit");
    }

    fn scene(name: &str, parent: Option<RecordId>) -> Record {
        Record::Scene(Scene { name: name.into(), order: OrderKey::first(), clock: None, source: None, live: false, parent })
    }

    /// Create a scene `id` with its twelve players (ids from `id * 100`), as the client does.
    fn new_scene(doc: &Doc, id: u128, name: &str, parent: Option<RecordId>) -> Vec<Op> {
        let mut ops = vec![Op::Create { id: RecordId(id), record: scene(name, parent) }];
        let slots: Vec<_> = doc
            .iter_live()
            .filter_map(|(sid, r)| match r {
                Record::RosterSlot(s) => Some((sid, s.team, s.slot)),
                _ => None,
            })
            .collect();
        for (i, (sid, team, slot)) in slots.into_iter().enumerate() {
            ops.push(Op::Create { id: RecordId(id * 100 + i as u128), record: Record::PlayerState(PlayerState::starting(RecordId(id), sid, team, slot)) });
        }
        ops
    }

    /// The same records with every id moved through `map`, for comparing an import with its file.
    fn renamed(records: &[(RecordId, Record)], map: &BTreeMap<RecordId, RecordId>) -> Vec<(RecordId, Record)> {
        let mut out: Vec<_> = records
            .iter()
            .map(|(id, r)| {
                let mut r = r.clone();
                if let Some(s) = r.scene_mut() {
                    *s = map[s];
                }
                match &mut r {
                    Record::PlayerState(p) => p.slot = map[&p.slot],
                    Record::Scene(s) => s.parent = s.parent.map(|p| map[&p]),
                    _ => {}
                }
                (map[id], r)
            })
            .collect();
        out.sort_by_key(|(id, _)| *id);
        out
    }

    #[test]
    fn an_import_is_the_export_under_fresh_ids() {
        let mut doc = board();
        let s = scene_of(&doc);
        let ops = new_scene(&doc, 500, "Rotate", Some(s));
        edit(&mut doc, ops);
        edit(&mut doc, vec![
            Op::Create { id: RecordId(501), record: Record::Note(Note { scene: s, text: "push mid\nthen rotate".into() }) },
            Op::Create { id: RecordId(502), record: Record::Callout(Callout { scene: s, pos: WorldPos { x: 10, y: -20 }, text: "here".into(), color: Some(3) }) },
            Op::Create {
                id: RecordId(503),
                record: Record::Stroke(Stroke { scene: RecordId(500), points: vec![WorldPos { x: 0, y: 0 }, WorldPos { x: 5, y: 9 }], color: 2, width: 20, offset: WorldPos { x: 1, y: 1 } }),
            },
        ]);
        let file = export_records(&doc);
        let imported = import_records(file.clone(), counter(10_000)).expect("imports");
        // Fresh ids are handed out in the file's order.
        let map: BTreeMap<_, _> = file.iter().enumerate().map(|(i, (id, _))| (*id, RecordId(10_001 + i as u128))).collect();
        assert_eq!(export_records(&imported), renamed(&file, &map));
        assert!(imported.iter().all(|(id, _)| id.0 > 10_000), "no id is the file's");
    }

    #[test]
    fn an_export_leaves_out_what_was_deleted() {
        let mut doc = board();
        let s = scene_of(&doc);
        let ops = new_scene(&doc, 500, "Gone", Some(s));
        edit(&mut doc, ops);
        let ops = new_scene(&doc, 501, "Kept", Some(RecordId(500)));
        edit(&mut doc, ops);
        edit(&mut doc, vec![
            Op::Create { id: RecordId(502), record: Record::Note(Note { scene: RecordId(500), text: "secret plan".into() }) },
            Op::Create { id: RecordId(503), record: Record::Callout(Callout { scene: s, pos: WorldPos::default(), text: "erased".into(), color: None }) },
        ]);
        edit(&mut doc, vec![Op::Delete { id: RecordId(500) }, Op::Delete { id: RecordId(503) }]);
        let file = export_records(&doc);
        assert!(file.iter().all(|(id, _)| ![RecordId(500), RecordId(502), RecordId(503)].contains(id)), "{file:?}");
        // The scene under the deleted one moves up to where the board shows it.
        assert!(file.iter().any(|(id, r)| *id == RecordId(501) && matches!(r, Record::Scene(sc) if sc.parent == Some(s))));
        import_records(file, counter(10_000)).expect("still a whole board");
    }

    fn with(mut file: Vec<(RecordId, Record)>, f: impl FnOnce(&mut Vec<(RecordId, Record)>)) -> Vec<(RecordId, Record)> {
        f(&mut file);
        file
    }

    fn title_of(file: &mut [(RecordId, Record)]) -> &mut String {
        file.iter_mut()
            .find_map(|(_, r)| match r {
                Record::BoardMeta(m) => Some(&mut m.title),
                _ => None,
            })
            .expect("meta")
    }

    #[test]
    fn bad_files_are_refused_whole() {
        let file = export_records(&board());
        let s = scene_of(&board());
        let refuse = |f: Vec<(RecordId, Record)>| import_records(f, counter(10_000)).expect_err("refused");
        let note = |id: u128, scene: RecordId, text: String| (RecordId(id), Record::Note(Note { scene, text }));

        assert_eq!(refuse(with(file.clone(), |f| *title_of(f) = "x".repeat(LIMITS.max_title + 1))), Reject::TextTooLong);
        assert_eq!(refuse(with(file.clone(), |f| *title_of(f) = "two\nlines".into())), Reject::BadText);
        assert_eq!(refuse(with(file.clone(), |f| *title_of(f) = "bell\u{7}".into())), Reject::BadText);
        assert_eq!(refuse(with(file.clone(), |f| f.push(note(900, s, "x".repeat(LIMITS.max_note + 1))))), Reject::TextTooLong);
        // A reference to a record the file doesn't have.
        assert_eq!(refuse(with(file.clone(), |f| f.push(note(900, RecordId(77_777), "x".into())))), Reject::NoSuchScene);
        // The same id twice.
        assert_eq!(refuse(with(file.clone(), |f| f.push(note(1, s, "x".into())))), Reject::IdTaken);
        // Two titles, a missing roster seat, a seat twice, a seat out of range.
        assert_eq!(refuse(with(file.clone(), |f| f.push((RecordId(900), Record::BoardMeta(BoardMeta { title: "b".into() }))))), Reject::Immutable);
        let first_slot = |f: &mut Vec<(RecordId, Record)>| f.iter().position(|(_, r)| matches!(r, Record::RosterSlot(_))).expect("slot");
        assert_eq!(refuse(with(file.clone(), |f| {
            let i = first_slot(f);
            f.remove(i);
        })), Reject::NoSuchSlot);
        assert_eq!(
            refuse(with(file.clone(), |f| {
                let i = first_slot(f);
                if let Record::RosterSlot(r) = &mut f[i].1 {
                    r.slot = 1;
                }
            })),
            Reject::Duplicate
        );
        assert_eq!(
            refuse(with(file.clone(), |f| {
                let i = first_slot(f);
                if let Record::RosterSlot(r) = &mut f[i].1 {
                    r.slot = SLOTS_PER_TEAM;
                }
            })),
            Reject::OutOfBounds
        );
        // A stroke past the point cap; a position off the map.
        let stroke = |n: usize, x: i32| Record::Stroke(Stroke { scene: s, points: vec![WorldPos { x, y: 0 }; n], color: 0, width: 10, offset: WorldPos::default() });
        assert_eq!(refuse(with(file.clone(), |f| f.push((RecordId(900), stroke(LIMITS.max_stroke_points + 1, 0))))), Reject::BadStroke);
        assert_eq!(refuse(with(file.clone(), |f| f.push((RecordId(900), stroke(2, LIMITS.max_coord + 1))))), Reject::OutOfBounds);
        // Scenes in a loop; a scene missing its players.
        assert_eq!(
            refuse(with(file.clone(), |f| {
                f.push((RecordId(900), scene("a", Some(RecordId(901)))));
                f.push((RecordId(901), scene("b", Some(RecordId(900)))));
            })),
            Reject::SceneCycle
        );
        assert_eq!(refuse(with(file.clone(), |f| f.push((RecordId(900), scene("bare", None))))), Reject::IncompleteScene);
        // Too many records, and too many scenes, before any is looked at.
        let many: Vec<_> = (0..=LIMITS.max_records as u128).map(|i| note(1000 + i, s, String::new())).collect();
        assert_eq!(refuse(with(file.clone(), |f| f.extend(many))), Reject::TooManyRecords);
        let scenes: Vec<_> = (0..=LIMITS.max_scenes as u128).map(|i| (RecordId(1000 + i), scene("s", None))).collect();
        assert_eq!(refuse(with(file.clone(), |f| f.extend(scenes))), Reject::TooManyScenes);
        // A record no file may make twice per scene.
        assert_eq!(refuse(with(file, |f| f.extend([note(900, s, "a".into()), note(901, s, "b".into())]))), Reject::Duplicate);
    }
}
