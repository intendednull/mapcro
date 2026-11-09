//! Per-second observations of a demo to a [`Timeline`]. Pure: the parser fills [`Obs`], tests
//! build it by hand.
//!
//! The demo only records entities near players (PVS), so absence is "not visible", never
//! "gone": objectives count as destroyed only on a seen positive-to-zero health change, and
//! powerups hold their last seen value and mark the gap stale. Zipline colours and camp timers
//! are networked whatever the players see (exploration rounds 3 and 4).

use crate::map::{self, Map};
use crate::timeline::{Camp, Event, FORMAT, MAX_GIVE_UP_S, MAX_REJUV, MidBoss, Objective, Player, Powerup, PowerupSpawn, REJUV_S, Rejuv, Rift, TIER, Timeline, Urn, UrnAt, UrnSpawn, ZipTrack, event, souls_swings};
#[cfg(test)]
use crate::timeline::decode_troopers;
use std::collections::BTreeMap;

/// Everything sampled at one game second.
#[derive(Default, Clone, Debug)]
pub struct Sample {
    /// The server's game time at the sample (`GameTime_t`, the clock ult cooldowns use).
    pub now: f32,
    pub heroes: Vec<HeroObs>,
    pub objectives: Vec<ObjObs>,
    pub troopers: Vec<TrooperObs>,
    /// The rift spawner's position, if one is in the recording.
    pub rift_spawner: Option<[f32; 2]>,
    /// The cash-in location while a rift's cash-in is live (game rules, world space).
    pub rift_live_at: Option<[f32; 2]>,
    /// While the cash-in is live: the scoring team (≤ 0 contested, 2 Amber, 3 Sapphire).
    pub rift_scoring: i64,
    pub powerups: Vec<PowerupObs>,
    /// Important abilities (ults) cast since the last sample.
    pub abilities: Vec<AbilityObs>,
    /// Each zipline node's `m_iTeamNum` (2 Amber, 3 Sapphire, 0 or 4 neither), in
    /// [`Obs::zip_nodes`] order; empty when the sample has none.
    pub zip_teams: Vec<u8>,
}

/// A zipline node (`CCitadelZipLineNode`): static, so read once.
#[derive(Clone, Debug)]
pub struct ZipNode {
    /// `m_iPrimaryLane`: 1, 4 or 6, our lane keys' numbers.
    pub lane: i64,
    pub pos: [f32; 2],
}

/// One of the game rules' neutral camp timers (`m_vecNeutralCampTimer*`, exploration round 3).
#[derive(Clone, Debug, Default)]
pub struct CampSlot {
    /// World position: the camp's site, to 0.0 units on the current map.
    pub origin: [f32; 2],
    /// `m_vecNeutralCampTimerIsMidBoss`.
    pub mid_boss: bool,
    /// `(game second, m_vecNeutralCampNextSpawnTimes)` whenever the timer changes: −1 alive, T > 0
    /// cleared (or not yet spawned) and up at match-clock T.
    pub changes: Vec<(f32, f32)>,
}

#[derive(Clone, Debug)]
pub struct AbilityObs {
    pub hero_id: u32,
    pub team: i64,
    pub pos: Option<[f32; 2]>,
    pub name: String,
}

#[derive(Clone, Debug, Default)]
pub struct HeroObs {
    /// A stable id for the player within the demo (the controller's entity index).
    pub id: i32,
    /// Demo team: 2 Amber, 3 Sapphire.
    pub team: i64,
    pub hero_id: u32,
    pub name: Option<String>,
    /// Alive by the pawn's life state and health; position only then.
    pub alive: bool,
    pub pos: Option<[f32; 2]>,
    pub health: i64,
    pub max_health: i64,
    pub net_worth: u32,
    pub ult_trained: bool,
    pub ult_start: f32,
    pub ult_end: f32,
    /// The pawn's `m_flRespawnTime` (on [`Sample::now`]'s clock) while dead; 0 when unset
    /// (exploration round 5).
    pub respawn_at: f32,
}

/// The Soul Urn's state where it changes, read every tick (exploration round 6): the urn on the
/// ground is a `CCitadelItemPickupIdol` entity; picked up, the entity goes and the delivery
/// point (`CCitadelIdolReturnTrigger`) takes the carrier's team; delivered, the point closes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UrnObs {
    /// Match-clock seconds.
    pub game: f32,
    /// Where the urn is, while it's on the ground.
    pub ground: Option<[f32; 2]>,
    /// The carrying team (the open delivery point's `m_iTeamNum`: 2 Amber, 3 Sapphire), 0 none.
    pub carrier_team: i64,
    /// The carrier ([`HeroObs::id`]): the carrying team's nearest living hero to where the urn
    /// lay when it was picked up.
    pub carrier: Option<i32>,
    /// The open delivery point (`m_bDisabled` false), where.
    pub delivery: Option<[f32; 2]>,
}

#[derive(Clone, Debug)]
pub struct ObjObs {
    /// Entity index and serial: one lifetime.
    pub ent: (i32, u32),
    /// Our site kind: guardian, walker, base_guardian, patron, mid_boss, shrine.
    pub kind: &'static str,
    pub pos: [f32; 2],
    pub health: i64,
    /// 0 when the recording doesn't say (no health bar then).
    pub max_health: i64,
    /// The patron's `m_ePhase` (0 shielded, 2 transforming, 1 final); 0 for the rest.
    pub phase: i64,
}

#[derive(Clone, Debug)]
pub struct TrooperObs {
    /// The trooper's entity index: the same trooper across samples, for the dots' motion.
    pub id: i32,
    pub team: i64,
    /// The trooper's `m_iLane` (1, 4, 6 on the current map: our lane keys' numbers).
    pub lane: i64,
    pub pos: [f32; 2],
}

/// A bridge powerup's pickup (`CCitadel_Pickup_Modifier` at a powerup site) where it changes, read
/// every tick (exploration round 7): one entity per site, re-armed with a new `m_nSubclassID` (the
/// buff) and `m_bActive` true at each spawn, inactive once taken. Some are up for a fifth of a
/// second, so 1 Hz samples miss them.
#[derive(Clone, Debug, PartialEq)]
pub struct BuffObs {
    /// Match-clock seconds.
    pub game: f32,
    pub pos: [f32; 2],
    pub active: bool,
    /// One of [`crate::timeline::BUFFS`].
    pub buff: &'static str,
}

/// A `RejuvStatus` message (timers audit, gap 1): a team's Rejuvenator shard picked up (one per
/// shard), a revive used, or the Rejuvenator expired.
#[derive(Clone, Debug, PartialEq)]
pub struct RejuvObs {
    /// Match-clock seconds.
    pub game: f32,
    pub what: RejuvWhat,
    /// 2 Amber, 3 Sapphire (`user_team`).
    pub team: i64,
    /// The player it's about ([`HeroObs::id`]), from the message's pawn, when it resolves.
    pub player: Option<i32>,
}

/// `RejuvStatus.event_type`: 4, 5 and 6 (exploration on 129738985).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RejuvWhat {
    Taken,
    Revive,
    Expired,
}

/// The game rules' Rejuvenator charges where either changes (`m_iAmberRejuvCount`,
/// `m_iSapphireRejuvCount`), read every tick.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RejuvCount {
    pub game: f32,
    pub amber: i64,
    pub sapphire: i64,
}

/// The open rift's capture state, sampled every [`crate::timeline::CAPTURE_EVERY_DS`] tenths of a second while its
/// cash-in is open (`m_vecTeamKothStates[]`: 0 Amber, 1 Sapphire, checked against the capturing
/// team on all five of 129738985's rifts).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KothObs {
    /// Match-clock seconds, on the sampling grid.
    pub game: f32,
    /// Capture progress, 0 to 1.
    pub amber: f32,
    pub sapphire: f32,
    /// `m_timeKothGiveUp` on the match clock; `None` while it's unset (FLT_MAX, or 0).
    pub give_up: Option<f32>,
}

#[derive(Clone, Debug)]
pub struct PowerupObs {
    pub pos: [f32; 2],
    pub active: bool,
}

#[derive(Default)]
pub struct Obs {
    pub match_id: u64,
    pub build: u32,
    /// The game rules' `m_eGameMode`, the last non-zero value seen (0: never set).
    pub game_mode: i64,
    /// The winning team (2 Amber, 3 Sapphire), 0 if the recording ends first.
    pub winner: i64,
    /// Index = game second, from 0.
    pub seconds: Vec<Sample>,
    pub zip_nodes: Vec<ZipNode>,
    pub camp_slots: Vec<CampSlot>,
    /// The urn's changes, in order.
    pub urn: Vec<UrnObs>,
    /// The bridge powerups' pickups where they change, in order (empty: the 1 Hz spawner
    /// samples alone, as before format 2).
    pub buffs: Vec<BuffObs>,
    /// `RejuvStatus` messages, in order.
    pub rejuv: Vec<RejuvObs>,
    /// The Rejuvenator charges where they change, in order.
    pub rejuv_counts: Vec<RejuvCount>,
    /// The open rift's capture state on its sampling grid, in order.
    pub koth: Vec<KothObs>,
}

/// How far (world units) a demo entity may be from our site to take its key. Current-map
/// demos land at 0 (exploration §8); the old map's patrons and shrines are ~1280 off.
const SITE_MATCH: f64 = 400.0;
/// A zipline node further than this from its lane (map units) isn't on it. Current-map nodes
/// sit at 0.0 (exploration round 4).
const ZIP_MATCH: f64 = 5.0;
/// How far (world units) a camp timer's origin may be from our camp site. They match at 0.0;
/// some sites are only ~550 apart.
const CAMP_MATCH: f64 = 64.0;
/// How far (world units) an urn spawn or delivery point may be from our urn site. The return
/// triggers sit on them exactly; the urn spawns 11 units off (exploration round 6).
const URN_MATCH: f64 = 400.0;

fn team_name(t: i64) -> Option<&'static str> {
    match t {
        2 => Some("amber"),
        3 => Some("sapphire"),
        _ => None,
    }
}

fn lane_number(key: &str) -> u32 {
    key.split(':').nth(2).and_then(|l| l.strip_prefix("lane")).and_then(|n| n.parse().ok()).unwrap_or(0)
}

/// A death undone in place: back alive within [`REVIVE_S`] seconds, within [`REVIVE_MATCH`] world
/// units of where the hero fell. On 129738985 four "deaths" are 3 s gaps like this; the
/// metadata doesn't count them, and real respawns take ≥ 10 s and start at the base, ≥ 10,000
/// units away (journal 2026-11-08, lane data).
const REVIVE_S: usize = 5;
const REVIVE_MATCH: f64 = 2500.0;

fn revived(p: &Player, death: u32) -> bool {
    let d = death as usize;
    let fell = (0..d).rev().find_map(|i| p.x[i].zip(p.y[i]));
    let back = (d..p.x.len().min(d + REVIVE_S + 1)).find_map(|i| p.x[i].zip(p.y[i]));
    match (fell, back) {
        (Some(a), Some(b)) => f64::from(a.0 - b.0).hypot(f64::from(a.1 - b.1)) <= REVIVE_MATCH,
        _ => false,
    }
}

/// Ult cooldown remaining, in percent: 0 ready, 100 just used.
pub fn ult_percent(trained: bool, start: f32, end: f32, now: f32) -> Option<u8> {
    if !trained {
        return None;
    }
    if !end.is_finite() || !start.is_finite() || end <= start || end <= now {
        return Some(0);
    }
    let left = ((end - now) / (end - start) * 100.0).ceil();
    Some(left.clamp(1.0, 100.0) as u8)
}

/// `[from, to)` runs of `true`.
fn runs(flags: &[bool]) -> Vec<[u32; 2]> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, &f) in flags.iter().chain(std::iter::once(&false)).enumerate() {
        match (f, start) {
            (true, None) => start = Some(i as u32),
            (false, Some(s)) => {
                out.push([s, i as u32]);
                start = None;
            }
            _ => {}
        }
    }
    out
}

#[derive(Debug, PartialEq)]
pub enum Refused {
    /// Too few of the demo's objectives sit on our map's sites: another map or era.
    OldMap,
    /// No game seconds, or no heroes.
    Empty,
    /// Not the standard 6v6 mode: Street Brawl, or one we don't know (the game rules' value).
    UnsupportedMode(i64),
}

impl Refused {
    /// The job's failure reason (`crate::reason`).
    pub fn reason(&self) -> &'static str {
        match self {
            Refused::OldMap => crate::reason::OLD_MAP,
            Refused::Empty => crate::reason::NOT_A_REPLAY,
            Refused::UnsupportedMode(crate::STREET_BRAWL) => crate::reason::BRAWL,
            Refused::UnsupportedMode(_) => crate::reason::UNSUPPORTED_MODE,
        }
    }
}

pub fn derive(obs: &Obs, m: &Map) -> Result<Timeline, Refused> {
    if obs.game_mode != crate::STANDARD_GAME_MODE {
        return Err(Refused::UnsupportedMode(obs.game_mode));
    }
    let n = obs.seconds.len();
    if n == 0 {
        return Err(Refused::Empty);
    }
    let duration_s = (n - 1) as u32;

    // ---- the map check: the objectives the demo shows alive must sit on our sites ----
    let mut seen: BTreeMap<(i32, u32), (&'static str, [f32; 2])> = BTreeMap::new();
    for s in &obs.seconds {
        for o in s.objectives.iter().filter(|o| o.health > 0) {
            seen.entry(o.ent).or_insert((o.kind, o.pos));
        }
    }
    let on_site = seen.values().filter(|(k, p)| m.nearest(k, p[0] as f64, p[1] as f64, SITE_MATCH).is_some()).count();
    if seen.len() >= 3 && on_site * 2 < seen.len() {
        return Err(Refused::OldMap);
    }

    // ---- players ----
    let mut ids: BTreeMap<i32, i64> = BTreeMap::new();
    for s in &obs.seconds {
        for h in &s.heroes {
            if team_name(h.team).is_some() && h.hero_id != 0 {
                ids.insert(h.id, h.team);
            }
        }
    }
    if ids.is_empty() {
        return Err(Refused::Empty);
    }
    let mut players = Vec::new();
    let mut ids_by_slot: BTreeMap<(String, u32), i32> = BTreeMap::new();
    for team in [2i64, 3] {
        for (slot, (&id, _)) in ids.iter().filter(|(_, t)| **t == team).enumerate() {
            ids_by_slot.insert((team_name(team).unwrap_or("amber").to_owned(), slot as u32), id);
            let mut p = Player {
                team: team_name(team).unwrap_or("amber").to_owned(),
                slot: slot as u32,
                hero_id: 0,
                name: None,
                x: Vec::with_capacity(n),
                y: Vec::with_capacity(n),
                health: Vec::with_capacity(n),
                deaths: Vec::new(),
                souls: Vec::new(),
                ult: Vec::with_capacity(n),
                respawn: Vec::new(),
            };
            // While dead: the second the game says the hero comes back (the pawn's timer).
            let mut due: Vec<Option<f32>> = Vec::with_capacity(n);
            let mut was_alive = None;
            // A cooldown that reads 0/0 is a gap in the recording (it reads so for tens of
            // seconds around full packets, then resumes): hold the last one seen.
            let mut cooldown = (0.0f32, 0.0f32);
            for (sec, s) in obs.seconds.iter().enumerate() {
                let h = s.heroes.iter().find(|h| h.id == id);
                let alive = h.is_some_and(|h| h.alive);
                let pos = h.and_then(|h| h.pos).filter(|_| alive);
                p.x.push(pos.map(|q| q[0].round() as i32));
                p.y.push(pos.map(|q| q[1].round() as i32));
                // Dead (or out of the recording): empty. A dead pawn can keep a stale health.
                p.health.push(h.filter(|h| h.alive).map_or(0, |h| if h.max_health > 0 { (h.health.max(0) * 100 / h.max_health).clamp(0, 100) as u8 } else { 0 }));
                if let Some(h) = h
                    && (h.ult_start != 0.0 || h.ult_end != 0.0)
                {
                    cooldown = (h.ult_start, h.ult_end);
                }
                p.ult.push(h.and_then(|h| ult_percent(h.ult_trained, cooldown.0, cooldown.1, s.now)));
                if let Some(h) = h {
                    if h.hero_id != 0 {
                        p.hero_id = h.hero_id;
                    }
                    if let Some(name) = h.name.as_deref().and_then(crate::timeline::clean_name) {
                        p.name = Some(name);
                    }
                    if p.souls.last().is_none_or(|l| l[1] != h.net_worth) {
                        p.souls.push([sec as u32, h.net_worth]);
                    }
                }
                due.push(h.filter(|h| !h.alive && h.respawn_at > 0.0).map(|h| sec as f32 + (h.respawn_at - s.now)));
                if was_alive == Some(true) && !alive && h.is_some() {
                    p.deaths.push(sec as u32);
                }
                if h.is_some() {
                    was_alive = Some(alive);
                }
            }
            let deaths = std::mem::take(&mut p.deaths);
            p.deaths = deaths.into_iter().filter(|&d| !revived(&p, d)).collect();
            p.respawn = respawns(&p, &due);
            players.push(p);
        }
    }

    // ---- objectives: destroyed on a seen positive-to-zero change that never recovers ----
    // A recording reads a zero health now and then (around full packets), and an entity can be
    // recreated under a new serial: a site is down only if nothing on it is seen alive after.
    struct Life {
        kind: &'static str,
        pos: [f32; 2],
        positive: bool,
        last_positive: u32,
        destroyed: Option<u32>,
    }
    let mut lives: BTreeMap<(i32, u32), Life> = BTreeMap::new();
    for (sec, s) in obs.seconds.iter().enumerate() {
        let sec = sec as u32;
        for o in &s.objectives {
            let l = lives.entry(o.ent).or_insert(Life { kind: o.kind, pos: o.pos, positive: false, last_positive: 0, destroyed: None });
            if o.health > 0 {
                if !l.positive {
                    l.pos = o.pos;
                }
                l.positive = true;
                l.last_positive = sec;
                l.destroyed = None;
            } else if l.positive && l.destroyed.is_none() {
                l.destroyed = Some(sec);
            }
        }
    }
    let mut objectives: Vec<Objective> = Vec::new();
    let mut mid_boss = Vec::new();
    // Per site (or base guardian pair): when it was last seen alive, and when each lifetime fell.
    struct SiteFate {
        kind: &'static str,
        team: String,
        last_alive: u32,
        falls: Vec<Option<u32>>,
    }
    let mut sites: BTreeMap<String, SiteFate> = BTreeMap::new();
    for l in lives.values().filter(|l| l.positive) {
        if l.kind == "mid_boss" {
            if let Some(d) = l.destroyed {
                mid_boss.push(MidBoss { destroyed_s: d, team_killed: "unknown".into() });
            }
            continue;
        }
        let Some(site) = m.nearest(l.kind, l.pos[0] as f64, l.pos[1] as f64, SITE_MATCH) else { continue };
        // Base guardians are one marker per pair: down when every member seen is down.
        let key = if l.kind == "base_guardian" { site.key.rsplit_once(':').map_or(site.key.clone(), |(k, _)| k.to_owned()) } else { site.key.clone() };
        let f = sites.entry(key).or_insert(SiteFate { kind: l.kind, team: site.team.clone(), last_alive: 0, falls: Vec::new() });
        f.last_alive = f.last_alive.max(l.last_positive);
        f.falls.push(l.destroyed);
    }
    for (key, f) in sites {
        // Every lifetime fell, and the last fall came after anything was seen alive here.
        let Some(falls) = f.falls.iter().copied().collect::<Option<Vec<u32>>>() else { continue };
        let Some(&d) = falls.iter().max() else { continue };
        if d <= f.last_alive {
            continue;
        }
        let lane = lane_number(&format!("{key}:"));
        objectives.push(Objective { key, kind: f.kind.to_owned(), team: f.team, lane, destroyed_s: d });
    }
    // The game ends on the loser's patron; the parse stops on the winner's tick, before the
    // patron reads 0 (129738985, journal 2026-11-08).
    if let Some(loser) = team_name(5 - obs.winner).filter(|_| matches!(obs.winner, 2 | 3)) {
        for site in m.sites.iter().filter(|s| s.kind == "patron" && s.team == loser) {
            if !objectives.iter().any(|o| o.key == site.key) {
                let lane = lane_number(&format!("{}:", site.key));
                objectives.push(Objective { key: site.key.clone(), kind: "patron".into(), team: loser.to_owned(), lane, destroyed_s: duration_s });
            }
        }
    }
    objectives.sort_by(|a, b| (a.destroyed_s, &a.key).cmp(&(b.destroyed_s, &b.key)));
    mid_boss.sort_by_key(|b| b.destroyed_s);

    // ---- rifts: the spawner's site, or the live cash-in's ----
    // The spawner appears when the rift is announced; it spawns when the cash-in opens.
    let mut rifts: Vec<Rift> = Vec::new();
    let mut open: Option<(String, u32, Option<u32>)> = None;
    for (sec, s) in obs.seconds.iter().enumerate() {
        let at = s.rift_spawner.or(s.rift_live_at);
        let key = at.and_then(|p| m.nearest("rift", p[0] as f64, p[1] as f64, 2000.0)).map(|s| s.key.clone());
        if open.as_ref().map(|o| &o.0) != key.as_ref() {
            if let Some((k, start, live)) = open.take() {
                rifts.push(Rift { key: k, start_s: start, end_s: sec as u32, live_s: live, give_up_s: None, capture: Vec::new() });
            }
            open = key.map(|k| (k, sec as u32, None));
        }
        if let Some(o) = open.as_mut().filter(|o| o.2.is_none() && s.rift_live_at.is_some()) {
            o.2 = Some(sec as u32);
        }
    }
    if let Some((k, start, live)) = open {
        rifts.push(Rift { key: k, start_s: start, end_s: n as u32, live_s: live, give_up_s: None, capture: Vec::new() });
    }
    for r in &mut rifts {
        rift_capture(obs, r);
    }

    // ---- powerups: per site, held through gaps ----
    let mut powerups = Vec::new();
    for key in m.keys_of("powerup") {
        let mut available = Vec::with_capacity(n);
        let mut stale = Vec::with_capacity(n);
        let mut last = 0u8;
        for s in &obs.seconds {
            let here = s.powerups.iter().find(|p| m.nearest("powerup", p.pos[0] as f64, p.pos[1] as f64, 600.0).is_some_and(|q| q.key == key));
            match here {
                Some(p) => {
                    last = u8::from(p.active);
                    stale.push(false);
                }
                None => stale.push(true),
            }
            available.push(last);
        }
        let spawns = powerup_spawns(obs, m, key, duration_s);
        if !spawns.is_empty() {
            // The tick-exact pickups say when it was up; a spawn taken within its second still
            // shows for that second.
            for (sec, a) in available.iter_mut().enumerate() {
                let sec = sec as u32;
                *a = u8::from(spawns.iter().any(|p| p.t <= sec && sec < p.taken_s.map_or(u32::MAX, |x| x.max(p.t + 1))));
            }
        }
        powerups.push(Powerup { key: key.to_owned(), available, stale: runs(&stale), spawns });
    }

    let zips = zips(obs, m);
    let camps = camps(obs, m);

    let events = events(obs, m, &players, &objectives, &mid_boss, &rifts, &powerups, duration_s);
    let objective_health = objective_health(obs, m);
    let troopers = Some(troopers_at(obs, TROOPER_EVERY_S));
    let carriers: BTreeMap<i32, (String, u32, u32)> = players.iter().filter_map(|p| Some((*ids_by_slot.get(&(p.team.clone(), p.slot))?, (p.team.clone(), p.slot, p.hero_id)))).collect();
    let (urn, urn_events) = urn(obs, m, &carriers, duration_s);
    let mut events = events;
    events.extend(urn_events);
    let (rejuv, rejuv_events) = rejuvs(obs, m, &players, &carriers, duration_s);
    events.extend(rejuv_events);
    events.sort_by(|a, b| (a.t, &a.kind).cmp(&(b.t, &b.kind)));
    Ok(Timeline {
        match_id: obs.match_id,
        start_time: 0,
        duration_s,
        source: "replay".into(),
        tier: TIER.into(),
        build: obs.build,
        players,
        objectives,
        mid_boss,
        reanchored: 0,
        rifts,
        powerups,
        zips,
        camps,
        events,
        troopers,
        objective_health,
        urn,
        rejuv,
        format: FORMAT,
    })
}

/// A rift's give-up deadline and capture progress from the samples taken while its cash-in was
/// open (timers audit, gap 2). The deadline is the last one set in that time (it moves when the
/// cash-in restarts, as 129738985's third and fifth did).
fn rift_capture(obs: &Obs, r: &mut Rift) {
    let Some(live) = r.live_s else { return };
    // From the second before: the cash-in opens part-way into `live_s - 1`.
    let (from, to) = (live.saturating_sub(1).max(r.start_s) * 10, r.end_s * 10);
    let pct = |v: f32| (v.clamp(0.0, 1.0) * 100.0).round() as u32;
    let mut rows: Vec<[u32; 3]> = Vec::new();
    for k in &obs.koth {
        let ds = (f64::from(k.game) * 10.0).round().max(0.0) as u32;
        if ds < from || ds > to {
            continue;
        }
        if let Some(g) = k.give_up.filter(|g| *g >= live as f32) {
            r.give_up_s = Some((g.round() as u32).min(live + MAX_GIVE_UP_S));
        }
        let row = [ds, pct(k.amber), pct(k.sapphire)];
        if rows.last().is_some_and(|l| l[0] >= ds) {
            continue;
        }
        // The middle of a run of equal values says nothing the run's ends don't.
        let n = rows.len();
        if n >= 2 && rows[n - 1][1..] == row[1..] && rows[n - 2][1..] == row[1..] {
            rows[n - 1] = row;
        } else {
            rows.push(row);
        }
    }
    r.capture = rows;
}

/// Each Rejuvenator a team held, and its events (timers audit, gap 1), from the game's
/// `RejuvStatus` messages and charges: taken with its first shard, a revive each time one is
/// used, expired when the game says so (else 180 s on, past the recording). Revives left come
/// from the charges, the game's own count.
fn rejuvs(obs: &Obs, m: &Map, players: &[Player], carriers: &BTreeMap<i32, (String, u32, u32)>, duration_s: u32) -> (Vec<Rejuv>, Vec<Event>) {
    let sec = |g: f32| (g.max(0.0) as u32).min(duration_s);
    // Its shards drop where the mid boss fell.
    let mid = m.keys_of("mid_boss").first().map(|k| (*k).to_owned());
    let (mx, my) = mid.as_deref().map_or((None, None), |k| site_xy(m, k));
    let (mut out, mut events) = (Vec::new(), Vec::new());
    for team in [2i64, 3] {
        let Some(name) = team_name(team) else { continue };
        let mut open: Option<Rejuv> = None;
        let close = |r: Rejuv, out: &mut Vec<Rejuv>| {
            let mut r = r;
            r.left = rejuv_left(obs, team, r.taken_s, r.ends_s, duration_s);
            out.push(r);
        };
        for m in obs.rejuv.iter().filter(|m| m.team == team) {
            let t = sec(m.game);
            match m.what {
                RejuvWhat::Taken if open.is_none() => {
                    open = Some(Rejuv { team: name.into(), taken_s: t, ends_s: t + REJUV_S, left: Vec::new() });
                    events.push(Event { team: Some(name.into()), key: mid.clone(), x: mx, y: my, ..event(t, "rejuv_taken") });
                }
                RejuvWhat::Revive if open.is_some() => {
                    let who = m.player.and_then(|id| carriers.get(&id)).filter(|w| w.0 == name);
                    let p = who.and_then(|w| players.iter().find(|p| p.team == w.0 && p.slot == w.1));
                    let at = |v: &[Option<i32>]| v.get(t as usize).copied().flatten().or_else(|| v[..(t as usize).min(v.len())].iter().rev().find_map(|x| *x));
                    events.push(Event {
                        team: Some(name.into()),
                        slot: who.map(|w| w.1),
                        hero_id: who.map(|w| w.2),
                        x: p.and_then(|p| at(&p.x)),
                        y: p.and_then(|p| at(&p.y)),
                        ..event(t, "rejuv_revive")
                    });
                }
                RejuvWhat::Expired => {
                    if let Some(mut r) = open.take() {
                        r.ends_s = t.max(r.taken_s + 1);
                        events.push(Event { team: Some(name.into()), ..event(t, "rejuv_expired") });
                        close(r, &mut out);
                    }
                }
                _ => {}
            }
        }
        if let Some(r) = open {
            close(r, &mut out);
        }
    }
    out.sort_by(|a, b| (a.taken_s, &a.team).cmp(&(b.taken_s, &b.team)));
    (out, events)
}

/// A team's revives left over `[from, to)`, as `[second, n]` where it changes (the last value in
/// each second), starting at `from`.
fn rejuv_left(obs: &Obs, team: i64, from: u32, to: u32, duration_s: u32) -> Vec<[u32; 2]> {
    let of = |c: &RejuvCount| (if team == 2 { c.amber } else { c.sapphire }).clamp(0, i64::from(MAX_REJUV)) as u32;
    let mut out: Vec<[u32; 2]> = Vec::new();
    let mut now = obs.rejuv_counts.iter().take_while(|c| (c.game.max(0.0) as u32) < from).last().map_or(0, of);
    out.push([from, now]);
    for c in obs.rejuv_counts.iter().filter(|c| {
        let s = c.game.max(0.0) as u32;
        from <= s && s < to && s <= duration_s
    }) {
        let (s, n) = (c.game.max(0.0) as u32, of(c));
        if n == now {
            continue;
        }
        now = n;
        match out.last_mut() {
            Some(l) if l[0] == s => l[1] = n,
            _ => out.push([s, n]),
        }
    }
    // A second whose last value is the one before it says nothing.
    out.dedup_by(|b, a| a[1] == b[1]);
    out
}

/// A powerup site's spawns from its pickup's tick-exact changes (exploration round 7): it turning
/// active is a spawn, with the buff it was armed with; turning inactive is the pick-up.
fn powerup_spawns(obs: &Obs, m: &Map, key: &str, duration_s: u32) -> Vec<PowerupSpawn> {
    let mut out: Vec<PowerupSpawn> = Vec::new();
    let mut up = false;
    for b in obs.buffs.iter().filter(|b| m.nearest("powerup", f64::from(b.pos[0]), f64::from(b.pos[1]), 600.0).is_some_and(|q| q.key == key)) {
        let t = (b.game.max(0.0) as u32).min(duration_s);
        if b.active && !up {
            if out.last().is_some_and(|l| l.t >= t) {
                out.pop();
            }
            out.push(PowerupSpawn { t, buff: b.buff.to_owned(), taken_s: None });
        } else if !b.active && up {
            if let Some(l) = out.last_mut() {
                l.taken_s = Some(t);
            }
        }
        up = b.active;
    }
    out
}

/// `[died_s, back_s]` for each death: the second the hero is next seen alive, else, when the
/// recording ends first, the pawn's own respawn timer as last seen while dead. The two agree
/// to 0.1 s on 129738985, except twice when the game cut the wait short (exploration round 5).
fn respawns(p: &Player, due: &[Option<f32>]) -> Vec<[u32; 2]> {
    let mut out = Vec::new();
    for &d in &p.deaths {
        let i = d as usize;
        let seen = (i..p.x.len()).find(|&j| p.x[j].is_some()).map(|j| j as u32);
        let timer = due[i.min(due.len())..].iter().take_while(|v| v.is_some()).flatten().last().map(|v| v.ceil().max(0.0) as u32);
        if let Some(back) = seen.or(timer).filter(|b| *b > d) {
            out.push([d, back]);
        }
    }
    out
}

/// The urn's spawns, states and events (exploration round 6) from its tick-exact changes:
/// nothing → on the ground with no delivery point open is a spawn; on the ground → carried a
/// pickup; carried → on the ground a drop; carried → nothing as the point closes a delivery.
fn urn(obs: &Obs, m: &Map, carriers: &BTreeMap<i32, (String, u32, u32)>, duration_s: u32) -> (Option<Urn>, Vec<Event>) {
    if obs.urn.is_empty() {
        return (None, Vec::new());
    }
    let site = |p: [f32; 2]| m.nearest("urn", f64::from(p[0]), f64::from(p[1]), URN_MATCH).map(|s| s.key.clone());
    let xy = |p: Option<[f32; 2]>| (p.map(|q| q[0].round() as i32), p.map(|q| q[1].round() as i32));
    let who = |c: &UrnObs| c.carrier.and_then(|id| carriers.get(&id)).filter(|w| team_name(c.carrier_team) == Some(w.0.as_str()));
    let state = |c: &UrnObs| if c.ground.is_some() { "ground" } else if team_name(c.carrier_team).is_some() { "carried" } else { "none" };
    let (mut spawns, mut at, mut events) = (Vec::<UrnSpawn>::new(), Vec::<UrnAt>::new(), Vec::new());
    let mut prev = UrnObs::default();
    for c in &obs.urn {
        let t = (c.game.max(0.0) as u32).min(duration_s);
        let (was, now) = (state(&prev), state(c));
        let holder = who(&prev);
        let team_of = |w: Option<&(String, u32, u32)>, team: i64| w.map(|w| w.0.clone()).or(team_name(team).map(str::to_owned));
        match (was, now) {
            ("none", "ground") if c.delivery.is_none() && prev.delivery.is_none() => {
                if let Some(key) = c.ground.and_then(site)
                    && spawns.last().is_none_or(|l| l.t < t)
                {
                    spawns.push(UrnSpawn { t, key });
                }
            }
            ("ground", "carried") => {
                let w = who(c);
                let (x, y) = xy(prev.ground);
                events.push(Event { team: team_of(w, c.carrier_team), slot: w.map(|w| w.1), hero_id: w.map(|w| w.2), x, y, ..event(t, "urn_pickup") });
            }
            ("carried", "ground") | ("none", "ground") => {
                let (x, y) = xy(c.ground);
                events.push(Event { team: team_of(holder, prev.carrier_team), slot: holder.map(|w| w.1), hero_id: holder.map(|w| w.2), x, y, ..event(t, "urn_drop") });
            }
            ("carried", "none") if prev.delivery.is_some() && c.delivery.is_none() => {
                let key = prev.delivery.and_then(site);
                let (x, y) = key.as_deref().map_or((None, None), |k| site_xy(m, k));
                events.push(Event { team: team_of(holder, prev.carrier_team), slot: holder.map(|w| w.1), hero_id: holder.map(|w| w.2), key, x, y, ..event(t, "urn_delivered") });
            }
            _ => {}
        }
        let w = who(c);
        let (x, y) = xy(c.ground);
        let entry = UrnAt {
            t,
            state: now.to_owned(),
            x,
            y,
            // Carried: the carrier's team; on the ground after a drop, the dropper's.
            team: if now == "carried" { team_of(w, c.carrier_team) } else if now == "ground" && c.delivery.is_some() { team_of(holder, prev.carrier_team).or(at.last().and_then(|l| l.team.clone())) } else { None },
            slot: if now == "carried" { w.map(|w| w.1) } else { None },
            delivery: c.delivery.and_then(site),
        };
        // One entry per second: the last state in it.
        if at.last().is_some_and(|l| l.t == t) {
            at.pop();
        }
        if at.last().is_none_or(|l| (&l.state, l.x, l.y, &l.team, l.slot, &l.delivery) != (&entry.state, entry.x, entry.y, &entry.team, entry.slot, &entry.delivery)) {
            at.push(entry);
        }
        prev = c.clone();
    }
    // Nothing before the first spawn: the urn starts as "none".
    let first = at.iter().position(|a| a.state != "none").unwrap_or(at.len());
    at.drain(..first);
    if spawns.is_empty() && at.is_empty() {
        return (None, events);
    }
    (Some(Urn { spawns, at }), events)
}

/// Each lane's zipline colours (exploration round 4): every node's `t` along our lane, then each
/// second Amber's edge, the furthest Amber node (0 if none), and Sapphire's, the nearest Sapphire
/// node (1000 if none), written where either moves. The colours are always one run per team
/// along a lane; were they ever to cross, both edges meet at their midpoint.
fn zips(obs: &Obs, m: &Map) -> Vec<ZipTrack> {
    let placed: Vec<Option<(usize, u16)>> = obs
        .zip_nodes
        .iter()
        .map(|z| {
            let key = format!("lane{}", z.lane);
            let li = m.lanes.iter().position(|l| l.key == key)?;
            let (t, d) = m.lanes[li].project(map::world_to_map(f64::from(z.pos[0]), f64::from(z.pos[1])));
            (d <= ZIP_MATCH).then_some((li, t))
        })
        .collect();
    let mut out = Vec::new();
    for (li, lane) in m.lanes.iter().enumerate() {
        if !placed.iter().flatten().any(|(l, _)| *l == li) {
            continue;
        }
        let mut at: Vec<[u32; 3]> = Vec::new();
        for (sec, s) in obs.seconds.iter().enumerate() {
            if s.zip_teams.len() != placed.len() {
                continue;
            }
            let (mut amber, mut sapphire) = (0u32, 1000u32);
            for (node, team) in placed.iter().zip(&s.zip_teams) {
                let Some((l, t)) = node else { continue };
                if *l != li {
                    continue;
                }
                match team {
                    2 => amber = amber.max(u32::from(*t)),
                    3 => sapphire = sapphire.min(u32::from(*t)),
                    _ => {}
                }
            }
            if amber > sapphire {
                let mid = (amber + sapphire) / 2;
                (amber, sapphire) = (mid, mid);
            }
            if at.last().is_none_or(|l| l[1] != amber || l[2] != sapphire) {
                at.push([sec as u32, amber, sapphire]);
            }
        }
        if !at.is_empty() {
            out.push(ZipTrack { lane: lane.key.to_owned(), at });
        }
    }
    out.sort_by(|a, b| a.lane.cmp(&b.lane));
    out
}

/// Camps and the mid boss from the game rules' timers (exploration round 3), each matched to our
/// site by its origin, never by its slot. A timer reads −1 while the camp is up and T > 0 while
/// it waits to (re)spawn at match-clock T; 0 means nothing.
fn camps(obs: &Obs, m: &Map) -> Vec<Camp> {
    let mut out: Vec<Camp> = Vec::new();
    let sec = |v: f32| v.max(0.0).round() as u32;
    for slot in &obs.camp_slots {
        let kind = if slot.mid_boss { "mid_boss" } else { "camp" };
        let Some(site) = m.nearest(kind, f64::from(slot.origin[0]), f64::from(slot.origin[1]), CAMP_MATCH) else { continue };
        if out.iter().any(|c| c.key == site.key) {
            continue;
        }
        let (mut first, mut due, mut alive, mut since) = (None::<u32>, None::<u32>, false, 0.0f32);
        let mut cleared: Vec<[u32; 2]> = Vec::new();
        for &(g, v) in &slot.changes {
            if v < 0.0 {
                if !alive {
                    since = g;
                }
                if first.is_none() {
                    // The spawn time it was waiting for, else when it was first seen up.
                    first = Some(due.unwrap_or(sec(g)).min(sec(g)));
                }
                alive = true;
            } else if v > 0.0 {
                if alive && g - since < 1.0 && cleared.is_empty() {
                    // Every timer reads −1 for the first tick of the recording, then its first
                    // spawn time: no camp is up and cleared within a second.
                    (first, alive) = (None, false);
                }
                if first.is_none() {
                    due = Some(sec(v));
                } else if alive {
                    let at = sec(g).max(first.unwrap_or(0));
                    // Seconds are rounded: a respawn and the next clear can share one.
                    if let Some(l) = cleared.last_mut() {
                        l[1] = l[1].min(at).max(l[0] + 1);
                    }
                    if cleared.last().is_none_or(|l| l[1] <= at) {
                        cleared.push([at, sec(v).max(at + 1)]);
                    }
                    alive = false;
                } else if let Some(l) = cleared.last_mut() {
                    // Still down, and its respawn moved.
                    l[1] = sec(v).max(l[0] + 1);
                }
            }
        }
        // A camp that never came up in the recording still says when it would.
        let Some(first_s) = first.or(due) else { continue };
        out.push(Camp { key: site.key.clone(), first_s, cleared });
    }
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

/// Each objective's health in percent, by board key, as `[second, pct]` whenever it moves by
/// a point or more (and when it's first seen). Seconds out of the recording hold. A base
/// guardian pair is the mean of the members seen. The patron also gets its stage (1, then 2 in
/// its final phase) where it changes.
fn objective_health(obs: &Obs, m: &Map) -> Vec<crate::timeline::ObjectiveHealth> {
    let mut tracks: BTreeMap<String, Vec<[u32; 2]>> = BTreeMap::new();
    let mut stages: BTreeMap<String, Vec<[u32; 2]>> = BTreeMap::new();
    for (sec, s) in obs.seconds.iter().enumerate() {
        let mut now: BTreeMap<String, (i64, i64)> = BTreeMap::new();
        for o in s.objectives.iter().filter(|o| o.max_health > 0) {
            let key = if o.kind == "mid_boss" {
                m.keys_of("mid_boss").first().map(|k| (*k).to_owned())
            } else {
                m.nearest(o.kind, f64::from(o.pos[0]), f64::from(o.pos[1]), SITE_MATCH).map(|site| {
                    if o.kind == "base_guardian" { site.key.rsplit_once(':').map_or(site.key.clone(), |(k, _)| k.to_owned()) } else { site.key.clone() }
                })
            };
            let Some(key) = key else { continue };
            if o.kind == "patron" {
                let stage = if o.phase == 1 { 2 } else { 1 };
                let track = stages.entry(key.clone()).or_default();
                if track.last().is_none_or(|l| l[1] != stage) {
                    track.push([sec as u32, stage]);
                }
            }
            let e = now.entry(key).or_insert((0, 0));
            e.0 += o.health.clamp(0, o.max_health);
            e.1 += o.max_health;
        }
        for (key, (h, max)) in now {
            let pct = (h * 100 / max.max(1)).clamp(0, 100) as u32;
            let track = tracks.entry(key).or_default();
            if track.last().is_none_or(|l| l[1] != pct) {
                track.push([sec as u32, pct]);
            }
        }
    }
    tracks.into_iter().map(|(key, at)| crate::timeline::ObjectiveHealth { stage: stages.remove(&key).unwrap_or_default(), key, at }).collect()
}

/// How often the trooper dots are sampled: 1 Hz (the 15-minute match's are ~100 KB of JSON).
pub const TROOPER_EVERY_S: usize = 1;

/// The lane troopers in the recording every `every` seconds, per team (timeline.rs `Troopers`).
pub fn troopers_at(obs: &Obs, every: usize) -> crate::timeline::Troopers {
    use crate::timeline::{MAX_TROOPERS, encode_troopers};
    let q = |v: f32| v.round().clamp(-16384.0, 16384.0) as i16;
    let pack = |team: i64, s: &Sample| {
        let list: Vec<(u16, i16, i16)> = s.troopers.iter().filter(|t| t.team == team).take(MAX_TROOPERS).map(|t| (t.id as u16, q(t.pos[0]), q(t.pos[1]))).collect();
        encode_troopers(&list)
    };
    let picked: Vec<&Sample> = obs.seconds.iter().step_by(every.max(1)).collect();
    crate::timeline::Troopers { every_s: every.max(1) as u32, amber: picked.iter().map(|s| pack(2, s)).collect(), sapphire: picked.iter().map(|s| pack(3, s)).collect() }
}

fn site_xy(m: &Map, key: &str) -> (Option<i32>, Option<i32>) {
    // Base guardian pairs are keyed without an index: their first member's site will do.
    m.sites
        .iter()
        .find(|s| s.key == key || s.key.strip_suffix(":1") == Some(key))
        .filter(|s| s.world.len() >= 2)
        .map_or((None, None), |s| (Some(s.world[0].round() as i32), Some(s.world[1].round() as i32)))
}

/// The events list (spec §6a): deaths where the hero last stood, objectives and the mid boss
/// at their sites, rifts coming up and being captured, powerups spawning and taken (only on
/// seconds the spawner is in the recording), and big souls swings.
#[allow(clippy::too_many_arguments)]
fn events(obs: &Obs, m: &Map, players: &[Player], objectives: &[Objective], mid_boss: &[MidBoss], rifts: &[Rift], powerups: &[Powerup], duration_s: u32) -> Vec<Event> {
    let mut out = Vec::new();
    for p in players {
        for &d in &p.deaths {
            let i = (d as usize).saturating_sub(1);
            out.push(Event { team: Some(p.team.clone()), slot: Some(p.slot), hero_id: Some(p.hero_id), x: p.x.get(i).copied().flatten(), y: p.y.get(i).copied().flatten(), ..event(d, "death") });
        }
    }
    for o in objectives {
        let (x, y) = site_xy(m, &o.key);
        out.push(Event { team: Some(o.team.clone()), key: Some(o.key.clone()), x, y, ..event(o.destroyed_s, "objective") });
    }
    let mid = m.keys_of("mid_boss").first().map(|k| (*k).to_owned());
    for b in mid_boss {
        let (x, y) = mid.as_deref().map_or((None, None), |k| site_xy(m, k));
        out.push(Event { key: mid.clone(), x, y, ..event(b.destroyed_s, "mid_boss") });
    }
    for r in rifts {
        let (x, y) = site_xy(m, &r.key);
        out.push(Event { key: Some(r.key.clone()), x, y, ..event(r.start_s, "rift_up") });
    }
    let mut held = 0i64;
    for (sec, s) in obs.seconds.iter().enumerate() {
        let scoring = if s.rift_live_at.is_some() { s.rift_scoring } else { 0 };
        if scoring > 0 && held <= 0 {
            let key = s.rift_live_at.and_then(|p| m.nearest("rift", f64::from(p[0]), f64::from(p[1]), 2000.0)).map(|q| q.key.clone());
            let (x, y) = key.as_deref().map_or((None, None), |k| site_xy(m, k));
            out.push(Event { team: team_name(scoring).map(str::to_owned), key, x, y, ..event(sec as u32, "rift_capture") });
        }
        held = scoring;
    }
    for p in powerups.iter().filter(|p| !p.spawns.is_empty()) {
        let (x, y) = site_xy(m, &p.key);
        for sp in &p.spawns {
            let buff = Some(sp.buff.clone());
            out.push(Event { key: Some(p.key.clone()), x, y, buff: buff.clone(), ..event(sp.t, "powerup_spawn") });
            if let Some(t) = sp.taken_s {
                out.push(Event { key: Some(p.key.clone()), x, y, buff, ..event(t, "powerup_taken") });
            }
        }
    }
    for p in powerups.iter().filter(|p| p.spawns.is_empty()) {
        let seen = |i: usize| !p.stale.iter().any(|[a, b]| (*a as usize) <= i && i < (*b as usize));
        let (x, y) = site_xy(m, &p.key);
        for i in 1..p.available.len() {
            if p.available[i] != p.available[i - 1] && seen(i) && seen(i - 1) {
                let kind = if p.available[i] == 1 { "powerup_spawn" } else { "powerup_taken" };
                out.push(Event { key: Some(p.key.clone()), x, y, ..event(i as u32, kind) });
            }
        }
    }
    // Ult casts: the game's ImportantAbilityUsed messages cover every ability, so a cast counts
    // as the ult when the hero's ult cooldown starts with it (within two seconds); its name
    // comes from the message. A cooldown starting with no message seen is still a cast.
    let casts: Vec<(usize, &AbilityObs)> = obs.seconds.iter().enumerate().flat_map(|(sec, s)| s.abilities.iter().map(move |a| (sec, a))).collect();
    for p in players {
        for sec in 1..p.ult.len() {
            let (before, now) = (p.ult[sec - 1], p.ult[sec]);
            // A rise seen from a known cooldown: a hero reappearing after a gap (or turning
            // up mid-cooldown) isn't a cast (review 2026-11-08, finding 14).
            if !(now.is_some_and(|u| u >= 90) && before.is_some_and(|b| b < 90)) {
                continue;
            }
            // Of the casts in the window, one that names itself the ult ("…_ult…", "…ultimate…")
            // wins; else the latest.
            let cast = casts
                .iter()
                .filter(|(s, a)| a.hero_id == p.hero_id && team_name(a.team) == Some(p.team.as_str()) && *s + 2 >= sec && *s <= sec)
                .min_by_key(|(s, a)| (!a.name.to_ascii_lowercase().contains("ult"), sec - *s));
            let t = cast.map_or(sec, |(s, _)| *s);
            let name = cast.map(|(_, a)| a.name.to_ascii_lowercase().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(64).collect::<String>()).filter(|n| !n.is_empty());
            let pos = cast.and_then(|(_, a)| a.pos);
            out.push(Event {
                team: Some(p.team.clone()),
                slot: Some(p.slot),
                hero_id: Some(p.hero_id),
                x: pos.map(|q| q[0].round() as i32).or(p.x.get(t).copied().flatten()),
                y: pos.map(|q| q[1].round() as i32).or(p.y.get(t).copied().flatten()),
                ability: name,
                ..event(t as u32, "ult")
            });
        }
    }
    let souls: Vec<(String, Vec<[u32; 2]>)> = players.iter().map(|p| (p.team.clone(), p.souls.clone())).collect();
    out.extend(souls_swings(&souls, duration_s));
    out.sort_by(|a, b| (a.t, &a.kind).cmp(&(b.t, &b.kind)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hero(id: i32, team: i64, alive: bool, pos: [f32; 2]) -> HeroObs {
        HeroObs { id, team, hero_id: 10 + id as u32, alive, pos: Some(pos), health: if alive { 500 } else { 0 }, max_health: 1000, net_worth: 100 * id as u32, ..Default::default() }
    }

    fn seconds(n: usize) -> Vec<Sample> {
        (0..n).map(|i| Sample { now: 100.0 + i as f32, ..Default::default() }).collect()
    }

    fn obs(seconds: Vec<Sample>) -> Obs {
        Obs { match_id: 42, build: 6813, game_mode: 1, winner: 0, seconds, ..Default::default() }
    }

    #[test]
    fn only_the_standard_mode_is_read() {
        let mut s = seconds(2);
        s[0].heroes = vec![hero(1, 2, true, [0.0, 0.0])];
        assert!(derive(&obs(s.clone()), map::current()).is_ok());
        // Street Brawl, an unknown mode, and a demo that never set one.
        for mode in [4, 99, 0] {
            let o = Obs { game_mode: mode, ..obs(s.clone()) };
            assert_eq!(derive(&o, map::current()).err(), Some(Refused::UnsupportedMode(mode)), "mode {mode}");
        }
        assert_eq!(Refused::UnsupportedMode(4).reason(), "brawl");
        assert_eq!(Refused::UnsupportedMode(99).reason(), "unsupported_mode");
    }

    #[test]
    fn ult_percent_counts_down_from_a_cast() {
        assert_eq!(ult_percent(false, 0.0, 0.0, 5.0), None);
        assert_eq!(ult_percent(true, 0.0, 0.0, 5.0), Some(0));
        assert_eq!(ult_percent(true, 100.0, 200.0, 100.0), Some(100));
        assert_eq!(ult_percent(true, 100.0, 200.0, 150.0), Some(50));
        assert_eq!(ult_percent(true, 100.0, 200.0, 199.5), Some(1));
        assert_eq!(ult_percent(true, 100.0, 200.0, 200.0), Some(0));
        assert_eq!(ult_percent(true, f32::NAN, 200.0, 150.0), Some(0));
    }

    #[test]
    fn players_by_team_and_slot_with_exact_alive_and_deaths() {
        let mut s = seconds(4);
        for (i, x) in s.iter_mut().enumerate() {
            // Controller 5 is Sapphire; 1 and 3 are Amber, in index order. 3 dies at second 2
            // and is back at the base at 3.
            x.heroes = vec![hero(5, 3, true, [1.0, 2.0]), hero(3, 2, i != 2, if i == 3 { [-9000.0, -9000.0] } else { [100.4, -200.6] }), hero(1, 2, true, [0.0, 0.0])];
            x.heroes[1].name = Some(" Coach\u{7} ".into());
            x.heroes[1].ult_trained = i >= 1;
            // Second 3 reads 0/0, a gap: the cooldown holds.
            x.heroes[1].ult_start = if i == 3 { 0.0 } else { 100.0 };
            x.heroes[1].ult_end = if i == 3 { 0.0 } else { 104.0 };
            x.heroes[1].net_worth = if i < 2 { 300 } else { 900 };
        }
        let t = derive(&obs(s), map::current()).expect("timeline");
        assert_eq!(t.duration_s, 3);
        let slots: Vec<(String, u32, u32)> = t.players.iter().map(|p| (p.team.clone(), p.slot, p.hero_id)).collect();
        assert_eq!(slots, [("amber".into(), 0, 11), ("amber".into(), 1, 13), ("sapphire".into(), 0, 15)]);
        let p = &t.players[1];
        assert_eq!(p.x, [Some(100), Some(100), None, Some(-9000)]);
        assert_eq!(p.y, [Some(-201), Some(-201), None, Some(-9000)]);
        assert_eq!(p.health, [50, 50, 0, 50]);
        assert_eq!(p.deaths, [2]);
        assert_eq!(p.name.as_deref(), Some("Coach"));
        assert_eq!(p.souls, [[0, 300], [2, 900]]);
        // now = 100 + second; cast at 100, ready at 104.
        assert_eq!(p.ult, [None, Some(75), Some(50), Some(25)]);
    }

    #[test]
    fn objectives_fall_only_on_a_seen_change_and_take_our_keys() {
        let mut s = seconds(5);
        let walker = [-6272.0, -4736.0]; // walker:amber:lane1:1
        let guardian = [0.0, 1792.0]; // guardian:sapphire:lane4:1
        for (i, x) in s.iter_mut().enumerate() {
            x.objectives.push(ObjObs { ent: (10, 1), kind: "walker", pos: walker, health: if i < 3 { 100 } else { 0 }, max_health: 100, phase: 0 });
            // Seen only at zero (a PVS gap from the start): never "destroyed".
            x.objectives.push(ObjObs { ent: (11, 1), kind: "guardian", pos: guardian, health: 0, max_health: 100, phase: 0 });
            // Both of Amber's mid base guardians; the pair is down when the second falls.
            x.objectives.push(ObjObs { ent: (20, 1), kind: "base_guardian", pos: [-1280.0, -5456.0], health: if i < 2 { 1 } else { 0 }, max_health: 100, phase: 0 });
            x.objectives.push(ObjObs { ent: (21, 1), kind: "base_guardian", pos: [-1290.0, -5450.0], health: if i < 4 { 1 } else { 0 }, max_health: 100, phase: 0 });
            x.objectives.push(ObjObs { ent: (30, 1), kind: "mid_boss", pos: [0.0, 0.0], health: if i < 1 { 1 } else { 0 }, max_health: 100, phase: 0 });
        }
        s[0].heroes = vec![hero(1, 2, true, [0.0, 0.0])];
        let t = derive(&obs(s), map::current()).expect("timeline");
        let got: Vec<(&str, u32, u32)> = t.objectives.iter().map(|o| (o.key.as_str(), o.lane, o.destroyed_s)).collect();
        assert_eq!(got, [("walker:amber:lane1:1", 1, 3), ("base_guardian:amber:lane4", 4, 4)]);
        assert_eq!(t.mid_boss, [MidBoss { destroyed_s: 1, team_killed: "unknown".into() }]);
    }

    #[test]
    fn a_transient_zero_or_a_new_serial_is_not_a_fall() {
        let mut s = seconds(5);
        let mid = [0.0, -1792.0]; // guardian:amber:lane4:1
        s[0].heroes = vec![hero(1, 2, true, [0.0, 0.0])];
        for (i, x) in s.iter_mut().enumerate() {
            // A zero read at second 1, alive again after (exploration's 122134063, tick 8055).
            x.objectives.push(ObjObs { ent: (10, 1), kind: "guardian", pos: mid, health: if i == 1 { 0 } else { 100 }, max_health: 100, phase: 0 });
        }
        // Amber's west guardian reads zero under one serial, then lives on under another.
        let west = [-8192.0, -1856.0];
        s[1].objectives.push(ObjObs { ent: (11, 1), kind: "guardian", pos: west, health: 50, max_health: 100, phase: 0 });
        s[2].objectives.push(ObjObs { ent: (11, 1), kind: "guardian", pos: west, health: 0, max_health: 100, phase: 0 });
        s[3].objectives.push(ObjObs { ent: (11, 2), kind: "guardian", pos: west, health: 50, max_health: 100, phase: 0 });
        let t = derive(&obs(s), map::current()).expect("timeline");
        assert_eq!(t.objectives, []);
    }

    #[test]
    fn objectives_off_our_sites_mean_another_map() {
        let mut s = seconds(2);
        s[0].heroes = vec![hero(1, 2, true, [0.0, 0.0])];
        // The old map: patrons and shrines ~1280 off (exploration §8).
        for (i, k) in ["patron", "shrine", "shrine", "walker"].iter().enumerate() {
            s[0].objectives.push(ObjObs { ent: (i as i32, 1), kind: k, pos: [3000.0 + i as f32 * 2000.0, 9000.0], health: 10, max_health: 100, phase: 0 });
        }
        assert_eq!(derive(&obs(s), map::current()).err(), Some(Refused::OldMap));
        assert_eq!(derive(&obs(vec![]), map::current()).err(), Some(Refused::Empty));
    }

    #[test]
    fn rifts_follow_the_spawner_then_the_cash_in() {
        let mut s = seconds(6);
        s[1].rift_spawner = Some([7648.0, 0.0]);
        s[2].rift_spawner = Some([7648.0, 0.0]);
        s[3].rift_live_at = Some([7612.0, 0.0]);
        s[5].rift_spawner = Some([-7648.0, 0.0]);
        s[0].heroes = vec![hero(1, 2, true, [0.0, 0.0])];
        let t = derive(&obs(s), map::current()).expect("timeline");
        assert_eq!(
            t.rifts,
            [
                Rift { key: "rift:neutral:lane6:1".into(), start_s: 1, end_s: 4, live_s: Some(3), give_up_s: None, capture: vec![] },
                Rift { key: "rift:neutral:lane1:1".into(), start_s: 5, end_s: 6, live_s: None, give_up_s: None, capture: vec![] }
            ]
        );
    }

    #[test]
    fn powerup_spawns_name_their_buff_and_when_they_were_taken() {
        let mut s = seconds(12);
        s[0].heroes = vec![hero(1, 2, true, [0.0, 0.0])];
        let (west, east) = ([-3936.0, 136.0], [3936.0, -128.0]);
        let b = |game: f32, pos: [f32; 2], active: bool, buff: &'static str| BuffObs { game, pos, active, buff };
        let o = Obs {
            buffs: vec![
                b(2.0, west, true, "survival"),
                b(2.0, east, true, "gun"),
                // Taken a fifth of a second after it spawned: 1 Hz samples never see it up.
                b(2.2, west, false, "survival"),
                b(6.5, east, false, "gun"),
                // Re-armed with the same buff: still a new spawn.
                b(8.0, west, true, "survival"),
                b(8.0, east, true, "movement"),
                b(9.4, west, false, "survival"),
                // Statues' drops elsewhere aren't a site's.
                b(3.0, [-8416.0, 224.0], true, "casting"),
            ],
            ..obs(s)
        };
        let t = derive(&o, map::current()).expect("timeline");
        let site = |k: &str| t.powerups.iter().find(|p| p.key == k).expect("site").clone();
        let sp = |t: u32, buff: &str, taken_s: Option<u32>| PowerupSpawn { t, buff: buff.into(), taken_s };
        let w = site("powerup:neutral:lane1:1");
        assert_eq!(w.spawns, [sp(2, "survival", Some(2)), sp(8, "survival", Some(9))]);
        assert_eq!(w.available, [0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
        let e = site("powerup:neutral:lane6:1");
        assert_eq!(e.spawns, [sp(2, "gun", Some(6)), sp(8, "movement", None)]);
        assert_eq!(e.available, [0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1]);
        let ev: Vec<(u32, &str, Option<&str>)> = t.events.iter().filter(|e| e.kind.starts_with("powerup")).map(|e| (e.t, e.kind.as_str(), e.buff.as_deref())).collect();
        assert_eq!(
            ev,
            [(2, "powerup_spawn", Some("survival")), (2, "powerup_spawn", Some("gun")), (2, "powerup_taken", Some("survival")), (6, "powerup_taken", Some("gun")), (8, "powerup_spawn", Some("survival")), (8, "powerup_spawn", Some("movement")), (9, "powerup_taken", Some("survival"))]
        );
        assert!(crate::timeline::validate(&serde_json::to_vec(&t).expect("json")).is_ok());
    }

    #[test]
    fn powerups_hold_through_gaps_and_say_so() {
        let mut s = seconds(5);
        let west = [-3936.0, 136.0];
        s[0].powerups = vec![PowerupObs { pos: west, active: false }];
        s[1].powerups = vec![PowerupObs { pos: west, active: true }];
        // 2 and 3: not in the recording.
        s[4].powerups = vec![PowerupObs { pos: west, active: false }, PowerupObs { pos: [3936.0, -128.0], active: true }];
        s[0].heroes = vec![hero(1, 2, true, [0.0, 0.0])];
        let t = derive(&obs(s), map::current()).expect("timeline");
        let w = t.powerups.iter().find(|p| p.key == "powerup:neutral:lane1:1").expect("west");
        assert_eq!(w.available, [0, 1, 1, 1, 0]);
        assert_eq!(w.stale, [[2, 4]]);
        let e = t.powerups.iter().find(|p| p.key == "powerup:neutral:lane6:1").expect("east");
        assert_eq!(e.available, [0, 0, 0, 0, 1]);
        assert_eq!(e.stale, [[0, 4]]);
    }

    #[test]
    fn events_cover_deaths_objectives_rifts_and_powerups() {
        let mut s = seconds(6);
        for (i, x) in s.iter_mut().enumerate() {
            x.heroes = vec![hero(1, 2, i != 3, [if i > 3 { -9000.0 } else { 100.0 + i as f32 }, 200.0])];
            x.objectives.push(ObjObs { ent: (10, 1), kind: "walker", pos: [-6272.0, -4736.0], health: if i < 4 { 100 } else { 0 }, max_health: 100, phase: 0 });
            x.powerups.push(PowerupObs { pos: [-3936.0, 136.0], active: (2..4).contains(&i) });
        }
        s[1].rift_spawner = Some([7648.0, 0.0]);
        s[2].rift_live_at = Some([7648.0, 0.0]);
        s[3].rift_live_at = Some([7648.0, 0.0]);
        s[3].rift_scoring = 3;
        let t = derive(&obs(s), map::current()).expect("timeline");
        let got: Vec<(u32, &str, Option<&str>, Option<i32>)> = t.events.iter().map(|e| (e.t, e.kind.as_str(), e.key.as_deref().or(e.team.as_deref()), e.x)).collect();
        assert_eq!(
            got,
            [
                (1, "rift_up", Some("rift:neutral:lane6:1"), Some(7648)),
                (2, "powerup_spawn", Some("powerup:neutral:lane1:1"), Some(-3936)),
                (3, "death", Some("amber"), Some(102)),
                (3, "rift_capture", Some("rift:neutral:lane6:1"), Some(7648)),
                (4, "objective", Some("walker:amber:lane1:1"), Some(-6272)),
                (4, "powerup_taken", Some("powerup:neutral:lane1:1"), Some(-3936)),
            ]
        );
        let capture = t.events.iter().find(|e| e.kind == "rift_capture").expect("capture");
        assert_eq!(capture.team.as_deref(), Some("sapphire"));
        let death = &t.events[2];
        assert_eq!((death.slot, death.hero_id, death.y), (Some(0), Some(11), Some(200)));
    }

    #[test]
    fn zipline_edges_are_the_furthest_node_of_each_team() {
        let m = map::current();
        let mid = m.lanes.iter().find(|l| l.key == "lane4").expect("mid");
        // Four nodes on the mid lane, Amber end first, then one off the lane.
        let r = 10752.0f32;
        let world = |q: map::Pt| [(q.x as f32) / 1000.0 * 2.0 * r - r, r - (q.y as f32) / 1000.0 * 2.0 * r];
        let on: Vec<[f32; 2]> = [40, 48, 52, 60].iter().map(|pc| world(mid.points[mid.points.len() * pc / 100])).collect();
        let t_of = |i: usize| u32::from(mid.project(map::world_to_map(f64::from(on[i][0]), f64::from(on[i][1]))).0);
        let mut zip_nodes: Vec<ZipNode> = on.iter().map(|p| ZipNode { lane: 4, pos: *p }).collect();
        zip_nodes.push(ZipNode { lane: 4, pos: [5000.0, -3000.0] });
        let mut s = seconds(5);
        s[0].heroes = vec![hero(1, 2, true, [0.0, 0.0])];
        // 0: neutral middle. 1: Amber takes the second, Sapphire holds the last two. 2: no nodes in the
        // sample (held). 3: unchanged. 4: Sapphire takes everything; the off-lane node counts
        // for nobody.
        s[0].zip_teams = vec![2, 4, 4, 3, 2];
        s[1].zip_teams = vec![2, 2, 3, 3, 2];
        s[3].zip_teams = vec![2, 2, 3, 3, 3];
        s[4].zip_teams = vec![3, 3, 3, 3, 2];
        let t = derive(&Obs { zip_nodes, ..obs(s) }, m).expect("timeline");
        assert_eq!(t.zips.len(), 1, "only lanes with nodes");
        let z = &t.zips[0];
        assert_eq!(z.lane, "lane4");
        assert!(t_of(0) < t_of(1) && t_of(1) < t_of(2) && t_of(2) < t_of(3));
        assert_eq!(z.at, [[0, t_of(0), t_of(3)], [1, t_of(1), t_of(2)], [4, 0, t_of(0)]]);
        assert_eq!(crate::timeline::validate(&serde_json::to_vec(&t).expect("json")).map(|_| ()), Ok(()));
    }

    #[test]
    fn camps_take_their_key_from_the_origin_and_clear_until_the_timer() {
        let m = map::current();
        let mut s = seconds(1200);
        s[0].heroes = vec![hero(1, 2, true, [0.0, 0.0])];
        let camp_slots = vec![
            // Slot 0 sits on camp 3 (strong): first up at 480, cleared at 677.4, back at 1012.4.
            // The recording's first tick reads −1 for every timer.
            CampSlot { origin: [-4916.0, -1792.0], mid_boss: false, changes: vec![(0.0, -1.0), (0.0, 480.0), (480.05, -1.0), (677.44, 1012.44), (1012.45, -1.0)] },
            // The mid boss (its origin a couple of units off the centre): up from the start.
            CampSlot { origin: [-2.0, -1.0], mid_boss: true, changes: vec![(0.0, -1.0), (0.0, 0.0), (0.02, -1.0), (864.7, 1284.7)] },
            // An origin on no site, and a camp that never spawns in the recording.
            CampSlot { origin: [9999.0, 9999.0], mid_boss: false, changes: vec![(0.0, 120.0)] },
            CampSlot { origin: [6304.0, 964.0], mid_boss: false, changes: vec![(0.0, 2000.0)] },
        ];
        let t = derive(&Obs { camp_slots, ..obs(s) }, m).expect("timeline");
        assert_eq!(
            t.camps,
            [
                Camp { key: "camp:neutral:lane0:3".into(), first_s: 480, cleared: vec![[677, 1012]] },
                Camp { key: "camp:neutral:lane0:45".into(), first_s: 2000, cleared: vec![] },
                Camp { key: "mid_boss:neutral:lane0:1".into(), first_s: 0, cleared: vec![[865, 1285]] },
            ]
        );
        assert_eq!(crate::timeline::validate(&serde_json::to_vec(&t).expect("json")).map(|_| ()), Ok(()));
    }

    #[test]
    fn ult_casts_are_events_with_the_caster() {
        let mut s = seconds(3);
        for x in &mut s {
            x.heroes = vec![hero(1, 2, true, [0.0, 0.0]), hero(2, 3, true, [0.0, 0.0])];
        }
        // Sapphire's hero casts two abilities; only the one its ult cooldown starts with is the ult.
        s[1].abilities = vec![AbilityObs { hero_id: 12, team: 3, pos: Some([1.0, 1.0]), name: "ability_haze_dagger".into() }];
        s[2].abilities = vec![AbilityObs { hero_id: 12, team: 3, pos: Some([10.4, -20.0]), name: "Ability_Haze_Bullet<Dance>".into() }];
        for (i, x) in s.iter_mut().enumerate() {
            x.heroes[1].ult_trained = true;
            (x.heroes[1].ult_start, x.heroes[1].ult_end) = if i >= 2 { (x.now, x.now + 100.0) } else { (0.0, 0.0) };
        }
        let t = derive(&obs(s.clone()), map::current()).expect("timeline");
        let ults: Vec<&Event> = t.events.iter().filter(|e| e.kind == "ult").collect();
        assert_eq!(ults.len(), 1, "{ults:?}");
        // A cast that names itself the ult wins over a later one in the window.
        let mut s2 = s.clone();
        s2[1].abilities = vec![AbilityObs { hero_id: 12, team: 3, pos: None, name: "ability_haze_ultimate".into() }];
        let t2 = derive(&obs(s2), map::current()).expect("timeline");
        assert_eq!(t2.events.iter().find(|e| e.kind == "ult").and_then(|e| e.ability.as_deref()), Some("ability_haze_ultimate"));
        // A hero first seen with its cooldown running: no cast.
        let mut s3 = s.clone();
        for x in s3.iter_mut().take(2) {
            x.heroes.retain(|h| h.team != 3);
        }
        let t3 = derive(&obs(s3), map::current()).expect("timeline");
        assert!(t3.events.iter().all(|e| e.kind != "ult"));
        let u = ults[0];
        assert_eq!((u.t, u.team.as_deref(), u.slot, u.hero_id, u.x, u.ability.as_deref()), (2, Some("sapphire"), Some(0), Some(12), Some(10), Some("ability_haze_bulletdance")));
        assert_eq!(crate::timeline::validate(&serde_json::to_vec(&t).expect("json")).map(|_| ()), Ok(()));
    }

    #[test]
    fn objective_health_by_key_changes_only() {
        let mut s = seconds(4);
        s[0].heroes = vec![hero(1, 2, true, [0.0, 0.0])];
        let walker = [-6272.0, -4736.0];
        for (i, h) in [3000, 3000, 2970, 1500].into_iter().enumerate() {
            s[i].objectives.push(ObjObs { ent: (10, 1), kind: "walker", pos: walker, health: h, max_health: 3000, phase: 0 });
        }
        let t = derive(&obs(s), map::current()).expect("timeline");
        let w = t.objective_health.iter().find(|o| o.key == "walker:amber:lane1:1").expect("walker");
        assert_eq!(w.at, [[0, 100], [2, 99], [3, 50]]);
    }

    #[test]
    fn the_patron_has_stages_and_the_loser_s_falls_at_the_end() {
        let m = map::current();
        let site = m.sites.iter().find(|x| x.kind == "patron" && x.team == "sapphire").expect("patron");
        let at = [site.world[0] as f32, site.world[1] as f32];
        let mut s = seconds(4);
        s[0].heroes = vec![hero(1, 2, true, [0.0, 0.0])];
        for (i, (h, phase)) in [(1000, 0), (500, 0), (2000, 1), (1000, 1)].into_iter().enumerate() {
            s[i].objectives.push(ObjObs { ent: (40, 1), kind: "patron", pos: at, health: h, max_health: 2000, phase });
        }
        let t = derive(&Obs { winner: 2, ..obs(s) }, m).expect("timeline");
        let p = t.objective_health.iter().find(|o| o.key == site.key).expect("patron health");
        assert_eq!(p.at, [[0, 50], [1, 25], [2, 100], [3, 50]]);
        assert_eq!(p.stage, [[0, 1], [2, 2]]);
        // Amber won: Sapphire's patron falls at the end, though the parse never saw it at 0.
        let fell = t.objectives.iter().find(|o| o.key == site.key).expect("patron down");
        assert_eq!((fell.destroyed_s, fell.team.as_str()), (3, "sapphire"));
    }

    #[test]
    fn a_revive_in_place_is_not_a_death() {
        let mut s = seconds(30);
        for (i, x) in s.iter_mut().enumerate() {
            // Down 3 s at 5 and back where it fell; down at 12 and back at the base 12 s later.
            let alive = !(5..8).contains(&i) && !(12..24).contains(&i);
            let pos = if i >= 24 { [-9000.0, -9000.0] } else { [100.0, 100.0] };
            x.heroes = vec![hero(1, 2, alive, pos)];
        }
        let t = derive(&obs(s), map::current()).expect("timeline");
        assert_eq!(t.players[0].deaths, [12]);
        assert_eq!(t.players[0].x[6], None, "still hidden while down");
        assert_eq!(t.events.iter().filter(|e| e.kind == "death").map(|e| e.t).collect::<Vec<_>>(), [12]);
    }

    #[test]
    fn a_dead_hero_has_no_health() {
        let mut s = seconds(2);
        s[0].heroes = vec![HeroObs { health: 300, max_health: 600, ..hero(1, 2, true, [0.0, 0.0]) }];
        s[1].heroes = vec![HeroObs { health: 300, max_health: 600, ..hero(1, 2, false, [0.0, 0.0]) }];
        let t = derive(&obs(s), map::current()).expect("timeline");
        assert_eq!(t.players[0].health, [50, 0]);
    }

    #[test]
    fn troopers_are_packed_per_team_per_second_and_gaps_stay_empty() {
        let mut s = seconds(3);
        s[0].heroes = vec![hero(1, 2, true, [0.0, 0.0])];
        s[0].troopers = vec![TrooperObs { id: 70001, team: 2, lane: 4, pos: [100.4, -200.6] }, TrooperObs { id: 5, team: 3, lane: 1, pos: [9.0, 9.0] }];
        s[2].troopers = vec![TrooperObs { id: 70001, team: 2, lane: 4, pos: [150.0, -150.0] }];
        let t = derive(&obs(s), map::current()).expect("timeline");
        let tr = t.troopers.expect("troopers");
        assert_eq!(tr.every_s, 1);
        assert_eq!(decode_troopers(&tr.amber[0]), Some(vec![(70001u32 as u16, 100, -201)]));
        assert_eq!(decode_troopers(&tr.sapphire[0]), Some(vec![(5, 9, 9)]));
        assert_eq!(tr.amber[1], "", "a gap is an empty sample");
        assert_eq!(decode_troopers(&tr.amber[2]), Some(vec![(70001u32 as u16, 150, -150)]));
    }

    #[test]
    fn a_respawn_is_when_the_hero_is_back_else_the_pawn_s_timer() {
        let mut s = seconds(12);
        for (i, x) in s.iter_mut().enumerate() {
            // Dies at 2 and is back at the base at 6, though its timer said 8 (the game cut the
            // wait short: seen wins); dies again at 9 and the recording ends with it dead, its
            // timer at now 100 + 9 + 20.4 (second 29.4: back at 30).
            let alive = !(2..6).contains(&i) && i < 9;
            let mut h = hero(1, 2, alive, if i >= 6 { [-9000.0, -9000.0] } else { [0.0, 0.0] });
            h.respawn_at = if alive { 0.0 } else if i >= 9 { 129.4 } else { 108.0 };
            x.heroes = vec![h];
        }
        let t = derive(&obs(s), map::current()).expect("timeline");
        assert_eq!(t.players[0].deaths, [2, 9]);
        assert_eq!(t.players[0].respawn, [[2, 6], [9, 30]]);
    }

    #[test]
    fn a_revive_in_place_has_no_respawn() {
        let mut s = seconds(8);
        for (i, x) in s.iter_mut().enumerate() {
            let mut h = hero(1, 2, !(3..5).contains(&i), [0.0, 0.0]);
            h.respawn_at = if (3..5).contains(&i) { 200.0 } else { 0.0 };
            x.heroes = vec![h];
        }
        let t = derive(&obs(s), map::current()).expect("timeline");
        assert_eq!(t.players[0].deaths, Vec::<u32>::new());
        assert_eq!(t.players[0].respawn, Vec::<[u32; 2]>::new());
    }

    /// The urn's life on 129738985 around 30:00, shortened: it spawns over the west site, the
    /// east point opens as it lands, Amber picks it up, drops it, picks it up and delivers it.
    #[test]
    fn the_urn_spawns_is_carried_dropped_and_delivered() {
        let mut s = seconds(40);
        for x in &mut s {
            x.heroes = vec![hero(1, 2, true, [0.0, 0.0]), hero(3, 2, true, [0.0, 0.0]), hero(7, 3, true, [0.0, 0.0])];
        }
        let mut o = obs(s);
        let west = Some([-6584.0, 0.0]);
        let east = Some([6304.0, -96.0]);
        let u = |game: f32, ground: Option<[f32; 2]>, carrier_team: i64, carrier: Option<i32>, delivery: Option<[f32; 2]>| UrnObs { game, ground, carrier_team, carrier, delivery };
        o.urn = vec![
            u(5.0, west, 0, None, None),
            u(17.5, west, 0, None, east),
            u(18.2, None, 2, Some(3), east),
            u(24.4, Some([4267.0, -3082.0]), 0, None, east),
            // Picked up again within the second the drop's: one entry, the later state.
            u(24.9, None, 2, Some(1), east),
            u(31.0, None, 0, None, None),
        ];
        let t = derive(&o, map::current()).expect("timeline");
        let urn = t.urn.as_ref().expect("urn");
        assert_eq!(urn.spawns, [UrnSpawn { t: 5, key: "urn:neutral:lane1:1".into() }]);
        type AtRow<'a> = (u32, &'a str, Option<i32>, Option<&'a str>, Option<u32>, Option<&'a str>);
        type EvRow<'a> = (u32, &'a str, Option<&'a str>, Option<u32>, Option<u32>, Option<i32>, Option<&'a str>);
        let at: Vec<AtRow> =
            urn.at.iter().map(|a| (a.t, a.state.as_str(), a.x, a.team.as_deref(), a.slot, a.delivery.as_deref())).collect();
        let e = Some("urn:neutral:lane6:1");
        assert_eq!(
            at,
            [
                (5, "ground", Some(-6584), None, None, None),
                (17, "ground", Some(-6584), None, None, e),
                (18, "carried", None, Some("amber"), Some(1), e),
                (24, "carried", None, Some("amber"), Some(0), e),
                (31, "none", None, None, None, None),
            ]
        );
        let ev: Vec<EvRow> = t
            .events
            .iter()
            .filter(|e| e.kind.starts_with("urn_"))
            .map(|e| (e.t, e.kind.as_str(), e.team.as_deref(), e.slot, e.hero_id, e.x, e.key.as_deref()))
            .collect();
        assert_eq!(
            ev,
            [
                (18, "urn_pickup", Some("amber"), Some(1), Some(13), Some(-6584), None),
                (24, "urn_drop", Some("amber"), Some(1), Some(13), Some(4267), None),
                (24, "urn_pickup", Some("amber"), Some(0), Some(11), Some(4267), None),
                (31, "urn_delivered", Some("amber"), Some(0), Some(11), Some(6304), e),
            ]
        );
        let bytes = serde_json::to_vec(&t).expect("json");
        assert_eq!(crate::timeline::validate(&bytes), Ok(t));
    }

    #[test]
    fn an_urn_dropped_on_the_ground_is_the_dropper_s_colour() {
        let mut s = seconds(20);
        for x in &mut s {
            x.heroes = vec![hero(7, 3, true, [0.0, 0.0])];
        }
        let mut o = obs(s);
        let east = Some([6304.0, -96.0]);
        o.urn = vec![
            UrnObs { game: 2.0, ground: Some([-6584.0, 0.0]), ..Default::default() },
            UrnObs { game: 4.0, ground: None, carrier_team: 3, carrier: Some(7), delivery: east },
            UrnObs { game: 6.0, ground: Some([100.0, 100.0]), delivery: east, ..Default::default() },
            UrnObs { game: 8.0, ground: Some([300.0, 100.0]), delivery: east, ..Default::default() },
        ];
        let t = derive(&o, map::current()).expect("timeline");
        let teams: Vec<(u32, &str, Option<&str>)> = t.urn.as_ref().expect("urn").at.iter().map(|a| (a.t, a.state.as_str(), a.team.as_deref())).collect();
        assert_eq!(teams, [(2, "ground", None), (4, "carried", Some("sapphire")), (6, "ground", Some("sapphire")), (8, "ground", Some("sapphire"))]);
    }

    /// 129738985's first rift, shortened: its cash-in opens at 2.6 s (the second samples first
    /// see it at 3), both teams push, Sapphire holds still a while, then captures at 7.4 s.
    #[test]
    fn an_open_rift_has_its_deadline_and_both_teams_progress() {
        let mut s = seconds(12);
        s[0].heroes = vec![hero(1, 2, true, [0.0, 0.0])];
        for x in &mut s[1..3] {
            x.rift_spawner = Some([-7648.0, 0.0]);
        }
        for x in &mut s[3..10] {
            x.rift_live_at = Some([-7612.0, 0.0]);
        }
        let mut o = obs(s);
        let k = |game: f32, amber: f32, sapphire: f32, give_up: Option<f32>| KothObs { game, amber, sapphire, give_up };
        o.koth = vec![
            k(2.5, 0.0, 0.0, Some(63.1)),
            k(3.0, 0.02, 0.01, Some(63.1)),
            k(3.5, 0.05, 0.02, Some(63.1)),
            k(4.0, 0.10, 0.20, Some(63.1)),
            // Sapphire holds at 40% for 2 s: only the run's ends are kept.
            k(4.5, 0.10, 0.40, Some(63.1)),
            k(5.0, 0.10, 0.40, Some(63.1)),
            k(5.5, 0.10, 0.40, Some(63.1)),
            k(6.0, 0.10, 0.40, Some(63.1)),
            k(6.5, 0.10, 0.70, Some(63.1)),
            k(7.0, 0.12, 0.999, Some(63.1)),
            k(7.5, 0.12, 1.0, None),
            // Another rift's samples, much later: not this one's.
            k(40.0, 0.5, 0.5, Some(99.0)),
        ];
        let t = derive(&o, map::current()).expect("timeline");
        let r = &t.rifts[0];
        assert_eq!((r.start_s, r.live_s, r.end_s, r.give_up_s), (1, Some(3), 10, Some(63)));
        assert_eq!(r.capture, [[25, 0, 0], [30, 2, 1], [35, 5, 2], [40, 10, 20], [45, 10, 40], [60, 10, 40], [65, 10, 70], [70, 12, 100], [75, 12, 100]]);
        let bytes = serde_json::to_vec(&t).expect("json");
        assert_eq!(crate::timeline::validate(&bytes), Ok(t));
    }

    /// 129738985's Rejuvenators, shortened: Sapphire's three shards come within the second, two
    /// revives (each charge goes at the death, the revive comes 3 s later), and it expires; then
    /// Amber takes one the recording ends during.
    #[test]
    fn a_rejuvenator_is_taken_used_and_expires() {
        let mut s = seconds(40);
        for x in &mut s {
            x.heroes = vec![hero(1, 2, true, [100.0, 200.0]), hero(5, 3, true, [-300.0, 400.0]), hero(7, 3, true, [-500.0, 600.0])];
        }
        let mut o = obs(s);
        let m = |game: f32, what: RejuvWhat, team: i64, player: Option<i32>| RejuvObs { game, what, team, player };
        let c = |game: f32, amber: i64, sapphire: i64| RejuvCount { game, amber, sapphire };
        o.rejuv = vec![
            m(2.3, RejuvWhat::Taken, 3, Some(5)),
            m(2.5, RejuvWhat::Taken, 3, Some(7)),
            m(2.5, RejuvWhat::Taken, 3, Some(5)),
            // A revive message for a team without one is noise.
            m(4.0, RejuvWhat::Revive, 2, Some(1)),
            m(8.5, RejuvWhat::Revive, 3, Some(7)),
            m(12.7, RejuvWhat::Revive, 3, Some(5)),
            m(20.3, RejuvWhat::Expired, 3, Some(5)),
            m(20.3, RejuvWhat::Expired, 3, Some(7)),
            m(30.0, RejuvWhat::Taken, 2, Some(1)),
        ];
        o.rejuv_counts = vec![c(2.3, 0, 1), c(2.5, 0, 3), c(5.5, 0, 2), c(9.7, 0, 1), c(20.3, 0, 0), c(30.0, 1, 0), c(31.2, 2, 0)];
        let t = derive(&o, map::current()).expect("timeline");
        assert_eq!(
            t.rejuv,
            [
                Rejuv { team: "sapphire".into(), taken_s: 2, ends_s: 20, left: vec![[2, 3], [5, 2], [9, 1]] },
                Rejuv { team: "amber".into(), taken_s: 30, ends_s: 30 + REJUV_S, left: vec![[30, 1], [31, 2]] },
            ]
        );
        type Row<'a> = (u32, &'a str, Option<&'a str>, Option<u32>, Option<u32>, Option<i32>);
        let ev: Vec<Row> = t.events.iter().filter(|e| e.kind.starts_with("rejuv_")).map(|e| (e.t, e.kind.as_str(), e.team.as_deref(), e.slot, e.hero_id, e.x)).collect();
        let s = Some("sapphire");
        assert_eq!(
            ev,
            [
                (2, "rejuv_taken", s, None, None, Some(0)),
                (8, "rejuv_revive", s, Some(1), Some(17), Some(-500)),
                (12, "rejuv_revive", s, Some(0), Some(15), Some(-300)),
                (20, "rejuv_expired", s, None, None, None),
                (30, "rejuv_taken", Some("amber"), None, None, Some(0)),
            ]
        );
        let bytes = serde_json::to_vec(&t).expect("json");
        assert_eq!(crate::timeline::validate(&bytes), Ok(t));
    }

    #[test]
    fn derived_timelines_pass_the_servers_checks() {
        let mut s = seconds(3);
        for x in &mut s {
            x.heroes = vec![hero(1, 2, true, [10.0, 10.0]), hero(2, 3, true, [10.0, 10.0])];
        }
        let t = derive(&obs(s), map::current()).expect("timeline");
        let bytes = serde_json::to_vec(&t).expect("json");
        assert_eq!(crate::timeline::validate(&bytes), Ok(t));
    }
}
