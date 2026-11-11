//! Against this machine's Steam install and a real replay, never committed:
//! `MAPCRO_REPLAY=/path/to/<match id>.dem cargo test -p mapcro-desktop-core --release -- --ignored`

use mapcro_desktop_core::{parse, replays, steam};
use std::io::Read;
use std::path::PathBuf;

#[test]
#[ignore = "needs a local replay: MAPCRO_REPLAY"]
fn a_real_replay_parses_in_a_child_to_a_gzip_timeline_the_server_accepts() {
    let dem = std::env::var_os("MAPCRO_REPLAY").map(PathBuf::from).expect("set MAPCRO_REPLAY");
    let name = dem.file_name().and_then(|n| n.to_str()).expect("name");
    let id: u64 = replays::replay_id(name).expect("named <match id>.dem").parse().expect("id");
    assert!(replays::looks_like_demo(&dem));
    let scratch = tempfile::tempdir().expect("scratch");
    let started = std::time::Instant::now();
    let gz = parse::parse(PathBuf::from(env!("CARGO_BIN_EXE_mapcro-desktop-parse")).as_path(), &dem, id, scratch.path(), parse::TIMEOUT).expect("parses");
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut json).expect("gunzip");
    let t = mapcro_replay::timeline::validate(&json).expect("valid");
    assert_eq!(t.match_id, id);
    eprintln!("{} KB gzip ({} KB raw) in {:.1} s", gz.len() / 1024, json.len() / 1024, started.elapsed().as_secs_f64());
}

#[test]
#[ignore = "reads this machine's Steam files (libraryfolders.vdf, Deadlock's manifest)"]
fn finds_this_machines_replays_folder() {
    // Prints no path: only whether it was found, and that it's a folder.
    match steam::locate() {
        Ok(p) => eprintln!("found; folder exists: {}", p.is_dir()),
        Err(e) => panic!("not found: {}", e.code()),
    }
}
