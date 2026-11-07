//! System tests (spec §14, layers 2–3): the real server binary, real WebSockets, real SQLite.
//! Clients use the same `Replica` the browser will run.

use futures_util::{SinkExt, StreamExt};
use mapcro_engine::wire::{Base, CloseReason, LinkRole, WireIn, WireOut};
use mapcro_engine::{ClientMsg, Replica, SaveStatus, ServerMsg};
use mapcro_schema::{ClientId, FieldValue, Op, Record, Reject, WorldPos};
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

const ORIGIN: &str = "http://localhost:5173";
type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Server {
    child: Child,
    port: u16,
    dir: std::path::PathBuf,
}

impl Server {
    fn start(dir: &std::path::Path, port: Option<u16>) -> Server {
        Server::start_with(dir, port, &[])
    }

    fn start_with(dir: &std::path::Path, port: Option<u16>, env: &[(&str, &str)]) -> Server {
        let port = port.unwrap_or_else(|| TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).unwrap_or(0));
        let child = Command::new(env!("CARGO_BIN_EXE_mapcro-server"))
            .env("PORT", port.to_string())
            .env("DATA_DIR", dir)
            .env("PUBLIC_ORIGIN", ORIGIN)
            .env("RUST_LOG", "warn")
            .envs(env.iter().copied())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("server starts");
        let s = Server { child, port, dir: dir.to_owned() };
        let deadline = Instant::now() + Duration::from_secs(10);
        while ureq::get(&s.url("/healthz")).call().is_err() {
            assert!(Instant::now() < deadline, "server never became healthy");
            std::thread::sleep(Duration::from_millis(50));
        }
        s
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    /// SIGKILL: no shutdown hooks, no flushing. Durability must not depend on them.
    fn kill9(mut self) -> (std::path::PathBuf, u16) {
        self.child.kill().expect("kill");
        let _ = self.child.wait();
        (self.dir.clone(), self.port)
    }

    fn create_board(&self) -> (String, String) {
        let v: serde_json::Value = ureq::post(&self.url("/api/boards"))
            .send_json(serde_json::json!({ "title": "System test" }))
            .expect("create")
            .body_mut()
            .read_json()
            .expect("json");
        (v["board"].as_str().unwrap_or_default().into(), v["owner_token"].as_str().unwrap_or_default().into())
    }

    fn mint(&self, board: &str, owner: &str, role: &str) -> (String, String) {
        let v: serde_json::Value = ureq::post(&self.url(&format!("/api/boards/{board}/links")))
            .header("authorization", &format!("Bearer {owner}"))
            .send_json(serde_json::json!({ "role": role, "label": "test" }))
            .expect("mint")
            .body_mut()
            .read_json()
            .expect("json");
        (v["link_id"].as_str().unwrap_or_default().into(), v["token"].as_str().unwrap_or_default().into())
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn open_ws(port: u16, origin: &str) -> Result<Ws, String> {
    let mut req = format!("ws://127.0.0.1:{port}/ws").into_client_request().map_err(|e| e.to_string())?;
    req.headers_mut().insert("origin", origin.parse().map_err(|_| "origin")?);
    tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws).map_err(|e| e.to_string())
}

async fn send(ws: &mut Ws, frame: &WireIn) {
    ws.send(Message::Text(serde_json::to_string(frame).unwrap_or_default().into())).await.expect("send");
}

async fn recv(ws: &mut Ws) -> Option<WireOut> {
    loop {
        match tokio::time::timeout(Duration::from_secs(10), ws.next()).await.ok()?? {
            Ok(Message::Text(t)) => return serde_json::from_str(t.as_str()).ok(),
            Ok(Message::Ping(_) | Message::Pong(_)) => continue,
            _ => return None,
        }
    }
}

/// A test client: a real `Replica` over a real socket.
struct Client {
    replica: Option<Replica>,
    id: ClientId,
    ws: Option<Ws>,
    role: Option<LinkRole>,
}

impl Client {
    fn new(id: u128) -> Client {
        Client { replica: None, id: ClientId(id), ws: None, role: None }
    }

    /// Connect and authenticate. Returns the close reason if the server refused.
    async fn connect(&mut self, port: u16, board: &str, token: &str) -> Result<(), Option<CloseReason>> {
        let mut ws = open_ws(port, ORIGIN).await.map_err(|_| None)?;
        let known_seq = self.replica.as_ref().map(Replica::last_seq);
        send(&mut ws, &WireIn::Auth { board: board.into(), token: token.into(), known_seq }).await;
        match recv(&mut ws).await {
            Some(WireOut::Ready { role, base }) => {
                self.role = Some(role);
                if self.replica.is_none() {
                    let Base { doc, seq } = base.expect("a new client gets a base document");
                    self.replica = Some(Replica::new(self.id, doc, seq));
                }
            }
            Some(WireOut::Closed { reason }) => return Err(Some(reason)),
            _ => return Err(None),
        }
        let msgs = self.replica_mut().connect();
        for m in msgs {
            send(&mut ws, &WireIn::Msg { msg: m }).await;
        }
        self.ws = Some(ws);
        Ok(())
    }

    fn replica_mut(&mut self) -> &mut Replica {
        self.replica.as_mut().expect("connected once")
    }

    fn replica(&self) -> &Replica {
        self.replica.as_ref().expect("connected once")
    }

    async fn edit(&mut self, ops: Vec<Op>) {
        let msg = self.replica_mut().edit(ops).expect("valid edit");
        if let (Some(m), Some(ws)) = (msg, self.ws.as_mut()) {
            send(ws, &WireIn::Msg { msg: m }).await;
        }
    }

    /// Process one frame. Returns a close reason if the server closed us.
    async fn pump_one(&mut self) -> Result<(), Option<CloseReason>> {
        let ws = self.ws.as_mut().ok_or(None)?;
        match recv(ws).await {
            Some(WireOut::Msg { msg }) => {
                self.replica.as_mut().ok_or(None)?.receive(msg).expect("protocol");
                Ok(())
            }
            Some(WireOut::Closed { reason }) => Err(Some(reason)),
            _ => Err(None),
        }
    }

    async fn until_saved(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while self.replica().status() != SaveStatus::Saved {
            assert!(Instant::now() < deadline, "never saved: {:?}", self.replica().status());
            self.pump_one().await.expect("connection stays up");
        }
    }

    fn drop_connection(&mut self) {
        self.ws = None;
        if let Some(r) = self.replica.as_mut() {
            r.disconnect();
        }
    }
}

fn players(r: &Replica) -> Vec<mapcro_schema::RecordId> {
    r.view().iter_live().filter(|(_, rec)| matches!(rec, Record::PlayerState(_))).map(|(id, _)| id).collect()
}

fn move_op(r: &Replica, i: usize) -> Vec<Op> {
    let ps = players(r);
    vec![Op::Set { id: ps[i % ps.len()], value: FieldValue::PlayerPos(WorldPos { x: (i as i32) * 7, y: -(i as i32) }) }]
}

#[tokio::test(flavor = "multi_thread")]
async fn acknowledged_edits_survive_kill_9() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let mut a = Client::new(0xa);
    a.connect(server.port, &board, &owner).await.expect("connect");

    let mut made = 0;
    for round in 0..3 {
        // A batch that is fully acknowledged...
        for _ in 0..20 {
            let ops = move_op(a.replica(), made);
            a.edit(ops).await;
            made += 1;
        }
        a.until_saved().await;
        // ...then a burst still in flight when the server is killed.
        for _ in 0..15 {
            let ops = move_op(a.replica(), made);
            a.edit(ops).await;
            made += 1;
        }
        let (d, port) = server.kill9();
        a.drop_connection();
        server = Server::start(&d, Some(port));
        a.connect(server.port, &board, &owner).await.expect("reconnect after restart");
        a.until_saved().await;
        eprintln!("round {round}: {made} edits made, log at {}", a.replica().last_seq());
    }

    // A brand-new client replays the whole board from the server's storage.
    let mut b = Client::new(0xb);
    b.connect(server.port, &board, &owner).await.expect("connect b");
    while b.replica().last_seq() < a.replica().last_seq() {
        b.pump_one().await.expect("catch-up");
    }
    assert_eq!(b.replica().confirmed(), a.replica().confirmed(), "fresh replay equals the survivor");
    assert_eq!(a.replica().last_seq(), made as u64, "every edit applied exactly once");
    assert_eq!(a.replica().next_cseq(), made as u64);
}

#[tokio::test(flavor = "multi_thread")]
async fn view_links_cannot_write() {
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let (_, view) = server.mint(&board, &owner, "view");
    let mut v = Client::new(0x1);
    v.connect(server.port, &board, &view).await.expect("connect");
    assert_eq!(v.role, Some(LinkRole::View));
    let ops = move_op(v.replica(), 0);
    v.edit(ops).await;
    v.pump_one().await.expect("reply");
    assert_eq!(v.replica().rejected(), &[(0, Reject::Forbidden)]);
    assert_eq!(v.replica().last_seq(), 0, "nothing was logged");
}

#[tokio::test(flavor = "multi_thread")]
async fn revoked_links_are_cut_off_immediately() {
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let (link_id, edit) = server.mint(&board, &owner, "edit");
    let mut e = Client::new(0x2);
    e.connect(server.port, &board, &edit).await.expect("connect");
    let ops = move_op(e.replica(), 1);
    e.edit(ops).await;
    e.until_saved().await;

    let status = ureq::delete(&server.url(&format!("/api/boards/{board}/links/{link_id}")))
        .header("authorization", &format!("Bearer {owner}"))
        .call()
        .expect("revoke")
        .status();
    assert_eq!(status, 204);
    assert_eq!(e.pump_one().await, Err(Some(CloseReason::Revoked)));
    e.drop_connection();
    assert_eq!(e.connect(server.port, &board, &edit).await, Err(Some(CloseReason::Unauthorized)));
}

fn list(server: &Server, board: &str, token: &str) -> Result<Vec<serde_json::Value>, ureq::Error> {
    ureq::get(&server.url(&format!("/api/boards/{board}/links")))
        .header("authorization", &format!("Bearer {token}"))
        .call()?
        .body_mut()
        .read_json()
}

fn revoke(server: &Server, board: &str, token: &str, link_id: &str) -> u16 {
    match ureq::delete(&server.url(&format!("/api/boards/{board}/links/{link_id}"))).header("authorization", &format!("Bearer {token}")).call() {
        Ok(r) => r.status().as_u16(),
        Err(ureq::Error::StatusCode(c)) => c,
        Err(e) => panic!("{e}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn editors_share_within_their_own_subtree() {
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let (a_id, a) = server.mint(&board, &owner, "edit"); // editor A
    let (b_id, b) = server.mint(&board, &owner, "edit"); // editor B, A's sibling
    let (av_id, _) = server.mint(&board, &a, "view"); // minted by A
    let (ae_id, ae) = server.mint(&board, &a, "edit"); // minted by A
    let (aev_id, _) = server.mint(&board, &ae, "view"); // minted by A's child

    // View links can't share or list.
    let (_, view) = server.mint(&board, &owner, "view");
    assert!(list(&server, &board, &view).is_err());
    let mint = ureq::post(&server.url(&format!("/api/boards/{board}/links")))
        .header("authorization", &format!("Bearer {view}"))
        .send_json(serde_json::json!({ "role": "view", "label": "x" }));
    assert!(mint.is_err(), "view links cannot mint");

    // An editor sees exactly its descendants; the owner sees everything.
    let ids = |v: Vec<serde_json::Value>| {
        let mut ids: Vec<String> = v.iter().map(|l| l["link_id"].as_str().unwrap_or_default().to_owned()).collect();
        ids.sort();
        ids
    };
    let mut expect = vec![av_id.clone(), ae_id.clone(), aev_id.clone()];
    expect.sort();
    assert_eq!(ids(list(&server, &board, &a).expect("list")), expect);
    assert!(list(&server, &board, &b).expect("list").is_empty());
    assert_eq!(list(&server, &board, &owner).expect("list").len(), 7); // owner, a, b, av, ae, aev, view

    // An editor can't revoke a sibling, an ancestor, itself or the owner; the response doesn't
    // tell "not yours" from "not found".
    assert_eq!(revoke(&server, &board, &b, &a_id), 404);
    assert_eq!(revoke(&server, &board, &ae, &a_id), 404);
    assert_eq!(revoke(&server, &board, &a, &a_id), 404);
    assert_eq!(revoke(&server, &board, &a, &b_id), 404);
    // But it can revoke inside its subtree.
    assert_eq!(revoke(&server, &board, &a, &aev_id), 204);
}

#[tokio::test(flavor = "multi_thread")]
async fn revocation_cascades_and_cuts_live_sessions() {
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let (leaked_id, leaked) = server.mint(&board, &owner, "edit");
    let (_, child) = server.mint(&board, &leaked, "edit");
    let (_, grandchild) = server.mint(&board, &child, "view");
    let (_, unrelated) = server.mint(&board, &owner, "view");

    let mut sessions = Vec::new();
    for (i, t) in [&leaked, &child, &grandchild, &unrelated].into_iter().enumerate() {
        let mut c = Client::new(0x100 + i as u128);
        c.connect(server.port, &board, t).await.expect("connect");
        sessions.push(c);
    }
    assert_eq!(revoke(&server, &board, &owner, &leaked_id), 204);
    for c in &mut sessions[..3] {
        assert_eq!(c.pump_one().await, Err(Some(CloseReason::Revoked)));
    }
    for t in [&leaked, &child, &grandchild] {
        assert_eq!(Client::new(0x200).connect(server.port, &board, t).await, Err(Some(CloseReason::Unauthorized)));
    }
    // The unrelated link is untouched: it still connects.
    Client::new(0x300).connect(server.port, &board, &unrelated).await.expect("unrelated link still works");
    // A revoked editor can no longer mint.
    let mint = ureq::post(&server.url(&format!("/api/boards/{board}/links")))
        .header("authorization", &format!("Bearer {leaked}"))
        .send_json(serde_json::json!({ "role": "view", "label": "x" }));
    assert!(mint.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn rejections_survive_a_restart() {
    // A rejection the client has heard about must still count after a restart; otherwise the
    // client's next transaction looks like a sequence gap and it gets thrown off.
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let (_, view) = server.mint(&board, &owner, "view");
    let mut v = Client::new(0x9);
    v.connect(server.port, &board, &view).await.expect("connect");
    let ops = move_op(v.replica(), 0);
    v.edit(ops).await;
    v.pump_one().await.expect("rejection");
    assert_eq!(v.replica().rejected().len(), 1);

    let (d, port) = server.kill9();
    v.drop_connection();
    let server = Server::start(&d, Some(port));
    v.connect(server.port, &board, &view).await.expect("reconnect");
    let ops = move_op(v.replica(), 1);
    v.edit(ops).await;
    v.pump_one().await.expect("second rejection, not a protocol error");
    assert_eq!(v.replica().rejected(), &[(0, Reject::Forbidden), (1, Reject::Forbidden)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_credentials_and_hostile_frames_are_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let (other_board, _) = server.create_board();

    // Cross-site WebSocket: refused at the upgrade.
    assert!(open_ws(server.port, "https://evil.example").await.is_err());

    // Unknown token, and a real token for the wrong board.
    let fake = "A".repeat(43);
    assert_eq!(Client::new(3).connect(server.port, &board, &fake).await, Err(Some(CloseReason::Unauthorized)));
    assert_eq!(Client::new(4).connect(server.port, &other_board, &owner).await, Err(Some(CloseReason::Unauthorized)));

    // Garbage after auth.
    let mut c = Client::new(5);
    c.connect(server.port, &board, &owner).await.expect("connect");
    let ws = c.ws.as_mut().expect("ws");
    ws.send(Message::Text("not json".into())).await.expect("send");
    assert_eq!(c.pump_one().await, Err(Some(CloseReason::Abuse)));

    // Oversized frame: the connection is dropped.
    let mut c = Client::new(6);
    c.connect(server.port, &board, &owner).await.expect("connect");
    let ws = c.ws.as_mut().expect("ws");
    let _ = ws.send(Message::Text("x".repeat(300 * 1024).into())).await;
    assert!(c.pump_one().await.is_err(), "oversized frame must close the connection");

    // Protocol abuse: a transaction claiming another client's id.
    let mut c = Client::new(7);
    c.connect(server.port, &board, &owner).await.expect("connect");
    let ops = move_op(c.replica(), 0);
    let tx = mapcro_schema::Tx { client: ClientId(0xdead), cseq: 0, kind: mapcro_schema::TxKind::Edit, ops };
    let ws = c.ws.as_mut().expect("ws");
    send(ws, &WireIn::Msg { msg: ClientMsg::Submit(tx) }).await;
    match recv(ws).await {
        Some(WireOut::Msg { msg: ServerMsg::Fatal(_) }) => {}
        other => panic!("expected Fatal, got {other:?}"),
    }
    assert_eq!(recv(ws).await, Some(WireOut::Closed { reason: CloseReason::Protocol }));
}

fn open_rooms(server: &Server) -> usize {
    let body = ureq::get(&server.url("/healthz")).call().expect("healthz").body_mut().read_to_string().expect("body");
    body.trim().strip_prefix("ok rooms=").and_then(|n| n.parse().ok()).expect("rooms count")
}

#[tokio::test(flavor = "multi_thread")]
async fn idle_rooms_unload_and_reload_intact() {
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start_with(dir.path(), None, &[("ROOM_IDLE_SECS", "1")]);
    let (board, owner) = server.create_board();
    let mut a = Client::new(0x11);
    a.connect(server.port, &board, &owner).await.expect("connect");
    for i in 0..5 {
        let ops = move_op(a.replica(), i);
        a.edit(ops).await;
    }
    a.until_saved().await;
    assert_eq!(open_rooms(&server), 1);
    a.ws = None; // close the socket: the room is now empty
    a.replica_mut().disconnect();
    let deadline = Instant::now() + Duration::from_secs(10);
    while open_rooms(&server) != 0 {
        assert!(Instant::now() < deadline, "room never unloaded");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // Reload from storage on the next join, with nothing lost.
    let mut b = Client::new(0x12);
    b.connect(server.port, &board, &owner).await.expect("connect after unload");
    while b.replica().last_seq() < 5 {
        b.pump_one().await.expect("catch-up");
    }
    assert_eq!(b.replica().confirmed(), a.replica().confirmed());
    assert_eq!(open_rooms(&server), 1);
}
