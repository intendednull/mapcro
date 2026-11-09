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
