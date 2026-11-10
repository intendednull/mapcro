//! System tests (spec §14, layers 2–3): the real server binary, real WebSockets, real SQLite.
//! Clients use the same `Replica` the browser will run.

use futures_util::{SinkExt, StreamExt};
use mapcro_engine::wire::{Base, CloseReason, LinkRole, WireIn, WireOut};
use mapcro_engine::{ClientMsg, Replica, SaveStatus, ServerMsg};
use mapcro_schema::{ClientId, FieldValue, Op, Record, Reject, WorldPos};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

mod support;

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
        // A first start takes a free port of its own (support.rs). A restart is given the port
        // the killed server had, so clients come back to it; another process may have taken it
        // in between, and then our child exits with `cannot bind`. Wait for it to come free.
        // That stranger may be another test's server, which holds it for that test's life.
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let mut cmd = support::server();
            if let Some(p) = port {
                cmd.env("PORT", p.to_string());
            }
            cmd.env("DATA_DIR", dir).env("PUBLIC_ORIGIN", ORIGIN).env("RUST_LOG", "warn").envs(env.iter().copied()).stdout(Stdio::null());
            match support::start(cmd) {
                Ok(s) => return Server { child: s.child, port: s.port, dir: dir.to_owned() },
                Err(e) if port.is_some() && e.bind_failed() && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(200));
                }
                Err(e) => panic!("mapcro-server exited before listening ({}): {}", e.status, e.stderr.trim_end()),
            }
        }
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

/// The next frame, or `None` if the server closed the socket (or sent something unreadable).
/// Ten seconds of silence is no close: it fails the test as what it is.
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

/// A test client: a real `Replica` over a real socket.
struct Client {
    replica: Option<Replica>,
    id: ClientId,
    ws: Option<Ws>,
    role: Option<LinkRole>,
    /// Latest presence per peer, as relayed by the server.
    peers: std::collections::BTreeMap<u64, mapcro_engine::wire::PeerPresence>,
}

impl Client {
    fn new(id: u128) -> Client {
        Client { replica: None, id: ClientId(id), ws: None, role: None, peers: Default::default() }
    }

    /// Connect and authenticate. Returns the close reason if the server refused.
    async fn connect(&mut self, port: u16, board: &str, token: &str) -> Result<(), Option<CloseReason>> {
        let mut ws = open_ws(port, ORIGIN).await.map_err(|_| None)?;
        let known_seq = self.replica.as_ref().map(Replica::last_seq);
        send(&mut ws, &WireIn::Auth { board: board.into(), token: token.into(), known_seq, build: None }).await;
        match recv(&mut ws).await {
            Some(WireOut::Ready { role, base, .. }) => {
                self.role = Some(role);
                if self.replica.is_none() {
                    let Base { doc, seq } = base.expect("a new client gets a base document");
                    self.replica = Some(Replica::new(self.id, format!("secret-{:032x}", self.id.0), doc, seq));
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
            Some(WireOut::Presence { peers }) => {
                for p in peers {
                    self.peers.insert(p.peer, p);
                }
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

    /// Make an edit; false if sending it found the connection gone (it stays pending).
    #[cfg(feature = "failpoints")]
    async fn try_edit(&mut self, ops: Vec<Op>) -> bool {
        let msg = self.replica_mut().edit(ops).expect("valid edit");
        match (msg, self.ws.as_mut()) {
            (Some(m), Some(ws)) => ws.send(Message::Text(serde_json::to_string(&WireIn::Msg { msg: m }).unwrap_or_default().into())).await.is_ok(),
            _ => true,
        }
    }

    /// Process whatever arrives for `d`. False if the connection was lost.
    #[cfg(feature = "failpoints")]
    async fn pump_for(&mut self, d: Duration) -> bool {
        let end = tokio::time::Instant::now() + d;
        loop {
            let Some(ws) = self.ws.as_mut() else { return false };
            let frame = match tokio::time::timeout_at(end, ws.next()).await {
                Err(_) => return true, // quiet: still connected
                Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str::<WireOut>(t.as_str()).ok(),
                Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
                _ => return false,
            };
            match frame {
                Some(WireOut::Msg { msg }) => {
                    if self.replica_mut().receive(msg).is_err() {
                        return false;
                    }
                }
                Some(WireOut::Presence { peers }) => {
                    for p in peers {
                        self.peers.insert(p.peer, p);
                    }
                }
                _ => return false,
            }
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
    // An honest UI never sends this; the server treats it as abuse and stores nothing.
    let ops = move_op(v.replica(), 0);
    v.edit(ops).await;
    let ws = v.ws.as_mut().expect("ws");
    match recv(ws).await {
        Some(WireOut::Msg { msg: ServerMsg::Fatal(_) }) => {}
        other => panic!("expected Fatal, got {other:?}"),
    }
    let mut o = Client::new(0x2);
    o.connect(server.port, &board, &owner).await.expect("owner");
    assert_eq!(o.replica().last_seq(), 0, "nothing was logged");
}

#[tokio::test(flavor = "multi_thread")]
async fn client_ids_cannot_be_hijacked() {
    // Security review H1: client ids are public (every entry carries one). Claiming one without
    // its secret must fail and must not disturb the real client.
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let (_, view) = server.mint(&board, &owner, "view");
    let mut victim = Client::new(0x51);
    victim.connect(server.port, &board, &owner).await.expect("victim");
    let ops = move_op(victim.replica(), 0);
    victim.edit(ops).await;
    victim.until_saved().await;

    let mut ws = open_ws(server.port, ORIGIN).await.expect("ws");
    send(&mut ws, &WireIn::Auth { board: board.clone(), token: view.clone(), known_seq: Some(0), build: None }).await;
    assert!(matches!(recv(&mut ws).await, Some(WireOut::Ready { .. })));
    let hello = mapcro_engine::Hello { client: ClientId(0x51), secret: "guess".into(), last_seq: 0, pending_from: 0 };
    send(&mut ws, &WireIn::Msg { msg: ClientMsg::Hello(hello) }).await;
    match recv(&mut ws).await {
        Some(WireOut::Msg { msg: ServerMsg::Fatal(why) }) => assert!(why.contains("another client"), "{why}"),
        other => panic!("expected Fatal, got {other:?}"),
    }
    // The victim is still connected and can still edit.
    let ops = move_op(victim.replica(), 1);
    victim.edit(ops).await;
    victim.until_saved().await;

    // And the binding survives a restart.
    let (d, port) = server.kill9();
    victim.drop_connection();
    let server = Server::start(&d, Some(port));
    let mut ws = open_ws(server.port, ORIGIN).await.expect("ws");
    send(&mut ws, &WireIn::Auth { board: board.clone(), token: view, known_seq: Some(0), build: None }).await;
    assert!(matches!(recv(&mut ws).await, Some(WireOut::Ready { .. })));
    let hello = mapcro_engine::Hello { client: ClientId(0x51), secret: "guess".into(), last_seq: 0, pending_from: 0 };
    send(&mut ws, &WireIn::Msg { msg: ClientMsg::Hello(hello) }).await;
    assert!(matches!(recv(&mut ws).await, Some(WireOut::Msg { msg: ServerMsg::Fatal(_) })));
    victim.connect(server.port, &board, &owner).await.expect("victim reconnects with its secret");
    victim.until_saved().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn owner_token_rotation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let (_, edit) = server.mint(&board, &owner, "edit");
    let mut o = Client::new(0x61);
    o.connect(server.port, &board, &owner).await.expect("owner");
    let v: serde_json::Value = ureq::post(&server.url(&format!("/api/boards/{board}/owner/rotate")))
        .header("authorization", &format!("Bearer {owner}"))
        .send_empty()
        .expect("rotate")
        .body_mut()
        .read_json()
        .expect("json");
    let new_owner = v["owner_token"].as_str().expect("token").to_owned();
    assert_eq!(o.pump_one().await, Err(Some(CloseReason::Revoked)), "the old owner session is cut off");
    assert_eq!(Client::new(0x62).connect(server.port, &board, &owner).await, Err(Some(CloseReason::Unauthorized)));
    Client::new(0x63).connect(server.port, &board, &new_owner).await.expect("new owner token works");
    Client::new(0x64).connect(server.port, &board, &edit).await.expect("links minted by the old owner still work");
    assert_eq!(list(&server, &board, &new_owner).expect("new owner manages links").len(), 3);
    // An edit link can't rotate.
    let r = ureq::post(&server.url(&format!("/api/boards/{board}/owner/rotate"))).header("authorization", &format!("Bearer {edit}")).send_empty();
    assert!(r.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn connections_per_address_are_capped() {
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let mut open = Vec::new();
    for _ in 0..32 {
        open.push(open_ws(server.port, ORIGIN).await.expect("within cap"));
    }
    assert!(open_ws(server.port, ORIGIN).await.is_err(), "33rd connection from one address is refused");
    drop(open.pop());
    tokio::time::sleep(Duration::from_millis(200)).await;
    open_ws(server.port, ORIGIN).await.expect("a slot frees when a socket closes");
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
    let mut a = Client::new(0x8);
    let mut b = Client::new(0x9);
    a.connect(server.port, &board, &owner).await.expect("a");
    b.connect(server.port, &board, &owner).await.expect("b");
    // Both create the scene's note concurrently: one note per scene, so the second is rejected.
    let scene = a.replica().view().iter_live().find(|(_, r)| matches!(r, Record::Scene(_))).map(|(id, _)| id).expect("scene");
    let note = |id: u128| vec![Op::Create { id: mapcro_schema::RecordId(id), record: Record::Note(mapcro_schema::Note { scene, text: "x".into() }) }];
    a.edit(note(1)).await;
    a.until_saved().await;
    b.edit(note(2)).await; // b hasn't seen a's note yet
    while b.replica().rejected().is_empty() {
        b.pump_one().await.expect("reply");
    }
    assert_eq!(b.replica().rejected()[0].1, Reject::Duplicate);

    let (d, port) = server.kill9();
    b.drop_connection();
    let server = Server::start(&d, Some(port));
    b.connect(server.port, &board, &owner).await.expect("reconnect");
    let ops = move_op(b.replica(), 1);
    b.edit(ops).await;
    b.until_saved().await; // the next cseq is accepted, not treated as a gap
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

async fn send_presence(c: &mut Client, state: mapcro_engine::wire::Presence) {
    let ws = c.ws.as_mut().expect("ws");
    send(ws, &WireIn::Presence { state }).await;
}

async fn until_peer(c: &mut Client, pred: impl Fn(&mapcro_engine::wire::PeerPresence) -> bool) -> mapcro_engine::wire::PeerPresence {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(p) = c.peers.values().find(|p| pred(p)) {
            return p.clone();
        }
        assert!(Instant::now() < deadline, "presence never arrived: {:?}", c.peers);
        c.pump_one().await.expect("connection");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn presence_is_relayed_with_server_stamped_roles() {
    use mapcro_engine::wire::{MAX_LASER_POINTS, Presence};
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let (_, view) = server.mint(&board, &owner, "view");
    let mut coach = Client::new(0x71);
    let mut viewer = Client::new(0x72);
    coach.connect(server.port, &board, &owner).await.expect("coach");
    viewer.connect(server.port, &board, &view).await.expect("viewer");

    let cursor = WorldPos { x: 100, y: -200 };
    send_presence(&mut coach, Presence { name: "Coach".into(), cursor: Some(cursor), ..Default::default() }).await;
    let seen = until_peer(&mut viewer, |p| p.state.as_ref().is_some_and(|s| s.name == "Coach")).await;
    assert_eq!(seen.role, LinkRole::Owner, "role comes from the link, not the client");
    assert_eq!(seen.state.as_ref().and_then(|s| s.cursor), Some(cursor));

    // A viewer's presence is relayed too, stamped view (so the UI won't offer to follow it).
    send_presence(&mut viewer, Presence { name: "Fan".into(), laser: vec![cursor; 3], ..Default::default() }).await;
    let fan = until_peer(&mut coach, |p| p.state.as_ref().is_some_and(|s| s.name == "Fan")).await;
    assert_eq!(fan.role, LinkRole::View);
    assert_eq!(fan.state.as_ref().map(|s| s.laser.len()), Some(3), "viewers get the laser too");
    // A view link can't draw: its live ink is dropped. Its ping still goes out.
    let ink = mapcro_engine::wire::LiveInk { color: 2, points: vec![cursor; 4] };
    let ping = mapcro_engine::wire::Ping { at: cursor, n: 1 };
    send_presence(&mut viewer, Presence { name: "Fan2".into(), ink: Some(ink), ping: Some(ping), ..Default::default() }).await;
    let fan = until_peer(&mut coach, |p| p.state.as_ref().is_some_and(|s| s.name == "Fan2")).await;
    assert_eq!(fan.state.as_ref().and_then(|s| s.ink.clone()), None, "a viewer's ink isn't relayed");
    assert_eq!(fan.state.as_ref().and_then(|s| s.ping), Some(ping), "a viewer's ping is");

    // A newcomer sees everyone already present straight away.
    let mut late = Client::new(0x73);
    late.connect(server.port, &board, &owner).await.expect("late");
    until_peer(&mut late, |p| p.state.as_ref().is_some_and(|s| s.name == "Coach")).await;
    until_peer(&mut late, |p| p.state.as_ref().is_some_and(|s| s.name == "Fan2")).await;

    // Leaving clears it for the others.
    let coach_peer = seen.peer;
    coach.drop_connection();
    until_peer(&mut viewer, |p| p.peer == coach_peer && p.state.is_none()).await;

    // Out-of-bounds presence is abuse.
    let huge = Presence { laser: vec![cursor; MAX_LASER_POINTS + 1], ..Default::default() };
    send_presence(&mut late, huge).await;
    loop {
        match late.pump_one().await {
            Ok(()) => continue,
            Err(reason) => {
                assert_eq!(reason, Some(CloseReason::Abuse));
                break;
            }
        }
    }
}

fn sha256_hex(b: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// A synthetic pack (not Valve data): two "images" and a manifest listing them. `version` is
/// written as a JSON number when it parses as one, as the extractor's schema-2 manifests do.
fn write_pack(dir: &std::path::Path, version: &str, tamper: bool, numeric: bool) {
    std::fs::create_dir_all(dir.join("map")).expect("mkdir");
    let img = format!("not really a png {version}").into_bytes();
    std::fs::write(dir.join("map/mid.png"), &img).expect("write");
    std::fs::write(dir.join("secret.txt"), b"not listed").expect("write");
    let hash = if tamper { "0".repeat(64) } else { sha256_hex(&img) };
    let game = if numeric {
        serde_json::json!({ "client_version": version.parse::<u64>().expect("number"), "source_revision": 11211860, "date": "Nov 05 2026" })
    } else {
        serde_json::json!({ "client_version": version, "source_revision": "1", "date": "Nov 05 2026" })
    };
    let manifest = serde_json::json!({
        "schema": if numeric { 2 } else { 1 },
        "game": game,
        "blobs": { "map/mid": { "sha256": hash, "w": 1, "h": 1, "mime": "image/png", "file": "map/mid.png" } }
    });
    std::fs::write(dir.join("pack.json"), serde_json::to_vec(&manifest).expect("json")).expect("write");
}

#[tokio::test(flavor = "multi_thread")]
async fn asset_packs_are_served_immutably_and_only_as_listed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let packs = tempfile::tempdir().expect("packs");
    write_pack(&packs.path().join("old"), "6851", false, false);
    write_pack(&packs.path().join("new"), "6860", false, true);
    write_pack(&packs.path().join("bad"), "9999", true, false);
    // A complete, valid pack still being moved into place (docs/deploy.md) is never loaded.
    write_pack(&packs.path().join(".incoming-next"), "7000", false, false);
    let server = Server::start_with(dir.path(), None, &[("PACKS_DIR", packs.path().to_str().expect("utf8"))]);

    let list: Vec<serde_json::Value> = ureq::get(&server.url("/api/packs")).call().expect("list").body_mut().read_json().expect("json");
    let versions: Vec<&str> = list.iter().filter_map(|p| p["game"]["client_version"].as_str()).collect();
    assert_eq!(versions, ["6860", "6851"], "newest first; the tampered and the incoming packs are skipped");
    let id = list[0]["pack_id"].as_str().expect("id").to_owned();
    let manifest = std::fs::read(packs.path().join("new/pack.json")).expect("read");
    assert_eq!(id, sha256_hex(&manifest), "pack id is the manifest's hash");

    let mut r = ureq::get(&server.url(&format!("/packs/{id}/map/mid.png"))).call().expect("file");
    assert_eq!(r.headers().get("content-type").and_then(|v| v.to_str().ok()), Some("image/png"));
    assert!(r.headers().get("cache-control").and_then(|v| v.to_str().ok()).is_some_and(|v| v.contains("immutable")));
    assert_eq!(r.body_mut().read_to_vec().expect("body"), b"not really a png 6860");

    for path in ["secret.txt", "../old/pack.json", "map/../secret.txt", "%2e%2e/old/map/mid.png", "pack.json/../secret.txt"] {
        let status = match ureq::get(&server.url(&format!("/packs/{id}/{path}"))).call() {
            Ok(r) => r.status().as_u16(),
            Err(ureq::Error::StatusCode(c)) => c,
            Err(e) => panic!("{e}"),
        };
        assert_eq!(status, 404, "{path} must not be served");
    }
    assert!(ureq::get(&server.url(&format!("/packs/{}/map/mid.png", "f".repeat(64)))).call().is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn cloning_makes_an_independent_board_with_fresh_links() {
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let (_, view) = server.mint(&board, &owner, "view");
    let mut a = Client::new(0x81);
    a.connect(server.port, &board, &owner).await.expect("a");
    for i in 0..3 {
        let ops = move_op(a.replica(), i);
        a.edit(ops).await;
    }
    a.until_saved().await;

    // Even a view link can clone (it can already see everything).
    let v: serde_json::Value = ureq::post(&server.url(&format!("/api/boards/{board}/clone")))
        .header("authorization", &format!("Bearer {view}"))
        .send_json(serde_json::json!({ "title": "Scrim prep (copy)" }))
        .expect("clone")
        .body_mut()
        .read_json()
        .expect("json");
    let (copy, copy_owner) = (v["board"].as_str().expect("board").to_owned(), v["owner_token"].as_str().expect("token").to_owned());
    assert_ne!(copy, board);

    let mut c = Client::new(0x82);
    c.connect(server.port, &copy, &copy_owner).await.expect("copy");
    let live = |r: &Replica| r.view().iter_live().filter(|(_, x)| !matches!(x, Record::BoardMeta(_))).map(|(i, x)| (i, x.clone())).collect::<Vec<_>>();
    assert_eq!(live(c.replica()), live(a.replica()), "same scenes, players and positions");
    assert_eq!(c.replica().last_seq(), 0, "history is not copied");
    // The old links don't open the copy, and the copy's owner can't touch the original.
    assert_eq!(Client::new(0x83).connect(server.port, &copy, &view).await, Err(Some(CloseReason::Unauthorized)));
    assert_eq!(Client::new(0x84).connect(server.port, &board, &copy_owner).await, Err(Some(CloseReason::Unauthorized)));
    // Edits to the copy don't reach the original.
    let ops = move_op(c.replica(), 9);
    c.edit(ops).await;
    c.until_saved().await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(a.replica().last_seq(), 3);
    // A token for another board can't clone this one.
    let r = ureq::post(&server.url(&format!("/api/boards/{board}/clone"))).header("authorization", &format!("Bearer {copy_owner}")).send_json(serde_json::json!({}));
    assert!(r.is_err());
}

// ---- security review 2026-11-07: capacity and quotas ----

/// Authenticate and hello as `client` by hand, and return the first thing the server says
/// back (on a board with history, success is a catch-up entry).
async fn raw_hello(port: u16, board: &str, token: &str, client: u128) -> Option<WireOut> {
    let mut ws = open_ws(port, ORIGIN).await.ok()?;
    send(&mut ws, &WireIn::Auth { board: board.into(), token: token.into(), known_seq: Some(0), build: None }).await;
    match recv(&mut ws).await? {
        WireOut::Ready { .. } => {}
        other => return Some(other),
    }
    let hello = mapcro_engine::Hello { client: ClientId(client), secret: format!("s-{client}"), last_seq: 0, pending_from: 0 };
    send(&mut ws, &WireIn::Msg { msg: ClientMsg::Hello(hello) }).await;
    recv(&mut ws).await
}

/// Make edits and wait until all are decided; returns the rejections they drew.
async fn edits_until_decided(c: &mut Client, n: usize, op: impl Fn(&Replica, usize) -> Vec<Op>) -> Vec<Reject> {
    let before = c.replica().rejected().len();
    for i in 0..n {
        let ops = op(c.replica(), i);
        c.edit(ops).await;
    }
    c.until_saved().await;
    c.replica().rejected()[before..].iter().map(|(_, r)| r.clone()).collect()
}

fn scene_of(r: &Replica) -> mapcro_schema::RecordId {
    r.view().iter_live().find(|(_, x)| matches!(x, Record::Scene(_))).map(|(id, _)| id).expect("scene")
}

/// A client that already holds a copy at `seq` (as a device that was here before would), so
/// it gets catch-up from there rather than a snapshot.
fn client_at(id: u128, doc: mapcro_schema::Doc, seq: u64) -> Client {
    let mut c = Client::new(id);
    c.replica = Some(Replica::new(ClientId(id), format!("secret-{id:032x}"), doc, seq));
    c
}

async fn fresh_catch_up(port: u16, board: &str, token: &str, id: u128, upto: u64) -> Client {
    let mut f = Client::new(id);
    f.connect(port, board, token).await.expect("fresh client connects");
    while f.replica().last_seq() < upto {
        f.pump_one().await.expect("catch-up keeps the connection");
    }
    f
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_board_refuses_edits_and_stays_readable() {
    // C1: the op log has a quota. Past it, edits are refused with a typed reason; nothing
    // breaks, and the board still loads after a restart.
    let dir = tempfile::tempdir().expect("tempdir");
    let env = [("BOARD_MAX_OPS", "10")];
    let server = Server::start_with(dir.path(), None, &env);
    let (board, owner) = server.create_board();
    let mut a = Client::new(0xc1);
    a.connect(server.port, &board, &owner).await.expect("connect");
    let rejected = edits_until_decided(&mut a, 12, move_op).await;
    assert_eq!(rejected, [Reject::BoardFull, Reject::BoardFull]);
    assert_eq!(a.replica().last_seq(), 10);
    // Another board on the same server is unaffected.
    let (other, other_owner) = server.create_board();
    let mut o = Client::new(0xc2);
    o.connect(server.port, &other, &other_owner).await.expect("other board");
    assert!(edits_until_decided(&mut o, 3, move_op).await.is_empty());

    // After a restart the full board opens, reads in full, and still refuses edits.
    let (d, port) = server.kill9();
    a.drop_connection();
    let server = Server::start_with(&d, Some(port), &env);
    let f = fresh_catch_up(server.port, &board, &owner, 0xc3, 10).await;
    assert_eq!(f.replica().confirmed(), a.replica().confirmed());
    a.connect(server.port, &board, &owner).await.expect("reconnect");
    assert_eq!(edits_until_decided(&mut a, 1, move_op).await, [Reject::BoardFull]);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_byte_quota_counts_history_not_board_size() {
    // C1 as the review found it: rewriting one note keeps the board tiny while its history
    // grows. The byte quota counts history, as stored (compressed).
    let dir = tempfile::tempdir().expect("tempdir");
    // Compaction off: this checks the quota itself, the backstop (see
    // `compaction_means_a_board_never_fills` for what happens with it on).
    let server = Server::start_with(dir.path(), None, &[("BOARD_MAX_BYTES", "65536"), ("BOARD_COMPACT_OPS", "0")]);
    let (board, owner) = server.create_board();
    let mut a = Client::new(0xc4);
    a.connect(server.port, &board, &owner).await.expect("connect");
    let scene = scene_of(a.replica());
    let note = mapcro_schema::RecordId(0xc4c4);
    a.edit(vec![Op::Create { id: note, record: Record::Note(mapcro_schema::Note { scene, text: "x".into() }) }]).await;
    // Pseudo-random letters: about 4.1 KB of JSON a rewrite, which compresses to about 60%.
    let letters = |i: usize| -> String {
        let mut x = 0x9e37_79b9_u32.wrapping_add(i as u32);
        (0..4000)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (b'a' + (x % 26) as u8) as char
            })
            .collect()
    };
    let set = |_: &Replica, i: usize| vec![Op::Set { id: note, value: FieldValue::NoteText(letters(i)) }];
    let rejected = edits_until_decided(&mut a, 40, set).await;
    // Counting JSON, fifteen rewrites would fit in 64 KiB; counting what's stored (compressed),
    // more do, and then the board is full.
    let accepted = a.replica().last_seq() - 1;
    assert!((20..40).contains(&accepted), "{accepted} rewrites fit: {rejected:?}");
    assert!(rejected.iter().all(|r| *r == Reject::BoardFull) && rejected.len() as u64 == 40 - accepted, "{rejected:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn frames_are_capped_at_the_largest_legal_transaction() {
    // C1: the frame cap follows from `Limits`. The largest legal op is accepted; a transaction
    // just over `max_tx_bytes` gets a typed rejection; a frame no honest client can produce
    // (but which the old 256 KiB cap allowed) closes the socket and stores nothing.
    use mapcro_schema::LIMITS;
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let mut a = Client::new(0xc5);
    a.connect(server.port, &board, &owner).await.expect("connect");
    let scene = scene_of(a.replica());
    let note = mapcro_schema::RecordId(0xc5c5);
    let widest = "\u{1F600}".repeat(LIMITS.max_note);
    a.edit(vec![Op::Create { id: note, record: Record::Note(mapcro_schema::Note { scene, text: widest.clone() }) }]).await;
    let undo_shaped = Op::SetIf { id: note, expect: FieldValue::NoteText(widest.clone()), value: FieldValue::NoteText(widest.clone()) };
    a.edit(vec![undo_shaped]).await;
    a.until_saved().await;
    assert!(a.replica().rejected().is_empty(), "the largest legal ops fit: {:?}", a.replica().rejected());

    // Just over the transaction limit, still inside the frame cap: refused, typed.
    let wide = |n: usize| (0..n).map(|_| Op::Set { id: note, value: FieldValue::NoteText(widest.clone()) }).collect::<Vec<_>>();
    let mut ops = wide(4);
    let tx_len = |ops: &Vec<Op>| {
        let tx = mapcro_schema::Tx { client: a.id, cseq: a.replica().next_cseq(), kind: mapcro_schema::TxKind::Edit, ops: ops.clone() };
        mapcro_engine::encoded_len(&tx)
    };
    let pad = Op::Set { id: note, value: FieldValue::NoteText(String::new()) };
    ops.push(pad);
    let short = LIMITS.max_tx_bytes + 200 - tx_len(&ops);
    ops.pop();
    ops.push(Op::Set { id: note, value: FieldValue::NoteText("a".repeat(short)) });
    assert_eq!(tx_len(&ops), LIMITS.max_tx_bytes + 200);
    assert_eq!(edits_until_decided(&mut a, 1, |_, _| ops.clone()).await, [Reject::TxTooLarge]);

    // A valid transaction of about 96 KB: over the frame cap, under the old 256 KiB one.
    let seq = a.replica().last_seq();
    let mut b = Client::new(0xc6);
    b.connect(server.port, &board, &owner).await.expect("connect");
    while b.replica().last_seq() < seq {
        b.pump_one().await.expect("catch-up");
    }
    let big = mapcro_schema::Tx { client: b.id, cseq: 0, kind: mapcro_schema::TxKind::Edit, ops: wide(6) };
    assert!(mapcro_engine::encoded_len(&big) > 90_000);
    let ws = b.ws.as_mut().expect("ws");
    let _ = ws.send(Message::Text(serde_json::to_string(&WireIn::Msg { msg: ClientMsg::Submit(big) }).expect("json").into())).await;
    // The frame itself is refused: the socket closes before any answer to the transaction.
    let t0 = Instant::now();
    let reply = recv(ws).await;
    assert!(matches!(reply, None | Some(WireOut::Closed { .. })), "the frame was read: {reply:?}");
    assert!(t0.elapsed() < Duration::from_secs(5), "the server closed the socket, not a timeout");
    let c = fresh_catch_up(server.port, &board, &owner, 0xc7, seq).await;
    assert_eq!(c.replica().last_seq(), seq);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_board_over_the_load_caps_is_refused_not_read() {
    // C1: a cold load reads at most the quota, so no stored board can be too big to open
    // safely. One written under larger caps is refused (logged), and the server carries on.
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let mut a = Client::new(0xc8);
    a.connect(server.port, &board, &owner).await.expect("connect");
    assert!(edits_until_decided(&mut a, 30, move_op).await.is_empty());
    let (d, port) = server.kill9();
    a.drop_connection();

    let server = Server::start_with(&d, Some(port), &[("BOARD_MAX_OPS", "10")]);
    assert_eq!(Client::new(0xc9).connect(server.port, &board, &owner).await, Err(Some(CloseReason::StorageFailure)));
    let (small, small_owner) = server.create_board();
    let mut s = Client::new(0xca);
    s.connect(server.port, &small, &small_owner).await.expect("the server still serves other boards");
    assert!(edits_until_decided(&mut s, 2, move_op).await.is_empty());

    // Raising the cap opens it again, intact.
    let (d, port) = server.kill9();
    let server = Server::start(&d, Some(port));
    let f = fresh_catch_up(server.port, &board, &owner, 0xcb, 30).await;
    assert_eq!(f.replica().confirmed(), a.replica().confirmed());
}

fn create_status(server: &Server, path: &str, auth: Option<&str>) -> (u16, String) {
    let mut req = ureq::post(&server.url(path));
    if let Some(t) = auth {
        req = req.header("authorization", &format!("Bearer {t}"));
    }
    match req.config().http_status_as_error(false).build().send_json(serde_json::json!({ "title": "x" })) {
        Ok(mut r) => (r.status().as_u16(), r.body_mut().read_to_string().unwrap_or_default()),
        Err(e) => panic!("{e}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn storage_caps_refuse_new_boards_and_edits_clearly() {
    // C1/M-A: the number of boards and the database's size are capped. Creation past either is
    // a clear 507; edits once storage is full are refused as ServerFull.
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start_with(dir.path(), None, &[("MAX_BOARDS", "2")]);
    let (board, owner) = server.create_board();
    server.create_board();
    let (status, body) = create_status(&server, "/api/boards", None);
    assert_eq!(status, 507, "{body}");
    assert!(body.contains("server is full"), "{body}");
    assert_eq!(create_status(&server, &format!("/api/boards/{board}/clone"), Some(&owner)).0, 507, "clones count too");

    let (d, port) = server.kill9();
    let server = Server::start_with(&d, Some(port), &[("MAX_STORAGE_BYTES", "4096")]);
    assert_eq!(create_status(&server, "/api/boards", None).0, 507);
    let mut a = Client::new(0xcc);
    a.connect(server.port, &board, &owner).await.expect("existing boards still open");
    assert_eq!(edits_until_decided(&mut a, 1, move_op).await, [Reject::ServerFull]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_client_catches_up_on_a_long_history() {
    // H-A: catch-up used to be queued whole into a 4096-deep outbox, so a board past ~4096 ops
    // dropped every client far behind. It's streamed now, from disk, and live entries still
    // follow it in order. (A fresh client gets a snapshot instead; see
    // `a_fresh_client_loads_the_board_not_its_history`.)
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    // A device that saw the board at the start, then went away.
    let mut early = Client::new(0xd96);
    early.connect(server.port, &board, &owner).await.expect("early");
    let genesis = early.replica().confirmed().clone();
    early.drop_connection();
    // 25 writers × 250 (inside each socket's burst allowance) = 6250 entries, five writers at a
    // time, each leaving when done so nobody has to keep up with the whole fill live.
    for wave in 0..5u128 {
        let writers: Vec<_> = (0..5u128)
            .map(|w| {
                let (port, board, owner, w) = (server.port, board.clone(), owner.clone(), wave * 5 + w);
                tokio::spawn(async move {
                    let mut c = Client::new(0xd00 + w);
                    c.connect(port, &board, &owner).await.expect("writer");
                    assert!(edits_until_decided(&mut c, 250, |r, i| move_op(r, i + w as usize)).await.is_empty());
                })
            })
            .collect();
        for w in writers {
            w.await.expect("writer done");
        }
    }
    let total = 6250;
    let mut live = Client::new(0xd99);
    live.connect(server.port, &board, &owner).await.expect("live writer");
    while live.replica().last_seq() < total {
        live.pump_one().await.expect("catch-up");
    }
    // The early device comes back while edits keep landing: all 6250 entries, then live ones.
    let (port, b, o, g) = (server.port, board.clone(), owner.clone(), genesis.clone());
    let back = tokio::spawn(async move {
        let mut c = client_at(0xd98, g, 0);
        c.connect(port, &b, &o).await.expect("back");
        while c.replica().last_seq() < total + 40 {
            c.pump_one().await.expect("catch-up keeps the connection");
        }
        c
    });
    assert!(edits_until_decided(&mut live, 40, move_op).await.is_empty());
    let back = back.await.expect("returning client");
    assert_eq!(back.replica().last_seq(), total + 40);
    assert_eq!(back.replica().confirmed(), live.replica().confirmed());

    // After a restart the room holds no history at all; catch-up comes from disk.
    live.drop_connection();
    let (d, port) = server.kill9();
    let server = Server::start(&d, Some(port));
    let mut cold = client_at(0xd97, genesis, 0);
    cold.connect(server.port, &board, &owner).await.expect("cold");
    while cold.replica().last_seq() < total + 40 {
        cold.pump_one().await.expect("catch-up from disk");
    }
    assert_eq!(cold.replica().confirmed(), live.replica().confirmed());
}

#[tokio::test(flavor = "multi_thread")]
async fn view_links_register_nothing_and_editors_are_capped() {
    // H-B: a view link used to write a permanent client row per fresh id. Now viewers register
    // nothing, and distinct editing clients per board are capped. H1 (a registered id is bound
    // to its secret) is covered by `client_ids_cannot_be_hijacked`.
    let dir = tempfile::tempdir().expect("tempdir");
    let env = [("BOARD_MAX_CLIENTS", "3")];
    let server = Server::start_with(dir.path(), None, &env);
    let (board, owner) = server.create_board();
    let (_, view) = server.mint(&board, &owner, "view");
    let mut o = Client::new(0xe0);
    o.connect(server.port, &board, &owner).await.expect("owner");
    assert!(edits_until_decided(&mut o, 1, move_op).await.is_empty());
    for id in 0..12 {
        let r = raw_hello(server.port, &board, &view, 0xe100 + id).await;
        assert!(matches!(r, Some(WireOut::Msg { msg: ServerMsg::Entry { .. } })), "viewer {id}: {r:?}");
    }
    // The owner plus two more editors fill the cap; the next is refused.
    for id in [0xe1, 0xe2] {
        let r = raw_hello(server.port, &board, &owner, id).await;
        assert!(matches!(r, Some(WireOut::Msg { msg: ServerMsg::Entry { .. } })), "editor {id:x}: {r:?}");
    }
    match raw_hello(server.port, &board, &owner, 0xe3).await {
        Some(WireOut::Msg { msg: ServerMsg::Fatal(why) }) => assert!(why.contains("too many clients"), "{why}"),
        other => panic!("expected Fatal, got {other:?}"),
    }
    // Registered editors still get in, and the cap survives a restart.
    let (d, port) = server.kill9();
    o.drop_connection();
    let server = Server::start_with(&d, Some(port), &env);
    o.connect(server.port, &board, &owner).await.expect("owner again");
    assert!(edits_until_decided(&mut o, 1, move_op).await.is_empty());
    assert!(matches!(raw_hello(server.port, &board, &owner, 0xe4).await, Some(WireOut::Msg { msg: ServerMsg::Fatal(_) })));
}

#[tokio::test(flavor = "multi_thread")]
async fn open_rooms_are_capped_and_idle_ones_make_way() {
    // M-B: boards held in memory are capped. At the cap, an idle room unloads early to make
    // room; if every room is in use, a join is refused as busy rather than loaded.
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start_with(dir.path(), None, &[("MAX_OPEN_ROOMS", "2")]);
    let boards: Vec<(String, String)> = (0..3).map(|_| server.create_board()).collect();
    let mut a = Client::new(0xf1);
    let mut b = Client::new(0xf2);
    a.connect(server.port, &boards[0].0, &boards[0].1).await.expect("a");
    b.connect(server.port, &boards[1].0, &boards[1].1).await.expect("b");
    assert_eq!(Client::new(0xf3).connect(server.port, &boards[2].0, &boards[2].1).await, Err(Some(CloseReason::Busy)));
    assert_eq!(open_rooms(&server), 2);

    b.drop_connection(); // room 1 is now idle, though far from its idle timeout
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut c = Client::new(0xf3);
    while let Err(e) = c.connect(server.port, &boards[2].0, &boards[2].1).await {
        assert!(Instant::now() < deadline, "the idle room never made way: {e:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(open_rooms(&server), 2);
    assert!(edits_until_decided(&mut c, 1, move_op).await.is_empty());
    // The evicted board reloads intact when someone comes back (evicting another idle room).
    assert!(edits_until_decided(&mut a, 1, move_op).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_csp_forbids_plugins() {
    // L1: `object-src` falls back to `'self'` unless set.
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let r = ureq::get(&server.url("/healthz")).call().expect("healthz");
    let csp = r.headers().get("content-security-policy").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
    assert!(csp.contains("object-src 'none'"), "{csp}");
}

/// A hand-driven session: authenticated and helloed, nothing read yet.
async fn raw_session(port: u16, board: &str, token: &str, client: u128) -> Ws {
    let mut ws = open_ws(port, ORIGIN).await.expect("ws");
    send(&mut ws, &WireIn::Auth { board: board.into(), token: token.into(), known_seq: Some(0), build: None }).await;
    assert!(matches!(recv(&mut ws).await, Some(WireOut::Ready { .. })));
    let hello = mapcro_engine::Hello { client: ClientId(client), secret: format!("s-{client}"), last_seq: 0, pending_from: 0 };
    send(&mut ws, &WireIn::Msg { msg: ClientMsg::Hello(hello) }).await;
    ws
}

/// Submit a transaction the server will refuse (it names a record that doesn't exist).
async fn submit_bad(ws: &mut Ws, client: u128, cseq: u64) -> Option<WireOut> {
    let ops = vec![Op::Set { id: mapcro_schema::RecordId(0xbad0), value: FieldValue::PlayerAlive(true) }];
    let tx = mapcro_schema::Tx { client: ClientId(client), cseq, kind: mapcro_schema::TxKind::Edit, ops };
    send(ws, &WireIn::Msg { msg: ClientMsg::Submit(tx) }).await;
    recv(ws).await
}

#[tokio::test(flavor = "multi_thread")]
async fn stored_rejections_are_capped_per_board() {
    // H-B: each client may leave 256 rejections stored, but with many clients that adds up, so
    // the board as a whole is capped too. Past it, a refused transaction cuts its sender off.
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start_with(dir.path(), None, &[("BOARD_MAX_REJECTIONS", "3")]);
    let (board, owner) = server.create_board();
    let rejected = Some(WireOut::Msg { msg: ServerMsg::Rejected { cseq: 0, reason: Reject::NoSuchRecord } });
    let mut a = raw_session(server.port, &board, &owner, 0xa1).await;
    for cseq in 0..3 {
        let r = submit_bad(&mut a, 0xa1, cseq).await;
        assert!(matches!(r, Some(WireOut::Msg { msg: ServerMsg::Rejected { reason: Reject::NoSuchRecord, .. } })), "{r:?}");
    }
    let mut b = raw_session(server.port, &board, &owner, 0xa2).await;
    match submit_bad(&mut b, 0xa2, 0).await {
        Some(WireOut::Msg { msg: ServerMsg::Fatal(why) }) => assert!(why.contains("too many rejected"), "{why}"),
        other => panic!("expected Fatal, got {other:?}"),
    }
    // Once `a` says it has heard its rejections, they're forgotten and there's room again.
    drop(a);
    let mut a = open_ws(server.port, ORIGIN).await.expect("ws");
    send(&mut a, &WireIn::Auth { board: board.clone(), token: owner.clone(), known_seq: Some(0), build: None }).await;
    assert!(matches!(recv(&mut a).await, Some(WireOut::Ready { .. })));
    let hello = mapcro_engine::Hello { client: ClientId(0xa1), secret: format!("s-{}", 0xa1), last_seq: 0, pending_from: 3 };
    send(&mut a, &WireIn::Msg { msg: ClientMsg::Hello(hello) }).await;
    let mut c = raw_session(server.port, &board, &owner, 0xa3).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(submit_bad(&mut c, 0xa3, 0).await, rejected);
}

// ---- storage: compressed rows, the log on disk only ----

/// A database exactly as schema v3 left it (before codecs): JSON text rows.
fn write_v3_database(path: &std::path::Path, board: &str, owner_hash: &str, base: &mapcro_schema::Doc, log: &[mapcro_schema::Tx]) {
    let c = rusqlite::Connection::open(path).expect("open");
    c.execute_batch(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO meta VALUES ('schema_version', '3');
         CREATE TABLE boards (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, base_doc TEXT NOT NULL, base_seq INTEGER NOT NULL);
         CREATE TABLE ops (board TEXT NOT NULL REFERENCES boards(id), seq INTEGER NOT NULL, tx TEXT NOT NULL, PRIMARY KEY (board, seq)) WITHOUT ROWID;
         CREATE TABLE rejections (board TEXT NOT NULL REFERENCES boards(id), client TEXT NOT NULL, cseq INTEGER NOT NULL, reason TEXT NOT NULL,
                                  PRIMARY KEY (board, client, cseq)) WITHOUT ROWID;
         CREATE TABLE links (hash TEXT PRIMARY KEY, board TEXT NOT NULL REFERENCES boards(id), role TEXT NOT NULL, label TEXT NOT NULL,
                             created_at INTEGER NOT NULL, revoked_at INTEGER, minted_by TEXT REFERENCES links(hash));
         CREATE INDEX links_by_board ON links(board);
         CREATE INDEX links_by_parent ON links(minted_by);
         CREATE TABLE clients (board TEXT NOT NULL REFERENCES boards(id), client TEXT NOT NULL, secret_hash BLOB NOT NULL,
                               PRIMARY KEY (board, client)) WITHOUT ROWID;",
    )
    .expect("v3 schema");
    let doc = serde_json::to_string(base).expect("json");
    c.execute("INSERT INTO boards VALUES (?1, 0, ?2, 0)", rusqlite::params![board, doc]).expect("board");
    c.execute("INSERT INTO links (hash, board, role, label, created_at) VALUES (?1, ?2, 'owner', 'owner', 0)", rusqlite::params![owner_hash, board])
        .expect("link");
    let t = c.unchecked_transaction().expect("transaction");
    for (i, tx) in log.iter().enumerate() {
        let json = serde_json::to_string(tx).expect("json");
        t.execute("INSERT INTO ops VALUES (?1, ?2, ?3)", rusqlite::params![board, i as i64 + 1, json]).expect("op");
    }
    t.commit().expect("commit");
}

fn codecs(path: &std::path::Path) -> Vec<(String, i64)> {
    let c = rusqlite::Connection::open(path).expect("open");
    let mut s = c.prepare("SELECT codec, COUNT(*) FROM ops GROUP BY codec ORDER BY codec").expect("query");
    s.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).expect("rows").map(|r| r.expect("row")).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn rows_from_before_compression_still_load() {
    // Schema v4 tags each row with its codec. A v3 database (JSON rows, JSON base document)
    // migrates in place; its rows read as before, new rows are compressed, and both kinds
    // load together after a restart.
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("mapcro.sqlite");
    let mut n = 0u128;
    let base = mapcro_schema::genesis(
        || {
            n += 1;
            mapcro_schema::RecordId(0x01d0 + n)
        },
        "Old board",
    );
    let mut writer = Replica::new(ClientId(0x01d), "old-secret".into(), base.clone(), 0);
    writer.connect();
    let mut log = Vec::new();
    for i in 0..30 {
        let ops = move_op(&writer, i);
        let Some(ClientMsg::Submit(tx)) = writer.edit(ops).expect("valid") else { panic!("a submit") };
        log.push(tx.clone());
        writer.receive(ServerMsg::Entry { seq: i as u64 + 1, tx }).expect("ack");
    }
    let (board, owner) = ("OldBoardOldBoardOldBoa".to_owned(), "O".repeat(43));
    write_v3_database(&path, &board, &sha256_hex(owner.as_bytes()), &base, &log);

    let server = Server::start(dir.path(), None);
    let fresh = fresh_catch_up(server.port, &board, &owner, 0x02d, 30).await;
    assert_eq!(fresh.replica().confirmed(), writer.confirmed(), "old rows replay to the same board");
    let mut a = Client::new(0x03d);
    a.connect(server.port, &board, &owner).await.expect("connect");
    while a.replica().last_seq() < 30 {
        a.pump_one().await.expect("catch-up");
    }
    assert!(edits_until_decided(&mut a, 10, move_op).await.is_empty());
    assert_eq!(codecs(&path), [("json".to_owned(), 30), ("zstd-v1".to_owned(), 10)]);

    let (d, port) = server.kill9();
    let server = Server::start(&d, Some(port));
    let mixed = fresh_catch_up(server.port, &board, &owner, 0x04d, 40).await;
    assert_eq!(mixed.replica().confirmed(), a.replica().confirmed(), "mixed codecs load");
    // A device that had the board before any of it reads every row through catch-up: old JSON
    // rows and new compressed ones.
    let mut back = client_at(0x05d, base, 0);
    back.connect(server.port, &board, &owner).await.expect("back");
    while back.replica().last_seq() < 40 {
        back.pump_one().await.expect("catch-up across codecs");
    }
    assert_eq!(back.replica().confirmed(), a.replica().confirmed(), "mixed codecs catch up");
}

fn rss_kb(server: &Server) -> u64 {
    let s = std::fs::read_to_string(format!("/proc/{}/status", server.child.id())).expect("status");
    s.lines().find_map(|l| l.strip_prefix("VmRSS:")).and_then(|v| v.trim().trim_end_matches("kB").trim().parse().ok()).expect("VmRSS")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_loaded_room_does_not_hold_its_history() {
    // The log lives on disk only: loading a board with a long history costs its document, not
    // its history. One note rewritten 2000 times: the document stays tiny, the history is
    // about 8 MB of JSON. Loading it must grow the server by much less than that.
    let dir = tempfile::tempdir().expect("tempdir");
    let env = [("BOARD_MAX_BYTES", "67108864")];
    let server = Server::start_with(dir.path(), None, &env);
    let (board, owner) = server.create_board();
    let mut first = Client::new(0x5a0);
    first.connect(server.port, &board, &owner).await.expect("connect");
    let scene = scene_of(first.replica());
    let note = mapcro_schema::RecordId(0x5a5a);
    first.edit(vec![Op::Create { id: note, record: Record::Note(mapcro_schema::Note { scene, text: "x".into() }) }]).await;
    first.until_saved().await;
    let rewrite = |r: &Replica, i: usize| {
        let mut x = (r.client().0 as u32) ^ (i as u32).wrapping_mul(0x9e37_79b9);
        let text: String = (0..4000)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (b'a' + (x % 26) as u8) as char
            })
            .collect();
        vec![Op::Set { id: note, value: FieldValue::NoteText(text) }]
    };
    // Eight writers in turn (each inside its socket's burst allowance), 25 rewrites at a time so
    // the test client's rebasing stays cheap.
    for w in 0..8u128 {
        let mut c = Client::new(0x5b0 + w);
        c.connect(server.port, &board, &owner).await.expect("writer");
        while c.replica().last_seq() < 1 {
            c.pump_one().await.expect("the note arrives");
        }
        for batch in 0..10 {
            assert!(edits_until_decided(&mut c, 25, |r, i| rewrite(r, batch * 25 + i)).await.is_empty());
        }
    }
    let total = 2001;
    first.drop_connection();
    let (d, port) = server.kill9();
    let server = Server::start_with(&d, Some(port), &env);
    let before = rss_kb(&server);
    // Open the room without catch-up: a client that already has everything.
    let mut ws = open_ws(server.port, ORIGIN).await.expect("ws");
    send(&mut ws, &WireIn::Auth { board: board.clone(), token: owner.clone(), known_seq: Some(total), build: None }).await;
    assert!(matches!(recv(&mut ws).await, Some(WireOut::Ready { .. })));
    assert_eq!(open_rooms(&server), 1);
    let grew = rss_kb(&server).saturating_sub(before);
    eprintln!("loading a room with {total} rewrites of a 4000-char note grew the server by {grew} kB");
    // The history is ~8,000 KB of JSON (~4,800 KB stored). Measured: loading grows the server
    // by ~3,500 kB (SQLite's page cache keeps up to 2,000 KB of what the load read, plus the
    // loading thread's buffers); holding the log in memory made it ~11,600 kB.
    assert!(grew < 7_000, "loading the room grew the server by {grew} kB");
    // And the history is all still there, from disk.
    let fresh = fresh_catch_up(server.port, &board, &owner, 0x5ff, total).await;
    assert_eq!(fresh.replica().last_seq(), total);
}

fn stroke_ops(scene: mapcro_schema::RecordId, seed: u32, n: usize) -> Vec<Op> {
    let mut x = seed.wrapping_mul(0x9e37_79b9) | 1;
    let mut next = move || {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        (x % 32_000) as i32 - 16_000
    };
    (0..n)
        .map(|k| {
            let points = (0..512).map(|_| WorldPos { x: next(), y: next() }).collect();
            let id = mapcro_schema::RecordId(((seed as u128) << 32) | k as u128 | 1 << 100);
            Op::Create { id, record: Record::Stroke(mapcro_schema::Stroke { scene, points, color: 3, width: 30, offset: WorldPos::default() }) }
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn open_rooms_fit_a_memory_budget() {
    // With no history in memory, a room costs its document, which ranges from kilobytes to the
    // ~20 MB the schema allows. So rooms are admitted against a memory budget, not just counted:
    // past it, an idle room makes way or the join is busy, and edits that would grow memory
    // further are refused as ServerFull. Here each small room weighs ~75 KB; two fit in 200 KB.
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start_with(dir.path(), None, &[("ROOM_MEMORY_BYTES", "200000")]);
    let boards: Vec<(String, String)> = (0..3).map(|_| server.create_board()).collect();
    let mut a = Client::new(0x9a1);
    let mut b = Client::new(0x9a2);
    a.connect(server.port, &boards[0].0, &boards[0].1).await.expect("a");
    b.connect(server.port, &boards[1].0, &boards[1].1).await.expect("b");
    assert_eq!(Client::new(0x9a3).connect(server.port, &boards[2].0, &boards[2].1).await, Err(Some(CloseReason::Busy)));

    // Growing a room past the budget: its edits are refused once the estimate says so.
    let scene = scene_of(a.replica());
    let mut refused = Vec::new();
    for i in 0..40 {
        refused = edits_until_decided(&mut a, 1, |_, _| stroke_ops(scene, i, 5)).await;
        if !refused.is_empty() {
            break;
        }
    }
    assert_eq!(refused, [Reject::ServerFull], "memory growth is refused");
    // When another room goes idle, it makes way, and edits are accepted again.
    b.drop_connection();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let r = edits_until_decided(&mut a, 1, move_op).await;
        if r.is_empty() {
            break;
        }
        assert!(Instant::now() < deadline, "the idle room never made way: {r:?}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_peer_that_stops_reading_is_dropped_by_bytes_queued() {
    // Live frames are shared between peers, but a peer that stops reading would keep every
    // frame since alive. Its outbox is capped in bytes (1 MiB), not just frames (4096). The slow
    // viewer's receive buffer is kept small, so ~15 MB of edits (250 frames) is more than the
    // 4 MiB cap and the sockets absorb, and it's dropped as too slow before it's sent everything.
    use tokio_tungstenite::tungstenite::Message as M;
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let (_, view) = server.mint(&board, &owner, "view");
    let sock = tokio::net::TcpSocket::new_v4().expect("socket");
    sock.set_recv_buffer_size(16 * 1024).expect("rcvbuf");
    let stream = sock.connect(([127, 0, 0, 1], server.port).into()).await.expect("connect");
    let mut req = format!("ws://127.0.0.1:{}/ws", server.port).into_client_request().expect("request");
    req.headers_mut().insert("origin", ORIGIN.parse().expect("origin"));
    let (mut slow, _) = tokio_tungstenite::client_async(req, stream).await.expect("ws");
    let text = |f: &WireIn| M::Text(serde_json::to_string(f).expect("json").into());
    slow.send(text(&WireIn::Auth { board: board.clone(), token: view, known_seq: Some(0), build: None })).await.expect("auth");
    let hello = mapcro_engine::Hello { client: ClientId(0x7a1), secret: "slow".into(), last_seq: 0, pending_from: 0 };
    slow.send(text(&WireIn::Msg { msg: ClientMsg::Hello(hello) })).await.expect("hello");

    let mut w = Client::new(0x7a2);
    w.connect(server.port, &board, &owner).await.expect("writer");
    let scene = scene_of(w.replica());
    let note = mapcro_schema::RecordId(0x7a7a);
    w.edit(vec![Op::Create { id: note, record: Record::Note(mapcro_schema::Note { scene, text: "x".into() }) }]).await;
    let letters = |i: usize| -> String {
        let mut x = 0x2545_f491_u32.wrapping_add(i as u32 * 7919);
        (0..4000)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (b'a' + (x % 26) as u8) as char
            })
            .collect()
    };
    for batch in 0..10 {
        let ops = |_: &Replica, i: usize| (0..15).map(|k| Op::Set { id: note, value: FieldValue::NoteText(letters(batch * 1000 + i * 15 + k)) }).collect();
        assert!(edits_until_decided(&mut w, 25, ops).await.is_empty());
    }
    // Now the viewer reads: it was cut off before it got everything.
    let mut entries = 0;
    let end = loop {
        match tokio::time::timeout(Duration::from_secs(10), slow.next()).await {
            Ok(Some(Ok(M::Text(t)))) => match serde_json::from_str::<WireOut>(t.as_str()) {
                Ok(WireOut::Msg { msg: ServerMsg::Entry { .. } }) => entries += 1,
                Ok(WireOut::Closed { reason }) => break Some(reason),
                _ => {}
            },
            Ok(Some(Ok(_))) => {}
            _ => break None,
        }
    };
    assert_eq!(end, Some(CloseReason::TooSlow), "got {entries} of 251 entries");
    assert!(entries < 251);
}

/// After a deploy every browser must get the new app: pages are never served from a cached
/// copy (the nix store dates every file 1970, so a revalidation would always say "not
/// modified"), while hashed assets cache forever.
#[tokio::test]
async fn pages_are_never_stale_and_hashed_assets_cache_forever() {
    let dir = tempfile::tempdir().expect("tempdir");
    let web = tempfile::tempdir().expect("web");
    std::fs::write(web.path().join("index.html"), "<!doctype html><title>new</title>").expect("index");
    std::fs::create_dir(web.path().join("assets")).expect("assets");
    std::fs::write(web.path().join("assets/index-abc123.js"), "1").expect("asset");
    let server = Server::start_with(dir.path(), None, &[("WEB_DIR", web.path().to_str().expect("utf8"))]);

    for path in ["/", "/b/someboard"] {
        let mut res = ureq::get(&server.url(path))
            .header("if-modified-since", "Sat, 01 Jan 2050 00:00:00 GMT")
            .call()
            .expect("page");
        assert_eq!(res.status(), 200, "{path}: a cached copy must not be confirmed");
        assert_eq!(res.headers().get("cache-control").and_then(|v| v.to_str().ok()), Some("no-store"), "{path}");
        assert!(res.body_mut().read_to_string().expect("body").contains("new"), "{path}");
    }
    let res = ureq::get(&server.url("/assets/index-abc123.js")).call().expect("asset");
    assert_eq!(
        res.headers().get("cache-control").and_then(|v| v.to_str().ok()),
        Some("public, max-age=31536000, immutable")
    );
}

/// A tab that freezes before authenticating (a backgrounded phone, a long GC) is told it was
/// slow, which clients retry, not `Unauthorized`, which they treat as final (soak 2026-11-07).
#[tokio::test]
async fn a_silent_socket_is_closed_as_slow_not_unauthorized() {
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let mut ws = open_ws(server.port, ORIGIN).await.expect("open");
    let closed = loop {
        match tokio::time::timeout(Duration::from_secs(15), ws.next()).await.expect("closed within the auth timeout") {
            Some(Ok(Message::Text(t))) => break serde_json::from_str::<WireOut>(t.as_str()).ok(),
            Some(Ok(_)) => continue,
            _ => break None,
        }
    };
    assert_eq!(closed, Some(WireOut::Closed { reason: CloseReason::TooSlow }));
}

// ---- fresh joins: a snapshot of the board, not its history ----

#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_client_loads_the_board_not_its_history() {
    // A client with no copy used to replay the whole log (~0.7 ms an entry in the browser: 23 s
    // for a 33k-entry board). Now Ready carries the board as it is, at the log position the room
    // took it at, and the client catches up only what came after. The last entry before the join
    // is a Create, which can't be applied twice: if the base and the catch-up disagreed by one,
    // the client would either get it again (IdTaken, a protocol error) or claim to be ahead of the
    // log (Fatal).
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("mapcro.sqlite");
    let mut n = 0u128;
    let base = mapcro_schema::genesis(
        || {
            n += 1;
            mapcro_schema::RecordId(0xf00 + n)
        },
        "Busy board",
    );
    // The history, built directly (a replica per edit would make this test slow, not the server).
    let scene = base.iter_live().find(|(_, r)| matches!(r, Record::Scene(_))).map(|(id, _)| id).expect("scene");
    let player = base.iter_live().find(|(_, r)| matches!(r, Record::PlayerState(_))).map(|(id, _)| id).expect("player");
    const N: usize = 20_000;
    let log: Vec<mapcro_schema::Tx> = (0..N)
        .map(|i| {
            let ops = if i + 1 == N {
                let callout = mapcro_schema::Callout { scene, pos: WorldPos { x: 1, y: 2 }, text: "last".into(), color: None };
                vec![Op::Create { id: mapcro_schema::RecordId(0xca11), record: Record::Callout(callout) }]
            } else {
                vec![Op::Set { id: player, value: FieldValue::PlayerPos(WorldPos { x: (i % 2000) as i32, y: 0 }) }]
            };
            mapcro_schema::Tx { client: ClientId(0xf01), cseq: i as u64, kind: mapcro_schema::TxKind::Edit, ops }
        })
        .collect();
    let (board, owner) = ("BusyBoardBusyBoardBusy".to_owned(), "B".repeat(43));
    write_v3_database(&path, &board, &sha256_hex(owner.as_bytes()), &base, &log);
    let server = Server::start(dir.path(), None);

    let started = Instant::now();
    let mut fresh = Client::new(0xf02);
    fresh.connect(server.port, &board, &owner).await.expect("fresh");
    let base_seq = fresh.replica().last_seq();
    assert!(base_seq > N as u64 - 10, "the base is the board now, not the start: seq {base_seq}");
    // In sync: one more edit from someone else arrives as the next entry, and nothing else.
    let mut other = Client::new(0xf03);
    other.connect(server.port, &board, &owner).await.expect("other");
    assert!(edits_until_decided(&mut other, 1, move_op).await.is_empty());
    while fresh.replica().last_seq() < N as u64 + 1 {
        fresh.pump_one().await.expect("a base and its catch-up meet exactly");
    }
    let received = fresh.replica().last_seq() - base_seq;
    assert!(received < 10, "{received} entries after the base");
    assert_eq!(fresh.replica().confirmed(), other.replica().confirmed());
    assert!(started.elapsed() < Duration::from_secs(10), "joined and in sync in {:?}", started.elapsed());
    eprintln!("fresh client on a {N}-entry board: base at {base_seq}, {received} entries after, in sync in {:?}", started.elapsed());
    // Its own edits land normally.
    assert!(edits_until_decided(&mut fresh, 3, move_op).await.is_empty());
}

/// A board whose history is `txs` transactions of five 512-point strokes each, written as a
/// v3 database directly (quicker than through the server).
fn inked_board(dir: &std::path::Path, txs: u32) -> (String, String, mapcro_schema::RecordId) {
    let mut n = 0u128;
    let base = mapcro_schema::genesis(
        || {
            n += 1;
            mapcro_schema::RecordId(0xe00 + n)
        },
        "Inked board",
    );
    let scene = base.iter_live().find(|(_, r)| matches!(r, Record::Scene(_))).map(|(id, _)| id).expect("scene");
    let log: Vec<mapcro_schema::Tx> = (0..txs)
        .map(|i| mapcro_schema::Tx { client: ClientId(0xe01), cseq: i as u64, kind: mapcro_schema::TxKind::Edit, ops: stroke_ops(scene, i + 1, 5) })
        .collect();
    let (board, owner) = ("InkedBoardInkedBoardIn".to_owned(), "I".repeat(43));
    write_v3_database(&dir.join("mapcro.sqlite"), &board, &sha256_hex(owner.as_bytes()), &base, &log);
    (board, owner, scene)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_shared_snapshot_keeps_its_own_position() {
    // Fresh joiners share the room's last snapshot while it's at most 256 entries old, so a
    // burst of them on a big board costs one copy. A reused snapshot keeps the position it was
    // taken at: a joiner after a few more edits gets it and catches up those edits. The last of
    // them is a Create, which can't be applied twice.
    let dir = tempfile::tempdir().expect("tempdir");
    let (board, owner, scene) = inked_board(dir.path(), 90);
    let server = Server::start(dir.path(), None);
    let mut w = Client::new(0xe02);
    w.connect(server.port, &board, &owner).await.expect("first joiner");
    assert_eq!(w.replica().last_seq(), 90, "a fresh snapshot of the board now");
    assert!(edits_until_decided(&mut w, 4, move_op).await.is_empty());
    let callout = mapcro_schema::Callout { scene, pos: WorldPos { x: 3, y: 4 }, text: "new".into(), color: None };
    let create = vec![Op::Create { id: mapcro_schema::RecordId(0xe0ca), record: Record::Callout(callout) }];
    assert!(edits_until_decided(&mut w, 1, |_, _| create.clone()).await.is_empty());

    let mut late = Client::new(0xe03);
    late.connect(server.port, &board, &owner).await.expect("late");
    assert_eq!(late.replica().last_seq(), 90, "the snapshot is reused, at its own position");
    while late.replica().last_seq() < 95 {
        late.pump_one().await.expect("catch-up from the snapshot's position");
    }
    assert_eq!(late.replica().confirmed(), w.replica().confirmed());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_board_too_big_for_one_frame_falls_back_to_catch_up() {
    // A snapshot is one frame and costs its size several times over while it's sent, so a board
    // over 8 MiB of JSON (here ~10 MB of ink) starts a fresh client from the stored base and
    // pages the history instead, as before snapshots.
    let dir = tempfile::tempdir().expect("tempdir");
    let (board, owner, _) = inked_board(dir.path(), 160);
    let server = Server::start(dir.path(), None);
    let mut f = Client::new(0xe04);
    f.connect(server.port, &board, &owner).await.expect("fresh");
    assert_eq!(f.replica().last_seq(), 0, "the stored base, not a snapshot");
    while f.replica().last_seq() < 160 {
        f.pump_one().await.expect("paged catch-up");
    }
    let mut g = Client::new(0xe05);
    g.connect(server.port, &board, &owner).await.expect("another");
    while g.replica().last_seq() < 160 {
        g.pump_one().await.expect("paged catch-up");
    }
    assert_eq!(f.replica().confirmed(), g.replica().confirmed());
}

#[tokio::test(flavor = "multi_thread")]
async fn presence_goes_out_on_the_leading_edge_and_bursts_coalesce() {
    // Presence used to wait for a full 50 ms batch, so with clients sending every 60 ms each
    // update waited ~50 ms on the server. Now a change after a quiet spell goes out at once, and
    // changes inside a batch window still go out together.
    use mapcro_engine::wire::Presence;
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let mut coach = Client::new(0x7c1);
    let mut viewer = Client::new(0x7c2);
    coach.connect(server.port, &board, &owner).await.expect("coach");
    viewer.connect(server.port, &board, &owner).await.expect("viewer");
    let at = |i: i32| Presence { name: "Coach".into(), cursor: Some(WorldPos { x: i, y: 0 }), ..Default::default() };
    // Ten updates, 120 ms apart (quieter than a batch): each should arrive straight away.
    let mut waits = Vec::new();
    for i in 0..10 {
        tokio::time::sleep(Duration::from_millis(120)).await;
        let sent = Instant::now();
        send_presence(&mut coach, at(i)).await;
        until_peer(&mut viewer, |p| p.state.as_ref().and_then(|s| s.cursor).is_some_and(|c| c.x == i)).await;
        waits.push(sent.elapsed());
    }
    waits.sort();
    let median = waits[waits.len() / 2];
    assert!(median < Duration::from_millis(25), "presence waited {median:?} (median of {waits:?})");
    // A burst of twenty inside one window: few frames, and the last state wins.
    tokio::time::sleep(Duration::from_millis(120)).await;
    for i in 100..120 {
        send_presence(&mut coach, at(i)).await;
    }
    let mut frames = 0;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let ws = viewer.ws.as_mut().expect("ws");
        match tokio::time::timeout(Duration::from_millis(300), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                if let Ok(WireOut::Presence { peers }) = serde_json::from_str::<WireOut>(t.as_str()) {
                    frames += 1;
                    for p in peers {
                        viewer.peers.insert(p.peer, p);
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => break,
        }
        assert!(Instant::now() < deadline, "presence never settled");
    }
    let last = viewer.peers.values().find_map(|p| p.state.as_ref().and_then(|s| s.cursor)).expect("coach's cursor");
    assert_eq!(last.x, 119, "the last update wins");
    assert!(frames <= 3, "a burst of 20 updates became {frames} frames");
    eprintln!("presence: median wait {median:?}; a burst of 20 went out as {frames} frames");
}

// ---- group commit (spec §9): crash points, `--features failpoints` only ----

/// Three editors, each with `n` paced edits (so the room commits many small batches), after one
/// saved edit each (so their ids are registered before the burst).
#[cfg(feature = "failpoints")]
async fn three_editors(port: u16, board: &str, owner: &str) -> Vec<Client> {
    let mut cs = Vec::new();
    for id in [0xc01, 0xc02, 0xc03] {
        let mut c = Client::new(id);
        c.connect(port, board, owner).await.expect("editor");
        assert!(edits_until_decided(&mut c, 1, move_op).await.is_empty());
        cs.push(c);
    }
    cs
}

#[cfg(feature = "failpoints")]
#[tokio::test(flavor = "multi_thread")]
async fn a_crash_between_write_and_ack_loses_nothing_and_doubles_nothing() {
    // Group commit writes a batch of transactions in one fsync and acks them after it. Kill the
    // server exactly before a commit (nothing of that batch is on disk, nothing acked) and
    // exactly after one (all of it on disk, nothing acked yet). Either way, after a restart every
    // edit is in the log exactly once: none acked is lost (a client holding an entry the server
    // lost would be "ahead of the log"), and none is applied twice (the resend is a duplicate).
    for point in ["before_commit", "after_commit"] {
        let dir = tempfile::tempdir().expect("tempdir");
        let spec = format!("{point}:20");
        let server = Server::start_with(dir.path(), None, &[("MAPCRO_FAILPOINT", spec.as_str())]);
        let (board, owner) = server.create_board();
        let mut probe = Client::new(0xc00);
        probe.connect(server.port, &board, &owner).await.expect("probe");
        let genesis = probe.replica().confirmed().clone();
        probe.drop_connection();
        let mut cs = three_editors(server.port, &board, &owner).await;
        // Paced edits from all three, until the failpoint kills the server.
        let per = 60;
        let mut died = false;
        for i in 0..per {
            let mut lost = false;
            for c in cs.iter_mut() {
                let ops = move_op(c.replica(), i);
                lost |= !c.try_edit(ops).await;
            }
            // Read as we go: an ack that arrives is applied (and would be lost if the server
            // had sent it before its commit).
            for c in cs.iter_mut() {
                lost |= !c.pump_for(Duration::from_millis(5)).await;
            }
            if lost || ureq::get(&server.url("/healthz")).call().is_err() {
                died = true;
                // The rest are made offline and sent on reconnect.
                for j in i + 1..per {
                    for c in cs.iter_mut() {
                        c.drop_connection();
                        let ops = move_op(c.replica(), j);
                        c.edit(ops).await;
                    }
                }
                break;
            }
        }
        assert!(died, "{point}: the failpoint never fired");
        let (d, port) = server.kill9();
        for c in cs.iter_mut() {
            c.drop_connection();
        }
        let server = Server::start(&d, Some(port));
        for c in cs.iter_mut() {
            c.connect(server.port, &board, &owner).await.expect("reconnect: nothing acked was lost");
            c.until_saved().await;
        }
        let made = 3 * (per as u64 + 1);
        let fresh = fresh_catch_up(server.port, &board, &owner, 0xc0f, made).await;
        for c in &mut cs {
            while c.replica().last_seq() < made {
                c.pump_one().await.expect("caught up");
            }
            assert_eq!(c.replica().last_seq(), made, "{point}: every edit exactly once");
            assert_eq!(c.replica().confirmed(), fresh.replica().confirmed(), "{point}: everyone converges");
        }
        // Exactly once, counted: a client at seq 0 reads the whole log.
        let mut reader = client_at(0xc0e, genesis, 0);
        reader.connect(server.port, &board, &owner).await.expect("reader");
        while reader.replica().last_seq() < made {
            reader.pump_one().await.expect("whole log");
        }
        assert_eq!(reader.replica().confirmed(), fresh.replica().confirmed(), "{point}: the log replays to the board");
        eprintln!("{point}: killed mid-burst; {made} edits, each in the log once");
    }
}

#[cfg(feature = "failpoints")]
#[tokio::test(flavor = "multi_thread")]
async fn transactions_arriving_together_share_one_commit() {
    // Group commit: what queues while one batch is being made durable goes in the next, so a
    // burst from several editors costs a few fsyncs, not one per transaction.
    let dir = tempfile::tempdir().expect("tempdir");
    let stats = dir.path().join("commits.txt");
    let server = Server::start_with(dir.path(), None, &[("MAPCRO_COMMIT_STATS", stats.to_str().expect("utf8"))]);
    let (board, owner) = server.create_board();
    let mut cs = three_editors(server.port, &board, &owner).await;
    for c in cs.iter_mut() {
        for i in 0..100 {
            let ops = move_op(c.replica(), i);
            c.edit(ops).await;
        }
    }
    for c in cs.iter_mut() {
        c.until_saved().await;
    }
    let sizes: Vec<usize> = std::fs::read_to_string(&stats)
        .expect("stats")
        .lines()
        .filter_map(|l| l.split(' ').next()?.parse().ok())
        .collect();
    let total: usize = sizes.iter().sum();
    let biggest = sizes.iter().max().copied().unwrap_or(0);
    eprintln!("{total} engine messages in {} commits, the biggest {biggest}", sizes.len());
    assert!(biggest > 1, "every commit held one message: {sizes:?}");
    assert!(sizes.len() < total, "{} commits for {total} messages", sizes.len());
}

// ---- compaction (spec §9) ----

fn base_and_ops(path: &std::path::Path, board: &str) -> (i64, i64, Option<i64>) {
    let c = rusqlite::Connection::open(path).expect("open");
    let base: i64 = c.query_row("SELECT base_seq FROM boards WHERE id = ?1", [board], |r| r.get(0)).expect("board");
    let (n, min): (i64, Option<i64>) = c.query_row("SELECT COUNT(*), MIN(seq) FROM ops WHERE board = ?1", [board], |r| Ok((r.get(0)?, r.get(1)?))).expect("ops");
    (base, n, min)
}

#[tokio::test(flavor = "multi_thread")]
async fn compaction_keeps_history_bounded_and_old_copies_rebase() {
    // The log is compacted: the board becomes the base, the newest entries stay, older ones go.
    // A client whose copy is older than what's kept gets a rebase: the board now, and which of
    // its transactions that already holds. Here client A's five edits are applied but it never
    // hears the acks; by the time it's back, those entries are compacted away (and the server
    // restarted). It must drop them as decided, not resend them as new: every edit exactly once.
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("mapcro.sqlite");
    let env = [("BOARD_COMPACT_OPS", "40"), ("BOARD_KEEP_OPS", "10")];
    let server = Server::start_with(dir.path(), None, &env);
    let (board, owner) = server.create_board();
    let mut b = Client::new(0xb0b);
    b.connect(server.port, &board, &owner).await.expect("b");
    let mut a = Client::new(0xa0a);
    a.connect(server.port, &board, &owner).await.expect("a");
    for i in 0..5 {
        let ops = move_op(a.replica(), i);
        a.edit(ops).await;
    }
    // B sees all five land; A leaves without reading a single ack.
    while b.replica().last_seq() < 5 {
        b.pump_one().await.expect("b hears a's edits");
    }
    a.drop_connection();
    assert_eq!(a.replica().pending().count(), 5, "a never heard its acks");
    assert!(edits_until_decided(&mut b, 100, move_op).await.is_empty());
    let (base, kept, oldest) = base_and_ops(&path, &board);
    assert!(base >= 80 && kept <= 50, "base {base}, {kept} entries kept from {oldest:?}");

    let (d, port) = server.kill9();
    b.drop_connection();
    let server = Server::start_with(&d, Some(port), &env);
    a.connect(server.port, &board, &owner).await.expect("a is rebased, not refused");
    a.until_saved().await;
    b.connect(server.port, &board, &owner).await.expect("b");
    b.until_saved().await;
    assert_eq!(a.replica().last_seq(), 105, "a's five edits are in the board once, not resent as new");
    assert_eq!(a.replica().confirmed(), b.replica().confirmed());
    // And A carries on normally.
    assert!(edits_until_decided(&mut a, 2, move_op).await.is_empty());
    while b.replica().last_seq() < 107 {
        b.pump_one().await.expect("b hears a");
    }
    assert_eq!(a.replica().confirmed(), b.replica().confirmed());
    let fresh = fresh_catch_up(server.port, &board, &owner, 0xf0f, 107).await;
    assert_eq!(fresh.replica().confirmed(), b.replica().confirmed());
    eprintln!("compaction: base at {base}, {kept} entries kept (from {oldest:?}); a rebased and in sync at 107");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_real_v4_database_migrates_and_its_board_compacts_and_rebases() {
    // A database the v4 server (ea9463a) wrote: zstd-v1 rows and base, a registered client and a
    // stored rejection (tests/fixtures/v4-board.*). The v5 server migrates it (client_seqs),
    // serves it, compacts it, and rebases the v4 client's own copy when it comes back below
    // the floor, with its unsent edits landing once.
    let fx: serde_json::Value = serde_json::from_str(include_str!("fixtures/v4-board.json")).expect("fixture");
    let (board, owner) = (fx["board"].as_str().expect("board").to_owned(), fx["owner_token"].as_str().expect("token").to_owned());
    let entries = fx["entries"].as_u64().expect("entries");
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("mapcro.sqlite");
    std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/v4-board.sqlite"), &path).expect("copy fixture");
    let env = [("BOARD_COMPACT_OPS", "10"), ("BOARD_KEEP_OPS", "3")];
    let server = Server::start_with(dir.path(), None, &env);
    {
        let c = rusqlite::Connection::open(&path).expect("open");
        let v: String = c.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0)).expect("version");
        assert_eq!(v, "6", "migrated to the current schema");
        let codecs: i64 = c.query_row("SELECT COUNT(*) FROM ops WHERE codec = 'zstd-v1'", [], |r| r.get(0)).expect("ops");
        assert_eq!(codecs as u64, entries, "the v4 rows are untouched");
    }
    // The board as v4 left it: the note survived; the refused second note didn't.
    let fresh = fresh_catch_up(server.port, &board, &owner, 0xf5f5, entries).await;
    let note = |r: &Replica, id: u128| r.view().live(mapcro_schema::RecordId(id)).cloned();
    assert!(matches!(note(fresh.replica(), 0xa0a0), Some(Record::Note(n)) if n.text == "kept across the migration"));
    assert!(note(fresh.replica(), 0xb0b0).is_none());
    assert!(matches!(note(fresh.replica(), 0xc0c0), Some(Record::Stroke(_))));

    // The v4 client's binding holds: its id with another secret is refused.
    let me = u128::from_str_radix(fx["client"].as_str().expect("client"), 16).expect("hex");
    match raw_hello(server.port, &board, &owner, me).await {
        Some(WireOut::Msg { msg: ServerMsg::Fatal(why) }) => assert!(why.contains("another client"), "{why}"),
        other => panic!("expected Fatal, got {other:?}"),
    }
    // The v4 client itself comes back: a copy at the head v4 left, its next cseq, two offline edits.
    let state = serde_json::json!({
        "client": fx["client"], "secret": fx["secret"], "confirmed": fresh.replica().confirmed(), "last_seq": entries,
        "pending": [], "next_cseq": fx["next_cseq"], "undo": [], "redo": [], "rejected": [],
    });
    let mut old = Client::new(me);
    old.replica = Some(Replica::from_state(serde_json::from_value(state).expect("replica state")));
    old.replica_mut().edit(move_op(fresh.replica(), 900)).expect("offline edit");
    old.replica_mut().edit(move_op(fresh.replica(), 901)).expect("offline edit");
    // Meanwhile the board moves on and compacts past it.
    let mut w = Client::new(0xf6f6);
    w.connect(server.port, &board, &owner).await.expect("writer");
    assert!(edits_until_decided(&mut w, 25, move_op).await.is_empty());
    let (base, kept, oldest) = base_and_ops(&path, &board);
    assert!(oldest.is_some_and(|o| o as u64 > entries + 1), "compacted past the old copy: base {base}, {kept} kept from {oldest:?}");
    old.connect(server.port, &board, &owner).await.expect("the old client is rebased, not refused");
    old.until_saved().await;
    while w.replica().last_seq() < entries + 27 {
        w.pump_one().await.expect("w hears the old client's edits");
    }
    assert_eq!(old.replica().last_seq(), entries + 27, "its two offline edits landed once");
    assert_eq!(old.replica().confirmed(), w.replica().confirmed());
    eprintln!("v4 fixture: migrated, {entries} rows kept; compacted to base {base} (oldest kept {oldest:?}); the v4 client rebased");
}

#[tokio::test(flavor = "multi_thread")]
async fn compaction_means_a_board_never_fills() {
    // With compaction on, the history caps are a backstop: the same rewrites that fill a
    // 64 KiB quota with compaction off (`the_byte_quota_counts_history_not_board_size`) are all
    // accepted, and what's kept stays under the quota.
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("mapcro.sqlite");
    let server = Server::start_with(dir.path(), None, &[("BOARD_MAX_BYTES", "65536")]);
    let (board, owner) = server.create_board();
    let mut a = Client::new(0xc4d);
    a.connect(server.port, &board, &owner).await.expect("connect");
    let scene = scene_of(a.replica());
    let note = mapcro_schema::RecordId(0xc4c5);
    a.edit(vec![Op::Create { id: note, record: Record::Note(mapcro_schema::Note { scene, text: "x".into() }) }]).await;
    let letters = |i: usize| -> String {
        let mut x = 0x9e37_79b9_u32.wrapping_add(i as u32);
        (0..4000)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (b'a' + (x % 26) as u8) as char
            })
            .collect()
    };
    let set = |_: &Replica, i: usize| vec![Op::Set { id: note, value: FieldValue::NoteText(letters(i)) }];
    let rejected = edits_until_decided(&mut a, 60, set).await;
    assert!(rejected.is_empty(), "a board with compaction never fills: {rejected:?}");
    let kept: i64 = rusqlite::Connection::open(&path)
        .expect("open")
        .query_row("SELECT COALESCE(SUM(length(tx)), 0) FROM ops WHERE board = ?1", [&board], |r| r.get(0))
        .expect("kept");
    assert!(kept < 65536, "{kept} bytes kept");
    let fresh = fresh_catch_up(server.port, &board, &owner, 0xc4e, 61).await;
    assert_eq!(fresh.replica().confirmed(), a.replica().confirmed());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pruned_rejection_survives_a_restart() {
    // Review 2026-11-07, finding 2. A client's last decided transaction was refused; once it
    // has heard that (its next hello's pending_from is past it), the stored rejection is pruned.
    // After a restart the server rebuilds each client's next cseq from the log and what's
    // stored: with the rejection gone, it came back one short, and the client's next edit was a
    // "sequence gap" on every reconnect, wedging that device on the board.
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let mut a = Client::new(0x2a1);
    let mut b = Client::new(0x2a2);
    a.connect(server.port, &board, &owner).await.expect("a");
    b.connect(server.port, &board, &owner).await.expect("b");
    assert!(edits_until_decided(&mut a, 1, move_op).await.is_empty()); // a's cseq 0: applied
    let scene = scene_of(a.replica());
    let note = |id: u128| vec![Op::Create { id: mapcro_schema::RecordId(id), record: Record::Note(mapcro_schema::Note { scene, text: "x".into() }) }];
    assert!(edits_until_decided(&mut b, 1, |_, _| note(0x2b1)).await.is_empty());
    // a hasn't seen b's note: its own (cseq 1) is refused as a duplicate.
    assert_eq!(edits_until_decided(&mut a, 1, |_, _| note(0x2a9)).await, [Reject::Duplicate]);
    // a reconnects: its hello says it has heard everything below 2, so the rejection is pruned.
    a.drop_connection();
    a.connect(server.port, &board, &owner).await.expect("a again");
    a.until_saved().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (d, port) = server.kill9();
    a.drop_connection();
    b.drop_connection();
    let server = Server::start(&d, Some(port));
    a.connect(server.port, &board, &owner).await.expect("a after the restart");
    assert!(edits_until_decided(&mut a, 2, move_op).await.is_empty(), "a's next edits are accepted, not a sequence gap");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_migration_interrupted_by_a_crash_still_boots() {
    // Review 2026-11-07, finding 3: a crash between a migration step and its version bump left
    // a database the server couldn't open (the step ran again and failed). Here, the real v4
    // fixture with v5's table already created but the version still 4.
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("mapcro.sqlite");
    std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/v4-board.sqlite"), &path).expect("copy fixture");
    rusqlite::Connection::open(&path)
        .expect("open")
        .execute_batch(
            "CREATE TABLE client_seqs (board TEXT NOT NULL REFERENCES boards(id), client TEXT NOT NULL,
               next_cseq INTEGER NOT NULL, PRIMARY KEY (board, client)) WITHOUT ROWID;",
        )
        .expect("half-migrated");
    let server = Server::start(dir.path(), None);
    let fx: serde_json::Value = serde_json::from_str(include_str!("fixtures/v4-board.json")).expect("fixture");
    let (board, owner) = (fx["board"].as_str().expect("board").to_owned(), fx["owner_token"].as_str().expect("token").to_owned());
    let fresh = fresh_catch_up(server.port, &board, &owner, 0x3f3, fx["entries"].as_u64().expect("entries")).await;
    assert!(fresh.replica().view().live(mapcro_schema::RecordId(0xa0a0)).is_some());
    let v: String = rusqlite::Connection::open(&path).expect("open").query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0)).expect("v");
    assert_eq!(v, "6", "migrated to the current schema");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_compaction_floor_never_moves_back() {
    // Review 2026-11-07, finding 6: a compaction whose keep budget covers every row returned a
    // floor of 0, and the server then served catch-up from rows long gone.
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start_with(dir.path(), None, &[("BOARD_COMPACT_OPS", "20"), ("BOARD_KEEP_OPS", "2")]);
    let (board, owner) = server.create_board();
    let mut w = Client::new(0x6a1);
    let mut c = Client::new(0x6a2);
    w.connect(server.port, &board, &owner).await.expect("w");
    c.connect(server.port, &board, &owner).await.expect("c");
    assert!(edits_until_decided(&mut w, 3, move_op).await.is_empty());
    while c.replica().last_seq() < 3 {
        c.pump_one().await.expect("c");
    }
    c.drop_connection(); // a copy at seq 3
    assert!(edits_until_decided(&mut w, 27, move_op).await.is_empty()); // compacts past it
    let (d, port) = server.kill9();
    w.drop_connection();
    // A bigger keep budget than there are rows: the next compaction keeps them all.
    let server = Server::start_with(&d, Some(port), &[("BOARD_COMPACT_OPS", "20"), ("BOARD_KEEP_OPS", "1000")]);
    w.connect(server.port, &board, &owner).await.expect("w again");
    assert!(edits_until_decided(&mut w, 25, move_op).await.is_empty());
    c.connect(server.port, &board, &owner).await.expect("c comes back from below the floor");
    while c.replica().last_seq() < w.replica().last_seq() {
        c.pump_one().await.expect("c is rebased, not served catch-up from rows that are gone");
    }
    assert_eq!(c.replica().confirmed(), w.replica().confirmed());
}

#[cfg(feature = "failpoints")]
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_compaction_leaves_the_room_up() {
    // Review finding 5: compaction runs after a commit, so its failure loses nothing. It used to
    // close the room (crash-only), which on a persistent error means a reconnect loop.
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start_with(dir.path(), None, &[("BOARD_COMPACT_OPS", "10"), ("MAPCRO_INJECT", "compact_error")]);
    let (board, owner) = server.create_board();
    let mut w = Client::new(0x5c1);
    w.connect(server.port, &board, &owner).await.expect("w");
    assert!(edits_until_decided(&mut w, 30, move_op).await.is_empty(), "edits keep landing");
    let fresh = fresh_catch_up(server.port, &board, &owner, 0x5c2, 30).await;
    assert_eq!(fresh.replica().confirmed(), w.replica().confirmed());
}

/// How a stale hello ends: the connection closes (and why), or it's rebased straight away.
#[cfg(feature = "failpoints")]
#[derive(Debug, PartialEq)]
enum StaleHello {
    Closed(CloseReason),
    Rebased,
}

#[cfg(feature = "failpoints")]
async fn stale_hello_outcome(ws: &mut Ws) -> Option<StaleHello> {
    loop {
        match recv(ws).await? {
            WireOut::Closed { reason } => return Some(StaleHello::Closed(reason)),
            WireOut::Msg { msg: ServerMsg::Rebase { .. } } => return Some(StaleHello::Rebased),
            _ => continue,
        }
    }
}

#[cfg(feature = "failpoints")]
#[tokio::test(flavor = "multi_thread")]
async fn compaction_in_the_same_batch_as_a_stale_hello_rebases_not_errors() {
    // Review finding 1: a catch-up is a range the socket reads later. Compaction in the same
    // batch as the hello deleted rows the range named, and the read failed as a storage error.
    // Now it's "too slow" (no error), and the client's reconnect is rebased.
    // Commits pause 600 ms (so the hello and the edits that trigger compaction share a batch),
    // and the catch-up read waits 2 s (so compaction has happened by then, whichever batch the
    // hello landed in).
    let dir = tempfile::tempdir().expect("tempdir");
    let env = [("BOARD_COMPACT_OPS", "20"), ("BOARD_KEEP_OPS", "2"), ("MAPCRO_PAUSE_COMMIT_MS", "600"), ("MAPCRO_PAUSE_CATCHUP_MS", "2000")];
    let server = Server::start_with(dir.path(), None, &env);
    let (board, owner) = server.create_board();
    let mut w = Client::new(0x1a1);
    let mut c = Client::new(0x1a2);
    w.connect(server.port, &board, &owner).await.expect("w");
    c.connect(server.port, &board, &owner).await.expect("c");
    assert!(edits_until_decided(&mut w, 5, move_op).await.is_empty());
    while c.replica().last_seq() < 5 {
        c.pump_one().await.expect("c");
    }
    c.drop_connection(); // a copy at seq 5
    assert!(edits_until_decided(&mut w, 12, move_op).await.is_empty()); // 17: not due yet
    // C authenticates; then the room is kept busy (a commit pausing) while C's hello and the
    // edits that make compaction due queue behind it, and so share the next batch.
    let mut raw = open_ws(server.port, ORIGIN).await.expect("ws");
    send(&mut raw, &WireIn::Auth { board: board.clone(), token: owner.clone(), known_seq: Some(5), build: None }).await;
    assert!(matches!(recv(&mut raw).await, Some(WireOut::Ready { .. })));
    let ops = move_op(w.replica(), 100);
    w.edit(ops).await;
    tokio::time::sleep(Duration::from_millis(200)).await; // that edit's commit is now pausing
    let hello = mapcro_engine::Hello { client: c.id, secret: format!("secret-{:032x}", c.id.0), last_seq: 5, pending_from: 0 };
    send(&mut raw, &WireIn::Msg { msg: ClientMsg::Hello(hello) }).await;
    for i in 0..5 {
        let ops = move_op(w.replica(), 101 + i);
        w.edit(ops).await;
    }
    // Usually the hello shares the batch and its catch-up is overtaken: closed as too slow. Under
    // load W's edits can reach the room first, on their own socket, and then the hello is simply
    // rebased. Either is right; a storage failure never is.
    let outcome = stale_hello_outcome(&mut raw).await;
    eprintln!("stale hello: {outcome:?}");
    assert!(
        matches!(outcome, Some(StaleHello::Closed(CloseReason::TooSlow) | StaleHello::Rebased)),
        "compacted away: retry or rebase, not {outcome:?}"
    );
    w.until_saved().await;
    c.connect(server.port, &board, &owner).await.expect("c is rebased");
    while c.replica().last_seq() < w.replica().last_seq() {
        c.pump_one().await.expect("in sync");
    }
    assert_eq!(c.replica().confirmed(), w.replica().confirmed());
}

#[cfg(feature = "failpoints")]
#[tokio::test(flavor = "multi_thread")]
async fn compaction_during_a_slow_paged_catch_up_rebases_not_errors() {
    // Review finding 1, the other half: a catch-up several pages long, read slowly, and
    // compaction lands between pages.
    let dir = tempfile::tempdir().expect("tempdir");
    let env = [("BOARD_COMPACT_OPS", "40"), ("BOARD_KEEP_OPS", "2"), ("MAPCRO_PAUSE_CATCHUP_MS", "300")];
    let server = Server::start_with(dir.path(), None, &env);
    let (board, owner) = server.create_board();
    let mut w = Client::new(0x1b1);
    let mut c = Client::new(0x1b2);
    w.connect(server.port, &board, &owner).await.expect("w");
    c.connect(server.port, &board, &owner).await.expect("c");
    assert!(edits_until_decided(&mut w, 1, move_op).await.is_empty());
    while c.replica().last_seq() < 1 {
        c.pump_one().await.expect("c");
    }
    c.drop_connection(); // a copy at seq 1
    let scene = scene_of(w.replica());
    // 20 entries of a 512-point stroke each (~12 KB): about four 64 KiB pages of catch-up.
    for i in 0..20 {
        assert!(edits_until_decided(&mut w, 1, |_, _| stroke_ops(scene, 0x1b00 + i, 1)).await.is_empty());
    }
    c.connect(server.port, &board, &owner).await.expect("c");
    while c.replica().last_seq() < 2 {
        c.pump_one().await.expect("the first page arrives");
    }
    // Now compact past where C's catch-up has got to.
    assert!(edits_until_decided(&mut w, 25, move_op).await.is_empty());
    let mut end = Ok(());
    while c.replica().last_seq() < w.replica().last_seq() {
        end = c.pump_one().await;
        if end.is_err() {
            break;
        }
    }
    assert_eq!(end, Err(Some(CloseReason::TooSlow)), "compacted away mid-stream: retry, not a storage failure");
    c.drop_connection();
    c.connect(server.port, &board, &owner).await.expect("c is rebased");
    while c.replica().last_seq() < w.replica().last_seq() {
        c.pump_one().await.expect("in sync");
    }
    assert_eq!(c.replica().confirmed(), w.replica().confirmed());
}

/// A tab from before a deploy (another protocol build) is closed as `Outdated` so it reloads;
/// this build, and clients that send no build, get in (review 2026-11-07, finding 2).
#[tokio::test(flavor = "multi_thread")]
async fn a_client_from_another_build_is_told_it_is_outdated() {
    let dir = tempfile::tempdir().expect("tempdir");
    let server = Server::start(dir.path(), None);
    let (board, owner) = server.create_board();
    let auth = |build: Option<&str>| WireIn::Auth { board: board.clone(), token: owner.clone(), known_seq: None, build: build.map(Into::into) };
    let mut ws = open_ws(server.port, ORIGIN).await.expect("ws");
    send(&mut ws, &auth(Some("0000000000000000"))).await;
    assert!(matches!(recv(&mut ws).await, Some(WireOut::Closed { reason: CloseReason::Outdated })));
    for build in [Some(mapcro_schema::BUILD_ID), None] {
        let mut ws = open_ws(server.port, ORIGIN).await.expect("ws");
        send(&mut ws, &auth(build)).await;
        assert!(matches!(recv(&mut ws).await, Some(WireOut::Ready { .. })), "build {build:?} gets in");
    }
}
