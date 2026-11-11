//! Checks [`mapcro_replay::stat_calc`] against ground truth (docs/research/stat-calc-spike.md).
//! Read-only; prints aggregate rates per stat, keyed by hero id at most. Never prints a name or
//! an account id (the metadata carries account ids; they're never read).
//!
//! `cargo run -p mapcro-replay --example stat_calc_check -- <boon-data dir> <metadata.json> [timeline.json] [-v]`
//!
//! - metadata: deadlock-api `/v1/matches/{id}/metadata` JSON. Its `PlayerStats` snapshots (about
//!   every 3 min: max_health, tech_power, weapon_power, level) are checked against a build from its
//!   item timeline, ability upgrades and statue pickups (`power_up_buffs`).
//! - timeline (format 8): its recorded `max_health` (the pawn's `m_iMaxHealth`, refreshed at
//!   (re)spawn) is checked against a build from the timeline's own items, levels and ability
//!   tiers, with pickups from the metadata. Its health percent also feeds the life-threshold rule.

use mapcro_replay::stat_calc::{Build, Catalog, Pickups};
use serde_json::Value;
use std::collections::HashMap;

fn load(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(path).expect("reads")).expect("json")
}

fn pickups(player: &Value, t: f64) -> Pickups {
    let mut p = Pickups::default();
    for b in player["power_up_buffs"].as_array().into_iter().flatten() {
        if b["is_permanent"] != true {
            continue;
        }
        let kind = b["type"].as_str().unwrap_or("").split("_permanent").next().unwrap_or("");
        let slot = match kind {
            "hp" => &mut p.max_health,
            "spirit" => &mut p.spirit_power,
            "wp" => &mut p.weapon_damage,
            "bulletresist" => &mut p.bullet_resist,
            "spiritresist" => &mut p.spirit_resist,
            _ => continue,
        };
        let times = b["pickup_times_s"].as_array().into_iter().flatten();
        let values = b["pickup_stat_values"].as_array().into_iter().flatten();
        *slot += times.zip(values).filter(|(w, _)| w.as_f64().is_some_and(|w| w <= t)).filter_map(|(_, v)| v.as_f64()).sum::<f64>();
    }
    p
}

#[derive(Default)]
struct Tally {
    n: u32,
    exact: u32,
    within1: u32,
}
impl Tally {
    fn add(&mut self, calc: i64, seen: i64) {
        self.n += 1;
        self.exact += u32::from(calc == seen);
        self.within1 += u32::from((calc - seen).abs() <= 1);
    }
    fn line(&self, what: &str) -> String {
        let pct = |k: u32| 100.0 * f64::from(k) / f64::from(self.n.max(1));
        format!("{what:<40} n={:<4} exact={:<4} ({:5.1}%) within1={:<4} ({:5.1}%)", self.n, self.exact, pct(self.exact), self.within1, pct(self.within1))
    }
}

fn at<T: Copy>(series: &[(f64, T)], t: f64) -> Option<T> {
    series.iter().take_while(|(s, _)| *s <= t).last().map(|(_, v)| *v)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let verbose = args.iter().any(|a| a == "-v");
    let args: Vec<&String> = args.iter().filter(|a| *a != "-v").collect();
    let [data, meta, rest @ ..] = args.as_slice() else { panic!("usage: stat_calc_check <boon-data dir> <metadata.json> [timeline.json] [-v]") };
    let cat = Catalog::load(std::path::Path::new(data.as_str())).expect("catalog");
    let meta = load(meta);
    let info = &meta["match_info"];
    let timeline = rest.first().map(|p| load(p));
    // Timeline player by hero id, for health percent (and the respawn check).
    let by_hero: HashMap<u64, &Value> = timeline.iter().flat_map(|t| t["players"].as_array().into_iter().flatten()).filter_map(|p| Some((p["hero_id"].as_u64()?, p))).collect();
    println!("patch data {} for match {}", cat.client_version, info["match_id"]);
    let (mut hp, mut sp, mut wd, mut wd_state, mut hp_state) = (Tally::default(), Tally::default(), Tally::default(), Tally::default(), Tally::default());
    for p in info["players"].as_array().into_iter().flatten() {
        let hero = p["hero_id"].as_u64().unwrap_or(0);
        let entries = p["items"].as_array().cloned().unwrap_or_default();
        for s in p["stats"].as_array().into_iter().flatten() {
            let t = s["time_stamp_s"].as_f64().unwrap_or(0.0);
            let mut items = Vec::new();
            let mut tiers: HashMap<u32, u8> = HashMap::new();
            for e in &entries {
                let (Some(id), Some(bought)) = (e["item_id"].as_u64().map(|i| i as u32), e["game_time_s"].as_f64()) else { continue };
                if bought > t {
                    continue;
                }
                if cat.is_shop_item(id) {
                    let sold = e["sold_time_s"].as_f64().unwrap_or(0.0);
                    if sold == 0.0 || sold > t {
                        items.push(id);
                    }
                } else if e["upgrade_id"].as_u64().unwrap_or(0) != 0 {
                    *tiers.entry(id).or_default() += 1;
                }
            }
            let tiers: Vec<(u32, u8)> = tiers.into_iter().collect();
            let mut build = Build { hero_id: hero as u32, level: s["level"].as_u64().unwrap_or(1) as u32, items: &items, ability_tiers: &tiers, pickups: pickups(p, t), health_pct: None };
            let Some(c) = cat.calculate(&build) else { continue };
            let seen = |k: &str| s[k].as_i64().unwrap_or(-1);
            let shown = c.shown();
            hp.add(shown.max_health, seen("max_health"));
            // Metadata truncates spirit power; the HUD rounds it.
            sp.add((c.spirit_power + 1e-6).floor() as i64, seen("tech_power"));
            wd.add((c.weapon_damage + 1e-6).floor() as i64, seen("weapon_power"));
            if let Some(tp) = by_hero.get(&hero) {
                let sec = t as usize;
                let alive = tp["x"].get(sec).is_some_and(|x| !x.is_null());
                build.health_pct = if alive { tp["health"].get(sec).and_then(Value::as_f64) } else { Some(100.0) };
                if let Some(c) = cat.calculate(&build) {
                    wd_state.add((c.weapon_damage + 1e-6).floor() as i64, seen("weapon_power"));
                    hp_state.add(c.shown().max_health, seen("max_health"));
                }
            }
            if verbose && s == p["stats"].as_array().and_then(|a| a.last()).unwrap_or(&Value::Null) {
                println!("  last snapshot hero {hero}: bullet resist {:.1}%, spirit resist {:.1}% (calculated, no ground truth)", c.bullet_resist, c.spirit_resist);
            }
            if verbose && (shown.max_health != seen("max_health") || (c.weapon_damage + 1e-6).floor() as i64 != seen("weapon_power")) {
                println!("  miss hero {hero} t={t} level {}: hp {} vs {}, spirit {:.1} vs {}, weapon {:.1} vs {}", build.level, shown.max_health, seen("max_health"), c.spirit_power, seen("tech_power"), c.weapon_damage, seen("weapon_power"));
            }
        }
    }
    println!("metadata snapshots (PlayerStats):");
    println!("{}", hp.line("  max_health"));
    println!("{}", sp.line("  spirit_power (truncated)"));
    println!("{}", wd.line("  weapon_damage"));
    if timeline.is_some() {
        println!("{}", hp_state.line("  max_health, with replay health"));
        println!("{}", wd_state.line("  weapon_damage, with replay health"));
        respawn_check(&cat, info, &by_hero, verbose);
    }
}

/// The timeline's recorded max health (non-null points) against a build from the timeline alone,
/// plus the metadata's pickups (the timeline has no pickup series yet).
fn respawn_check(cat: &Catalog, info: &Value, by_hero: &HashMap<u64, &Value>, verbose: bool) {
    let mut tally = Tally::default();
    for p in info["players"].as_array().into_iter().flatten() {
        let hero = p["hero_id"].as_u64().unwrap_or(0);
        let Some(tp) = by_hero.get(&hero) else { continue };
        let pairs = |k: &str| -> Vec<(f64, Value)> { tp[k].as_array().into_iter().flatten().filter_map(|r| Some((r[0].as_f64()?, r[1].clone()))).collect() };
        let levels: Vec<(f64, u64)> = pairs("level").into_iter().filter_map(|(t, v)| Some((t, v.as_u64()?))).collect();
        let shop: Vec<[u64; 3]> = tp["items"].as_array().into_iter().flatten().filter_map(|r| Some([r[0].as_u64()?, r[1].as_u64()?, r[2].as_u64()?])).collect();
        let abilities: Vec<[u64; 3]> = tp["abilities"].as_array().into_iter().flatten().filter_map(|r| Some([r[0].as_u64()?, r[1].as_u64()?, r[2].as_u64()?])).collect();
        for (t, v) in pairs("max_health") {
            let Some(seen) = v.as_i64() else { continue };
            let mut owned: Vec<u32> = Vec::new();
            for [ds, id, kind] in &shop {
                if *ds as f64 > t * 10.0 {
                    break;
                }
                let id = *id as u32;
                if *kind == 0 {
                    owned.push(id);
                } else if let Some(i) = owned.iter().position(|x| *x == id) {
                    owned.remove(i);
                }
            }
            let mut tiers: HashMap<u32, u8> = HashMap::new();
            for [s, id, level] in &abilities {
                if *s as f64 <= t && *level >= 2 {
                    tiers.insert(*id as u32, (*level - 1) as u8);
                }
            }
            let tiers: Vec<(u32, u8)> = tiers.into_iter().collect();
            let level = at(&levels, t).unwrap_or(1) as u32;
            let build = Build { hero_id: hero as u32, level, items: &owned, ability_tiers: &tiers, pickups: pickups(p, t), health_pct: None };
            let Some(c) = cat.calculate(&build) else { continue };
            tally.add(c.shown().max_health, seen);
            if verbose && c.shown().max_health != seen {
                println!("  respawn miss hero {hero} t={t} level {level}: {} vs recorded {seen}", c.shown().max_health);
            }
        }
    }
    println!("timeline recorded max_health (fresh at spawn), timeline-only build + metadata pickups:");
    println!("{}", tally.line("  max_health"));
}
