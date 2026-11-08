//! boon reads a demo into per-second [`Obs`]. Field paths are the ones the exploration checked
//! on current demos (docs/research/replay-parsing-exploration.md §2–§7). Steam ids are never
//! read.

use crate::derive::{AbilityObs, CampSlot, HeroObs, ObjObs, Obs, PowerupObs, Sample, TrooperObs, UrnObs, ZipNode};
use prost::Message;
use crate::{FIRST_CURRENT_BUILD, content_build, reason};
use boon::{Parser, world_position};
use std::collections::{HashMap, HashSet};
use std::path::Path;

const CONTROLLER: &str = "CCitadelPlayerController";
const PAWN: &str = "CCitadelPlayerPawn";
const RULES: &str = "CCitadelGameRulesProxy";
const KOTH: &str = "CCitadelItemKothSpawner";
const PICKUP: &str = "CCitadel_PickupItemSpawner";
const TROOPER: &str = "CNPC_Trooper";
const ZIP_NODE: &str = "CCitadelZipLineNode";
/// The Soul Urn on the ground, and its two delivery points (exploration round 6).
const IDOL: &str = "CCitadelItemPickupIdol";
const IDOL_RETURN: &str = "CCitadelIdolReturnTrigger";
/// The urn moving less than this (world units) isn't a change worth a record.
const URN_MOVE: f32 = 64.0;
const CAMP_TIMES: &str = "m_pGameRules.m_vecNeutralCampNextSpawnTimes";
const CAMP_ORIGINS: &str = "m_pGameRules.m_vecNeutralCampTimerOrigins";
const CAMP_IS_MID: &str = "m_pGameRules.m_vecNeutralCampTimerIsMidBoss";
/// More slots than this isn't the map we know (52 on the current one).
const MAX_CAMP_SLOTS: usize = 64;
/// Demo class → our site kind.
const OBJECTIVES: [(&str, &str); 6] = [
    ("CNPC_TrooperBoss", "guardian"),
    ("CNPC_Boss_Tier2", "walker"),
    ("CNPC_BarrackBoss", "base_guardian"),
    ("CNPC_Boss_Tier3", "patron"),
    ("CNPC_MidBoss", "mid_boss"),
    ("CCitadel_Destroyable_Building", "shrine"),
];
const ORIGIN: &str = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
/// A class without a skeleton (the urn's delivery points) has its origin on the body itself.
const BODY_ORIGIN: &str = "CBodyComponent";

type K = Option<u64>;

/// A class's position and health keys.
#[derive(Clone, Copy, Default)]
struct Body {
    cell: [K; 3],
    vec: [K; 3],
    health: K,
    max_health: K,
    life: K,
    team: K,
    lane: K,
}

impl Body {
    fn of(ctx: &boon::Context, class: &str) -> Body {
        let skeleton = ctx.serializers().get(class).and_then(|s| s.resolve_field_key(&format!("{ORIGIN}.m_cellX"))).is_some();
        Body::at(ctx, class, if skeleton { ORIGIN } else { BODY_ORIGIN })
    }

    fn at(ctx: &boon::Context, class: &str, origin: &str) -> Body {
        let Some(s) = ctx.serializers().get(class) else { return Body::default() };
        let k = |p: &str| s.resolve_field_key(p);
        Body {
            cell: [k(&format!("{origin}.m_cellX")), k(&format!("{origin}.m_cellY")), k(&format!("{origin}.m_cellZ"))],
            vec: [k(&format!("{origin}.m_vecX")), k(&format!("{origin}.m_vecY")), k(&format!("{origin}.m_vecZ"))],
            health: k("m_iHealth"),
            max_health: k("m_iMaxHealth"),
            life: k("m_lifeState"),
            team: k("m_iTeamNum"),
            lane: k("m_iLane"),
        }
    }

    fn pos(&self, e: &boon::entity::Entity) -> [f32; 2] {
        let [x, y, _] = world_position(e, self.cell, self.vec);
        [x, y]
    }
}

struct Keys {
    pawn: Body,
    pawn_hero: K,
    pawn_respawn: K,
    ctrl_team: K,
    ctrl_pawn: K,
    ctrl_hero: K,
    ctrl_name: K,
    ctrl_net_worth: K,
    ult_trained: K,
    ult_start: K,
    ult_end: K,
    paused_ticks: K,
    game_start: K,
    winner: K,
    game_mode: K,
    patron_phase: K,
    koth_started: K,
    koth_loc: K,
    koth_team: K,
    koth: Body,
    pickup: Body,
    pickup_active: K,
    trooper: Body,
    zip: Body,
    zip_lane: K,
    idol: Body,
    idol_return: Body,
    idol_return_off: K,
    camp_count: K,
    /// Per camp slot: next spawn time, origin, is-mid-boss.
    camp: Vec<[K; 3]>,
    objectives: HashMap<&'static str, (Body, &'static str)>,
}

impl Keys {
    fn resolve(ctx: &boon::Context) -> Keys {
        let field = |class: &str, p: &str| ctx.serializers().get(class).and_then(|s| s.resolve_field_key(p));
        Keys {
            pawn: Body::of(ctx, PAWN),
            pawn_hero: field(PAWN, "m_CCitadelHeroComponent.m_spawnedHero.m_nHeroID"),
            pawn_respawn: field(PAWN, "m_flRespawnTime"),
            ctrl_team: field(CONTROLLER, "m_iTeamNum"),
            ctrl_pawn: field(CONTROLLER, "m_hPawn"),
            ctrl_hero: field(CONTROLLER, "m_PlayerDataGlobal.m_nHeroID"),
            ctrl_name: field(CONTROLLER, "m_iszPlayerName"),
            ctrl_net_worth: field(CONTROLLER, "m_PlayerDataGlobal.m_iGoldNetWorth"),
            ult_trained: field(CONTROLLER, "m_PlayerDataGlobal.m_bUltimateTrained"),
            ult_start: field(CONTROLLER, "m_PlayerDataGlobal.m_flUltimateCooldownStart"),
            ult_end: field(CONTROLLER, "m_PlayerDataGlobal.m_flUltimateCooldownEnd"),
            paused_ticks: field(RULES, "m_pGameRules.m_nTotalPausedTicks"),
            game_start: field(RULES, "m_pGameRules.m_flGameStartTime"),
            winner: field(RULES, "m_pGameRules.m_iWinningTeam"),
            game_mode: field(RULES, "m_pGameRules.m_eGameMode"),
            patron_phase: field("CNPC_Boss_Tier3", "m_ePhase"),
            koth_started: field(RULES, "m_pGameRules.m_timeKothCashInStarted"),
            koth_loc: field(RULES, "m_pGameRules.m_vKothCashInCurrentLocation"),
            koth_team: field(RULES, "m_pGameRules.m_nKothScoringTeam"),
            koth: Body::of(ctx, KOTH),
            pickup: Body::of(ctx, PICKUP),
            pickup_active: field(PICKUP, "m_bPowerupActive"),
            trooper: Body::of(ctx, TROOPER),
            zip: Body::of(ctx, ZIP_NODE),
            zip_lane: field(ZIP_NODE, "m_iPrimaryLane"),
            idol: Body::of(ctx, IDOL),
            idol_return: Body::of(ctx, IDOL_RETURN),
            idol_return_off: field(IDOL_RETURN, "m_bDisabled"),
            camp_count: field(RULES, CAMP_TIMES),
            camp: (0..MAX_CAMP_SLOTS).map(|i| [field(RULES, &format!("{CAMP_TIMES}.{i}")), field(RULES, &format!("{CAMP_ORIGINS}.{i}")), field(RULES, &format!("{CAMP_IS_MID}.{i}"))]).collect(),
            objectives: OBJECTIVES.iter().map(|(c, k)| (*c, (Body::of(ctx, c), *k))).collect(),
        }
    }
}

/// Why a demo can't become a timeline: one of [`reason`]'s codes.
pub type Failure = &'static str;

/// The demo's content build and server start tick, from its header alone (cheap: read before
/// the full parse).
pub fn header(path: &Path) -> Result<(u32, i32), Failure> {
    let parser = Parser::from_file(path).map_err(|_| reason::NOT_A_REPLAY)?;
    parser.verify().map_err(|_| reason::NOT_A_REPLAY)?;
    let header = parser.file_header().map_err(|_| reason::NOT_A_REPLAY)?;
    let dir = header.game_directory.unwrap_or_default();
    if !dir.contains("citadel") {
        return Err(reason::NOT_A_REPLAY);
    }
    Ok((content_build(&dir).ok_or(reason::NOT_A_REPLAY)?, header.server_start_tick.unwrap_or(0).max(0)))
}

/// Read the whole demo into one sample per game second.
pub fn observe(path: &Path, match_id: u64) -> Result<Obs, Failure> {
    let (build, server_start) = header(path)?;
    if build < FIRST_CURRENT_BUILD {
        return Err(reason::OLD_MAP);
    }
    let parser = Parser::from_file(path).map_err(|_| reason::NOT_A_REPLAY)?;
    let mut classes: HashSet<&str> = [CONTROLLER, PAWN, RULES, KOTH, PICKUP, TROOPER, ZIP_NODE, IDOL, IDOL_RETURN].into_iter().collect();
    classes.extend(OBJECTIVES.iter().map(|(c, _)| *c));
    let mut keys: Option<Keys> = None;
    let mut seconds: Vec<Sample> = Vec::new();
    let mut over = false;
    let mut game_mode = 0;
    let mut winner = 0;
    // Ult casts arrive as user messages between samples; they go with the next sample.
    let mut casts: Vec<AbilityObs> = Vec::new();
    // Zipline nodes by entity index, in first-seen order; camp timers by slot.
    let mut zip_index: HashMap<i32, usize> = HashMap::new();
    let mut zip_nodes: Vec<ZipNode> = Vec::new();
    let mut camp_slots: Vec<CampSlot> = Vec::new();
    let mut urn: Vec<UrnObs> = Vec::new();
    parser
        .run_to_end_with_events_filtered(&classes, |ctx, events| {
            let k = keys.get_or_insert_with(|| Keys::resolve(ctx));
            for e in events.iter().filter(|e| e.msg_type == IMPORTANT_ABILITY_USED) {
                if let Some(a) = ability_used(ctx, k, &e.payload) {
                    casts.push(a);
                }
            }
            let rules = ctx.entities().iter().find(|(_, e)| e.class_name.as_ref() == RULES).map(|(_, e)| e);
            let Some(rules) = rules else { return };
            game_mode = match rules.get_i64(k.game_mode) {
                0 => game_mode,
                m => m,
            };
            // The match is over once it has a winner; the recording runs on for a while.
            if !over {
                winner = rules.get_i64(k.winner);
            }
            over |= winner > 0;
            if over {
                return;
            }
            // The game's clock (`GameTime_t`) counts server ticks, and the recording starts
            // `server_start_tick` into the server's life: checked against the metadata's death
            // and objective times, and its duration, on match 122134063 (journal 2026-11-07).
            let interval = f64::from(ctx.tick_interval());
            let paused = rules.get_i64(k.paused_ticks) as f64;
            let start = f64::from(rules.get_f32(k.game_start));
            let now = (f64::from(ctx.tick() + server_start) - paused) * interval;
            let game = now - start;
            // Camp timers change on any tick: read them on every one, from the horn.
            if start > 0.0 && game >= 0.0 {
                camp_timers(k, rules, game as f32, &mut camp_slots);
                urn_tick(ctx, k, game as f32, &mut urn);
            }
            if start <= 0.0 || game < seconds.len() as f64 || game > f64::from(crate::timeline::MAX_DURATION_S) {
                return;
            }
            let mut s = sample(ctx, k, rules, now as f32);
            s.abilities = std::mem::take(&mut casts);
            s.zip_teams = zip_teams(ctx, k, &mut zip_index, &mut zip_nodes);
            // Fill every second up to this one (a gap in ticks repeats the sample).
            while (seconds.len() as f64) <= game {
                seconds.push(s.clone());
            }
        })
        .map_err(|_| reason::PARSE_FAILED)?;
    // Nodes first seen after a sample was taken make earlier samples short: those hold.
    Ok(Obs { match_id, build, game_mode, winner, seconds, zip_nodes, camp_slots, urn })
}

/// Every zipline node's team now, in `nodes` order; a node seen for the first time is added
/// (positions and lanes are static).
fn zip_teams(ctx: &boon::Context, k: &Keys, index: &mut HashMap<i32, usize>, nodes: &mut Vec<ZipNode>) -> Vec<u8> {
    let mut seen: Vec<(usize, u8)> = Vec::new();
    for (_, e) in ctx.entities().iter().filter(|(_, e)| e.class_name.as_ref() == ZIP_NODE) {
        let i = *index.entry(e.index).or_insert_with(|| {
            nodes.push(ZipNode { lane: e.get_i64(k.zip_lane), pos: k.zip.pos(e) });
            nodes.len() - 1
        });
        seen.push((i, e.get_i64(k.zip.team).clamp(0, 255) as u8));
    }
    if seen.is_empty() {
        return Vec::new();
    }
    let mut teams = vec![0u8; nodes.len()];
    for (i, t) in seen {
        teams[i] = t;
    }
    teams
}

/// Record each camp slot's timer where it changed (exploration round 3).
fn camp_timers(k: &Keys, rules: &boon::entity::Entity, game: f32, slots: &mut Vec<CampSlot>) {
    let n = (rules.get_i64(k.camp_count).max(0) as usize).min(k.camp.len());
    for (i, [time, origin, mid]) in k.camp.iter().enumerate().take(n) {
        if slots.len() <= i {
            let o = rules.get_vector3(*origin);
            slots.push(CampSlot { origin: [o[0], o[1]], mid_boss: rules.get_bool(*mid), changes: Vec::new() });
        }
        let v = rules.get_f32(*time);
        let slot = &mut slots[i];
        if slot.changes.last().is_none_or(|(_, last)| *last != v) {
            slot.changes.push((game, v));
        }
    }
}

/// Record the urn where it changes (exploration round 6). Picked up, the carrier is the carrying
/// team's nearest living hero to where the urn lay.
fn urn_tick(ctx: &boon::Context, k: &Keys, game: f32, out: &mut Vec<UrnObs>) {
    let ents = ctx.entities();
    let mut now = UrnObs { game, ..Default::default() };
    for (_, e) in ents.iter() {
        let class = e.class_name.as_ref();
        if class == IDOL && e.active && now.ground.is_none() {
            now.ground = Some(k.idol.pos(e));
        } else if class == IDOL_RETURN && !e.get_bool(k.idol_return_off) && now.delivery.is_none() {
            now.delivery = Some(k.idol_return.pos(e));
            now.carrier_team = e.get_i64(k.idol_return.team);
        }
    }
    let last = out.last().cloned().unwrap_or_default();
    let moved = match (last.ground, now.ground) {
        (Some(a), Some(b)) => (a[0] - b[0]).hypot(a[1] - b[1]) >= URN_MOVE,
        (a, b) => a.is_some() != b.is_some(),
    };
    if !moved && last.carrier_team == now.carrier_team && last.delivery.is_some() == now.delivery.is_some() {
        return;
    }
    now.carrier = if now.carrier_team > 0 && now.ground.is_none() && last.carrier_team == now.carrier_team && last.ground.is_none() {
        last.carrier
    } else if matches!(now.carrier_team, 2 | 3) && now.ground.is_none() {
        let from = last.ground.or(out.iter().rev().find_map(|u| u.ground));
        from.and_then(|from| nearest_hero(ctx, k, now.carrier_team, from))
    } else {
        None
    };
    out.push(now);
}

/// The controller index of `team`'s living hero nearest `at`.
fn nearest_hero(ctx: &boon::Context, k: &Keys, team: i64, at: [f32; 2]) -> Option<i32> {
    let ents = ctx.entities();
    let mut best: Option<(f32, i32)> = None;
    for (_, e) in ents.iter().filter(|(_, e)| e.class_name.as_ref() == CONTROLLER && e.get_i64(k.ctrl_team) == team) {
        let Some(p) = e.get_handle(k.ctrl_pawn).and_then(|h| ents.get_by_handle(h)).filter(|p| p.class_name.as_ref() == PAWN) else { continue };
        if !(p.active && p.get_i64(k.pawn.life) == 0 && p.get_i64(k.pawn.health) > 0) {
            continue;
        }
        let q = k.pawn.pos(p);
        let d = (q[0] - at[0]).hypot(q[1] - at[1]);
        if best.is_none_or(|b| d < b.0) {
            best = Some((d, e.index));
        }
    }
    best.map(|b| b.1)
}

/// `KEUserMsgImportantAbilityUsed`: an ult (or other important ability) cast (exploration
/// round 2, §7).
const IMPORTANT_ABILITY_USED: u32 = 365;

fn ability_used(ctx: &boon::Context, k: &Keys, payload: &[u8]) -> Option<AbilityObs> {
    let m = boon_proto::proto::CCitadelUserMessageImportantAbilityUsed::decode(payload).ok()?;
    let ents = ctx.entities();
    let name = m.ability_name?;
    // The caster's pawn, else the player's controller.
    for h in [m.caster, m.player].into_iter().flatten() {
        let Some(e) = ents.get_by_handle(h) else { continue };
        match e.class_name.as_ref() {
            PAWN => {
                let hero_id = e.get_i64(k.pawn_hero) as u32;
                return (hero_id != 0).then(|| AbilityObs { hero_id, team: e.get_i64(k.pawn.team), pos: Some(k.pawn.pos(e)), name: name.clone() });
            }
            CONTROLLER => {
                let hero_id = e.get_i64(k.ctrl_hero) as u32;
                let pawn = e.get_handle(k.ctrl_pawn).and_then(|p| ents.get_by_handle(p)).filter(|p| p.class_name.as_ref() == PAWN);
                return (hero_id != 0).then(|| AbilityObs { hero_id, team: e.get_i64(k.ctrl_team), pos: pawn.map(|p| k.pawn.pos(p)), name: name.clone() });
            }
            _ => {}
        }
    }
    None
}

fn sample(ctx: &boon::Context, k: &Keys, rules: &boon::entity::Entity, now: f32) -> Sample {
    let mut s = Sample { now, ..Default::default() };
    let ents = ctx.entities();
    for (_, e) in ents.iter() {
        let class = e.class_name.as_ref();
        if class == CONTROLLER {
            let team = e.get_i64(k.ctrl_team);
            let pawn = e.get_handle(k.ctrl_pawn).and_then(|h| ents.get_by_handle(h)).filter(|p| p.class_name.as_ref() == PAWN);
            let mut hero_id = e.get_i64(k.ctrl_hero) as u32;
            if hero_id == 0 {
                hero_id = pawn.map_or(0, |p| p.get_i64(k.pawn_hero) as u32);
            }
            let alive = pawn.is_some_and(|p| p.active && p.get_i64(k.pawn.life) == 0 && p.get_i64(k.pawn.health) > 0);
            s.heroes.push(HeroObs {
                id: e.index,
                team,
                hero_id,
                name: e.get_string(k.ctrl_name),
                alive,
                pos: pawn.filter(|_| alive).map(|p| k.pawn.pos(p)),
                health: pawn.map_or(0, |p| p.get_i64(k.pawn.health)),
                max_health: pawn.map_or(0, |p| p.get_i64(k.pawn.max_health)),
                net_worth: e.get_i64(k.ctrl_net_worth).max(0) as u32,
                ult_trained: e.get_bool(k.ult_trained),
                ult_start: e.get_f32(k.ult_start),
                ult_end: e.get_f32(k.ult_end),
                respawn_at: pawn.map_or(0.0, |p| p.get_f32(k.pawn_respawn)),
            });
        } else if !e.active {
            continue;
        } else if class == TROOPER {
            if e.get_i64(k.trooper.max_health) == 0 || e.get_i64(k.trooper.life) != 0 || e.get_i64(k.trooper.health) <= 0 {
                continue;
            }
            s.troopers.push(TrooperObs { id: e.index, team: e.get_i64(k.trooper.team), lane: e.get_i64(k.trooper.lane), pos: k.trooper.pos(e) });
        } else if class == KOTH {
            s.rift_spawner = Some(k.koth.pos(e));
        } else if class == PICKUP {
            s.powerups.push(PowerupObs { pos: k.pickup.pos(e), active: e.get_bool(k.pickup_active) });
        } else if let Some((body, kind)) = k.objectives.get(class) {
            if e.get_i64(body.max_health) == 0 {
                continue;
            }
            s.objectives.push(ObjObs { ent: (e.index, e.serial), kind, pos: body.pos(e), health: e.get_i64(body.health), max_health: e.get_i64(body.max_health), phase: if *kind == "patron" { e.get_i64(k.patron_phase) } else { 0 } });
        }
    }
    let cash_in = rules.get_f32(k.koth_started);
    if cash_in > 0.0 && cash_in.is_finite() {
        // Already world space: not cell-decoded (exploration §6).
        let loc = rules.get_vector3(k.koth_loc);
        if loc[0] != 0.0 || loc[1] != 0.0 {
            s.rift_live_at = Some([loc[0], loc[1]]);
        }
        // ≤ 0 contested; 2 or 3 once a team holds it (exploration §6).
        s.rift_scoring = rules.get_i64(k.koth_team);
    }
    s
}
