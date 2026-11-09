//! The feedback form against a fake GitHub: the real server binary, a local HTTP server that
//! records every request and answers from a script. No real GitHub call is made; the token is a
//! made-up string.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const TOKEN: &str = "fake-token-for-tests-0123456789";
const ISSUE_URL: &str = "https://github.com/intendednull/mapcro/issues/42";

struct Server {
    child: Child,
    port: u16,
    metrics: u16,
    log: Arc<Mutex<String>>,
    _data: tempfile::TempDir,
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

/// A token file in its own temp dir (the dir lives as long as the test holds it).
fn token_file(contents: &str) -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("token");
    std::fs::write(&path, contents).expect("write token");
    let p = path.to_str().expect("path").to_owned();
    (dir, p)
}

impl Server {
    fn start(github: u16, env: &[(&str, &str)]) -> Server {
        let data = tempfile::tempdir().expect("data");
        let (port, metrics) = (free_port(), free_port());
        let mut child = Command::new(env!("CARGO_BIN_EXE_mapcro-server"))
            .env("PORT", port.to_string())
            .env("DATA_DIR", data.path())
            .env("PUBLIC_ORIGIN", "http://localhost:5173")
            .env("RUST_LOG", "info")
            .env("MATCH_API_BASE", "http://127.0.0.1:1")
            .env("METRICS_ADDR", format!("127.0.0.1:{metrics}"))
            .env("METRICS_EVERY_S", "1")
            .env("FEEDBACK_GITHUB_API", format!("http://127.0.0.1:{github}"))
            .envs(env.iter().copied())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("server starts");
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
        let s = Server { child, port, metrics, log, _data: data };
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

    fn enabled(&self) -> serde_json::Value {
        let mut r = ureq::get(&self.url("/api/feedback")).call().expect("status");
        r.body_mut().read_json().expect("json")
    }

    /// POST /api/feedback as the client at `from` (the server is reached over loopback, so it
    /// trusts X-Forwarded-For, as behind Caddy). Status, Retry-After, body.
    fn send_raw(&self, from: &str, body: &str) -> (u16, Option<String>, String) {
        let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
        let mut r = agent
            .post(&self.url("/api/feedback"))
            .header("content-type", "application/json")
            .header("x-forwarded-for", from)
            .header("user-agent", "SecretBrowser/9.9 (sender-ua-marker)")
            .send(body)
            .expect("request");
        let retry = r.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(str::to_owned);
        (r.status().as_u16(), retry, r.body_mut().read_to_string().expect("body"))
    }

    fn send(&self, from: &str, title: &str, description: &str) -> (u16, Option<String>, String) {
        self.send_raw(from, &serde_json::json!({ "title": title, "description": description }).to_string())
    }

    fn metrics(&self) -> String {
        ureq::get(&format!("http://127.0.0.1:{}/metrics", self.metrics)).call().expect("metrics").body_mut().read_to_string().expect("text")
    }

    /// `stats <args> --json`, polled until `done` holds (snapshots land every second).
    fn until_stats(&self, args: &[&str], done: impl Fn(&serde_json::Value) -> bool) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let out = Command::new(env!("CARGO_BIN_EXE_mapcro-server"))
                .arg("stats")
                .args(args)
                .args(["--json", "--data-dir"])
                .arg(self._data.path())
                .env_remove("DATA_DIR")
                .output()
                .expect("stats runs");
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout)
                && done(&v)
            {
                return v;
            }
            assert!(Instant::now() < deadline, "stats never showed it: {}", String::from_utf8_lossy(&out.stdout));
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    fn log(&self) -> String {
        self.log.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// Every file under the data dir, as text (the database and its WAL).
fn db_text(dir: &std::path::Path) -> String {
    let mut out = String::new();
    for e in std::fs::read_dir(dir).expect("data dir").flatten() {
        if let Ok(b) = std::fs::read(e.path()) {
            out.push_str(&String::from_utf8_lossy(&b));
        }
    }
    out
}

/// One request as the fake saw it.
#[derive(Clone, Debug)]
struct Seen {
    head: String,
    path: String,
    headers: Vec<(String, String)>,
    body: serde_json::Value,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// A fake GitHub: answers each request from `script` in turn (the last entry repeats).
struct GitHub {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
}

fn github(script: Vec<(u16, String)>) -> GitHub {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
    let s = seen.clone();
    let script = Arc::new(Mutex::new(VecDeque::from(script)));
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let mut head = line.clone();
            let mut headers = Vec::new();
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h).map(|n| n == 0).unwrap_or(true) || h == "\r\n" {
                    break;
                }
                head.push_str(&h);
                if let Some((k, v)) = h.trim_end().split_once(':') {
                    headers.push((k.trim().to_ascii_lowercase(), v.trim().to_owned()));
                }
            }
            let len: usize = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
            let mut body = vec![0u8; len];
            let _ = reader.read_exact(&mut body);
            head.push_str(&String::from_utf8_lossy(&body));
            let path = line.split_whitespace().nth(1).unwrap_or("").to_owned();
            let body = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
            s.lock().expect("lock").push(Seen { head, path, headers, body });
            let (status, answer) = {
                let mut q = script.lock().expect("lock");
                if q.len() > 1 { q.pop_front().expect("entry") } else { q.front().cloned().expect("entry") }
            };
            let mut out = stream;
            let msg = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}", answer.len());
            let _ = out.write_all(msg.as_bytes());
        }
    });
    GitHub { port, seen }
}

impl GitHub {
    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().expect("lock").clone()
    }
}

fn created() -> (u16, String) {
    (201, serde_json::json!({ "number": 42, "html_url": ISSUE_URL, "url": "https://api.github.com/repos/intendednull/mapcro/issues/42" }).to_string())
}

#[test]
fn creates_the_issue_with_exactly_the_text_and_nothing_about_the_sender() {
    let gh = github(vec![created()]);
    let (_dir, file) = token_file(&format!("{TOKEN}\n"));
    let s = Server::start(gh.port, &[("FEEDBACK_GITHUB_TOKEN_FILE", &file)]);
    assert_eq!(s.enabled(), serde_json::json!({ "enabled": true }));

    let title = "  The minimap \u{7}freezes, cc @intendednull  ";
    let description = "Steps:\r\n1. open a board\r\n2. ping @mapcro/maintainers\u{0}\n\nhidden-text-marker";
    let (status, _, body) = s.send("203.0.113.77", title, description);
    assert_eq!(status, 201, "{body}");
    assert_eq!(serde_json::from_str::<serde_json::Value>(&body).expect("json"), serde_json::json!({ "url": ISSUE_URL }));

    let seen = gh.seen();
    assert_eq!(seen.len(), 1);
    let r = &seen[0];
    assert!(r.head.starts_with("POST /repos/intendednull/mapcro/issues HTTP/1.1\r\n"), "{}", r.head);
    assert_eq!(r.path, "/repos/intendednull/mapcro/issues");
    assert_eq!(r.header("authorization"), Some(format!("Bearer {TOKEN}").as_str()));
    assert_eq!(r.header("x-github-api-version"), Some("2022-11-28"));
    assert_eq!(r.header("accept"), Some("application/vnd.github+json"));
    assert!(r.header("user-agent").is_some_and(|u| u.starts_with("mapcro")), "{:?}", r.header("user-agent"));
    // Exactly title, body and the label: cleaned, trimmed, mentions neutralised, the footer.
    let build = mapcro_schema::BUILD_ID;
    assert_eq!(
        r.body,
        serde_json::json!({
            "title": "The minimap freezes, cc @\u{200D}intendednull",
            "body": format!("Steps:\n1. open a board\n2. ping @\u{200D}mapcro/maintainers\n\nhidden-text-marker\n\n---\n— Sent from the mapcro feedback form (build {build})"),
            "labels": ["feedback"],
        })
    );
    // Nothing about the sender reaches GitHub: not its address, its /64-style key, its agent.
    for marker in ["203.0.113", "SecretBrowser", "sender-ua-marker", "x-forwarded-for", "forwarded"] {
        assert!(!r.head.to_ascii_lowercase().contains(&marker.to_ascii_lowercase()), "{marker} in {}", r.head);
    }
    // The log holds neither the text, the token nor the sender.
    std::thread::sleep(Duration::from_millis(200));
    let log = s.log();
    for marker in ["hidden-text-marker", "minimap", TOKEN, "203.0.113", "SecretBrowser"] {
        assert!(!log.contains(marker), "{marker} in the log:\n{log}");
    }
    let m = s.metrics();
    assert!(m.contains("mapcro_feedback_sent_total 1"), "{m}");
    assert!(m.contains("mapcro_http_requests_total{route=\"feedback\",status_class=\"2xx\"}"), "{m}");
}

/// What GitHub would link in `s` as another repository's issue, PR, commit or discussion, or a
/// mention: `@name`, `owner/repo@sha`, `owner/repo#n`, any github.com URL.
fn linkable(s: &str) -> Vec<String> {
    let c: Vec<char> = s.chars().collect();
    let name = |x: char| x.is_alphanumeric() || "-_./".contains(x);
    let mut found = Vec::new();
    for i in 0..c.len() {
        let next = c.get(i + 1).copied();
        if c[i] == '@' && next.is_some_and(char::is_alphanumeric) {
            found.push(format!("@ at {i}"));
        }
        if c[i] == '#' && i > 0 && name(c[i - 1]) && next.is_some_and(|n| n.is_ascii_digit()) {
            found.push(format!("# at {i}"));
        }
    }
    if s.to_ascii_lowercase().contains("github.com") {
        found.push("github.com".into());
    }
    found
}

#[test]
fn no_cross_repo_reference_reaches_github() {
    let gh = github(vec![created()]);
    let (_dir, file) = token_file(TOKEN);
    let s = Server::start(gh.port, &[("FEEDBACK_GITHUB_TOKEN_FILE", &file)]);
    let refs = "Like foo/bar#12 and foo#3, fixed in foo/bar@a1b2c3d.\n\
        https://github.com/foo/bar/issues/1 https://github.com/foo/bar/pull/2\n\
        https://GitHub.com/foo/bar/commit/a1b2c3d4 [d](https://www.github.com/foo/bar/discussions/5)\n\
        Our own #7 stays.";
    assert_eq!(linkable(refs), ["# at 12", "# at 23", "@ at 43", "github.com"], "the check sees each kind");
    let (status, _, body) = s.send("203.0.113.1", "Dup of foo/bar#9, see https://github.com/foo/bar/pull/1", refs);
    assert_eq!(status, 201, "{body}");
    let sent = &gh.seen()[0].body;
    let (title, text) = (sent["title"].as_str().expect("title"), sent["body"].as_str().expect("body"));
    assert!(linkable(title).is_empty(), "{title:?}: {:?}", linkable(title));
    assert!(linkable(text).is_empty(), "{text:?}: {:?}", linkable(text));
    // Only joiners were added, and this repository's own reference is still a link.
    assert!(text.replace('\u{200D}', "").starts_with(&refs.replace("\r\n", "\n")));
    assert!(text.contains("Our own #7 stays."));
}

#[test]
fn a_refused_label_is_retried_once_without_it() {
    let gh = github(vec![(422, r#"{"message":"Validation Failed","errors":[{"resource":"Label","code":"invalid"}]}"#.into()), created()]);
    let (_dir, file) = token_file(TOKEN);
    let s = Server::start(gh.port, &[("FEEDBACK_GITHUB_TOKEN_FILE", &file)]);
    let (status, _, body) = s.send("203.0.113.1", "Title", "Description");
    assert_eq!(status, 201, "{body}");
    let seen = gh.seen();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].body["labels"], serde_json::json!(["feedback"]));
    assert!(seen[1].body.get("labels").is_none(), "{:?}", seen[1].body);
    assert_eq!(seen[1].body["title"], "Title");

    // Refused again without the label: one retry only, then a clean error.
    let gh = github(vec![(422, r#"{"message":"Validation Failed"}"#.into())]);
    let s = Server::start(gh.port, &[("FEEDBACK_GITHUB_TOKEN_FILE", &file)]);
    let (status, _, body) = s.send("203.0.113.1", "Title", "Description");
    assert_eq!(status, 502, "{body}");
    assert_eq!(gh.seen().len(), 2);
}

#[test]
fn github_failures_are_a_clean_error() {
    let gh = github(vec![(503, r#"{"message":"upstream-detail-marker"}"#.into())]);
    let (_dir, file) = token_file(TOKEN);
    let s = Server::start(gh.port, &[("FEEDBACK_GITHUB_TOKEN_FILE", &file)]);
    let (status, _, body) = s.send("203.0.113.1", "Title", "secret-description-marker");
    assert_eq!(status, 502);
    let v: serde_json::Value = serde_json::from_str(&body).expect("json");
    assert!(v["error"].as_str().is_some_and(|e| e.contains("try again")), "{body}");
    for marker in ["upstream-detail-marker", TOKEN, "Bearer"] {
        assert!(!body.contains(marker), "{marker} in {body}");
    }
    // A 5xx isn't retried (only a refused label is).
    assert_eq!(gh.seen().len(), 1);
    std::thread::sleep(Duration::from_millis(200));
    let log = s.log();
    assert!(log.contains("feedback: GitHub didn't create the issue"), "{log}");
    for marker in ["secret-description-marker", TOKEN, "203.0.113"] {
        assert!(!log.contains(marker), "{marker} in the log:\n{log}");
    }
    assert!(s.metrics().contains("mapcro_feedback_rejected_total{reason=\"github_error\"} 1"));
    // The operator's view: the refusal by reason, and the failure, in words we wrote.
    let v = s.until_stats(&["summary"], |v| v["usage"]["feedback_rejected"]["reason=github_error"] == 1.0);
    assert_eq!(v["health"]["failures_by_kind_code"]["k=upstream,c=upstream_5xx"], 1.0);
    let failures = s.until_stats(&["failures"], |v| v.as_array().is_some_and(|a| !a.is_empty()));
    assert!(failures.as_array().is_some_and(|f| f.iter().any(|g| g["message"] == "github issues upstream_5xx")), "{failures:#}");
    for secret in ["secret-description-marker", TOKEN] {
        assert!(!db_text(s._data.path()).contains(secret), "the database holds {secret}");
    }

    // A success answer without an https link isn't passed on.
    let gh = github(vec![(201, r#"{"html_url":"javascript:alert(1)"}"#.into())]);
    let s = Server::start(gh.port, &[("FEEDBACK_GITHUB_TOKEN_FILE", &file)]);
    assert_eq!(s.send("203.0.113.1", "Title", "Body").0, 502);

    // Nobody listening.
    let s = Server::start(free_port(), &[("FEEDBACK_GITHUB_TOKEN_FILE", &file)]);
    assert_eq!(s.send("203.0.113.1", "Title", "Body").0, 502);
}

#[test]
fn invalid_submissions_are_refused_before_github() {
    let gh = github(vec![created()]);
    let (_dir, file) = token_file(TOKEN);
    let s = Server::start(gh.port, &[("FEEDBACK_GITHUB_TOKEN_FILE", &file), ("FEEDBACK_PER_CLIENT_PER_HOUR", "1")]);
    let cases: Vec<(String, String)> = vec![
        ("".into(), "body".into()),
        (" \u{0}\u{1b} ".into(), "body".into()),
        ("title".into(), "\r\n\t ".into()),
        ("x".repeat(121), "body".into()),
        ("title".into(), "x".repeat(5001)),
    ];
    for (t, d) in &cases {
        let (status, _, body) = s.send("203.0.113.1", t, d);
        assert_eq!(status, 400, "{t:?}: {body}");
        assert!(serde_json::from_str::<serde_json::Value>(&body).expect("json")["error"].is_string());
    }
    // Not JSON, a field missing, a body past the cap.
    assert_eq!(s.send_raw("203.0.113.1", "nope").0, 400);
    assert_eq!(s.send_raw("203.0.113.1", r#"{"title":"t"}"#).0, 400);
    let huge = serde_json::json!({ "title": "t", "description": "x".repeat(40 * 1024) }).to_string();
    assert!(matches!(s.send_raw("203.0.113.1", &huge).0, 400 | 413));
    assert!(gh.seen().is_empty());
    // At the limits is fine, in characters (5,000 4-byte ones fit the body cap), and none of
    // the refusals spent the client's one-an-hour budget.
    let (status, _, body) = s.send("203.0.113.1", &"é".repeat(120), &"😀".repeat(5000));
    assert_eq!(status, 201, "{body}");
    assert!(s.metrics().contains("mapcro_feedback_rejected_total{reason=\"invalid\"}"));
}

#[test]
fn rate_limits_per_client_and_server_wide() {
    let gh = github(vec![created()]);
    let (_dir, file) = token_file(TOKEN);
    let s = Server::start(gh.port, &[("FEEDBACK_GITHUB_TOKEN_FILE", &file), ("FEEDBACK_PER_CLIENT_PER_HOUR", "2"), ("FEEDBACK_GLOBAL_PER_DAY", "4")]);
    assert_eq!(s.send("203.0.113.1", "a", "b").0, 201);
    assert_eq!(s.send("203.0.113.1", "a", "b").0, 201);
    let (status, retry, body) = s.send("203.0.113.1", "a", "b");
    assert_eq!(status, 429, "{body}");
    let secs: u64 = retry.expect("Retry-After").parse().expect("seconds");
    assert!((3500..=3600).contains(&secs), "{secs}");
    // The client key is the /64: another address in it is the same client; another /64 isn't.
    assert_eq!(s.send("2001:db8:1:2::1", "a", "b").0, 201);
    assert_eq!(s.send("2001:db8:1:2::ffff", "a", "b").0, 201);
    assert_eq!(s.send("2001:db8:1:2:aaaa::1", "a", "b").0, 429);
    // Four sent: the day is full for everyone.
    let (status, retry, _) = s.send("198.51.100.9", "a", "b");
    assert_eq!(status, 429);
    let secs: u64 = retry.expect("Retry-After").parse().expect("seconds");
    assert!((86_000..=86_400).contains(&secs), "{secs}");
    assert_eq!(gh.seen().len(), 4);
    assert!(s.metrics().contains("mapcro_feedback_rejected_total{reason=\"rate_limited\"} 3"));
}

#[test]
fn off_without_a_usable_token_file() {
    let gh = github(vec![created()]);
    let (_dir, empty) = token_file(" \n");
    let cases: Vec<Vec<(&str, &str)>> = vec![vec![], vec![("FEEDBACK_GITHUB_TOKEN_FILE", "/nonexistent/mapcro-token")], vec![("FEEDBACK_GITHUB_TOKEN_FILE", &empty)]];
    for env in cases {
        let s = Server::start(gh.port, &env);
        assert_eq!(s.enabled(), serde_json::json!({ "enabled": false }));
        let (status, _, body) = s.send("203.0.113.1", "Title", "Body");
        assert_eq!(status, 404, "{body}");
        assert!(s.metrics().contains("mapcro_feedback_rejected_total{reason=\"disabled\"} 1"));
    }
    assert!(gh.seen().is_empty());
}

#[test]
fn a_bad_repo_or_api_base_is_a_config_error() {
    for (k, v) in [("FEEDBACK_GITHUB_REPO", "not-a-repo"), ("FEEDBACK_GITHUB_REPO", "a/../b"), ("FEEDBACK_GITHUB_API", "http://example.com"), ("FEEDBACK_GITHUB_API", "http://localhost.example.com")] {
        let data = tempfile::tempdir().expect("data");
        let out = Command::new(env!("CARGO_BIN_EXE_mapcro-server"))
            .env("PORT", free_port().to_string())
            .env("DATA_DIR", data.path())
            .env("PUBLIC_ORIGIN", "http://localhost:5173")
            .env(k, v)
            .output()
            .expect("runs");
        assert_eq!(out.status.code(), Some(2), "{k}={v}");
        assert!(String::from_utf8_lossy(&out.stderr).contains(k), "{k}={v}");
    }
}
