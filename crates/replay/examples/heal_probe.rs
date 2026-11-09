//! Healing pickup probe: what a replay says about the map's floating health pickups. Read-only
//! exploration (docs/research/map-objectives-audit.md, "Healing pickups").
//!
//! `cargo run -p mapcro-replay --release --example heal_probe -- <replay.dem> [class…]`
//!
//! For each class (default `CCitadel_PickupSpawner` and `CCitadel_Pickup_Health`) it prints the
//! serializer's top-level fields, then every change of a field that isn't a position, every
//! entity that appears or goes, and every change of its `active` (in the recording's view), with
//! the match-clock second. No controller is read, so no Steam id is.

use boon::{FieldValue, Parser, world_position};
use std::collections::{BTreeMap, HashMap, HashSet};

const RULES: &str = "CCitadelGameRulesProxy";
const ORIGIN: &str = "CBodyComponent.m_skeletonInstance.m_vecOrigin";

fn show(v: &FieldValue) -> String {
    let s = format!("{v:?}");
    if s.len() > 60 { format!("{}…", &s[..60]) } else { s }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dem = std::path::PathBuf::from(args.get(1).expect("usage: heal_probe <replay.dem> [class…]"));
    let wanted: Vec<String> =
        if args.len() > 2 { args[2..].to_vec() } else { vec!["CCitadel_PickupSpawner".into(), "CCitadel_Pickup_Health".into()] };
    let (_, server_start) = mapcro_replay::parse::header(&dem).expect("a Deadlock replay");
    let parser = Parser::from_file(&dem).expect("opens");
    let mut classes: HashSet<&str> = wanted.iter().map(String::as_str).collect();
    classes.insert(RULES);
    // Per class: packed key → field name (top level, and one level into components).
    let mut names: HashMap<String, HashMap<u64, String>> = HashMap::new();
    let mut last: BTreeMap<(i32, u32), (bool, BTreeMap<u64, String>)> = BTreeMap::new();
    let mut header_done = false;
    parser
        .run_to_end_with_events_filtered(&classes, |ctx, _| {
            let sers = ctx.serializers();
            if !header_done {
                for c in &wanted {
                    let Some(s) = sers.get(c) else { continue };
                    println!("# {c} fields");
                    let mut m = HashMap::new();
                    for f in &s.fields {
                        println!("{} : {}", f.var_name, f.var_type);
                        if let Some(k) = s.resolve_field_key(&f.var_name) {
                            m.insert(k, f.var_name.to_string());
                        }
                        if let Some(fs) = f.field_serializer.as_ref() {
                            for g in &fs.fields {
                                let p = format!("{}.{}", f.var_name, g.var_name);
                                if let Some(k) = s.resolve_field_key(&p) {
                                    m.insert(k, p);
                                }
                            }
                        }
                    }
                    names.insert(c.clone(), m);
                }
                header_done = true;
            }
            let Some(rules) = ctx.entities().iter().find(|(_, e)| e.class_name.as_ref() == RULES).map(|(_, e)| e) else { return };
            let rk = |p: &str| sers.get(RULES).and_then(|s| s.resolve_field_key(p));
            let start = f64::from(rules.get_f32(rk("m_pGameRules.m_flGameStartTime")));
            if start <= 0.0 {
                return;
            }
            let paused = rules.get_i64(rk("m_pGameRules.m_nTotalPausedTicks")) as f64;
            let game = (f64::from(ctx.tick() + server_start) - paused) * f64::from(ctx.tick_interval()) - start;
            let mut now = HashSet::new();
            for (_, e) in ctx.entities().iter() {
                let class = e.class_name.as_ref();
                if class == RULES {
                    continue;
                }
                let Some(m) = names.get(class) else { continue };
                let id = (e.index, e.serial);
                now.insert(id);
                let vals: BTreeMap<u64, String> = e
                    .fields
                    .iter()
                    .filter(|(k, _)| m.get(*k).is_some_and(|n| !n.contains("m_vec") && !n.contains("m_cell") && !n.contains("Origin") && !n.contains("m_ang")))
                    .map(|(k, v)| (*k, show(v)))
                    .collect();
                let s = sers.get(class).expect("serializer");
                let ok = |p: &str| s.resolve_field_key(&format!("{ORIGIN}.{p}"));
                let p = world_position(e, [ok("m_cellX"), ok("m_cellY"), ok("m_cellZ")], [ok("m_vecX"), ok("m_vecY"), ok("m_vecZ")]);
                let at = format!("({:.0},{:.0})", p[0], p[1]);
                match last.get(&id) {
                    None => {
                        let all: Vec<String> = vals.iter().map(|(k, v)| format!("{}={v}", m[k])).collect();
                        println!("{game:.1}\t{class}\t{}\t{at}\tNEW active={}\t{}", e.index, e.active, all.join(" "));
                    }
                    Some((act, old)) => {
                        if *act != e.active {
                            println!("{game:.1}\t{class}\t{}\t{at}\tactive={}", e.index, e.active);
                        }
                        for (k, v) in &vals {
                            if old.get(k) != Some(v) {
                                println!("{game:.1}\t{class}\t{}\t{at}\t{}={v}", e.index, m[k]);
                            }
                        }
                    }
                }
                last.insert(id, (e.active, vals));
            }
            let gone: Vec<(i32, u32)> = last.keys().filter(|id| !now.contains(*id)).copied().collect();
            for id in gone {
                println!("{game:.1}\tGONE\t{}", id.0);
                last.remove(&id);
            }
        })
        .expect("parses");
}
