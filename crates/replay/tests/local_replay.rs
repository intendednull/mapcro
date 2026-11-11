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

/// 129738985's tough crates (the "Heavy boxes"): each of the map's 78 is one entity all match,
/// matched to its own built-in site. They aren't there before 3:00: 64 come up at 3:00, 8 at 5:00
/// and 6 at 10:00 (the lump's `breakable_spawn_group` 0, 3 and 2), and each is back 180 s after a
/// break (once, lane1:18 at 815.9 s, 300 s).
#[test]
#[ignore = "needs 129738985: MAPCRO_REPLAY_129738985"]
fn match_129738985_tough_crates_break_and_are_back() {
    use std::collections::BTreeMap;
    let Some(dem) = env_path("MAPCRO_REPLAY_129738985") else { panic!("set MAPCRO_REPLAY_129738985 to 129738985.dem") };
    let dir = tempfile::tempdir().expect("dir");
    let out = dir.path().join("t.json");
    worker::job(&dem, &out, 129_738_985, 2 << 30).expect("parses");
    let t = timeline::validate(&std::fs::read(&out).expect("output")).expect("the server's checks pass");
    assert_eq!(t.crates.len(), 78, "every tough crate, each on its own site");
    assert!(t.crates.iter().all(|c| c.key.starts_with("tough_crate:")));
    let first: BTreeMap<u32, usize> = t.crates.iter().fold(BTreeMap::new(), |mut m, c| {
        *m.entry(c.first_s).or_default() += 1;
        m
    });
    assert_eq!(first, BTreeMap::from([(180, 64), (300, 8), (600, 6)]), "up at 3:00, 5:00 and 10:00 by spawn group");
    let breaks: Vec<[u32; 2]> = t.crates.iter().flat_map(|c| c.cleared.iter().copied()).collect();
    assert_eq!((breaks.len(), t.crates.iter().filter(|c| !c.cleared.is_empty()).count()), (232, 64), "232 breaks over 64 crates");
    let mut gaps: BTreeMap<u32, usize> = BTreeMap::new();
    for [a, b] in &breaks {
        *gaps.entry(b - a).or_default() += 1;
    }
    assert_eq!(gaps, BTreeMap::from([(180, 231), (300, 1)]), "back 180 s after a break");
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

/// 129738985's format-7 data against the studies' probes (docs/research/abilities-and-items.md,
/// status-effects.md, elevation.md): 239 purchases; 96 sells, of which 25 carry the shop's sell
/// notice (each also checked against the catalog: none is a component of what was bought with
/// it) and 71 are components of the item bought in the same instant; 190 ability level changes;
/// 2227 casts; 125 stun intervals, 109 attributed; 79 lethal-hit deaths (the probe's count kept
/// post-game ticks); height level 74%, above 17%, below 9%; on a zipline 8.1% of alive seconds.
#[test]
#[ignore = "needs 129738985: MAPCRO_REPLAY_129738985"]
fn match_129738985_has_its_builds_casts_status_effects_and_heights() {
    use timeline::{CC_STATES, ITEM_BOUGHT, ITEM_MERGED, ITEM_REMOVED, ITEM_SOLD, NO_HERO};
    let Some(dem) = env_path("MAPCRO_REPLAY_129738985") else { panic!("set MAPCRO_REPLAY_129738985 to 129738985.dem") };
    let dir = tempfile::tempdir().expect("dir");
    let out = dir.path().join("t.json");
    worker::job(&dem, &out, 129_738_985, 2 << 30).expect("parses");
    let bytes = std::fs::read(&out).expect("output");
    let t = timeline::validate(&bytes).expect("the server's checks pass");
    let p = &t.players;
    let count = |f: &dyn Fn(&timeline::Player) -> usize| p.iter().map(f).sum::<usize>();
    let kind = |k: u32| count(&|p| p.items.iter().filter(|i| i[2] == k).count());
    assert_eq!((kind(ITEM_BOUGHT), kind(ITEM_SOLD), kind(ITEM_MERGED), kind(ITEM_REMOVED)), (239, 25, 71, 0));
    assert!(p.iter().all(|p| (15..=23).contains(&p.items.iter().filter(|i| i[2] == ITEM_BOUGHT).count())), "15–23 buys each");
    assert_eq!(count(&|p| p.abilities.len()), 190);
    assert!(p.iter().all(|p| p.abilities.iter().map(|a| a[1]).collect::<std::collections::BTreeSet<_>>().len() == 4), "4 abilities each");
    assert_eq!(p.iter().filter(|p| p.abilities.iter().any(|a| a[2] == 4)).count(), 12, "everyone reached a tier 3");
    // The ult casts the events list has are among the casts, by token.
    assert_eq!(count(&|p| p.casts.len()), 2227);
    let with_cd = count(&|p| p.casts.iter().filter(|c| c[2] != 0).count());
    assert!(with_cd * 100 >= 2227 * 90, "{with_cd} of 2227 casts have their cooldown end");
    let ults: Vec<u32> = t.events.iter().filter(|e| e.kind == "ult").filter_map(|e| e.ability.as_deref()).map(timeline::token).collect();
    assert!(!ults.is_empty() && ults.iter().all(|u| p.iter().any(|p| p.casts.iter().any(|c| c[1] == *u))), "every ult is a cast");
    assert!(count(&|p| p.charges.len()) > 1000, "charges change");
    let state = |s: u32| count(&|p| p.cc.iter().filter(|c| c[2] == s).count());
    let stuns = state(20);
    let stuns_by_hero = count(&|p| p.cc.iter().filter(|c| c[2] == 20 && c[3] != NO_HERO).count());
    assert!((120..=130).contains(&stuns), "{stuns} stuns");
    assert!(stuns_by_hero * 100 >= stuns * 85, "{stuns_by_hero} of {stuns} stuns attributed");
    assert!((55..=65).contains(&state(17)) && (30..=36).contains(&state(81)), "silences {}, sleeps {}", state(17), state(81));
    assert!(p.iter().all(|p| p.cc.iter().all(|c| CC_STATES.contains(&c[2]))));
    let effects = count(&|p| p.effects.len());
    assert!((4000..=4300).contains(&effects), "{effects} icon-shown effects (the probe: 4196)");
    let recaps = count(&|p| p.recaps.len());
    assert!((74..=79).contains(&recaps), "{recaps} death recaps");
    assert!(p.iter().flat_map(|p| &p.recaps).all(|r| !r.damage.is_empty()), "every recap has its damage");
    // Height and zipline shares of alive seconds.
    let (mut level, mut zip, mut alive) = ([0usize; 3], 0usize, 0usize);
    for p in p {
        for s in 0..p.x.len() {
            let h = p.height.iter().rev().find(|c| c[0] as usize <= s).map_or(0, |c| c[1] as usize);
            if p.x[s].is_some() {
                alive += 1;
                level[h] += 1;
                zip += usize::from(p.zipline.iter().any(|z| (z[0] as usize..z[1] as usize).contains(&s)));
            }
        }
    }
    let share = |n: usize| n as f64 / alive as f64;
    assert!((0.71..=0.78).contains(&share(level[0])) && (0.13..=0.19).contains(&share(level[1])) && (0.07..=0.11).contains(&share(level[2])), "height shares {level:?} of {alive}");
    assert!((0.07..=0.09).contains(&share(zip)), "zipline share {}", share(zip));
    // No account or Steam id: the new fields are numbers keyed by slot.
    let json = String::from_utf8_lossy(&bytes);
    assert!(!json.contains("steam") && !json.contains("account"));
    eprintln!("{} KB", bytes.len() / 1024);
    assert!(bytes.len() < 2 << 20, "under 2 MiB");
}

/// No identity reaches disk: parse in memory, drop names, then serialize the sanitized result.
#[test]
#[ignore = "needs 129738985: MAPCRO_REPLAY_129738985"]
fn match_129738985_has_recorded_scoreboard_values() {
    let dem = env_path("MAPCRO_REPLAY_129738985").expect("set MAPCRO_REPLAY_129738985");
    let obs = mapcro_replay::parse::observe(&dem, 129_738_985).expect("observes");
    let mut t = mapcro_replay::derive::derive(&obs, mapcro_replay::map::current()).expect("derives");
    for p in &mut t.players { p.name = None; }
    assert_eq!(t.players.len(), 12);
    assert!(t.players.iter().all(|p| !p.level.is_empty() && !p.max_health.is_empty()));
    assert!(t.players.iter().all(|p| !p.kills.is_empty() && !p.assists.is_empty()));
    let levels: Vec<u32> = t.players.iter().flat_map(|p| p.level.iter().filter_map(|(_, v)| *v)).collect();
    let hp: Vec<u32> = t.players.iter().flat_map(|p| p.max_health.iter().filter_map(|(_, v)| *v)).collect();
    assert!(levels.iter().all(|v| (1..=45).contains(v)));
    assert!(hp.iter().all(|v| (500..=20_000).contains(v)));
    assert!(levels.iter().any(|v| *v >= 20));
    assert!(hp.iter().any(|v| *v >= 3000));
    // The first scoreboard samples precede combat; final totals must not leak backwards.
    for p in &t.players {
        assert_eq!(p.kills.first(), Some(&(0, Some(0))));
        assert_eq!(p.assists.first(), Some(&(0, Some(0))));
    }
    assert!(t.players.iter().any(|p| p.kills.iter().any(|(s, v)| *s > 0 && v.is_some_and(|v| v > 0))));
    let kills: u32 = t.players.iter().map(|p| p.kills.iter().rev().find_map(|(_, v)| *v).expect("kills")).sum();
    let assists: u32 = t.players.iter().map(|p| p.assists.iter().rev().find_map(|(_, v)| *v).expect("assists")).sum();
    assert_eq!(kills, 74);
    assert_eq!(assists, 134);
    assert_eq!(kills as usize, t.players.iter().map(|p| p.deaths.len()).sum::<usize>());
    eprintln!("recorded totals: {kills} kills, {assists} assists; {} deaths", t.players.iter().map(|p| p.deaths.len()).sum::<usize>());
    let bytes = serde_json::to_vec(&t).expect("serialize");
    assert!(timeline::validate(&bytes).is_ok());
    if let Some(path) = std::env::var_os("MAPCRO_SANITIZED_TIMELINE") {
        std::fs::write(path, &bytes).expect("sanitized output");
    }
    eprintln!("scoreboard: {} level changes, {} max HP changes; ranges {}..{} / {}..{}; {} bytes", levels.len(), hp.len(), levels.iter().min().expect("levels"), levels.iter().max().expect("levels"), hp.iter().min().expect("hp"), hp.iter().max().expect("hp"), bytes.len());
}

/// 129738985's rift troopers (feedback #5; exploration round 8): the 33 units its 5 captures
/// spawn (on a pool of 8 entities) carry bit 15 of their trooper id, read from the game's
/// `kothtrooper` modifier, and they are exactly the entities the game draws bigger (model scale 1.57 to 1.66; every other trooper is
/// 1.2 at most). The one-health units waiting at the bases are never drawn.
#[test]
#[ignore = "needs 129738985: MAPCRO_REPLAY_129738985"]
fn match_129738985_marks_its_rift_troopers_and_draws_no_base_units() {
    use boon::Parser;
    use std::collections::{BTreeSet, HashSet};
    let Some(dem) = env_path("MAPCRO_REPLAY_129738985") else { panic!("set MAPCRO_REPLAY_129738985 to 129738985.dem") };
    let dir = tempfile::tempdir().expect("dir");
    let out = dir.path().join("t.json");
    worker::job(&dem, &out, 129_738_985, 2 << 30).expect("parses");
    let t = timeline::validate(&std::fs::read(&out).expect("output")).expect("the server's checks pass");
    let tr = t.troopers.expect("troopers");
    let captures: Vec<u32> = t.events.iter().filter(|e| e.kind == "rift_capture").map(|e| e.t).collect();
    assert_eq!(captures.len(), 5);
    // A rift trooper's id, first drawn or back after 30 s without it, is a new unit (the
    // entities are pooled, and a unit out of the recording for a moment is the same one).
    let (mut flagged, mut plain, mut births, mut deep) = (BTreeSet::new(), HashSet::new(), Vec::new(), 0);
    for team in [&tr.amber, &tr.sapphire] {
        let mut last: std::collections::HashMap<u16, usize> = std::collections::HashMap::new();
        for (sec, sample) in team.iter().enumerate() {
            for (id, _, y) in timeline::decode_troopers(sample).expect("sample") {
                deep += usize::from(y.abs() > 9200);
                if id & timeline::RIFT_TROOPER == 0 {
                    plain.insert(id);
                } else {
                    flagged.insert(id & !timeline::RIFT_TROOPER);
                    if last.get(&id).is_none_or(|l| sec - l > 30) {
                        births.push(sec as u32);
                    }
                    last.insert(id, sec);
                }
            }
        }
    }
    births.sort_unstable();
    let per_capture: Vec<usize> = captures.iter().map(|c| births.iter().filter(|b| (*c..=c + 5).contains(*b)).count()).collect();
    assert_eq!(per_capture, [7, 8, 5, 5, 8], "births {births:?}, captures {captures:?}");
    assert_eq!(births.len(), 33, "each one spawned by a capture");
    // The units waiting at the bases (max health 1) sat at |y| 9,300 to 9,600: 5,467 dots there
    // before they were left out; the lane troopers hardly go that deep.
    assert!(deep <= 5, "{deep} dots inside the bases");

    // The same units by the game's own drawing: their model scale.
    const TROOPER: &str = "CNPC_Trooper";
    let mut big = BTreeSet::new();
    Parser::from_file(&dem)
        .expect("opens")
        .run_to_end_filtered(&HashSet::from([TROOPER]), |ctx| {
            let Some(s) = ctx.serializers().get(TROOPER) else { return };
            let scale = s.resolve_field_key("CBodyComponent.m_skeletonInstance.m_flScale");
            for (_, e) in ctx.entities().iter().filter(|(_, e)| e.class_name.as_ref() == TROOPER) {
                if e.get_f32(scale) >= 1.5 {
                    big.insert(e.index as u16);
                }
            }
        })
        .expect("parses");
    assert_eq!(flagged, big, "flagged by the modifier = drawn bigger by the game");
    assert!(big.iter().all(|i| !plain.contains(i)), "and never drawn unflagged");
}
