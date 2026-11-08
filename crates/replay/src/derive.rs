//! Per-second observations of a demo to a [`Timeline`]. Pure: the parser fills [`Obs`], tests
//! build it by hand.
//!
//! The demo only records entities near players (PVS), so absence is "not visible", never
//! "gone": objectives count as destroyed only on a seen positive-to-zero health change, waves and
//! powerups hold their last seen value and mark the gap stale.

use crate::map::{self, Map};
use crate::timeline::{MidBoss, Objective, Player, Powerup, Rift, Timeline, WaveTrack, TIER};
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
    pub powerups: Vec<PowerupObs>,
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
}

#[derive(Clone, Debug)]
pub struct ObjObs {
    /// Entity index and serial: one lifetime.
    pub ent: (i32, u32),
    /// Our site kind: guardian, walker, base_guardian, patron, mid_boss, shrine.
    pub kind: &'static str,
    pub pos: [f32; 2],
    pub health: i64,
}

#[derive(Clone, Debug)]
pub struct TrooperObs {
    pub team: i64,
    /// The trooper's `m_iLane` (1, 4, 6 on the current map: our lane keys' numbers).
    pub lane: i64,
    pub pos: [f32; 2],
}

#[derive(Clone, Debug)]
pub struct PowerupObs {
    pub pos: [f32; 2],
    pub active: bool,
}

pub struct Obs {
    pub match_id: u64,
    pub build: u32,
    /// Index = game second, from 0.
    pub seconds: Vec<Sample>,
}

/// How far (world units) a demo entity may be from our site to take its key. Current-map
/// demos land at 0 (exploration §8); the old map's patrons and shrines are ~1280 off.
const SITE_MATCH: f64 = 400.0;
/// A trooper further than this from its lane (map units, ~1,300 world units) isn't on it.
const LANE_MATCH: f64 = 60.0;

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
}

pub fn derive(obs: &Obs, m: &Map) -> Result<Timeline, Refused> {
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
    for team in [2i64, 3] {
        for (slot, (&id, _)) in ids.iter().filter(|(_, t)| **t == team).enumerate() {
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
            };
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
                p.health.push(h.map_or(0, |h| if h.max_health > 0 { (h.health.max(0) * 100 / h.max_health).clamp(0, 100) as u8 } else { 0 }));
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
                    if let Some(name) = h.name.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                        let clean: String = name.chars().filter(|c| !c.is_control()).take(32).collect();
                        p.name = Some(clean);
                    }
                    if p.souls.last().is_none_or(|l| l[1] != h.net_worth) {
                        p.souls.push([sec as u32, h.net_worth]);
                    }
                }
                if was_alive == Some(true) && !alive && h.is_some() {
                    p.deaths.push(sec as u32);
                }
                if h.is_some() {
                    was_alive = Some(alive);
                }
            }
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
    objectives.sort_by(|a, b| (a.destroyed_s, &a.key).cmp(&(b.destroyed_s, &b.key)));
    mid_boss.sort_by_key(|b| b.destroyed_s);

    // ---- rifts: the spawner's site, or the live cash-in's ----
    let mut rifts: Vec<Rift> = Vec::new();
    let mut open: Option<(String, u32)> = None;
    for (sec, s) in obs.seconds.iter().enumerate() {
        let at = s.rift_spawner.or(s.rift_live_at);
        let key = at.and_then(|p| m.nearest("rift", p[0] as f64, p[1] as f64, 2000.0)).map(|s| s.key.clone());
        if open.as_ref().map(|o| &o.0) != key.as_ref() {
            if let Some((k, start)) = open.take() {
                rifts.push(Rift { key: k, start_s: start, end_s: sec as u32 });
            }
            open = key.map(|k| (k, sec as u32));
        }
    }
    if let Some((k, start)) = open {
        rifts.push(Rift { key: k, start_s: start, end_s: n as u32 });
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
        powerups.push(Powerup { key: key.to_owned(), available, stale: runs(&stale) });
    }

    // ---- waves: where the two fronts meet along each lane ----
    let mut waves = Vec::new();
    for lane in &m.lanes {
        let lane_no: i64 = lane.key.trim_start_matches("lane").parse().unwrap_or(-1);
        let mut t = Vec::with_capacity(n);
        let mut stale = Vec::with_capacity(n);
        let mut last: Option<u16> = None;
        for s in &obs.seconds {
            let (mut amber, mut sapphire): (Option<u16>, Option<u16>) = (None, None);
            for tr in s.troopers.iter().filter(|tr| tr.lane == lane_no) {
                let (tt, d) = lane.project(map::world_to_map(tr.pos[0] as f64, tr.pos[1] as f64));
                if d > LANE_MATCH {
                    continue;
                }
                match tr.team {
                    2 => amber = Some(amber.map_or(tt, |a| a.max(tt))),
                    3 => sapphire = Some(sapphire.map_or(tt, |v| v.min(tt))),
                    _ => {}
                }
            }
            let now = match (amber, sapphire) {
                (Some(a), Some(b)) => Some(((u32::from(a) + u32::from(b)) / 2) as u16),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (None, None) => None,
            };
            stale.push(now.is_none());
            if now.is_some() {
                last = now;
            }
            t.push(last);
        }
        waves.push(WaveTrack { lane: lane.key.to_owned(), t, stale: runs(&stale) });
    }
    waves.sort_by(|a, b| a.lane.cmp(&b.lane));

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
        waves,
    })
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
        Obs { match_id: 42, build: 6813, seconds }
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
            // Controller 5 is Sapphire; 1 and 3 are Amber, in index order. 3 dies at second 2.
            x.heroes = vec![hero(5, 3, true, [1.0, 2.0]), hero(3, 2, i != 2, [100.4, -200.6]), hero(1, 2, true, [0.0, 0.0])];
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
        assert_eq!(p.x, [Some(100), Some(100), None, Some(100)]);
        assert_eq!(p.y, [Some(-201), Some(-201), None, Some(-201)]);
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
            x.objectives.push(ObjObs { ent: (10, 1), kind: "walker", pos: walker, health: if i < 3 { 100 } else { 0 } });
            // Seen only at zero (a PVS gap from the start): never "destroyed".
            x.objectives.push(ObjObs { ent: (11, 1), kind: "guardian", pos: guardian, health: 0 });
            // Both of Amber's mid base guardians; the pair is down when the second falls.
            x.objectives.push(ObjObs { ent: (20, 1), kind: "base_guardian", pos: [-1280.0, -5456.0], health: if i < 2 { 1 } else { 0 } });
            x.objectives.push(ObjObs { ent: (21, 1), kind: "base_guardian", pos: [-1290.0, -5450.0], health: if i < 4 { 1 } else { 0 } });
            x.objectives.push(ObjObs { ent: (30, 1), kind: "mid_boss", pos: [0.0, 0.0], health: if i < 1 { 1 } else { 0 } });
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
            x.objectives.push(ObjObs { ent: (10, 1), kind: "guardian", pos: mid, health: if i == 1 { 0 } else { 100 } });
        }
        // Amber's west guardian reads zero under one serial, then lives on under another.
        let west = [-8192.0, -1856.0];
        s[1].objectives.push(ObjObs { ent: (11, 1), kind: "guardian", pos: west, health: 50 });
        s[2].objectives.push(ObjObs { ent: (11, 1), kind: "guardian", pos: west, health: 0 });
        s[3].objectives.push(ObjObs { ent: (11, 2), kind: "guardian", pos: west, health: 50 });
        let t = derive(&obs(s), map::current()).expect("timeline");
        assert_eq!(t.objectives, []);
    }

    #[test]
    fn objectives_off_our_sites_mean_another_map() {
        let mut s = seconds(2);
        s[0].heroes = vec![hero(1, 2, true, [0.0, 0.0])];
        // The old map: patrons and shrines ~1280 off (exploration §8).
        for (i, k) in ["patron", "shrine", "shrine", "walker"].iter().enumerate() {
            s[0].objectives.push(ObjObs { ent: (i as i32, 1), kind: k, pos: [3000.0 + i as f32 * 2000.0, 9000.0], health: 10 });
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
            [Rift { key: "rift:neutral:lane6:1".into(), start_s: 1, end_s: 4 }, Rift { key: "rift:neutral:lane1:1".into(), start_s: 5, end_s: 6 }]
        );
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
    fn waves_meet_between_the_fronts_and_hold_when_unseen() {
        let m = map::current();
        let mid = m.lanes.iter().find(|l| l.key == "lane4").expect("mid");
        // World points on the mid lane: the map centre, and a little toward each base.
        let on = |y: f32| [0.0f32, y];
        let t_of = |y: f32| mid.project(map::world_to_map(0.0, y as f64)).0;
        let mut s = seconds(5);
        s[0].heroes = vec![hero(1, 2, true, [0.0, 0.0])];
        // 0: nothing seen yet. 1: both fronts. 2: Amber only. 3: none (held, stale). 4: both again.
        s[1].troopers = vec![
            TrooperObs { team: 2, lane: 4, pos: on(-1000.0) },
            TrooperObs { team: 2, lane: 4, pos: on(-400.0) },
            TrooperObs { team: 3, lane: 4, pos: on(400.0) },
            TrooperObs { team: 3, lane: 4, pos: on(2000.0) },
            // Another lane's trooper doesn't count, nor one far off the lane.
            TrooperObs { team: 3, lane: 1, pos: on(-3000.0) },
            TrooperObs { team: 3, lane: 4, pos: [5000.0, -3000.0] },
        ];
        s[2].troopers = vec![TrooperObs { team: 2, lane: 4, pos: on(800.0) }];
        s[4].troopers = vec![TrooperObs { team: 2, lane: 4, pos: on(0.0) }, TrooperObs { team: 3, lane: 4, pos: on(0.0) }];
        let t = derive(&obs(s), m).expect("timeline");
        let w = t.waves.iter().find(|w| w.lane == "lane4").expect("mid");
        let meet = ((u32::from(t_of(-400.0)) + u32::from(t_of(400.0))) / 2) as u16;
        assert!(t_of(-400.0) < t_of(400.0));
        assert_eq!(w.t, [None, Some(meet), Some(t_of(800.0)), Some(t_of(800.0)), Some(t_of(0.0))]);
        assert_eq!(w.stale, [[0, 1], [3, 4]]);
        let lanes: Vec<&str> = t.waves.iter().map(|w| w.lane.as_str()).collect();
        assert_eq!(lanes, ["lane1", "lane4", "lane6"]);
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
