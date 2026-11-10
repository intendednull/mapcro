//! The replay tier on the real server binary (spec §6a, §11): uploads under their caps, the job
//! lifecycle through the on-disk queue (the test plays the worker: the queue is the contract),
//! the cache, tier selection, and the CDN fetch through a fake deadlock-api and a fake CDN.

use mapcro_replay::timeline::{Camp, Player, Timeline, ZipTrack};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod support;

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

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().http_status_as_error(false).build().into()
}

impl Server {
    fn start(upstream: u16, env: &[(&str, &str)]) -> Server {
        Self::start_with(upstream, env, false).0
    }

    /// Like `start`, but the server's stderr is collected so a test can assert on its log.
    fn start_logged(upstream: u16, env: &[(&str, &str)]) -> (Server, Arc<Mutex<String>>) {
        let (server, log) = Self::start_with(upstream, env, true);
        (server, log.expect("log"))
    }

    fn start_with(upstream: u16, env: &[(&str, &str)], logs: bool) -> (Server, Option<Arc<Mutex<String>>>) {
        let (data, queue) = (tempfile::tempdir().expect("data"), tempfile::tempdir().expect("queue"));
        let mut cmd = support::server();
        cmd.env("DATA_DIR", data.path())
            .env("REPLAY_DIR", queue.path())
            .env("PUBLIC_ORIGIN", "http://localhost:5173")
            .env("RUST_LOG", "warn")
            .env("MATCH_API_BASE", format!("http://127.0.0.1:{upstream}"))
            .env("REPLAY_CDN_BASE", format!("http://127.0.0.1:{upstream}/cdn"))
            .envs(env.iter().copied())
            .stdout(if logs { Stdio::piped() } else { Stdio::null() });
        let support::Started { mut child, port, .. } = support::start_or_panic(cmd);
        let log = logs.then(|| {
            // `tracing_subscriber::fmt` writes to stdout.
            let mut out = child.stdout.take().expect("stdout");
            let log = Arc::new(Mutex::new(String::new()));
            let sink = log.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = out.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    sink.lock().unwrap_or_else(|e| e.into_inner()).push_str(&String::from_utf8_lossy(&buf[..n]));
                }
            });
            log
        });
        let s = Server { child, port, data, queue };
        (s, log)
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

    /// An upload from the client at `ip` (the proxy's `X-Forwarded-For`, as Caddy sends it).
    fn upload_as(&self, board: &str, token: &str, id: &str, body: &[u8], ip: &str) -> (u16, serde_json::Value) {
        let mut r = agent()
            .post(&self.url(&format!("/api/boards/{board}/replays/{id}/upload")))
            .header("authorization", &format!("Bearer {token}"))
            .header("x-forwarded-for", ip)
            .header("content-type", "application/octet-stream")
            .send(body)
            .expect("request");
        (r.status().as_u16(), r.body_mut().read_json().unwrap_or_default())
    }

    /// Ask for (or keep) a place in line for an upload of `bytes`, as the client at `ip`.
    fn reserve(&self, board: &str, token: &str, id: &str, bytes: u64, ip: &str) -> (u16, serde_json::Value) {
        let mut r = agent()
            .post(&self.url(&format!("/api/boards/{board}/replays/{id}/reserve")))
            .header("authorization", &format!("Bearer {token}"))
            .header("x-forwarded-for", ip)
            .header("content-type", "application/json")
            .send(serde_json::json!({ "bytes": bytes }).to_string())
            .expect("request");
        (r.status().as_u16(), r.body_mut().read_json().unwrap_or_default())
    }

    /// The parse order the server wrote for the worker.
    fn order(&self) -> Vec<String> {
        std::fs::read_to_string(self.q("inbox").join(mapcro_replay::ORDER_FILE)).unwrap_or_default().lines().map(str::to_owned).collect()
    }

    fn until_order(&self, want: &[String]) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.order() != want {
            assert!(Instant::now() < deadline, "order {:?}, want {want:?}", self.order());
            std::thread::sleep(Duration::from_millis(50));
        }
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

    /// Ask for the match's replay from Valve, as the client at `ip`.
    fn fetch_as(&self, board: &str, token: &str, id: &str, ip: &str) -> (u16, serde_json::Value) {
        let mut r = agent()
            .post(&self.url(&format!("/api/boards/{board}/replays/{id}/fetch")))
            .header("authorization", &format!("Bearer {token}"))
            .header("x-forwarded-for", ip)
            .send_empty()
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

/// A queue directory's files, but the server's parse order (`inbox/.order`, always there).
fn files(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n != mapcro_replay::ORDER_FILE).collect())
        .unwrap_or_default();
    v.sort();
    v
}

/// A fake deadlock-api and Valve CDN on one port: `routes` by path, hits counted by path, and
/// each path's last request headers kept (lowercased).
struct Upstream {
    port: u16,
    hits: Arc<Mutex<HashMap<String, usize>>>,
    seen: Arc<Mutex<HashMap<String, Vec<String>>>>,
}

fn upstream(routes: HashMap<String, (u16, Vec<u8>)>) -> Upstream {
    upstream_with(routes, HashMap::new())
}

/// `extra`: response header lines by path (a 429's `retry-after`).
fn upstream_with(routes: HashMap<String, (u16, Vec<u8>)>, extra: HashMap<String, String>) -> Upstream {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let hits: Arc<Mutex<HashMap<String, usize>>> = Arc::default();
    let seen: Arc<Mutex<HashMap<String, Vec<String>>>> = Arc::default();
    let (h, sn) = (hits.clone(), seen.clone());
    let (routes, extra) = (Arc::new(routes), Arc::new(extra));
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (routes, extra, hits, seen) = (routes.clone(), extra.clone(), h.clone(), sn.clone());
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    return;
                }
                let mut headers = Vec::new();
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).map(|n| n == 0).unwrap_or(true) || header == "\r\n" {
                        break;
                    }
                    headers.push(header.trim().to_lowercase());
                }
                let path = line.split_whitespace().nth(1).unwrap_or("").to_owned();
                seen.lock().expect("lock").insert(path.clone(), headers);
                *hits.lock().expect("lock").entry(path.clone()).or_default() += 1;
                let (status, body) = routes.get(&path).cloned().unwrap_or((404, b"{}".to_vec()));
                let more = extra.get(&path).map(|h| format!("{h}\r\n")).unwrap_or_default();
                let mut out = stream;
                let head = format!("HTTP/1.1 {status} X\r\ncontent-length: {}\r\n{more}connection: close\r\n\r\n", body.len());
                let _ = out.write_all(head.as_bytes());
                let _ = out.write_all(&body);
            });
        }
    });
    Upstream { port, hits, seen }
}

impl Upstream {
    fn hits(&self, path: &str) -> usize {
        self.hits.lock().expect("lock").get(path).copied().unwrap_or(0)
    }
    fn headers(&self, path: &str) -> Vec<String> {
        self.seen.lock().expect("lock").get(path).cloned().unwrap_or_default()
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
        players: vec![Player { team: "amber".into(), slot: 0, hero_id: 6, name: Some("Coach".into()), x: vec![Some(1), Some(2)], y: vec![Some(3), Some(4)], health: vec![100, 90], deaths: vec![], souls: vec![[0, 400]], ult: vec![Some(0), Some(100)], respawn: vec![], seen: vec![], items: vec![[0, 77, 0]], casts: vec![[3, 88, 150]], effects: vec![[1, 9, 99, mapcro_replay::timeline::NO_HERO, 88, 1]], ..Default::default() }],
        objectives: vec![],
        mid_boss: vec![],
        reanchored: 0,
        rifts: vec![],
        powerups: vec![],
        zips: vec![ZipTrack { lane: "lane4".into(), at: vec![[0, 480, 520]] }],
        camps: vec![Camp { key: "camp:neutral:lane0:3".into(), first_s: 0, cleared: vec![[1, 300]] }],
        heals: vec![],
        crates: vec![],
        events: vec![],
        troopers: None,
        objective_health: vec![],
        urn: None,
        rejuv: vec![],
        format: mapcro_replay::timeline::FORMAT,
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
    assert_eq!(server.status(&board, &view, id), serde_json::json!({ "state": "queued", "source": "upload", "ahead": 0 }), "view links read the state");
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
    // Compressed for a client that accepts it (FORMAT 7: the edge proxy doesn't).
    let r = agent().get(&server.url(&format!("/api/boards/{board}/matches/{id}"))).header("authorization", &format!("Bearer {view}")).header("accept-encoding", "zstd").call().expect("request");
    assert_eq!(r.headers().get("content-encoding").and_then(|v| v.to_str().ok()), Some("zstd"));
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

#[test]
fn a_jobs_stats_are_collected_with_its_result_not_as_stray_output() {
    let up = upstream(HashMap::new());
    let (server, log) = Server::start_logged(up.port, &[]);
    let (board, owner, _) = server.board();
    let id = "130816396";
    let job = format!("{id}-{}", scope(&board));
    let stats = serde_json::json!({ "parse_s": 1.0, "demo_bytes": 1000 }).to_string();

    // The worker writes its record before its result, as the real worker does.
    assert_eq!(server.upload(&board, &owner, id, &fake_demo(1000)).0, 202);
    std::fs::write(server.q("outbox").join(format!("{job}.stats")), &stats).expect("stats");
    std::fs::write(server.q("outbox").join(format!("{job}.parsing")), b"").expect("parsing");
    finish(&server, &job, Ok(&serde_json::to_vec(&timeline(130816396)).expect("json")));
    server.until_state(&board, &owner, id, "done");
    assert!(!server.q("outbox").join(format!("{job}.stats")).exists(), "read with its result");

    // A record with no result and no queued job is not stray worker output: a young one is
    // cleaned up quietly. A stray result written after it makes the pass observable.
    let orphan = format!("7-{}", scope(&board));
    std::fs::write(server.q("outbox").join(format!("{orphan}.stats")), &stats).expect("orphan stats");
    std::fs::write(server.q("outbox").join(format!("{orphan}.json")), b"not a timeline").expect("stray result");
    let deadline = Instant::now() + Duration::from_secs(5);
    while server.q("outbox").join(format!("{orphan}.json")).exists() {
        assert!(Instant::now() < deadline, "stray result not collected");
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(100)); // let any warning reach the pipe
    let log = log.lock().unwrap_or_else(|e| e.into_inner()).clone();
    // The stray result proves the pass ran and its warning was captured; its stats is quiet.
    assert!(log.contains(".json"), "the stray result is logged: {log}");
    assert!(!log.contains(".stats"), "a stats file is not stray output: {log}");
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
    // "Fetch replay" tries a failure again (opening the match on its own doesn't, below).
    server.call("POST", &format!("/api/boards/{board}/replays/12/fetch"), &owner);
    assert_eq!(server.until_state(&board, &owner, "12", "failed")["reason"], "too_large");
    assert_eq!(up.hits("/v1/matches/12/salts"), 2);

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

/// QA 2026-11-08: a Brawl match cached before the mode refusal existed. The cache is our derived
/// shape, which then had no mode, so it was served and a board opened on it. A cache without a
/// mode is stale: fetched again once, it's refused, and no board can attach it.
#[test]
fn a_brawl_match_cached_before_the_refusal_is_refused_not_served() {
    let path = "/v1/matches/79/metadata?disable_steam=true".to_owned();
    let meta = serde_json::to_vec(&serde_json::json!({ "match_info": { "match_id": 79, "duration_s": 60, "start_time": 0, "game_mode": 4, "match_mode": 1, "players": [] } })).expect("json");
    let up = upstream(HashMap::from([(path.clone(), (200, meta))]));
    let server = Server::start(up.port, &[]);
    let legacy = serde_json::json!({ "match_id": 79, "start_time": 0, "duration_s": 60, "source": "deadlock-api.com", "players": [], "objectives": [], "mid_boss": [], "reanchored": 0, "events": [] });
    let cache = server.data.path().join("matches/79.json");
    std::fs::create_dir_all(cache.parent().expect("dir")).expect("mkdir");
    std::fs::write(&cache, serde_json::to_vec(&legacy).expect("json")).expect("legacy cache");
    let (board, owner, _) = server.board();
    // The board's own route (what Player opens) and the public one both refuse it.
    assert_eq!(server.call("GET", &format!("/api/boards/{board}/matches/79"), &owner), (422, serde_json::json!({ "error": "brawl" })));
    assert_eq!(server.call("GET", "/api/matches/79", ""), (422, serde_json::json!({ "error": "brawl" })));
    assert_eq!(up.hits(&path), 1, "fetched again once, then remembered");
    assert!(!cache.exists(), "the stale cache is gone");
    let put = agent().put(&server.url(&format!("/api/boards/{board}/matches/79"))).header("authorization", &format!("Bearer {owner}")).send_empty().expect("request").status().as_u16();
    assert_eq!(put, 422);
    assert_eq!(server.call("GET", &format!("/api/boards/{board}/matches"), &owner).1, serde_json::json!({ "matches": [] }));
}

// ---- opening a match fetches its replay (operator, 2026-11-08) ----

const DAY: u64 = 24 * 3600;

fn now_s() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_secs()
}

fn salts_for(id: u64, salt: u64) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "match_id": id, "cluster_id": 404, "replay_salt": salt, "metadata_salt": 9 })).expect("json")
}

impl Server {
    /// The match's metadata as `/api/matches/{id}` caches it, started `ago` seconds back.
    fn meta(&self, id: u64, ago: u64) {
        let dir = self.data.path().join("matches");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let m = serde_json::json!({ "match_id": id, "start_time": now_s() - ago, "duration_s": 60, "source": "deadlock-api.com", "players": [], "objectives": [], "mid_boss": [], "reanchored": 0, "events": [], "game_mode": 1 });
        std::fs::write(dir.join(format!("{id}.json")), serde_json::to_vec(&m).expect("json")).expect("meta");
    }
    /// Open the match on a board, as the landing's Open match and Player's Load do.
    fn open(&self, board: &str, token: &str, id: u64) {
        let r = agent().put(&self.url(&format!("/api/boards/{board}/matches/{id}"))).header("authorization", &format!("Bearer {token}")).send_empty().expect("request");
        assert_eq!(r.status().as_u16(), 200, "attached");
    }
}

fn until_hits(up: &Upstream, path: &str, n: usize) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while up.hits(path) < n {
        assert!(Instant::now() < deadline, "{path}: {} hits, want {n}", up.hits(path));
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn opening_a_match_fetches_its_replay_once_for_every_board() {
    let demo = bz2(&fake_demo(20_000));
    let routes = HashMap::from([("/v1/matches/21/salts".to_owned(), (200, salts_for(21, 77))), ("/cdn/404/1422450/21_77.dem.bz2".to_owned(), (200, demo))]);
    let up = upstream(routes);
    let server = Server::start(up.port, &[]);
    let (a, a_owner, _) = server.board();
    let (b, b_owner, _) = server.board();
    server.meta(21, DAY);
    // Two boards open it at once: one job, one request.
    server.open(&a, &a_owner, 21);
    server.open(&b, &b_owner, 21);
    assert_eq!(server.until_state(&a, &a_owner, "21", "queued")["source"], "cdn");
    assert_eq!(server.status(&b, &b_owner, "21")["state"], "queued");
    assert_eq!(up.hits("/v1/matches/21/salts"), 1);
    assert_eq!(files(&server.q("inbox")), ["21-cdn.bz2"]);
    work(&server, "21-cdn", Ok(&serde_json::to_vec(&timeline(21)).expect("json")));
    server.until_state(&b, &b_owner, "21", "done");
    assert_eq!(server.call("GET", &format!("/api/boards/{b}/matches/21"), &b_owner).1["tier"], "replay");
    // Opened again once it's there: nothing more is asked.
    server.open(&a, &a_owner, 21);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(up.hits("/v1/matches/21/salts"), 1);
}

#[test]
fn a_fetch_that_cant_work_is_remembered_and_old_matches_arent_tried() {
    let up = upstream(HashMap::new()); // every salts call: 404
    let server = Server::start(up.port, &[]);
    let (a, a_owner, _) = server.board();
    let (b, b_owner, _) = server.board();
    // No replay at Valve: remembered for the match, across boards and opens.
    server.meta(22, DAY);
    server.open(&a, &a_owner, 22);
    assert_eq!(server.until_state(&a, &a_owner, "22", "failed")["reason"], "no_replay");
    server.open(&a, &a_owner, 22);
    server.open(&b, &b_owner, 22);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(up.hits("/v1/matches/22/salts"), 1, "not asked again");
    assert_eq!(server.status(&b, &b_owner, "22")["reason"], "no_replay");
    // "Fetch replay" asks anyway.
    assert_eq!(server.call("POST", &format!("/api/boards/{b}/replays/22/fetch"), &b_owner).0, 202);
    until_hits(&up, "/v1/matches/22/salts", 2);
    // Past Valve's three weeks: never asked; the chip says why.
    server.meta(23, 22 * DAY);
    server.open(&a, &a_owner, 23);
    assert_eq!(server.status(&a, &a_owner, "23")["reason"], "expired");
    // Not imported (no metadata cached): no age to go by, so nothing on its own.
    server.open(&a, &a_owner, 24);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!((up.hits("/v1/matches/23/salts"), up.hits("/v1/matches/24/salts")), (0, 0));
    assert_eq!(server.status(&a, &a_owner, "24")["state"], "none");
}

/// Why no fetch is coming, for the opener's prompt (spec §6b): an expired match says so whether
/// or not anything opened it (the negative cache forgets), and an open our caps didn't start a
/// fetch for says `busy`, to that board only.
#[test]
fn the_status_says_when_a_fetch_cant_come_expired_or_skipped_for_caps() {
    let up = upstream(HashMap::new());
    // No download starts: every fetch waits in line, so a client's fifth isn't started.
    let server = Server::start(up.port, &[("REPLAY_DOWNLOADS_AT_ONCE", "0")]);
    let (a, a_owner, _) = server.board();
    let (b, b_owner, _) = server.board();
    server.meta(30, 22 * DAY);
    assert_eq!(server.status(&a, &a_owner, "30")["reason"], "expired", "never opened, still expired");
    server.meta(31, 20 * DAY);
    assert_eq!(server.status(&a, &a_owner, "31")["state"], "none", "inside the three weeks");
    for id in 40..44 {
        server.meta(id, DAY);
        server.open(&a, &a_owner, id);
    }
    server.meta(44, DAY);
    server.open(&a, &a_owner, 44);
    assert_eq!(server.status(&a, &a_owner, "44"), serde_json::json!({ "state": "failed", "reason": "busy", "source": "cdn" }));
    assert_eq!(server.status(&b, &b_owner, "44")["state"], "none", "another board's opener hears nothing");
    assert_eq!(server.status(&a, &a_owner, "43")["state"], "queued");
}

#[test]
fn a_429_backs_every_fetch_off_and_says_why() {
    let routes = HashMap::from([("/v1/matches/25/salts".to_owned(), (429, b"{}".to_vec())), ("/v1/matches/26/salts".to_owned(), (200, salts_for(26, 5)))]);
    let up = upstream(routes);
    let server = Server::start(up.port, &[]);
    let (a, owner, _) = server.board();
    server.meta(25, DAY);
    server.meta(26, DAY);
    server.open(&a, &owner, 25);
    assert_eq!(server.until_state(&a, &owner, "25", "failed")["reason"], "upstream_limited");
    // Backing off (60 s, no Retry-After): another match isn't asked for, on open or on a press.
    server.open(&a, &owner, 26);
    assert_eq!(server.status(&a, &owner, "26")["reason"], "upstream_limited");
    assert_eq!(server.call("POST", &format!("/api/boards/{a}/replays/26/fetch"), &owner), (429, serde_json::json!({ "error": "upstream_limited" })));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(up.hits("/v1/matches/26/salts"), 0);

    // With Retry-After it waits just that.
    let up = upstream_with(
        HashMap::from([("/v1/matches/27/salts".to_owned(), (429, b"{}".to_vec()))]),
        HashMap::from([("/v1/matches/27/salts".to_owned(), "retry-after: 1".to_owned())]),
    );
    let server = Server::start(up.port, &[]);
    let (a, owner, _) = server.board();
    assert_eq!(server.call("POST", &format!("/api/boards/{a}/replays/27/fetch"), &owner).0, 202);
    assert_eq!(server.until_state(&a, &owner, "27", "failed")["reason"], "upstream_limited");
    assert_eq!(server.call("POST", &format!("/api/boards/{a}/replays/27/fetch"), &owner).0, 429);
    std::thread::sleep(Duration::from_millis(1200));
    assert_eq!(server.call("POST", &format!("/api/boards/{a}/replays/27/fetch"), &owner).0, 202, "cleared");
    until_hits(&up, "/v1/matches/27/salts", 2);
}

#[test]
fn fetches_have_no_hourly_cap_of_ours() {
    let up = upstream(HashMap::new());
    // Uploads keep theirs (2 an hour here); fetches, from one client, aren't counted at all.
    let server = Server::start(up.port, &[("REPLAY_PER_CLIENT_PER_HOUR", "2")]);
    let (a, owner, _) = server.board();
    for id in 100..130 {
        assert_eq!(server.call("POST", &format!("/api/boards/{a}/replays/{id}/fetch"), &owner).0, 202, "match {id}");
        until_hits(&up, &format!("/v1/matches/{id}/salts"), 1);
    }
}

/// A fetch waiting costs nothing to ask for, so it's capped like a reservation: a client waits
/// for 4 at once, and the line's cap (the last resort) holds for fetches too.
#[test]
fn fetches_waiting_are_capped_per_client_and_in_all() {
    let up = upstream(HashMap::new());
    // No download starts: every fetch waits in line.
    let server = Server::start(up.port, &[("REPLAY_DOWNLOADS_AT_ONCE", "0"), ("REPLAY_MAX_WAITING", "6"), ("REPLAY_PER_CLIENT_PER_HOUR", "2")]);
    let (a, owner, _) = server.board();
    for id in 200..204 {
        assert_eq!(server.fetch_as(&a, &owner, &id.to_string(), "10.0.7.1").0, 202, "match {id}");
    }
    let (code, body) = server.fetch_as(&a, &owner, "204", "10.0.7.1");
    assert_eq!((code, body["error"].as_str()), (429, Some("busy")), "a fifth from one client");
    assert_eq!(server.status(&a, &owner, "204")["state"], "none", "nothing was queued for it");
    // Fetches waiting aren't upload turns: they don't count against the hourly limit.
    assert_eq!(server.reserve(&a, &owner, "209", 1000, "10.0.7.1").1["state"], "ready");
    assert_eq!(server.fetch_as(&a, &owner, "205", "10.0.7.2").0, 202);
    assert_eq!(server.fetch_as(&a, &owner, "206", "10.0.7.2").0, 202);
    let (code, body) = server.fetch_as(&a, &owner, "207", "10.0.7.3");
    assert_eq!((code, body["error"].as_str()), (503, Some("queue_full")), "past the line's cap");
    // Reservations count against the same line.
    let (code, body) = server.reserve(&a, &owner, "208", 1000, "10.0.7.4");
    assert_eq!((code, body["error"].as_str()), (503, Some("queue_full")));
}

#[test]
fn the_api_key_is_sent_only_when_configured() {
    let dir = tempfile::tempdir().expect("tmp");
    let key = dir.path().join("key");
    std::fs::write(&key, "test-key-0123\n").expect("key");
    let up = upstream(HashMap::new());
    let with = Server::start(up.port, &[("DEADLOCK_API_KEY_FILE", key.to_str().expect("path"))]);
    let (a, owner, _) = with.board();
    with.call("POST", &format!("/api/boards/{a}/replays/31/fetch"), &owner);
    until_hits(&up, "/v1/matches/31/salts", 1);
    assert!(up.headers("/v1/matches/31/salts").contains(&"x-api-key: test-key-0123".to_owned()), "{:?}", up.headers("/v1/matches/31/salts"));
    let without = Server::start(up.port, &[]);
    let (b, owner, _) = without.board();
    without.call("POST", &format!("/api/boards/{b}/replays/32/fetch"), &owner);
    until_hits(&up, "/v1/matches/32/salts", 1);
    assert!(!up.headers("/v1/matches/32/salts").iter().any(|h| h.starts_with("x-api-key")));
}

// ---- the queue: capacity, fairness, reservations (spec §6a, "The queue") ----

fn job(id: &str, board: &str) -> String {
    format!("{id}-{}", scope(board))
}

/// Two parse at once (the worker's `REPLAY_WORKERS`): both read as parsing, and the job behind
/// them counts both ahead of it.
#[test]
fn two_parse_at_once_and_the_rest_count_them_ahead() {
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[("REPLAY_WORKERS", "2")]);
    let (board, owner, _) = server.board();
    for (id, ip) in [("1", "10.0.0.1"), ("2", "10.0.0.2"), ("3", "10.0.0.3")] {
        assert_eq!(server.upload_as(&board, &owner, id, &fake_demo(1000), ip).0, 202, "match {id}");
    }
    server.until_order(&[job("1", &board), job("2", &board), job("3", &board)]);
    for id in ["1", "2"] {
        std::fs::write(server.q("outbox").join(format!("{}.parsing", job(id, &board))), b"").expect("parsing");
    }
    server.until_order(&[job("3", &board)]);
    assert_eq!(server.status(&board, &owner, "1")["state"], "parsing");
    assert_eq!(server.status(&board, &owner, "2")["state"], "parsing");
    let s = server.status(&board, &owner, "3");
    assert_eq!((s["state"].as_str(), s["ahead"].as_u64()), (Some("queued"), Some(2)), "{s}");
    assert!(s.get("eta_s").is_none(), "no estimate before any parse finished: {s}");
    finish(&server, &job("1", &board), Err("old_map"));
    server.until_state(&board, &owner, "1", "failed");
    let deadline = Instant::now() + Duration::from_secs(5);
    while server.status(&board, &owner, "3")["ahead"] != 1 {
        assert!(Instant::now() < deadline, "{}", server.status(&board, &owner, "3"));
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// One client's many jobs don't keep another's first one waiting: the parse order takes turns.
#[test]
fn the_parse_order_takes_turns_across_clients() {
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[]);
    let (board, owner, _) = server.board();
    for id in ["11", "12", "13"] {
        assert_eq!(server.upload_as(&board, &owner, id, &fake_demo(1000), "10.0.0.1").0, 202, "A's match {id}");
    }
    assert_eq!(server.upload_as(&board, &owner, "21", &fake_demo(1000), "10.0.0.2").0, 202, "B's");
    server.until_order(&[job("11", &board), job("21", &board), job("12", &board), job("13", &board)]);
    assert_eq!(server.status(&board, &owner, "21")["ahead"], 1);
    assert_eq!(server.status(&board, &owner, "13")["ahead"], 3);
    // A's first is parsing: B's goes next, then A's.
    std::fs::write(server.q("outbox").join(format!("{}.parsing", job("11", &board))), b"").expect("parsing");
    server.until_order(&[job("21", &board), job("12", &board), job("13", &board)]);
}

/// Recent parse times make an estimate, once there are a few.
#[test]
fn the_wait_is_estimated_from_recent_parses() {
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[]);
    let (board, owner, _) = server.board();
    // Refusals end in no time: they aren't parse times, and make no estimate.
    for (i, id) in ["35", "36", "37"].iter().enumerate() {
        assert_eq!(server.upload_as(&board, &owner, id, &fake_demo(1000), &format!("10.0.1.{}", 10 + i)).0, 202);
        work(&server, &job(id, &board), Err("old_map"));
        server.until_state(&board, &owner, id, "failed");
    }
    assert_eq!(server.upload_as(&board, &owner, "38", &fake_demo(1000), "10.0.1.20").0, 202);
    let s = server.status(&board, &owner, "38");
    assert!(s.get("eta_s").is_none(), "failures aren't samples: {s}");
    for (i, id) in ["31", "32", "33"].iter().enumerate() {
        assert_eq!(server.upload_as(&board, &owner, id, &fake_demo(1000), &format!("10.0.1.{i}")).0, 202);
        let t = serde_json::to_vec(&timeline(id.parse().expect("id"))).expect("json");
        work(&server, &job(id, &board), Ok(&t));
        server.until_state(&board, &owner, id, "done");
    }
    work(&server, &job("38", &board), Err("old_map"));
    server.until_state(&board, &owner, "38", "failed");
    assert_eq!(server.upload_as(&board, &owner, "34", &fake_demo(1000), "10.0.1.9").0, 202);
    let s = server.status(&board, &owner, "34");
    assert_eq!(s["state"], "queued");
    let eta = s["eta_s"].as_u64().unwrap_or_else(|| panic!("an estimate: {s}"));
    assert!((1..=5).contains(&eta), "three parses of about a second each, nothing ahead: {s}");
}

/// When the queue's bytes are spoken for, an upload waits in line for a turn instead of being
/// refused; it's sent when its turn comes; a client that goes away loses its place.
#[test]
fn uploads_wait_for_room_in_line_and_a_lapsed_reservation_frees_its_place() {
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[("REPLAY_MAX_QUEUE_BYTES", "250000"), ("REPLAY_RESERVE_TTL_S", "2")]);
    let (board, owner, _) = server.board();
    let ready = |id: &str, ip: &str| server.reserve(&board, &owner, id, 100_000, ip);
    assert_eq!(ready("41", "10.0.2.1").1["state"], "ready");
    assert_eq!(ready("42", "10.0.2.2").1["state"], "ready");
    // The budget holds two: the third and fourth wait, in turn.
    assert_eq!(ready("43", "10.0.2.3").1, serde_json::json!({ "state": "waiting", "source": "upload", "ahead": 0 }));
    assert_eq!(ready("44", "10.0.2.4").1["ahead"], 1);
    assert_eq!(server.status(&board, &owner, "44"), serde_json::json!({ "state": "waiting", "source": "upload", "ahead": 1 }));
    // Out of turn, an upload is refused, and nothing reaches the disk.
    let (code, body) = server.upload_as(&board, &owner, "44", &fake_demo(100_000), "10.0.2.4");
    assert_eq!((code, body["error"].as_str()), (503, Some("queue_full")));
    let (code, body) = server.upload_as(&board, &owner, "49", &fake_demo(100_000), "10.0.2.9");
    assert_eq!((code, body["error"].as_str()), (503, Some("queue_full")), "nor without a reservation");
    assert_eq!(ready("41", "10.0.2.1").1["state"], "ready", "its turn is kept while it asks");
    assert_eq!(server.upload_as(&board, &owner, "41", &fake_demo(100_000), "10.0.2.1").0, 202);
    // 43 stops asking (its tab closed); 44 keeps asking and takes the turn when room comes.
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        assert_eq!(ready("42", "10.0.2.2").1["state"], "ready", "42 keeps its turn while it asks");
        let s = ready("44", "10.0.2.4").1;
        if s["ahead"] == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "43's place never lapsed: {s}");
        std::thread::sleep(Duration::from_millis(300));
    }
    assert_eq!(server.status(&board, &owner, "43")["state"], "none", "a lapsed reservation is gone");
    // 42 never sent its file either: its turn lapses too, and 44's comes.
    let deadline = Instant::now() + Duration::from_secs(8);
    while ready("44", "10.0.2.4").1["state"] != "ready" {
        assert!(Instant::now() < deadline, "42's unused turn never lapsed");
        std::thread::sleep(Duration::from_millis(300));
    }
    assert_eq!(server.upload_as(&board, &owner, "44", &fake_demo(100_000), "10.0.2.4").0, 202);
    let held: u64 = files(&server.q("inbox")).iter().map(|f| std::fs::metadata(server.q("inbox").join(f)).map_or(0, |m| m.len())).sum();
    assert_eq!(held, 200_000, "the queue never holds more than its budget");
    // A parse collected frees room: the next reservation is ready at once.
    work(&server, &job("41", &board), Err("old_map"));
    server.until_state(&board, &owner, "41", "failed");
    assert_eq!(ready("45", "10.0.2.5").1["state"], "ready");
}

/// A reservation can be given up (Cancel), and the next in line moves up; a board whose match
/// was fetched already needs no upload; a line past its cap refuses, honestly.
#[test]
fn reservations_cancel_dedupe_and_have_a_last_resort() {
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[("REPLAY_MAX_QUEUE_BYTES", "150000"), ("REPLAY_MAX_WAITING", "2")]);
    let (board, owner, view) = server.board();
    assert_eq!(server.reserve(&board, &owner, "51", 100_000, "10.0.3.1").1["state"], "ready");
    assert_eq!(server.reserve(&board, &owner, "52", 100_000, "10.0.3.2").1["ahead"], 0);
    assert_eq!(server.reserve(&board, &owner, "53", 100_000, "10.0.3.3").1["ahead"], 1);
    let (code, body) = server.reserve(&board, &owner, "54", 100_000, "10.0.3.4");
    assert_eq!((code, body["error"].as_str()), (503, Some("queue_full")), "past the line's cap");
    assert_eq!(server.reserve(&board, &view, "54", 100_000, "10.0.3.4").0, 403, "view links can't reserve");
    assert_eq!(server.reserve(&board, &owner, "54", 900_000_000, "10.0.3.4").0, 413, "over the upload cap");
    let release = |id: &str| agent().delete(&server.url(&format!("/api/boards/{board}/replays/{id}/reserve"))).header("authorization", &format!("Bearer {owner}")).call().expect("release").status().as_u16();
    assert_eq!(release("52"), 204);
    assert_eq!(server.status(&board, &owner, "52")["state"], "none");
    assert_eq!(server.reserve(&board, &owner, "53", 100_000, "10.0.3.3").1["ahead"], 0, "53 moves up");
    // A reserved upload can't send more than it said; the failed try uses up its turn, and the
    // next in line takes it.
    assert_eq!(server.upload_as(&board, &owner, "51", &fake_demo(100_001), "10.0.3.1").0, 413);
    assert_eq!(server.reserve(&board, &owner, "53", 100_000, "10.0.3.3").1["state"], "ready");
    assert_eq!(server.reserve(&board, &owner, "51", 100_000, "10.0.3.1").1["ahead"], 0, "51 starts over at the back");
    // The match's replay came from Valve already: the board uses it, nothing is sent.
    std::fs::create_dir_all(server.data.path().join("replays")).expect("cache dir");
    std::fs::write(server.data.path().join("replays/55-cdn.json"), serde_json::to_vec(&timeline(55)).expect("json")).expect("cached");
    assert_eq!(server.reserve(&board, &owner, "55", 100_000, "10.0.3.5").1, serde_json::json!({ "state": "done", "source": "cdn" }));
}

/// Fetches wait in the same line for the queue's room as uploads (they share the parser), and
/// say where they are meanwhile.
#[test]
fn a_fetch_waits_in_line_for_room_beside_uploads() {
    let demo = bz2(&fake_demo(20_000));
    let routes = HashMap::from([("/v1/matches/61/salts".to_owned(), (200, salts_for(61, 5))), ("/cdn/404/1422450/61_5.dem.bz2".to_owned(), (200, demo))]);
    let up = upstream(routes);
    let server = Server::start(up.port, &[("REPLAY_MAX_QUEUE_BYTES", "150000"), ("REPLAY_MAX_DOWNLOAD_BYTES", "100000")]);
    let (board, owner, _) = server.board();
    assert_eq!(server.upload_as(&board, &owner, "60", &fake_demo(100_000), "10.0.4.1").0, 202);
    assert_eq!(server.call("POST", &format!("/api/boards/{board}/replays/61/fetch"), &owner).0, 202);
    let s = server.status(&board, &owner, "61");
    assert_eq!((s["state"].as_str(), s["source"].as_str(), s["ahead"].as_u64()), (Some("queued"), Some("cdn"), Some(0)), "{s}");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(up.hits("/v1/matches/61/salts"), 0, "it waits for room before asking anyone");
    work(&server, &job("60", &board), Err("old_map"));
    until_hits(&up, "/v1/matches/61/salts", 1);
    server.until_state(&board, &owner, "61", "queued");
    assert_eq!(files(&server.q("inbox")), ["61-cdn.bz2"]);
}

/// Turns already given count against the job and upload budgets until they're used or lapse.
#[test]
fn turns_given_hold_their_room() {
    let up = upstream(HashMap::new());
    let jobs = Server::start(up.port, &[("REPLAY_MAX_QUEUED", "2")]);
    let (board, owner, _) = jobs.board();
    assert_eq!(jobs.reserve(&board, &owner, "71", 1000, "10.0.5.1").1["state"], "ready");
    assert_eq!(jobs.reserve(&board, &owner, "72", 1000, "10.0.5.2").1["state"], "ready");
    assert_eq!(jobs.reserve(&board, &owner, "73", 1000, "10.0.5.3").1["state"], "waiting", "two jobs' worth given already");
    let uploads = Server::start(up.port, &[("REPLAY_UPLOADS_AT_ONCE", "1")]);
    let (board, owner, _) = uploads.board();
    assert_eq!(uploads.reserve(&board, &owner, "81", 1000, "10.0.6.1").1["state"], "ready");
    assert_eq!(uploads.reserve(&board, &owner, "82", 1000, "10.0.6.2").1["state"], "waiting", "one upload at once, given already");
}

/// A turn given must be used soon: asking alone doesn't keep it, so nobody can hold an upload
/// slot without uploading. Each turn given counts against the hourly limit, used or not.
#[test]
fn a_turn_unused_lapses_however_often_it_is_asked_about_and_counts_for_the_hour() {
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[("REPLAY_UPLOADS_AT_ONCE", "1"), ("REPLAY_GRANT_USE_S", "2"), ("REPLAY_PER_CLIENT_PER_HOUR", "2")]);
    let (board, owner, _) = server.board();
    let reserve = |id: &str, ip: &str| server.reserve(&board, &owner, id, 1000, ip);
    assert_eq!(reserve("91", "10.0.8.1").1["state"], "ready");
    assert_eq!(reserve("92", "10.0.8.2").1["state"], "waiting");
    // 91 keeps asking and never sends: its turn goes, and 92's comes.
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        let a = reserve("91", "10.0.8.1").1;
        reserve("92", "10.0.8.2");
        if a["state"] == "waiting" {
            break;
        }
        assert!(Instant::now() < deadline, "91 kept its turn by asking: {a}");
        std::thread::sleep(Duration::from_millis(300));
    }
    assert_eq!(reserve("92", "10.0.8.2").1["state"], "ready", "the next in line has the turn");
    // 91's client was given one turn and waits for another: that's its two for the hour.
    let (code, body) = reserve("93", "10.0.8.1");
    assert_eq!((code, body["error"].as_str()), (429, Some("rate_limited")));
    assert_eq!(server.upload_as(&board, &owner, "92", &fake_demo(1000), "10.0.8.2").0, 202);
}

/// A job being parsed isn't swept as stale for how long it waited before: its age counts from
/// its parse, which the worker's own wall clock bounds.
#[test]
fn a_parse_under_way_is_not_swept_for_its_wait() {
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[("REPLAY_STALE_S", "3")]);
    let (board, owner, _) = server.board();
    assert_eq!(server.upload(&board, &owner, "95", &fake_demo(100)).0, 202);
    let j = job("95", &board);
    std::thread::sleep(Duration::from_millis(2500));
    std::fs::write(server.q("outbox").join(format!("{j}.parsing")), b"").expect("parsing");
    // Its file is past the stale age now, its parse isn't.
    std::thread::sleep(Duration::from_millis(2000));
    assert_eq!(server.status(&board, &owner, "95")["state"], "parsing");
    assert!(server.q("inbox").join(format!("{j}.dem")).exists(), "the demo is still there for the parser");
    // A parse that runs past the stale age (the worker is gone) is swept after all.
    assert_eq!(server.until_state(&board, &owner, "95", "failed")["reason"], "timeout");
}

/// A timeline as a worker before the format stamp wrote it (format 0), cached for `job`.
fn cache_old(server: &Server, id: u64, job: &str) {
    let mut v = serde_json::to_value(timeline(id)).expect("json");
    v.as_object_mut().expect("object").remove("format");
    v["players"][0]["name"] = "Old".into();
    let dir = server.data.path().join("replays");
    std::fs::create_dir_all(&dir).expect("mkdir");
    std::fs::write(dir.join(format!("{job}.json")), serde_json::to_vec(&v).expect("json")).expect("cache");
}

/// Backlog, "Replay timeline format versions": a fetched timeline older than the worker's
/// format is fetched and parsed again once, on open, while the old one is served; the new one
/// replaces it.
#[test]
fn a_stale_fetched_timeline_is_fetched_again_once_and_replaced() {
    let demo = bz2(&fake_demo(20_000));
    let routes = HashMap::from([("/v1/matches/25/salts".to_owned(), (200, salts_for(25, 78))), ("/cdn/404/1422450/25_78.dem.bz2".to_owned(), (200, demo))]);
    let up = upstream(routes);
    let server = Server::start(up.port, &[]);
    let (a, a_owner, _) = server.board();
    let (b, b_owner, b_view) = server.board();
    server.meta(25, DAY);
    cache_old(&server, 25, "25-cdn");
    let served = |board: &str, token: &str| server.call("GET", &format!("/api/boards/{board}/matches/25"), token).1;
    server.open(&a, &a_owner, 25);
    // Its status follows the new job, so the client watches it; the old timeline is served meanwhile.
    assert_eq!(server.until_state(&a, &a_owner, "25", "queued")["source"], "cdn");
    assert_eq!(server.status(&b, &b_view, "25")["state"], "queued");
    let old = served(&b, &b_view);
    assert_eq!((old["players"][0]["name"].as_str(), old.get("format")), (Some("Old"), None), "the old one, at once");
    // Opened again, on any board: once a match.
    server.open(&b, &b_owner, 25);
    server.open(&a, &a_owner, 25);
    assert_eq!(up.hits("/v1/matches/25/salts"), 1);
    work(&server, "25-cdn", Ok(&serde_json::to_vec(&timeline(25)).expect("json")));
    server.until_state(&a, &a_owner, "25", "done");
    let new = served(&a, &a_owner);
    assert_eq!((new["players"][0]["name"].as_str(), new["format"].as_u64()), (Some("Coach"), Some(u64::from(mapcro_replay::timeline::FORMAT))), "replaced");
    server.open(&a, &a_owner, 25);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(up.hits("/v1/matches/25/salts"), 1, "current now: not fetched again");
}

/// A refetch that fails keeps the old timeline, done, and isn't tried on the next open (a
/// failed parse, which the match's negative cache doesn't keep).
#[test]
fn a_stale_fetched_timeline_whose_refetch_fails_stays() {
    let demo = bz2(&fake_demo(20_000));
    let routes = HashMap::from([("/v1/matches/28/salts".to_owned(), (200, salts_for(28, 81))), ("/cdn/404/1422450/28_81.dem.bz2".to_owned(), (200, demo))]);
    let up = upstream(routes);
    let server = Server::start(up.port, &[]);
    let (a, a_owner, _) = server.board();
    server.meta(28, DAY);
    cache_old(&server, 28, "28-cdn");
    server.open(&a, &a_owner, 28);
    server.until_state(&a, &a_owner, "28", "queued");
    work(&server, "28-cdn", Err("parse_failed"));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !files(&server.q("inbox")).is_empty() {
        assert!(Instant::now() < deadline, "collected");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(server.until_state(&a, &a_owner, "28", "done")["source"], "cdn");
    assert_eq!(server.call("GET", &format!("/api/boards/{a}/matches/28"), &a_owner).1["players"][0]["name"], "Old");
    server.open(&a, &a_owner, 28);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(up.hits("/v1/matches/28/salts"), 1);
}

/// Past Valve's three weeks there's nothing to fetch: the old timeline stays, untried.
#[test]
fn a_stale_fetched_timeline_past_the_three_weeks_is_kept() {
    let routes = HashMap::from([("/v1/matches/26/salts".to_owned(), (200, salts_for(26, 79)))]);
    let up = upstream(routes);
    let server = Server::start(up.port, &[]);
    let (a, a_owner, _) = server.board();
    server.meta(26, 22 * DAY);
    cache_old(&server, 26, "26-cdn");
    server.open(&a, &a_owner, 26);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(up.hits("/v1/matches/26/salts"), 0);
    assert_eq!(server.status(&a, &a_owner, "26"), serde_json::json!({ "state": "done", "source": "cdn" }));
    assert_eq!(server.call("GET", &format!("/api/boards/{a}/matches/26"), &a_owner).1["players"][0]["name"], "Old");
}

/// A stale upload can't be parsed again (its demo went with its parse): it's served, never
/// fetched, and its status says `stale` so the client offers "Upload replay file".
#[test]
fn a_stale_upload_is_served_and_offered_for_upload_not_fetched() {
    let routes = HashMap::from([("/v1/matches/27/salts".to_owned(), (200, salts_for(27, 80)))]);
    let up = upstream(routes);
    let server = Server::start(up.port, &[]);
    let (a, a_owner, a_view) = server.board();
    let job = format!("27-{}", scope(&a));
    server.meta(27, DAY);
    cache_old(&server, 27, &job);
    server.open(&a, &a_owner, 27);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(up.hits("/v1/matches/27/salts"), 0, "not fetched");
    assert_eq!(server.status(&a, &a_view, "27"), serde_json::json!({ "state": "done", "source": "upload", "stale": true }));
    assert_eq!(server.call("GET", &format!("/api/boards/{a}/matches/27"), &a_view).1["players"][0]["name"], "Old");
    // Uploading it again is the way up, and its new parse isn't stale.
    assert_eq!(server.reserve(&a, &a_owner, "27", 1000, "203.0.113.9").1["state"], "ready");
    assert_eq!(server.upload_as(&a, &a_owner, "27", &fake_demo(1000), "203.0.113.9").0, 202);
    work(&server, &job, Ok(&serde_json::to_vec(&timeline(27)).expect("json")));
    assert_eq!(server.until_state(&a, &a_owner, "27", "done"), serde_json::json!({ "state": "done", "source": "upload" }));
}

/// Operator, 2026-11-09: "we lose the replay player when we clone a board". A clone carries the
/// board's matches, newest first, and its uploaded replay (shared, not parsed again); a fetched
/// one is shared by every board already. The two boards' timelines live apart after.
#[test]
fn a_clone_keeps_the_matches_and_the_uploaded_replay() {
    use std::os::unix::fs::MetadataExt;
    let up = upstream(HashMap::new());
    let server = Server::start(up.port, &[]);
    let (board, owner, view) = server.board();
    let (uploaded, fetched) = ("130816395", "130816396");
    let put = |id: &str| agent().put(&server.url(&format!("/api/boards/{board}/matches/{id}"))).header("authorization", &format!("Bearer {owner}")).send_empty().expect("request").status().as_u16();
    // A replay fetched from Valve, in the shared cache, and a parse of this board's upload.
    let cache = server.data.path().join("replays");
    std::fs::write(cache.join(format!("{fetched}-cdn.json")), serde_json::to_vec(&timeline(130816396)).expect("json")).expect("cdn");
    assert_eq!((put(fetched), put(uploaded)), (200, 200));
    let job = format!("{uploaded}-{}", scope(&board));
    assert_eq!(server.upload(&board, &owner, uploaded, &fake_demo(1000)).0, 202);
    let mut t = timeline(130816395);
    work(&server, &job, Ok(&serde_json::to_vec(&t).expect("json")));
    server.until_state(&board, &owner, uploaded, "done");

    // Any link may clone; a view link here.
    let mut r = agent()
        .post(&server.url(&format!("/api/boards/{board}/clone")))
        .header("authorization", &format!("Bearer {view}"))
        .header("content-type", "application/json")
        .send(serde_json::json!({ "title": "Copy" }).to_string())
        .expect("clone");
    assert_eq!(r.status().as_u16(), 201);
    let v: serde_json::Value = r.body_mut().read_json().expect("json");
    let (copy, copy_owner) = (v["board"].as_str().unwrap_or_default().to_owned(), v["owner_token"].as_str().unwrap_or_default().to_owned());

    let n = |id: &str| id.parse::<u64>().expect("id");
    assert_eq!(server.call("GET", &format!("/api/boards/{copy}/matches"), &copy_owner).1, serde_json::json!({ "matches": [n(uploaded), n(fetched)] }));
    let (code, got) = server.call("GET", &format!("/api/boards/{copy}/matches/{uploaded}"), &copy_owner);
    assert_eq!((code, serde_json::from_value::<Timeline>(got).expect("timeline")), (200, t.clone()), "the upload's full replay");
    assert_eq!(server.status(&copy, &copy_owner, uploaded), serde_json::json!({ "state": "done", "source": "upload" }));
    assert_eq!(server.call("GET", &format!("/api/boards/{copy}/matches/{fetched}"), &copy_owner).1["tier"], "replay", "the fetched replay");
    assert!(files(&server.q("inbox")).is_empty(), "nothing parsed again");
    // One timeline, two names: the clone's carries only its own scope.
    let mine = cache.join(format!("{uploaded}-{}.json", scope(&copy)));
    assert_eq!(std::fs::metadata(&mine).expect("carried").ino(), std::fs::metadata(cache.join(format!("{job}.json"))).expect("source").ino());
    assert_eq!(server.call("GET", &format!("/api/boards/{copy}/matches"), &owner).0, 403, "the source's links don't open the clone");

    // The source's new upload replaces only its own name; the clone keeps its replay.
    assert_eq!(server.upload(&board, &owner, uploaded, &fake_demo(1000)).0, 202);
    assert!(!cache.join(format!("{job}.json")).exists());
    t.build = 7000;
    let (code, got) = server.call("GET", &format!("/api/boards/{copy}/matches/{uploaded}"), &copy_owner);
    assert_eq!((code, serde_json::from_value::<Timeline>(got).expect("timeline").build), (200, 6813));
    work(&server, &job, Ok(&serde_json::to_vec(&t).expect("json")));
    server.until_state(&board, &owner, uploaded, "done");
    assert_eq!(serde_json::from_value::<Timeline>(server.call("GET", &format!("/api/boards/{copy}/matches/{uploaded}"), &copy_owner).1).expect("timeline").build, 6813);

    // A board without matches clones to one without.
    let (bare, bare_owner, _) = server.board();
    let mut r = agent().post(&server.url(&format!("/api/boards/{bare}/clone"))).header("authorization", &format!("Bearer {bare_owner}")).header("content-type", "application/json").send("{}").expect("clone");
    let v: serde_json::Value = r.body_mut().read_json().expect("json");
    let (c2, c2_owner) = (v["board"].as_str().unwrap_or_default().to_owned(), v["owner_token"].as_str().unwrap_or_default().to_owned());
    assert_eq!(server.call("GET", &format!("/api/boards/{c2}/matches"), &c2_owner).1, serde_json::json!({ "matches": [] }));
}
