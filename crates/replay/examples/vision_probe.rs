//! Vision probe: does a replay say which heroes each team could see? Read-only exploration
//! (docs/research/replay-vision.md).
//!
//! `cargo run -p mapcro-replay --release --example vision_probe -- <replay.dem> [out dir]`
//!
//! Each `CCitadelTeam` carries `m_vecFOWEntities`: that team's minimap feed, one entry per
//! tracked entity, with `m_bVisibleOnMap` and a 0–255 position while shown. This walks it on
//! every tick, beside the pawns' true positions and `m_tLastPlayerRevealTime`, and writes to
//! the out dir (default `/tmp/vision-spike`):
//! - `schema.txt`: the FOW entry's fields and types, and the `m_eClass` / per-class counts;
//! - `flips.tsv`: every change of a hero entry's `m_bVisibleOnMap`, with the hero's distance
//!   to the nearest living observer-team hero at that tick;
//! - `seconds.tsv`: once a game second, per living hero: true position, each enemy team's
//!   flag and FOW position, nearest-enemy distance, and the reveal time's age;
//! - with `--names` (every class decoded), `schema.txt` names each `m_eClass`'s entities;
//! - `deaths.tsv`: each hero death, with the enemy team's flag for the victim at that tick
//!   and the ticks before it.
//!
//! Ids: no controller is read, so no Steam id is; outputs hold entity indices only.

use boon::{FieldValue, Parser, world_position};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::PathBuf;

const TEAM: &str = "CCitadelTeam";
const PAWN: &str = "CCitadelPlayerPawn";
const RULES: &str = "CCitadelGameRulesProxy";
const ORIGIN: &str = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
/// Per-entry fields read (beyond the ones boon names, the audit's numeric walk saw these).
const ENTRY: [&str; 10] =
    ["m_eClass", "m_nEntIndex", "m_nTeam", "m_bVisibleOnMap", "m_nPositionX", "m_nPositionY", "m_nTickHidden", "m_iLane", "m_nOwnerOnlyEntIndex", "m_flAngle"];

fn int(v: Option<&FieldValue>) -> Option<i64> {
    match v? {
        FieldValue::I32(n) => Some(i64::from(*n)),
        FieldValue::U32(n) => Some(i64::from(*n)),
        FieldValue::I64(n) => Some(*n),
        FieldValue::U64(n) => i64::try_from(*n).ok(),
        FieldValue::Bool(b) => Some(i64::from(*b)),
        FieldValue::F32(f) => Some(*f as i64),
        _ => None,
    }
}

#[derive(Clone, Copy)]
struct Hero {
    team: i64,
    hero: i64,
    alive: bool,
    pos: [f32; 2],
    reveal: f32,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(dem) = args.get(1).map(PathBuf::from) else {
        eprintln!("usage: vision_probe <replay.dem> [out dir]");
        std::process::exit(2);
    };
    let out = args.get(2).map_or_else(|| PathBuf::from("/tmp/vision-spike"), PathBuf::from);
    std::fs::create_dir_all(&out).expect("out dir");
    let (_, server_start) = mapcro_replay::parse::header(&dem).expect("a Deadlock replay");
    let parser = Parser::from_file(&dem).expect("opens");
    // `--names`: decode every class, so non-hero FOW entries resolve to a class name (slower).
    let all: Vec<String> = if args.iter().any(|a| a == "--names") {
        parser.parse_init().expect("signon").class_info().classes().iter().map(|c| c.network_name.to_string()).collect()
    } else {
        Vec::new()
    };
    let mut classes: HashSet<&str> = [TEAM, PAWN, RULES].into_iter().collect();
    classes.extend(all.iter().map(String::as_str));
    let w = |name: &str| std::io::BufWriter::new(std::fs::File::create(out.join(name)).expect("out file"));
    let (mut flips, mut secs, mut deaths) = (w("flips.tsv"), w("seconds.tsv"), w("deaths.tsv"));
    writeln!(flips, "game_s\ttick\tobserver\tent\thero\tvisible\tnearest_observer_dist\tfow_x\tfow_y\ttick_hidden").ok();
    writeln!(secs, "game_s\tent\thero\tteam\tx\ty\tvisible_to_enemy\tfow_x\tfow_y\tnearest_enemy_dist\treveal_age_s").ok();
    writeln!(deaths, "game_s\ttick\tent\thero\tteam\tvisible_to_enemy\tvisible_ticks_of_last_64\tnearest_enemy_dist").ok();

    let mut schema = String::new();
    let mut entry_keys: Vec<Vec<Option<u64>>> = Vec::new();
    let mut team_keys: Option<(Option<u64>, Option<u64>)> = None;
    let mut pawn_keys: Option<[Option<u64>; 9]> = None;
    let mut rule_keys: Option<[Option<u64>; 2]> = None;
    // (observer, ent) → visible, and a 64-tick history bitmask.
    let mut vis: HashMap<(i64, i32), (bool, u64)> = HashMap::new();
    // class → (entries seen, visible) and class → sample entity classes.
    let mut by_class: BTreeMap<i64, (u64, u64, BTreeMap<String, u64>)> = BTreeMap::new();
    let mut alive_prev: HashMap<i32, bool> = HashMap::new();
    let mut last_sec = i64::MIN;

    parser
        .run_to_end_with_events_filtered(&classes, |ctx, _events| {
            let sers = ctx.serializers();
            let (tcount, tteam) = *team_keys.get_or_insert_with(|| {
                if let Some(s) = sers.get(TEAM) {
                    for f in &s.fields {
                        if f.var_name.contains("FOW") {
                            let _ = writeln!(schema, "{} : {}", f.var_name, f.var_type);
                            if let Some(fs) = f.field_serializer.as_ref() {
                                for g in &fs.fields {
                                    let _ = writeln!(schema, "  .{} : {}", g.var_name, g.var_type);
                                    if let Some(hs) = g.field_serializer.as_ref() {
                                        for h in &hs.fields {
                                            let _ = writeln!(schema, "    .{} : {}", h.var_name, h.var_type);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                let k = |p: &str| sers.get(TEAM).and_then(|s| s.resolve_field_key(p));
                (k("m_vecFOWEntities"), k("m_iTeamNum"))
            });
            let pk = *pawn_keys.get_or_insert_with(|| {
                let k = |p: &str| sers.get(PAWN).and_then(|s| s.resolve_field_key(p));
                [
                    k(&format!("{ORIGIN}.m_cellX")),
                    k(&format!("{ORIGIN}.m_cellY")),
                    k(&format!("{ORIGIN}.m_cellZ")),
                    k(&format!("{ORIGIN}.m_vecX")),
                    k(&format!("{ORIGIN}.m_vecY")),
                    k(&format!("{ORIGIN}.m_vecZ")),
                    k("m_iTeamNum"),
                    k("m_lifeState"),
                    k("m_tLastPlayerRevealTime"),
                ]
            });
            let hero_key = sers.get(PAWN).and_then(|s| s.resolve_field_key("m_CCitadelHeroComponent.m_spawnedHero.m_nHeroID"));
            let rk = *rule_keys.get_or_insert_with(|| {
                let k = |p: &str| sers.get(RULES).and_then(|s| s.resolve_field_key(p));
                [k("m_pGameRules.m_nTotalPausedTicks"), k("m_pGameRules.m_flGameStartTime")]
            });
            let ents = ctx.entities();
            let Some(rules) = ents.iter().find(|(_, e)| e.class_name.as_ref() == RULES).map(|(_, e)| e) else { return };
            let start = f64::from(rules.get_f32(rk[1]));
            if start <= 0.0 {
                return;
            }
            let interval = f64::from(ctx.tick_interval());
            let now = (f64::from(ctx.tick() + server_start) - rules.get_i64(rk[0]) as f64) * interval;
            let game = now - start;
            if game < 0.0 {
                return;
            }

            let mut heroes: HashMap<i32, Hero> = HashMap::new();
            for (_, e) in ents.iter().filter(|(_, e)| e.active && e.class_name.as_ref() == PAWN) {
                let [x, y, _] = world_position(e, [pk[0], pk[1], pk[2]], [pk[3], pk[4], pk[5]]);
                heroes.insert(e.index, Hero {
                    team: e.get_i64(pk[6]),
                    hero: e.get_i64(hero_key),
                    alive: e.get_i64(pk[7]) == 0,
                    pos: [x, y],
                    reveal: e.get_f32(pk[8]),
                });
            }
            let nearest = |ent: i32, team: i64| -> f32 {
                let h = heroes[&ent];
                heroes
                    .values()
                    .filter(|o| o.team == team && o.alive)
                    .map(|o| ((o.pos[0] - h.pos[0]).powi(2) + (o.pos[1] - h.pos[1]).powi(2)).sqrt())
                    .fold(f32::INFINITY, f32::min)
            };

            // Each team's FOW list.
            let mut fow: HashMap<(i64, i32), (bool, i64, i64)> = HashMap::new();
            for (_, t) in ents.iter().filter(|(_, e)| e.active && e.class_name.as_ref() == TEAM) {
                let Some(observer @ (2 | 3)) = int(t.field_value(tteam)) else { continue };
                let n = int(t.field_value(tcount)).unwrap_or(0).max(0) as usize;
                let ser = sers.get(TEAM).expect("team serializer");
                while entry_keys.len() < n {
                    let i = entry_keys.len();
                    entry_keys.push(ENTRY.iter().map(|f| ser.resolve_field_key(&format!("m_vecFOWEntities.{i}.{f}"))).collect());
                }
                for k in &entry_keys[..n] {
                    let g = |j: usize| int(t.field_value(k[j]));
                    let class = g(0).unwrap_or(-1);
                    let idx = g(1).unwrap_or(-1);
                    let visible = g(3) == Some(1);
                    let c = by_class.entry(class).or_default();
                    c.0 += 1;
                    c.1 += u64::from(visible);
                    if c.2.len() < 8 || c.0.is_multiple_of(4096) {
                        let name = i32::try_from(idx).ok().and_then(|i| ents.get(i)).map_or("?".into(), |e| e.class_name.to_string());
                        *c.2.entry(name).or_default() += 1;
                    }
                    if class != 1 {
                        continue;
                    }
                    let Ok(ent) = i32::try_from(idx) else { continue };
                    if !heroes.contains_key(&ent) || heroes[&ent].team == observer {
                        continue;
                    }
                    let (fx, fy) = (g(4).unwrap_or(-1), g(5).unwrap_or(-1));
                    fow.insert((observer, ent), (visible, fx, fy));
                    let slot = vis.entry((observer, ent)).or_insert((!visible, 0));
                    slot.1 = (slot.1 << 1) | u64::from(visible);
                    if slot.0 != visible {
                        slot.0 = visible;
                        let h = heroes[&ent];
                        writeln!(flips, "{game:.3}\t{}\t{observer}\t{ent}\t{}\t{}\t{:.0}\t{fx}\t{fy}\t{}", ctx.tick(), h.hero, u8::from(visible), nearest(ent, observer), g(6).unwrap_or(-1)).ok();
                    }
                }
            }

            for (&ent, h) in &heroes {
                let enemy = 5 - h.team;
                let was = alive_prev.insert(ent, h.alive);
                if was == Some(true) && !h.alive {
                    let (v, hist) = vis.get(&(enemy, ent)).copied().unwrap_or((false, 0));
                    writeln!(deaths, "{game:.3}\t{}\t{ent}\t{}\t{}\t{}\t{}\t{:.0}", ctx.tick(), h.hero, h.team, u8::from(v), (hist >> 1).count_ones(), nearest(ent, enemy)).ok();
                }
            }

            let sec = game.floor() as i64;
            if sec == last_sec {
                return;
            }
            last_sec = sec;
            for (&ent, h) in &heroes {
                if !h.alive {
                    continue;
                }
                let enemy = 5 - h.team;
                let (v, fx, fy) = fow.get(&(enemy, ent)).copied().map_or(("?".into(), -1, -1), |(v, x, y)| (u8::from(v).to_string(), x, y));
                let age = if h.reveal > 0.0 { format!("{:.2}", now - f64::from(h.reveal)) } else { "-".into() };
                writeln!(secs, "{sec}\t{ent}\t{}\t{}\t{:.0}\t{:.0}\t{v}\t{fx}\t{fy}\t{:.0}\t{age}", h.hero, h.team, h.pos[0], h.pos[1], nearest(ent, enemy)).ok();
            }
        })
        .expect("parse");

    let _ = writeln!(schema, "\nm_eClass: entries, visible, sampled entity classes");
    for (c, (n, v, names)) in &by_class {
        let _ = writeln!(schema, "{c}\t{n}\t{v}\t{names:?}");
    }
    std::fs::write(out.join("schema.txt"), schema).expect("schema");
}
