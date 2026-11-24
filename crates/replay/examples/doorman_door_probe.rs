//! Doorman doorway probe (Stage 0): inspect networked entities, ability fields, lifecycle,
//! coordinates, orientation, team/owner, FOW visibility (`CCitadelTeam.m_vecFOWEntities`),
//! user messages (`CCitadelUserMsgEntityPortalled`, msg 361), and `ActiveModifiers` for
//! The Doorman (`hero_id == 69`) in a standard 6v6 replay.
//!
//! Privacy: never reads player names or account/Steam IDs. Outputs key everything by hero_id,
//! team, entity index, and token.
//!
//! `cargo run -p mapcro-replay --release --example doorman_door_probe -- <replay.dem> [out dir]`

use boon::{FieldValue, ModifierChangeKind, ModifierState, Parser, world_position};
use mapcro_replay::timeline::token;
use prost::Message;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Write as _;
use std::path::PathBuf;

const CONTROLLER: &str = "CCitadelPlayerController";
const PAWN: &str = "CCitadelPlayerPawn";
const RULES: &str = "CCitadelGameRulesProxy";
const TEAM: &str = "CCitadelTeam";
const DOORWAY_PORTAL: &str = "CCitadel_DoorwayPortal";
const DOORWAY_ABILITY: &str = "CCitadel_Ability_Doorman_Doorway";
const DOORMAN_HERO_ID: u32 = 69;
const ENTITY_PORTALLED: u32 = 361;
const IMPORTANT_ABILITY_USED: u32 = 365;
const ORIGIN_SKEL: &str = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
const ORIGIN_BODY: &str = "CBodyComponent";
const INVALID_HANDLE: u32 = 0x00FF_FFFF;
const MAX_FOW: usize = 512;

fn int(v: Option<&FieldValue>) -> Option<i64> {
    match v? {
        FieldValue::I32(n) => Some(i64::from(*n)),
        FieldValue::U32(n) => Some(i64::from(*n)),
        FieldValue::I64(n) => Some(*n),
        FieldValue::U64(n) => i64::try_from(*n).ok(),
        FieldValue::Bool(b) => Some(i64::from(*b)),
        _ => None,
    }
}

fn str_val(v: Option<&FieldValue>) -> Option<String> {
    match v? {
        FieldValue::String(s) => Some(String::from_utf8_lossy(s).into_owned()),
        _ => None,
    }
}

fn val_json(v: &FieldValue) -> serde_json::Value {
    match v {
        FieldValue::Bool(b) => (*b).into(),
        FieldValue::I32(x) => (*x).into(),
        FieldValue::I64(x) => (*x).into(),
        FieldValue::U32(x) => (*x).into(),
        FieldValue::U64(x) => x.to_string().into(),
        FieldValue::F32(x) => (((f64::from(*x)) * 1000.0).round() / 1000.0).into(),
        FieldValue::String(s) => String::from_utf8_lossy(s).into_owned().into(),
        other => format!("{other:?}").into(),
    }
}

fn walk_fields(
    prefix: &str,
    fields: &[std::sync::Arc<boon::SerializerField>],
    depth: usize,
    out: &mut Vec<(String, String)>,
) {
    for f in fields {
        let p = if prefix.is_empty() { f.var_name.to_string() } else { format!("{prefix}.{}", f.var_name) };
        out.push((p.clone(), f.var_type.to_string()));
        if depth < 6
            && let Some(s) = f.field_serializer.as_ref()
        {
            walk_fields(&p, &s.fields, depth + 1, out);
        }
    }
}

fn matches_door_kw(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    l.contains("door") || l.contains("portal") || l.contains("doorman")
}

#[derive(Clone, Copy, Default)]
struct PosKeys {
    cell: [Option<u64>; 3],
    vec: [Option<u64>; 3],
}

impl PosKeys {
    fn of(s: &boon::Serializer) -> Option<Self> {
        let prefix = if s.resolve_field_key(&format!("{ORIGIN_SKEL}.m_cellX")).is_some() {
            ORIGIN_SKEL
        } else if s.resolve_field_key(&format!("{ORIGIN_BODY}.m_cellX")).is_some() {
            ORIGIN_BODY
        } else {
            return None;
        };
        let k = |f: &str| s.resolve_field_key(&format!("{prefix}.{f}"));
        Some(Self {
            cell: [k("m_cellX"), k("m_cellY"), k("m_cellZ")],
            vec: [k("m_vecX"), k("m_vecY"), k("m_vecZ")],
        })
    }

    fn pos(self, e: &boon::Entity) -> [f32; 3] {
        world_position(e, self.cell, self.vec)
    }
}

struct TrackedEntity {
    class: String,
    serial: u32,
    first_game_s: f64,
    active: bool,
    active_transitions: u32,
    snapshot: BTreeMap<String, serde_json::Value>,
}

struct DoorSummary {
    index: i32,
    serial: u32,
    team: i64,
    spawn_s: f64,
    link_s: Option<f64>,
    delete_s: Option<f64>,
    initial_linked: Option<i32>,
    partner: Option<i32>,
    pos: [f32; 3],
    rot: Option<String>,
    own_fow_flips: Vec<(f64, bool)>,
    enemy_fow_flips: Vec<(f64, bool)>,
    fow_heights: BTreeSet<i64>,
    fow_css_classes: BTreeSet<String>,
}

fn server_clock(server_tick: i64, paused_ticks: i64, game_paused: bool, pause_start: i64, interval: f64) -> f64 {
    let paused = if game_paused && pause_start > 0 {
        paused_ticks + (server_tick - pause_start).max(0)
    } else {
        paused_ticks
    };
    (server_tick - paused) as f64 * interval
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(dem) = args.get(1).map(PathBuf::from) else {
        eprintln!("usage: doorman_door_probe <replay.dem> [out dir]");
        std::process::exit(2);
    };
    let out_dir = args.get(2).map_or_else(|| PathBuf::from("/tmp/doorman-probe/out"), PathBuf::from);
    std::fs::create_dir_all(&out_dir).expect("create out dir");

    let (build, server_start) = mapcro_replay::parse::header(&dem).expect("valid Deadlock replay");
    let parser = Parser::from_file(&dem).expect("open demo");
    let send_tables = parser.parse_send_tables().expect("parse send tables");
    let class_info = parser.parse_class_info().expect("parse class info");

    // 1. Schema scan.
    let mut schema_out = std::io::BufWriter::new(std::fs::File::create(out_dir.join("schema.txt")).expect("schema.txt"));
    let mut door_classes: Vec<String> = Vec::new();
    let mut all_class_names: Vec<String> = class_info.classes().iter().map(|c| c.network_name.to_string()).collect();
    all_class_names.sort();
    all_class_names.dedup();

    writeln!(schema_out, "=== Build {build}, server_start={server_start}, total_serializers={} ===", send_tables.len()).ok();
    writeln!(schema_out, "\n=== Classes matching door/portal/doorman ===").ok();
    for name in &all_class_names {
        if matches_door_kw(name) {
            door_classes.push(name.clone());
            writeln!(schema_out, "\n[CLASS] {name}").ok();
            if let Some(ser) = send_tables.get(name) {
                let mut fields = Vec::new();
                walk_fields("", &ser.fields, 0, &mut fields);
                for (p, ty) in fields {
                    writeln!(schema_out, "  {p}\t{ty}").ok();
                }
            }
        }
    }

    writeln!(schema_out, "\n=== Other classes with fields matching door/portal/doorman ===").ok();
    for name in &all_class_names {
        if matches_door_kw(name) {
            continue;
        }
        if let Some(ser) = send_tables.get(name) {
            let mut fields = Vec::new();
            walk_fields("", &ser.fields, 0, &mut fields);
            for (p, ty) in fields {
                if matches_door_kw(&p) {
                    writeln!(schema_out, "  {name}\t{p}\t{ty}").ok();
                }
            }
        }
    }
    schema_out.flush().ok();

    println!("build={build} server_start={server_start} door_classes={door_classes:?}");

    // 2. Full replay pass.
    let mut classes: HashSet<&str> = [CONTROLLER, PAWN, RULES, TEAM].into_iter().collect();
    for c in &door_classes {
        classes.insert(c.as_str());
    }
    let event_types: HashSet<u32> = [ENTITY_PORTALLED, IMPORTANT_ABILITY_USED].into_iter().collect();

    let mut events_file = std::io::BufWriter::new(std::fs::File::create(out_dir.join("door_events.jsonl")).expect("door_events.jsonl"));
    let mut fow_file = std::io::BufWriter::new(std::fs::File::create(out_dir.join("fow_flips.jsonl")).expect("fow_flips.jsonl"));
    let mut portalled_file = std::io::BufWriter::new(std::fs::File::create(out_dir.join("portalled.jsonl")).expect("portalled.jsonl"));
    let mut mods_file = std::io::BufWriter::new(std::fs::File::create(out_dir.join("doorman_mods.jsonl")).expect("doorman_mods.jsonl"));

    let mut field_name_cache: HashMap<(String, u64), String> = HashMap::new();
    let mut pos_keys: HashMap<String, Option<PosKeys>> = HashMap::new();

    let mut rules_keys: Option<[Option<u64>; 6]> = None;
    let mut ctrl_keys: Option<[Option<u64>; 3]> = None;
    let mut pawn_keys: Option<[Option<u64>; 2]> = None;
    let mut team_keys: Option<[Option<u64>; 2]> = None;
    let mut door_keys: Option<[Option<u64>; 4]> = None;
    let mut fow_keys: Vec<[Option<u64>; 11]> = Vec::new();

    let mut game_mode: i64 = 0;
    let mut winner: i64 = 0;
    let mut over = false;
    let mut last_game_s: f64 = 0.0;

    let mut doormen: BTreeMap<i32, (i64, Option<i32>)> = BTreeMap::new();
    let mut live: HashMap<i32, TrackedEntity> = HashMap::new();
    let mut door_summaries: Vec<DoorSummary> = Vec::new();
    let mut active_door_slot: HashMap<i32, usize> = HashMap::new();

    let mut class_spawn_counts: BTreeMap<String, u32> = BTreeMap::new();
    let mut class_unique_indices: BTreeMap<String, BTreeSet<i32>> = BTreeMap::new();
    let mut class_max_concurrent: BTreeMap<String, usize> = BTreeMap::new();
    let mut class_max_active: BTreeMap<String, usize> = BTreeMap::new();
    let mut class_index_reuses: BTreeMap<String, u32> = BTreeMap::new();
    let mut seen_indices_by_class: BTreeMap<String, HashSet<i32>> = BTreeMap::new();

    // FOW exact transition tracking: (observer_team, ent_index) -> last m_bVisibleOnMap
    let mut fow_last_vis: HashMap<(i64, i32), bool> = HashMap::new();
    let mut fow_class88_css: BTreeMap<(String, String), u64> = BTreeMap::new();
    let mut fow_door_hits: u64 = 0;
    let mut fow_enemy_true_to_false: u32 = 0;
    let mut fow_enemy_false_to_true: u32 = 0;

    // User messages & modifiers.
    let mut portalled_count: u32 = 0;
    let mut doorway_casts_365: u32 = 0;
    let mut mods = ModifierState::default();
    let mut mod_agg: BTreeMap<(u32, u32, String), u32> = BTreeMap::new();

    let doorway_ability_tok = token("ability_doorman_doorway");
    let doorway_close_tok = token("ability_doorman_doorway_close");

    parser
        .run_to_end_with_properties(&classes, &[], Some(&event_types), |ctx, events| {
            let sers = ctx.serializers();
            let ents = ctx.entities();
            let tick = ctx.tick();

            let rk = *rules_keys.get_or_insert_with(|| {
                let f = |p: &str| sers.get(RULES).and_then(|s| s.resolve_field_key(p));
                [
                    f("m_pGameRules.m_flGameStartTime"),
                    f("m_pGameRules.m_nTotalPausedTicks"),
                    f("m_pGameRules.m_bGamePaused"),
                    f("m_pGameRules.m_nPauseStartTick"),
                    f("m_pGameRules.m_iWinningTeam"),
                    f("m_pGameRules.m_eGameMode"),
                ]
            });
            let ck = *ctrl_keys.get_or_insert_with(|| {
                let f = |p: &str| sers.get(CONTROLLER).and_then(|s| s.resolve_field_key(p));
                [
                    f("m_iTeamNum"),
                    f("m_hPawn"),
                    f("m_PlayerDataGlobal.m_nHeroID"),
                ]
            });
            let pk = *pawn_keys.get_or_insert_with(|| {
                let f = |p: &str| sers.get(PAWN).and_then(|s| s.resolve_field_key(p));
                [
                    f("m_CCitadelHeroComponent.m_spawnedHero.m_nHeroID"),
                    f("m_iTeamNum"),
                ]
            });
            let tk = *team_keys.get_or_insert_with(|| {
                let f = |p: &str| sers.get(TEAM).and_then(|s| s.resolve_field_key(p));
                [f("m_iTeamNum"), f("m_vecFOWEntities")]
            });
            let dk = *door_keys.get_or_insert_with(|| {
                let f = |p: &str| sers.get(DOORWAY_PORTAL).and_then(|s| s.resolve_field_key(p));
                [
                    f("m_iTeamNum"),
                    f("m_hLinkedDoorway"),
                    f("m_hOwnerEntity"),
                    f("CBodyComponent.m_skeletonInstance.m_angRotation"),
                ]
            });

            let mod_changes = mods.update(ctx);

            let Some((_, rules)) = ents.iter().find(|(_, e)| e.class_name.as_ref() == RULES) else {
                return;
            };
            let m = rules.get_i64(rk[5]);
            if m != 0 {
                game_mode = m;
            }
            if !over {
                winner = rules.get_i64(rk[4]);
            }
            over |= winner > 0;
            if over {
                return;
            }

            let interval = f64::from(ctx.tick_interval());
            let start = f64::from(rules.get_f32(rk[0]));
            let now = server_clock(
                i64::from(tick + server_start),
                rules.get_i64(rk[1]),
                rules.get_bool(rk[2]),
                rules.get_i64(rk[3]),
                interval,
            );
            let game_s = if start > 0.0 && now >= start { now - start } else { 0.0 };
            last_game_s = game_s;

            // Map pawns to (hero_id, team) and find Doorman.
            let mut pawn_info: HashMap<i32, (u32, i64)> = HashMap::new();
            for (_, e) in ents.iter().filter(|(_, e)| e.class_name.as_ref() == CONTROLLER) {
                let team = e.get_i64(ck[0]);
                let mut hero_id = e.get_i64(ck[2]) as u32;
                let pawn = e
                    .get_handle(ck[1])
                    .and_then(|h| ents.get_by_handle(h))
                    .filter(|p| p.class_name.as_ref() == PAWN);
                if hero_id == 0
                    && let Some(p) = pawn
                {
                    hero_id = p.get_i64(pk[0]) as u32;
                }
                if let Some(p) = pawn {
                    pawn_info.insert(p.index, (hero_id, team));
                    if hero_id == DOORMAN_HERO_ID {
                        doormen.insert(e.index, (team, Some(p.index)));
                    }
                } else if hero_id == DOORMAN_HERO_ID {
                    doormen.entry(e.index).or_insert((team, None));
                }
            }

            // Track all door/portal/doorman entities.
            let mut seen_this_tick: HashSet<i32> = HashSet::new();
            let mut concurrent_by_class: HashMap<String, usize> = HashMap::new();
            let mut active_by_class: HashMap<String, usize> = HashMap::new();
            let mut live_door_indices: HashMap<i32, String> = HashMap::new();

            for (_, e) in ents.iter() {
                let cls = e.class_name.as_ref();
                if !matches_door_kw(cls) {
                    continue;
                }
                seen_this_tick.insert(e.index);
                *concurrent_by_class.entry(cls.to_owned()).or_default() += 1;
                if e.active {
                    *active_by_class.entry(cls.to_owned()).or_default() += 1;
                }
                live_door_indices.insert(e.index, cls.to_owned());

                let Some(ser) = sers.get(cls) else { continue };
                let pkeys = *pos_keys.entry(cls.to_owned()).or_insert_with(|| PosKeys::of(ser));
                let pos = pkeys.map(|k| k.pos(e));

                let mut fields = BTreeMap::new();
                for (k, v) in &e.fields {
                    let name = field_name_cache
                        .entry((cls.to_owned(), *k))
                        .or_insert_with(|| ser.field_name_for_key(*k).unwrap_or_else(|| format!("?{k}")));
                    fields.insert(name.clone(), val_json(v));
                }

                let is_ability = cls.contains("Ability");
                let is_portal = cls == DOORWAY_PORTAL;

                match live.get_mut(&e.index) {
                    None => {
                        *class_spawn_counts.entry(cls.to_owned()).or_default() += 1;
                        class_unique_indices.entry(cls.to_owned()).or_default().insert(e.index);
                        if !seen_indices_by_class.entry(cls.to_owned()).or_default().insert(e.index) {
                            *class_index_reuses.entry(cls.to_owned()).or_default() += 1;
                        }
                        if is_portal {
                            let linked_raw = e.get_handle(dk[1]).unwrap_or(INVALID_HANDLE);
                            let linked_idx = (linked_raw != INVALID_HANDLE).then_some((linked_raw & boon::ENTITY_HANDLE_INDEX_MASK) as i32);
                            let slot = door_summaries.len();
                            door_summaries.push(DoorSummary {
                                index: e.index,
                                serial: e.serial,
                                team: e.get_i64(dk[0]),
                                spawn_s: game_s,
                                link_s: linked_idx.map(|_| game_s),
                                delete_s: None,
                                initial_linked: linked_idx,
                                partner: linked_idx,
                                pos: pos.unwrap_or([0.0; 3]),
                                rot: e.field_value(dk[3]).map(|v| format!("{v:?}")),
                                own_fow_flips: Vec::new(),
                                enemy_fow_flips: Vec::new(),
                                fow_heights: BTreeSet::new(),
                                fow_css_classes: BTreeSet::new(),
                            });
                            active_door_slot.insert(e.index, slot);
                        }
                        if is_portal || cls == DOORWAY_ABILITY {
                            writeln!(
                                events_file,
                                "{}",
                                serde_json::json!({
                                    "event": "spawn",
                                    "tick": tick,
                                    "game_s": round2(game_s),
                                    "class": cls,
                                    "index": e.index,
                                    "serial": e.serial,
                                    "active": e.active,
                                    "pos": pos,
                                    "fields": fields,
                                })
                            )
                            .ok();
                        }
                        live.insert(
                            e.index,
                            TrackedEntity {
                                class: cls.to_owned(),
                                serial: e.serial,
                                first_game_s: game_s,
                                active: e.active,
                                active_transitions: 0,
                                snapshot: fields,
                            },
                        );
                    }
                    Some(t) => {
                        if t.serial != e.serial || t.class != cls {
                            *class_spawn_counts.entry(cls.to_owned()).or_default() += 1;
                            *class_index_reuses.entry(cls.to_owned()).or_default() += 1;
                            *t = TrackedEntity {
                                class: cls.to_owned(),
                                serial: e.serial,
                                first_game_s: game_s,
                                active: e.active,
                                active_transitions: 0,
                                snapshot: fields,
                            };
                        } else {
                            let active_changed = t.active != e.active;
                            if active_changed {
                                t.active = e.active;
                                t.active_transitions += 1;
                            }
                            if is_portal
                                && let Some(&slot) = active_door_slot.get(&e.index)
                            {
                                let linked_raw = e.get_handle(dk[1]).unwrap_or(INVALID_HANDLE);
                                let linked_idx = (linked_raw != INVALID_HANDLE).then_some((linked_raw & boon::ENTITY_HANDLE_INDEX_MASK) as i32);
                                if door_summaries[slot].partner != linked_idx {
                                    door_summaries[slot].partner = linked_idx;
                                    if door_summaries[slot].link_s.is_none() && linked_idx.is_some() {
                                        door_summaries[slot].link_s = Some(game_s);
                                    }
                                }
                            }
                            let mut diffs = serde_json::Map::new();
                            for (k, v) in &fields {
                                if t.snapshot.get(k) != Some(v) {
                                    diffs.insert(k.clone(), v.clone());
                                }
                            }
                            if (active_changed || !diffs.is_empty())
                                && (is_portal
                                    || (is_ability
                                        && cls == DOORWAY_ABILITY
                                        && (active_changed
                                            || diffs.keys().any(|k| {
                                                k.contains("Door")
                                                    || k.contains("Slot")
                                                    || k.contains("Cooldown")
                                                    || k.contains("Charge")
                                            }))))
                            {
                                writeln!(
                                    events_file,
                                    "{}",
                                    serde_json::json!({
                                        "event": "change",
                                        "tick": tick,
                                        "game_s": round2(game_s),
                                        "class": cls,
                                        "index": e.index,
                                        "serial": e.serial,
                                        "active": e.active,
                                        "active_changed": active_changed,
                                        "pos": pos,
                                        "diffs": diffs,
                                    })
                                )
                                .ok();
                            }
                            if active_changed || !diffs.is_empty() {
                                t.snapshot = fields;
                            }
                        }
                    }
                }
            }

            for (cls, c) in concurrent_by_class {
                let e = class_max_concurrent.entry(cls).or_default();
                *e = (*e).max(c);
            }
            for (cls, c) in active_by_class {
                let e = class_max_active.entry(cls).or_default();
                *e = (*e).max(c);
            }

            // Detect deleted entities.
            live.retain(|idx, t| {
                if seen_this_tick.contains(idx) {
                    return true;
                }
                if t.class == DOORWAY_PORTAL {
                    if let Some(slot) = active_door_slot.remove(idx) {
                        door_summaries[slot].delete_s = Some(game_s);
                    }
                    fow_last_vis.retain(|(_, i), _| i != idx);
                    writeln!(
                        events_file,
                        "{}",
                        serde_json::json!({
                            "event": "delete",
                            "tick": tick,
                            "game_s": round2(game_s),
                            "class": t.class,
                            "index": idx,
                            "serial": t.serial,
                            "first_game_s": round2(t.first_game_s),
                            "duration_s": round2(game_s - t.first_game_s),
                            "active_transitions": t.active_transitions,
                        })
                    )
                    .ok();
                }
                false
            });

            // Check CCitadelTeam.m_vecFOWEntities for door entries & every visibility flip.
            if let Some(tser) = sers.get(TEAM) {
                for (_, t) in ents.iter().filter(|(_, e)| e.active && e.class_name.as_ref() == TEAM) {
                    let Some(observer @ (2 | 3)) = int(t.field_value(tk[0])) else { continue };
                    let n = int(t.field_value(tk[1])).unwrap_or(0).clamp(0, MAX_FOW as i64) as usize;
                    while fow_keys.len() < n {
                        let i = fow_keys.len();
                        let f = |name: &str| tser.resolve_field_key(&format!("m_vecFOWEntities.{i}.{name}"));
                        fow_keys.push([
                            f("m_eClass"),
                            f("m_nEntIndex"),
                            f("m_nTeam"),
                            f("m_bVisibleOnMap"),
                            f("m_eHeight"),
                            f("m_nPositionX"),
                            f("m_nPositionY"),
                            f("m_nTickHidden"),
                            f("m_iLane"),
                            f("m_nOwnerOnlyEntIndex"),
                            f("m_strCSSClass"),
                        ]);
                    }
                    for fk in &fow_keys[..n] {
                        let Some(eclass) = int(t.field_value(fk[0])) else { continue };
                        let ent_idx = int(t.field_value(fk[1])).and_then(|v| i32::try_from(v).ok()).unwrap_or(-1);
                        let ent_cls = ents.get(ent_idx).map_or("(undecoded)", |e| e.class_name.as_ref());
                        let css = str_val(t.field_value(fk[10])).unwrap_or_default();

                        if eclass == 88 {
                            *fow_class88_css.entry((ent_cls.to_owned(), css.clone())).or_default() += 1;
                        }

                        if let Some(&slot) = active_door_slot.get(&ent_idx) {
                            fow_door_hits += 1;
                            let vis = int(t.field_value(fk[3])) == Some(1);
                            let height = int(t.field_value(fk[4])).unwrap_or(0);
                            let door_team = door_summaries[slot].team;
                            door_summaries[slot].fow_heights.insert(height);
                            if !css.is_empty() {
                                door_summaries[slot].fow_css_classes.insert(css.clone());
                            }
                            let prev = fow_last_vis.insert((observer, ent_idx), vis);
                            if prev != Some(vis) {
                                if observer == door_team {
                                    door_summaries[slot].own_fow_flips.push((game_s, vis));
                                } else {
                                    door_summaries[slot].enemy_fow_flips.push((game_s, vis));
                                    if prev == Some(false) && vis {
                                        fow_enemy_false_to_true += 1;
                                    } else if prev == Some(true) && !vis {
                                        fow_enemy_true_to_false += 1;
                                    }
                                }
                                writeln!(
                                    fow_file,
                                    "{}",
                                    serde_json::json!({
                                        "tick": tick,
                                        "game_s": round2(game_s),
                                        "observer_team": observer,
                                        "door_team": door_team,
                                        "m_eClass": eclass,
                                        "m_nEntIndex": ent_idx,
                                        "prev_vis": prev,
                                        "vis": vis,
                                        "m_eHeight": height,
                                        "m_strCSSClass": css,
                                        "m_nPositionX": int(t.field_value(fk[5])),
                                        "m_nPositionY": int(t.field_value(fk[6])),
                                        "m_nTickHidden": int(t.field_value(fk[7])),
                                    })
                                )
                                .ok();
                            }
                        }
                    }
                }
            }

            // User messages.
            for ev in events {
                match ev.msg_type {
                    ENTITY_PORTALLED => {
                        if let Ok(m) = boon_proto::proto::CCitadelUserMsgEntityPortalled::decode(&ev.payload[..]) {
                            portalled_count += 1;
                            let ent_idx = m.entity_portalled.map(|h| (h & boon::ENTITY_HANDLE_INDEX_MASK) as i32);
                            let ent_cls = ent_idx.and_then(|i| ents.get(i)).map(|e| e.class_name.to_string());
                            let hero = ent_idx.and_then(|i| pawn_info.get(&i)).copied();
                            let pos = m.portal_transform.and_then(|t| t.position).map(|p| [p.x, p.y, p.z]);
                            writeln!(
                                portalled_file,
                                "{}",
                                serde_json::json!({
                                    "tick": tick,
                                    "game_s": round2(game_s),
                                    "handle": m.entity_portalled,
                                    "ent_index": ent_idx,
                                    "ent_class": ent_cls,
                                    "hero_id": hero.map(|h| h.0),
                                    "team": hero.map(|h| h.1),
                                    "portal_pos": pos,
                                })
                            )
                            .ok();
                        }
                    }
                    IMPORTANT_ABILITY_USED => {
                        if let Ok(m) = boon_proto::proto::CCitadelUserMessageImportantAbilityUsed::decode(&ev.payload[..])
                            && m.ability_name.as_deref().is_some_and(matches_door_kw)
                            && m.ability_name.as_deref() == Some("ability_doorman_doorway")
                        {
                            doorway_casts_365 += 1;
                        }
                    }
                    _ => {}
                }
            }

            // Modifiers involving doorway ability or door entities.
            for ch in mod_changes {
                let e = &ch.entry;
                let parent_idx = e.parent.map(|h| (h & boon::ENTITY_HANDLE_INDEX_MASK) as i32);
                let caster_idx = e.caster.map(|h| (h & boon::ENTITY_HANDLE_INDEX_MASK) as i32);
                let parent_is_door = parent_idx.is_some_and(|i| live_door_indices.get(&i).is_some_and(|c| c == DOORWAY_PORTAL));
                let caster_is_door = caster_idx.is_some_and(|i| live_door_indices.get(&i).is_some_and(|c| c == DOORWAY_PORTAL));
                let abil = e.ability_subclass.unwrap_or(0);
                let is_doorway_abil = abil == doorway_ability_tok || abil == doorway_close_tok;

                if parent_is_door || caster_is_door || is_doorway_abil {
                    let parent_desc = parent_idx.map_or_else(
                        || "none".to_owned(),
                        |i| {
                            if let Some(cls) = live_door_indices.get(&i) {
                                cls.clone()
                            } else if let Some((h, _)) = pawn_info.get(&i) {
                                format!("hero:{h}")
                            } else if let Some(ent) = ents.get(i) {
                                ent.class_name.to_string()
                            } else {
                                "undecoded".to_owned()
                            }
                        },
                    );
                    if ch.kind == ModifierChangeKind::Applied {
                        *mod_agg.entry((e.modifier_subclass.unwrap_or(0), abil, parent_desc.clone())).or_default() += 1;
                    }
                    writeln!(
                        mods_file,
                        "{}",
                        serde_json::json!({
                            "kind": format!("{:?}", ch.kind),
                            "tick": tick,
                            "game_s": round2(game_s),
                            "serial": e.serial_number,
                            "modifier_subclass": e.modifier_subclass,
                            "ability_subclass": e.ability_subclass,
                            "parent_idx": parent_idx,
                            "parent_desc": parent_desc,
                            "caster_idx": caster_idx,
                            "duration": e.duration,
                            "stack_count": e.stack_count,
                        })
                    )
                    .ok();
                }
            }
        })
        .expect("parse demo");

    events_file.flush().ok();
    fow_file.flush().ok();
    portalled_file.flush().ok();
    mods_file.flush().ok();

    println!("\n=== Match Summary ===");
    println!("game_mode={game_mode} winner={winner} duration_s={last_game_s:.1}");
    println!("doormen (ctrl_idx -> (team, pawn_idx)): {doormen:?}");
    println!("tokens: ability_doorman_doorway={doorway_ability_tok}, ability_doorman_doorway_close={doorway_close_tok}");

    println!("\n=== Door/Portal/Doorman Entity Census ===");
    for cls in &door_classes {
        let spawns = class_spawn_counts.get(cls).copied().unwrap_or(0);
        if spawns == 0 {
            continue;
        }
        let uniq = class_unique_indices.get(cls).map_or(0, BTreeSet::len);
        let reuses = class_index_reuses.get(cls).copied().unwrap_or(0);
        let max_c = class_max_concurrent.get(cls).copied().unwrap_or(0);
        let max_a = class_max_active.get(cls).copied().unwrap_or(0);
        println!("  {cls}: spawns={spawns}, unique_indices={uniq}, index_reuses={reuses}, max_concurrent={max_c}, max_active={max_a}");
    }

    println!("\n=== CCitadel_DoorwayPortal Lifecycle & FOW Table ({} doors) ===", door_summaries.len());
    let mut linked_pairs = 0u32;
    let mut unpaired_doors = 0u32;
    let mut total_enemy_fow_flips = 0usize;
    for d in &door_summaries {
        let role = if d.partner.is_none() {
            unpaired_doors += 1;
            "unpaired"
        } else if d.initial_linked.is_none() {
            linked_pairs += 1;
            "door1"
        } else {
            "door2"
        };
        let end = d.delete_s.unwrap_or(last_game_s);
        let tot_dur = end - d.spawn_s;
        let open_dur = d.link_s.map_or(0.0, |l| end - l);
        total_enemy_fow_flips += d.enemy_fow_flips.len();
        let own_flips: Vec<(f64, bool)> = d.own_fow_flips.iter().map(|(t, v)| (round2(*t), *v)).collect();
        let enemy_flips: Vec<(f64, bool)> = d.enemy_fow_flips.iter().map(|(t, v)| (round2(*t), *v)).collect();
        println!(
            "  idx={:>4} ser={:>3} team={} role={:<8} spawn={:>7.2} link={:>7} del={:>7.2} tot={:>6.2}s open={:>5.2}s partner={:>4} pos=[{:.1},{:.1},{:.1}] rot={} heights={:?} css={:?} own_fow={:?} enemy_fow={:?}",
            d.index,
            d.serial,
            d.team,
            role,
            d.spawn_s,
            d.link_s.map_or_else(|| "   None".to_owned(), |l| format!("{l:7.2}")),
            end,
            tot_dur,
            open_dur,
            d.partner.map_or_else(|| "None".to_owned(), |p| p.to_string()),
            d.pos[0],
            d.pos[1],
            d.pos[2],
            d.rot.as_deref().unwrap_or("None"),
            d.fow_heights,
            d.fow_css_classes,
            own_flips,
            enemy_flips,
        );
    }

    println!("\n=== FOW Summary ===");
    println!("fow_door_hits={fow_door_hits} enemy_false_to_true={fow_enemy_false_to_true} enemy_true_to_false={fow_enemy_true_to_false}");
    println!("m_eClass=88 breakdown (ent_class, m_strCSSClass -> count): {fow_class88_css:?}");

    println!("\n=== User Messages ===");
    println!("CCitadelUserMsgEntityPortalled (361) count={portalled_count}");
    println!("ImportantAbilityUsed (365) ability_doorman_doorway count={doorway_casts_365}");

    println!("\n=== Doorway Modifiers (applied counts) ===");
    for ((mod_tok, abil_tok, parent_desc), count) in &mod_agg {
        println!("  mod={mod_tok} abil={abil_tok} parent={parent_desc} count={count}");
    }

    // 5. Timeline size estimate.
    let sample_json = serde_json::json!(
        door_summaries
            .iter()
            .map(|d| {
                let mut seen: Vec<[f64; 2]> = Vec::new();
                let mut on_since: Option<f64> = None;
                for &(t, v) in &d.enemy_fow_flips {
                    if v && on_since.is_none() {
                        on_since = Some(t);
                    } else if !v && let Some(s) = on_since.take() {
                        seen.push([(s * 10.0).round() / 10.0, (t * 10.0).round() / 10.0]);
                    }
                }
                if let Some(s) = on_since {
                    let end = d.delete_s.unwrap_or(last_game_s);
                    seen.push([(s * 10.0).round() / 10.0, (end * 10.0).round() / 10.0]);
                }
                serde_json::json!({
                    "id": d.index,
                    "team": d.team,
                    "x": d.pos[0].round() as i32,
                    "y": d.pos[1].round() as i32,
                    "start": (d.spawn_s * 10.0).round() / 10.0,
                    "link": d.link_s.map(|l| (l * 10.0).round() / 10.0),
                    "end": (d.delete_s.unwrap_or(last_game_s) * 10.0).round() / 10.0,
                    "partner": d.partner,
                    "seen": seen,
                })
            })
            .collect::<Vec<_>>()
    );
    let est_bytes = serde_json::to_string(&sample_json).map_or(0, |s| s.len());
    println!("\n=== Timeline Size Estimate ===");
    println!(
        "doors={} (linked_pairs={}, unpaired={}), enemy_fow_flips={}, estimated_per_door_json_bytes={est_bytes}",
        door_summaries.len(),
        linked_pairs,
        unpaired_doors,
        total_enemy_fow_flips,
    );
}
