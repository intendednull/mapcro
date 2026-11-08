//! Match import (docs/research/match-replay.md, v1): `GET /api/matches/{id}` fetches a match's
//! metadata from deadlock-api.com, derives a compact timeline (positions at 1 s, health, deaths,
//! objectives, mid boss kills, souls samples) and caches it under `DATA_DIR/matches/<id>.json`.
//! Browsers never call the upstream: the CSP stays `connect-src 'self'`, users' addresses stay
//! private, and one cached copy serves a whole room.
//!
//! **Personal data:** a player is a team, a slot and a hero. Account ids in the upstream response
//! are never deserialised, so they can't be cached or returned. The metadata call carries no
//! display names (and no parameter to add them), so names aren't imported (operator: names only
//! if the match call already returns them).
//!
//! **Limits:** a global token bucket for upstream calls (well under deadlock-api's published
//! limits), a per-client limit on uncached imports, a timeout and a response size cap.

use crate::AppState;
use crate::api::{client_ip, client_key};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// deadlock-api.com, unless `MATCH_API_BASE` points elsewhere (tests run a local fake).
const DEFAULT_BASE: &str = "https://api.deadlock-api.com";

/// Settings from the environment, read once.
struct Settings {
    base: String,
    /// Upstream calls: bucket size and seconds per token.
    bucket: f64,
    refill_s: f64,
    /// Uncached imports per client per window.
    per_client: usize,
    window: Duration,
    max_bytes: u64,
    timeout: Duration,
}

fn settings() -> &'static Settings {
    static S: OnceLock<Settings> = OnceLock::new();
    S.get_or_init(|| {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let num = |k: &str, d: f64| var(k).and_then(|v| v.parse().ok()).unwrap_or(d);
        Settings {
            base: var("MATCH_API_BASE").unwrap_or_else(|| DEFAULT_BASE.to_owned()).trim_end_matches('/').to_owned(),
            // 5 at once, then one every 2 s: at most 30 a minute against their 100 per 10 s.
            bucket: num("MATCH_UPSTREAM_BURST", 5.0),
            refill_s: num("MATCH_UPSTREAM_REFILL_S", 2.0),
            per_client: num("MATCH_PER_CLIENT", 20.0) as usize,
            window: Duration::from_secs(num("MATCH_PER_CLIENT_WINDOW_S", 3600.0) as u64),
            // A 35-minute match is ~1.2 MB of JSON.
            max_bytes: num("MATCH_MAX_BYTES", (16 * 1024 * 1024) as f64) as u64,
            timeout: Duration::from_secs(num("MATCH_TIMEOUT_S", 20.0) as u64),
        }
    })
}

struct Limits {
    tokens: f64,
    at: Instant,
    clients: HashMap<IpAddr, Vec<Instant>>,
}

fn limits() -> &'static Mutex<Limits> {
    static L: OnceLock<Mutex<Limits>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(Limits { tokens: settings().bucket, at: Instant::now(), clients: HashMap::new() }))
}

/// Take one upstream call for `client`, or say which limit refused it.
fn admit(client: IpAddr) -> Result<(), &'static str> {
    let s = settings();
    let mut l = limits().lock().unwrap_or_else(|p| p.into_inner());
    let now = Instant::now();
    let seen = l.clients.entry(client).or_default();
    seen.retain(|t| now.duration_since(*t) < s.window);
    if seen.len() >= s.per_client {
        return Err("rate_limited");
    }
    let refill = now.duration_since(l.at).as_secs_f64() / s.refill_s;
    l.tokens = (l.tokens + refill).min(s.bucket);
    l.at = now;
    if l.tokens < 1.0 {
        return Err("busy");
    }
    l.tokens -= 1.0;
    l.clients.entry(client).or_default().push(now);
    if l.clients.len() > 10_000 {
        l.clients.retain(|_, v| v.iter().any(|t| now.duration_since(*t) < s.window));
    }
    Ok(())
}

// ---- upstream shape (only what we use; account ids and names are never read) ----

#[derive(Deserialize)]
struct Upstream {
    match_info: MatchInfo,
}

#[derive(Deserialize)]
struct MatchInfo {
    duration_s: u32,
    start_time: u64,
    match_id: u64,
    #[serde(default)]
    players: Vec<Player>,
    #[serde(default)]
    objectives: Vec<Objective>,
    #[serde(default)]
    mid_boss: Vec<MidBoss>,
    match_paths: Option<Paths>,
    /// `ECitadelGameMode`, absent in older shapes (read as standard).
    #[serde(default)]
    game_mode: Option<i64>,
}

#[derive(Deserialize)]
struct ModeOnly {
    match_info: ModeInfo,
}
#[derive(Deserialize)]
struct ModeInfo {
    /// `ECitadelGameMode`: 1 is the standard 6v6, 4 Street Brawl. Absent in older shapes.
    #[serde(default)]
    game_mode: Option<i64>,
}

/// Why a match's mode is refused (2026-11-08): our map, lanes and objectives describe only the
/// standard 6v6 mode. `None` for a standard match, or one whose metadata doesn't say.
pub fn mode_refusal(raw: &[u8]) -> Option<&'static str> {
    refusal_for(serde_json::from_slice::<ModeOnly>(raw).ok()?.match_info.game_mode?)
}

fn refusal_for(mode: i64) -> Option<&'static str> {
    match mode {
        mapcro_replay::STANDARD_GAME_MODE => None,
        mapcro_replay::STREET_BRAWL => Some(mapcro_replay::reason::BRAWL),
        _ => Some(mapcro_replay::reason::UNSUPPORTED_MODE),
    }
}

#[derive(Deserialize)]
struct Player {
    player_slot: u32,
    team: u32,
    hero_id: u32,
    /// Read only to look the player's public in-game name up, in memory, during the import; never
    /// stored, cached, logged or returned (operator's standing rule).
    #[serde(default)]
    account_id: Option<u64>,
    #[serde(default)]
    death_details: Vec<Death>,
    #[serde(default)]
    stats: Vec<Stat>,
}

#[derive(Deserialize)]
struct Death {
    game_time_s: u32,
    #[serde(default)]
    death_pos: Option<Pos>,
    #[serde(default)]
    killer_player_slot: Option<u32>,
}

#[derive(Deserialize)]
struct Pos {
    x: f64,
    y: f64,
}

#[derive(Deserialize)]
struct Stat {
    time_stamp_s: u32,
    net_worth: u32,
}

#[derive(Deserialize)]
struct Objective {
    team_objective_id: u32,
    team: u32,
    #[serde(default)]
    destroyed_time_s: u32,
}

#[derive(Deserialize)]
struct MidBoss {
    #[serde(default)]
    team_killed: u32,
    destroyed_time_s: u32,
}

#[derive(Deserialize)]
struct Paths {
    x_resolution: f64,
    y_resolution: f64,
    #[serde(default)]
    paths: Vec<Path_>,
}

#[derive(Deserialize)]
struct Path_ {
    player_slot: u32,
    x_min: f64,
    x_max: f64,
    y_min: f64,
    y_max: f64,
    #[serde(default)]
    x_pos: Vec<f64>,
    #[serde(default)]
    y_pos: Vec<f64>,
    #[serde(default)]
    health: Vec<f64>,
}

// ---- the timeline we serve ----

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct Timeline {
    pub match_id: u64,
    pub start_time: u64,
    pub duration_s: u32,
    pub source: String,
    pub players: Vec<TimelinePlayer>,
    pub objectives: Vec<TimelineObjective>,
    pub mid_boss: Vec<TimelineMidBoss>,
    /// Players whose path clock drifted from the game clock and was re-anchored on deaths.
    pub reanchored: u32,
    /// Deaths (with killer and place when the match data has them), objectives, mid boss
    /// kills and big souls swings, in the replay timeline's shape (spec §6a, "Events").
    #[serde(default)]
    pub events: Vec<mapcro_replay::timeline::Event>,
    /// The match's `ECitadelGameMode` (standard when the metadata didn't say). A cache without
    /// it predates the mode refusal and is fetched again, so a Brawl match cached then is
    /// refused now rather than served (QA 2026-11-08).
    #[serde(default)]
    pub game_mode: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct TimelinePlayer {
    /// "amber" or "sapphire".
    pub team: String,
    /// 0..5 within the team, in the game's slot order.
    pub slot: u32,
    pub hero_id: u32,
    /// World units at each game second, 0..=duration; `null` while dead.
    pub x: Vec<Option<i32>>,
    pub y: Vec<Option<i32>>,
    /// Health percent at each game second.
    pub health: Vec<u8>,
    pub deaths: Vec<u32>,
    /// `[game second, net worth]`, every 3–5 minutes.
    pub souls: Vec<[u32; 2]>,
    /// The player's public Steam name (deadlock-api's profiles), sanitised; absent if the lookup
    /// failed. Never an id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct TimelineObjective {
    /// The board's objective key, as the pack writes it (`walker:amber:lane1:1`).
    pub key: String,
    pub kind: String,
    pub team: String,
    pub lane: u32,
    pub destroyed_s: u32,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct TimelineMidBoss {
    pub destroyed_s: u32,
    pub team_killed: String,
}

fn team_name(t: u32) -> &'static str {
    // Lobby team 0 starts at the Amber spawn (research §4; checked on two matches).
    if t == 0 { "amber" } else { "sapphire" }
}

/// Valve's objective lane numbers to our lane zipline numbers. Checked against two matches
/// (130816395, 130816450): at each destruction, the attacking team's heroes stand by our
/// `lane1` / `lane4` / `lane6` entity respectively. Lane 2 isn't on the current map.
fn our_lane(valve_lane: u32) -> Option<u32> {
    match valve_lane {
        1 => Some(1),
        3 => Some(4),
        4 => Some(6),
        _ => None,
    }
}

/// `ECitadelTeamObjective` to our entity kind, lane and key. `None` for the core (no entity)
/// and for lanes the map doesn't have.
pub fn objective_key(id: u32, team: u32) -> Option<(String, &'static str, u32)> {
    let t = team_name(team);
    let (kind, lane, indexed) = match id {
        1..=4 => ("guardian", our_lane(id)?, true),
        5..=8 => ("walker", our_lane(id - 4)?, true),
        12..=15 => ("base_guardian", our_lane(id - 11)?, false),
        // Shield generator 1 is the east shrine and 2 the west, for both teams (checked as above).
        10 => ("shrine", 6, true),
        11 => ("shrine", 1, true),
        9 => ("patron", 3, true),
        _ => return None,
    };
    // Base guardians are drawn one per pair, keyed without an index (web/src/map/model.ts).
    let key = if indexed { format!("{kind}:{t}:lane{lane}:1") } else { format!("{kind}:{t}:lane{lane}") };
    Some((key, kind, lane))
}

/// Path sample index for each game second, re-anchored on deaths: a death at game second `d`
/// shows as the first zero-health sample at index `d + 1` when the clocks agree. Returns the
/// mapping and whether any anchor moved by more than a sample.
fn anchors(deaths: &[u32], health: &[f64], duration: u32) -> (Vec<usize>, bool) {
    let starts: Vec<usize> = (1..health.len()).filter(|&i| health[i] == 0.0 && health[i - 1] != 0.0).collect();
    let mut pts: Vec<(f64, f64)> = vec![(0.0, 0.0)];
    let mut next = 0;
    let mut drift = false;
    for &d in deaths {
        let want = d as usize + 1;
        // The first zero run at or after the death, within two minutes, in order.
        if let Some(j) = (next..starts.len()).find(|&j| starts[j] + 1 >= want && starts[j] <= want + 120) {
            let (t, i) = (want as f64, starts[j] as f64);
            if t > pts.last().map_or(-1.0, |p| p.0) && i >= pts.last().map_or(0.0, |p| p.1) {
                drift |= (i - t).abs() > 1.0;
                pts.push((t, i));
            }
            next = j + 1;
        }
    }
    let last = health.len().saturating_sub(1);
    let map = (0..=duration)
        .map(|s| {
            let t = s as f64;
            let k = pts.iter().rposition(|p| p.0 <= t).unwrap_or(0);
            let idx = match pts.get(k + 1) {
                Some(&(t1, i1)) => {
                    let (t0, i0) = pts[k];
                    i0 + (t - t0) * (i1 - i0) / (t1 - t0)
                }
                None => t + (pts[k].1 - pts[k].0),
            };
            (idx.round().max(0.0) as usize).min(last)
        })
        .collect();
    (map, drift)
}

/// The match's players' account ids by (team, slot), for the names lookup only.
fn accounts(raw: &[u8]) -> Vec<((String, u32), u64)> {
    let Ok(u) = serde_json::from_slice::<Upstream>(raw) else { return Vec::new() };
    let m = u.match_info;
    let mut out = Vec::new();
    for team in [0, 1] {
        let mut ps: Vec<&Player> = m.players.iter().filter(|p| p.team == team).collect();
        ps.sort_by_key(|p| p.player_slot);
        for (i, p) in ps.into_iter().enumerate() {
            if let Some(a) = p.account_id.filter(|a| *a > 0) {
                out.push(((team_name(team).to_owned(), i as u32), a));
            }
        }
    }
    out
}

#[derive(Deserialize)]
struct Profile {
    account_id: u64,
    personaname: String,
}

/// Public Steam names for the match's players, one batched call (deadlock-api
/// `/v1/players/steam`). Any failure means no names, never a failed import. Blocking.
fn names(raw: &[u8]) -> HashMap<(String, u32), String> {
    let accounts = accounts(raw);
    // One call per uncached import, so the import limits bound it too (their read limit is
    // 100 requests a second per address).
    if accounts.is_empty() {
        return HashMap::new();
    }
    let s = settings();
    let ids: Vec<String> = accounts.iter().map(|(_, a)| a.to_string()).collect();
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(s.timeout)).http_status_as_error(false).max_redirects(0).user_agent("mapcro (https://mapcro.dmgdeadlock.com)").build().into();
    let Ok(mut r) = agent.get(&format!("{}/v1/players/steam?account_ids={}", s.base, ids.join(","))).call() else { return HashMap::new() };
    if r.status().as_u16() != 200 {
        return HashMap::new();
    }
    let Ok(profiles) = r.body_mut().with_config().limit(4 * 1024 * 1024).read_json::<Vec<Profile>>() else { return HashMap::new() };
    let by_id: HashMap<u64, &str> = profiles.iter().map(|p| (p.account_id, p.personaname.as_str())).collect();
    accounts
        .into_iter()
        .filter_map(|(slot, a)| {
            // deadlock-api answers in SteamID3 (32-bit) whichever form was asked.
            let name = by_id.get(&a).or_else(|| by_id.get(&(a & 0xffff_ffff)))?;
            Some((slot, mapcro_replay::timeline::clean_name(name)?))
        })
        .collect()
}

pub fn derive(raw: &[u8]) -> Result<Timeline, String> {
    let u: Upstream = serde_json::from_slice(raw).map_err(|e| format!("unexpected match shape: {e}"))?;
    let m = u.match_info;
    let paths = m.match_paths.as_ref().ok_or("no paths")?;
    let mut reanchored = 0;
    let mut slots: HashMap<u32, u32> = HashMap::new();
    for team in [0, 1] {
        let mut ps: Vec<u32> = m.players.iter().filter(|p| p.team == team).map(|p| p.player_slot).collect();
        ps.sort_unstable();
        for (i, s) in ps.into_iter().enumerate() {
            slots.insert(s, i as u32);
        }
    }
    let mut players = Vec::new();
    for p in &m.players {
        let Some(path) = paths.paths.iter().find(|q| q.player_slot == p.player_slot) else { continue };
        let deaths: Vec<u32> = p.death_details.iter().map(|d| d.game_time_s).collect();
        let (map, drift) = anchors(&deaths, &path.health, m.duration_s);
        reanchored += u32::from(drift);
        let n = path.x_pos.len().min(path.y_pos.len()).min(path.health.len());
        let (mut x, mut y, mut health) = (Vec::new(), Vec::new(), Vec::new());
        for &i in &map {
            let alive = i < n && path.health[i] > 0.0;
            let h = if i < n { path.health[i].clamp(0.0, 100.0) as u8 } else { 0 };
            health.push(h);
            if alive {
                // De-quantise with the path's own bounding box (research §1.2).
                x.push(Some((path.x_min + path.x_pos[i] / paths.x_resolution * (path.x_max - path.x_min)).round() as i32));
                y.push(Some((path.y_min + path.y_pos[i] / paths.y_resolution * (path.y_max - path.y_min)).round() as i32));
            } else {
                x.push(None);
                y.push(None);
            }
        }
        players.push(TimelinePlayer {
            team: team_name(p.team).to_owned(),
            slot: slots.get(&p.player_slot).copied().unwrap_or(0),
            hero_id: p.hero_id,
            x,
            y,
            health,
            deaths,
            souls: p.stats.iter().map(|s| [s.time_stamp_s, s.net_worth]).collect(),
            name: None,
        });
    }
    players.sort_by(|a, b| (a.team.as_str(), a.slot).cmp(&(b.team.as_str(), b.slot)));
    let events = events(&m, &players, &slots);
    let objectives = m
        .objectives
        .iter()
        .filter(|o| o.destroyed_time_s > 0)
        .filter_map(|o| {
            let (key, kind, lane) = objective_key(o.team_objective_id, o.team)?;
            Some(TimelineObjective { key, kind: kind.to_owned(), team: team_name(o.team).to_owned(), lane, destroyed_s: o.destroyed_time_s })
        })
        .collect();
    let mid_boss = m
        .mid_boss
        .iter()
        .filter(|b| b.destroyed_time_s > 0)
        .map(|b| TimelineMidBoss { destroyed_s: b.destroyed_time_s, team_killed: team_name(b.team_killed).to_owned() })
        .collect();
    Ok(Timeline {
        match_id: m.match_id,
        start_time: m.start_time,
        duration_s: m.duration_s,
        source: "deadlock-api.com".to_owned(),
        players,
        objectives,
        mid_boss,
        reanchored,
        game_mode: Some(m.game_mode.unwrap_or(mapcro_replay::STANDARD_GAME_MODE)),
        events: {
            let mut e = events;
            for o in &objectives_for_events(&m) {
                e.push(o.clone());
            }
            let souls: Vec<(String, Vec<[u32; 2]>)> = players_souls(&m);
            e.extend(mapcro_replay::timeline::souls_swings(&souls, m.duration_s));
            e.sort_by(|a, b| (a.t, &a.kind).cmp(&(b.t, &b.kind)));
            e
        },
    })
}

fn site_xy(key: &str) -> (Option<i32>, Option<i32>) {
    mapcro_replay::map::current()
        .sites
        .iter()
        .find(|s| s.key == key || s.key.strip_suffix(":1") == Some(key))
        .filter(|s| s.world.len() >= 2)
        .map_or((None, None), |s| (Some(s.world[0].round() as i32), Some(s.world[1].round() as i32)))
}

/// Deaths, with the killer when the match data names one and the place it gives (else where the
/// hero was last seen on its path).
fn events(m: &MatchInfo, players: &[TimelinePlayer], slots: &HashMap<u32, u32>) -> Vec<mapcro_replay::timeline::Event> {
    use mapcro_replay::timeline::{Event, Who, event};
    let mut out = Vec::new();
    for p in &m.players {
        let team = team_name(p.team).to_owned();
        let slot = slots.get(&p.player_slot).copied().unwrap_or(0);
        let tp = players.iter().find(|q| q.team == team && q.slot == slot);
        for d in &p.death_details {
            let by = d.killer_player_slot.and_then(|k| m.players.iter().find(|q| q.player_slot == k)).map(|k| Who {
                team: team_name(k.team).to_owned(),
                slot: slots.get(&k.player_slot).copied().unwrap_or(0),
                hero_id: k.hero_id,
            });
            let last = tp.and_then(|tp| (0..=(d.game_time_s as usize).min(tp.x.len().saturating_sub(1))).rev().find_map(|i| Some((tp.x[i]?, tp.y[i]?))));
            let (x, y) = match &d.death_pos {
                Some(pos) if pos.x.abs() <= 32768.0 && pos.y.abs() <= 32768.0 => (Some(pos.x.round() as i32), Some(pos.y.round() as i32)),
                _ => (last.map(|l| l.0), last.map(|l| l.1)),
            };
            out.push(Event { team: Some(team.clone()), slot: Some(slot), hero_id: Some(p.hero_id), by, x, y, ..event(d.game_time_s.min(m.duration_s), "death") });
        }
    }
    for b in m.mid_boss.iter().filter(|b| b.destroyed_time_s > 0) {
        let (x, y) = site_xy("mid_boss:neutral:lane0:1");
        out.push(Event { team: Some(team_name(b.team_killed).to_owned()), key: Some("mid_boss:neutral:lane0:1".into()), x, y, ..event(b.destroyed_time_s.min(m.duration_s), "mid_boss") });
    }
    out
}

fn objectives_for_events(m: &MatchInfo) -> Vec<mapcro_replay::timeline::Event> {
    m.objectives
        .iter()
        .filter(|o| o.destroyed_time_s > 0)
        .filter_map(|o| {
            let (key, _, _) = objective_key(o.team_objective_id, o.team)?;
            let (x, y) = site_xy(&key);
            Some(mapcro_replay::timeline::Event { team: Some(team_name(o.team).to_owned()), key: Some(key), x, y, ..mapcro_replay::timeline::event(o.destroyed_time_s.min(m.duration_s), "objective") })
        })
        .collect()
}

fn players_souls(m: &MatchInfo) -> Vec<(String, Vec<[u32; 2]>)> {
    m.players.iter().map(|p| (team_name(p.team).to_owned(), p.stats.iter().map(|s| [s.time_stamp_s, s.net_worth]).collect())).collect()
}

fn err(status: StatusCode, code: &str) -> Response {
    (status, axum::Json(serde_json::json!({ "error": code }))).into_response()
}

fn json(bytes: Vec<u8>) -> Response {
    ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "private, max-age=3600")], bytes).into_response()
}

enum Fetched {
    Ok(Vec<u8>),
    NotFound,
    Limited,
    Down,
    TooLarge,
}

fn fetch(id: &str) -> Fetched {
    let s = settings();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(s.timeout))
        .http_status_as_error(false)
        .user_agent("mapcro (https://mapcro.dmgdeadlock.com)")
        .build()
        .into();
    let url = format!("{}/v1/matches/{id}/metadata?disable_steam=true", s.base);
    let mut r = match agent.get(&url).call() {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "match upstream unreachable");
            return Fetched::Down;
        }
    };
    match r.status().as_u16() {
        200 => {}
        404 => return Fetched::NotFound,
        429 => return Fetched::Limited,
        code => {
            tracing::warn!(code, "match upstream refused");
            return Fetched::Down;
        }
    }
    match r.body_mut().with_config().limit(s.max_bytes).read_to_vec() {
        Ok(b) => Fetched::Ok(b),
        Err(ureq::Error::BodyExceedsLimit(_)) => Fetched::TooLarge,
        Err(e) => {
            tracing::warn!(error = %e, "match upstream body");
            Fetched::Down
        }
    }
}

/// What a cached timeline must carry to be served as it is.
#[derive(Deserialize)]
struct CachedHead {
    events: Option<serde::de::IgnoredAny>,
    game_mode: Option<i64>,
}

fn cache_path(app: &AppState, id: &str) -> PathBuf {
    app.config.data_dir.join("matches").join(format!("{id}.json"))
}

/// A match refused for its mode keeps the reason here (a few bytes), so it isn't fetched again
/// and a board can't attach it.
fn refused_path(app: &AppState, id: &str) -> PathBuf {
    app.config.data_dir.join("matches").join(format!("{id}.refused"))
}

/// The reason a match was refused for its mode, if it was.
pub async fn refused(app: &AppState, id: &str) -> Option<&'static str> {
    let said = tokio::fs::read(refused_path(app, id)).await.ok()?;
    [mapcro_replay::reason::BRAWL, mapcro_replay::reason::UNSUPPORTED_MODE].into_iter().find(|r| r.as_bytes() == said.trim_ascii())
}

/// Remember a mode refusal. Only the metadata says so: a replay is untrusted, and a crafted one
/// must not lock a standard match out of every board.
pub async fn remember_refusal(app: &AppState, id: &str, why: &'static str) {
    let path = refused_path(app, id);
    if tokio::task::spawn_blocking(move || write_cache(&path, why.as_bytes())).await.map_or(true, |r| r.is_err()) {
        tracing::warn!(match_id = id, "mode refusal not written");
    }
}

/// Write the cache file atomically: a temporary file in the same directory, then a rename.
fn write_cache(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
    std::fs::create_dir_all(dir)?;
    let mut rnd = [0u8; 8];
    getrandom::fill(&mut rnd).map_err(|e| std::io::Error::other(e.to_string()))?;
    let tmp = dir.join(format!(".{}.{:x}.tmp", path.file_name().and_then(|f| f.to_str()).unwrap_or("m"), u64::from_le_bytes(rnd)));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

pub fn valid_id(id: &str) -> bool {
    (1..=12).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit()) && !id.starts_with('0')
}

pub async fn get(State(app): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !valid_id(&id) {
        return err(StatusCode::BAD_REQUEST, "bad_id");
    }
    if let Some(why) = refused(&app, &id).await {
        return err(StatusCode::UNPROCESSABLE_ENTITY, why);
    }
    let path = cache_path(&app, &id);
    // A cache is served only if it has events and says its mode, and the mode is standard. One
    // written before either existed is fetched again, once: the fresh one has both, or the
    // match is refused (production kept Brawl matches cached before the refusal, QA 2026-11-08).
    if let Ok(bytes) = tokio::fs::read(&path).await
        && let Ok(head) = serde_json::from_slice::<CachedHead>(&bytes)
        && head.events.is_some()
        && let Some(mode) = head.game_mode
    {
        if let Some(why) = refusal_for(mode) {
            remember_refusal(&app, &id, why).await;
            return err(StatusCode::UNPROCESSABLE_ENTITY, why);
        }
        return json(bytes);
    }
    match admit(client_key(client_ip(peer, &headers))) {
        Ok(()) => {}
        Err(code) => return err(StatusCode::TOO_MANY_REQUESTS, code),
    }
    let fetch_id = id.clone();
    let fetched = match tokio::task::spawn_blocking(move || fetch(&fetch_id)).await {
        Ok(f) => f,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "internal"),
    };
    let raw = match fetched {
        Fetched::Ok(b) => b,
        Fetched::NotFound => return err(StatusCode::NOT_FOUND, "not_found"),
        Fetched::Limited => return err(StatusCode::TOO_MANY_REQUESTS, "upstream_limited"),
        Fetched::Down => return err(StatusCode::BAD_GATEWAY, "upstream_down"),
        Fetched::TooLarge => return err(StatusCode::BAD_GATEWAY, "too_large"),
    };
    if let Some(why) = mode_refusal(&raw) {
        tracing::info!(match_id = id, why, "match refused for its mode");
        remember_refusal(&app, &id, why).await;
        let _ = tokio::fs::remove_file(&path).await;
        return err(StatusCode::UNPROCESSABLE_ENTITY, why);
    }
    let timeline = match tokio::task::spawn_blocking(move || {
        derive(&raw).map(|mut t| {
            let found = names(&raw);
            for p in &mut t.players {
                p.name = found.get(&(p.team.clone(), p.slot)).cloned();
            }
            t
        })
    })
    .await
    {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => {
            tracing::warn!(error = e, "match not understood");
            return err(StatusCode::BAD_GATEWAY, "upstream_shape");
        }
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "internal"),
    };
    if timeline.match_id.to_string() != id {
        return err(StatusCode::BAD_GATEWAY, "upstream_shape");
    }
    let bytes = match serde_json::to_vec(&timeline) {
        Ok(b) => b,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "internal"),
    };
    let to_write = bytes.clone();
    let reanchored = timeline.reanchored;
    match tokio::task::spawn_blocking(move || write_cache(&path, &to_write)).await {
        Ok(Ok(())) => tracing::info!(match_id = id, reanchored, "match imported"),
        _ => tracing::warn!(match_id = id, "match cache not written"),
    }
    json(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_digits_of_sane_length() {
        assert!(valid_id("130816395"));
        for bad in ["", "0123", "12a", "1234567890123", "../etc", "1 2"] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn objective_ids_map_to_our_keys() {
        assert_eq!(objective_key(1, 0).map(|k| k.0), Some("guardian:amber:lane1:1".into()));
        assert_eq!(objective_key(3, 1).map(|k| k.0), Some("guardian:sapphire:lane4:1".into()));
        assert_eq!(objective_key(8, 0).map(|k| k.0), Some("walker:amber:lane6:1".into()));
        assert_eq!(objective_key(14, 1).map(|k| k.0), Some("base_guardian:sapphire:lane4".into()));
        assert_eq!(objective_key(10, 0).map(|k| k.0), Some("shrine:amber:lane6:1".into()));
        assert_eq!(objective_key(11, 1).map(|k| k.0), Some("shrine:sapphire:lane1:1".into()));
        assert_eq!(objective_key(9, 1).map(|k| k.0), Some("patron:sapphire:lane3:1".into()));
        assert_eq!(objective_key(0, 0), None); // the core has no entity
        assert_eq!(objective_key(2, 0), None); // no lane 2 on the current map
    }

    #[test]
    fn events_from_the_metadata() {
        let raw = serde_json::json!({ "match_info": {
            "duration_s": 600, "start_time": 1, "match_id": 5,
            "players": [
                { "player_slot": 1, "team": 0, "hero_id": 7, "death_details": [{ "game_time_s": 30, "death_pos": { "x": 100.4, "y": -50.0, "z": 0.0 }, "killer_player_slot": 2 }, { "game_time_s": 2 }], "stats": [{ "time_stamp_s": 180, "net_worth": 9000 }] },
                { "player_slot": 2, "team": 1, "hero_id": 9, "stats": [{ "time_stamp_s": 180, "net_worth": 1000 }] }
            ],
            "objectives": [{ "team_objective_id": 5, "team": 0, "destroyed_time_s": 300 }],
            "mid_boss": [{ "team_killed": 1, "destroyed_time_s": 400 }],
            "match_paths": { "x_resolution": 100.0, "y_resolution": 100.0, "paths": [
                { "player_slot": 1, "x_min": 0.0, "x_max": 100.0, "y_min": 0.0, "y_max": 100.0, "x_pos": [10.0, 20.0, 30.0], "y_pos": [10.0, 20.0, 30.0], "health": [100.0, 100.0, 100.0] }
            ] }
        }});
        let t = derive(&serde_json::to_vec(&raw).expect("json")).expect("timeline");
        let got: Vec<(u32, &str, Option<i32>)> = t.events.iter().map(|e| (e.t, e.kind.as_str(), e.x)).collect();
        // Second 2 has no place in the data: where the path last saw the hero.
        assert_eq!(got, [(2, "death", Some(30)), (30, "death", Some(100)), (180, "souls_swing", None), (300, "objective", Some(-6272)), (400, "mid_boss", Some(0))]);
        let by = t.events[1].by.as_ref().expect("killer");
        assert_eq!((by.team.as_str(), by.slot, by.hero_id), ("sapphire", 0, 9));
        assert_eq!(t.events[4].team.as_deref(), Some("sapphire"));
        assert_eq!(t.events[3].key.as_deref(), Some("walker:amber:lane1:1"));
    }

    #[test]
    fn deaths_re_anchor_a_drifting_path() {
        // The path runs 5 samples late after second 20: a death at 30 shows at index 36, not 31.
        let mut health = vec![100.0; 80];
        for h in health.iter_mut().take(41).skip(36) {
            *h = 0.0;
        }
        let (map, drift) = anchors(&[30], &health, 70);
        assert!(drift);
        assert_eq!(map[0], 0);
        assert_eq!(map[31], 36); // the death lines up
        assert_eq!(map[60], 65); // and the offset holds after it
        let (_, clean) = anchors(&[35], &health, 70);
        assert!(!clean);
    }
}
