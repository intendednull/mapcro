//! `dump_stored <dir> [seeds]`: what the server as built stores, for the rollback check
//! (`just reader-check`; docs/deploy.md). Each seed's board is run against `Admit::DEPLOYED`
//! and written as its genesis, its log (one transaction a line) and the board the log gives,
//! as the JSON the store holds. `load_stored` reads them back, built from the reader release.
use mapcro_schema::{Admit, apply_tx};
use mapcro_sim::{Config, run_logged};

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args.next().expect("usage: dump_stored <dir> [seeds]");
    let seeds: u64 = args.next().map_or(40, |n| n.parse().expect("seeds"));
    std::fs::create_dir_all(&dir).expect("dir");
    let config = Config { admit: Admit::DEPLOYED, steps: 1500, ..Config::default() };
    let (mut logged, mut registry) = (0, 0);
    for seed in 0..seeds {
        let (_, genesis, log) = run_logged(seed, &config).unwrap_or_else(|f| panic!("{f}"));
        let mut doc = genesis.clone();
        let mut lines = String::new();
        for tx in &log {
            apply_tx(&mut doc, tx).expect("replays on this build");
            let line = serde_json::to_string(tx).expect("json");
            registry += usize::from(["\"More\":", "\"SceneState\":", "\"more\":"].iter().any(|k| line.contains(k)));
            lines.push_str(&line);
            lines.push('\n');
        }
        logged += log.len();
        let write = |what: &str, text: String| std::fs::write(format!("{dir}/{seed}.{what}"), text).expect("write");
        write("genesis.json", serde_json::to_string(&genesis).expect("json"));
        write("log.jsonl", lines);
        write("final.json", serde_json::to_string(&doc).expect("json"));
        // What a board file exported by this build says it needs (`rows`, boardfile.rs).
        write("file-rows", mapcro_schema::written_rows().to_string());
    }
    // Once a row is written, the check is of the registry's stored shapes: say so if none is.
    let written = mapcro_schema::RowId::all().any(|r| r.row().status != mapcro_schema::Status::Ahead);
    assert!(!written || registry > 100, "rows are written by this build, but the dump holds {registry} registry transactions");
    println!("dumped {seeds} boards: {logged} logged transactions, {registry} holding registry values or a scene's state");
}
