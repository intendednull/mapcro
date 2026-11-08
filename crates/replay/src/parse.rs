//! boon reads a demo into per-second [`Obs`]. Field paths are the ones the exploration checked
//! on current demos (docs/research/replay-parsing-exploration.md §2–§7). Steam ids are never
//! read.

use crate::derive::{AbilityObs, HeroObs, ObjObs, Obs, PowerupObs, Sample, TrooperObs};
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
        let Some(s) = ctx.serializers().get(class) else { return Body::default() };
        let k = |p: &str| s.resolve_field_key(p);
        Body {
            cell: [k(&format!("{ORIGIN}.m_cellX")), k(&format!("{ORIGIN}.m_cellY")), k(&format!("{ORIGIN}.m_cellZ"))],
            vec: [k(&format!("{ORIGIN}.m_vecX")), k(&format!("{ORIGIN}.m_vecY")), k(&format!("{ORIGIN}.m_vecZ"))],
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
    koth_started: K,
    koth_loc: K,
    koth_team: K,
    koth: Body,
    pickup: Body,
    pickup_active: K,
    trooper: Body,
    objectives: HashMap<&'static str, (Body, &'static str)>,
}

impl Keys {
    fn resolve(ctx: &boon::Context) -> Keys {
        let field = |class: &str, p: &str| ctx.serializers().get(class).and_then(|s| s.resolve_field_key(p));
        Keys {
            pawn: Body::of(ctx, PAWN),
            pawn_hero: field(PAWN, "m_CCitadelHeroComponent.m_spawnedHero.m_nHeroID"),
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
            koth_started: field(RULES, "m_pGameRules.m_timeKothCashInStarted"),
            koth_loc: field(RULES, "m_pGameRules.m_vKothCashInCurrentLocation"),
            koth_team: field(RULES, "m_pGameRules.m_nKothScoringTeam"),
            koth: Body::of(ctx, KOTH),
            pickup: Body::of(ctx, PICKUP),
            pickup_active: field(PICKUP, "m_bPowerupActive"),
            trooper: Body::of(ctx, TROOPER),
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
    let mut classes: HashSet<&str> = [CONTROLLER, PAWN, RULES, KOTH, PICKUP, TROOPER].into_iter().collect();
    classes.extend(OBJECTIVES.iter().map(|(c, _)| *c));
    let mut keys: Option<Keys> = None;
    let mut seconds: Vec<Sample> = Vec::new();
    let mut over = false;
    // Ult casts arrive as user messages between samples; they go with the next sample.
    let mut casts: Vec<AbilityObs> = Vec::new();
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
            // The match is over once it has a winner; the recording runs on for a while.
            over |= rules.get_i64(k.winner) > 0;
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
            if start <= 0.0 || game < seconds.len() as f64 || game > f64::from(crate::timeline::MAX_DURATION_S) {
                return;
            }
            let mut s = sample(ctx, k, rules, now as f32);
            s.abilities = std::mem::take(&mut casts);
            // Fill every second up to this one (a gap in ticks repeats the sample).
            while (seconds.len() as f64) <= game {
                seconds.push(s.clone());
            }
        })
        .map_err(|_| reason::PARSE_FAILED)?;
    Ok(Obs { match_id, build, seconds })
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
            });
        } else if !e.active {
            continue;
        } else if class == TROOPER {
            if e.get_i64(k.trooper.max_health) == 0 || e.get_i64(k.trooper.life) != 0 || e.get_i64(k.trooper.health) <= 0 {
                continue;
            }
            s.troopers.push(TrooperObs { team: e.get_i64(k.trooper.team), lane: e.get_i64(k.trooper.lane), pos: k.trooper.pos(e) });
        } else if class == KOTH {
            s.rift_spawner = Some(k.koth.pos(e));
        } else if class == PICKUP {
            s.powerups.push(PowerupObs { pos: k.pickup.pos(e), active: e.get_bool(k.pickup_active) });
        } else if let Some((body, kind)) = k.objectives.get(class) {
            if e.get_i64(body.max_health) == 0 {
                continue;
            }
            s.objectives.push(ObjObs { ent: (e.index, e.serial), kind, pos: body.pos(e), health: e.get_i64(body.health) });
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
