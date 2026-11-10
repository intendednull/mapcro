//! Against real replays on this machine, never committed (they're large and carry players).
//! `MAPCRO_REPLAY=/path/to/current.dem MAPCRO_OLD_REPLAY=/path/to/pre-6712.dem
//! MAPCRO_BRAWL_REPLAY=/path/to/street-brawl.dem
//! cargo test -p mapcro-replay --release -- --ignored`

use mapcro_replay::{reason, timeline, worker};
use std::path::PathBuf;

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).map(PathBuf::from).filter(|p| p.is_file())
}

#[test]
#[ignore = "needs a local replay: MAPCRO_REPLAY"]
fn a_current_replay_becomes_a_timeline_the_server_accepts() {
    let Some(dem) = env_path("MAPCRO_REPLAY") else { panic!("set MAPCRO_REPLAY to a current-map .dem") };
    let dir = tempfile::tempdir().expect("dir");
    let out = dir.path().join("t.json");
    let started = std::time::Instant::now();
    worker::job(&dem, &out, 1, 2 << 30).expect("parses");
    let bytes = std::fs::read(&out).expect("output");
    let t = timeline::validate(&bytes).expect("the server's checks pass");
    eprintln!("{} s of match, {} players, {} KB, parsed in {:.1} s", t.duration_s, t.players.len(), bytes.len() / 1024, started.elapsed().as_secs_f64());
    assert!(t.duration_s > 60);
    assert!(t.players.len() >= 8);
    assert!(t.players.iter().all(|p| p.hero_id != 0 && p.x.iter().filter(|x| x.is_some()).count() > t.duration_s as usize / 2));
    assert!(t.players.iter().any(|p| p.ult.iter().any(|u| u.is_some_and(|u| u > 0))), "ults go on cooldown");
    let lanes: Vec<&str> = t.zips.iter().map(|z| z.lane.as_str()).collect();
    assert_eq!(lanes, ["lane1", "lane4", "lane6"], "every lane has its zipline colours");
    assert!(t.zips.iter().all(|z| z.at.len() > 100 && z.at[0][0] == 0), "the colours move, from the start");
    assert_eq!(t.camps.len(), 52, "51 camps and the mid boss, each matched to a site");
    assert!(t.camps.iter().filter(|c| c.key.starts_with("camp:")).all(|c| !c.cleared.is_empty() && c.first_s >= 120), "every camp spawns and is cleared");
    assert!(bytes.len() < 4 << 20, "compact");
}

/// 129738985's Rejuvenators and rifts, against the game's own `RejuvStatus` messages (the timer
/// audit's `--messages 350`: ticks 121537 / 133057 and 154925 / 166445 are 1872.3 / 2052.3 and
/// 2394.0 / 2574.0 on the match clock) and give-up deadlines (`m_timeKothGiveUp` − game start).
#[test]
#[ignore = "needs 129738985: MAPCRO_REPLAY_129738985"]
fn match_129738985_has_its_rejuvenators_and_rift_captures() {
    let Some(dem) = env_path("MAPCRO_REPLAY_129738985") else { panic!("set MAPCRO_REPLAY_129738985 to 129738985.dem") };
    let dir = tempfile::tempdir().expect("dir");
    let out = dir.path().join("t.json");
    worker::job(&dem, &out, 129_738_985, 2 << 30).expect("parses");
    let t = timeline::validate(&std::fs::read(&out).expect("output")).expect("the server's checks pass");
    let rejuv: Vec<(&str, u32, u32, &[[u32; 2]])> = t.rejuv.iter().map(|r| (r.team.as_str(), r.taken_s, r.ends_s, r.left.as_slice())).collect();
    assert_eq!(rejuv, [("sapphire", 1872, 2052, &[[1872, 3], [1927, 2], [1952, 1]][..]), ("amber", 2394, 2574, &[[2394, 2], [2395, 3], [2538, 2], [2544, 1]][..])]);
    let ev: Vec<(u32, &str, Option<&str>, bool)> = t.events.iter().filter(|e| e.kind.starts_with("rejuv_")).map(|e| (e.t, e.kind.as_str(), e.team.as_deref(), e.hero_id.is_some())).collect();
    let (s, a) = (Some("sapphire"), Some("amber"));
    assert_eq!(
        ev,
        [
            (1872, "rejuv_taken", s, false),
            (1930, "rejuv_revive", s, true),
            (1955, "rejuv_revive", s, true),
            (2052, "rejuv_expired", s, false),
            (2394, "rejuv_taken", a, false),
            (2541, "rejuv_revive", a, true),
            (2547, "rejuv_revive", a, true),
            (2574, "rejuv_expired", a, false),
        ]
    );
    let give_up: Vec<Option<u32>> = t.rifts.iter().map(|r| r.give_up_s).collect();
    assert_eq!(give_up, [Some(795), Some(1252), Some(1676), Some(2101), Some(2465)]);
    // Each rift ends with its capturer's progress full, as the capture events say.
    let captured: Vec<Option<String>> = t.events.iter().filter(|e| e.kind == "rift_capture").map(|e| e.team.clone()).collect();
    let full: Vec<Option<String>> = t.rifts.iter().map(|r| r.capture.last().and_then(|l| if l[1] == 100 { Some("amber".into()) } else if l[2] == 100 { Some("sapphire".into()) } else { None })).collect();
    assert_eq!(full, captured);
    assert!(t.rifts.iter().all(|r| r.capture.len() >= 20), "sampled through each capture");
    // Each starts from nothing: the cash-in's first tick still holds the last rift's progress.
    let first: Vec<[u32; 2]> = t.rifts.iter().map(|r| [r.capture[0][1], r.capture[0][2]]).collect();
    assert_eq!(first, [[0, 0]; 5]);
}

/// 129738985 pauses for 1,706 ticks (26.7 s) at 148.1 s of match (the pause probe). The match
/// clock holds through it, so the seconds after it are played, not the frozen frame: before the
/// fix the clock ran on while paused, filling 149–174 with the paused frame, then went back at the
/// unpause and the next 26 s of play were dropped.
#[test]
#[ignore = "needs 129738985: MAPCRO_REPLAY_129738985"]
fn match_129738985_plays_on_after_its_pause() {
    let Some(dem) = env_path("MAPCRO_REPLAY_129738985") else { panic!("set MAPCRO_REPLAY_129738985 to 129738985.dem") };
    let dir = tempfile::tempdir().expect("dir");
    let out = dir.path().join("t.json");
    worker::job(&dem, &out, 129_738_985, 2 << 30).expect("parses");
    let t = timeline::validate(&std::fs::read(&out).expect("output")).expect("the server's checks pass");
    // Seconds in which somebody moved from the second before.
    let moved = |s: usize| t.players.iter().any(|p| p.x[s] != p.x[s - 1] || p.y[s] != p.y[s - 1]);
    let still: Vec<usize> = (149..=175).filter(|s| !moved(*s)).collect();
    assert!(still.is_empty(), "frozen seconds after the pause: {still:?}");
    assert!((2635..=2645).contains(&t.duration_s), "the match's length, pauses out: {}", t.duration_s);
}

/// 129738985's vision (docs/research/replay-vision.md): when each hero's enemies could see it,
/// from the teams' own minimap feeds. Nobody is seen before the laners first meet, at 18.2 s;
/// almost every hero is seen as it dies (77 of 79 at the death tick in the spike); the merged
/// intervals number about 2,053.
#[test]
#[ignore = "needs 129738985: MAPCRO_REPLAY_129738985"]
fn match_129738985_says_when_each_hero_was_seen() {
    let Some(dem) = env_path("MAPCRO_REPLAY_129738985") else { panic!("set MAPCRO_REPLAY_129738985 to 129738985.dem") };
    let dir = tempfile::tempdir().expect("dir");
    let out = dir.path().join("t.json");
    worker::job(&dem, &out, 129_738_985, 2 << 30).expect("parses");
    let bytes = std::fs::read(&out).expect("output");
    let t = timeline::validate(&bytes).expect("the server's checks pass");
    let n: usize = t.players.iter().map(|p| p.seen.len()).sum();
    let seen_bytes: usize = t.players.iter().map(|p| serde_json::to_string(&p.seen).expect("json").len() + ",\"seen\":".len()).sum();
    let first = t.players.iter().filter_map(|p| p.seen.first()).map(|s| s[0]).min();
    let deaths: Vec<u32> = t.players.iter().flat_map(|p| p.deaths.iter().map(move |&d| (p, d))).map(|(p, d)| u32::from(p.seen.iter().any(|s| s[0] <= d * 10 && d * 10 <= s[1] + 10))).collect();
    let share: Vec<u32> = t.players.iter().map(|p| p.seen.iter().map(|s| s[1] - s[0]).sum::<u32>() * 100 / (t.duration_s * 10)).collect();
    eprintln!("{n} intervals, {seen_bytes} bytes of seen, timeline {} bytes; first seen at {first:?} ds; {} of {} deaths seen; seen % per hero {share:?}", bytes.len(), deaths.iter().sum::<u32>(), deaths.len());
    assert_eq!((n, first), (2052, Some(182)), "the spike's merged count; nobody seen before the laners meet");
    assert_eq!((deaths.iter().sum::<u32>(), deaths.len()), (73, 74), "seen within a second of dying");
    assert!(share.iter().all(|s| (30..50).contains(s)), "each hero seen a third to a half of the match");
    assert!(seen_bytes < 30_000, "about 27 KB");
}

#[test]
#[ignore = "needs a local replay: MAPCRO_OLD_REPLAY"]
fn an_old_map_replay_is_refused() {
    let Some(dem) = env_path("MAPCRO_OLD_REPLAY") else { panic!("set MAPCRO_OLD_REPLAY to a pre-6712 .dem") };
    let dir = tempfile::tempdir().expect("dir");
    assert_eq!(worker::job(&dem, &dir.path().join("t.json"), 1, 2 << 30), Err(reason::OLD_MAP));
}

#[test]
#[ignore = "needs a local replay: MAPCRO_BRAWL_REPLAY"]
fn a_street_brawl_replay_is_refused() {
    let Some(dem) = env_path("MAPCRO_BRAWL_REPLAY") else { panic!("set MAPCRO_BRAWL_REPLAY to a Street Brawl .dem") };
    let dir = tempfile::tempdir().expect("dir");
    assert_eq!(worker::job(&dem, &dir.path().join("t.json"), 1, 2 << 30), Err(reason::BRAWL));
}

/// Per hero, how much of the match has a position, and the longest run without one while
/// alive (review 2026-11-08: is a recording missing heroes?). Prints, asserts nothing.
#[test]
#[ignore = "needs a local replay: MAPCRO_REPLAY"]
fn hero_presence() {
    let Some(dem) = env_path("MAPCRO_REPLAY") else { panic!("set MAPCRO_REPLAY") };
    let obs = mapcro_replay::parse::observe(&dem, 1).expect("parses");
    eprintln!("game mode {}", obs.game_mode);
    let t = mapcro_replay::derive::derive(&obs, mapcro_replay::map::current()).expect("derives");
    for p in &t.players {
        let n = p.x.len().max(1);
        let placed = p.x.iter().filter(|x| x.is_some()).count();
        let alive = p.health.iter().filter(|h| **h > 0).count();
        let (mut run, mut longest) = (0, 0);
        for (x, h) in p.x.iter().zip(&p.health) {
            if x.is_none() && *h > 0 {
                run += 1;
                longest = longest.max(run);
            } else {
                run = 0;
            }
        }
        eprintln!("{} {} hero {}: position {:.1}% of {n} s, alive {:.1}%, longest alive without a position {longest} s, deaths {}", p.team, p.slot, p.hero_id, 100.0 * placed as f64 / n as f64, 100.0 * alive as f64 / n as f64, p.deaths.len());
    }
}

/// 129738985's neutral objectives (docs/research/map-objectives-audit.md): the game rules' 52 camp
/// timers sit on the built-in map's 51 camps and the mid boss, and the 15 Sinner's Sacrifice
/// machines stand in the 11 `vaults` camps, three on the bell tower and two on the theater
/// balcony and the slums garage roof. Each camp first spawns on its tier's schedule
/// (misc.vdata: weak 120, medium 300, strong and vaults 480).
#[test]
#[ignore = "needs 129738985: MAPCRO_REPLAY_129738985"]
fn match_129738985_has_every_camp_and_sinners_sacrifice() {
    use boon::{Parser, world_position};
    use std::collections::{BTreeMap, HashSet};
    let Some(dem) = env_path("MAPCRO_REPLAY_129738985") else { panic!("set MAPCRO_REPLAY_129738985 to 129738985.dem") };
    let map = mapcro_replay::map::current();
    let tier_of = |key: &str| map.sites.iter().find(|s| s.key == key).and_then(|s| s.tier.clone()).unwrap_or_default();

    let dir = tempfile::tempdir().expect("dir");
    let out = dir.path().join("t.json");
    worker::job(&dem, &out, 129_738_985, 2 << 30).expect("parses");
    let t = timeline::validate(&std::fs::read(&out).expect("output")).expect("the server's checks pass");
    let mut by_tier: BTreeMap<String, (usize, Vec<u32>)> = BTreeMap::new();
    for c in t.camps.iter().filter(|c| c.key.starts_with("camp:")) {
        let e = by_tier.entry(tier_of(&c.key)).or_default();
        e.0 += 1;
        e.1.push(c.first_s);
    }
    let firsts = |tier: &str| by_tier[tier].1.iter().copied().collect::<HashSet<u32>>();
    let counts: Vec<(&str, usize)> = by_tier.iter().map(|(k, v)| (k.as_str(), v.0)).collect();
    assert_eq!(counts, [("medium", 24), ("strong", 12), ("vaults", 11), ("weak", 4)], "every camp timer on a built-in camp");
    assert_eq!(t.camps.iter().filter(|c| c.key.starts_with("mid_boss:")).count(), 1);
    assert_eq!(firsts("weak"), HashSet::from([120]));
    assert_eq!(firsts("medium"), HashSet::from([300]));
    assert_eq!(firsts("strong"), HashSet::from([480]));
    assert_eq!(firsts("vaults"), HashSet::from([480]));
    assert!(t.camps.iter().filter(|c| tier_of(&c.key) == "vaults").all(|c| !c.cleared.is_empty()), "every Sinner's Sacrifice camp was taken at least once");

    // The machines themselves, by camp.
    const SINNER: &str = "CNPC_Neutral_SinnersSacrifice";
    let parser = Parser::from_file(&dem).expect("opens");
    let mut seen: HashSet<(i32, u32)> = HashSet::new();
    let mut per_camp: BTreeMap<String, usize> = BTreeMap::new();
    parser
        .run_to_end_with_events_filtered(&HashSet::from([SINNER]), |ctx, _| {
            let Some(s) = ctx.serializers().get(SINNER) else { return };
            let o = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
            let k = |a: &str| s.resolve_field_key(&format!("{o}.{a}"));
            let (cell, vec) = ([k("m_cellX"), k("m_cellY"), k("m_cellZ")], [k("m_vecX"), k("m_vecY"), k("m_vecZ")]);
            for (_, e) in ctx.entities().iter().filter(|(_, e)| e.class_name.as_ref() == SINNER) {
                if seen.insert((e.index, e.serial)) {
                    let [x, y, _] = world_position(e, cell, vec);
                    // A machine stands within 500 units of its camp's centre (the bell tower's
                    // spread is the widest, 496).
                    let site = map.nearest("camp", f64::from(x), f64::from(y), 520.0).expect("on a camp");
                    *per_camp.entry(site.key.clone()).or_default() += 1;
                }
            }
        })
        .expect("parses");
    assert_eq!(seen.len(), 15, "15 Sinner's Sacrifice machines");
    assert!(per_camp.keys().all(|k| tier_of(k) == "vaults"), "only in vaults camps: {per_camp:?}");
    assert_eq!(per_camp.len(), 11, "one or more in every vaults camp: {per_camp:?}");
    let at = |world: [f64; 2]| map.nearest("camp", world[0], world[1], 1.0).map(|s| per_camp.get(&s.key).copied().unwrap_or(0));
    // Bell tower 3, theater balcony 2, slums garage roof 2.
    assert_eq!([at([3248.0, -1888.0]), at([4160.0, 2784.0]), at([-3264.0, -1600.0])], [Some(3), Some(2), Some(2)]);
}

/// 129738985's map furniture (docs/research/map-objectives-audit.md): the 36 healing pickups
/// come up at 2:30 and are back 180 s after each take (six takes in this match, two of them a
/// pair taken together); the replay's 36 pickup spawners, 4 teleporters and 8 of its 9 shops
/// (the 9th is the base's, in the spawn room) stand on the built-in map's sites.
#[test]
#[ignore = "needs 129738985: MAPCRO_REPLAY_129738985"]
fn match_129738985_has_every_healing_pickup_shop_and_teleporter() {
    use boon::{Parser, world_position};
    use std::collections::{BTreeMap, HashSet};
    let Some(dem) = env_path("MAPCRO_REPLAY_129738985") else { panic!("set MAPCRO_REPLAY_129738985 to 129738985.dem") };
    let map = mapcro_replay::map::current();
    let key_at = |kind: &str, x: f64, y: f64| map.nearest(kind, x, y, 1.0).map(|s| s.key.clone()).unwrap_or_else(|| panic!("a {kind} site at {x}, {y}"));

    let dir = tempfile::tempdir().expect("dir");
    let out = dir.path().join("t.json");
    worker::job(&dem, &out, 129_738_985, 2 << 30).expect("parses");
    let t = timeline::validate(&std::fs::read(&out).expect("output")).expect("the server's checks pass");
    assert_eq!(t.heals.len(), 36, "every healing pickup");
    assert_eq!(t.heals.iter().map(|h| h.first_s).collect::<HashSet<u32>>(), HashSet::from([150]), "all up at 2:30");
    let taken: BTreeMap<String, Vec<[u32; 2]>> = t.heals.iter().filter(|h| !h.cleared.is_empty()).map(|h| (h.key.clone(), h.cleared.clone())).collect();
    let want: BTreeMap<String, Vec<[u32; 2]>> = [
        (key_at("heal", -8016.0, 2560.0), vec![[402, 582]]),
        (key_at("heal", -7946.0, 4000.0), vec![[477, 658]]),
        (key_at("heal", -7878.0, 4000.0), vec![[477, 658]]),
        (key_at("heal", 5024.0, 1240.0), vec![[926, 1106]]),
        (key_at("heal", -4128.0, -4448.0), vec![[1937, 2117]]),
        (key_at("heal", 2560.0, -5120.0), vec![[2022, 2203]]),
    ]
    .into_iter()
    .collect();
    assert_eq!(taken, want);
    assert!(taken.values().flatten().all(|[a, b]| (180..=181).contains(&(b - a))), "back 180 s after");

    // The replay's own entities, on the built-in sites.
    const SHOP: &str = "CTriggerItemShop";
    const TELEPORT: &str = "CCitadelTeleportTrigger";
    const SPAWNER: &str = "CCitadel_PickupSpawner";
    let parser = Parser::from_file(&dem).expect("opens");
    let mut seen: HashSet<(i32, u32)> = HashSet::new();
    let mut at: BTreeMap<&str, Vec<(String, [f32; 2])>> = BTreeMap::new();
    parser
        .run_to_end_with_events_filtered(&HashSet::from([SHOP, TELEPORT, SPAWNER]), |ctx, _| {
            for (_, e) in ctx.entities().iter() {
                let class = e.class_name.as_ref();
                let Some(s) = ctx.serializers().get(class) else { continue };
                if !seen.insert((e.index, e.serial)) {
                    continue;
                }
                let skel = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
                let o = if s.resolve_field_key(&format!("{skel}.m_cellX")).is_some() { skel } else { "CBodyComponent" };
                let k = |a: &str| s.resolve_field_key(&format!("{o}.{a}"));
                let [x, y, _] = world_position(e, [k("m_cellX"), k("m_cellY"), k("m_cellZ")], [k("m_vecX"), k("m_vecY"), k("m_vecZ")]);
                let kind = match class {
                    SHOP => "shop",
                    TELEPORT => "teleporter",
                    _ => "heal",
                };
                let site = map.nearest(kind, f64::from(x), f64::from(y), 16.0).map(|s| s.key.clone()).unwrap_or_default();
                at.entry(kind).or_default().push((site, [x, y]));
            }
        })
        .expect("parses");
    let on_sites = |kind: &str| at[kind].iter().filter(|(k, _)| !k.is_empty()).map(|(k, _)| k.clone()).collect::<HashSet<String>>().len();
    assert_eq!((at["heal"].len(), on_sites("heal")), (36, 36), "every spawner on its own healing site");
    assert_eq!((at["teleporter"].len(), on_sites("teleporter")), (4, 4), "every teleporter on its site");
    assert_eq!((at["shop"].len(), on_sites("shop")), (9, 8), "8 shops on the map, and the base's");
    let base = at["shop"].iter().find(|(k, _)| k.is_empty()).expect("the base's shop").1;
    assert!(base[1] < -10000.0, "the 9th is the Hidden King's base shop: {base:?}");
}

/// 129738985's lane shops (docs/research/map-objectives-audit.md, "Shops"): each closes as the
/// guardian beside it falls (its `CTriggerItemShop` deleted, its `CCitadel_ShopProp`'s
/// `m_bIsShopOpen` false), in the second the timeline has that guardian destroyed, so the Player
/// derives it from the objectives (web `shopsClosed`). The secret shops and the base's stay open.
/// Sapphire's shops are paired by place, not `LaneNum`: the map mirrors it on that side.
#[test]
#[ignore = "needs 129738985: MAPCRO_REPLAY_129738985"]
fn match_129738985_closes_each_lane_shop_with_its_guardian() {
    use boon::{Parser, world_position};
    use std::collections::{HashMap, HashSet};
    const RULES: &str = "CCitadelGameRulesProxy";
    const PROP: &str = "CCitadel_ShopProp";
    const ORIGIN: &str = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
    let Some(dem) = env_path("MAPCRO_REPLAY_129738985") else { panic!("set MAPCRO_REPLAY_129738985 to 129738985.dem") };
    let dir = tempfile::tempdir().expect("dir");
    let out = dir.path().join("t.json");
    worker::job(&dem, &out, 129_738_985, 2 << 30).expect("parses");
    let t = timeline::validate(&std::fs::read(&out).expect("output")).expect("the server's checks pass");

    let (_, server_start) = mapcro_replay::parse::header(&dem).expect("a Deadlock replay");
    let classes: HashSet<&str> = [RULES, PROP].into_iter().collect();
    // Each shop prop (team, place) and the match second it closed; every one seen, open or not.
    let mut closed: HashMap<(i32, u32), (i64, i32, i32, f64)> = HashMap::new();
    let mut seen: HashSet<(i32, u32)> = HashSet::new();
    Parser::from_file(&dem)
        .expect("opens")
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
            let Some(s) = sers.get(PROP) else { return };
            let (open, team) = (s.resolve_field_key("m_bIsShopOpen"), s.resolve_field_key("m_iTeamNum"));
            let ok = |p: &str| s.resolve_field_key(&format!("{ORIGIN}.{p}"));
            for (_, e) in ctx.entities().iter() {
                if e.class_name.as_ref() != PROP {
                    continue;
                }
                let id = (e.index, e.serial);
                seen.insert(id);
                if e.get_bool(open) || closed.contains_key(&id) {
                    continue;
                }
                let p = world_position(e, [ok("m_cellX"), ok("m_cellY"), ok("m_cellZ")], [ok("m_vecX"), ok("m_vecY"), ok("m_vecZ")]);
                closed.insert(id, (e.get_i64(team), p[0].round() as i32, p[1].round() as i32, game));
            }
        })
        .expect("parses");
    assert_eq!(seen.len(), 8, "6 lane shops and 2 secret shops have a prop");

    // (team, prop's x, y) → the guardian beside it.
    let pairs = [
        (3, -910, 1184, "guardian:sapphire:lane4:1"),
        (3, 8832, 1880, "guardian:sapphire:lane6:1"),
        (3, -6432, 1696, "guardian:sapphire:lane1:1"),
        (2, 1024, -1184, "guardian:amber:lane4:1"),
        (2, -8832, -1880, "guardian:amber:lane1:1"),
        (2, 6432, -1696, "guardian:amber:lane6:1"),
    ];
    let mut got: Vec<(i64, i32, i32)> = closed.values().map(|c| (c.0, c.1, c.2)).collect();
    got.sort_unstable();
    let mut want: Vec<(i64, i32, i32)> = pairs.iter().map(|p| (p.0, p.1, p.2)).collect();
    want.sort_unstable();
    assert_eq!(got, want, "only the six lane shops close; the secret shops stay open");
    for (team, x, y, key) in pairs {
        let at = closed.values().find(|c| (c.0, c.1, c.2) == (team, x, y)).expect("closed").3;
        let down = t.objectives.iter().find(|o| o.key == key).expect("the guardian falls").destroyed_s;
        assert!(at <= f64::from(down) && f64::from(down) - at < 1.0, "{key}: the shop closes at {at:.1}, the guardian at {down}");
    }
}
