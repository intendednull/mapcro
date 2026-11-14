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

/// A file holding a map-state snapshot (registry values on a hero, the scene's own state) makes
/// no board while this build only reads them (map-state spec §4.3): a server rolled back to
/// before the reader couldn't load it. At version 2, and at version 1, whose header promises
/// nothing about its records. (That the same file imports once the rows are written, and
/// exports the same values, is `boardfile`'s own test: the server as built can't be told to.)
#[test]
fn a_file_with_map_state_makes_no_board_while_its_rows_are_ahead() {
    assert!(mapcro_schema::ROWS.iter().all(|r| r.status == mapcro_schema::Status::Ahead) && mapcro_schema::SCENE_STATE == mapcro_schema::Status::Ahead, "the writer release: this test is the reader's; the import below then succeeds");
    // One board at most: a refusal that made a board would leave no room for the last import.
    let server = Server::start(&[("CREATE_PER_HOUR", "1000"), ("CREATE_GLOBAL_PER_HOUR", "1000"), ("MAX_BOARDS", "1")]);
    let scene_of = |file: &mut Value| records(file).iter().find(|r| r[1].get("Scene").is_some_and(|s| s["name"] == "8:40 rotate")).expect("scene")[0].clone();
    let hero = |file: &mut Value, more: Value| {
        let scene = scene_of(file);
        let p = records(file).iter_mut().find(|r| r[1].get("PlayerState").is_some_and(|p| p["scene"] == scene)).expect("player");
        p[1]["PlayerState"]["more"] = more;
    };
    let state = |file: &mut Value, more: Value| {
        let scene = scene_of(file);
        records(file).push(json!(["00000000000000000000000000005000", { "SceneState": { "scene": scene, "more": more } }]));
    };
    let send = |file: &Value| {
        let (status, body) = server.import(file.to_string().as_bytes());
        (status, error_of(&body))
    };
    for version in [1, 2] {
        let versioned = |f: &dyn Fn(&mut Value)| {
            with(|v| {
                f(v);
                v["version"] = json!(version);
                if version == 2 {
                    v["rows"] = json!(mapcro_schema::ROWS.len());
                }
            })
        };
        // The whole snapshot; a hero's value alone; a scene's state alone, even an empty one.
        let snapshot = versioned(&|v| {
            hero(v, json!({ "hero": 13, "name": "Solo", "items": [9000, -1, 4294967295u64], "level": 12, "health": 55 }));
            state(v, json!({ "rows": mapcro_schema::ROWS.len(), "has_builds": true, "build": 6839 }));
        });
        assert_eq!(send(&snapshot), (422, "invalid".into()), "version {version}");
        assert_eq!(send(&versioned(&|v| hero(v, json!({ "level": 12 })))), (422, "invalid".into()), "version {version}");
        assert_eq!(send(&versioned(&|v| state(v, json!({})))), (422, "invalid".into()), "version {version}");
        // An empty `more` is no value at all: it comes in, and is not written back.
        let empty = versioned(&|v| hero(v, json!({})));
        if version == 2 {
            let (board, owner, _) = server.import_ok(&empty);
            let mut out = server.export_json(&board, &owner);
            assert!(records(&mut out).iter().all(|r| r[1].get("SceneState").is_none() && r[1].as_object().is_some_and(|o| o.values().all(|body| body.get("more").is_none()))));
        }
    }
}

/// `rich_file`, changed by `f`.
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

    // A newer build's file: refused whole, whatever its body. Version 2 is read (below); a
    // file whose writer knew more map-state rows than this build is newer at any version.
    let rows = mapcro_schema::ROWS.len();
    assert_eq!(send(&with(|v| v["version"] = json!(3))), (422, "newer".into()));
    assert_eq!(send(&with(|v| { v["version"] = json!(99); v["records"] = json!(marker); })), (422, "newer".into()));
    assert_eq!(send(&with(|v| { v["version"] = json!(2); v["rows"] = json!(rows + 1); v["records"] = json!(marker); })), (422, "newer".into()));
    assert_eq!(send(&with(|v| v["rows"] = json!(rows + 1))), (422, "newer".into()));
    // A map-state key this build doesn't know can't be held: the file doesn't parse.
    assert_eq!(send(&with(|v| { let p = records(v).iter_mut().find(|r| r[1].get("PlayerState").is_some()).expect("player"); p[1]["PlayerState"]["more"] = json!({ "no_such_row": 1 }); })), (400, "not_a_board".into()));
    // A known key with a value outside its row, or on the wrong kind of record: invalid.
    let player_more = |more: Value| with(|v| { let p = records(v).iter_mut().find(|r| r[1].get("PlayerState").is_some()).expect("player"); p[1]["PlayerState"]["more"] = more; });
    assert_eq!(send(&player_more(json!({ "health": 101 }))), (422, "invalid".into()));
    assert_eq!(send(&player_more(json!({ "health": "full" }))), (422, "invalid".into()));
    assert_eq!(send(&player_more(json!({ "has_builds": true }))), (422, "invalid".into()));
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

/// A connection that sent an import's head (`content-length: length`) and the first `sent`
/// bytes of its body, and no more.
fn held_import(port: u16, extra: &str, length: usize, sent: usize) -> std::net::TcpStream {
    use std::io::Write;
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
    write!(s, "POST /api/boards/import HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\n{extra}content-length: {length}\r\n\r\n").expect("head");
    s.write_all(&vec![b' '; sent]).expect("body");
    s
}

/// The status a held connection is answered with within `within`, if any.
fn answer(s: &mut std::net::TcpStream, within: std::time::Duration) -> Option<u16> {
    use std::io::Read;
    s.set_read_timeout(Some(within)).expect("timeout");
    let mut buf = [0u8; 64];
    let n = s.read(&mut buf).ok()?;
    std::str::from_utf8(&buf[..n]).ok()?.split(' ').nth(1)?.parse().ok()
}

fn error_of(body: &str) -> String {
    serde_json::from_str::<Value>(body).ok().and_then(|v| v["error"].as_str().map(str::to_owned)).unwrap_or_else(|| body.to_owned())
}

/// Security review F2: an import was read whole (8 MiB) before the creation limit was asked, so
/// rate-limited connections still each held a body. Now nothing is read until the request
/// passes: a stated length, the creation limits.
#[test]
fn an_import_is_refused_before_its_body_is_read() {
    let server = Server::start(&[("CREATE_PER_HOUR", "1")]);
    server.import_ok(&rich_file());
    // Rate-limited: answered with the body unsent.
    let mut held = held_import(server.port, "", MAX_BYTES - 1, 0);
    assert_eq!(answer(&mut held, std::time::Duration::from_secs(5)), Some(429));
    // Over the cap by its length, or no length at all.
    assert_eq!(answer(&mut held_import(server.port, "", MAX_BYTES + 1, 0), std::time::Duration::from_secs(5)), Some(413));
    let r = ureq::post(&server.url("/api/boards/import"))
        .header("content-type", "application/json")
        .config()
        .http_status_as_error(false)
        .build()
        .send(ureq::SendBody::from_reader(&mut &b"{}"[..]));
    assert_eq!(r.expect("answer").status().as_u16(), 411, "a body of no stated length (chunked)");
}

/// F2: a body that stalls is cut off, and only so many imports read at once; one past them is
/// refused before any of its body is read, and costs no attempt.
#[test]
fn a_stalled_import_times_out_and_imports_at_once_are_capped() {
    let server = Server::start(&[("CREATE_PER_HOUR", "1000")]);
    let started = std::time::Instant::now();
    let mut held: Vec<_> = (0..4).map(|_| held_import(server.port, "", 4096, 100)).collect();
    std::thread::sleep(std::time::Duration::from_millis(500));
    let (status, body) = server.import(rich_file().to_string().as_bytes());
    assert_eq!((status, error_of(&body).as_str()), (503, "busy"), "a fifth import while four read");
    // Each stalled body is answered once its 15 s are up, never later.
    for s in &mut held {
        assert_eq!(answer(s, std::time::Duration::from_secs(25)), Some(408));
    }
    let waited = started.elapsed();
    assert!(waited >= std::time::Duration::from_secs(14) && waited < std::time::Duration::from_secs(25), "{waited:?}");
    server.import_ok(&rich_file());
}

/// Security review F3: a point may be written `[0,0]`, which the board holds as
/// `{"x":0,"y":0}`, so a file under the cap could make a board over it (one that could then be
/// neither sent as a snapshot nor downloaded). The board's own size is what's capped.
#[test]
fn a_file_under_the_cap_whose_board_is_over_it_is_refused() {
    let server = Server::start(&[]);
    let mut file = rich_file();
    let scene = records(&mut file).iter().find(|r| r[1].get("Scene").is_some()).expect("scene")[0].clone();
    let points = json!(vec![json!([0, 0]); 512]);
    for i in 0..2600u32 {
        records(&mut file).push(json!([format!("{:032x}", 0xf000_0000u64 + u64::from(i)), { "Stroke": { "scene": scene, "points": points, "color": 0, "width": 1 } }]));
    }
    let bytes = file.to_string();
    assert!(bytes.len() < MAX_BYTES, "{}", bytes.len());
    let (status, body) = server.import(bytes.as_bytes());
    assert_eq!((status, error_of(&body).as_str()), (413, "too_large"));
    // The array form itself is fine in a board that fits.
    let small = with(|v| {
        let i = records(v).iter().position(|r| r[1].get("Stroke").is_some()).expect("stroke");
        records(v)[i][1]["Stroke"]["points"] = json!([[0, 0], [10, 10]]);
    });
    server.import_ok(&small);
}

/// Security review F4: an import took any body from any page, so a cross-site form could post
/// one (`text/plain` needs no preflight). It takes JSON only, and a browser's request only from
/// the site.
#[test]
fn an_import_from_another_site_is_refused() {
    let server = Server::start(&[]);
    let body = rich_file().to_string();
    let post = |ct: &str, origin: Option<&str>| {
        let mut r = ureq::post(&server.url("/api/boards/import")).header("content-type", ct);
        if let Some(o) = origin {
            r = r.header("origin", o);
        }
        let mut r = r.config().http_status_as_error(false).build().send(body.as_bytes()).expect("answer");
        (r.status().as_u16(), error_of(&r.body_mut().read_to_string().unwrap_or_default()))
    };
    assert_eq!(post("text/plain", Some("https://evil.example")), (415, "content_type".into()));
    assert_eq!(post("text/plain", None), (415, "content_type".into()));
    assert_eq!(post("application/json", Some("https://evil.example")), (403, "origin".into()));
    assert_eq!(post("application/json", Some("null")), (403, "origin".into()));
    // The site itself (the landing, and the desktop app, which loads the site), and no browser.
    assert_eq!(post("application/json", Some("http://localhost:5173")).0, 201);
    assert_eq!(post("application/json; charset=utf-8", None).0, 201);
}

/// F6: a revoked link can neither download nor clone its board.
#[test]
fn a_revoked_link_cannot_download_or_clone() {
    let server = Server::start(&[]);
    let (board, owner, _) = server.import_ok(&rich_file());
    let v: Value = ureq::post(&server.url(&format!("/api/boards/{board}/links")))
        .header("authorization", &format!("Bearer {owner}"))
        .send_json(json!({ "role": "view", "label": "v" }))
        .expect("mint")
        .body_mut()
        .read_json()
        .expect("json");
    let (link, view) = (v["link_id"].as_str().expect("id").to_owned(), v["token"].as_str().expect("token").to_owned());
    let clone = |token: &str| {
        ureq::post(&server.url(&format!("/api/boards/{board}/clone"))).header("authorization", &format!("Bearer {token}")).config().http_status_as_error(false).build().send_json(json!({})).expect("answer").status().as_u16()
    };
    assert_eq!(server.export(&board, &view).0, 200);
    assert_eq!(clone(&view), 201);
    let revoked = ureq::delete(&server.url(&format!("/api/boards/{board}/links/{link}"))).header("authorization", &format!("Bearer {owner}")).call().expect("revoke");
    assert!(revoked.status().is_success());
    assert_eq!(server.export(&board, &view).0, 403);
    assert_eq!(clone(&view), 403);
}

/// F6: a match the server refused for its mode (Street Brawl) is dropped from a file's list.
/// The id is made up; its refusal is planted where the server keeps one.
#[test]
fn a_mode_refused_match_in_a_file_is_dropped() {
    let server = Server::start(&[]);
    let matches = server._dir.path().join("matches");
    std::fs::create_dir_all(&matches).expect("dir");
    std::fs::write(matches.join("77.refused"), "brawl").expect("refusal");
    let (board, owner, answer) = server.import_ok(&with(|v| v["matches"] = json!([77, 130816395])));
    assert_eq!(answer["matches"], json!([130816395]));
    assert_eq!(server.export_json(&board, &owner)["matches"], json!([130816395]));
}

/// Security review F1: a download copied the whole board and wrote it on the blocking pool with
/// nothing bounding how many ran at once (about 50 MB each for the largest). Downloads past the
/// server-wide budget are refused, not all run.
#[test]
fn downloads_at_once_are_capped() {
    let server = Server::start(&[]);
    let (board, owner, _) = server.import_ok(&support::large_board_file(64 * 1024));
    // Rounds of 16 at once, until one is refused: on a loaded box a round can arrive spread out
    // enough that each ends before the next starts. With no budget, none ever is.
    let round = || -> Vec<(u16, String)> {
        let barrier = std::sync::Barrier::new(16);
        std::thread::scope(|s| {
            let all: Vec<_> = (0..16)
                .map(|_| {
                    s.spawn(|| {
                        barrier.wait();
                        let (status, body) = server.export(&board, &owner);
                        (status, if status == 200 { String::new() } else { error_of(&body) })
                    })
                })
                .collect();
            all.into_iter().map(|t| t.join().expect("thread")).collect()
        })
    };
    let mut refused = false;
    for _ in 0..5 {
        let codes = round();
        assert!(codes.iter().all(|(s, e)| *s == 200 || (*s == 503 && e == "busy")), "{codes:?}");
        assert!(codes.iter().any(|(s, _)| *s == 200), "{codes:?}");
        if codes.iter().any(|(s, _)| *s == 503) {
            refused = true;
            break;
        }
    }
    assert!(refused, "five rounds of 16 at once, and none refused");
    // Once they're done, one goes through again.
    assert_eq!(server.export(&board, &owner).0, 200);
}
