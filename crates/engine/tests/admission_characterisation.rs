//! What the server takes from a client, pinned before feedback #56, #59 and #60 changed the
//! schema (a scene name up to 48, a comment's side, a stroke's colour as a field).
//!
//! Written against the build deployed as store v10 (e878c30) and held through the reader
//! release: that release reads the new things from a stored board and still takes none of them
//! from outside, so a rollback to v10 finds nothing it can't load. The transactions are JSON,
//! as a client sends them, so the same test runs on a build that can't parse the new field
//! values at all: not parsed, or parsed and refused, it is never logged.

use mapcro_engine::{Authority, ClientMsg, ConnId, Effect, Hello, Role};
use mapcro_schema::{Arrow, Callout, ClientId, Doc, Op, Record, RecordId, Reject, Stroke, Tx, TxKind, WorldPos, genesis};
use serde_json::{Value, json};

const CLIENT: ClientId = ClientId(7);
const CONN: ConnId = ConnId(1);

fn board() -> Doc {
    let mut n = 0u128;
    genesis(
        || {
            n += 1;
            RecordId(n)
        },
        "Scrim",
    )
}

fn first(doc: &Doc, kind: impl Fn(&Record) -> bool) -> RecordId {
    doc.iter_live().find(|(_, r)| kind(r)).map(|(id, _)| id).expect("record")
}

/// The server's authority (its own admission, nothing set) on a board with an arrow (id 900),
/// a comment (901) and a stroke (902), with one editor connected.
fn serving() -> (Authority, u64) {
    let doc = board();
    let scene = first(&doc, |r| matches!(r, Record::Scene(_)));
    let mut a = Authority::new(doc);
    a.connect(CONN, Role::Edit);
    let hello = Hello { client: CLIENT, secret: "s".into(), last_seq: a.log_len(), pending_from: a.next_cseq(CLIENT) };
    a.handle(CONN, ClientMsg::Hello(hello));
    let at = |x, y| WorldPos { x, y };
    let placed = Tx {
        client: CLIENT,
        cseq: 0,
        kind: TxKind::Edit,
        ops: vec![
            Op::Create { id: RecordId(900), record: Record::Arrow(Arrow { scene, from: at(0, 0), to: at(50, 50), team: None, color: None }) },
            Op::Create { id: RecordId(901), record: serde_json::from_value(json!({ "Callout": { "scene": scene, "pos": at(5, 5), "text": "smoke", "color": null } })).expect("a comment as clients send it") },
            Op::Create { id: RecordId(902), record: Record::Stroke(Stroke { scene, points: vec![at(1, 1), at(9, 9)], color: 7, width: 20, offset: WorldPos::default() }) },
        ],
    };
    let (_, effects) = a.handle(CONN, ClientMsg::Submit(placed));
    assert!(matches!(effects.as_slice(), [Effect::Logged { .. }]), "{effects:?}");
    (a, 1)
}

/// Submit `ops` (JSON, as a client sends them). `Ok` if logged; else why not: the refusal, or
/// `None` when this build can't even parse them.
fn submit(a: &mut Authority, cseq: &mut u64, ops: Value) -> Result<(), Option<Reject>> {
    let tx = json!({ "client": CLIENT, "cseq": *cseq, "kind": "Edit", "ops": ops });
    let Ok(tx) = serde_json::from_value::<Tx>(tx) else { return Err(None) };
    let (doc, len) = (a.doc().clone(), a.log_len());
    let (_, effects) = a.handle(CONN, ClientMsg::Submit(tx));
    *cseq += 1;
    match effects.as_slice() {
        [Effect::Logged { .. }] => Ok(()),
        [Effect::Rejected { reason, .. }] => {
            assert_eq!((a.doc(), a.log_len()), (&doc, len), "a refused transaction changes nothing");
            Err(Some(reason.clone()))
        }
        other => panic!("{other:?}"),
    }
}

fn set(id: RecordId, value: Value) -> Value {
    json!([{ "Set": { "id": id, "value": value } }])
}

#[test]
fn names_are_taken_up_to_24_characters() {
    let (mut a, mut cseq) = serving();
    let scene = first(a.doc(), |r| matches!(r, Record::Scene(_)));
    let slot = first(a.doc(), |r| matches!(r, Record::RosterSlot(_)));
    let (fits, long) = ("n".repeat(24), "n".repeat(25));
    for (id, field) in [(scene, "SceneName"), (slot, "RosterName")] {
        assert_eq!(submit(&mut a, &mut cseq, set(id, json!({ field: fits }))), Ok(()), "{field}");
        assert_eq!(submit(&mut a, &mut cseq, set(id, json!({ field: long }))), Err(Some(Reject::TextTooLong)), "{field}");
        // An undo's shape: refused for what it would write, whatever it expects.
        let set_if = json!([{ "SetIf": { "id": id, "expect": { field: fits }, "value": { field: long } } }]);
        assert_eq!(submit(&mut a, &mut cseq, set_if), Err(Some(Reject::TextTooLong)), "{field}");
    }
    // A scene created with its name: the same bound.
    let new_scene = |name: &str| json!([{ "Create": { "id": RecordId(950), "record": { "Scene": { "name": name, "order": "a5", "clock": null } } } }]);
    assert_eq!(submit(&mut a, &mut cseq, new_scene(&long)), Err(Some(Reject::TextTooLong)));
    // (With a name that fits it is refused for its missing heroes, not its name.)
    assert_eq!(submit(&mut a, &mut cseq, new_scene(&fits)), Err(Some(Reject::IncompleteScene)));
    // A session's tab name and a hero's name in a scene keep the bound too.
    let hero = first(a.doc(), |r| matches!(r, Record::PlayerState(_)));
    let hero_name = |name: &str| set(hero, json!({ "More": { "key": "name", "value": name } }));
    assert_eq!(submit(&mut a, &mut cseq, hero_name(&fits)), Ok(()));
    assert_eq!(submit(&mut a, &mut cseq, hero_name(&long)), Err(Some(Reject::TextTooLong)));
}

/// Recolouring an arrow or a comment is an edit the deployed server already takes (no client
/// sent one before feedback #60), so it needs no reader release.
#[test]
fn an_arrow_and_a_comment_are_recoloured_by_a_field_write() {
    let (mut a, mut cseq) = serving();
    assert_eq!(submit(&mut a, &mut cseq, set(RecordId(900), json!({ "ArrowColor": 3 }))), Ok(()));
    assert_eq!(submit(&mut a, &mut cseq, set(RecordId(901), json!({ "CalloutColor": 15 }))), Ok(()));
    assert_eq!(submit(&mut a, &mut cseq, set(RecordId(901), json!({ "CalloutColor": null }))), Ok(()));
    assert_eq!(submit(&mut a, &mut cseq, set(RecordId(900), json!({ "ArrowColor": 16 }))), Err(Some(Reject::OutOfBounds)));
    let Some(Record::Arrow(arrow)) = a.doc().live(RecordId(900)) else { panic!("arrow") };
    assert_eq!(arrow.color, Some(3));
}

/// What no client may store yet: a comment's side and a stroke's colour written as a field.
/// The v10 build can't parse them; the reader release parses and refuses them.
#[test]
fn a_comments_side_and_a_strokes_colour_are_never_logged() {
    let (mut a, mut cseq) = serving();
    let (callout, stroke) = (RecordId(901), RecordId(902));
    let scene = first(a.doc(), |r| matches!(r, Record::Scene(_)));
    let not_logged = |r: Result<(), Option<Reject>>, what: &str| assert!(matches!(r, Err(None | Some(Reject::WrongField))), "{what}: {r:?}");
    for side in ["Above", "Below", "Left", "Right"] {
        not_logged(submit(&mut a, &mut cseq, set(callout, json!({ "CalloutSide": side }))), side);
    }
    let undo = json!([{ "SetIf": { "id": callout, "expect": { "CalloutSide": "Left" }, "value": { "CalloutSide": "Above" } } }]);
    not_logged(submit(&mut a, &mut cseq, undo), "undo of a side");
    not_logged(submit(&mut a, &mut cseq, set(stroke, json!({ "StrokeColor": 3 }))), "stroke colour");
    let undo = json!([{ "SetIf": { "id": stroke, "expect": { "StrokeColor": 3 }, "value": { "StrokeColor": 7 } } }]);
    not_logged(submit(&mut a, &mut cseq, undo), "undo of a stroke colour");
    // Beside an edit the board takes today, the whole transaction is refused.
    let both = json!([{ "Set": { "id": callout, "value": { "CalloutText": "smoke bridge" } } }, { "Set": { "id": callout, "value": { "CalloutSide": "Below" } } }]);
    not_logged(submit(&mut a, &mut cseq, both), "a side beside a text edit");
    // A comment created with a side. (A build that doesn't know the field would drop it on
    // parse and store the comment without it: then it must hold no side.)
    let sided = json!([{ "Create": { "id": RecordId(960), "record": { "Callout": { "scene": scene, "pos": { "x": 1, "y": 2 }, "text": "x", "color": null, "side": "Left" } } } }]);
    match submit(&mut a, &mut cseq, sided) {
        Err(why) => not_logged(Err(why), "a comment created on a side"),
        Ok(()) => {
            let stored = serde_json::to_value(a.doc().live(RecordId(960)).expect("created")).expect("json");
            assert_eq!(stored["Callout"].get("side"), None, "a side was stored");
        }
    }
    // The board is as it was: the comment's text, and a comment and a stroke as stored today.
    let Some(Record::Callout(Callout { text, .. })) = a.doc().live(callout) else { panic!("comment") };
    assert_eq!(text, "smoke");
    let stored = serde_json::to_value(a.doc().live(callout).expect("comment")).expect("json");
    assert_eq!(stored, json!({ "Callout": { "scene": scene, "pos": { "x": 5, "y": 5 }, "text": "smoke", "color": null } }));
    let Some(Record::Stroke(s)) = a.doc().live(stroke) else { panic!("stroke") };
    assert_eq!(s.color, 7);
}
