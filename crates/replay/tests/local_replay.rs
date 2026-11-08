//! Against real replays on this machine, never committed (they're large and carry players).
//! `MAPCRO_REPLAY=/path/to/current.dem MAPCRO_OLD_REPLAY=/path/to/pre-6712.dem
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
    assert!(t.waves.iter().all(|w| w.t.iter().any(Option::is_some)), "every lane sees a wave");
    assert!(bytes.len() < 4 << 20, "compact");
}

#[test]
#[ignore = "needs a local replay: MAPCRO_OLD_REPLAY"]
fn an_old_map_replay_is_refused() {
    let Some(dem) = env_path("MAPCRO_OLD_REPLAY") else { panic!("set MAPCRO_OLD_REPLAY to a pre-6712 .dem") };
    let dir = tempfile::tempdir().expect("dir");
    assert_eq!(worker::job(&dem, &dir.path().join("t.json"), 1, 2 << 30), Err(reason::OLD_MAP));
}

/// How the computed lane splits compare with the troopers they come from (a debugging aid for
/// the wave view; prints, asserts nothing beyond the parse).
#[test]
#[ignore = "needs a local replay: MAPCRO_REPLAY"]
fn wave_split_against_the_troopers() {
    let Some(dem) = env_path("MAPCRO_REPLAY") else { panic!("set MAPCRO_REPLAY") };
    let obs = mapcro_replay::parse::observe(&dem, 1).expect("parses");
    let m = mapcro_replay::map::current();
    let t = mapcro_replay::derive::derive(&obs, m).expect("derives");
    for lane in &m.lanes {
        let no: i64 = lane.key.trim_start_matches("lane").parse().unwrap_or(-1);
        let w = t.waves.iter().find(|w| w.lane == lane.key).expect("wave");
        let (mut both, mut one, mut none, mut inside, mut crossed, mut far) = (0, 0, 0, 0, 0, 0);
        let mut gaps = Vec::new();
        for (sec, s) in obs.seconds.iter().enumerate() {
            let fronts = |team: i64| -> Vec<u16> {
                s.troopers.iter().filter(|x| x.lane == no && x.team == team).filter_map(|x| {
                    let (tt, d) = lane.project(mapcro_replay::map::world_to_map(f64::from(x.pos[0]), f64::from(x.pos[1])));
                    (d <= 60.0).then_some(tt)
                }).collect()
            };
            let (a, b) = (fronts(2), fronts(3));
            let split = w.t[sec];
            match (a.iter().max(), b.iter().min()) {
                (Some(&af), Some(&sf)) => {
                    both += 1;
                    if af > sf { crossed += 1 }
                    let (lo, hi) = (af.min(sf), af.max(sf));
                    if let Some(sp) = split {
                        if sp >= lo.saturating_sub(30) && sp <= hi + 30 { inside += 1 } else { far += 1; gaps.push((sec, af, sf, sp)); }
                    }
                }
                (None, None) => none += 1,
                _ => one += 1,
            }
        }
        let mut ds: Vec<f64> = obs.seconds.iter().flat_map(|s| s.troopers.iter().filter(|x| x.lane == no).map(|x| lane.project(mapcro_replay::map::world_to_map(f64::from(x.pos[0]), f64::from(x.pos[1]))).1)).collect();
        ds.sort_by(f64::total_cmp);
        let q = |p: f64| ds.get(((ds.len() as f64 - 1.0) * p) as usize).copied().unwrap_or(f64::NAN);
        let lanes: std::collections::BTreeMap<i64, usize> = obs.seconds.iter().flat_map(|s| s.troopers.iter().map(|x| x.lane)).fold(Default::default(), |mut m, l| { *m.entry(l).or_default() += 1; m });
        eprintln!("{}: {} trooper-seconds on this lane; distance to the lane p50 {:.0} p90 {:.0} p99 {:.0} (map units); all lanes seen {lanes:?}", lane.key, ds.len(), q(0.5), q(0.9), q(0.99));
        eprintln!("{}: both {both} (split within the fronts ±30: {inside}, outside: {far}, fronts crossed: {crossed}), one side only {one}, none {none}", lane.key);
        for g in gaps.iter().take(6) {
            eprintln!("  {}s amber front {} sapphire front {} split {}", g.0, g.1, g.2, g.3);
        }
    }
}
