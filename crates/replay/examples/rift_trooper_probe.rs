//! Rift trooper probe (second pass, feedback #5): does anything in the recording mark the
//! troopers a captured rift spawns? Writes JSON lines to the directory given (scratch, /tmp):
//! - `captures.jsonl`: each rise of the rules' `m_nKothScoringTeam` above 0, with the tick and
//!   the cash-in location;
//! - `troopers.jsonl`: every `CNPC_Trooper` life, 2 s into it (lives shorter than that aren't
//!   dumped): **every** decoded field (name → value), the full entry of each team's
//!   `m_vecFOWEntities` that tracks it, and the modifier tokens (`ActiveModifiers`
//!   `modifier_subclass`) applied to it so far. The entities are pooled (~200 on 129738985),
//!   so a life is a new `m_flCreateTime` or serial on an index, not a new entity;
//! - `mods.jsonl`: each life's modifier tokens over the whole life, written when it ends.
//!
//! Then compare the two groups in a script (aggregates only; no player data is read).
//! `cargo run -p mapcro-replay --release --example rift_trooper_probe -- <replay.dem> <out dir>`
use boon::{FieldValue, ModifierChangeKind, ModifierState, Parser};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Write;

const TROOPER: &str = "CNPC_Trooper";
const RULES: &str = "CCitadelGameRulesProxy";
const TEAM: &str = "CCitadelTeam";
/// 2 s at 64 ticks a second.
const SETTLE: i32 = 128;

fn val(v: &FieldValue) -> serde_json::Value {
    match v {
        FieldValue::Bool(b) => (*b).into(),
        FieldValue::I32(x) => (*x).into(),
        FieldValue::I64(x) => (*x).into(),
        FieldValue::U32(x) => (*x).into(),
        FieldValue::U64(x) => x.to_string().into(),
        FieldValue::F32(x) => (((*x as f64) * 1000.0).round() / 1000.0).into(),
        FieldValue::String(s) => String::from_utf8_lossy(s).into_owned().into(),
        other => format!("{other:?}").into(),
    }
}

struct Live {
    serial: u32,
    /// Alive (`m_lifeState` 0, health above 0) at the last tick: the entities are pooled and
    /// keep their serial and `m_flCreateTime`, so a new life is a rise of this.
    alive: bool,
    first: i32,
    dumped: bool,
    mods: BTreeSet<u32>,
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let out = std::path::PathBuf::from(&a[2]);
    std::fs::create_dir_all(&out).expect("out dir");
    let mut caps = std::fs::File::create(out.join("captures.jsonl")).expect("captures");
    let mut lives =
        std::io::BufWriter::new(std::fs::File::create(out.join("mods.jsonl")).expect("mods"));
    let mut trs = std::io::BufWriter::new(
        std::fs::File::create(out.join("troopers.jsonl")).expect("troopers"),
    );
    let classes: HashSet<&str> = [
        TROOPER,
        RULES,
        TEAM,
        "CCitadelItemKothSpawner",
        "CCitadel_KothCashIn",
    ]
    .into_iter()
    .collect();
    let mut live: HashMap<i32, Live> = HashMap::new();
    let mut mods = ModifierState::default();
    let mut scoring_was = 0i64;
    let mut names: HashMap<(&'static str, u64), String> = HashMap::new();
    let mut n_dumped = 0u32;
    Parser::from_file(std::path::Path::new(&a[1]))
        .expect("opens")
        .run_to_end_filtered(&classes, |ctx| {
            let tick = ctx.tick();
            let ents = ctx.entities();
            let sers = ctx.serializers();
            // Rift captures.
            if let Some(rs) = sers.get(RULES)
                && let Some((_, r)) = ents.iter().find(|(_, e)| e.class_name.as_ref() == RULES)
            {
                let s = r.get_i64(rs.resolve_field_key("m_pGameRules.m_nKothScoringTeam"));
                if s > 0 && scoring_was <= 0 {
                    let loc = r.get_vector3(rs.resolve_field_key("m_pGameRules.m_vKothCashInCurrentLocation"));
                    let started = r.get_f32(rs.resolve_field_key("m_pGameRules.m_timeKothCashInStarted"));
                    writeln!(caps, "{}", serde_json::json!({"tick": tick, "team": s, "loc": loc, "cash_in_started": started})).ok();
                }
                scoring_was = s;
            }
            let changes = mods.update(ctx);
            // Troopers: new ones, and the ones due a dump.
            let mut now = HashSet::new();
            let mut due: Vec<i32> = Vec::new();
            if tick % 3840 == 0 && let Some(ts) = sers.get(TROOPER) {
                let (life, hp) = (ts.resolve_field_key("m_lifeState"), ts.resolve_field_key("m_iHealth"));
                let all: Vec<_> = ents.iter().filter(|(_, e)| e.class_name.as_ref() == TROOPER).collect();
                let alive = all.iter().filter(|(_, e)| e.get_i64(life) == 0 && e.get_i64(hp) > 0).count();
                let active = all.iter().filter(|(_, e)| e.active).count();
                eprintln!("min {}: {} troopers, {alive} alive, {active} active, {} lives", tick / 3840, all.len(), live.len());
            }
            let tk = sers.get(TROOPER).map(|s| (s.resolve_field_key("m_lifeState"), s.resolve_field_key("m_iHealth")));
            for (_, e) in ents.iter().filter(|(_, e)| e.class_name.as_ref() == TROOPER) {
                now.insert(e.index);
                let alive = tk.is_some_and(|(life, hp)| e.get_i64(life) == 0 && e.get_i64(hp) > 0);
                let fresh = || Live { serial: e.serial, alive, first: tick, dumped: false, mods: BTreeSet::new() };
                let l = live.entry(e.index).or_insert_with(fresh);
                let reborn = alive && !l.alive;
                l.alive = alive;
                if l.serial != e.serial || reborn {
                    writeln!(lives, "{}", serde_json::json!({"index": e.index, "first": l.first, "last": tick, "mods": l.mods})).ok();
                    *l = fresh();
                }
                if alive && !l.dumped && tick - l.first >= SETTLE {
                    due.push(e.index);
                }
            }
            // Modifiers applied to troopers, after this tick's lives start (one applied on the
            // spawn tick belongs to the new life).
            for ch in changes {
                if ch.kind != ModifierChangeKind::Applied {
                    continue;
                }
                let Some(p) = ch.entry.parent else { continue };
                let idx = (p & boon::ENTITY_HANDLE_INDEX_MASK) as i32;
                if let (Some(l), Some(m)) = (live.get_mut(&idx), ch.entry.modifier_subclass) {
                    l.mods.insert(m);
                }
            }
            let mut end = |live: &mut HashMap<i32, Live>| {
                live.retain(|i, l| {
                    let keep = now.contains(i);
                    if !keep {
                        writeln!(lives, "{}", serde_json::json!({"index": i, "first": l.first, "last": tick, "mods": l.mods})).ok();
                    }
                    keep
                });
            };
            if due.is_empty() {
                end(&mut live);
                return;
            }
            let Some(ts) = sers.get(TROOPER) else { return };
            // Each team's FOW entries, by tracked entity index.
            let mut fow: HashMap<i32, BTreeMap<i64, serde_json::Map<String, serde_json::Value>>> = HashMap::new();
            if let Some(tser) = sers.get(TEAM) {
                let team_key = tser.resolve_field_key("m_iTeamNum");
                for (_, t) in ents.iter().filter(|(_, e)| e.class_name.as_ref() == TEAM) {
                    let team = t.get_i64(team_key);
                    let mut entries: BTreeMap<usize, serde_json::Map<String, serde_json::Value>> = BTreeMap::new();
                    for (k, v) in &t.fields {
                        let name = names.entry((TEAM, *k)).or_insert_with(|| tser.field_name_for_key(*k).unwrap_or_default());
                        let Some(rest) = name.strip_prefix("m_vecFOWEntities.") else { continue };
                        let Some((i, f)) = rest.split_once('.') else { continue };
                        let Ok(i) = i.parse::<usize>() else { continue };
                        entries.entry(i).or_default().insert(f.to_owned(), val(v));
                    }
                    for (_, m) in entries {
                        if let Some(ix) = m.get("m_nEntIndex").and_then(serde_json::Value::as_i64) {
                            fow.entry(ix as i32).or_default().insert(team, m);
                        }
                    }
                }
            }
            for idx in due {
                let Some(e) = ents.get(idx) else { continue };
                let mut fields = serde_json::Map::new();
                for (k, v) in &e.fields {
                    let name = names.entry((TROOPER, *k)).or_insert_with(|| ts.field_name_for_key(*k).unwrap_or_else(|| format!("?{k}")));
                    fields.insert(name.clone(), val(v));
                }
                let l = live.get_mut(&idx).expect("live");
                l.dumped = true;
                let f: serde_json::Map<String, serde_json::Value> = fow.get(&idx).map(|m| m.iter().map(|(t, v)| (t.to_string(), serde_json::Value::Object(v.clone()))).collect()).unwrap_or_default();
                writeln!(trs, "{}", serde_json::json!({"index": idx, "first": l.first, "at": tick, "active": e.active, "fields": fields, "fow": f, "mods": l.mods})).ok();
                n_dumped += 1;
            }
            end(&mut live);
        })
        .expect("parses");
    for (i, l) in &live {
        writeln!(
            lives,
            "{}",
            serde_json::json!({"index": i, "first": l.first, "last": null, "mods": l.mods})
        )
        .ok();
    }
    eprintln!("{n_dumped} troopers dumped");
}
