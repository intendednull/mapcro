//! Map-objective census: every neutral-objective entity class in one replay, with how many
//! distinct entities it had, when, and where (docs/research/map-objectives-audit.md). Read-only.
//!
//! `cargo run -p mapcro-replay --release --example objective_census -- <replay.dem>`
//!
//! Prints, per class whose name looks neutral or objective-like, the distinct `(index, serial)`
//! count, the first and last match-clock second seen, and its distinct positions (rounded to
//! 16 units) with the second each was first seen. Then the game rules' camp-timer slots. No
//! controller is read, so no Steam id is.

use boon::{Parser, world_position};
use std::collections::{BTreeMap, HashSet};

const RULES: &str = "CCitadelGameRulesProxy";
const ORIGIN: &str = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
const BODY_ORIGIN: &str = "CBodyComponent";
/// Class-name fragments that are neutral objectives, or might be.
const NEUTRAL: [&str; 16] = [
    "Neutral", "Sinner", "MidBoss", "Breakable", "Punchable", "Koth", "Idol", "PickupItemSpawner", "Pickup_Modifier", "PickupRejuv",
    "Statue", "Vault", "Camp", "Boss", "Shrine", "Destroyable",
];

/// A class's origin field keys: cell and offset, x/y/z.
type OriginKeys = ([Option<u64>; 3], [Option<u64>; 3]);

#[derive(Default)]
struct Class {
    ents: HashSet<(i32, u32)>,
    first: f64,
    last: f64,
    /// Rounded position → first second seen.
    at: BTreeMap<(i32, i32, i32), f64>,
}

fn main() {
    let dem = std::env::args().nth(1).expect("usage: objective_census <replay.dem>");
    let dem = std::path::PathBuf::from(dem);
    let (_, server_start) = mapcro_replay::parse::header(&dem).expect("a Deadlock replay");
    let parser = Parser::from_file(&dem).expect("opens");
    let names: Vec<String> = parser
        .parse_init()
        .expect("signon")
        .class_info()
        .classes()
        .iter()
        .map(|c| c.network_name.to_string())
        .filter(|n| n == RULES || NEUTRAL.iter().any(|f| n.contains(f)))
        .collect();
    let classes: HashSet<&str> = names.iter().map(String::as_str).collect();
    let mut seen: BTreeMap<String, Class> = BTreeMap::new();
    let mut keys: BTreeMap<String, OriginKeys> = BTreeMap::new();
    let mut slots: Vec<([f32; 3], bool)> = Vec::new();
    parser
        .run_to_end_with_events_filtered(&classes, |ctx, _| {
            let sers = ctx.serializers();
            let Some(rules) = ctx.entities().iter().find(|(_, e)| e.class_name.as_ref() == RULES).map(|(_, e)| e) else { return };
            let rk = |p: &str| sers.get(RULES).and_then(|s| s.resolve_field_key(p));
            let start = f64::from(rules.get_f32(rk("m_pGameRules.m_flGameStartTime")));
            if start <= 0.0 {
                return;
            }
            let paused = rules.get_i64(rk("m_pGameRules.m_nTotalPausedTicks")) as f64;
            let game = (f64::from(ctx.tick() + server_start) - paused) * f64::from(ctx.tick_interval()) - start;
            if slots.is_empty() {
                let n = rules.get_i64(rk("m_pGameRules.m_vecNeutralCampTimerOrigins")).max(0);
                for i in 0..n {
                    let o = rules.get_vector3(rk(&format!("m_pGameRules.m_vecNeutralCampTimerOrigins.{i}")));
                    slots.push((o, rules.get_bool(rk(&format!("m_pGameRules.m_vecNeutralCampTimerIsMidBoss.{i}")))));
                }
            }
            for (_, e) in ctx.entities().iter() {
                let class = e.class_name.as_ref();
                if class == RULES {
                    continue;
                }
                let (cell, vec) = *keys.entry(class.to_owned()).or_insert_with(|| {
                    let Some(s) = sers.get(class) else { return ([None; 3], [None; 3]) };
                    let o = if s.resolve_field_key(&format!("{ORIGIN}.m_cellX")).is_some() { ORIGIN } else { BODY_ORIGIN };
                    let k = |a: &str| s.resolve_field_key(&format!("{o}.{a}"));
                    ([k("m_cellX"), k("m_cellY"), k("m_cellZ")], [k("m_vecX"), k("m_vecY"), k("m_vecZ")])
                });
                let c = seen.entry(class.to_owned()).or_insert_with(|| Class { first: game, ..Class::default() });
                c.last = game;
                if c.ents.insert((e.index, e.serial)) {
                    let p = world_position(e, cell, vec);
                    let r = |v: f32| ((v / 16.0).round() * 16.0) as i32;
                    c.at.entry((r(p[0]), r(p[1]), r(p[2]))).or_insert(game);
                }
            }
        })
        .expect("parses");
    println!("# class\tdistinct\tfirst_s\tlast_s\tpositions");
    for (name, c) in &seen {
        println!("{name}\t{}\t{:.1}\t{:.1}\t{}", c.ents.len(), c.first, c.last, c.at.len());
    }
    for (name, c) in &seen {
        if c.at.len() > 60 {
            continue;
        }
        println!("## {name}");
        for ((x, y, z), t) in &c.at {
            println!("{x}\t{y}\t{z}\t{t:.1}");
        }
    }
    println!("# camp timer slots: {} ({} mid boss)", slots.len(), slots.iter().filter(|s| s.1).count());
    for (o, mid) in &slots {
        println!("{:.0}\t{:.0}\t{:.0}\t{mid}", o[0], o[1], o[2]);
    }
}
