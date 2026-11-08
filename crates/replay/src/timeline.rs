//! The replay timeline: what the worker writes and the server serves (spec §6a).
//!
//! It extends the metadata timeline (`crates/server/src/matches.rs`) field for field, so the
//! client reads both the same way, and adds what only a demo has: ult cooldowns, rifts,
//! powerups and lane waves. One sample per game second, index = second, `0..=duration_s`.
//!
//! **Personal data:** a player is a team, a slot, a hero and, if the demo carries one, the
//! in-game name. Steam and account ids are never read from the demo, so they can't be written.

use serde::{Deserialize, Serialize};

pub const TIER: &str = "replay";

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Timeline {
    pub match_id: u64,
    /// Unix start time. Demos don't carry one: 0 unless the server knows it from the metadata.
    pub start_time: u64,
    pub duration_s: u32,
    pub source: String,
    /// Always `"replay"`; the metadata timeline has none.
    pub tier: String,
    /// The content build from the demo header (`citadel_v6813` → 6813).
    pub build: u32,
    pub players: Vec<Player>,
    pub objectives: Vec<Objective>,
    pub mid_boss: Vec<MidBoss>,
    /// Always 0: the demo's clock is the game clock (kept for the metadata timeline's shape).
    pub reanchored: u32,
    /// Rift (`rift:` key) up from `start_s` to `end_s` (exclusive). At most one at a time.
    pub rifts: Vec<Rift>,
    pub powerups: Vec<Powerup>,
    pub waves: Vec<WaveTrack>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Player {
    /// "amber" or "sapphire".
    pub team: String,
    /// 0..5 within the team.
    pub slot: u32,
    pub hero_id: u32,
    /// The in-game name the demo carries, if any. Never an id.
    #[serde(default)]
    pub name: Option<String>,
    /// World units at each game second; `null` while dead (the pawn's life state, exactly).
    pub x: Vec<Option<i32>>,
    pub y: Vec<Option<i32>>,
    /// Health percent at each game second.
    pub health: Vec<u8>,
    pub deaths: Vec<u32>,
    /// `[game second, net worth]` whenever it changed, at most once a second.
    pub souls: Vec<[u32; 2]>,
    /// Ult cooldown remaining in percent at each second (0 = ready); `null` while untrained.
    /// Maps to `PlayerState.ult_cooldown`.
    pub ult: Vec<Option<u8>>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Objective {
    pub key: String,
    pub kind: String,
    pub team: String,
    pub lane: u32,
    pub destroyed_s: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct MidBoss {
    pub destroyed_s: u32,
    /// Not in the demo's entities: always "unknown" for the replay tier.
    pub team_killed: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Rift {
    pub key: String,
    pub start_s: u32,
    pub end_s: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Powerup {
    pub key: String,
    /// Per second: 1 available, 0 taken (or not yet spawned).
    pub available: Vec<u8>,
    /// `[from, to)` seconds where the spawner wasn't in the recording and the value is held.
    pub stale: Vec<[u32; 2]>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct WaveTrack {
    /// `lane1`, `lane4` or `lane6`, as `Wave.lane`.
    pub lane: String,
    /// `Wave.t` (0 Amber end … 1000 Sapphire end) at each second; `null` before any trooper.
    pub t: Vec<Option<u16>>,
    /// `[from, to)` seconds with no trooper on the lane in the recording: the value is held.
    pub stale: Vec<[u32; 2]>,
}

/// What the server accepts from a worker (spec §11, replay limits).
pub const MAX_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_DURATION_S: u32 = 4 * 3600;
const MAX_PLAYERS: usize = 16;
const MAX_LIST: usize = 256;
const MAX_NAME: usize = 64;

fn plausible_key(k: &str) -> bool {
    // `kind:team:laneN` with an optional `:index`, as the pack writes it.
    let parts: Vec<&str> = k.split(':').collect();
    (3..=4).contains(&parts.len())
        && k.len() <= 64
        && parts[0].bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        && parts[1].bytes().all(|b| b.is_ascii_lowercase())
        && parts[2].strip_prefix("lane").is_some_and(|n| !n.is_empty() && n.len() <= 2 && n.bytes().all(|b| b.is_ascii_digit()))
        && parts.get(3).is_none_or(|n| !n.is_empty() && n.len() <= 3 && n.bytes().all(|b| b.is_ascii_digit()))
}

fn ranges_ok(r: &[[u32; 2]], n: u32) -> bool {
    r.len() <= 4096 && r.iter().all(|[a, b]| a < b && *b <= n)
}

/// Parse and check a worker's output. Anything outside the shape the worker can produce is
/// refused, so a compromised worker can't hand the server something the client can't draw.
pub fn validate(bytes: &[u8]) -> Result<Timeline, &'static str> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err("too large");
    }
    let t: Timeline = serde_json::from_slice(bytes).map_err(|_| "not a timeline")?;
    let n = t.duration_s as usize + 1;
    let ok = t.tier == TIER
        && t.duration_s <= MAX_DURATION_S
        && t.players.len() <= MAX_PLAYERS
        && t.players.iter().all(|p| {
            (p.team == "amber" || p.team == "sapphire")
                && p.slot < 8
                && p.x.len() == n
                && p.y.len() == n
                && p.health.len() == n
                && p.ult.len() == n
                && p.health.iter().all(|h| *h <= 100)
                && p.ult.iter().all(|u| u.is_none_or(|u| u <= 100))
                && p.x.iter().chain(&p.y).all(|v| v.is_none_or(|v| v.abs() <= 32768))
                && p.deaths.len() <= n
                && p.souls.len() <= n
                && p.name.as_ref().is_none_or(|s| s.chars().count() <= MAX_NAME && !s.chars().any(char::is_control))
        })
        && t.objectives.len() <= MAX_LIST
        && t.objectives.iter().all(|o| plausible_key(&o.key) && o.kind.len() <= 32 && o.team.len() <= 16 && o.destroyed_s <= t.duration_s)
        && t.mid_boss.len() <= MAX_LIST
        && t.rifts.len() <= MAX_LIST
        && t.rifts.iter().all(|r| plausible_key(&r.key) && r.key.starts_with("rift:") && r.start_s < r.end_s && r.end_s <= n as u32)
        && t.powerups.len() <= 8
        && t.powerups.iter().all(|p| plausible_key(&p.key) && p.key.starts_with("powerup:") && p.available.len() == n && p.available.iter().all(|a| *a <= 1) && ranges_ok(&p.stale, n as u32))
        && t.waves.len() <= 8
        && t.waves.iter().all(|w| plausible_key(&format!("lane:x:{}", w.lane)) && w.t.len() == n && w.t.iter().all(|v| v.is_none_or(|v| v <= 1000)) && ranges_ok(&w.stale, n as u32));
    if ok { Ok(t) } else { Err("out of shape") }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn tiny() -> Timeline {
        Timeline {
            match_id: 7,
            start_time: 0,
            duration_s: 2,
            source: "replay".into(),
            tier: TIER.into(),
            build: 6813,
            players: vec![Player {
                team: "amber".into(),
                slot: 0,
                hero_id: 1,
                name: Some("Coach".into()),
                x: vec![Some(1), None, Some(3)],
                y: vec![Some(1), None, Some(3)],
                health: vec![100, 0, 100],
                deaths: vec![1],
                souls: vec![[0, 500]],
                ult: vec![None, Some(50), Some(0)],
            }],
            objectives: vec![Objective { key: "walker:amber:lane1:1".into(), kind: "walker".into(), team: "amber".into(), lane: 1, destroyed_s: 2 }],
            mid_boss: vec![],
            reanchored: 0,
            rifts: vec![Rift { key: "rift:neutral:lane6:1".into(), start_s: 1, end_s: 3 }],
            powerups: vec![Powerup { key: "powerup:neutral:lane1:1".into(), available: vec![0, 1, 0], stale: vec![[0, 1]] }],
            waves: vec![WaveTrack { lane: "lane4".into(), t: vec![None, Some(500), Some(520)], stale: vec![[2, 3]] }],
        }
    }

    #[test]
    fn a_worker_timeline_round_trips() {
        let t = tiny();
        let bytes = serde_json::to_vec(&t).expect("json");
        assert_eq!(validate(&bytes), Ok(t));
    }

    #[test]
    fn out_of_shape_output_is_refused() {
        type Breaks = Vec<Box<dyn Fn(&mut Timeline)>>;
        let bad: Breaks = vec![
            Box::new(|t| t.tier = "metadata".into()),
            Box::new(|t| t.players[0].x.push(Some(1))),
            Box::new(|t| t.players[0].health[0] = 101),
            Box::new(|t| t.players[0].ult[0] = Some(200)),
            Box::new(|t| t.players[0].name = Some("a\u{7}b".into())),
            Box::new(|t| t.players[0].team = "<b>".into()),
            Box::new(|t| t.objectives[0].key = "walker:amber:lane1:1<script>".into()),
            Box::new(|t| t.objectives[0].destroyed_s = 99),
            Box::new(|t| t.rifts[0].key = "walker:amber:lane1:1".into()),
            Box::new(|t| t.rifts[0].end_s = 9),
            Box::new(|t| t.powerups[0].available[1] = 2),
            Box::new(|t| t.waves[0].t[1] = Some(1001)),
            Box::new(|t| t.waves[0].stale = vec![[2, 2]]),
            Box::new(|t| t.waves[0].lane = "../x".into()),
            Box::new(|t| t.duration_s = MAX_DURATION_S + 1),
        ];
        for (i, f) in bad.iter().enumerate() {
            let mut t = tiny();
            f(&mut t);
            assert!(validate(&serde_json::to_vec(&t).expect("json")).is_err(), "case {i}");
        }
        assert!(validate(b"{").is_err());
    }

    #[test]
    fn keys_have_the_pack_shape() {
        for k in ["walker:amber:lane1:1", "base_guardian:sapphire:lane4", "rift:neutral:lane6:1"] {
            assert!(plausible_key(k), "{k}");
        }
        for k in ["walker", "Walker:amber:lane1:1", "walker:amber:lane:1", "walker:amber:lane1:1:2", "a:b:lane1:x"] {
            assert!(!plausible_key(k), "{k}");
        }
    }
}
