//! Match import against a fake deadlock-api: the real server binary, a local HTTP server serving
//! fixtures, and the cache under DATA_DIR/matches. The fixtures are anonymised: a synthetic match
//! in the real shape (with made-up account ids that must not survive), and a trimmed real match
//! (130816395) with every account field removed.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

mod support;

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

impl Server {
    fn start(dir: &std::path::Path, upstream: u16, env: &[(&str, &str)]) -> Server {
        let mut cmd = support::server();
        cmd.env("DATA_DIR", dir)
            .env("PUBLIC_ORIGIN", "http://localhost:5173")
            .env("RUST_LOG", "warn")
            .env("MATCH_API_BASE", format!("http://127.0.0.1:{upstream}"))
            .envs(env.iter().copied())
            .stdout(Stdio::null());
        let support::Started { child, port, .. } = support::start_or_panic(cmd);
        Server { child, port }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    /// Status and body of `GET /api/matches/{id}`.
    fn get(&self, id: &str) -> (u16, String) {
        self.get_path(&format!("/api/matches/{id}"))
    }

    /// Status and body of `GET /api/matches/{id}/preview`.
    fn preview(&self, id: &str) -> (u16, String) {
        self.get_path(&format!("/api/matches/{id}/preview"))
    }

    fn get_path(&self, path: &str) -> (u16, String) {
        let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
        let mut r = agent.get(&self.url(path)).call().expect("request");
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
            "player_slot": slot, "team": team, "hero_id": 10 + slot, "assigned_lane": 1, "kills": slot % 3,
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
            "duration_s": 120, "start_time": 1_793_753_219u64, "match_id": id, "game_mode": 1, "match_mode": 1, "winning_team": 1,
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
    // Respawns from the death durations: one per death, and the hero is back on its path then.
    let (mut deaths, mut back_on_path) = (0, 0);
    for p in t["players"].as_array().expect("players") {
        let respawn = p["respawn"].as_array().expect("respawn");
        assert_eq!(respawn.len(), p["deaths"].as_array().map_or(0, Vec::len));
        for r in respawn {
            let (died, back) = (r[0].as_u64().expect("died") as usize, r[1].as_u64().expect("back") as usize);
            assert!(back > died);
            deaths += 1;
            // The first second back on the path, within 2 s (re-anchored paths stretch a little).
            let seen = (died + 1..back + 10).find(|&i| p["x"][i].is_number()).unwrap_or(0);
            back_on_path += usize::from(seen.abs_diff(back) <= 2);
        }
    }
    assert!(deaths > 20 && back_on_path * 10 >= deaths * 9, "{back_on_path} of {deaths}");
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

/// A cache written before the mode was kept (QA 2026-11-08) is fetched again once; the fresh one
/// says its mode and is served from then on.
#[test]
fn a_cache_without_its_mode_is_fetched_again_once() {
    let dir = tempfile::tempdir().expect("tempdir");
    let up = upstream(routes());
    let s = Server::start(dir.path(), up.port, &[]);
    std::fs::create_dir_all(dir.path().join("matches")).expect("mkdir");
    let legacy = serde_json::json!({ "match_id": 111, "start_time": 0, "duration_s": 120, "source": "deadlock-api.com", "players": [], "objectives": [], "mid_boss": [], "reanchored": 0, "events": [] });
    std::fs::write(dir.path().join("matches/111.json"), serde_json::to_vec(&legacy).expect("json")).expect("legacy");
    let (status, body) = s.get("111");
    assert_eq!(status, 200, "{body}");
    let t: serde_json::Value = serde_json::from_str(&body).expect("json");
    assert_eq!((t["game_mode"].as_i64(), t["players"].as_array().map(Vec::len)), (Some(1), Some(12)), "the fresh one, not the legacy one");
    assert_eq!(up.hits("111"), 1);
    assert_eq!(s.get("111"), (200, body));
    assert_eq!(up.hits("111"), 1, "then a cache hit");
}

/// One raw GET (no client-side decoding): the response's headers, lower-cased, and its body
/// with any chunked framing removed.
fn raw_get(port: u16, path: &str, accept: Option<&str>) -> (String, Vec<u8>) {
    use std::io::Read;
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let enc = accept.map(|a| format!("accept-encoding: {a}\r\n")).unwrap_or_default();
    write!(s, "GET {path} HTTP/1.1\r\nhost: 127.0.0.1\r\n{enc}connection: close\r\n\r\n").expect("send");
    let mut all = Vec::new();
    s.read_to_end(&mut all).expect("read");
    let at = all.windows(4).position(|w| w == b"\r\n\r\n").expect("head") + 4;
    let head = String::from_utf8_lossy(&all[..at]).to_ascii_lowercase();
    let mut body = all[at..].to_vec();
    if head.contains("transfer-encoding: chunked") {
        let (mut out, mut rest) = (Vec::new(), &body[..]);
        while let Some(eol) = rest.windows(2).position(|w| w == b"\r\n") {
            let n = usize::from_str_radix(std::str::from_utf8(&rest[..eol]).expect("size").trim(), 16).expect("hex");
            if n == 0 {
                break;
            }
            out.extend_from_slice(&rest[eol + 2..eol + 2 + n]);
            rest = &rest[eol + 2 + n + 2..];
        }
        body = out;
    }
    (head, body)
}

/// The timeline routes compress for a client that accepts gzip or zstd (the edge proxy doesn't,
/// and a FORMAT 7 timeline is ~1.8 MB of JSON), and not otherwise.
#[test]
fn a_timeline_is_compressed_for_a_client_that_accepts_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let up = upstream(routes());
    let s = Server::start(dir.path(), up.port, &[]);
    let (head, plain) = raw_get(s.port, "/api/matches/130816395", None);
    assert!(head.starts_with("http/1.1 200"), "{head}");
    assert!(!head.contains("content-encoding"), "{head}");
    assert!(serde_json::from_slice::<serde_json::Value>(&plain).is_ok(), "plain JSON without accept-encoding");
    for (accept, encoding, magic) in [("gzip", "gzip", &[0x1f, 0x8b][..]), ("zstd", "zstd", &[0x28, 0xb5, 0x2f, 0xfd][..]), ("gzip;q=0, zstd", "zstd", &[0x28, 0xb5, 0x2f, 0xfd][..])] {
        let (head, body) = raw_get(s.port, "/api/matches/130816395", Some(accept));
        assert!(head.contains(&format!("content-encoding: {encoding}")), "{accept}: {head}");
        assert!(head.contains("vary: accept-encoding"), "{accept}: {head}");
        assert!(body.starts_with(magic), "{accept}: a {encoding} body");
        assert!(body.len() * 2 < plain.len(), "{accept}: {} of {} bytes", body.len(), plain.len());
    }
    let (head, _) = raw_get(s.port, "/api/matches/130816395", Some("br"));
    assert!(!head.contains("content-encoding"), "brotli isn't offered: {head}");
}

/// The replay picker's card (spec §6a, "Previews"): heroes by slot, the score and the winner,
/// from the same cached summary; no names or ids, and a second look is free.
#[test]
fn a_preview_is_small_cached_and_carries_no_names() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut routes = routes();
    let profiles = serde_json::json!([{ "account_id": ACCOUNT_A + 1, "personaname": "Marrow", "profileurl": "https://y", "avatar": "", "avatarmedium": "", "avatarfull": "", "last_updated": "2026-01-01T00:00:00Z", "friends": [], "matches_played_last_30d": 3 }]);
    routes.insert("steam".to_owned(), (200, serde_json::to_vec(&profiles).expect("json")));
    let up = upstream(routes);
    let s = Server::start(dir.path(), up.port, &[]);
    let (status, body) = s.preview("111");
    assert_eq!(status, 200, "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).expect("json");
    // Amber is slots 1–6 (heroes 11–16), Sapphire 7–12; kills are slot % 3 summed per team; souls
    // the last samples (2000 × slot) summed; slot 1's one death doesn't count when kills are known.
    assert_eq!(
        v,
        serde_json::json!({
            "match_id": 111, "start_time": 1_793_753_219u64, "duration_s": 120, "game_mode": 1, "winner": "sapphire",
            "teams": [
                { "team": "amber", "heroes": [[0, 11], [1, 12], [2, 13], [3, 14], [4, 15], [5, 16]], "kills": 1 + 2 + 0 + 1 + 2 + 0, "souls": 2000 * 21 },
                { "team": "sapphire", "heroes": [[0, 17], [1, 18], [2, 19], [3, 20], [4, 21], [5, 22]], "kills": 1 + 2 + 0 + 1 + 2 + 0, "souls": 2000 * 57 },
            ],
        })
    );
    assert!(body.len() < 1024, "{} bytes", body.len());
    let cached = std::fs::read_to_string(dir.path().join("matches/111.preview.json")).expect("preview cache");
    for text in [&body, &cached] {
        for leak in ["name", "Marrow", "account", "steam", "persona", &(ACCOUNT_A + 1).to_string()] {
            assert!(!text.contains(leak), "{leak} leaked");
        }
    }
    // One upstream call: the preview again, and opening the match, are cache hits.
    assert_eq!(s.preview("111"), (200, body));
    assert_eq!(s.get("111").0, 200);
    assert_eq!(up.hits("111"), 1);
    assert_eq!(up.hits("steam"), 1, "the open's own names lookup, no more");
}

/// A match without kills in its metadata (the trimmed real one, or a summary cached before
/// kills were kept) counts the other team's deaths; no winner is `null`.
#[test]
fn a_preview_without_kills_counts_deaths() {
    let dir = tempfile::tempdir().expect("tempdir");
    let up = upstream(routes());
    let s = Server::start(dir.path(), up.port, &[]);
    let (status, full) = s.get("130816395");
    assert_eq!(status, 200, "{full}");
    let t: serde_json::Value = serde_json::from_str(&full).expect("json");
    let deaths = |team: &str| t["players"].as_array().expect("players").iter().filter(|p| p["team"] == team).map(|p| p["deaths"].as_array().map_or(0, Vec::len) as u64).sum::<u64>();
    let (status, body) = s.preview("130816395");
    assert_eq!(status, 200, "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).expect("json");
    assert!(v["winner"].is_null());
    assert_eq!(v["teams"][0]["kills"].as_u64(), Some(deaths("sapphire")));
    assert_eq!(v["teams"][1]["kills"].as_u64(), Some(deaths("amber")));
    assert_eq!(v["teams"][0]["heroes"].as_array().map(Vec::len), Some(6));
    assert_eq!(up.hits("130816395"), 1);
}

/// No metadata (a fresh match): a 404 the card reads as "Not recorded", and nothing cached.
/// Bad ids never reach the upstream.
#[test]
fn an_unknown_match_has_no_preview() {
    let dir = tempfile::tempdir().expect("tempdir");
    let up = upstream(routes());
    let s = Server::start(dir.path(), up.port, &[]);
    let (status, body) = s.preview("404");
    assert_eq!(status, 404, "{body}");
    assert!(body.contains("not_found"));
    assert!(!dir.path().join("matches/404.preview.json").exists());
    assert_eq!(s.preview("0123").0, 400);
    assert_eq!(up.hits("0123"), 0);
}

/// deadlock-api said 429: previews stop asking it for a while (an open still may), and cached
/// ones are still served. Previews count against the same per-client limit as opens.
#[test]
fn previews_hold_back_after_a_429_and_share_the_open_limits() {
    let dir = tempfile::tempdir().expect("tempdir");
    let up = upstream(routes());
    let s = Server::start(dir.path(), up.port, &[("MATCH_PER_CLIENT", "3")]);
    assert_eq!(s.preview("112").0, 200);
    let (status, body) = s.preview("429");
    assert_eq!((status, body.contains("upstream_limited")), (429, true), "{body}");
    let (status, body) = s.preview("111");
    assert_eq!((status, body.contains("upstream_limited")), (429, true), "{body}");
    assert_eq!(up.hits("111"), 0, "held back: no upstream call");
    assert_eq!(s.preview("112").0, 200, "a cached preview is served");
    assert_eq!(s.get("111").0, 200, "an open still goes");
    assert_eq!(s.preview("111").0, 200, "and its summary makes the preview");
    assert_eq!(up.hits("111"), 1);
    // Still held, and the per-client limit (3) is spent besides: 112, 429 and the open of 111.
    let (status, body) = s.preview("113");
    assert_eq!(status, 429, "{body}");
    assert_eq!(up.hits("113"), 0);
}
