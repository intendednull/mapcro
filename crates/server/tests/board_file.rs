//! Board files (spec §6, §11): Download (`GET /api/boards/{board}/export`) and Import board
//! (`POST /api/boards/import`), against the real server binary. An import is untrusted: every
//! refusal here is a file that must make no board.

use mapcro_schema::{Op, Record, RecordId, Tx, TxKind, WorldPos};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::process::{Child, Stdio};

mod support;

const MAX_BYTES: usize = 8 * 1024 * 1024;

struct Server {
    child: Child,
    port: u16,
    _dir: tempfile::TempDir,
}

impl Server {
    fn start(env: &[(&str, &str)]) -> Server {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut cmd = support::server();
        cmd.env("DATA_DIR", dir.path()).env("PUBLIC_ORIGIN", "http://localhost:5173").env("RUST_LOG", "warn").envs(env.iter().copied()).stdout(Stdio::null());
        let s = support::start(cmd).unwrap_or_else(|e| panic!("server exited ({}): {}", e.status, e.stderr));
        Server { child: s.child, port: s.port, _dir: dir }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    /// `(status, body)` of a POST of raw bytes.
    fn import(&self, body: &[u8]) -> (u16, String) {
        let r = ureq::post(&self.url("/api/boards/import")).header("content-type", "application/json").config().http_status_as_error(false).build().send(body);
        match r {
            Ok(mut r) => (r.status().as_u16(), r.body_mut().read_to_string().unwrap_or_default()),
            Err(e) => (0, e.to_string()),
        }
    }

    /// Import `file`, expecting a board: `(board, owner token, the answer)`.
    fn import_ok(&self, file: &Value) -> (String, String, Value) {
        let (status, body) = self.import(file.to_string().as_bytes());
        assert_eq!(status, 201, "{body}");
        let v: Value = serde_json::from_str(&body).expect("json");
        (v["board"].as_str().expect("board").to_owned(), v["owner_token"].as_str().expect("token").to_owned(), v)
    }

    fn export(&self, board: &str, token: &str) -> (u16, String) {
        let r = ureq::get(&self.url(&format!("/api/boards/{board}/export"))).header("authorization", &format!("Bearer {token}")).config().http_status_as_error(false).build().call();
        match r {
            Ok(mut r) => (r.status().as_u16(), r.body_mut().with_config().limit(16 * 1024 * 1024).read_to_string().unwrap_or_default()),
            Err(e) => (0, e.to_string()),
        }
    }

    fn export_json(&self, board: &str, token: &str) -> Value {
        let (status, body) = self.export(board, token);
        assert_eq!(status, 200, "{body}");
        serde_json::from_str(&body).expect("json")
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn fixture() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/board-file-v1-oldest-records.mapcro.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("fixture json")
}

/// A board as the client builds one: genesis, then a second scene nested under the first with
/// ink, an arrow, a comment and a note, as a file.
fn rich_file() -> Value {
    let mut n = 0u128;
    let mut doc = mapcro_schema::genesis(
        || {
            n += 1;
            RecordId(n)
        },
        "Scrim prep",
    );
    let first = doc.iter_live().find(|(_, r)| matches!(r, Record::Scene(_))).map(|(id, _)| id).expect("scene");
    let slots: Vec<_> = doc
        .iter_live()
        .filter_map(|(id, r)| match r {
            Record::RosterSlot(s) => Some((id, s.team, s.slot)),
            _ => None,
        })
        .collect();
    let second = RecordId(1000);
    let mut ops = vec![Op::Create {
        id: second,
        record: Record::Scene(mapcro_schema::Scene { name: "8:40 rotate".into(), order: mapcro_schema::OrderKey::between(Some(&mapcro_schema::OrderKey::first()), None), clock: Some(520), source: None, live: false, parent: Some(first) }),
    }];
    for (i, (slot, team, index)) in slots.into_iter().enumerate() {
        ops.push(Op::Create { id: RecordId(2000 + i as u128), record: Record::PlayerState(mapcro_schema::PlayerState::starting(second, slot, team, index)) });
    }
    ops.push(Op::Create { id: RecordId(3000), record: Record::Stroke(mapcro_schema::Stroke { scene: second, points: vec![WorldPos { x: 0, y: 0 }, WorldPos { x: 400, y: -300 }], color: 4, width: 30, offset: WorldPos { x: 5, y: 5 } }) });
    ops.push(Op::Create { id: RecordId(3001), record: Record::Arrow(mapcro_schema::Arrow { scene: first, from: WorldPos { x: 1, y: 2 }, to: WorldPos { x: 900, y: 900 }, team: None, color: Some(2) }) });
    ops.push(Op::Create { id: RecordId(3002), record: Record::Callout(mapcro_schema::Callout { scene: second, pos: WorldPos { x: -40, y: 40 }, text: "smoke here".into(), color: None }) });
    ops.push(Op::Create { id: RecordId(3003), record: Record::Note(mapcro_schema::Note { scene: first, text: "take mid\nthen rotate east".into() }) });
    mapcro_schema::apply_tx(&mut doc, &Tx { client: mapcro_schema::ClientId(1), cseq: 0, kind: TxKind::Edit, ops }).expect("valid edits");
    json!({ "format": "mapcro-board", "version": 1, "build": "test", "exported_at": 0, "records": mapcro_schema::export_records(&doc), "matches": [130816395] })
}

/// A file's records with ids replaced by what they name (a seat, a scene by its name), and
/// sorted: equal for the same board under any ids.
fn canonical(file: &Value) -> Vec<String> {
    let records = file["records"].as_array().expect("records");
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    for r in records {
        let id = r[0].as_str().expect("id").to_owned();
        let rec = &r[1];
        if let Some(s) = rec.get("RosterSlot") {
            names.insert(id, format!("seat:{}:{}", s["team"], s["slot"]));
        } else if let Some(s) = rec.get("Scene") {
            names.insert(id, format!("scene:{}", s["name"]));
        }
    }
    let mut out: Vec<String> = records
        .iter()
        .map(|r| {
            let mut text = r[1].to_string();
            for (id, name) in &names {
                text = text.replace(id, name);
            }
            text
        })
        .collect();
    out.sort();
    out
}

#[test]
fn an_export_imports_as_the_same_board_under_fresh_ids() {
    let server = Server::start(&[]);
    let file = rich_file();
    let (a, a_owner, answer) = server.import_ok(&file);
    assert_eq!(answer["title"], "Scrim prep");
    assert_eq!(answer["matches"], json!([130816395]));
    let first = server.export_json(&a, &a_owner);
    assert_eq!(first["format"], "mapcro-board");
    assert_eq!(first["version"], 1);
    assert!(first["build"].as_str().is_some_and(|b| b.len() == 16), "the server's build");
    assert!(first["exported_at"].as_i64().is_some_and(|t| t > 1_700_000_000));
    assert_eq!(first["matches"], json!([130816395]), "the match comes back by its id");
    assert_eq!(canonical(&first), canonical(&file), "the same records");

    // And again, from the server's own export: the same board, none of the ids kept.
    let (b, b_owner, _) = server.import_ok(&first);
    let second = server.export_json(&b, &b_owner);
    assert_eq!(canonical(&second), canonical(&first));
    let ids = |f: &Value| f["records"].as_array().expect("records").iter().map(|r| r[0].as_str().expect("id").to_owned()).collect::<Vec<_>>();
    assert!(ids(&second).iter().all(|id| !ids(&first).contains(id)), "fresh ids on every import");
    // The source is untouched by its import.
    assert_eq!(server.export_json(&a, &a_owner)["records"], first["records"]);
    // The new board's match list is the file's.
    let m: Value = ureq::get(&server.url(&format!("/api/boards/{b}/matches"))).header("authorization", &format!("Bearer {b_owner}")).call().expect("matches").body_mut().read_json().expect("json");
    assert_eq!(m["matches"], json!([130816395]));
}

#[test]
fn a_file_in_the_oldest_record_shapes_opens_with_their_defaults() {
    let server = Server::start(&[]);
    let (board, owner, answer) = server.import_ok(&fixture());
    assert_eq!(answer["title"], "Old scrim");
    let out = server.export_json(&board, &owner);
    let find = |kind: &str| out["records"].as_array().expect("records").iter().map(|r| &r[1]).filter_map(|r| r.get(kind)).cloned().collect::<Vec<_>>();
    assert_eq!(find("Stroke")[0]["offset"], json!({ "x": 0, "y": 0 }), "older strokes load unmoved");
    assert!(find("PlayerState").iter().all(|p| p["visible"] == true && p["respawn"].is_null()), "older players are visible, no timer");
    assert_eq!(find("Scene")[0]["parent"], Value::Null);
    assert_eq!(find("Arrow")[0]["color"], Value::Null);
    assert_eq!(find("Note")[0]["text"], "push mid\nthen take the urn");
    assert_eq!(find("RosterSlot").iter().filter(|s| s["name"] == "Player 1").count(), 1);
    assert_eq!(canonical(&out).len(), canonical(&fixture()).len(), "every record kept");
}

#[test]
fn an_export_holds_no_secret() {
    let server = Server::start(&[]);
    let (board, owner, _) = server.import_ok(&rich_file());
    // A view link, minted: its token and its public id must not appear either.
    let v: Value = ureq::post(&server.url(&format!("/api/boards/{board}/links")))
        .header("authorization", &format!("Bearer {owner}"))
        .send_json(json!({ "role": "view", "label": "scrim team" }))
        .expect("mint")
        .body_mut()
        .read_json()
        .expect("json");
    let (link_id, view) = (v["link_id"].as_str().expect("id").to_owned(), v["token"].as_str().expect("token").to_owned());
    // A view link can download, as it can clone.
    let (status, text) = server.export(&board, &view);
    assert_eq!(status, 200, "{text}");
    for secret in [owner.as_str(), view.as_str(), link_id.as_str(), "scrim team", board.as_str()] {
        assert!(!text.contains(secret), "the export carries {secret:?}");
    }
    for word in ["token", "link", "grant", "presence", "client"] {
        assert!(!text.to_lowercase().contains(&format!("\"{word}")), "a {word} key in {text}");
    }
    // Without a link, or with another board's, nothing.
    let (other, other_owner, _) = server.import_ok(&rich_file());
    assert_eq!(server.export(&board, &other_owner).0, 403);
    assert_eq!(server.export(&other, "not-a-token").0, 401);
}

/// `file`, changed by `f`.
fn with(f: impl FnOnce(&mut Value)) -> Value {
    let mut v = rich_file();
    f(&mut v);
    v
}

fn records(v: &mut Value) -> &mut Vec<Value> {
    v["records"].as_array_mut().expect("records")
}

#[test]
fn bad_files_are_refused_with_a_code_and_make_no_board() {
    // One board at most: a refusal that made a board would leave no room for the last import.
    let server = Server::start(&[("CREATE_PER_HOUR", "1000"), ("CREATE_GLOBAL_PER_HOUR", "1000"), ("MAX_BOARDS", "1")]);
    let marker = "MARKER-not-to-be-echoed";
    let code = |(status, body): (u16, String)| {
        assert!(!body.contains(marker), "the answer echoes the file: {body}");
        let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        (status, v["error"].as_str().unwrap_or(&body).to_owned())
    };
    let send = |v: &Value| code(server.import(v.to_string().as_bytes()));
    let title_at = |v: &mut Value| -> usize { records(v).iter().position(|r| r[1].get("BoardMeta").is_some()).expect("meta") };

    // A newer build's file: refused whole, whatever its body.
    assert_eq!(send(&with(|v| v["version"] = json!(2))), (422, "newer".into()));
    assert_eq!(send(&with(|v| { v["version"] = json!(99); v["records"] = json!(marker); })), (422, "newer".into()));
    // Not this format, not JSON, or a version that never was.
    assert_eq!(send(&with(|v| v["format"] = json!("excalidraw"))), (400, "not_a_board".into()));
    assert_eq!(code(server.import(format!("<html>{marker}</html>").as_bytes())), (400, "not_a_board".into()));
    assert_eq!(send(&with(|v| v["version"] = json!(0))), (400, "not_a_board".into()));
    // An unknown key in the envelope is refused (strict); one in a record is dropped (below).
    assert_eq!(send(&with(|v| v[marker] = json!(1))), (400, "not_a_board".into()));
    // Bad shapes: a record of a kind that doesn't exist, a field of the wrong type, a bad id.
    assert_eq!(send(&with(|v| records(v).push(json!(["00000000000000000000000000abcdef", { "Script": { "src": marker } }])))), (400, "not_a_board".into()));
    assert_eq!(send(&with(|v| { let i = title_at(v); records(v)[i][1]["BoardMeta"]["title"] = json!(7); })), (400, "not_a_board".into()));
    assert_eq!(send(&with(|v| { let i = title_at(v); records(v)[i][0] = json!("../../etc/passwd"); })), (400, "not_a_board".into()));
    // The schema's rules: a title over the limit, a title of two lines, ink off the map.
    assert_eq!(send(&with(|v| { let i = title_at(v); records(v)[i][1]["BoardMeta"]["title"] = json!("x".repeat(81)); })), (422, "invalid".into()));
    assert_eq!(send(&with(|v| { let i = title_at(v); records(v)[i][1]["BoardMeta"]["title"] = json!("a\nb"); })), (422, "invalid".into()));
    assert_eq!(
        send(&with(|v| {
            let i = records(v).iter().position(|r| r[1].get("Stroke").is_some()).expect("stroke");
            records(v)[i][1]["Stroke"]["points"][0] = json!({ "x": 99_999, "y": 0 });
        })),
        (422, "invalid".into())
    );
    // Too many records (each fine alone), and too many matches.
    assert_eq!(
        send(&with(|v| {
            let scene = records(v).iter().find(|r| r[1].get("Scene").is_some()).expect("scene")[0].clone();
            for i in 0..5000u32 {
                records(v).push(json!([format!("{:032x}", 0xf000_0000u64 + u64::from(i)), { "Callout": { "scene": scene, "pos": { "x": 0, "y": 0 }, "text": "" } }]));
            }
        })),
        (422, "invalid".into())
    );
    assert_eq!(send(&with(|v| v["matches"] = json!((1..=21).collect::<Vec<u64>>()))), (422, "invalid".into()));
    // Deep nesting, refused before it is parsed.
    let deep = format!("{{\"format\":\"mapcro-board\",\"version\":1,\"x\":{}1{}}}", "[".repeat(5000), "]".repeat(5000));
    assert_eq!(code(server.import(deep.as_bytes())), (400, "too_deep".into()));
    // Over the cap: the route stops reading. It may answer 413 and close while the client is
    // still sending; either way, refused.
    let big = vec![b' '; MAX_BYTES + 1];
    assert!(matches!(server.import(&big).0, 413 | 0));

    // None of these made a board: there is room for this one, and it drops the unknown field.
    let (board, owner, _) = server.import_ok(&with(|v| {
        let i = records(v).iter().position(|r| r[1].get("Note").is_some()).expect("note");
        records(v)[i][1]["Note"][marker] = json!("dropped");
    }));
    let (_, text) = server.export(&board, &owner);
    assert!(!text.contains(marker), "an unknown record field is dropped, never stored");
}

#[test]
fn a_blank_title_imports_as_imported_board() {
    let server = Server::start(&[]);
    let file = with(|v| {
        let i = records(v).iter().position(|r| r[1].get("BoardMeta").is_some()).expect("meta");
        records(v)[i][1]["BoardMeta"]["title"] = json!("   ");
    });
    let (board, owner, answer) = server.import_ok(&file);
    assert_eq!(answer["title"], "Imported board");
    let out = server.export_json(&board, &owner);
    assert!(out["records"].as_array().expect("records").iter().any(|r| r[1]["BoardMeta"]["title"] == "Imported board"));
}

#[test]
fn imports_share_board_creation_s_rate_limit() {
    let server = Server::start(&[("CREATE_PER_HOUR", "3")]);
    server.import_ok(&rich_file());
    // A refused file still counts: the parse is what the limit pays for.
    assert_eq!(server.import(b"{}").0, 400);
    let created = ureq::post(&server.url("/api/boards")).send_json(json!({ "title": "x" })).expect("create");
    assert_eq!(created.status().as_u16(), 201);
    let (status, body) = server.import(rich_file().to_string().as_bytes());
    assert_eq!((status, body.as_str()), (429, r#"{"error":"rate_limited"}"#));
    let r = ureq::post(&server.url("/api/boards")).config().http_status_as_error(false).build().send_json(json!({ "title": "x" })).expect("answer");
    assert_eq!(r.status().as_u16(), 429, "and creation is out too");
}
