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
            .stdout(Stdio::null());
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

    fn log(&self) -> String {
        self.stderr.lock().unwrap_or_else(|e| e.into_inner()).clone()
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
