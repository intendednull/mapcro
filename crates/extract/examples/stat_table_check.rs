//! Probe: the install's stat table (from its vdata) against boon-data's for the same patch, item
//! by item. Prints ids and counts only (no Valve text beyond internal stat names).
//!
//! `cargo run -p mapcro-extract --release --example stat_table_check -- <citadel dir> <boon-data snapshot dir> [-v]`

use mapcro_extract::{GameDir, SteamInfo, install_table, vdata};
use mapcro_stats::StatTable;
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let verbose = args.iter().any(|a| a == "-v");
    let game = Path::new(&args[0]);
    let steam = SteamInfo::read(&GameDir::new(game).expect("game dir")).expect("steam.inf");
    let read = |p: &str| vdata(game, p).expect("vdata");
    let ours = install_table(u32::try_from(steam.client_version).expect("version"), &read("scripts/heroes.vdata_c"), &read("scripts/abilities.vdata_c"), &read("scripts/generic_data.vdata_c"));
    let boon = StatTable::load_boon_data(Path::new(&args[1])).expect("boon-data");
    println!("install {} ({} heroes, {} items) vs boon-data {} ({} heroes, {} items)", ours.client_version, ours.heroes.len(), ours.items.len(), boon.client_version, boon.heroes.len(), boon.items.len());
    let (items, heroes) = ours.differences(&boon);
    println!("differing: {} items, {} heroes", items.len(), heroes.len());
    if verbose {
        for id in items {
            println!("  item {id}\n    vdata {:?}\n    boon  {:?}", ours.items.get(&id), boon.items.get(&id));
        }
        for id in heroes {
            println!("  hero {id}");
        }
    }
    println!("table JSON: {} bytes", serde_json::to_vec(&ours).expect("json").len());
}
