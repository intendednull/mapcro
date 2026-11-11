//! boon reads a demo into per-second [`Obs`]. Field paths are the ones the exploration checked
//! on current demos (docs/research/replay-parsing-exploration.md §2–§7). Steam ids are never
//! read.

use crate::derive::{AbilityObs, BuffObs, CampSlot, CrateObs, HealObs, HeroObs, KothObs, ObjObs, Obs, PowerupObs, RejuvCount, RejuvObs, RejuvWhat, Sample, TrooperObs, UrnObs, VisionObs, ZipNode};
use prost::Message;
use crate::{FIRST_CURRENT_BUILD, content_build, reason};
use boon::world_position;
use std::collections::{HashMap, HashSet};
use std::io::Read as _;
use std::path::Path;

const CONTROLLER: &str = "CCitadelPlayerController";
const PAWN: &str = "CCitadelPlayerPawn";
const RULES: &str = "CCitadelGameRulesProxy";
const KOTH: &str = "CCitadelItemKothSpawner";
const PICKUP: &str = "CCitadel_PickupItemSpawner";
/// The pickup a powerup spawner arms (and the statues' drops): `m_nSubclassID` names it
/// (exploration round 7).
const PICKUP_MODIFIER: &str = "CCitadel_Pickup_Modifier";
/// The bridge buffs' pickup names (misc.vdata `*_powerup_pickup`) as `m_nSubclassID` carries
/// them: CUtlStringToken, MurmurHash2 of the name with seed 0x31415926 (checked by a test).
const BUFF_TOKENS: [(u32, &str); 4] = [(201_785_745, "gun"), (828_222_066, "survival"), (15_572_055, "casting"), (754_654_000, "movement")];
const TROOPER: &str = "CNPC_Trooper";
const ZIP_NODE: &str = "CCitadelZipLineNode";
/// The Soul Urn on the ground, and its two delivery points (exploration round 6).
const IDOL: &str = "CCitadelItemPickupIdol";
const IDOL_RETURN: &str = "CCitadelIdolReturnTrigger";
/// A health pickup: the map's floating ones (one entity each, all match, `m_bActive` false
/// while taken) and the drops, from one pool (docs/research/map-objectives-audit.md).
const HEAL: &str = "CCitadel_Pickup_Health";
/// The map's breakable props: wooden crates, item containers, the bells and the tough crates,
/// one entity each for the whole match, inactive while broken (docs/research/map-objectives-audit.md).
const BREAKABLE: &str = "CCitadel_BreakableProp";
/// A tough ("heavy") crate's `m_nSubclassID`: `citadel_breakable_prop_tough_crate` as a
/// CUtlStringToken (checked by a test). 78 of 129738985's 709 breakable props carry it.
const TOUGH_CRATE_TOKEN: u32 = 202_631_964;
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
/// A team's own minimap feed: `m_vecFOWEntities`, one entry per tracked entity, with whether
/// the team sees it now (docs/research/replay-vision.md). Read here field by field: boon's
/// `replay_inputs::EnemyMinimap` also resolves Steam ids, which mapcro never reads.
const TEAM: &str = "CCitadelTeam";
const FOW: &str = "m_vecFOWEntities";
/// `m_eClass` of a hero pawn's entry.
const FOW_HERO: i64 = 1;
/// More entries than this isn't the feed we know (about 120 on 129738985).
const MAX_FOW: usize = 512;
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
    ctrl_level: K,
    ctrl_kills: K,
    ctrl_assists: K,
    /// `m_PlayerDataGlobal.m_vecStatViewerModifierValues`: its length, then per entry the source
    /// modifier, the value type and the value.
    stat_viewer: K,
    stat_viewer_entries: Vec<[K; 3]>,
    /// [`crate::timeline::pickup_sources`].
    pickup_sources: Vec<(u32, u32, usize)>,
    ult_trained: K,
    ult_start: K,
    ult_end: K,
    paused_ticks: K,
    game_paused: K,
    pause_start: K,
    game_start: K,
    winner: K,
    game_mode: K,
    patron_phase: K,
    koth_started: K,
    koth_loc: K,
    koth_team: K,
    koth_give_up: K,
    /// `m_vecTeamKothStates.{0,1}.m_flCaptureProgressFrac`: Amber's, Sapphire's.
    koth_progress: [K; 2],
    rejuv_count: [K; 2],
    koth: Body,
    pickup: Body,
    pickup_active: K,
    pickup_mod: Body,
    pickup_mod_active: K,
    pickup_mod_sub: K,
    trooper: Body,
    zip: Body,
    zip_lane: K,
    idol: Body,
    idol_return: Body,
    idol_return_off: K,
    heal: Body,
    heal_active: K,
    breakable: Body,
    breakable_sub: K,
    camp_count: K,
    team_num: K,
    fow_count: K,
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
            ctrl_level: field(CONTROLLER, "m_PlayerDataGlobal.m_iLevel"),
            ctrl_kills: field(CONTROLLER, "m_PlayerDataGlobal.m_iPlayerKills"),
            ctrl_assists: field(CONTROLLER, "m_PlayerDataGlobal.m_iPlayerAssists"),
            stat_viewer: field(CONTROLLER, STAT_VIEWER),
            stat_viewer_entries: (0..STAT_VIEWER_MAX)
                .map(|i| ["m_SourceModifierID", "m_eValType", "m_flValue"].map(|f| field(CONTROLLER, &format!("{STAT_VIEWER}.{i}.{f}"))))
                .collect(),
            pickup_sources: crate::timeline::pickup_sources(),
            ult_trained: field(CONTROLLER, "m_PlayerDataGlobal.m_bUltimateTrained"),
            ult_start: field(CONTROLLER, "m_PlayerDataGlobal.m_flUltimateCooldownStart"),
            ult_end: field(CONTROLLER, "m_PlayerDataGlobal.m_flUltimateCooldownEnd"),
            paused_ticks: field(RULES, "m_pGameRules.m_nTotalPausedTicks"),
            game_paused: field(RULES, "m_pGameRules.m_bGamePaused"),
            pause_start: field(RULES, "m_pGameRules.m_nPauseStartTick"),
            game_start: field(RULES, "m_pGameRules.m_flGameStartTime"),
            winner: field(RULES, "m_pGameRules.m_iWinningTeam"),
            game_mode: field(RULES, "m_pGameRules.m_eGameMode"),
            patron_phase: field("CNPC_Boss_Tier3", "m_ePhase"),
            koth_started: field(RULES, "m_pGameRules.m_timeKothCashInStarted"),
            koth_loc: field(RULES, "m_pGameRules.m_vKothCashInCurrentLocation"),
            koth_team: field(RULES, "m_pGameRules.m_nKothScoringTeam"),
            koth_give_up: field(RULES, "m_pGameRules.m_timeKothGiveUp"),
            koth_progress: [0, 1].map(|i| field(RULES, &format!("m_pGameRules.m_vecTeamKothStates.{i}.m_flCaptureProgressFrac"))),
            rejuv_count: [field(RULES, "m_pGameRules.m_iAmberRejuvCount"), field(RULES, "m_pGameRules.m_iSapphireRejuvCount")],
            koth: Body::of(ctx, KOTH),
            pickup: Body::of(ctx, PICKUP),
            pickup_active: field(PICKUP, "m_bPowerupActive"),
            pickup_mod: Body::of(ctx, PICKUP_MODIFIER),
            pickup_mod_active: field(PICKUP_MODIFIER, "m_bActive"),
            pickup_mod_sub: field(PICKUP_MODIFIER, "m_nSubclassID"),
            trooper: Body::of(ctx, TROOPER),
            zip: Body::of(ctx, ZIP_NODE),
            zip_lane: field(ZIP_NODE, "m_iPrimaryLane"),
            idol: Body::of(ctx, IDOL),
            idol_return: Body::of(ctx, IDOL_RETURN),
            idol_return_off: field(IDOL_RETURN, "m_bDisabled"),
            heal: Body::of(ctx, HEAL),
            heal_active: field(HEAL, "m_bActive"),
            breakable: Body::of(ctx, BREAKABLE),
            breakable_sub: field(BREAKABLE, "m_nSubclassID"),
            camp_count: field(RULES, CAMP_TIMES),
            team_num: field(TEAM, "m_iTeamNum"),
            fow_count: field(TEAM, FOW),
            camp: (0..MAX_CAMP_SLOTS).map(|i| [field(RULES, &format!("{CAMP_TIMES}.{i}")), field(RULES, &format!("{CAMP_ORIGINS}.{i}")), field(RULES, &format!("{CAMP_IS_MID}.{i}"))]).collect(),
            objectives: OBJECTIVES.iter().map(|(c, k)| (*c, (Body::of(ctx, c), *k))).collect(),
        }
    }
}

/// Why a demo can't become a timeline: one of [`reason`]'s codes.
pub type Failure = &'static str;

/// The demo's content build and server start tick, from its header alone (cheap: read before
/// the full parse).
#[cfg(feature = "mmap")]
pub fn header(path: &Path) -> Result<(u32, i32), Failure> {
    let parser = boon::Parser::from_file(path).map_err(|_| reason::NOT_A_REPLAY)?;
    parser.verify().map_err(|_| reason::NOT_A_REPLAY)?;
    checked(parser.file_header().map_err(|_| reason::NOT_A_REPLAY)?)
}

/// A Deadlock demo's content build and server start tick from its `DEM_FileHeader`.
fn checked(header: boon_proto::proto::CDemoFileHeader) -> Result<(u32, i32), Failure> {
    let dir = header.game_directory.unwrap_or_default();
    if !dir.contains("citadel") {
        return Err(reason::NOT_A_REPLAY);
    }
    Ok((content_build(&dir).ok_or(reason::NOT_A_REPLAY)?, header.server_start_tick.unwrap_or(0).max(0)))
}

/// Read the whole demo into one sample per game second, streamed from the file
/// ([`observe_stream`]).
pub fn observe(path: &Path, match_id: u64) -> Result<Obs, Failure> {
    observe_stream(|| std::fs::File::open(path), match_id)
}

/// [`observe`] over the memory-mapped file: boon's own index and run. The streamed parse gives
/// the same bytes (docs/research/parser-memory.md, "Streamed"); this stays for that check.
#[cfg(feature = "mmap")]
pub fn observe_mapped(path: &Path, match_id: u64) -> Result<Obs, Failure> {
    let (build, server_start) = header(path)?;
    if build < FIRST_CURRENT_BUILD {
        return Err(reason::OLD_MAP);
    }
    let parser = boon::Parser::from_file(path).map_err(|_| reason::NOT_A_REPLAY)?;
    let ability_classes = crate::parse_hero::ability_classes(&parser);
    observe_with(match_id, build, server_start, &ability_classes, |classes, properties, events, on_tick| {
        parser.run_to_end_with_properties(classes, properties, Some(events), on_tick).map_err(|_| reason::PARSE_FAILED)
    })
}

/// Read the whole demo front to back from `open()`'s reader, through a bounded buffer: no map
/// and no whole-file buffer (boon's vendored `StreamParser`, crates/vendor/VENDORED.md). The
/// header checks come from the stream's own `DEM_FileHeader`. `open` is called again only for a
/// demo whose schema changes after signon, which the property filter can't follow: that one is
/// played a second time with full decoding, as the mapped parse does from its index.
pub fn observe_stream<R: std::io::Read>(mut open: impl FnMut() -> std::io::Result<R>, match_id: u64) -> Result<Obs, Failure> {
    let mut full = false;
    loop {
        let mut reader = open().map_err(|_| reason::NOT_A_REPLAY)?;
        let ((build, server_start), read) = peek_header(&mut reader)?;
        if build < FIRST_CURRENT_BUILD {
            return Err(reason::OLD_MAP);
        }
        let parser = boon::StreamParser::new(std::io::Cursor::new(read).chain(reader)).map_err(|_| reason::NOT_A_REPLAY)?;
        let ability_classes = crate::parse_hero::ability_classes_of(parser.class_info(), parser.serializers());
        let mut schema_changed = false;
        let obs = observe_with(match_id, build, server_start, &ability_classes, |classes, properties, events, on_tick| {
            let properties = if full { &[] } else { properties };
            parser.run_to_end_with_properties(classes, properties, Some(events), on_tick).map_err(|e| {
                schema_changed = e.is_schema_change();
                reason::PARSE_FAILED
            })
        });
        match obs {
            Err(_) if schema_changed && !full => full = true,
            obs => return obs,
        }
    }
}

/// The header checks on a stream's first command (`DEM_FileHeader`), before its signon is
/// parsed, as [`header`] does for a file. Returns the bytes it read, to be read again.
fn peek_header(r: &mut impl std::io::Read) -> Result<((u32, i32), Vec<u8>), Failure> {
    use crate::preview::{cmd, header};
    // The file header (16 bytes) and the longest command header (three 5-byte varints).
    let mut read = vec![0; 16 + 15];
    r.read_exact(&mut read).map_err(|_| reason::NOT_A_REPLAY)?;
    let h = header(&read[16..]).filter(|h| read[..8] == *crate::DEM_MAGIC && h.cmd == cmd::FILE_HEADER && h.size <= 1 << 20).ok_or(reason::NOT_A_REPLAY)?;
    let body = 16 + h.len..16 + h.len + h.size as usize;
    if read.len() < body.end {
        let have = read.len();
        read.resize(body.end, 0);
        r.read_exact(&mut read[have..]).map_err(|_| reason::NOT_A_REPLAY)?;
    }
    let raw = &read[body];
    let raw = if h.compressed { snap::raw::Decoder::new().decompress_vec(raw).map_err(|_| reason::NOT_A_REPLAY)? } else { raw.to_vec() };
    let header = boon_proto::proto::CDemoFileHeader::decode(&raw[..]).map_err(|_| reason::NOT_A_REPLAY)?;
    Ok((checked(header)?, read))
}

/// The callback a parse runs on every tick: the entities and the tick's collected messages.
pub type Run<'a> = dyn FnMut(&boon::Context, &[boon::GameEvent]) + 'a;

/// [`observe`] after the header checks. `run` plays the demo through the callback it's given,
/// with the class filter, the property filter and the message types to collect: in one run
/// over the mapped file here, or in several (docs/research/parser-memory.md, "the spliced
/// read"). `ability_classes` is [`crate::parse_hero::ability_classes`] for the demo.
pub fn observe_with(
    match_id: u64,
    build: u32,
    server_start: i32,
    ability_classes: &[String],
    run: impl FnOnce(&HashSet<&str>, &[(&str, &[&str])], &HashSet<u32>, &mut Run<'_>) -> Result<(), Failure>,
) -> Result<Obs, Failure> {
    let mut classes: HashSet<&str> = [CONTROLLER, PAWN, RULES, KOTH, PICKUP, PICKUP_MODIFIER, TROOPER, ZIP_NODE, IDOL, IDOL_RETURN, TEAM, HEAL, BREAKABLE].into_iter().collect();
    classes.extend(OBJECTIVES.iter().map(|(c, _)| *c));
    // Format 7: the ability and item entities, for cooldowns and charges.
    classes.extend(ability_classes.iter().map(String::as_str));
    let mut hero = crate::parse_hero::HeroTracker::new();
    let mut heights: HashMap<i32, u8> = HashMap::new();
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
    let mut buffs: Vec<BuffObs> = Vec::new();
    let mut buff_state: BuffState = HashMap::new();
    let mut heals: Vec<HealObs> = Vec::new();
    let mut heal_state: HealState = HashMap::new();
    let mut crates: Vec<CrateObs> = Vec::new();
    let mut crate_state: HealState = HashMap::new();
    let mut rejuv: Vec<RejuvObs> = Vec::new();
    let mut rejuv_counts: Vec<RejuvCount> = Vec::new();
    let mut koth: Vec<KothObs> = Vec::new();
    let mut fow_keys: Vec<[K; 4]> = Vec::new();
    let mut seen_now: HashMap<i32, bool> = HashMap::new();
    let mut vision: Vec<VisionObs> = Vec::new();
    // Only the fields read are kept for the classes with many entities (docs/research/
    // parser-memory.md: 709 breakable props, ~200 troopers and 334 zipline nodes held 11 of the
    // 13 MB of entity state), and only the messages read are collected.
    let kept = [(TROOPER, kept_fields(&["m_iHealth", "m_iMaxHealth", "m_lifeState", "m_iTeamNum", "m_iLane"])), (BREAKABLE, kept_fields(&["m_nSubclassID"])), (ZIP_NODE, kept_fields(&["m_iTeamNum", "m_iPrimaryLane"]))];
    let kept: Vec<(&str, Vec<&str>)> = kept.iter().map(|(c, f)| (*c, f.iter().map(String::as_str).collect())).collect();
    let properties: Vec<(&str, &[&str])> = kept.iter().map(|(c, f)| (*c, f.as_slice())).collect();
    let event_types: HashSet<u32> = [IMPORTANT_ABILITY_USED, REJUV_STATUS].into_iter().chain(crate::parse_hero::EVENT_TYPES).collect();
    run(&classes, &properties, &event_types, &mut |ctx, events| {
        let k = keys.get_or_insert_with(|| Keys::resolve(ctx));
        if !over {
            hero.modifiers(ctx);
        }
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
        let start = f64::from(rules.get_f32(k.game_start));
        let pause = Pause { total: rules.get_i64(k.paused_ticks), running: rules.get_bool(k.game_paused), since: rules.get_i64(k.pause_start) };
        let now = server_clock(i64::from(ctx.tick() + server_start), pause, interval);
        let game = now - start;
        // Camp timers change on any tick: read them on every one, from the horn.
        if start > 0.0 && game >= 0.0 {
            camp_timers(k, rules, game as f32, &mut camp_slots);
            urn_tick(ctx, k, game as f32, &mut urn);
            buff_tick(ctx, k, game as f32, &mut buff_state, &mut buffs);
            heal_tick(ctx, k, game as f32, &mut heal_state, &mut heals);
            crate_tick(ctx, k, game as f32, &mut crate_state, &mut crates);
            for e in events.iter().filter(|e| e.msg_type == REJUV_STATUS) {
                rejuv.extend(rejuv_status(ctx, k, game as f32, &e.payload));
            }
            rejuv_tick(k, rules, game as f32, &mut rejuv_counts);
            koth_tick(k, rules, start, game, &mut koth);
            vision_tick(ctx, k, game as f32, &mut fow_keys, &mut seen_now, &mut vision, &mut |player, level| crate::parse_hero::height(&mut hero.data, &mut heights, game as f32, player, level));
            hero.tick(ctx, events, game, start);
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
    })?;
    // Nodes first seen after a sample was taken make earlier samples short: those hold.
    Ok(Obs { match_id, build, game_mode, winner, seconds, zip_nodes, camp_slots, urn, buffs, heals, crates, rejuv, rejuv_counts, koth, vision, hero_data: hero.finish() })
}

/// `fields` and a body's origin (either layout: [`Body::of`]), for boon's property filter.
fn kept_fields(fields: &[&str]) -> Vec<String> {
    let origin = [ORIGIN, BODY_ORIGIN].into_iter().flat_map(|o| ["m_cellX", "m_cellY", "m_cellZ", "m_vecX", "m_vecY", "m_vecZ"].map(|c| format!("{o}.{c}")));
    origin.chain(fields.iter().map(|f| (*f).to_owned())).collect()
}

/// The game rules' pause state on one tick.
#[derive(Clone, Copy, Default)]
pub(crate) struct Pause {
    /// `m_nTotalPausedTicks`: the ticks of the pauses that have ended (it only grows at an unpause).
    pub(crate) total: i64,
    /// `m_bGamePaused`.
    pub(crate) running: bool,
    /// `m_nPauseStartTick`: the server tick the running pause began.
    pub(crate) since: i64,
}

/// The server's `GameTime_t` clock, in seconds, at `server_tick`: pauses don't count. The
/// running pause isn't in the total yet (129738985: 0 throughout its 1,706-tick pause, then
/// 1,706), so it's counted from its start: the clock holds through a pause instead of running on
/// and jumping back at the unpause, which repeated the paused frame and lost as much match after.
pub(crate) fn server_clock(server_tick: i64, pause: Pause, interval: f64) -> f64 {
    let running = if pause.running && pause.since > 0 { (server_tick - pause.since).max(0) } else { 0 };
    (server_tick - pause.total - running) as f64 * interval
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

/// Record each bridge powerup pickup where it changes (exploration round 7). Other pickups of the
/// class (the statues' permanent drops) carry other subclasses and are skipped.
fn buff_tick(ctx: &boon::Context, k: &Keys, game: f32, state: &mut BuffState, out: &mut Vec<BuffObs>) {
    let now: Vec<Seen> = ctx
        .entities()
        .iter()
        .filter(|(_, e)| e.class_name.as_ref() == PICKUP_MODIFIER)
        .filter_map(|(_, e)| {
            let sub = e.get_i64(k.pickup_mod_sub) as u32;
            let buff = BUFF_TOKENS.iter().find(|(t, _)| *t == sub).map(|(_, b)| *b)?;
            Some((e.index, buff, e.active && e.get_bool(k.pickup_mod_active), k.pickup_mod.pos(e)))
        })
        .collect();
    buff_changes(&now, game, state, out);
}

/// A bridge pickup as seen on a tick: its entity index, buff, whether it's up, and where.
type Seen = (i32, &'static str, bool, [f32; 2]);

/// Each tracked pickup's last state (active, buff) and where it is, by entity index.
type BuffState = HashMap<i32, (bool, &'static str, [f32; 2])>;

/// The pickups seen this tick (index, buff, active, position) against the last: each change is an
/// observation. One that's gone while up (deleted, or re-created at another index, instead of
/// turning inactive) was taken: observed inactive where it was, before this tick's changes, so a
/// re-created pickup's spawn still reads as one.
fn buff_changes(now: &[Seen], game: f32, state: &mut BuffState, out: &mut Vec<BuffObs>) {
    let mut gone: Vec<i32> = state.keys().copied().filter(|i| !now.iter().any(|n| n.0 == *i)).collect();
    gone.sort_unstable();
    for i in gone {
        if let Some((true, buff, pos)) = state.remove(&i) {
            out.push(BuffObs { game, pos, active: false, buff });
        }
    }
    for &(i, buff, active, pos) in now {
        if state.insert(i, (active, buff, pos)).map(|(a, b, _)| (a, b)) != Some((active, buff)) {
            out.push(BuffObs { game, pos, active, buff });
        }
    }
}

/// Each health pickup's last state by entity (index, serial): up or not, and where it came up
/// (taken, it flies to the hero before it goes inactive).
type HealState = HashMap<(i32, u32), (bool, [f32; 2])>;

/// Record each health pickup where it comes up or goes, at the spot it came up (exploration on
/// 129738985: a map pickup comes up at its spawner and is back 180 s after it's taken; the drops
/// come up elsewhere and are told apart by place in derive).
fn heal_tick(ctx: &boon::Context, k: &Keys, game: f32, state: &mut HealState, out: &mut Vec<HealObs>) {
    for (_, e) in ctx.entities().iter().filter(|(_, e)| e.class_name.as_ref() == HEAL) {
        up_down((e.index, e.serial), e.active && e.get_bool(k.heal_active), || k.heal.pos(e), game, state, out);
    }
}

/// Record each tough crate where it breaks (goes inactive) or is back (exploration on 129738985:
/// one entity per crate all match, inactive while broken, back 180 s later). The other breakable
/// props, wooden crates among them (one sits 11 units from a tough crate), aren't read.
fn crate_tick(ctx: &boon::Context, k: &Keys, game: f32, state: &mut HealState, out: &mut Vec<CrateObs>) {
    for (_, e) in ctx.entities().iter().filter(|(_, e)| e.class_name.as_ref() == BREAKABLE) {
        if e.get_i64(k.breakable_sub) as u32 != TOUGH_CRATE_TOKEN {
            continue;
        }
        up_down((e.index, e.serial), e.active, || k.breakable.pos(e), game, state, out);
    }
}

/// One entity's up or down now against its last state: a change is recorded at the spot it came
/// up (a taken pickup flies to the hero first), and one first seen down says nothing.
fn up_down(id: (i32, u32), active: bool, pos: impl Fn() -> [f32; 2], game: f32, state: &mut HealState, out: &mut Vec<HealObs>) {
    let last = state.get(&id).copied();
    if last.map(|(a, _)| a) == Some(active) {
        return;
    }
    let at = if active { pos() } else { last.map_or_else(&pos, |(_, at)| at) };
    state.insert(id, (active, at));
    if active || last.is_some() {
        out.push(HealObs { game, ent: id, pos: at, active });
    }
}

/// `k_EUserMsg_RejuvStatus` (timers audit): the Rejuvenator taken (4, one per shard), a revive
/// used (5) or expired (6), for `user_team`.
const REJUV_STATUS: u32 = 350;

fn rejuv_status(ctx: &boon::Context, k: &Keys, game: f32, payload: &[u8]) -> Option<RejuvObs> {
    let m = boon_proto::proto::CCitadelUserMsgRejuvStatus::decode(payload).ok()?;
    let what = match m.event_type? {
        4 => RejuvWhat::Taken,
        5 => RejuvWhat::Revive,
        6 => RejuvWhat::Expired,
        _ => return None,
    };
    let team = i64::from(m.user_team?);
    // The pawn's controller: the player, as samples know them.
    let ents = ctx.entities();
    let pawn = m.player_pawn.and_then(|h| ents.get_by_handle(h)).filter(|p| p.class_name.as_ref() == PAWN);
    let player = pawn.and_then(|p| {
        ents.iter()
            .filter(|(_, e)| e.class_name.as_ref() == CONTROLLER)
            .find(|(_, e)| e.get_handle(k.ctrl_pawn).and_then(|h| ents.get_by_handle(h)).is_some_and(|q| q.index == p.index))
            .map(|(_, e)| e.index)
    });
    Some(RejuvObs { game, what, team, player })
}

/// Record the teams' Rejuvenator charges where either changes.
fn rejuv_tick(k: &Keys, rules: &boon::entity::Entity, game: f32, out: &mut Vec<RejuvCount>) {
    let [amber, sapphire] = k.rejuv_count.map(|f| rules.get_i64(f));
    if out.last().map_or(amber != 0 || sapphire != 0, |l| l.amber != amber || l.sapphire != sapphire) {
        out.push(RejuvCount { game, amber, sapphire });
    }
}

/// Sample the open rift's capture progress and give-up deadline on the
/// [`crate::timeline::CAPTURE_EVERY_DS`] grid, while a cash-in is open and running.
fn koth_tick(k: &Keys, rules: &boon::entity::Entity, start: f64, game: f64, out: &mut Vec<KothObs>) {
    let every = f64::from(crate::timeline::CAPTURE_EVERY_DS) / 10.0;
    let slot = (game / every).floor();
    if out.last().is_some_and(|l| (f64::from(l.game) / every).round() >= slot) {
        return;
    }
    let cash_in = rules.get_f32(k.koth_started);
    if !(cash_in > 0.0 && cash_in.is_finite()) {
        return;
    }
    // FLT_MAX until it's set, 0 once captured. Its first tick open, the cash-in still holds the
    // last rift's progress (129738985: 99% and 100% at 19:51.61); the deadline is set, and the
    // progress reset, a tick later. Unset, it's not running: no sample.
    let g = f64::from(rules.get_f32(k.koth_give_up));
    if !(g > 0.0 && g < 1e9) {
        return;
    }
    let give_up = Some((g - start) as f32);
    let [amber, sapphire] = k.koth_progress.map(|f| rules.get_f32(f));
    out.push(KothObs { game: (slot * every) as f32, amber, sapphire, give_up });
}

const STAT_VIEWER: &str = "m_PlayerDataGlobal.m_vecStatViewerModifierValues";
/// Stat-viewer entries read per controller: one per pickup kind and level plus Spirit Snatch and
/// the like (129738985: at most 14).
const STAT_VIEWER_MAX: usize = 64;

/// A controller's statue-pickup totals ([`crate::timeline::Player::pickups`] columns), from its
/// stat viewer; `None` when the vector isn't networked.
fn pickups(k: &Keys, e: &boon::entity::Entity) -> Option<[f32; 5]> {
    let n = usize::try_from(int(k.stat_viewer.and_then(|key| e.fields.get(&key)))?).ok()?;
    let mut out = [0.0f32; 5];
    for [src, kind, value] in k.stat_viewer_entries.iter().take(n) {
        let field = |f: &K| int(f.and_then(|key| e.fields.get(&key)));
        let (Some(src), Some(kind)) = (field(src), field(kind)) else { continue };
        if let Some((_, _, column)) = k.pickup_sources.iter().find(|(s, t, _)| i64::from(*s) == src && i64::from(*t) == kind) {
            out[*column] += e.get_f32(*value);
        }
    }
    Some(out)
}

/// A networked integer of any width (the FOW entry's fields are a mix of widths and a bool).
fn int(v: Option<&boon::FieldValue>) -> Option<i64> {
    use boon::FieldValue as F;
    match v? {
        F::I32(n) => Some(i64::from(*n)),
        F::U32(n) => Some(i64::from(*n)),
        F::I64(n) => Some(*n),
        F::U64(n) => i64::try_from(*n).ok(),
        F::Bool(b) => Some(i64::from(*b)),
        _ => None,
    }
}

/// Each team's minimap feed for the other team's heroes, on every tick (docs/research/
/// replay-vision.md): a [`VisionObs`] wherever a hero's `m_bVisibleOnMap` for the enemy team
/// changes. Entries name the pawn's entity index; the controller whose `m_hPawn` it is gives the
/// player ([`HeroObs::id`]). A hero not in this tick's feed keeps its last state.
fn vision_tick(ctx: &boon::Context, k: &Keys, game: f32, keys: &mut Vec<[K; 4]>, now: &mut HashMap<i32, bool>, out: &mut Vec<VisionObs>, height: &mut dyn FnMut(i32, i64)) {
    let ents = ctx.entities();
    // Pawn entity index → (controller index, team).
    let mut by_pawn: HashMap<i32, (i32, i64)> = HashMap::new();
    for (_, e) in ents.iter().filter(|(_, e)| e.class_name.as_ref() == CONTROLLER) {
        if let Some(p) = e.get_handle(k.ctrl_pawn).and_then(|h| ents.get_by_handle(h)).filter(|p| p.class_name.as_ref() == PAWN) {
            by_pawn.insert(p.index, (e.index, e.get_i64(k.ctrl_team)));
        }
    }
    let Some(ser) = ctx.serializers().get(TEAM) else { return };
    for (_, t) in ents.iter().filter(|(_, e)| e.active && e.class_name.as_ref() == TEAM) {
        let Some(observer @ (2 | 3)) = int(t.field_value(k.team_num)) else { continue };
        let n = int(t.field_value(k.fow_count)).unwrap_or(0).clamp(0, MAX_FOW as i64) as usize;
        while keys.len() < n {
            let i = keys.len();
            let f = |name: &str| ser.resolve_field_key(&format!("{FOW}.{i}.{name}"));
            keys.push([f("m_eClass"), f("m_nEntIndex"), f("m_bVisibleOnMap"), f("m_eHeight")]);
        }
        for [class, ent, visible, level] in &keys[..n] {
            if int(t.field_value(*class)) != Some(FOW_HERO) {
                continue;
            }
            let Some(&(player, team)) = int(t.field_value(*ent)).and_then(|i| i32::try_from(i).ok()).and_then(|i| by_pawn.get(&i)) else { continue };
            if team == observer {
                // The hero's own team's feed always sees it: its height (elevation.md).
                height(player, int(t.field_value(*level)).unwrap_or(0));
                continue;
            }
            let v = int(t.field_value(*visible)) == Some(1);
            if now.insert(player, v) != Some(v) {
                out.push(VisionObs { game, player, visible: v });
            }
        }
    }
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
                max_health: pawn.filter(|p| p.active).map_or(0, |p| p.get_i64(k.pawn.max_health)),
                kills: int(k.ctrl_kills.and_then(|key| e.fields.get(&key))).and_then(|v| u32::try_from(v).ok()),
                assists: int(k.ctrl_assists.and_then(|key| e.fields.get(&key))).and_then(|v| u32::try_from(v).ok()),
                level: int(k.ctrl_level.and_then(|key| e.fields.get(&key))).and_then(|v| u32::try_from(v).ok()).filter(|v| *v > 0),
                pickups: pickups(k, e),
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

#[cfg(test)]
mod tests {
    use super::*;

    use crate::timeline::token;

    /// 129738985's pause (the pause probe): paused at tick 9482 (server tick 13906) for 1,706
    /// ticks; the total is 0 until the unpause.
    #[test]
    fn the_clock_holds_through_a_pause_and_runs_on_after_it() {
        const START: i64 = 4424;
        let i = 1.0 / 64.0;
        let before = server_clock(START + 9481, Pause::default(), i);
        let at = |tick: i64, running: bool, total: i64| server_clock(START + tick, Pause { total, running, since: if running { 13906 } else { 0 } }, i);
        let pausing = at(9482, true, 0);
        assert!((pausing - before - i).abs() < 1e-9, "the pause's first tick is the next instant");
        assert_eq!(at(10_500, true, 0), pausing, "held while paused");
        assert_eq!(at(11_187, true, 0), pausing, "held to the last paused tick");
        assert_eq!(at(11_188, false, 1706), pausing, "the unpause picks up where it held");
        assert!((at(11_252, false, 1706) - pausing - 1.0).abs() < 1e-9, "and runs on: 64 ticks a second");
    }

    #[test]
    fn buff_tokens_are_the_pickups_names() {
        // boon's known pair (hero_stats/inputs.rs) checks the hash itself.
        assert_eq!(token("modifier_player_pinged"), 1_215_616_703);
        for (t, b) in BUFF_TOKENS {
            assert_eq!(t, token(&format!("{b}_powerup_pickup")), "{b}");
        }
        assert_eq!(TOUGH_CRATE_TOKEN, token("citadel_breakable_prop_tough_crate"));
    }

    #[test]
    fn a_pickup_gone_while_up_was_taken_and_its_successor_spawns() {
        let (west, east) = ([-3936.0, 136.0], [3936.0, -128.0]);
        let mut state = BuffState::new();
        let mut out = Vec::new();
        let ticks: [(f32, &[Seen]); 6] = [
            (300.0, &[(10, "gun", true, west), (11, "casting", true, east)]),
            (300.1, &[(10, "gun", true, west), (11, "casting", true, east)]),
            // Deleted while up, not turned inactive.
            (305.0, &[(11, "casting", true, east)]),
            // Re-created at a new index in the very tick the old one goes.
            (600.0, &[(12, "movement", true, west), (13, "survival", true, east)]),
            // Gone once taken: nothing more to say.
            (610.0, &[(12, "movement", false, west), (13, "survival", true, east)]),
            (611.0, &[(13, "survival", true, east)]),
        ];
        for (game, now) in ticks {
            buff_changes(now, game, &mut state, &mut out);
        }
        let got: Vec<(f32, [f32; 2], bool, &str)> = out.iter().map(|b| (b.game, b.pos, b.active, b.buff)).collect();
        assert_eq!(
            got,
            [
                (300.0, west, true, "gun"),
                (300.0, east, true, "casting"),
                (305.0, west, false, "gun"),
                (600.0, east, false, "casting"),
                (600.0, west, true, "movement"),
                (600.0, east, true, "survival"),
                (610.0, west, false, "movement"),
            ]
        );
    }
}
