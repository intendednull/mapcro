//! Trooper probe: each `CNPC_Trooper` the first time it's seen, counted by its `m_nSubclassID`
//! (the token of its unit name), `m_iLane`, `m_iTeamNum` and whether `m_hOwnerEntity` is set,
//! with the first and last match minute it appeared. Asks whether rift-spawned troopers are
//! told apart (feedback #5). Aggregates only.
//! `cargo run -p mapcro-replay --release --example trooper_probe -- <replay.dem>`
use boon::Parser;
use std::collections::{BTreeMap, HashSet};

fn main() {
    let path = std::env::args_os().nth(1).expect("replay path");
    let classes: HashSet<&str> = ["CNPC_Trooper"].into_iter().collect();
    let mut last: HashSet<i32> = HashSet::new();
    // (subclass, lane, team, owned) -> (count, first minute, last minute)
    let mut out = BTreeMap::<(i64, i64, i64, bool), (u32, i32, i32)>::new();
    Parser::from_file(std::path::Path::new(&path))
        .expect("opens")
        .run_to_end_filtered(&classes, |ctx| {
            let Some(s) = ctx.serializers().get("CNPC_Trooper") else { return };
            let k = |p: &str| s.resolve_field_key(p);
            let (sub, lane, team, owner) = (k("m_nSubclassID"), k("m_iLane"), k("m_iTeamNum"), k("m_hOwnerEntity"));
            let mut now = HashSet::new();
            for (_, e) in ctx.entities().iter().filter(|(_, e)| e.class_name.as_ref() == "CNPC_Trooper") {
                now.insert(e.index);
                if last.contains(&e.index) {
                    continue;
                }
                let owned = e.get_handle(owner).and_then(|h| ctx.entities().get_by_handle(h)).is_some();
                let minute = ctx.tick() / 3840;
                let row = out.entry((e.get_i64(sub), e.get_i64(lane), e.get_i64(team), owned)).or_insert((0, minute, minute));
                row.0 += 1;
                row.2 = minute;
            }
            last = now;
        })
        .expect("parses");
    println!("subclass\tlane\tteam\towned\tcount\tfirst_min\tlast_min");
    for ((s, l, t, o), (n, a, b)) in out {
        println!("{s}\t{l}\t{t}\t{o}\t{n}\t{a}\t{b}");
    }
}
