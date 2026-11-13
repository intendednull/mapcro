//! Sessions and grants (docs/specs/sessions.md §3, §9.2), and the board auth they must leave as
//! it was. The characterisation half pins what every board route and the WebSocket answer to
//! each kind of board credential; it was written and passed on main before sessions existed.

use futures_util::{SinkExt, StreamExt};
use mapcro_engine::wire::{CloseReason, LinkRole, WireOut};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

mod support;

const ORIGIN: &str = "http://localhost:5173";
type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Server {
    child: Child,
    port: u16,
    stderr: Arc<Mutex<String>>,
    _dir: tempfile::TempDir,
}

impl Server {
    fn start(env: &[(&str, &str)]) -> Server {
        let dir = tempfile::tempdir().expect("tempdir");
        let dead = support::dead_port();
        let mut cmd = support::server();
        cmd.env("DATA_DIR", dir.path())
            .env("PUBLIC_ORIGIN", ORIGIN)
            .env("RUST_LOG", "warn")
            .env("CREATE_PER_HOUR", "10000")
            .env("CREATE_GLOBAL_PER_HOUR", "10000")
            .env("MATCH_API_BASE", format!("http://127.0.0.1:{dead}"))
            .env("REPLAY_CDN_BASE", format!("http://127.0.0.1:{dead}/cdn"))
            .envs(env.iter().copied())
            // The server logs to stdout: kept, for the leak test to read.
            .stdout(Stdio::from(std::fs::File::create(dir.path().join("stdout.log")).expect("log file")));
        let s = support::start_or_panic(cmd);
        Server { child: s.child, port: s.port, stderr: s.stderr, _dir: dir }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    /// `(status, body)` for any method, with `Authorization: <auth>` when given.
    fn call(&self, method: &str, path: &str, auth: Option<&str>, body: Option<serde_json::Value>) -> (u16, String) {
        let url = self.url(path);
        let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
        let mut req = ureq::http::Request::builder().method(method).uri(&url);
        if let Some(a) = auth {
            req = req.header("authorization", a);
        }
        let res = match body {
            Some(b) => agent.run(req.header("content-type", "application/json").body(serde_json::to_vec(&b).expect("json")).expect("request")),
            None => agent.run(req.body(Vec::<u8>::new()).expect("request")),
        };
        match res {
            Ok(mut r) => (r.status().as_u16(), r.body_mut().read_to_string().unwrap_or_default()),
            Err(e) => panic!("{method} {path}: {e}"),
        }
    }

    fn json(&self, method: &str, path: &str, auth: Option<&str>, body: serde_json::Value) -> (u16, serde_json::Value) {
        let (s, b) = self.call(method, path, auth, Some(body));
        (s, serde_json::from_str(&b).unwrap_or(serde_json::Value::Null))
    }

    fn create_board(&self) -> (String, String) {
        let (s, v) = self.json("POST", "/api/boards", None, serde_json::json!({ "title": "Board" }));
        assert_eq!(s, 201, "{v}");
        (v["board"].as_str().expect("board").into(), v["owner_token"].as_str().expect("token").into())
    }

    fn mint(&self, board: &str, token: &str, role: &str) -> (String, String) {
        let (s, v) = self.json("POST", &format!("/api/boards/{board}/links"), Some(&bearer(token)), serde_json::json!({ "role": role, "label": "t" }));
        assert_eq!(s, 201, "{v}");
        (v["link_id"].as_str().expect("id").into(), v["token"].as_str().expect("token").into())
    }

    fn revoke(&self, board: &str, token: &str, link_id: &str) -> u16 {
        self.call("DELETE", &format!("/api/boards/{board}/links/{link_id}"), Some(&bearer(token)), None).0
    }

    /// Everything the server wrote, stdout (its log) and stderr.
    fn log(&self) -> String {
        let out = std::fs::read_to_string(self._dir.path().join("stdout.log")).unwrap_or_default();
        out + &self.stderr.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

async fn open_ws(port: u16) -> Ws {
    let mut req = format!("ws://127.0.0.1:{port}/ws").into_client_request().expect("request");
    req.headers_mut().insert("origin", ORIGIN.parse().expect("origin"));
    tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws).expect("ws connects")
}

async fn send(ws: &mut Ws, frame: &serde_json::Value) {
    ws.send(Message::Text(frame.to_string().into())).await.expect("send");
}

/// The next frame, or `None` if the socket closed.
async fn recv(ws: &mut Ws) -> Option<WireOut> {
    loop {
        let next = tokio::time::timeout(Duration::from_secs(10), ws.next()).await;
        match next.expect("the server sent nothing for 10 s")? {
            Ok(Message::Text(t)) => return serde_json::from_str(t.as_str()).ok(),
            Ok(Message::Ping(_) | Message::Pong(_)) => continue,
            _ => return None,
        }
    }
}

/// What a WebSocket `Auth` with this frame gets: the role it joined with, or why it was closed.
#[derive(Debug, PartialEq)]
enum Joined {
    Role(LinkRole),
    Closed(CloseReason),
}

async fn auth_frame(port: u16, frame: serde_json::Value) -> (Joined, Ws) {
    let mut ws = open_ws(port).await;
    send(&mut ws, &frame).await;
    match recv(&mut ws).await {
        Some(WireOut::Ready { role, .. }) => (Joined::Role(role), ws),
        Some(WireOut::Closed { reason }) => (Joined::Closed(reason), ws),
        other => panic!("unexpected first frame {other:?}"),
    }
}

async fn ws_join(port: u16, board: &str, token: &str) -> Joined {
    auth_frame(port, serde_json::json!({ "t": "auth", "board": board, "token": token, "known_seq": null })).await.0
}

/// Wait for the server to close this socket, and say why.
async fn closed(ws: &mut Ws) -> Option<CloseReason> {
    loop {
        match recv(ws).await {
            Some(WireOut::Closed { reason }) => return Some(reason),
            Some(_) => continue,
            None => return None,
        }
    }
}

// ---- the board routes, as main has them ----

/// Every board-scoped HTTP route: method, path (`{b}` is the board), and a body. Match ids are
/// the invalid "x", so a caller that passes auth gets `400 bad_id` and nothing reaches the
/// network or the queue. Rotate is last: it ends the owner token.
const BOARD_ROUTES: &[(&str, &str, bool)] = &[
    ("POST", "/api/boards/{b}/links", true),
    ("GET", "/api/boards/{b}/links", false),
    ("DELETE", "/api/boards/{b}/links/0000000000000000", false),
    ("POST", "/api/boards/{b}/clone", true),
    ("GET", "/api/boards/{b}/export", false),
    ("GET", "/api/boards/{b}/replays/x", false),
    ("POST", "/api/boards/{b}/replays/x/fetch", false),
    ("POST", "/api/boards/{b}/replays/x/reserve", false),
    ("DELETE", "/api/boards/{b}/replays/x/reserve", false),
    ("POST", "/api/boards/{b}/replays/x/upload", false),
    ("POST", "/api/boards/{b}/replays/x/timeline", false),
    ("GET", "/api/boards/{b}/matches/x", false),
    ("PUT", "/api/boards/{b}/matches/x", false),
    ("GET", "/api/boards/{b}/matches", false),
    ("POST", "/api/boards/{b}/owner/rotate", false),
];

fn body_for(path: &str, has_body: bool) -> Option<serde_json::Value> {
    if !has_body {
        return None;
    }
    Some(if path.ends_with("/links") { serde_json::json!({ "role": "view", "label": "c" }) } else { serde_json::json!({}) })
}

/// Status per route per credential, as `route: s1 s2 …` lines.
fn route_table(server: &Server, board: &str, creds: &[(&str, Option<String>)]) -> String {
    let mut out = String::new();
    for (method, path, has_body) in BOARD_ROUTES {
        let p = path.replace("{b}", board);
        let mut line = format!("{method} {path}:");
        for (_, auth) in creds {
            let (s, _) = server.call(method, &p, auth.as_deref(), body_for(path, *has_body));
            line.push_str(&format!(" {s}"));
        }
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// Characterisation (on main before sessions): what each board route answers to no token, a
/// malformed one, another board's owner, a revoked link, and this board's view, edit and owner
/// links. Columns are in that order.
#[tokio::test(flavor = "multi_thread")]
async fn board_routes_answer_board_links_as_before() {
    let server = Server::start(&[]);
    let (board, owner) = server.create_board();
    let (_, other_owner) = server.create_board();
    let (_, view) = server.mint(&board, &owner, "view");
    let (_, edit) = server.mint(&board, &owner, "edit");
    let (gone_id, gone) = server.mint(&board, &owner, "edit");
    assert_eq!(server.revoke(&board, &owner, &gone_id), 204);
    let creds = [
        ("none", None),
        ("garbage", Some("Bearer not-a-token".to_owned())),
        ("other board", Some(bearer(&other_owner))),
        ("revoked", Some(bearer(&gone))),
        ("view", Some(bearer(&view))),
        ("edit", Some(bearer(&edit))),
        ("owner", Some(bearer(&owner))),
    ];
    let got = route_table(&server, &board, &creds);
    let want = "\
POST /api/boards/{b}/links: 401 401 403 403 403 201 201
GET /api/boards/{b}/links: 401 401 403 403 403 200 200
DELETE /api/boards/{b}/links/0000000000000000: 401 401 403 403 403 404 404
POST /api/boards/{b}/clone: 401 401 403 403 201 201 201
GET /api/boards/{b}/export: 401 401 403 403 200 200 200
GET /api/boards/{b}/replays/x: 401 401 403 403 400 400 400
POST /api/boards/{b}/replays/x/fetch: 401 401 403 403 403 400 400
POST /api/boards/{b}/replays/x/reserve: 401 401 403 403 403 400 400
DELETE /api/boards/{b}/replays/x/reserve: 401 401 403 403 403 400 400
POST /api/boards/{b}/replays/x/upload: 401 401 403 403 403 400 400
POST /api/boards/{b}/replays/x/timeline: 401 401 403 403 403 400 400
GET /api/boards/{b}/matches/x: 401 401 403 403 400 400 400
PUT /api/boards/{b}/matches/x: 401 401 403 403 403 400 400
GET /api/boards/{b}/matches: 401 401 403 403 200 200 200
POST /api/boards/{b}/owner/rotate: 401 401 403 403 403 403 200
";
    assert_eq!(got, want, "board routes answer board links differently:\n{got}");
}

/// Characterisation: the WebSocket's answer to the same credentials, and to a board id that
/// isn't one.
#[tokio::test(flavor = "multi_thread")]
async fn the_websocket_answers_board_links_as_before() {
    let server = Server::start(&[]);
    let (board, owner) = server.create_board();
    let (other, other_owner) = server.create_board();
    let (_, view) = server.mint(&board, &owner, "view");
    let (_, edit) = server.mint(&board, &owner, "edit");
    let (gone_id, gone) = server.mint(&board, &owner, "edit");
    assert_eq!(server.revoke(&board, &owner, &gone_id), 204);
    let p = server.port;
    assert_eq!(ws_join(p, &board, &owner).await, Joined::Role(LinkRole::Owner));
    assert_eq!(ws_join(p, &board, &edit).await, Joined::Role(LinkRole::Edit));
    assert_eq!(ws_join(p, &board, &view).await, Joined::Role(LinkRole::View));
    assert_eq!(ws_join(p, &board, &gone).await, Joined::Closed(CloseReason::Unauthorized));
    assert_eq!(ws_join(p, &board, &other_owner).await, Joined::Closed(CloseReason::Unauthorized));
    assert_eq!(ws_join(p, &other, &owner).await, Joined::Closed(CloseReason::Unauthorized));
    assert_eq!(ws_join(p, "not-a-board", &owner).await, Joined::Closed(CloseReason::Unauthorized));
    assert_eq!(ws_join(p, &board, "short").await, Joined::Closed(CloseReason::Unauthorized));
}

/// Characterisation: revoking a link closes the connections it opened, and the cascade reaches
/// what it minted; an editor manages only its own subtree.
#[tokio::test(flavor = "multi_thread")]
async fn revocation_closes_live_board_connections_as_before() {
    let server = Server::start(&[]);
    let (board, owner) = server.create_board();
    let (edit_id, edit) = server.mint(&board, &owner, "edit");
    let (_, child) = server.mint(&board, &edit, "view");
    let (_, sibling) = server.mint(&board, &owner, "edit");
    let p = server.port;
    let join = |t: String| {
        let b = board.clone();
        async move { auth_frame(p, serde_json::json!({ "t": "auth", "board": b, "token": t, "known_seq": null })).await }
    };
    let (j1, mut ws_edit) = join(edit.clone()).await;
    let (j2, mut ws_child) = join(child.clone()).await;
    let (j3, mut ws_sibling) = join(sibling.clone()).await;
    assert_eq!((j1, j2, j3), (Joined::Role(LinkRole::Edit), Joined::Role(LinkRole::View), Joined::Role(LinkRole::Edit)));
    // A sibling editor can't revoke a link it didn't mint; it reads as not found.
    assert_eq!(server.revoke(&board, &sibling, &edit_id), 404);
    assert_eq!(server.revoke(&board, &owner, &edit_id), 204);
    assert_eq!(closed(&mut ws_edit).await, Some(CloseReason::Revoked));
    assert_eq!(closed(&mut ws_child).await, Some(CloseReason::Revoked));
    assert_eq!(ws_join(p, &board, &child).await, Joined::Closed(CloseReason::Unauthorized));
    // The sibling stays connected.
    assert!(tokio::time::timeout(Duration::from_millis(500), closed(&mut ws_sibling)).await.is_err(), "the sibling was closed");
}

// ---- sessions (spec §9.2) ----

fn grant_auth(session: &str, grant: &str, token: &str) -> String {
    format!("Grant {session}.{grant}.{token}")
}

/// A session, its owner token, and (made from a board) its first tab and grant.
struct NewSession {
    id: String,
    owner: String,
    tab: Option<String>,
    grant: Option<serde_json::Value>,
}

impl Server {
    fn create_session(&self, title: &str, from: Option<(&str, &str)>) -> NewSession {
        let mut body = serde_json::json!({ "title": title });
        if let Some((b, t)) = from {
            body["board"] = b.into();
            body["board_token"] = t.into();
        }
        let (s, v) = self.json("POST", "/api/sessions", None, body);
        assert_eq!(s, 201, "{v}");
        NewSession {
            id: v["session"].as_str().expect("session").into(),
            owner: v["owner_token"].as_str().expect("owner").into(),
            tab: v["tab"].as_str().map(Into::into),
            grant: v.get("grant").cloned(),
        }
    }

    /// `POST /api/sessions/{s}/grants`: (status, body).
    fn add_grant(&self, session: &str, token: &str, board: &str, board_token: &str, role: Option<&str>) -> (u16, serde_json::Value) {
        let mut body = serde_json::json!({ "board": board, "board_token": board_token });
        if let Some(r) = role {
            body["role"] = r.into();
        }
        self.json("POST", &format!("/api/sessions/{session}/grants"), Some(&bearer(token)), body)
    }

    fn grant_ok(&self, session: &str, token: &str, board: &str, board_token: &str, role: Option<&str>) -> (String, String) {
        let (s, v) = self.add_grant(session, token, board, board_token, role);
        // 200: the same board through the same link at the same role, so the same grant.
        assert!(s == 201 || s == 200, "{s} {v}");
        (v["grant_id"].as_str().expect("grant").into(), v["role"].as_str().expect("role").into())
    }

    fn mint_session(&self, session: &str, token: &str, role: &str) -> (String, String) {
        let (s, v) = self.json("POST", &format!("/api/sessions/{session}/links"), Some(&bearer(token)), serde_json::json!({ "role": role, "label": "t" }));
        assert_eq!(s, 201, "{v}");
        (v["link_id"].as_str().expect("id").into(), v["token"].as_str().expect("token").into())
    }

    fn revoke_session(&self, session: &str, token: &str, link_id: &str) -> u16 {
        self.call("DELETE", &format!("/api/sessions/{session}/links/{link_id}"), Some(&bearer(token)), None).0
    }

    /// The public id of the grant's links row on `board`, from the board owner's link list.
    fn grant_link_id(&self, board: &str, owner: &str) -> Vec<String> {
        let (s, b) = self.call("GET", &format!("/api/boards/{board}/links"), Some(&bearer(owner)), None);
        assert_eq!(s, 200, "{b}");
        let v: serde_json::Value = serde_json::from_str(&b).expect("json");
        v.as_array().expect("list").iter().filter(|l| l["label"].as_str().is_some_and(|x| x.starts_with("Session: "))).map(|l| l["link_id"].as_str().expect("id").to_owned()).collect()
    }

    /// The role an HTTP caller gets on `board`: none, view or edit, read off two board routes.
    fn http_role(&self, board: &str, auth: &str) -> Option<LinkRole> {
        let (list, _) = self.call("GET", &format!("/api/boards/{board}/matches"), Some(auth), None);
        let (attach, _) = self.call("PUT", &format!("/api/boards/{board}/matches/x"), Some(auth), None);
        match (list, attach) {
            (200, 400) => Some(LinkRole::Edit),
            (200, 403) => Some(LinkRole::View),
            (403, 403) => None,
            other => panic!("unexpected {other:?}"),
        }
    }
}

/// A connection to a room that submits raw transactions and keeps every frame it saw.
struct Raw {
    ws: Ws,
    client: u128,
    cseq: u64,
    seen: Vec<String>,
}

impl Raw {
    async fn open(port: u16, room: &str, token: &str, client: u128) -> Raw {
        let mut ws = open_ws(port).await;
        send(&mut ws, &serde_json::json!({ "t": "auth", "board": room, "token": token, "known_seq": null })).await;
        let mut seen = Vec::new();
        let first = ws.next().await.expect("frame").expect("ok");
        let Message::Text(t) = first else { panic!("text") };
        seen.push(t.to_string());
        let ready: serde_json::Value = serde_json::from_str(t.as_str()).expect("json");
        assert_eq!(ready["t"], "ready", "{ready}");
        let seq = ready["base"]["seq"].as_u64().expect("a base");
        let hello = serde_json::json!({ "t": "msg", "msg": { "Hello": { "client": format!("{client:032x}"), "secret": format!("s-{client}"), "last_seq": seq, "pending_from": 0 } } });
        send(&mut ws, &hello).await;
        Raw { ws, client, cseq: 0, seen }
    }

    /// The base document the room sent on joining.
    fn doc(&self) -> mapcro_schema::Doc {
        let v: serde_json::Value = serde_json::from_str(&self.seen[0]).expect("json");
        serde_json::from_value(v["base"]["doc"].clone()).expect("doc")
    }

    /// Submit `ops`; Ok once it's logged, or the reason it was refused.
    async fn submit(&mut self, ops: Vec<mapcro_schema::Op>) -> Result<(), mapcro_schema::Reject> {
        let cseq = self.cseq;
        self.cseq += 1;
        let tx = mapcro_schema::Tx { client: mapcro_schema::ClientId(self.client), cseq, kind: mapcro_schema::TxKind::Edit, ops };
        send(&mut self.ws, &serde_json::json!({ "t": "msg", "msg": { "Submit": tx } })).await;
        loop {
            let next = tokio::time::timeout(Duration::from_secs(10), self.ws.next()).await.expect("an answer").expect("open").expect("ok");
            let Message::Text(t) = next else { continue };
            self.seen.push(t.to_string());
            match serde_json::from_str::<WireOut>(t.as_str()) {
                Ok(WireOut::Msg { msg: mapcro_engine::ServerMsg::Entry { tx, .. } }) if tx.client.0 == self.client && tx.cseq == cseq => return Ok(()),
                Ok(WireOut::Msg { msg: mapcro_engine::ServerMsg::Rejected { cseq: c, reason } }) if c == cseq => return Err(reason),
                Ok(WireOut::Closed { reason }) => panic!("closed: {reason:?}"),
                _ => {}
            }
        }
    }
}

fn tab_record(board: &str, grant: &str, name: &str) -> mapcro_schema::Record {
    mapcro_schema::Record::Tab(mapcro_schema::Tab {
        board: mapcro_schema::BoardId(board.into()),
        grant: mapcro_schema::GrantId(grant.into()),
        name: name.into(),
        order: mapcro_schema::OrderKey::first(),
    })
}

/// Opening `board` as a tab over the socket: the role, or why it was refused.
async fn ws_via(port: u16, board: &str, session: &str, grant: &str, token: &str) -> (Joined, Ws) {
    auth_frame(port, serde_json::json!({ "t": "auth", "board": board, "token": token, "known_seq": null, "via": { "session": session, "grant": grant } })).await
}

static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0x5000);

fn rid() -> mapcro_schema::RecordId {
    mapcro_schema::RecordId(u128::from(NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)))
}

/// A board added to a session as a tab: the board's owner, the adder's link, the grant and tab.
struct Added {
    board: String,
    owner: String,
    adder_id: String,
    grant: String,
    tab: mapcro_schema::RecordId,
}

/// A fresh board, an adder link of `adder_role` on it (minted by the owner), granted to the
/// session and added as a tab by `editor` (a session editor's raw connection).
async fn add_board(server: &Server, session: &NewSession, editor: &mut Raw, adder_role: &str) -> Added {
    let (board, owner) = server.create_board();
    let (adder_id, adder) = server.mint(&board, &owner, adder_role);
    let (grant, _) = server.grant_ok(&session.id, &session.owner, &board, &adder, None);
    let tab = rid();
    editor.submit(vec![mapcro_schema::Op::Create { id: tab, record: tab_record(&board, &grant, "Game") }]).await.expect("tab added");
    Added { board, owner, adder_id, grant, tab }
}

/// What each board route answers to a caller whose effective role is `role` (`None`: refused):
/// the characterisation table's view and edit columns, except that access through a session
/// can never share (§3.5).
fn want_route(method: &str, path: &str, role: Option<LinkRole>) -> u16 {
    let share = path.contains("/links") || path.ends_with("/owner/rotate");
    match role {
        None => 403,
        Some(_) if share => 403,
        Some(r) => {
            let edit = r != LinkRole::View;
            match (method, path) {
                ("POST", "/api/boards/{b}/clone") => 201,
                ("GET", "/api/boards/{b}/export" | "/api/boards/{b}/matches") => 200,
                ("GET", _) => 400,
                _ if edit => 400,
                _ => 403,
            }
        }
    }
}

/// §9.2's role matrix: session role (owner, edit, view, revoked) × grant role (edit, view) ×
/// grant state (live, revoked directly, revoked via cascade) × tab state (live, removed,
/// restored), on the socket and on every board route, against `min(S, G)` or refusal. (Board
/// expiry, §9a, isn't built: there is no expired board to try.)
#[tokio::test(flavor = "multi_thread")]
async fn role_matrix_session_role_by_grant_by_tab() {
    let server = Server::start(&[]);
    let p = server.port;
    let session = server.create_session("Matrix", None);
    let (_, s_edit) = server.mint_session(&session.id, &session.owner, "edit");
    let (_, s_view) = server.mint_session(&session.id, &session.owner, "view");
    let (gone_id, s_gone) = server.mint_session(&session.id, &session.owner, "edit");
    let mut editor = Raw::open(p, &session.id, &session.owner, 0x51).await;
    // (grant role, grant state, tab state) → the tab.
    let mut cells = Vec::new();
    for g in ["edit", "view"] {
        for gstate in ["live", "revoked", "cascade"] {
            for tstate in ["live", "removed", "restored"] {
                let a = add_board(&server, &session, &mut editor, g).await;
                cells.push((g, gstate, tstate, a));
            }
        }
    }
    for (_, gstate, tstate, a) in &cells {
        if *tstate != "live" {
            editor.submit(vec![mapcro_schema::Op::Delete { id: a.tab }]).await.expect("removed");
        }
        if *tstate == "restored" {
            editor.submit(vec![mapcro_schema::Op::Restore { id: a.tab }]).await.expect("restored");
        }
        match *gstate {
            "revoked" => {
                let ids = server.grant_link_id(&a.board, &a.owner);
                assert_eq!(ids.len(), 1);
                assert_eq!(server.revoke(&a.board, &a.owner, &ids[0]), 204);
            }
            "cascade" => assert_eq!(server.revoke(&a.board, &a.owner, &a.adder_id), 204),
            _ => {}
        }
    }
    assert_eq!(server.revoke_session(&session.id, &session.owner, &gone_id), 204);
    let mut checked = 0;
    for (srole, token) in [("owner", &session.owner), ("edit", &s_edit), ("view", &s_view), ("revoked", &s_gone)] {
        for (g, gstate, tstate, a) in &cells {
            let alive = *gstate == "live" && *tstate != "removed" && srole != "revoked";
            let want = alive.then(|| if srole == "view" || *g == "view" { LinkRole::View } else { LinkRole::Edit });
            let cell = format!("session {srole}, grant {g} {gstate}, tab {tstate}");
            let (joined, _ws) = ws_via(p, &a.board, &session.id, &a.grant, token).await;
            assert_eq!(joined, want.map_or(Joined::Closed(CloseReason::Unauthorized), Joined::Role), "socket: {cell}");
            let auth = grant_auth(&session.id, &a.grant, token);
            for (method, path, has_body) in BOARD_ROUTES {
                let (s, body) = server.call(method, &path.replace("{b}", &a.board), Some(&auth), body_for(path, *has_body));
                assert_eq!(s, want_route(method, path, want), "{method} {path}: {cell}: {body}");
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 4 * 18 * BOARD_ROUTES.len());
}

/// A small deterministic generator (xorshift), so the property test needs no new crate.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn pick(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// §9.2's property: under random adds (with owner, edit or view board links), mints, revokes,
/// removes and restores, the role any session member gets on a tab's board is exactly
/// `min(session role, edit, the adder's role when added)`, and none once anything in the chain
/// is gone. Checked over HTTP after every step, for every member and every tab.
#[tokio::test(flavor = "multi_thread")]
async fn session_access_never_exceeds_the_chain_under_random_changes() {
    let server = Server::start(&[]);
    let p = server.port;
    for seed in [0x9e37_79b9_7f4a_7c15u64, 0x2545_f491_4f6c_dd1d, 0xdead_beef_cafe_f00d] {
        let mut rng = Rng(seed);
        let session = server.create_session("Prop", None);
        let mut editor = Raw::open(p, &session.id, &session.owner, 0x60 + u128::from(seed as u8)).await;
        // Members: (token, link id, role, live). The owner is first and never revoked.
        let mut members: Vec<(String, String, LinkRole, bool)> = vec![(session.owner.clone(), String::new(), LinkRole::Owner, true)];
        // Tabs: (board, grant, tab, board owner, adder link id, adder role, grant live, tab live).
        struct T {
            board: String,
            grant: String,
            tab: mapcro_schema::RecordId,
            owner: String,
            adder_id: Option<String>,
            adder_role: LinkRole,
            grant_live: bool,
            tab_live: bool,
        }
        let mut tabs: Vec<T> = Vec::new();
        for _ in 0..24 {
            match rng.pick(7) {
                0 | 1 => {
                    let (board, owner) = server.create_board();
                    let roles = [("owner", LinkRole::Owner), ("edit", LinkRole::Edit), ("view", LinkRole::View)];
                    let (rname, role) = roles[rng.pick(3)];
                    let (adder_id, adder) = if rname == "owner" { (None, owner.clone()) } else {
                        let (id, t) = server.mint(&board, &owner, rname);
                        (Some(id), t)
                    };
                    let (grant, _) = server.grant_ok(&session.id, &session.owner, &board, &adder, None);
                    let tab = rid();
                    editor.submit(vec![mapcro_schema::Op::Create { id: tab, record: tab_record(&board, &grant, "g") }]).await.expect("add");
                    tabs.push(T { board, grant, tab, owner, adder_id, adder_role: role, grant_live: true, tab_live: true });
                }
                2 => {
                    let role = if rng.pick(2) == 0 { ("edit", LinkRole::Edit) } else { ("view", LinkRole::View) };
                    let (id, t) = server.mint_session(&session.id, &session.owner, role.0);
                    members.push((t, id, role.1, true));
                }
                3 if members.len() > 1 => {
                    let i = 1 + rng.pick(members.len() - 1);
                    if members[i].3 {
                        assert_eq!(server.revoke_session(&session.id, &session.owner, &members[i].1), 204);
                        members[i].3 = false;
                    }
                }
                4 if !tabs.is_empty() => {
                    let i = rng.pick(tabs.len());
                    let t = &mut tabs[i];
                    if t.grant_live {
                        // Directly, or by cascade from the adder's link (an owner adder: directly).
                        match (&t.adder_id, rng.pick(2)) {
                            (Some(id), 0) => assert_eq!(server.revoke(&t.board, &t.owner, id), 204),
                            _ => {
                                let ids = server.grant_link_id(&t.board, &t.owner);
                                assert_eq!(server.revoke(&t.board, &t.owner, &ids[0]), 204);
                            }
                        }
                        t.grant_live = false;
                    }
                }
                5 if !tabs.is_empty() => {
                    let i = rng.pick(tabs.len());
                    let op = if tabs[i].tab_live { mapcro_schema::Op::Delete { id: tabs[i].tab } } else { mapcro_schema::Op::Restore { id: tabs[i].tab } };
                    editor.submit(vec![op]).await.expect("remove or restore");
                    tabs[i].tab_live = !tabs[i].tab_live;
                }
                _ => {}
            }
            for (token, _, srole, live) in &members {
                for t in &tabs {
                    let got = server.http_role(&t.board, &grant_auth(&session.id, &t.grant, token));
                    let cap = auth_min(auth_min(*srole, LinkRole::Edit), t.adder_role);
                    let want = (*live && t.grant_live && t.tab_live).then_some(cap);
                    assert_eq!(got, want, "seed {seed:x}: member {srole:?} live {live}, adder {:?}, grant {}, tab {}", t.adder_role, t.grant_live, t.tab_live);
                }
            }
        }
    }
}

fn auth_min(a: LinkRole, b: LinkRole) -> LinkRole {
    let rank = |r: LinkRole| match r {
        LinkRole::View => 0,
        LinkRole::Edit => 1,
        LinkRole::Owner => 2,
    };
    if rank(a) <= rank(b) { a } else { b }
}

/// §9.2: adding with an owner token gives edit; asking for more than a view token gives view;
/// "Can view" lowers an edit; and session-derived callers can't mint, list, revoke or rotate.
#[tokio::test(flavor = "multi_thread")]
async fn owner_is_never_delegated_and_view_stays_view() {
    let server = Server::start(&[]);
    let session = server.create_session("Roles", None);
    let (b1, o1) = server.create_board();
    let (g1, r1) = server.grant_ok(&session.id, &session.owner, &b1, &o1, None);
    assert_eq!(r1, "edit", "an owner token gives an edit grant");
    let (_, r) = server.grant_ok(&session.id, &session.owner, &b1, &o1, Some("owner"));
    assert_eq!(r, "edit", "asking for owner gives edit");
    let (b2, o2) = server.create_board();
    let (_, view) = server.mint(&b2, &o2, "view");
    let (_, r2) = server.grant_ok(&session.id, &session.owner, &b2, &view, Some("edit"));
    assert_eq!(r2, "view", "a view token gives view, whatever is asked");
    let (_, r3) = server.grant_ok(&session.id, &session.owner, &b1, &o1, Some("view"));
    assert_eq!(r3, "view", "Can view lowers an edit");
    let mut editor = Raw::open(server.port, &session.id, &session.owner, 0x71).await;
    editor.submit(vec![mapcro_schema::Op::Create { id: rid(), record: tab_record(&b1, &g1, "One") }]).await.expect("tab");
    let auth = grant_auth(&session.id, &g1, &session.owner);
    assert_eq!(server.http_role(&b1, &auth), Some(LinkRole::Edit));
    let (j, _ws) = ws_via(server.port, &b1, &session.id, &g1, &session.owner).await;
    assert_eq!(j, Joined::Role(LinkRole::Edit), "a session owner on an owner-added board is an editor there");
    for (m, path, body) in [
        ("POST", format!("/api/boards/{b1}/links"), Some(serde_json::json!({ "role": "view", "label": "x" }))),
        ("GET", format!("/api/boards/{b1}/links"), None),
        ("DELETE", format!("/api/boards/{b1}/links/0000000000000000"), None),
        ("POST", format!("/api/boards/{b1}/owner/rotate"), None),
    ] {
        let (s, b) = server.call(m, &path, Some(&auth), body);
        assert_eq!((s, b.as_str()), (403, r#"{"error":"this link cannot share"}"#), "{m} {path}");
    }
    // A view-only session member can't add boards.
    let (_, s_view) = server.mint_session(&session.id, &session.owner, "view");
    assert_eq!(server.add_grant(&session.id, &s_view, &b1, &o1, None).0, 403);
    // Nor can a grant be passed on as if it were a board link (v1: no grant of a grant).
    let (s, _) = server.json("POST", &format!("/api/sessions/{}/grants", session.id), Some(&auth), serde_json::json!({ "board": b1, "board_token": session.owner }));
    assert_eq!(s, 403, "a Grant credential isn't a session link");
}

/// Every route in the router table (main.rs and replays.rs) is listed here, so a new route
/// without a kind assertion fails this test until it's added.
const SESSION_ROUTES: &[(&str, &str, bool)] = &[
    ("POST", "/api/sessions/{b}/grants", true),
    ("POST", "/api/sessions/{b}/links", true),
    ("GET", "/api/sessions/{b}/links", false),
    ("DELETE", "/api/sessions/{b}/links/0000000000000000", false),
    ("POST", "/api/sessions/{b}/owner/rotate", false),
    ("DELETE", "/api/sessions/{b}/grants/gggggggggggggggggggggg", false),
];
/// Routes that name no room.
const ROOMLESS: &[&str] = &["/healthz", "/ws", "/api/boards", "/api/packs", "/api/matches/{id}", "/api/matches/{id}/preview", "/packs/{pack}/{*file}", "/api/boards/import", "/api/feedback", "/api/sessions"];

fn template(path: &str) -> String {
    path.replace("{b}", "{board}").replace("/gggggggggggggggggggggg", "/{grant}").replace("/x", "/{id}").replace("/0000000000000000", "/{link}")
}

#[test]
fn every_route_is_in_a_kind_table() {
    let src = |f: &str| std::fs::read_to_string(format!("{}/src/{f}", env!("CARGO_MANIFEST_DIR"))).expect("source");
    let mut routes = Vec::new();
    for f in ["main.rs", "replays.rs"] {
        for line in src(f).lines() {
            if let Some(rest) = line.trim().strip_prefix(".route(\"") {
                routes.push(rest.split('"').next().expect("path").to_owned());
            }
        }
    }
    assert!(routes.len() > 20, "{routes:?}");
    let known: Vec<String> = BOARD_ROUTES.iter().chain(SESSION_ROUTES).map(|(_, p, _)| template(p)).chain(ROOMLESS.iter().map(|s| s.to_string())).collect();
    for r in &routes {
        assert!(known.contains(r), "route {r} is in no kind table: add it to BOARD_ROUTES, SESSION_ROUTES or ROOMLESS");
    }
}

/// §3.6, §9.2: each kind's id and token on the other kind's routes is refused, never served.
#[tokio::test(flavor = "multi_thread")]
async fn kind_confusion_is_refused_on_every_route() {
    let server = Server::start(&[]);
    let p = server.port;
    let (board, owner) = server.create_board();
    let session = server.create_session("Kinds", Some((&board, &owner)));
    let grant = session.grant.as_ref().expect("grant")["grant_id"].as_str().expect("id").to_owned();
    let refused = |s: u16| matches!(s, 401 | 403 | 404);
    for (method, path, has_body) in BOARD_ROUTES {
        // A session's id and token on a board route; a session's token on a board's route.
        for (room, token) in [(&session.id, &session.owner), (&board, &session.owner)] {
            let (s, b) = server.call(method, &path.replace("{b}", room), Some(&bearer(token)), body_for(path, *has_body));
            assert!(refused(s), "{method} {path} answered {s} to a session token: {b}");
        }
        // A grant naming the session as the board.
        let (s, _) = server.call(method, &path.replace("{b}", &session.id), Some(&grant_auth(&session.id, &grant, &session.owner)), body_for(path, *has_body));
        assert!(refused(s), "{method} {path}: grant onto the session itself answered {s}");
    }
    for (method, path, has_body) in SESSION_ROUTES {
        let body = if path.ends_with("/grants") { Some(serde_json::json!({ "board": board, "board_token": owner })) } else { body_for(path, *has_body) };
        // A board's id and token on a session route; a board's token on the session's route.
        for (room, token) in [(&board, &owner), (&session.id, &owner)] {
            let (s, b) = server.call(method, &path.replace("{b}", room), Some(&bearer(token)), body.clone());
            assert!(refused(s), "{method} {path} answered {s} to a board token: {b}");
        }
    }
    // Sessions aren't boards to POST /api/sessions either: a session's token as board_token.
    let (s, _) = server.json("POST", "/api/sessions", None, serde_json::json!({ "board": session.id, "board_token": session.owner }));
    assert_eq!(s, 403);
    // The socket: a session token on a board; a board token through `via`; `via` onto the session.
    assert_eq!(ws_join(p, &board, &session.owner).await, Joined::Closed(CloseReason::Unauthorized));
    assert_eq!(ws_via(p, &board, &session.id, &grant, &owner).await.0, Joined::Closed(CloseReason::Unauthorized));
    assert_eq!(ws_via(p, &session.id, &session.id, &grant, &session.owner).await.0, Joined::Closed(CloseReason::Unauthorized));
    // The session's own connection is the session's room, at the session's role.
    assert_eq!(ws_join(p, &session.id, &session.owner).await, Joined::Role(LinkRole::Owner));
    // Records of the other kind are refused by each room.
    let mut s_raw = Raw::open(p, &session.id, &session.owner, 0x81).await;
    let doc = Raw::open(p, &board, &owner, 0x82).await.doc();
    let scene = doc.iter_live().find(|(_, r)| matches!(r, mapcro_schema::Record::Scene(_))).map(|(id, _)| id).expect("scene");
    let note = mapcro_schema::Record::Note(mapcro_schema::Note { scene, text: "n".into() });
    assert_eq!(s_raw.submit(vec![mapcro_schema::Op::Create { id: rid(), record: note }]).await, Err(mapcro_schema::Reject::WrongDocKind));
    let mut b_raw = Raw::open(p, &board, &owner, 0x83).await;
    assert_eq!(b_raw.submit(vec![mapcro_schema::Op::Create { id: rid(), record: tab_record(&board, &grant, "x") }]).await, Err(mapcro_schema::Reject::WrongDocKind));
}

/// §9.2: a grant of session X with a token of session Y is refused, and a grant id from another
/// session doesn't name a grant here.
#[tokio::test(flavor = "multi_thread")]
async fn grants_do_not_cross_sessions() {
    let server = Server::start(&[]);
    let (board, owner) = server.create_board();
    let x = server.create_session("X", Some((&board, &owner)));
    let y = server.create_session("Y", Some((&board, &owner)));
    let gx = x.grant.as_ref().expect("grant")["grant_id"].as_str().expect("id").to_owned();
    let gy = y.grant.as_ref().expect("grant")["grant_id"].as_str().expect("id").to_owned();
    assert_eq!(server.http_role(&board, &grant_auth(&x.id, &gx, &x.owner)), Some(LinkRole::Edit));
    assert_eq!(server.http_role(&board, &grant_auth(&x.id, &gx, &y.owner)), None, "X's grant, Y's token");
    assert_eq!(server.http_role(&board, &grant_auth(&y.id, &gx, &y.owner)), None, "X's grant named in Y");
    assert_eq!(server.http_role(&board, &grant_auth(&x.id, &gy, &x.owner)), None, "Y's grant named in X");
    assert_eq!(ws_via(server.port, &board, &x.id, &gx, &y.owner).await.0, Joined::Closed(CloseReason::Unauthorized));
    // A grant for one board doesn't open another.
    let (other, _) = server.create_board();
    assert_eq!(server.http_role(&other, &grant_auth(&x.id, &gx, &x.owner)), None);
    assert_eq!(ws_via(server.port, &other, &x.id, &gx, &x.owner).await.0, Joined::Closed(CloseReason::Unauthorized));
    // The board's owner sees each grant in its list, labelled with its session.
    let (_, list) = server.call("GET", &format!("/api/boards/{board}/links"), Some(&bearer(&owner)), None);
    assert!(list.contains("\"label\":\"Session: X\"") && list.contains("\"label\":\"Session: Y\""), "{list}");
}

/// §9.2, §3.7: live connections through a session close when the grant, its parent link, the
/// session link (in every board room, by `via_hash`) or the tab goes; a restore lets a new one in.
#[tokio::test(flavor = "multi_thread")]
async fn revocation_and_removal_close_live_tab_connections() {
    let server = Server::start(&[]);
    let p = server.port;
    let session = server.create_session("Live", None);
    let mut editor = Raw::open(p, &session.id, &session.owner, 0x91).await;
    let direct = add_board(&server, &session, &mut editor, "edit").await;
    let parent = add_board(&server, &session, &mut editor, "edit").await;
    let removed = add_board(&server, &session, &mut editor, "edit").await;
    let (s_link_id, s_edit) = server.mint_session(&session.id, &session.owner, "edit");
    // The grant itself, revoked from the board's Share list.
    let (j, mut ws) = ws_via(p, &direct.board, &session.id, &direct.grant, &session.owner).await;
    assert_eq!(j, Joined::Role(LinkRole::Edit));
    let (j, mut own) = auth_frame(p, serde_json::json!({ "t": "auth", "board": direct.board, "token": direct.owner, "known_seq": null })).await;
    assert_eq!(j, Joined::Role(LinkRole::Owner));
    let ids = server.grant_link_id(&direct.board, &direct.owner);
    assert_eq!(server.revoke(&direct.board, &direct.owner, &ids[0]), 204);
    assert_eq!(closed(&mut ws).await, Some(CloseReason::Revoked));
    assert!(tokio::time::timeout(Duration::from_millis(300), closed(&mut own)).await.is_err(), "the board's own owner stays");
    // The adder's link, by cascade.
    let (_, mut ws) = ws_via(p, &parent.board, &session.id, &parent.grant, &session.owner).await;
    assert_eq!(server.revoke(&parent.board, &parent.owner, &parent.adder_id), 204);
    assert_eq!(closed(&mut ws).await, Some(CloseReason::Revoked));
    // Tab removal closes it; a restore lets a new connection in.
    let (_, mut ws) = ws_via(p, &removed.board, &session.id, &removed.grant, &s_edit).await;
    editor.submit(vec![mapcro_schema::Op::Delete { id: removed.tab }]).await.expect("remove");
    assert_eq!(closed(&mut ws).await, Some(CloseReason::Revoked));
    assert_eq!(ws_via(p, &removed.board, &session.id, &removed.grant, &s_edit).await.0, Joined::Closed(CloseReason::Unauthorized));
    editor.submit(vec![mapcro_schema::Op::Restore { id: removed.tab }]).await.expect("restore");
    let (j, mut ws_board) = ws_via(p, &removed.board, &session.id, &removed.grant, &s_edit).await;
    assert_eq!(j, Joined::Role(LinkRole::Edit));
    // The session link: its session socket and its board socket both close.
    let (j, mut ws_session) = auth_frame(p, serde_json::json!({ "t": "auth", "board": session.id, "token": s_edit, "known_seq": null })).await;
    assert_eq!(j, Joined::Role(LinkRole::Edit));
    let (_, mut ws_owner_board) = ws_via(p, &removed.board, &session.id, &removed.grant, &session.owner).await;
    assert_eq!(server.revoke_session(&session.id, &session.owner, &s_link_id), 204);
    assert_eq!(closed(&mut ws_board).await, Some(CloseReason::Revoked));
    assert_eq!(closed(&mut ws_session).await, Some(CloseReason::Revoked));
    assert!(tokio::time::timeout(Duration::from_millis(300), closed(&mut ws_owner_board)).await.is_err(), "another member stays");
    // Rotating the session's owner token closes what the old one opened, boards included.
    let (s, b) = server.call("POST", &format!("/api/sessions/{}/owner/rotate", session.id), Some(&bearer(&session.owner)), None);
    assert_eq!(s, 200, "{b}");
    assert_eq!(closed(&mut ws_owner_board).await, Some(CloseReason::Revoked));
    let new_owner: serde_json::Value = serde_json::from_str(&b).expect("json");
    let new_owner = new_owner["owner_token"].as_str().expect("token");
    assert_eq!(ws_via(p, &removed.board, &session.id, &removed.grant, new_owner).await.0, Joined::Role(LinkRole::Edit), "the new owner token opens the tab");
}

/// §9.2: no board token in the session's document, in any answer to a session-derived caller,
/// or in the server's log at debug.
#[tokio::test(flavor = "multi_thread")]
async fn no_board_token_leaks_to_the_session_or_the_log() {
    let server = Server::start(&[("RUST_LOG", "debug")]);
    let p = server.port;
    let (board, owner) = server.create_board();
    let (_, edit) = server.mint(&board, &owner, "edit");
    let (_, view) = server.mint(&board, &owner, "view");
    let session = server.create_session("Leaks", Some((&board, &owner)));
    let g0 = session.grant.as_ref().expect("grant")["grant_id"].as_str().expect("id").to_owned();
    let (g1, _) = server.grant_ok(&session.id, &session.owner, &board, &edit, None);
    let (g2, _) = server.grant_ok(&session.id, &session.owner, &board, &view, Some("view"));
    let mut editor = Raw::open(p, &session.id, &session.owner, 0xa1).await;
    for g in [&g1, &g2] {
        editor.submit(vec![mapcro_schema::Op::Create { id: rid(), record: tab_record(&board, g, "Tab") }]).await.expect("tab");
    }
    let mut answers = String::new();
    // Everything a session member can be told: the session's document and its log, every board
    // route through each grant, the socket's Ready.
    let member = Raw::open(p, &session.id, &session.owner, 0xa2).await;
    answers.push_str(&member.seen.join("\n"));
    answers.push_str(&editor.seen.join("\n"));
    for g in [&g0, &g1, &g2] {
        let auth = grant_auth(&session.id, g, &session.owner);
        for (method, path, has_body) in BOARD_ROUTES.iter().filter(|(_, p, _)| !p.ends_with("/owner/rotate")) {
            answers.push_str(&server.call(method, &path.replace("{b}", &board), Some(&auth), body_for(path, *has_body)).1);
        }
        let (_, mut ws) = ws_via(p, &board, &session.id, g, &session.owner).await;
        send(&mut ws, &serde_json::json!({ "t": "nonsense" })).await;
        answers.push_str(&format!("{:?}", closed(&mut ws).await));
    }
    let (_, list) = server.call("GET", &format!("/api/sessions/{}/links", session.id), Some(&bearer(&session.owner)), None);
    answers.push_str(&list);
    assert!(answers.contains(&board), "the check looked at real answers");
    let log = server.log();
    assert!(log.contains("DEBUG") || log.contains("INFO"), "the log was captured at debug: {log}");
    for (what, t) in [("owner", &owner), ("edit", &edit), ("view", &view)] {
        assert!(!answers.contains(t.as_str()), "the {what} board token reached a session member");
        assert!(!log.contains(t.as_str()), "the {what} board token is in the log");
    }
    assert!(!log.contains(session.owner.as_str()), "the session token is in the log");
}

/// §9.2, §3.8: grants are limited per session link and per address, session creation counts
/// toward the board creation limiter, and the tab cap holds on the server.
#[tokio::test(flavor = "multi_thread")]
async fn abuse_limits_hold() {
    let server = Server::start(&[]);
    // A fresh board each time: adding one board again returns its grant, and a board holds 50.
    let board = || server.create_board();
    let a = server.create_session("A", None);
    for i in 0..120 {
        let (b, o) = board();
        assert_eq!(server.add_grant(&a.id, &a.owner, &b, &o, None).0, 201, "grant {i}");
    }
    let (b, o) = board();
    assert_eq!(server.add_grant(&a.id, &a.owner, &b, &o, None).0, 429, "the link's hour is spent");
    let (_, a_edit) = server.mint_session(&a.id, &a.owner, "edit");
    for i in 0..120 {
        let (b, o) = board();
        assert_eq!(server.add_grant(&a.id, &a_edit, &b, &o, None).0, 201, "second link, grant {i}");
    }
    let s_b = server.create_session("B", None);
    let (b, o) = board();
    assert_eq!(server.add_grant(&s_b.id, &s_b.owner, &b, &o, None).0, 429, "the address's hour is spent");
    drop(server);

    // Sessions count toward the creation limiter, as boards do.
    let server = Server::start(&[("CREATE_PER_HOUR", "2")]);
    server.create_board();
    server.create_session("one", None);
    let (s, _) = server.json("POST", "/api/sessions", None, serde_json::json!({ "title": "two" }));
    assert_eq!(s, 429);
    let (s, _) = server.json("POST", "/api/boards", None, serde_json::json!({ "title": "x" }));
    assert_eq!(s, 429);
    drop(server);

    // 2,000 tabs, removed ones included: one more is `SessionFull`.
    let server = Server::start(&[]);
    let s = server.create_session("Full", None);
    let mut editor = Raw::open(server.port, &s.id, &s.owner, 0xb1).await;
    let fake = "f".repeat(22);
    let mut made = 0;
    while made < mapcro_schema::LIMITS.max_tabs {
        let n = (mapcro_schema::LIMITS.max_tabs - made).min(200);
        let ops = (0..n).map(|_| mapcro_schema::Op::Create { id: rid(), record: tab_record(&fake, &fake, "t") }).collect();
        editor.submit(ops).await.expect("under the cap");
        made += n;
    }
    assert_eq!(editor.submit(vec![mapcro_schema::Op::Create { id: rid(), record: tab_record(&fake, &fake, "t") }]).await, Err(mapcro_schema::Reject::SessionFull));
}

/// §7.3: a session made from a board opens that board as its first tab at once, through a
/// grant at the adder's role (capped at edit), and the board's own links work as before.
#[tokio::test(flavor = "multi_thread")]
async fn a_board_becomes_a_session_and_stays_as_it_was() {
    let server = Server::start(&[]);
    let p = server.port;
    let (board, owner) = server.create_board();
    let (_, view) = server.mint(&board, &owner, "view");
    let s = server.create_session("From a board", Some((&board, &view)));
    let g = s.grant.as_ref().expect("grant");
    assert_eq!((g["board"].as_str(), g["role"].as_str()), (Some(board.as_str()), Some("view")));
    let grant = g["grant_id"].as_str().expect("id");
    let doc = Raw::open(p, &s.id, &s.owner, 0xc1).await.doc();
    assert_eq!(doc.kind(), mapcro_schema::DocKind::Session);
    let tabs: Vec<_> = doc.iter_live().filter_map(|(id, r)| if let mapcro_schema::Record::Tab(t) = r { Some((id, t.clone())) } else { None }).collect();
    assert_eq!(tabs.len(), 1);
    assert_eq!((tabs[0].1.board.0.as_str(), tabs[0].1.grant.0.as_str(), tabs[0].1.name.as_str()), (board.as_str(), grant, "Board"));
    assert_eq!(s.tab.as_deref(), Some(serde_json::to_value(tabs[0].0).expect("id").as_str().expect("str")));
    assert_eq!(ws_via(p, &board, &s.id, grant, &s.owner).await.0, Joined::Role(LinkRole::View), "a view link added stays view");
    assert_eq!(ws_join(p, &board, &owner).await, Joined::Role(LinkRole::Owner));
    assert_eq!(ws_join(p, &board, &view).await, Joined::Role(LinkRole::View));
    // A revoked or wrong board link makes no session.
    let (s2, _) = server.json("POST", "/api/sessions", None, serde_json::json!({ "board": board, "board_token": links_like() }));
    assert_eq!(s2, 403);
    let (s3, _) = server.json("POST", "/api/sessions", None, serde_json::json!({ "board": board }));
    assert_eq!(s3, 400);
}

/// A plausible token nobody holds.
fn links_like() -> String {
    "A".repeat(43)
}

/// §3.8: junk tabs open nothing. A tab naming one board with another board's grant opens neither
/// the named board nor, once the real tab is gone, the grant's own board.
#[tokio::test(flavor = "multi_thread")]
async fn junk_tabs_open_nothing() {
    let server = Server::start(&[]);
    let p = server.port;
    let session = server.create_session("Junk", None);
    let mut editor = Raw::open(p, &session.id, &session.owner, 0xd1).await;
    let real = add_board(&server, &session, &mut editor, "edit").await;
    let (other, _) = server.create_board();
    editor.submit(vec![mapcro_schema::Op::Create { id: rid(), record: tab_record(&other, &real.grant, "Junk") }]).await.expect("an editor may write junk");
    let auth = grant_auth(&session.id, &real.grant, &session.owner);
    assert_eq!(server.http_role(&other, &auth), None, "another board's grant opens nothing");
    assert_eq!(ws_via(p, &other, &session.id, &real.grant, &session.owner).await.0, Joined::Closed(CloseReason::Unauthorized));
    assert_eq!(server.http_role(&real.board, &auth), Some(LinkRole::Edit));
    editor.submit(vec![mapcro_schema::Op::Delete { id: real.tab }]).await.expect("remove");
    assert_eq!(server.http_role(&real.board, &auth), None, "a junk tab with the grant doesn't keep its board open");
    assert_eq!(ws_via(p, &real.board, &session.id, &real.grant, &session.owner).await.0, Joined::Closed(CloseReason::Unauthorized));
    let made_up = "z".repeat(22);
    editor.submit(vec![mapcro_schema::Op::Create { id: rid(), record: tab_record(&real.board, &made_up, "Made up") }]).await.expect("junk");
    assert_eq!(server.http_role(&real.board, &grant_auth(&session.id, &made_up, &session.owner)), None);
}

// ---- the security review of phase 1 (2026-11-12) ----

impl Server {
    /// `DELETE /api/sessions/{s}/grants/{g}` with `Authorization: <auth>`: (status, body).
    fn withdraw(&self, session: &str, grant: &str, auth: Option<&str>) -> (u16, String) {
        self.call("DELETE", &format!("/api/sessions/{session}/grants/{grant}"), auth, None)
    }

    /// The board's "Session: …" links rows as the owner lists them: (link id, revoked).
    fn grant_rows(&self, board: &str, owner: &str) -> Vec<(String, bool)> {
        let (s, b) = self.call("GET", &format!("/api/boards/{board}/links"), Some(&bearer(owner)), None);
        assert_eq!(s, 200, "{b}");
        let v: serde_json::Value = serde_json::from_str(&b).expect("json");
        v.as_array()
            .expect("list")
            .iter()
            .filter(|l| l["label"].as_str().is_some_and(|x| x.starts_with("Session: ")))
            .map(|l| (l["link_id"].as_str().expect("id").to_owned(), l["revoked"].as_bool().expect("revoked")))
            .collect()
    }
}

/// §3.7: the session's owner, or the session link that added a grant, withdraws it: its links
/// row on the board is revoked and connections through it close. Anyone else, a grant
/// credential, a board's token or an unknown grant are refused, and refusals don't say which
/// check failed.
#[tokio::test(flavor = "multi_thread")]
async fn a_grant_is_withdrawn_from_the_session_side() {
    let server = Server::start(&[]);
    let p = server.port;
    let (board, owner) = server.create_board();
    let (_, view) = server.mint(&board, &owner, "view");
    let session = server.create_session("Withdraw", None);
    let (_, adder) = server.mint_session(&session.id, &session.owner, "view");
    let (_, other) = server.mint_session(&session.id, &session.owner, "edit");
    // The adder is an edit link (view links can't add) that isn't the owner.
    let (_, adder_edit) = server.mint_session(&session.id, &session.owner, "edit");
    let (grant, _) = server.grant_ok(&session.id, &adder_edit, &board, &view, None);
    let mut editor = Raw::open(p, &session.id, &session.owner, 0xe1).await;
    editor.submit(vec![mapcro_schema::Op::Create { id: rid(), record: tab_record(&board, &grant, "Game") }]).await.expect("tab");
    let (j, mut ws) = ws_via(p, &board, &session.id, &grant, &session.owner).await;
    assert_eq!(j, Joined::Role(LinkRole::View));

    // Refused: no credential, a grant credential, the board's own token, another session link
    // (edit or view), and an unknown grant.
    assert_eq!(server.withdraw(&session.id, &grant, None).0, 401);
    assert_eq!(server.withdraw(&session.id, &grant, Some(&grant_auth(&session.id, &grant, &session.owner))).0, 403);
    assert_eq!(server.withdraw(&session.id, &grant, Some(&bearer(&owner))).0, 403);
    let not_yours = server.withdraw(&session.id, &grant, Some(&bearer(&other)));
    assert_eq!(not_yours.0, 404, "{}", not_yours.1);
    assert_eq!(server.withdraw(&session.id, &grant, Some(&bearer(&adder))).0, 404);
    let unknown = server.withdraw(&session.id, &"q".repeat(22), Some(&bearer(&session.owner)));
    assert_eq!(unknown, not_yours, "not yours and not found read the same");
    let other_session = server.create_session("Other", None);
    assert_eq!(server.withdraw(&other_session.id, &grant, Some(&bearer(&other_session.owner))), not_yours, "a grant id names nothing in another session");
    assert!(tokio::time::timeout(Duration::from_millis(300), closed(&mut ws)).await.is_err(), "nothing was withdrawn");
    assert_eq!(server.grant_rows(&board, &owner).iter().filter(|(_, r)| *r).count(), 0);

    // The adder withdraws it: the row is revoked, the connection closes, the tab opens nothing.
    assert_eq!(server.withdraw(&session.id, &grant, Some(&bearer(&adder_edit))).0, 204);
    assert_eq!(closed(&mut ws).await, Some(CloseReason::Revoked));
    assert_eq!(server.grant_rows(&board, &owner), vec![(server.grant_rows(&board, &owner)[0].0.clone(), true)]);
    assert_eq!(ws_via(p, &board, &session.id, &grant, &session.owner).await.0, Joined::Closed(CloseReason::Unauthorized));
    assert_eq!(server.http_role(&board, &grant_auth(&session.id, &grant, &session.owner)), None);

    // The session's owner withdraws a grant another link added.
    let (grant2, _) = server.grant_ok(&session.id, &other, &board, &owner, None);
    editor.submit(vec![mapcro_schema::Op::Create { id: rid(), record: tab_record(&board, &grant2, "Game") }]).await.expect("tab");
    let (j, mut ws) = ws_via(p, &board, &session.id, &grant2, &other).await;
    assert_eq!(j, Joined::Role(LinkRole::Edit));
    assert_eq!(server.withdraw(&session.id, &grant2, Some(&bearer(&session.owner))).0, 204);
    assert_eq!(closed(&mut ws).await, Some(CloseReason::Revoked));
    // The board's own links are untouched.
    assert_eq!(ws_join(p, &board, &view).await, Joined::Role(LinkRole::View));
    assert_eq!(ws_join(p, &board, &owner).await, Joined::Role(LinkRole::Owner));
}

/// §3.2, §3.8: adding the same board through the same link at the same role again gives the
/// same grant and writes nothing on the board; a different role, or after the grant is
/// revoked, is a new grant.
#[tokio::test(flavor = "multi_thread")]
async fn adding_a_board_again_returns_its_grant() {
    let server = Server::start(&[]);
    let (board, owner) = server.create_board();
    let (_, view) = server.mint(&board, &owner, "view");
    let (_, edit) = server.mint(&board, &owner, "edit");
    let session = server.create_session("Again", None);
    let (g1, r1) = server.grant_ok(&session.id, &session.owner, &board, &view, None);
    let (s, again) = server.add_grant(&session.id, &session.owner, &board, &view, None);
    assert_eq!(s, 200, "{again}");
    assert_eq!((again["grant_id"].as_str(), again["role"].as_str()), (Some(g1.as_str()), Some(r1.as_str())));
    // A view link asking for edit still gets view: the same grant.
    let (s, again) = server.add_grant(&session.id, &session.owner, &board, &view, Some("edit"));
    assert_eq!((s, again["grant_id"].as_str()), (200, Some(g1.as_str())));
    assert_eq!(server.grant_rows(&board, &owner).len(), 1, "one row on the board");
    // Another link, or another role through the same link, is another grant.
    let (g2, _) = server.grant_ok(&session.id, &session.owner, &board, &edit, None);
    let (g3, r3) = server.grant_ok(&session.id, &session.owner, &board, &edit, Some("view"));
    assert_eq!(r3, "view");
    assert!(g2 != g1 && g3 != g2 && g3 != g1);
    // Another session is another grant.
    let other = server.create_session("Other", None);
    let (g4, _) = server.grant_ok(&other.id, &other.owner, &board, &view, None);
    assert_ne!(g4, g1);
    // Once revoked, adding again makes a new grant.
    assert_eq!(server.withdraw(&session.id, &g1, Some(&bearer(&session.owner))).0, 204);
    let (g5, _) = server.grant_ok(&session.id, &session.owner, &board, &view, None);
    assert_ne!(g5, g1);
    assert_eq!(server.grant_rows(&board, &owner).len(), 5);
}

/// §3.8: one top-level link holds at most 50 live grants on a board, however many sessions add
/// it; past that it's 409, when adding or when making a session from the board, until one of
/// its grants is revoked. The cap is per link now, so this used to be "a board holds at most
/// 50"; another link's allowance is separate.
#[tokio::test(flavor = "multi_thread")]
async fn a_top_level_link_holds_at_most_50_live_grants() {
    let server = Server::start(&[]);
    let (board, owner) = server.create_board();
    let (_, view) = server.mint(&board, &owner, "view");
    for i in 0..50 {
        let s = server.create_session("Many", None);
        assert_eq!(server.add_grant(&s.id, &s.owner, &board, &view, None).0, 201, "grant {i}");
    }
    let s = server.create_session("One too many", None);
    let (code, body) = server.add_grant(&s.id, &s.owner, &board, &view, None);
    assert_eq!(code, 409, "{body}");
    let (code, body) = server.json("POST", "/api/sessions", None, serde_json::json!({ "title": "From it", "board": board, "board_token": view }));
    assert_eq!(code, 409, "{body}");
    // Another board is unaffected.
    let (other, other_owner) = server.create_board();
    assert_eq!(server.add_grant(&s.id, &s.owner, &other, &other_owner, None).0, 201);
    // The board's owner revokes one: there is room again.
    let rows = server.grant_rows(&board, &owner);
    assert_eq!(rows.len(), 50);
    assert_eq!(server.revoke(&board, &owner, &rows[0].0), 204);
    assert_eq!(server.add_grant(&s.id, &s.owner, &board, &view, None).0, 201);
}

/// §3.8: the 50-live-grants cap is per minting link, not board-wide, so a view-link holder
/// filling its own allowance leaves the board owner's untouched.
#[tokio::test(flavor = "multi_thread")]
async fn a_view_link_holders_grants_do_not_fill_the_owners_allowance() {
    let server = Server::start(&[]);
    let (board, owner) = server.create_board();
    let (_, view) = server.mint(&board, &owner, "view");
    for i in 0..50 {
        let s = server.create_session("View's", None);
        assert_eq!(server.add_grant(&s.id, &s.owner, &board, &view, None).0, 201, "grant {i}");
    }
    // The owner's own allowance is untouched: the board still goes into a new session.
    let (code, body) = server.json("POST", "/api/sessions", None, serde_json::json!({ "title": "Owner's", "board": board, "board_token": owner }));
    assert_eq!(code, 201, "{body}");
    // And the owner's grants are their own, not the view holder's.
    let s = server.create_session("Owner's again", None);
    assert_eq!(server.add_grant(&s.id, &s.owner, &board, &owner, None).0, 201);
}

/// §3.8: the cap still bounds what one view-link holder can write: its 51st grant is refused.
#[tokio::test(flavor = "multi_thread")]
async fn a_view_link_holder_is_still_capped_at_50_grants() {
    let server = Server::start(&[]);
    let (board, owner) = server.create_board();
    let (_, view) = server.mint(&board, &owner, "view");
    for i in 0..50 {
        let s = server.create_session("View's", None);
        assert_eq!(server.add_grant(&s.id, &s.owner, &board, &view, None).0, 201, "grant {i}");
    }
    let s = server.create_session("One too many", None);
    let (code, body) = server.add_grant(&s.id, &s.owner, &board, &view, None);
    assert_eq!(code, 409, "{body}");
    // A second view link the owner minted has its own allowance.
    let (_, other_view) = server.mint(&board, &owner, "view");
    let s = server.create_session("Other link", None);
    assert_eq!(server.add_grant(&s.id, &s.owner, &board, &other_view, None).0, 201);
}

/// §3.8: an editor can't dodge its allowance by minting a child link and adding through it:
/// the cap is counted per top-level ancestor link, the one the owner minted.
#[tokio::test(flavor = "multi_thread")]
async fn an_editor_cannot_dodge_the_grant_cap_with_a_child_link() {
    let server = Server::start(&[]);
    let (board, owner) = server.create_board();
    let (_, editor) = server.mint(&board, &owner, "edit");
    let (_, child) = server.mint(&board, &editor, "view");
    for i in 0..50 {
        let s = server.create_session("Editor's", None);
        assert_eq!(server.add_grant(&s.id, &s.owner, &board, &editor, None).0, 201, "grant {i}");
    }
    let s = server.create_session("Through the child", None);
    let (code, body) = server.add_grant(&s.id, &s.owner, &board, &child, None);
    assert_eq!(code, 409, "{body}");
}

/// §3.7: removing one of two tabs with the same grant leaves the other's connections open, and
/// a delete of a tab that's already removed closes nothing; removing the last one closes them.
#[tokio::test(flavor = "multi_thread")]
async fn removing_one_of_two_tabs_on_a_grant_keeps_the_other() {
    let server = Server::start(&[]);
    let p = server.port;
    let session = server.create_session("Twins", None);
    let mut editor = Raw::open(p, &session.id, &session.owner, 0xf1).await;
    let a = add_board(&server, &session, &mut editor, "edit").await;
    let twin = rid();
    editor.submit(vec![mapcro_schema::Op::Create { id: twin, record: tab_record(&a.board, &a.grant, "Twin") }]).await.expect("twin");
    let (j, mut ws) = ws_via(p, &a.board, &session.id, &a.grant, &session.owner).await;
    assert_eq!(j, Joined::Role(LinkRole::Edit));
    editor.submit(vec![mapcro_schema::Op::Delete { id: a.tab }]).await.expect("remove one");
    assert!(tokio::time::timeout(Duration::from_millis(500), closed(&mut ws)).await.is_err(), "the twin still holds the grant");
    // Deleting the removed tab again is skipped: still nothing closes.
    editor.submit(vec![mapcro_schema::Op::Delete { id: a.tab }]).await.expect("delete again");
    assert!(tokio::time::timeout(Duration::from_millis(500), closed(&mut ws)).await.is_err(), "a skipped delete closes nothing");
    // The last one goes: its connections close.
    editor.submit(vec![mapcro_schema::Op::Delete { id: twin }]).await.expect("remove the twin");
    assert_eq!(closed(&mut ws).await, Some(CloseReason::Revoked));
}

/// §3.6: `Ready` says what the room is, so a client can tell a board from a session.
#[tokio::test(flavor = "multi_thread")]
async fn ready_says_what_the_room_is() {
    let server = Server::start(&[]);
    let p = server.port;
    let (board, owner) = server.create_board();
    let session = server.create_session("Kind", Some((&board, &owner)));
    let grant = session.grant.as_ref().expect("grant")["grant_id"].as_str().expect("id").to_owned();
    let kind = |raw: &Raw| serde_json::from_str::<serde_json::Value>(&raw.seen[0]).expect("json")["kind"].clone();
    assert_eq!(kind(&Raw::open(p, &session.id, &session.owner, 0x71).await), "session");
    assert_eq!(kind(&Raw::open(p, &board, &owner, 0x72).await), "board");
    // Through a session, as the client parses it, with a base and without one.
    for known_seq in [serde_json::Value::Null, 0.into()] {
        let mut ws = open_ws(p).await;
        send(&mut ws, &serde_json::json!({ "t": "auth", "board": board, "token": session.owner, "known_seq": known_seq, "via": { "session": session.id, "grant": grant } })).await;
        match recv(&mut ws).await {
            Some(WireOut::Ready { kind, .. }) => assert_eq!(kind, Some(mapcro_engine::wire::RoomKind::Board), "known_seq {known_seq}"),
            other => panic!("{other:?}"),
        }
    }
    let mut ws = open_ws(p).await;
    send(&mut ws, &serde_json::json!({ "t": "auth", "board": session.id, "token": session.owner, "known_seq": 0 })).await;
    match recv(&mut ws).await {
        Some(WireOut::Ready { kind, .. }) => assert_eq!(kind, Some(mapcro_engine::wire::RoomKind::Session)),
        other => panic!("{other:?}"),
    }
}
