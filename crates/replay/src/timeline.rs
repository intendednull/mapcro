//! The replay timeline: what the worker writes and the server serves (spec §6a).
//!
//! It extends the metadata timeline (`crates/server/src/matches.rs`) field for field, so the
//! client reads both the same way, and adds what only a demo has: ult cooldowns, rifts,
//! powerups, zipline colours and jungle camps. One sample per game second, index = second, `0..=duration_s`.
//!
//! **Personal data:** a player is a team, a slot, a hero and, if the demo carries one, the
//! in-game name. Steam and account ids are never read from the demo, so they can't be written.

use serde::{Deserialize, Serialize};

pub const TIER: &str = "replay";

/// The worker's output format, stamped in every timeline it writes. Bump it when the worker's
/// output gains or changes a layer, so a cached timeline from an older worker can be told apart
/// (docs/backlog.md, "Replay timeline format versions"). 0: written before the stamp.
/// 1: respawn times and the urn (exploration rounds 5 and 6).
pub const FORMAT: u32 = 1;

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
    /// Replay tier: each lane's zipline colours, the game's own (spec §6b, "Lanes").
    #[serde(default)]
    pub zips: Vec<ZipTrack>,
    /// Replay tier: jungle camps and the mid boss, alive or cleared (spec §6b, "Camps").
    #[serde(default)]
    pub camps: Vec<Camp>,
    /// What happened when, for the events list (spec §6a, "Events").
    #[serde(default)]
    pub events: Vec<Event>,
    /// Lane troopers as seen in the recording (replay tier).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub troopers: Option<Troopers>,
    /// Replay tier: objectives' health over time.
    #[serde(default)]
    pub objective_health: Vec<ObjectiveHealth>,
    /// Replay tier: the Soul Urn (exploration round 6). Absent in timelines from before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub urn: Option<Urn>,
    /// [`FORMAT`] of the worker that wrote it; 0 if it predates the stamp.
    #[serde(default)]
    pub format: u32,
}

/// The Soul Urn over the match (exploration round 6): where each one spawned, and its state
/// wherever it changes.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Urn {
    /// Each urn's spawn, in order: the second and the urn site (`urn:` key) it spawned over.
    pub spawns: Vec<UrnSpawn>,
    /// The urn's state from its first spawn, one entry per second it changes (the last state in
    /// that second).
    pub at: Vec<UrnAt>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct UrnSpawn {
    pub t: u32,
    pub key: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct UrnAt {
    pub t: u32,
    /// One of [`URN_STATES`]: on the ground (at `x`, `y`), carried (by `team`, `slot`), or none
    /// in the match (delivered, or not spawned yet).
    pub state: String,
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    /// Carried: the carrier's team. On the ground after a drop: the team that dropped it.
    #[serde(default)]
    pub team: Option<String>,
    /// Carried: the carrier's slot in `team`.
    #[serde(default)]
    pub slot: Option<u32>,
    /// The urn site (`urn:` key) it is to be delivered to, while that point is open.
    #[serde(default)]
    pub delivery: Option<String>,
}

pub const URN_STATES: [&str; 3] = ["ground", "carried", "none"];

/// One objective's health in percent: `[second, pct]` where it changes.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ObjectiveHealth {
    pub key: String,
    pub at: Vec<[u32; 2]>,
    /// Patrons only: `[second, stage]` (1, then 2 in the final phase) where it changes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stage: Vec<[u32; 2]>,
}

/// Every lane trooper alive in the recording, sampled every `every_s` seconds from 0. Sample
/// `k` per team is base64 of little-endian `[id: u16, x: i16, y: i16]` triples (world units,
/// the entity index's low 16 bits for following one trooper between samples). Gaps in the
/// recording are empty samples: nothing is invented.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Troopers {
    pub every_s: u32,
    pub amber: Vec<String>,
    pub sapphire: Vec<String>,
}

/// The most troopers one sample may carry per team.
pub const MAX_TROOPERS: usize = 256;

/// One sample's triples, or `None` if it isn't a well-formed sample.
pub fn decode_troopers(sample: &str) -> Option<Vec<(u16, i16, i16)>> {
    use base64::Engine as _;
    let b = base64::engine::general_purpose::STANDARD.decode(sample).ok()?;
    if b.len() % 6 != 0 || b.len() / 6 > MAX_TROOPERS {
        return None;
    }
    Some(b.chunks_exact(6).map(|c| (u16::from_le_bytes([c[0], c[1]]), i16::from_le_bytes([c[2], c[3]]), i16::from_le_bytes([c[4], c[5]]))).collect())
}

pub fn encode_troopers(list: &[(u16, i16, i16)]) -> String {
    use base64::Engine as _;
    let mut b = Vec::with_capacity(list.len() * 6);
    for (id, x, y) in list {
        b.extend_from_slice(&id.to_le_bytes());
        b.extend_from_slice(&x.to_le_bytes());
        b.extend_from_slice(&y.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(b)
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
    /// `[died_s, back_s]` per death: when the hero respawns (exploration round 5). Absent in
    /// timelines from before it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub respawn: Vec<[u32; 2]>,
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

/// One lane's zipline colours as the game networks them (`CCitadelZipLineNode.m_iTeamNum`,
/// exploration round 4): Amber owns the rope over `[0, amber_t]`, Sapphire over
/// `[sapphire_t, 1000]`, and the gap between is uncoloured. `t` is `Wave.t`'s scale.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ZipTrack {
    /// `lane1`, `lane4` or `lane6`, as `Wave.lane`.
    pub lane: String,
    /// `[second, amber_t, sapphire_t]` from second 0, then wherever either edge moves. Amber's
    /// edge is 0 when it owns no node, Sapphire's 1000.
    pub at: Vec<[u32; 3]>,
}

/// A jungle camp (or the mid boss) from the game rules' respawn timers (exploration round 3):
/// not yet spawned before `first_s`, then alive except while cleared.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Camp {
    /// The camp's (`camp:`) or the mid boss's (`mid_boss:`) site key.
    pub key: String,
    /// The second it first spawns (0: up from the start).
    pub first_s: u32,
    /// `[cleared_s, respawn_s]`, in order. The respawn can fall after the match ends.
    pub cleared: Vec<[u32; 2]>,
}

/// One match event. The metadata timeline (crates/server/src/matches.rs) uses the same shape
/// with what it has: deaths (with killer and place when the match data has them), objectives
/// and mid boss kills. Only a replay has rifts and powerups.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Event {
    /// Game second.
    pub t: u32,
    /// One of [`EVENT_KINDS`].
    pub kind: String,
    /// The team the event belongs to: the hero's, the objective's owner's, the capturing
    /// team's, or the team that gained the souls lead.
    #[serde(default)]
    pub team: Option<String>,
    /// The player (`team`, `slot`), for deaths.
    #[serde(default)]
    pub slot: Option<u32>,
    #[serde(default)]
    pub hero_id: Option<u32>,
    /// Who killed them, when the data says.
    #[serde(default)]
    pub by: Option<Who>,
    /// The board key involved (objective, rift, powerup).
    #[serde(default)]
    pub key: Option<String>,
    /// Where, in world units, when known.
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    /// A size: the souls swing, for `souls_swing`.
    #[serde(default)]
    pub amount: Option<u32>,
    /// The ability's internal name, for `ult` (the game's `ImportantAbilityUsed`).
    #[serde(default)]
    pub ability: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Who {
    pub team: String,
    pub slot: u32,
    pub hero_id: u32,
}

pub const EVENT_KINDS: [&str; 12] = ["death", "objective", "mid_boss", "rift_up", "rift_capture", "powerup_spawn", "powerup_taken", "souls_swing", "ult", "urn_pickup", "urn_drop", "urn_delivered"];

/// An ability's internal name as the timeline keeps it: `[a-z0-9_]`, at most 64.
pub fn plausible_ability(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// A team's souls lead moving by at least this much within [`SWING_WINDOW`] is an event.
pub const SWING_SOULS: i64 = 5000;
pub const SWING_WINDOW: u32 = 60;

/// Big souls swings from players' `[second, net worth]` samples (either tier): when the
/// Amber-minus-Sapphire lead has moved by [`SWING_SOULS`] within the last [`SWING_WINDOW`]
/// seconds, and still has ten seconds on, one event for the team it moved toward, then none for
/// a window.
pub fn souls_swings(players: &[(String, Vec<[u32; 2]>)], duration_s: u32) -> Vec<Event> {
    let worth = |souls: &[[u32; 2]], t: u32| souls.iter().take_while(|s| s[0] <= t).last().map_or(0, |s| i64::from(s[1]));
    let mut times: Vec<u32> = players.iter().flat_map(|(_, s)| s.iter().map(|x| x[0])).filter(|t| *t <= duration_s).collect();
    times.sort_unstable();
    times.dedup();
    let lead = |t: u32| players.iter().map(|(team, s)| if team == "amber" { worth(s, t) } else { -worth(s, t) }).sum::<i64>();
    let mut out = Vec::new();
    let mut quiet_until = 0;
    for &t in &times {
        // The first two minutes are starting souls arriving player by player, not swings.
        if t < quiet_until || t < 2 * SWING_WINDOW {
            continue;
        }
        let then = lead(t.saturating_sub(SWING_WINDOW));
        let moved = lead(t) - then;
        // Players' samples don't all land on the same second: a swing must still be there ten
        // seconds on, so one team's update arriving first isn't a swing.
        let held = lead((t + 10).min(duration_s)) - then;
        if moved.abs() >= SWING_SOULS && held.abs() >= SWING_SOULS && held.signum() == moved.signum() {
            out.push(Event {
                t,
                kind: "souls_swing".into(),
                team: Some(if moved > 0 { "amber" } else { "sapphire" }.into()),
                slot: None,
                hero_id: None,
                by: None,
                key: None,
                x: None,
                y: None,
                amount: Some(moved.unsigned_abs().min(u64::from(u32::MAX)) as u32),
                ability: None,
            });
            quiet_until = t + SWING_WINDOW;
        }
    }
    out
}

/// A bare event of `kind` at `t`; callers fill in the rest.
pub fn event(t: u32, kind: &str) -> Event {
    Event { t, kind: kind.into(), team: None, slot: None, hero_id: None, by: None, key: None, x: None, y: None, amount: None, ability: None }
}

/// What the server accepts from a worker (spec §11, replay limits).
/// A 15-minute match is ~140 KB; a 60-minute one well under 1 MiB. The server parses it inside
/// its 256M budget, so the cap stays small.
pub const MAX_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_DURATION_S: u32 = 4 * 3600;
const MAX_PLAYERS: usize = 16;
const MAX_LIST: usize = 256;
/// In-game names, in characters (Steam allows 32).
pub const MAX_NAME: usize = 32;

/// Characters a name may not carry (security review 2026-11-08, L3): control characters, bidi
/// overrides and isolates (which reorder text around them), and HTML's metacharacters, so the
/// server's output is safe on its own, not only because the client escapes it.
pub fn bad_name_char(c: char) -> bool {
    c.is_control() || matches!(c, '\u{200E}' | '\u{200F}' | '\u{061C}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '<' | '>' | '&' | '"')
}

/// A name as the timeline keeps it: those characters dropped, trimmed, at most [`MAX_NAME`].
pub fn clean_name(raw: &str) -> Option<String> {
    let s: String = raw.chars().filter(|c| !bad_name_char(*c)).collect();
    let s: String = s.trim().chars().take(MAX_NAME).collect();
    (!s.is_empty()).then_some(s)
}
const MAX_EVENTS: usize = 4096;
/// 51 camps and the mid boss on the current map.
const MAX_CAMPS: usize = 64;
/// How far past the end a camp's next spawn may fall (the longest respawn is ~7 minutes).
const MAX_RESPAWN_S: u32 = 3600;

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

/// A player's `[died_s, back_s]` list: in order, each death in the match and its respawn after
/// it, no later than the longest respawn past the end.
pub fn respawns_ok(r: &[[u32; 2]], duration_s: u32) -> bool {
    r.len() <= duration_s as usize + 1
        && r.iter().all(|[a, b]| a < b && *a <= duration_s && *b <= duration_s.saturating_add(MAX_RESPAWN_S))
        && r.windows(2).all(|w| w[0][0] < w[1][0])
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
                && p.name.as_ref().is_none_or(|s| s.chars().count() <= MAX_NAME && !s.chars().any(bad_name_char))
                && respawns_ok(&p.respawn, t.duration_s)
        })
        && t.objectives.len() <= MAX_LIST
        && t.objectives.iter().all(|o| plausible_key(&o.key) && o.kind.len() <= 32 && o.team.len() <= 16 && o.destroyed_s <= t.duration_s)
        && t.mid_boss.len() <= MAX_LIST
        && t.rifts.len() <= MAX_LIST
        && t.rifts.iter().all(|r| plausible_key(&r.key) && r.key.starts_with("rift:") && r.start_s < r.end_s && r.end_s <= n as u32)
        && t.powerups.len() <= 8
        && t.powerups.iter().all(|p| plausible_key(&p.key) && p.key.starts_with("powerup:") && p.available.len() == n && p.available.iter().all(|a| *a <= 1) && ranges_ok(&p.stale, n as u32))
        && t.zips.len() <= 8
        && t.zips.iter().all(|z| {
            plausible_key(&format!("lane:x:{}", z.lane)) && z.at.len() <= n && z.at.windows(2).all(|w| w[0][0] < w[1][0]) && z.at.iter().all(|[s, a, b]| *s <= t.duration_s && a <= b && *b <= 1000)
        })
        && t.camps.len() <= MAX_CAMPS
        && t.camps.iter().all(|c| {
            plausible_key(&c.key)
                && (c.key.starts_with("camp:") || c.key.starts_with("mid_boss:"))
                && c.first_s <= t.duration_s.saturating_add(MAX_RESPAWN_S)
                && c.cleared.len() <= n
                && c.cleared.iter().all(|[a, b]| c.first_s <= *a && a < b && *a <= t.duration_s && *b <= t.duration_s.saturating_add(MAX_RESPAWN_S))
                && c.cleared.windows(2).all(|w| w[0][1] <= w[1][0])
        })
        && t.troopers.as_ref().is_none_or(|tr| {
            let samples = (n as u32).div_ceil(tr.every_s.max(1)) as usize;
            (1..=4).contains(&tr.every_s)
                && tr.amber.len() == samples
                && tr.sapphire.len() == samples
                && tr.amber.iter().chain(&tr.sapphire).all(|x| decode_troopers(x).is_some_and(|v| v.iter().all(|(_, x, y)| x.unsigned_abs() <= 16384 && y.unsigned_abs() <= 16384)))
        })
        && t.objective_health.len() <= 64
        && t.objective_health.iter().all(|o| {
            let rising = |v: &[[u32; 2]]| v.windows(2).all(|w| w[0][0] < w[1][0]);
            plausible_key(&o.key)
                && o.at.len() <= n
                && rising(&o.at)
                && o.at.iter().all(|[s, p]| *s <= t.duration_s && *p <= 100)
                && o.stage.len() <= n
                && rising(&o.stage)
                && o.stage.iter().all(|[s, g]| *s <= t.duration_s && (1..=2).contains(g))
        })
        && t.urn.as_ref().is_none_or(|u| {
            let urn_key = |k: &str| plausible_key(k) && k.starts_with("urn:");
            u.spawns.len() <= MAX_LIST
                && u.spawns.iter().all(|s| s.t <= t.duration_s && urn_key(&s.key))
                && u.spawns.windows(2).all(|w| w[0].t < w[1].t)
                && u.at.len() <= MAX_EVENTS
                && u.at.windows(2).all(|w| w[0].t < w[1].t)
                && u.at.iter().all(|a| {
                    a.t <= t.duration_s
                        && URN_STATES.contains(&a.state.as_str())
                        && a.team.as_deref().is_none_or(|s| s == "amber" || s == "sapphire")
                        && a.slot.is_none_or(|s| s < 8)
                        && a.x.into_iter().chain(a.y).all(|v| v.abs() <= 32768)
                        && a.delivery.as_deref().is_none_or(urn_key)
                })
        })
        && t.events.len() <= MAX_EVENTS
        && t.events.iter().all(|e| {
            let team_ok = |s: &str| s == "amber" || s == "sapphire" || s == "neutral";
            e.t <= t.duration_s
                && EVENT_KINDS.contains(&e.kind.as_str())
                && e.team.as_deref().is_none_or(team_ok)
                && e.slot.is_none_or(|s| s < 8)
                && e.by.as_ref().is_none_or(|b| team_ok(&b.team) && b.slot < 8)
                && e.key.as_deref().is_none_or(plausible_key)
                && e.x.into_iter().chain(e.y).all(|v| v.abs() <= 32768)
                && e.ability.as_deref().is_none_or(plausible_ability)
        });
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
                respawn: vec![[1, 2]],
            }],
            objectives: vec![Objective { key: "walker:amber:lane1:1".into(), kind: "walker".into(), team: "amber".into(), lane: 1, destroyed_s: 2 }],
            mid_boss: vec![],
            reanchored: 0,
            rifts: vec![Rift { key: "rift:neutral:lane6:1".into(), start_s: 1, end_s: 3 }],
            powerups: vec![Powerup { key: "powerup:neutral:lane1:1".into(), available: vec![0, 1, 0], stale: vec![[0, 1]] }],
            zips: vec![ZipTrack { lane: "lane4".into(), at: vec![[0, 425, 574], [2, 500, 520]] }],
            camps: vec![Camp { key: "camp:neutral:lane0:3".into(), first_s: 1, cleared: vec![[1, 2], [2, 400]] }],
            events: vec![Event { team: Some("amber".into()), slot: Some(0), hero_id: Some(1), x: Some(3), y: Some(3), ..event(1, "death") }],
            objective_health: vec![ObjectiveHealth { key: "walker:amber:lane1:1".into(), at: vec![[0, 100], [2, 40]], stage: vec![] }],
            troopers: Some(Troopers { every_s: 1, amber: vec![encode_troopers(&[(7, 100, -200)]), String::new(), String::new()], sapphire: vec![String::new(); 3] }),
            urn: Some(Urn {
                spawns: vec![UrnSpawn { t: 0, key: "urn:neutral:lane1:1".into() }],
                at: vec![
                    UrnAt { t: 0, state: "ground".into(), x: Some(-6584), y: Some(0), team: None, slot: None, delivery: Some("urn:neutral:lane6:1".into()) },
                    UrnAt { t: 1, state: "carried".into(), x: None, y: None, team: Some("amber".into()), slot: Some(0), delivery: Some("urn:neutral:lane6:1".into()) },
                    UrnAt { t: 2, state: "none".into(), x: None, y: None, team: None, slot: None, delivery: None },
                ],
            }),
            format: FORMAT,
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
            Box::new(|t| t.players[0].name = Some("<img src=x>".into())),
            Box::new(|t| t.players[0].name = Some("ab\u{202E}cd".into())),
            Box::new(|t| t.players[0].name = Some("x".repeat(33))),
            Box::new(|t| t.players[0].team = "<b>".into()),
            Box::new(|t| t.objectives[0].key = "walker:amber:lane1:1<script>".into()),
            Box::new(|t| t.objectives[0].destroyed_s = 99),
            Box::new(|t| t.rifts[0].key = "walker:amber:lane1:1".into()),
            Box::new(|t| t.rifts[0].end_s = 9),
            Box::new(|t| t.powerups[0].available[1] = 2),
            Box::new(|t| t.zips[0].at[1] = [2, 500, 1001]),
            Box::new(|t| t.zips[0].at[1] = [2, 600, 520]),
            Box::new(|t| t.zips[0].at[1] = [0, 500, 520]),
            Box::new(|t| t.zips[0].at[1] = [9, 500, 520]),
            Box::new(|t| t.zips[0].lane = "../x".into()),
            Box::new(|t| t.camps[0].key = "walker:amber:lane1:1".into()),
            Box::new(|t| t.camps[0].key = "camp:<b>:lane0:3".into()),
            Box::new(|t| t.camps[0].cleared[0] = [2, 2]),
            Box::new(|t| t.camps[0].cleared[0] = [0, 2]),
            Box::new(|t| t.camps[0].cleared[1] = [9, 400]),
            Box::new(|t| t.camps[0].cleared[1] = [2, 2 + 3600 + 1]),
            Box::new(|t| t.camps[0].cleared = vec![[1, 3], [2, 4]]),
            Box::new(|t| t.camps = vec![t.camps[0].clone(); MAX_CAMPS + 1]),
            Box::new(|t| t.duration_s = MAX_DURATION_S + 1),
            Box::new(|t| t.events[0].kind = "<b>".into()),
            Box::new(|t| t.events[0].t = 9),
            Box::new(|t| t.events[0].team = Some("x".into())),
            Box::new(|t| t.events[0].key = Some("../x".into())),
            Box::new(|t| t.events[0].ability = Some("<b>".into())),
            Box::new(|t| t.objective_health[0].at[1] = [2, 101]),
            Box::new(|t| t.objective_health[0].at[1] = [9, 40]),
            Box::new(|t| t.objective_health[0].key = "x".into()),
            Box::new(|t| t.objective_health[0].at[0] = [2, 50]),
            Box::new(|t| t.objective_health[0].stage = vec![[0, 3]]),
            Box::new(|t| t.troopers.as_mut().map_or((), |x| x.amber.pop().map_or((), |_| ()))),
            Box::new(|t| t.troopers.as_mut().map_or((), |x| x.amber[1] = "not base64!".into())),
            Box::new(|t| t.troopers.as_mut().map_or((), |x| x.amber[1] = encode_troopers(&[(1, 20000, 0)]))),
            Box::new(|t| t.troopers.as_mut().map_or((), |x| x.sapphire[0] = encode_troopers(&vec![(1, 0, 0); MAX_TROOPERS + 1]))),
            Box::new(|t| t.players[0].respawn = vec![[1, 1]]),
            Box::new(|t| t.players[0].respawn = vec![[9, 10]]),
            Box::new(|t| t.players[0].respawn = vec![[1, 2 + 3600 + 1]]),
            Box::new(|t| t.players[0].respawn = vec![[1, 2], [0, 2]]),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.spawns[0].key = "rift:neutral:lane1:1".into())),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.spawns[0].t = 9)),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.at[1].state = "<b>".into())),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.at[1].team = Some("neutral".into()))),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.at[1].slot = Some(8))),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.at[1].t = 0)),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.at[0].x = Some(40000))),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.at[0].delivery = Some("camp:neutral:lane0:3".into()))),
        ];
        for (i, f) in bad.iter().enumerate() {
            let mut t = tiny();
            f(&mut t);
            assert!(validate(&serde_json::to_vec(&t).expect("json")).is_err(), "case {i}");
        }
        assert!(validate(b"{").is_err());
    }

    #[test]
    fn a_timeline_from_before_the_urn_and_respawns_still_loads() {
        let mut v = serde_json::to_value(tiny()).expect("json");
        let o = v.as_object_mut().expect("object");
        o.remove("urn");
        o.remove("format");
        o["players"][0].as_object_mut().expect("player").remove("respawn");
        let t = validate(&serde_json::to_vec(&v).expect("json")).expect("an old timeline loads");
        assert_eq!((t.urn, t.format, t.players[0].respawn.len()), (None, 0, 0));
    }

    #[test]
    fn souls_swings_mark_big_moves_of_the_lead_once_per_window() {
        let p = |team: &str, s: &[[u32; 2]]| (team.to_owned(), s.to_vec());
        // Amber gains 6,000 between 100 and 140 s; Sapphire claws 8,000 back by 400 s.
        let players = [p("amber", &[[0, 0], [100, 1000], [140, 7000], [150, 7500]]), p("sapphire", &[[0, 0], [100, 1000], [380, 3000], [400, 15000]])];
        let got: Vec<(u32, Option<String>, Option<u32>)> = souls_swings(&players, 500).into_iter().map(|e| (e.t, e.team, e.amount)).collect();
        assert_eq!(got, [(140, Some("amber".into()), Some(6000)), (400, Some("sapphire".into()), Some(14000))]);
        // One team's update a few seconds before the other's is no swing.
        let staggered = [p("amber", &[[0, 0], [180, 9000]]), p("sapphire", &[[0, 0], [184, 9000]])];
        assert_eq!(souls_swings(&staggered, 500), []);
    }

    #[test]
    fn names_lose_control_bidi_and_html_characters() {
        assert_eq!(clean_name(" Co\u{202E}a<b>ch&\"\u{7} "), Some("Coabch".into()));
        assert_eq!(clean_name("\u{2066}\u{2069}"), None);
        assert_eq!(clean_name(&"é".repeat(40)).map(|s| s.chars().count()), Some(32));
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
