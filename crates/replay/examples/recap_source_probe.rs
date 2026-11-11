//! Recap-source probe: for `CCitadelUserMessageDamage` (msg 300) on hero pawns whose attacker
//! isn't a hero pawn, what the message says the attacker is: the attacker entity's demo class,
//! `attacker_class`, `attacker_subclass` and `ability_id`, with hit counts, damage and lethal
//! hits. Aggregates only (no names, no Steam ids). Backs the death recap's source kinds
//! (docs/research/status-effects.md §4).
//! `cargo run -p mapcro-replay --release --example recap_source_probe -- <replay.dem>`
use boon::Parser;
use prost::Message;
use std::collections::{BTreeMap, HashSet};

const PAWN: &str = "CCitadelPlayerPawn";

fn main() {
    let path = std::env::args_os().nth(1).expect("replay path");
    let parser = Parser::from_file(std::path::Path::new(&path)).expect("opens");
    let tables = Parser::from_file(std::path::Path::new(&path)).expect("opens").parse_send_tables().expect("tables");
    // Every NPC-like class, so the attacker's entity is known; abilities are left out (the
    // attacker is the pawn or the NPC, the ability is `ability_id`).
    let names: Vec<String> = tables
        .iter()
        .map(|(n, _)| n.to_string())
        .filter(|n| n.starts_with("CNPC") || n.contains("Neutral") || n.contains("Sinner") || n.contains("Turret") || n.contains("Boss") || n.contains("Building") || n.contains("Trigger") || n.contains("World"))
        .collect();
    let mut classes: HashSet<&str> = names.iter().map(String::as_str).collect();
    classes.insert(PAWN);
    // (entity class, attacker_class, attacker_subclass, ability_id) -> (hits, damage, lethal)
    let mut out = BTreeMap::<(String, u32, u32, u32), (u32, u64, u32)>::new();
    let mut pawn_attacker = BTreeMap::<(u32, u32), u32>::new();
    parser
        .run_to_end_with_events_filtered(&classes, |ctx, events| {
            for e in events.iter().filter(|e| e.msg_type == 300) {
                let Ok(m) = boon_proto::proto::CCitadelUserMessageDamage::decode(&e.payload[..]) else { continue };
                let Some(v) = m.entindex_victim.and_then(|v| ctx.entities().get(v)) else { continue };
                if v.class_name.as_ref() != PAWN {
                    continue;
                }
                let class = |i: Option<i32>| match i {
                    None => "none".to_string(),
                    Some(-1) => "-1".to_string(),
                    Some(i) => ctx.entities().get(i).map_or_else(|| "untracked".to_string(), |e| e.class_name.to_string()),
                };
                let att = class(m.entindex_attacker);
                let key = (m.attacker_class.unwrap_or(u32::MAX), m.attacker_subclass.unwrap_or(u32::MAX));
                if att == PAWN {
                    *pawn_attacker.entry(key).or_default() += 1;
                    continue;
                }
                let d = m.damage.unwrap_or(0).max(0) as u64;
                let lethal = d > 0 && m.victim_health_new == Some(0);
                let row = out.entry((format!("{att} / inflictor {}", class(m.entindex_inflictor)), key.0, key.1, m.ability_id.unwrap_or(0))).or_default();
                row.0 += 1;
                row.1 += d;
                row.2 += u32::from(lethal);
            }
        })
        .expect("parses");
    println!("# pawn attackers by (attacker_class, attacker_subclass)");
    for ((c, s), n) in &pawn_attacker {
        println!("pawn\t{c}\t{s}\t{n}");
    }
    println!("# non-pawn attackers: entity class / inflictor class, attacker_class, attacker_subclass, ability_id, hits, damage, lethal");
    for ((cls, c, s, a), (n, d, l)) in out {
        println!("{cls}\t{c}\t{s}\t{a}\t{n}\t{d}\t{l}");
    }
}
