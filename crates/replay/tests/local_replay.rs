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
