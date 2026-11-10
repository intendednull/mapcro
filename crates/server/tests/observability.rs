//! Observability on the real server binary (docs/specs/observability.md): requests counted by
//! route template with no ids anywhere, `/metrics` only on its own loopback listener, a failed
//! replay job in the failures log with a clean message, and `stats` reading it all back.

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

mod support;

struct Server {
    child: Child,
    port: u16,
    metrics: u16,
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
    fn start() -> Server {
        let (data, queue) = (tempfile::tempdir().expect("data"), tempfile::tempdir().expect("queue"));
        let mut cmd = support::server();
        cmd.env("DATA_DIR", data.path())
            .env("REPLAY_DIR", queue.path())
            .env("PUBLIC_ORIGIN", "http://localhost:5173")
            .env("RUST_LOG", "error")
            // Nothing listens there: an uncached match is a 502.
            .env("MATCH_API_BASE", "http://127.0.0.1:1")
            .env("METRICS_ADDR", "127.0.0.1:0")
            .env("METRICS_EVERY_S", "1")
            .stdout(Stdio::null());
        let support::Started { child, port, metrics, .. } = support::start_or_panic(cmd);
        let metrics = metrics.expect("the metrics listener is up");
        Server { child, port, metrics, data, queue }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn get(&self, url: &str, token: Option<&str>) -> (u16, String) {
        let mut req = agent().get(url);
        if let Some(t) = token {
            req = req.header("authorization", &format!("Bearer {t}"));
        }
        let mut r = req.call().expect("request");
        (r.status().as_u16(), r.body_mut().read_to_string().unwrap_or_default())
    }

    fn board(&self) -> (String, String) {
        let v: serde_json::Value = ureq::post(&self.url("/api/boards")).send_json(serde_json::json!({ "title": "Obs" })).expect("create").body_mut().read_json().expect("json");
        (v["board"].as_str().unwrap_or_default().to_owned(), v["owner_token"].as_str().unwrap_or_default().to_owned())
    }

    fn scrape(&self) -> String {
        self.get(&format!("http://127.0.0.1:{}/metrics", self.metrics), None).1
    }

    /// `mapcro-server stats …` against this server's database.
    fn stats(&self, args: &[&str]) -> (String, i32) {
        let out = Command::new(env!("CARGO_BIN_EXE_mapcro-server"))
            .arg("stats")
            .args(args)
            .arg("--data-dir")
            .arg(self.data.path())
            .env_remove("DATA_DIR")
            .output()
            .expect("stats runs");
        (String::from_utf8_lossy(&out.stdout).into_owned(), out.status.code().unwrap_or(-1))
    }

    fn stats_json(&self, args: &[&str]) -> serde_json::Value {
        let mut a = args.to_vec();
        a.push("--json");
        let (out, code) = self.stats(&a);
        assert_eq!(code, 0, "stats {args:?}: {out}");
        serde_json::from_str(&out).expect("stats json")
    }

    /// Wait for the snapshot to hold what `ok` looks for.
    fn until_stats(&self, args: &[&str], ok: impl Fn(&serde_json::Value) -> bool) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let v = self.stats_json(args);
            if ok(&v) {
                return v;
            }
            assert!(Instant::now() < deadline, "stats {args:?} never showed it: {v:#}");
            std::thread::sleep(Duration::from_millis(250));
        }
    }
}

/// Every file of the database (main and WAL) as text, to search for what must not be there.
fn db_text(dir: &Path) -> String {
    ["mapcro.sqlite", "mapcro.sqlite-wal"].iter().map(|f| String::from_utf8_lossy(&std::fs::read(dir.join(f)).unwrap_or_default()).into_owned()).collect()
}

#[test]
fn requests_count_by_route_template_and_never_by_id() {
    let s = Server::start();
    let (board, owner) = s.board();
    let match_id = "123456789";
    assert_eq!(s.get(&s.url(&format!("/api/boards/{board}/links")), Some(&owner)).0, 200);
    assert_eq!(s.get(&s.url(&format!("/api/boards/{board}/links")), Some(&owner)).0, 200);
    assert_eq!(s.get(&s.url(&format!("/api/matches/{match_id}")), None).0, 502, "the upstream is down");

    let text = s.scrape();
    assert!(text.contains("mapcro_http_requests_total{route=\"board_links\",status_class=\"2xx\"} 2\n"), "{text}");
    assert!(text.contains("mapcro_http_requests_total{route=\"match\",status_class=\"5xx\"} 1\n"));
    assert!(text.contains("mapcro_boards_created_total{how=\"new\"} 1\n"));
    assert!(text.contains("mapcro_deadlock_api_calls_total{endpoint=\"metadata\",result=\"unreachable\"} 1\n"));
    for secret in [board.as_str(), owner.as_str(), match_id] {
        assert!(!text.contains(secret), "/metrics carries {secret}");
    }
    // The public listener doesn't serve it.
    let (_, public) = s.get(&s.url("/metrics"), None);
    assert!(!public.contains("mapcro_http_requests_total"), "/metrics on the public port");

    // The snapshot lands in the database, and `stats summary` reads it back.
    let v = s.until_stats(&["summary"], |v| v["health"]["http_5xx"].as_f64() >= Some(1.0) && v["health"]["failures"].as_u64() >= Some(2));
    assert_eq!(v["health"]["http"]["route=board_links,status_class=2xx"], 2.0);
    assert_eq!(v["health"]["failures_by_kind_code"]["k=http,c=match"], 1.0);
    assert_eq!(v["health"]["failures_by_kind_code"]["k=upstream,c=unreachable"], 1.0);
    assert_eq!(v["usage"]["boards_created"]["how=new"], 1.0);
    let failures = s.stats_json(&["failures"]);
    assert!(failures.as_array().is_some_and(|f| f.iter().any(|g| g["message"] == "GET match answered 502")), "{failures:#}");
    let db = db_text(s.data.path());
    assert!(db.contains("route=board_links"), "the rows are in this file");
    // The board's id is in its own tables; the metrics and failures must not add the token or
    // the match id.
    for secret in [owner.as_str(), match_id] {
        assert!(!db.contains(secret), "the database holds {secret}");
    }
    let (text, code) = s.stats(&["summary"]);
    assert_eq!(code, 0);
    assert!(text.contains("HEALTH") && text.contains("match/5xx 1"), "{text}");
}

#[test]
fn a_failed_replay_job_lands_in_failures_with_a_clean_message() {
    let s = Server::start();
    let (board, owner) = s.board();
    let id = "987654321";
    let mut r = agent()
        .post(&s.url(&format!("/api/boards/{board}/replays/{id}/upload")))
        .header("authorization", &format!("Bearer {owner}"))
        .header("content-type", "application/octet-stream")
        .send(&b"PBDEMS2\0 some demo bytes"[..])
        .expect("upload");
    assert_eq!(r.status().as_u16(), 202, "{}", r.body_mut().read_to_string().unwrap_or_default());
    // Play the worker: the job's record, then its failure.
    let inbox = s.queue.path().join("inbox");
    let job = std::fs::read_dir(&inbox)
        .expect("inbox")
        .flatten()
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".dem")).map(str::to_owned))
        .find(|n| n.starts_with(id))
        .expect("queued");
    let outbox = s.queue.path().join("outbox");
    let record = mapcro_replay::JobStats { queue_wait_s: Some(1.5), parse_s: Some(4.0), peak_rss_bytes: Some(100 << 20), demo_bytes: Some(25), ..Default::default() };
    std::fs::write(outbox.join(format!("{job}.stats")), serde_json::to_vec(&record).expect("json")).expect("record");
    std::fs::write(outbox.join(format!("{job}.failed")), b"old_map").expect("failed");

    let v = s.until_stats(&["summary"], |v| v["health"]["replay_jobs"]["source=uploaded,outcome=old_map"].as_f64() == Some(1.0));
    assert_eq!(v["speed"]["parse_s"]["n"], 1.0, "the worker's record fed the histograms");
    assert_eq!(v["speed"]["queue_wait_s"]["n"], 1.0);
    let failures = s.stats_json(&["failures", "--kind", "replay_job"]);
    let f = failures.as_array().and_then(|f| f.first()).cloned().unwrap_or_default();
    assert_eq!(f["code"], "old_map", "{failures:#}");
    let msg = f["message"].as_str().unwrap_or_default();
    assert!(msg.starts_with("replay uploaded old_map after "), "{msg}");
    assert!(!msg.contains(id) && !msg.contains(&board) && !msg.contains(&job), "{msg}");
    assert!(!outbox.join(format!("{job}.stats")).exists(), "the record is read and removed");
    let series = s.stats_json(&["series", "parse_peak_rss_bytes"]);
    assert_eq!(series.as_array().map(Vec::len), Some(1), "{series:#}");
}

#[test]
fn stats_refuses_without_a_database_and_explains_its_flags() {
    let dir = tempfile::tempdir().expect("dir");
    let out = Command::new(env!("CARGO_BIN_EXE_mapcro-server")).args(["stats", "summary", "--data-dir"]).arg(dir.path()).output().expect("runs");
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("no database"));
    let out = Command::new(env!("CARGO_BIN_EXE_mapcro-server")).args(["stats", "bogus", "--since", "nope"]).output().expect("runs");
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage: mapcro-server stats"));
}
