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

struct ClassInfo {
    /// Tracked (non-position) field key → dotted field name.
    names: HashMap<u64, String>,
    cells: [Option<u64>; 3],
    vecs: [Option<u64>; 3],
}

fn is_tracked(name: &str) -> bool {
    !name.contains("m_vec") && !name.contains("m_cell") && !name.contains("Origin") && !name.contains("m_ang")
}

fn same_f32_slice(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}

fn same_value(a: &FieldValue, b: &FieldValue) -> bool {
    match (a, b) {
        (FieldValue::Bool(x), FieldValue::Bool(y)) => x == y,
        (FieldValue::I32(x), FieldValue::I32(y)) => x == y,
        (FieldValue::I64(x), FieldValue::I64(y)) => x == y,
        (FieldValue::U32(x), FieldValue::U32(y)) => x == y,
        (FieldValue::U64(x), FieldValue::U64(y)) => x == y,
        (FieldValue::F32(x), FieldValue::F32(y)) => x.to_bits() == y.to_bits(),
        (FieldValue::String(x), FieldValue::String(y)) => x == y,
        (FieldValue::Vector2(x), FieldValue::Vector2(y)) => same_f32_slice(x, y),
        (FieldValue::Vector3(x), FieldValue::Vector3(y)) => same_f32_slice(x, y),
        (FieldValue::Vector4(x), FieldValue::Vector4(y)) => same_f32_slice(x, y),
        (FieldValue::FloatVector(x), FieldValue::FloatVector(y)) => same_f32_slice(x, y),
        (FieldValue::QAngle(x), FieldValue::QAngle(y)) => same_f32_slice(x, y),
        // `FieldValue` is `#[non_exhaustive]`: distinct variants aren't equal, and any future
        // variant falls back to formatted comparison only if both have the same discriminant.
        _ if std::mem::discriminant(a) != std::mem::discriminant(b) => false,
        _ => show(a) == show(b),
    }
}

fn show(v: &FieldValue) -> String {
    let s = format!("{v:?}");
    if s.len() > 60 { format!("{}…", &s[..60]) } else { s }
}

fn pos_of<'a>(cache: &'a mut Option<String>, e: &boon::Entity, ci: &ClassInfo) -> &'a str {
    cache
        .get_or_insert_with(|| {
            let p = world_position(e, ci.cells, ci.vecs);
            format!("({:.0},{:.0})", p[0], p[1])
        })
        .as_str()
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
    // Per class: resolved origin keys and packed key → tracked field name.
    let mut info: HashMap<String, ClassInfo> = HashMap::new();
    let mut rules_keys: Option<(Option<u64>, Option<u64>)> = None;
    let mut last: BTreeMap<(i32, u32), (bool, BTreeMap<u64, FieldValue>)> = BTreeMap::new();
    let mut header_done = false;
    parser
        .run_to_end_with_events_filtered(&classes, |ctx, _| {
            let sers = ctx.serializers();
            if !header_done {
                if let Some(rs) = sers.get(RULES) {
                    rules_keys = Some((
                        rs.resolve_field_key("m_pGameRules.m_flGameStartTime"),
                        rs.resolve_field_key("m_pGameRules.m_nTotalPausedTicks"),
                    ));
                }
                for c in &wanted {
                    let Some(s) = sers.get(c) else { continue };
                    println!("# {c} fields");
                    let mut m = HashMap::new();
                    for f in &s.fields {
                        println!("{} : {}", f.var_name, f.var_type);
                        if is_tracked(&f.var_name)
                            && let Some(k) = s.resolve_field_key(&f.var_name)
                        {
                            m.insert(k, f.var_name.to_string());
                        }
                        if let Some(fs) = f.field_serializer.as_ref() {
                            for g in &fs.fields {
                                let p = format!("{}.{}", f.var_name, g.var_name);
                                if is_tracked(&p)
                                    && let Some(k) = s.resolve_field_key(&p)
                                {
                                    m.insert(k, p);
                                }
                            }
                        }
                    }
                    let ok = |p: &str| s.resolve_field_key(&format!("{ORIGIN}.{p}"));
                    info.insert(
                        c.clone(),
                        ClassInfo {
                            names: m,
                            cells: [ok("m_cellX"), ok("m_cellY"), ok("m_cellZ")],
                            vecs: [ok("m_vecX"), ok("m_vecY"), ok("m_vecZ")],
                        },
                    );
                }
                header_done = true;
            }
            let Some(rules) = ctx.entities().iter().find(|(_, e)| e.class_name.as_ref() == RULES).map(|(_, e)| e) else { return };
            let (start_key, paused_key) = *rules_keys.get_or_insert_with(|| {
                let rk = |p: &str| sers.get(RULES).and_then(|s| s.resolve_field_key(p));
                (rk("m_pGameRules.m_flGameStartTime"), rk("m_pGameRules.m_nTotalPausedTicks"))
            });
            let start = f64::from(rules.get_f32(start_key));
            if start <= 0.0 {
                return;
            }
            let paused = rules.get_i64(paused_key) as f64;
            let game = (f64::from(ctx.tick() + server_start) - paused) * f64::from(ctx.tick_interval()) - start;
            let mut now = HashSet::new();
            for (_, e) in ctx.entities().iter() {
                let class = e.class_name.as_ref();
                if class == RULES {
                    continue;
                }
                let Some(ci) = info.get(class) else { continue };
                let id = (e.index, e.serial);
                now.insert(id);
                let mut at_cache: Option<String> = None;
                match last.get_mut(&id) {
                    None => {
                        let vals: BTreeMap<u64, FieldValue> = e
                            .fields
                            .iter()
                            .filter(|(k, _)| ci.names.contains_key(*k))
                            .map(|(k, v)| (*k, v.clone()))
                            .collect();
                        let all: Vec<String> = vals.iter().map(|(k, v)| format!("{}={}", ci.names[k], show(v))).collect();
                        println!("{game:.1}\t{class}\t{}\t{}\tNEW active={}\t{}", e.index, pos_of(&mut at_cache, e, ci), e.active, all.join(" "));
                        last.insert(id, (e.active, vals));
                    }
                    Some((act, old)) => {
                        if *act != e.active {
                            println!("{game:.1}\t{class}\t{}\t{}\tactive={}", e.index, pos_of(&mut at_cache, e, ci), e.active);
                            *act = e.active;
                        }
                        let mut seen = 0usize;
                        for (k, v) in &e.fields {
                            let Some(name) = ci.names.get(k) else { continue };
                            seen += 1;
                            if old.get(k).is_none_or(|prev| !same_value(prev, v)) {
                                println!("{game:.1}\t{class}\t{}\t{}\t{name}={}", e.index, pos_of(&mut at_cache, e, ci), show(v));
                                old.insert(*k, v.clone());
                            }
                        }
                        if seen != old.len() {
                            old.retain(|k, _| e.fields.contains_key(k));
                        }
                    }
                }
            }
            let gone: Vec<(i32, u32)> = last.keys().filter(|id| !now.contains(*id)).copied().collect();
            for id in gone {
                println!("{game:.1}\tGONE\t{}", id.0);
                last.remove(&id);
            }
        })
        .expect("parses");
}
