//! Match import against a fake deadlock-api: the real server binary, a local HTTP server serving
//! fixtures, and the cache under DATA_DIR/matches. The fixtures are anonymised: a synthetic match
//! in the real shape (with made-up account ids that must not survive), and a trimmed real match
//! (130816395) with every account field removed.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Server {
    child: Child,
    port: u16,
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

impl Server {
    fn start(dir: &std::path::Path, upstream: u16, env: &[(&str, &str)]) -> Server {
        let port = free_port();
        let child = Command::new(env!("CARGO_BIN_EXE_mapcro-server"))
            .env("PORT", port.to_string())
            .env("DATA_DIR", dir)
            .env("PUBLIC_ORIGIN", "http://localhost:5173")
            .env("RUST_LOG", "warn")
            .env("MATCH_API_BASE", format!("http://127.0.0.1:{upstream}"))
            .envs(env.iter().copied())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("server starts");
        let s = Server { child, port };
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

    /// Status and body of `GET /api/matches/{id}`.
    fn get(&self, id: &str) -> (u16, String) {
        let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
        let mut r = agent.get(&self.url(&format!("/api/matches/{id}"))).call().expect("request");
        let status = r.status().as_u16();
        (status, r.body_mut().read_to_string().expect("body"))
    }
}

/// A fake deadlock-api: `/v1/matches/{id}/metadata` answers from `routes` and counts calls.
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
            let routes = routes.clone();
            let hits = h.clone();
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
                let id = if path.starts_with("/v1/players/steam?") {
                    "steam".to_owned()
                } else {
                    path.strip_prefix("/v1/matches/").and_then(|r| r.split('/').next()).unwrap_or("").to_owned()
                };
                *hits.lock().expect("lock").entry(id.clone()).or_default() += 1;
                let (status, body) = routes.get(&id).cloned().unwrap_or((404, b"{\"error\":\"not found\"}".to_vec()));
                let mut out = stream;
                let head = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                let _ = out.write_all(head.as_bytes());
                let _ = out.write_all(&body);
            });
        }
    });
    Upstream { port, hits }
}

impl Upstream {
    fn hits(&self, id: &str) -> usize {
        self.hits.lock().expect("lock").get(id).copied().unwrap_or(0)
    }
}

const ACCOUNT_A: u64 = 987_654_321;

/// A two-minute match in deadlock-api's shape. Made-up account ids and profile-like fields
/// ride along, as in the real response; none of them may come back out.
fn synthetic(id: u64) -> Vec<u8> {
    let n = 121;
    let mut players = Vec::new();
    let mut paths = Vec::new();
    for slot in 1..=12u32 {
        let team = if slot <= 6 { 0 } else { 1 };
        let mut health = vec![100; n];
        let deaths: Vec<serde_json::Value> = if slot == 1 {
            // Slot 1 dies at 40 s for 10 s; the path shows it from index 41.
            for h in health.iter_mut().take(51).skip(41) {
                *h = 0;
            }
            vec![serde_json::json!({ "game_time_s": 40, "death_duration_s": 10, "killer_player_slot": 7 })]
        } else {
            vec![]
        };
        players.push(serde_json::json!({
            "account_id": ACCOUNT_A + u64::from(slot),
            "steam_id": format!("7656119{}", ACCOUNT_A + u64::from(slot)),
            "persona": "should not leak",
            "player_slot": slot, "team": team, "hero_id": 10 + slot, "assigned_lane": 1,
            "death_details": deaths,
            "stats": [{ "time_stamp_s": 60, "net_worth": 1000 * slot }, { "time_stamp_s": 120, "net_worth": 2000 * slot }],
        }));
        // x runs 0 → 16383 over the match: world −1000 → +1000; y fixed at the box's middle.
        let x: Vec<u32> = (0..n).map(|i| (i as u32 * 16383 / (n as u32 - 1)).min(16383)).collect();
        paths.push(serde_json::json!({
            "player_slot": slot, "x_min": -1000.0, "x_max": 1000.0, "y_min": -2000.0, "y_max": -1000.0,
            "x_pos": x, "y_pos": vec![8192; n], "health": health,
            "combat_type": vec![0; n], "move_type": vec![0; n],
        }));
    }
    serde_json::to_vec(&serde_json::json!({
        "match_info": {
            "duration_s": 120, "start_time": 1_793_753_219u64, "match_id": id,
            "players": players,
            "objectives": [
                { "team_objective_id": 5, "team": 0, "first_damage_time_s": 30, "destroyed_time_s": 60 },
                { "team_objective_id": 10, "team": 1, "first_damage_time_s": 80, "destroyed_time_s": 90 },
                { "team_objective_id": 8, "team": 1, "first_damage_time_s": 80, "destroyed_time_s": 0 },
                { "team_objective_id": 0, "team": 1, "first_damage_time_s": 0, "destroyed_time_s": 110 },
            ],
            "mid_boss": [{ "team_killed": 1, "team_claimed": 1, "destroyed_time_s": 100 }],
            "match_paths": { "version": 1, "interval_s": 1.0, "x_resolution": 16383, "y_resolution": 16383, "paths": paths },
        },
        "hero_build_ids": [], "pregame_hero_ids": [], "banned_hero_ids": [],
    }))
    .expect("json")
}

fn real() -> Vec<u8> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/match-130816395-trimmed.json")).expect("fixture")
}

fn routes() -> HashMap<String, (u16, Vec<u8>)> {
    let mut r = HashMap::new();
    r.insert("111".into(), (200, synthetic(111)));
    r.insert("112".into(), (200, synthetic(112)));
    r.insert("113".into(), (200, synthetic(113)));
    r.insert("130816395".into(), (200, real()));
    r.insert("500".into(), (500, b"oops".to_vec()));
    r.insert("429".into(), (429, b"slow down".to_vec()));
    r.insert("222".into(), (200, vec![b' '; 600 * 1024]));
    r
}

#[test]
fn an_import_derives_a_timeline_caches_it_and_keeps_no_ids() {
    let dir = tempfile::tempdir().expect("tempdir");
    let up = upstream(routes());
    let s = Server::start(dir.path(), up.port, &[]);
    let (status, body) = s.get("111");
    assert_eq!(status, 200, "{body}");
    let t: serde_json::Value = serde_json::from_str(&body).expect("json");
    assert_eq!(t["match_id"], 111);
    assert_eq!(t["duration_s"], 120);
    assert_eq!(t["source"], "deadlock-api.com");
    let players = t["players"].as_array().expect("players");
    assert_eq!(players.len(), 12);
    let first = &players[0];
    assert_eq!((first["team"].as_str(), first["slot"].as_u64(), first["hero_id"].as_u64()), (Some("amber"), Some(0), Some(11)));
    assert_eq!(players[6]["team"], "sapphire");
    // De-quantised with the path's box: x from −1000 to +1000, y at the box's middle.
    assert_eq!(first["x"][0], -1000);
    assert_eq!(first["y"][0], -1500);
    assert_eq!(players[3]["x"][120], 1000);
    // Dead from 40 s for 10 s: no position, health 0.
    assert!(first["x"][45].is_null());
    assert_eq!(first["health"][45], 0);
    assert!(first["x"][55].is_number());
    assert_eq!(first["deaths"], serde_json::json!([40]));
    assert_eq!(first["souls"], serde_json::json!([[60, 1000], [120, 2000]]));
    // Objectives as board keys; the surviving walker and the core are left out.
    assert_eq!(
        t["objectives"],
        serde_json::json!([
            { "key": "walker:amber:lane1:1", "kind": "walker", "team": "amber", "lane": 1, "destroyed_s": 60 },
            { "key": "shrine:sapphire:lane6:1", "kind": "shrine", "team": "sapphire", "lane": 6, "destroyed_s": 90 },
        ])
    );
    assert_eq!(t["mid_boss"], serde_json::json!([{ "destroyed_s": 100, "team_killed": "sapphire" }]));

    // Nothing id-like survives, in the response or in the cache.
    let cached = std::fs::read_to_string(dir.path().join("matches/111.json")).expect("cache file");
    for text in [&body, &cached] {
        for leak in ["account", "steam", "persona", "should not leak", &(ACCOUNT_A + 1).to_string()] {
            assert!(!text.contains(leak), "{leak} leaked");
        }
    }
    assert_eq!(cached, body);
    // A second import is a cache hit: no second upstream call.
    assert_eq!(up.hits("111"), 1);
    let (status, again) = s.get("111");
    assert_eq!((status, again), (200, body));
    assert_eq!(up.hits("111"), 1);
    // No temporary files left behind.
    let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("matches")).expect("dir").flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
    assert!(leftovers.is_empty());
}

#[test]
fn a_real_match_maps_its_objectives_and_re_anchors_drifting_paths() {
    let dir = tempfile::tempdir().expect("tempdir");
    let up = upstream(routes());
    let s = Server::start(dir.path(), up.port, &[]);
    let (status, body) = s.get("130816395");
    assert_eq!(status, 200, "{body}");
    let t: serde_json::Value = serde_json::from_str(&body).expect("json");
    assert_eq!(t["players"].as_array().map(Vec::len), Some(12));
    // Mappings checked against the attackers' positions at each destruction (journal).
    let destroyed: HashMap<String, u64> = t["objectives"]
        .as_array()
        .expect("objectives")
        .iter()
        .map(|o| (o["key"].as_str().unwrap_or("").to_owned(), o["destroyed_s"].as_u64().unwrap_or(0)))
        .collect();
    assert_eq!(destroyed.get("guardian:amber:lane4:1"), Some(&529));
    assert_eq!(destroyed.get("guardian:amber:lane1:1"), Some(&604));
    assert_eq!(destroyed.get("guardian:amber:lane6:1"), Some(&703));
    assert_eq!(destroyed.get("walker:amber:lane1:1"), Some(&899));
    assert_eq!(destroyed.get("walker:sapphire:lane6:1"), Some(&1169));
    // Some paths drift from the game clock in this match (research §1.2).
    assert!(t["reanchored"].as_u64().unwrap_or(0) >= 1);
    // Every hero starts at its own team's spawn.
    for p in t["players"].as_array().expect("players") {
        let y = p["y"][0].as_i64().expect("alive at 0");
        if p["team"] == "amber" { assert!(y < -9_000) } else { assert!(y > 9_000) }
    }
}

#[test]
fn bad_ids_and_upstream_failures_have_clear_statuses() {
    let dir = tempfile::tempdir().expect("tempdir");
    let up = upstream(routes());
    let s = Server::start(dir.path(), up.port, &[("MATCH_MAX_BYTES", "524288")]);
    let code = |id: &str| {
        let (st, body) = s.get(id);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        (st, v["error"].as_str().unwrap_or("").to_owned())
    };
    assert_eq!(code("12ab"), (400, "bad_id".into()));
    assert_eq!(code("0123"), (400, "bad_id".into()));
    assert_eq!(code("1234567890123"), (400, "bad_id".into()));
    assert_eq!(up.hits("12ab") + up.hits("0123"), 0, "bad ids never reach the upstream");
    assert_eq!(code("404"), (404, "not_found".into()));
    assert_eq!(code("500"), (502, "upstream_down".into()));
    assert_eq!(code("429"), (429, "upstream_limited".into()));
    assert_eq!(code("222"), (502, "too_large".into()));
    // Failures aren't cached: the next call asks again.
    assert_eq!(code("404"), (404, "not_found".into()));
    assert_eq!(up.hits("404"), 2);
    assert!(!dir.path().join("matches/404.json").exists());
}

#[test]
fn imports_are_rate_limited_per_client_but_cached_matches_still_load() {
    let dir = tempfile::tempdir().expect("tempdir");
    let up = upstream(routes());
    let s = Server::start(dir.path(), up.port, &[("MATCH_PER_CLIENT", "2")]);
    assert_eq!(s.get("111").0, 200);
    assert_eq!(s.get("112").0, 200);
    let (status, body) = s.get("113");
    assert_eq!(status, 429, "{body}");
    assert!(body.contains("rate_limited"));
    assert_eq!(up.hits("113"), 0);
    assert_eq!(s.get("111").0, 200, "a cached match is free");
    let calls = AtomicUsize::new(up.hits("111") + up.hits("112"));
    assert_eq!(calls.load(Ordering::Relaxed), 2);
}

#[test]
fn the_upstream_bucket_caps_bursts_from_everyone() {
    let dir = tempfile::tempdir().expect("tempdir");
    let up = upstream(routes());
    let s = Server::start(dir.path(), up.port, &[("MATCH_UPSTREAM_BURST", "2"), ("MATCH_UPSTREAM_REFILL_S", "3600")]);
    assert_eq!(s.get("111").0, 200);
    assert_eq!(s.get("112").0, 200);
    let (status, body) = s.get("113");
    assert_eq!(status, 429, "{body}");
    assert!(body.contains("busy"));
}

/// Names (operator, 2026-11-08): the players' public Steam names come from one batched call to
/// deadlock-api's profiles, by the account ids in the match, which exist only in memory: the
/// cache keeps the sanitised name per slot and no id.
#[test]
fn names_come_from_one_profiles_call_and_no_id_is_kept() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut routes = HashMap::new();
    routes.insert("112".to_owned(), (200, synthetic(112)));
    let profiles = serde_json::json!([
        { "account_id": ACCOUNT_A + 1, "personaname": "Coach<script>\u{202E}", "profileurl": "https://x", "avatar": "", "avatarmedium": "", "avatarfull": "", "last_updated": "2026-01-01T00:00:00Z", "friends": [], "matches_played_last_30d": 3 },
        { "account_id": ACCOUNT_A + 8, "personaname": "Marrow", "profileurl": "https://y", "avatar": "", "avatarmedium": "", "avatarfull": "", "last_updated": "2026-01-01T00:00:00Z", "friends": [], "matches_played_last_30d": 3 },
    ]);
    routes.insert("steam".to_owned(), (200, serde_json::to_vec(&profiles).expect("json")));
    let up = upstream(routes);
    let s = Server::start(dir.path(), up.port, &[]);
    let (status, body) = s.get("112");
    assert_eq!(status, 200, "{body}");
    assert_eq!(up.hits("steam"), 1, "one batched call");
    let t: serde_json::Value = serde_json::from_str(&body).expect("json");
    let players = t["players"].as_array().expect("players");
    let name = |team: &str, slot: u64| players.iter().find(|p| p["team"] == team && p["slot"] == slot).map(|p| p["name"].clone());
    assert_eq!(name("amber", 0), Some(serde_json::json!("Coachscript")), "sanitised");
    assert_eq!(name("sapphire", 1), Some(serde_json::json!("Marrow")));
    assert_eq!(name("amber", 1), Some(serde_json::Value::Null), "no profile: no name");
    let cached = std::fs::read_to_string(dir.path().join("matches/112.json")).expect("cache file");
    for text in [&body, &cached] {
        for leak in ["account", "steam", "persona", "profileurl", &(ACCOUNT_A + 1).to_string(), &(ACCOUNT_A + 8).to_string()] {
            assert!(!text.contains(leak), "{leak} leaked");
        }
    }
}

#[test]
fn a_failed_names_lookup_imports_without_names() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut routes = HashMap::new();
    routes.insert("113".to_owned(), (200, synthetic(113)));
    routes.insert("steam".to_owned(), (429, b"{}".to_vec()));
    let up = upstream(routes);
    let s = Server::start(dir.path(), up.port, &[]);
    let (status, body) = s.get("113");
    assert_eq!(status, 200, "{body}");
    let t: serde_json::Value = serde_json::from_str(&body).expect("json");
    assert!(t["players"].as_array().expect("players").iter().all(|p| p.get("name").is_none()));
}
