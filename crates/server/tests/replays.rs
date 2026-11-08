//! The replay tier on the real server binary (spec §6a, §11): uploads under their caps, the job
//! lifecycle through the on-disk queue (the test plays the worker: the queue is the contract),
//! the cache, tier selection, and the CDN fetch through a fake deadlock-api and a fake CDN.

use mapcro_replay::timeline::{Camp, Player, Timeline, ZipTrack};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Server {
    child: Child,
    port: u16,
    data: tempfile::TempDir,
    queue: tempfile::TempDir,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).expect("port")
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().http_status_as_error(false).build().into()
}

impl Server {
    fn start(upstream: u16, env: &[(&str, &str)]) -> Server {
        let (data, queue) = (tempfile::tempdir().expect("data"), tempfile::tempdir().expect("queue"));
        let port = free_port();
        let child = Command::new(env!("CARGO_BIN_EXE_mapcro-server"))
            .env("PORT", port.to_string())
            .env("DATA_DIR", data.path())
            .env("REPLAY_DIR", queue.path())
            .env("PUBLIC_ORIGIN", "http://localhost:5173")
            .env("RUST_LOG", "warn")
            .env("MATCH_API_BASE", format!("http://127.0.0.1:{upstream}"))
            .env("REPLAY_CDN_BASE", format!("http://127.0.0.1:{upstream}/cdn"))
            .envs(env.iter().copied())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("server starts");
        let s = Server { child, port, data, queue };
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

    fn q(&self, sub: &str) -> PathBuf {
        self.queue.path().join(sub)
    }

    fn board(&self) -> (String, String, String) {
        let v: serde_json::Value = ureq::post(&self.url("/api/boards")).send_json(serde_json::json!({ "title": "Replays" })).expect("create").body_mut().read_json().expect("json");
        let (board, owner) = (v["board"].as_str().unwrap_or_default().to_owned(), v["owner_token"].as_str().unwrap_or_default().to_owned());
        let v: serde_json::Value = ureq::post(&self.url(&format!("/api/boards/{board}/links")))
            .header("authorization", &format!("Bearer {owner}"))
            .send_json(serde_json::json!({ "role": "view", "label": "v" }))
            .expect("mint")
            .body_mut()
            .read_json()
            .expect("json");
        let view = v["token"].as_str().unwrap_or_default().to_owned();
        (board, owner, view)
    }

    fn upload(&self, board: &str, token: &str, id: &str, body: &[u8]) -> (u16, serde_json::Value) {
        let mut r = agent()
            .post(&self.url(&format!("/api/boards/{board}/replays/{id}/upload")))
            .header("authorization", &format!("Bearer {token}"))
            .header("content-type", "application/octet-stream")
            .send(body)
            .expect("request");
        (r.status().as_u16(), r.body_mut().read_json().unwrap_or_default())
    }

    fn call(&self, method: &str, path: &str, token: &str) -> (u16, serde_json::Value) {
        let a = agent();
        let url = self.url(path);
        let auth = format!("Bearer {token}");
        let mut r = match method {
            "POST" => a.post(&url).header("authorization", &auth).send_empty(),
            _ => a.get(&url).header("authorization", &auth).call(),
        }
        .expect("request");
        (r.status().as_u16(), r.body_mut().read_json().unwrap_or_default())
    }

    fn status(&self, board: &str, token: &str, id: &str) -> serde_json::Value {
        self.call("GET", &format!("/api/boards/{board}/replays/{id}"), token).1
    }

    fn until_state(&self, board: &str, token: &str, id: &str, want: &str) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let s = self.status(board, token, id);
            if s["state"] == want {
                return s;
            }
            assert!(Instant::now() < deadline, "never {want}: {s}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn files(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    v.sort();
    v
}

/// A fake deadlock-api and Valve CDN on one port: `routes` by path, hits counted by path.
struct Upstream {
    port: u16,
    hits: Arc<Mutex<HashMap<String, usize>>>,
}

fn upstream(routes: HashMap<String, (u16, Vec<u8>)>) -> Upstream {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let hits: Arc<Mutex<HashMap<String, usize>>> = Arc::default();
    let h = hits.clone();
    let routes = Arc::new(routes);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (routes, hits) = (routes.clone(), h.clone());
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    return;
                }
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).map(|n| n == 0).unwrap_or(true) || header == "\r\n" {
                        break;
                    }
                }
                let path = line.split_whitespace().nth(1).unwrap_or("").to_owned();
                *hits.lock().expect("lock").entry(path.clone()).or_default() += 1;
                let (status, body) = routes.get(&path).cloned().unwrap_or((404, b"{}".to_vec()));
                let mut out = stream;
                let head = format!("HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                let _ = out.write_all(head.as_bytes());
                let _ = out.write_all(&body);
            });
        }
    });
    Upstream { port, hits }
}

impl Upstream {
    fn hits(&self, path: &str) -> usize {
        self.hits.lock().expect("lock").get(path).copied().unwrap_or(0)
    }
}

fn fake_demo(len: usize) -> Vec<u8> {
    let mut v = mapcro_replay::DEM_MAGIC.to_vec();
    v.resize(len, 7);
    v
}

/// A timeline the worker could have written: two seconds, one player, one lane.
fn timeline(id: u64) -> Timeline {
    Timeline {
        match_id: id,
        start_time: 0,
        duration_s: 1,
        source: "replay".into(),
        tier: "replay".into(),
        build: 6813,
        players: vec![Player { team: "amber".into(), slot: 0, hero_id: 6, name: Some("Coach".into()), x: vec![Some(1), Some(2)], y: vec![Some(3), Some(4)], health: vec![100, 90], deaths: vec![], souls: vec![[0, 400]], ult: vec![Some(0), Some(100)] }],
        objectives: vec![],
        mid_boss: vec![],
        reanchored: 0,
        rifts: vec![],
        powerups: vec![],
        zips: vec![ZipTrack { lane: "lane4".into(), at: vec![[0, 480, 520]] }],
        camps: vec![Camp { key: "camp:neutral:lane0:3".into(), first_s: 0, cleared: vec![[1, 300]] }],
        events: vec![],
        troopers: None,
        objective_health: vec![],
    }
}

/// Play the worker for `job` (it only reads the inbox): mark it started, then post `result`.
fn work(server: &Server, job: &str, result: Result<&[u8], &str>) {
    assert!(["dem", "bz2", "zst"].iter().any(|e| server.q("inbox").join(format!("{job}.{e}")).exists()), "the job is queued");
    std::fs::write(server.q("outbox").join(format!("{job}.parsing")), b"").expect("parsing");
    finish(server, job, result);
}

fn finish(server: &Server, job: &str, result: Result<&[u8], &str>) {
    match result {
        Ok(bytes) => std::fs::write(server.q("outbox").join(format!("{job}.json")), bytes).expect("done"),
        Err(why) => std::fs::write(server.q("outbox").join(format!("{job}.failed")), why).expect("failed"),
    }
    let _ = std::fs::remove_file(server.q("outbox").join(format!("{job}.parsing")));
}

fn scope(board: &str) -> String {
    use sha2::Digest;
    let d = sha2::Sha256::digest(board.as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect::<String>()[..16].to_owned()
}

#[test]
fn uploads_need_an_editor_link_a_demo_and_room() {
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[("REPLAY_MAX_UPLOAD_BYTES", "100000")]);
    let (board, owner, view) = server.board();
    let id = "122134063";

    assert_eq!(server.upload(&board, "", id, &fake_demo(100)).0, 401, "no link");
    assert_eq!(server.upload(&board, &view, id, &fake_demo(100)).0, 403, "view links can't upload");
    let (other, other_owner, _) = server.board();
    assert_eq!(server.upload(&board, &other_owner, id, &fake_demo(100)).0, 403, "another board's link");
    assert_eq!(server.upload(&board, &owner, "0123", &fake_demo(100)).0, 400, "bad id");
    let (code, body) = server.upload(&board, &owner, id, b"MZ\x90\0\x03\0\0\0not a demo");
    assert_eq!((code, body["error"].as_str()), (415, Some("not_a_replay")), "bad magic");
    assert_eq!(server.upload(&board, &owner, id, b"PBD").0, 415, "too short for the magic");
    // Over the cap: refused up front by its length, and mid-stream when sent chunked.
    assert_eq!(server.upload(&board, &owner, id, &fake_demo(100_001)).0, 413);
    let big = fake_demo(300_000);
    // The server may answer 413 and close while the client is still sending: either way, refused.
    match agent()
        .post(&server.url(&format!("/api/boards/{board}/replays/{id}/upload")))
        .header("authorization", &format!("Bearer {owner}"))
        .send(ureq::SendBody::from_reader(&mut &big[..]))
    {
        Ok(r) => assert_eq!(r.status().as_u16(), 413, "chunked over the cap"),
        Err(e) => assert!(matches!(e, ureq::Error::Io(_)), "{e}"),
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while !files(&server.q("inbox")).is_empty() {
        assert!(Instant::now() < deadline, "refused uploads leave nothing behind: {:?}", files(&server.q("inbox")));
        std::thread::sleep(Duration::from_millis(20));
    }

    let (code, body) = server.upload(&board, &owner, id, &fake_demo(50_000));
    assert_eq!((code, body["state"].as_str()), (202, Some("queued")));
    let job = format!("{id}-{}", scope(&board));
    assert_eq!(files(&server.q("inbox")), [format!("{job}.dem")]);
    assert_eq!(std::fs::read(server.q("inbox").join(format!("{job}.dem"))).expect("queued").len(), 50_000);
    assert_eq!(server.status(&board, &view, id), serde_json::json!({ "state": "queued", "source": "upload" }), "view links read the state");
    assert_eq!(server.upload(&board, &owner, id, &fake_demo(100)).0, 409, "one job per board and match at a time");
    assert_eq!(server.status(&other, &other_owner, id)["state"], "none", "another board doesn't see it");

    // The 16 KiB body limit still holds on every other route, the replay ones included.
    let r = agent().post(&server.url(&format!("/api/boards/{board}/replays/{id}/fetch"))).header("authorization", &format!("Bearer {owner}")).send(&vec![b'x'; 20_000][..]).expect("request");
    assert_eq!(r.status().as_u16(), 413);
    let r = agent().post(&server.url("/api/boards")).header("content-type", "application/json").send(&vec![b' '; 20_000][..]).expect("request");
    assert_eq!(r.status().as_u16(), 413);
}

#[test]
fn uploads_are_rate_limited_and_the_queue_is_capped() {
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[("REPLAY_PER_CLIENT_PER_HOUR", "2"), ("REPLAY_MAX_QUEUED", "1")]);
    let (board, owner, _) = server.board();
    assert_eq!(server.upload(&board, &owner, "1", &fake_demo(100)).0, 202);
    let (code, body) = server.upload(&board, &owner, "2", &fake_demo(100));
    assert_eq!((code, body["error"].as_str()), (503, Some("queue_full")), "one queued job at most");
    work(&server, &format!("1-{}", scope(&board)), Err("old_map"));
    assert_eq!(server.until_state(&board, &owner, "1", "failed")["reason"], "old_map");
    assert_eq!(server.upload(&board, &owner, "2", &fake_demo(100)).0, 202);
    work(&server, &format!("2-{}", scope(&board)), Err("old_map"));
    server.until_state(&board, &owner, "2", "failed");
    let (code, body) = server.upload(&board, &owner, "3", &fake_demo(100));
    assert_eq!((code, body["error"].as_str()), (429, Some("rate_limited")));
}

#[test]
fn a_job_runs_to_a_cached_timeline_that_only_its_board_sees() {
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[]);
    let (board, owner, view) = server.board();
    let (other, other_owner, _) = server.board();
    let id = "130816395";
    let job = format!("{id}-{}", scope(&board));

    // Before any replay, the board's match route falls back to the metadata tier (upstream 404).
    assert_eq!(server.call("GET", &format!("/api/boards/{board}/matches/{id}"), &view), (404, serde_json::json!({ "error": "not_found" })));

    assert_eq!(server.upload(&board, &owner, id, &fake_demo(1000)).0, 202);
    std::fs::write(server.q("outbox").join(format!("{job}.parsing")), b"").expect("parsing");
    assert_eq!(server.status(&board, &owner, id)["state"], "parsing");
    let t = timeline(130816395);
    finish(&server, &job, Ok(&serde_json::to_vec(&t).expect("json")));
    assert_eq!(server.until_state(&board, &owner, id, "done")["source"], "upload");
    assert!(files(&server.q("outbox")).is_empty(), "collected");
    assert!(files(&server.q("inbox")).is_empty(), "the demo goes when its result is collected");
    assert_eq!(files(&server.data.path().join("replays")), [format!("{job}.json")], "cached");

    // Tier selection: this board gets the replay, a view link included; another board doesn't.
    let (code, got) = server.call("GET", &format!("/api/boards/{board}/matches/{id}"), &view);
    assert_eq!(code, 200);
    assert_eq!(got["tier"], "replay");
    assert_eq!(serde_json::from_value::<Timeline>(got).expect("timeline"), t);
    assert_eq!(server.call("GET", &format!("/api/boards/{other}/matches/{id}"), &other_owner).0, 404);
    assert_eq!(server.call("GET", &format!("/api/boards/{other}/matches/{id}"), &owner).0, 403, "a link only opens its own board");

    // Out-of-shape worker output is refused, never cached; the job fails.
    assert_eq!(server.upload(&other, &other_owner, id, &fake_demo(1000)).0, 202);
    let mut bad = serde_json::to_value(timeline(130816395)).expect("json");
    bad["players"][0]["health"] = serde_json::json!([100, 250]);
    work(&server, &format!("{id}-{}", scope(&other)), Ok(&serde_json::to_vec(&bad).expect("json")));
    assert_eq!(server.until_state(&other, &other_owner, id, "failed")["reason"], "parse_failed");
    // A timeline for another match than its job's is refused too.
    assert_eq!(server.upload(&other, &other_owner, "5", &fake_demo(1000)).0, 202);
    work(&server, &format!("5-{}", scope(&other)), Ok(&serde_json::to_vec(&timeline(6)).expect("json")));
    assert_eq!(server.until_state(&other, &other_owner, "5", "failed")["reason"], "parse_failed");
    assert_eq!(files(&server.data.path().join("replays")), [format!("{job}.json")]);

    // A worker's own reason is passed on; anything else reads as parse_failed.
    assert_eq!(server.upload(&other, &other_owner, "7", &fake_demo(1000)).0, 202);
    work(&server, &format!("7-{}", scope(&other)), Err("<script>"));
    assert_eq!(server.until_state(&other, &other_owner, "7", "failed")["reason"], "parse_failed");

    // A new upload replaces the board's timeline.
    assert_eq!(server.upload(&board, &owner, id, &fake_demo(1000)).0, 202);
    assert_eq!(server.status(&board, &owner, id)["state"], "queued");
}

fn bz2(bytes: &[u8]) -> Vec<u8> {
    let mut e = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
    e.write_all(bytes).expect("compress");
    e.finish().expect("finish")
}

#[test]
fn fetches_take_salts_then_the_cdn_under_caps() {
    let salts = |cluster: u32, salt: u64| serde_json::to_vec(&serde_json::json!({
        "match_id": 1, "cluster_id": cluster, "replay_salt": salt, "metadata_salt": 9,
        // Never followed: the URL is rebuilt from the two numbers.
        "demo_url": "http://169.254.169.254/latest/meta-data",
    })).expect("json");
    let demo = bz2(&fake_demo(200_000));
    let mut routes: HashMap<String, (u16, Vec<u8>)> = HashMap::new();
    routes.insert("/v1/matches/11/salts".into(), (200, salts(404, 77)));
    routes.insert("/cdn/404/1422450/11_77.dem.bz2".into(), (200, demo.clone()));
    routes.insert("/v1/matches/12/salts".into(), (200, salts(404, 78)));
    let mut huge = b"BZh9".to_vec();
    huge.resize(60_000, 1);
    routes.insert("/cdn/404/1422450/12_78.dem.bz2".into(), (200, huge));
    routes.insert("/v1/matches/13/salts".into(), (200, salts(404, 79)));
    routes.insert("/cdn/404/1422450/13_79.dem.bz2".into(), (200, b"<html>nope</html>".to_vec()));
    routes.insert("/v1/matches/14/salts".into(), (200, b"{\"match_id\":14}".to_vec()));
    let up = upstream(routes);
    let server = Server::start(up.port, &[("REPLAY_MAX_DOWNLOAD_BYTES", "50000")]);
    let (board, owner, view) = server.board();

    assert_eq!(server.call("POST", &format!("/api/boards/{board}/replays/11/fetch"), &view).0, 403, "view links can't fetch");
    // The 200 KB demo compresses to well under the 50 KB download cap; 12's body doesn't.
    assert!(demo.len() < 50_000);
    let (code, body) = server.call("POST", &format!("/api/boards/{board}/replays/11/fetch"), &owner);
    assert_eq!((code, body["state"].as_str()), (202, Some("fetching")));
    assert_eq!(server.until_state(&board, &owner, "11", "queued")["source"], "cdn");
    assert_eq!(files(&server.q("inbox")), ["11-cdn.bz2"]);
    assert_eq!(std::fs::read(server.q("inbox").join("11-cdn.bz2")).expect("queued"), demo);
    assert_eq!(up.hits("/cdn/404/1422450/11_77.dem.bz2"), 1);
    assert_eq!(up.hits("/latest/meta-data"), 0);
    // Fetched once, for every board: another board sees the same job.
    let (other, other_owner, _) = server.board();
    assert_eq!(server.status(&other, &other_owner, "11")["state"], "queued");
    assert_eq!(server.call("POST", &format!("/api/boards/{other}/replays/11/fetch"), &other_owner).1["state"], "queued");
    assert_eq!(up.hits("/v1/matches/11/salts"), 1, "no second fetch while one is queued");

    for (id, why) in [("12", "too_large"), ("13", "not_a_replay"), ("14", "no_replay"), ("15", "no_replay")] {
        server.call("POST", &format!("/api/boards/{board}/replays/{id}/fetch"), &owner);
        assert_eq!(server.until_state(&board, &owner, id, "failed")["reason"], why, "match {id}");
    }
    assert_eq!(files(&server.q("inbox")), ["11-cdn.bz2"], "failed downloads leave nothing behind");
    // A failure isn't retried within the hour.
    server.call("POST", &format!("/api/boards/{board}/replays/12/fetch"), &owner);
    assert_eq!(up.hits("/v1/matches/12/salts"), 1);

    // The worker's result is shared: done for both boards.
    work(&server, "11-cdn", Ok(&serde_json::to_vec(&timeline(11)).expect("json")));
    server.until_state(&board, &owner, "11", "done");
    assert_eq!(server.call("GET", &format!("/api/boards/{other}/matches/11"), &other_owner).1["tier"], "replay");
}

#[test]
fn a_dropped_upload_frees_its_slot_and_leaves_nothing() {
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[]);
    let (board, owner, _) = server.board();
    // Half a body, then the connection goes.
    let mut s = std::net::TcpStream::connect(("127.0.0.1", server.port)).expect("connect");
    let head = format!("POST /api/boards/{board}/replays/8/upload HTTP/1.1\r\nhost: x\r\nauthorization: Bearer {owner}\r\ncontent-length: 100000\r\n\r\n");
    s.write_all(head.as_bytes()).expect("head");
    s.write_all(&fake_demo(5000)).expect("some body");
    let deadline = Instant::now() + Duration::from_secs(5);
    while server.status(&board, &owner, "8")["state"] != "uploading" {
        assert!(Instant::now() < deadline, "never uploading");
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(s);
    let deadline = Instant::now() + Duration::from_secs(5);
    while server.status(&board, &owner, "8")["state"] != "none" || !files(&server.q("inbox")).is_empty() {
        assert!(Instant::now() < deadline, "{} {:?}", server.status(&board, &owner, "8"), files(&server.q("inbox")));
        std::thread::sleep(Duration::from_millis(20));
    }
    // The same client may upload again at once.
    assert_eq!(server.upload(&board, &owner, "8", &fake_demo(100)).0, 202);
}

#[test]
fn stale_jobs_and_partial_uploads_are_cleaned_up() {
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[("REPLAY_STALE_S", "1")]);
    let (board, owner, _) = server.board();
    std::fs::write(server.q("inbox").join(".9-abandoned.part"), b"x").expect("partial");
    assert_eq!(server.upload(&board, &owner, "9", &fake_demo(100)).0, 202);
    // Nobody works the queue: the job times out and its file goes.
    assert_eq!(server.until_state(&board, &owner, "9", "failed")["reason"], "timeout");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !files(&server.q("inbox")).is_empty() {
        assert!(Instant::now() < deadline, "{:?}", files(&server.q("inbox")));
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn a_board_keeps_the_matches_it_opened() {
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[]);
    let (board, owner, view) = server.board();
    let put = |id: &str, token: &str| {
        let mut r = agent().put(&server.url(&format!("/api/boards/{board}/matches/{id}"))).header("authorization", &format!("Bearer {token}")).send_empty().expect("request");
        (r.status().as_u16(), r.body_mut().read_json::<serde_json::Value>().unwrap_or_default())
    };
    assert_eq!(server.call("GET", &format!("/api/boards/{board}/matches"), &view), (200, serde_json::json!({ "matches": [] })));
    assert_eq!(put("111", &view).0, 403, "view links can't attach");
    assert_eq!(put("0x", &owner).0, 400);
    assert_eq!(put("111", &owner).0, 200);
    assert_eq!(put("222", &owner).1, serde_json::json!({ "matches": [222, 111] }));
    assert_eq!(put("111", &owner).1, serde_json::json!({ "matches": [111, 222] }), "newest first, once");
    assert_eq!(server.call("GET", &format!("/api/boards/{board}/matches"), &view).1, serde_json::json!({ "matches": [111, 222] }));
    let (other, other_owner, _) = server.board();
    assert_eq!(server.call("GET", &format!("/api/boards/{other}/matches"), &other_owner).1, serde_json::json!({ "matches": [] }));
    for i in 0..25 {
        put(&(1000 + i).to_string(), &owner);
    }
    assert_eq!(server.call("GET", &format!("/api/boards/{board}/matches"), &owner).1["matches"].as_array().map(Vec::len), Some(20));
}

/// Security review 2026-11-08, M1: a link planted where the server writes a partial upload is
/// never followed, and nothing outside the queue is touched.
#[test]
fn a_planted_link_in_the_inbox_is_never_followed() {
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[]);
    let (board, owner, _) = server.board();
    let target = server.data.path().join("server_owned_file");
    std::fs::write(&target, b"ORIGINAL SERVER DATA").expect("target");
    let job = format!("123456-{}", scope(&board));
    std::os::unix::fs::symlink(&target, server.q("inbox").join(format!(".{job}.part"))).expect("plant");
    let (code, _) = server.upload(&board, &owner, "123456", &fake_demo(1000));
    assert_ne!(code, 202);
    assert_eq!(std::fs::read(&target).expect("target"), b"ORIGINAL SERVER DATA");
    // The refused upload clears the planted link (unlinked, not followed), so the next works.
    assert_eq!(server.upload(&board, &owner, "123456", &fake_demo(1000)).0, 202);
    assert_eq!(std::fs::read(&target).expect("target"), b"ORIGINAL SERVER DATA");
}

/// Security review 2026-11-08, M2: results for jobs the server never queued are dropped, never
/// cached, so a worker can't publish a timeline for a match (or the shared CDN scope) at will.
#[test]
fn results_for_unqueued_jobs_are_dropped() {
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[]);
    let (board, owner, _) = server.board();
    let forged = serde_json::to_vec(&timeline(77)).expect("json");
    std::fs::write(server.q("outbox").join("77-cdn.json"), &forged).expect("forge cdn");
    std::fs::write(server.q("outbox").join(format!("77-{}.json", scope(&board))), &forged).expect("forge upload");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !files(&server.q("outbox")).is_empty() {
        assert!(Instant::now() < deadline, "{:?}", files(&server.q("outbox")));
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(files(&server.data.path().join("replays")).is_empty(), "nothing cached");
    assert_eq!(server.status(&board, &owner, "77")["state"], "none");
    // A queued upload's result can't be published under the CDN scope either.
    assert_eq!(server.upload(&board, &owner, "77", &fake_demo(1000)).0, 202);
    std::fs::write(server.q("outbox").join("77-cdn.json"), &forged).expect("forge cdn");
    let deadline = Instant::now() + Duration::from_secs(5);
    while server.q("outbox").join("77-cdn.json").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!server.data.path().join("replays/77-cdn.json").exists());
    assert_eq!(server.status(&board, &owner, "77")["state"], "queued");
}

/// 2026-11-08: only the standard 6v6 mode is understood. A Street Brawl or unknown-mode match is
/// refused at import with its reason, isn't fetched again, and no board can attach it.
#[test]
fn a_non_standard_mode_is_refused_and_never_attached() {
    let meta = |id: u64, mode: i64| serde_json::to_vec(&serde_json::json!({ "match_info": { "match_id": id, "duration_s": 60, "start_time": 0, "game_mode": mode, "match_mode": 1, "players": [] } })).expect("json");
    let path = |id: u64| format!("/v1/matches/{id}/metadata?disable_steam=true");
    let mut routes = HashMap::new();
    routes.insert(path(77), (200, meta(77, 4)));
    routes.insert(path(78), (200, meta(78, 99)));
    let up = upstream(routes);
    let server = Server::start(up.port, &[]);
    let (board, owner, _) = server.board();
    let get = |id: &str| server.call("GET", &format!("/api/matches/{id}"), "");
    let put = |id: &str| agent().put(&server.url(&format!("/api/boards/{board}/matches/{id}"))).header("authorization", &format!("Bearer {owner}")).send_empty().expect("request").status().as_u16();
    assert_eq!(get("77"), (422, serde_json::json!({ "error": "brawl" })));
    assert_eq!(get("78"), (422, serde_json::json!({ "error": "unsupported_mode" })));
    // Remembered: asked again, the upstream isn't.
    assert_eq!(get("77").1["error"], "brawl");
    assert_eq!(up.hits(&path(77)), 1);
    assert_eq!(put("77"), 422);
    assert_eq!(put("78"), 422);
    // Nor is a replay of it taken.
    assert_eq!(server.upload(&board, &owner, "77", &fake_demo(100)), (422, serde_json::json!({ "error": "brawl" })));
    assert_eq!(server.call("POST", &format!("/api/boards/{board}/replays/78/fetch"), &owner), (422, serde_json::json!({ "error": "unsupported_mode" })));
    assert_eq!(server.call("GET", &format!("/api/boards/{board}/matches"), &owner).1, serde_json::json!({ "matches": [] }));
}
