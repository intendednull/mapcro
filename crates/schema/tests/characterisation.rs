//! Stored bytes don't move (map-state spec §9, phase 0).
//!
//! A board and a session as they are stored today, and the log of edits that built the board,
//! are committed under `tests/golden/`. Every later phase must read them and write them back
//! byte for byte: a stored document, a logged transaction and a board file all outlive the build
//! that wrote them, and a server rolled back a release reads what the newer one wrote.
//!
//! The fixtures are built here from the public API, so they hold every record kind, every op and
//! every typed field value there was on 2026-11-13, before `more` and `SceneState`: neither is in
//! them, and an empty `more` is never written, so they hold still through the map-state work. A change that
//! moves a byte fails the comparison. `MAPCRO_BLESS=1 cargo test -p mapcro-schema --test
//! characterisation` rewrites them, which is right only for a change these fixtures were never
//! meant to hold still (a new typed field with a serde default that is always written).

use mapcro_schema::{
    Arrow, BoardId, Callout, ClientId, Doc, Field, FieldValue, GrantId, HeroId, LaneKey, More, Note, ObjectiveKey, ObjectiveState,
    ObjectiveStatus, Op, OpOutcome, OrderKey, PlayerState, Record, RecordId, Scene, SceneSource, Stroke, Tab, Team, Tx, TxKind, Wave,
    WorldPos, apply_tx, apply_tx_with_inverse, export_records, genesis, session_genesis, validate_doc,
};
use std::collections::BTreeSet;
use std::path::PathBuf;

fn golden(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden").join(name)
}

/// Compare with the committed file, or write it when blessing.
fn pinned(name: &str, actual: &str) {
    let path = golden(name);
    if std::env::var_os("MAPCRO_BLESS").is_some() {
        std::fs::create_dir_all(path.parent().expect("dir")).expect("golden dir");
        std::fs::write(&path, actual).expect("write golden");
        return;
    }
    let want = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert!(want == actual, "{name} moved: stored bytes must not change (see this file's header)\n want {want}\n  got {actual}");
}

fn ids(from: u128) -> impl FnMut() -> RecordId {
    let mut n = from;
    move || {
        n += 1;
        RecordId(n)
    }
}

fn id(n: u128) -> RecordId {
    RecordId(n)
}

fn set(id: RecordId, value: FieldValue) -> Op {
    Op::Set { id, value }
}

fn pos(x: i32, y: i32) -> WorldPos {
    WorldPos { x, y }
}

/// A scene `scene` with its twelve player states (ids from `scene * 100`), as a client sends it.
fn scene_ops(doc: &Doc, scene: u128, record: Scene, player: impl Fn(usize, PlayerState) -> PlayerState) -> Vec<Op> {
    let mut ops = vec![Op::Create { id: id(scene), record: Record::Scene(record) }];
    let slots: Vec<_> = doc
        .iter_live()
        .filter_map(|(sid, r)| match r {
            Record::RosterSlot(s) => Some((sid, s.team, s.slot)),
            _ => None,
        })
        .collect();
    for (i, (sid, team, slot)) in slots.into_iter().enumerate() {
        let p = PlayerState::starting(id(scene), sid, team, slot);
        ops.push(Op::Create { id: id(scene * 100 + i as u128), record: Record::PlayerState(player(i, p)) });
    }
    ops
}

/// The edits that build the fixture board, in order. Between them they hold every op, every
/// record kind a board has, and every field value (the test below counts).
fn board_log() -> (Doc, Vec<Tx>) {
    let start = genesis(ids(0), "Scrim prep");
    let mut doc = start.clone();
    let mut log = Vec::new();
    let mut cseq = 0u64;
    // Applies one transaction; gives its cseq and the ops that undo it.
    let mut send = |doc: &mut Doc, kind: TxKind, ops: Vec<Op>| -> (u64, Vec<Op>) {
        let tx = Tx { client: ClientId(0xa11ce), cseq, kind, ops };
        cseq += 1;
        let (_, inverse) = apply_tx_with_inverse(doc, &tx).unwrap_or_else(|r| panic!("tx #{} refused: {r}", tx.cseq));
        log.push(tx);
        (cseq - 1, inverse)
    };
    let first = id(14); // genesis: meta 1, slots 2..=13, scene 14, players 15..=26
    let (slot, player) = (id(2), id(15));

    // The board and its roster.
    send(&mut doc, TxKind::Edit, vec![
        set(id(1), FieldValue::Title("Scrim prep: mid".into())),
        set(slot, FieldValue::RosterName("Solo".into())),
        set(slot, FieldValue::RosterHero(Some(HeroId(13)))),
        set(id(3), FieldValue::RosterHero(None)),
    ]);
    // A hand-made scene: every player field, objectives, a wave, ink, a note.
    send(&mut doc, TxKind::Edit, vec![
        set(first, FieldValue::SceneName("8:00 mid".into())),
        set(first, FieldValue::SceneClock(Some(480))),
        set(player, FieldValue::PlayerPos(pos(-1200, 340))),
        set(player, FieldValue::PlayerAlive(false)),
        set(player, FieldValue::PlayerRespawn(Some(42))),
        set(player, FieldValue::PlayerSouls(Some(12_345))),
        set(player, FieldValue::PlayerUltCooldown(Some(60))),
        set(id(16), FieldValue::PlayerVisible(false)),
        set(id(17), FieldValue::PlayerPlaced(false)),
    ]);
    let objective = |n: u128, scene: RecordId, key: &str, status| Op::Create {
        id: id(n),
        record: Record::ObjectiveState(ObjectiveState { scene, key: ObjectiveKey(key.into()), status, more: More::default() }),
    };
    let wave = |n: u128, scene: RecordId, lane: &str, t| Op::Create { id: id(n), record: Record::Wave(Wave { scene, lane: LaneKey(lane.into()), t, more: More::default() }) };
    send(&mut doc, TxKind::Edit, vec![
        objective(100, first, "walker:amber:lane1:1", ObjectiveStatus::Destroyed),
        objective(101, first, "patron:sapphire:lane0:1", ObjectiveStatus::Stage2),
        objective(102, first, "camp:neutral:lane1:10", ObjectiveStatus::Hidden),
        objective(103, first, "rift:neutral:lane6:1", ObjectiveStatus::Active),
        wave(110, first, "lane1", 500),
        wave(111, first, "lane4", 0),
        Op::Create { id: id(120), record: Record::Arrow(Arrow { scene: first, from: pos(0, 0), to: pos(900, -900), team: Some(Team::Amber), color: Some(3) }) },
        Op::Create { id: id(121), record: Record::Arrow(Arrow { scene: first, from: pos(5, 5), to: pos(6, 6), team: None, color: None }) },
        Op::Create { id: id(122), record: Record::Callout(Callout { scene: first, pos: pos(100, 200), text: "smoke".into(), color: Some(15) }) },
        Op::Create { id: id(123), record: Record::Callout(Callout { scene: first, pos: pos(-1, -2), text: "push → mid".into(), color: None }) },
        Op::Create { id: id(124), record: Record::Note(Note { scene: first, text: "Rotate after the walker.\nThen urn.".into() }) },
        Op::Create {
            id: id(125),
            record: Record::Stroke(Stroke { scene: first, points: vec![pos(1, 2), pos(30, 40), pos(-500, 600)], color: 7, width: 20, offset: WorldPos::default() }),
        },
    ]);
    send(&mut doc, TxKind::Edit, vec![
        set(id(100), FieldValue::ObjectiveStatus(ObjectiveStatus::Active)),
        set(id(110), FieldValue::WavePos(730)),
        set(id(120), FieldValue::ArrowFrom(pos(10, 10))),
        set(id(120), FieldValue::ArrowTo(pos(-800, 800))),
        set(id(120), FieldValue::ArrowTeam(Some(Team::Sapphire))),
        set(id(120), FieldValue::ArrowColor(None)),
        set(id(122), FieldValue::CalloutPos(pos(150, 250))),
        set(id(122), FieldValue::CalloutText("smoke bridge".into())),
        set(id(122), FieldValue::CalloutColor(Some(2))),
        set(id(124), FieldValue::NoteText("Rotate after the walker.".into())),
        set(id(125), FieldValue::StrokeOffset(pos(-40, 75))),
    ]);
    // A scene as Save as scene writes it from a replay: a source, the clock, each player as the
    // match had it, what is down, the splits.
    let saved = Scene {
        name: "Match moment".into(),
        order: OrderKey::between(Some(&OrderKey::first()), None),
        clock: Some(1735),
        source: Some(SceneSource { match_id: 129_738_985, t: 1735, tier: "replay".into() }),
        live: false,
        parent: None,
    };
    let mut ops = scene_ops(&doc, 200, saved, |i, p| PlayerState {
        pos: pos(-9000 + 1500 * i as i32, 400 * i as i32 - 2000),
        alive: i % 5 != 4,
        placed: i != 7,
        souls: Some(20_000 + 1_111 * i as u32),
        ult_cooldown: if i % 3 == 0 { None } else { Some((i * 9) as u8) },
        ..p
    });
    ops.extend([
        objective(2100, id(200), "guardian:amber:lane1", ObjectiveStatus::Destroyed),
        objective(2101, id(200), "walker:sapphire:lane4:1", ObjectiveStatus::Destroyed),
        objective(2102, id(200), "mid_boss:neutral:lane4:1", ObjectiveStatus::Destroyed),
        wave(2110, id(200), "lane1", 412),
        wave(2111, id(200), "lane4", 655),
        wave(2112, id(200), "lane6", 1000),
    ]);
    send(&mut doc, TxKind::Edit, ops);
    // One from the metadata tier, nested under it; and Player's live layer.
    let meta = Scene {
        name: "Fight".into(),
        order: OrderKey::first(),
        clock: Some(900),
        source: Some(SceneSource { match_id: 129_738_985, t: 900, tier: "metadata".into() }),
        live: false,
        parent: Some(id(200)),
    };
    let ops = scene_ops(&doc, 300, meta, |_, p| p);
    send(&mut doc, TxKind::Edit, ops);
    let live = Scene { name: String::new(), order: OrderKey("z".into()), clock: None, source: None, live: true, parent: None };
    let ops = scene_ops(&doc, 400, live, |_, p| p);
    send(&mut doc, TxKind::Edit, ops);
    // Reorder and re-nest; then undo and redo of an edit, as the replica builds them.
    send(&mut doc, TxKind::Edit, vec![
        set(id(300), FieldValue::SceneOrder(OrderKey("m".into()))),
        set(id(300), FieldValue::SceneParent(None)),
        set(id(300), FieldValue::SceneParent(Some(first))),
    ]);
    let (edit, undo) = send(&mut doc, TxKind::Edit, vec![set(id(20000), FieldValue::PlayerPos(pos(77, -77))), Op::Delete { id: id(2101) }]);
    assert!(matches!(undo.as_slice(), [Op::Restore { .. }, Op::SetIf { .. }]), "an undo holds a Restore and a SetIf: {undo:?}");
    let (undone, redo) = send(&mut doc, TxKind::Undo { of: edit }, undo);
    send(&mut doc, TxKind::Redo { of: undone }, redo);
    // Deleted things stay as tombstones: a callout, a wave, and a scene with all it holds.
    send(&mut doc, TxKind::Edit, vec![Op::Delete { id: id(123) }, Op::Delete { id: id(111) }]);
    send(&mut doc, TxKind::Edit, vec![Op::Delete { id: id(400) }]);
    (start, log)
}

fn replay(start: &Doc, log: &[Tx]) -> Doc {
    let mut doc = start.clone();
    for tx in log {
        apply_tx(&mut doc, tx).unwrap_or_else(|r| panic!("tx #{} refused: {r}", tx.cseq));
    }
    doc
}

fn lines<T: serde::Serialize>(items: &[T]) -> String {
    items.iter().map(|t| serde_json::to_string(t).expect("json") + "\n").collect()
}

#[test]
fn the_fixture_log_holds_every_op_and_every_typed_field() {
    let (_, log) = board_log();
    let (mut fields, mut ops, mut kinds) = (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
    for op in log.iter().flat_map(|t| &t.ops) {
        match op {
            Op::Create { record, .. } => {
                ops.insert("create");
                kinds.insert(format!("{:?}", record.kind()));
            }
            Op::Set { value, .. } => {
                ops.insert("set");
                fields.insert(format!("{:?}", value.field()));
            }
            Op::SetIf { value, .. } => {
                ops.insert("set_if");
                fields.insert(format!("{:?}", value.field()));
            }
            Op::Delete { .. } => {
                ops.insert("delete");
            }
            Op::Restore { .. } => {
                ops.insert("restore");
            }
        }
    }
    assert_eq!(ops.len(), 5, "every op: {ops:?}");
    // A board's typed fields: every one but a session's three (pinned by the session fixture).
    let board: BTreeSet<String> =
        Field::TYPED.iter().filter(|f| !matches!(f, Field::SessionTitle | Field::TabName | Field::TabOrder)).map(|f| format!("{f:?}")).collect();
    assert_eq!(fields, board);
    assert_eq!(kinds.len(), 8, "every kind an edit creates in a board: {kinds:?}");
    assert!(log.iter().any(|t| matches!(t.kind, TxKind::Undo { .. })) && log.iter().any(|t| matches!(t.kind, TxKind::Redo { .. })));
}

#[test]
fn a_logged_transaction_reads_and_writes_back_byte_for_byte() {
    let (start, log) = board_log();
    pinned("board-log.jsonl", &lines(&log));
    let stored = std::fs::read_to_string(golden("board-log.jsonl")).expect("golden log");
    let read: Vec<Tx> = stored.lines().map(|l| serde_json::from_str(l).expect("a logged transaction parses")).collect();
    assert_eq!(lines(&read), stored);
    // And it replays, as a cold load does, to the stored board.
    pinned("board.json", &serde_json::to_string(&replay(&start, &read)).expect("json"));
}

#[test]
fn a_stored_board_reads_and_writes_back_byte_for_byte() {
    let (start, log) = board_log();
    let doc = replay(&start, &log);
    pinned("board-genesis.json", &serde_json::to_string(&start).expect("json"));
    pinned("board.json", &serde_json::to_string(&doc).expect("json"));
    let stored = std::fs::read_to_string(golden("board.json")).expect("golden board");
    let read: Doc = serde_json::from_str(&stored).expect("a stored board parses");
    validate_doc(&read).expect("and is valid");
    assert_eq!(serde_json::to_string(&read).expect("json"), stored);
    assert_eq!(read, doc);
    // Deleted records are in it: a tombstone is stored, not dropped.
    assert!(read.iter().filter(|(_, e)| e.deleted).count() >= 3);
}

#[test]
fn a_board_file_holds_the_same_records() {
    let (start, log) = board_log();
    pinned("board-export.json", &serde_json::to_string(&export_records(&replay(&start, &log))).expect("json"));
    let stored = std::fs::read_to_string(golden("board-export.json")).expect("golden export");
    let read: Vec<(RecordId, Record)> = serde_json::from_str(&stored).expect("a file's records parse");
    assert_eq!(serde_json::to_string(&read).expect("json"), stored);
    let imported = mapcro_schema::import_records(read.clone(), ids(1 << 64), &mapcro_schema::Admit::DEPLOYED).expect("and import");
    assert_eq!(imported.iter_live().count(), read.len());
}

#[test]
fn a_stored_session_reads_and_writes_back_byte_for_byte() {
    let tabs = [(BoardId("a".repeat(22)), GrantId("c".repeat(22)), "Game 1".to_owned())];
    let mut doc = session_genesis(ids(0), "Scrims", &tabs);
    let log = vec![
        Tx {
            client: ClientId(7),
            cseq: 0,
            kind: TxKind::Edit,
            ops: vec![
                Op::Create { id: id(50), record: Record::Tab(Tab { board: BoardId("b".repeat(22)), grant: GrantId("g".repeat(22)), name: "Game 2".into(), order: OrderKey("m".into()) }) },
                set(id(1), FieldValue::SessionTitle("Block B".into())),
                set(id(50), FieldValue::TabName("Final".into())),
                set(id(50), FieldValue::TabOrder(OrderKey("a".into()))),
            ],
        },
        Tx { client: ClientId(7), cseq: 1, kind: TxKind::Edit, ops: vec![Op::Delete { id: id(2) }] },
    ];
    for tx in &log {
        assert!(apply_tx(&mut doc, tx).expect("valid").iter().all(|o| *o == OpOutcome::Applied));
    }
    pinned("session-log.jsonl", &lines(&log));
    pinned("session.json", &serde_json::to_string(&doc).expect("json"));
    let stored = std::fs::read_to_string(golden("session.json")).expect("golden session");
    let read: Doc = serde_json::from_str(&stored).expect("a stored session parses");
    validate_doc(&read).expect("and is valid");
    assert_eq!(serde_json::to_string(&read).expect("json"), stored);
}

/// Records as the first builds wrote them, before each `serde(default)` field existed: no clock,
/// source, live or parent on a scene; no souls, ult, sight or respawn on a player; no colour on
/// an arrow or a comment; no offset on a stroke. They load, and are written in today's shape.
#[test]
fn the_oldest_shapes_still_load_and_are_written_as_today() {
    let s = "00000000000000000000000000000001";
    let old = [
        r#"{"Scene":{"name":"8:00 mid","order":"i"}}"#.to_owned(),
        format!(r#"{{"PlayerState":{{"scene":"{s}","slot":"{s}","pos":{{"x":1,"y":2}},"alive":true,"placed":true}}}}"#),
        format!(r#"{{"Arrow":{{"scene":"{s}","from":{{"x":0,"y":0}},"to":{{"x":1,"y":1}},"team":null}}}}"#),
        format!(r#"{{"Callout":{{"scene":"{s}","pos":{{"x":0,"y":0}},"text":"x"}}}}"#),
        format!(r#"{{"Stroke":{{"scene":"{s}","points":[{{"x":0,"y":0}},{{"x":1,"y":1}}],"color":1,"width":20}}}}"#),
        format!(r#"{{"ObjectiveState":{{"scene":"{s}","key":"walker:amber:lane1:1","status":"Destroyed"}}}}"#),
        format!(r#"{{"Wave":{{"scene":"{s}","lane":"lane1","t":500}}}}"#),
    ];
    let read: Vec<Record> = old.iter().map(|j| serde_json::from_str(j).expect("an old record parses")).collect();
    pinned("oldest-shapes.jsonl", &lines(&read));
}
