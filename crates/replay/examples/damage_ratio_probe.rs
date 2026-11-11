//! Damage-ratio probe: for `CCitadelUserMessage_Damage` on hero victims, the recorded
//! `damage / pre_damage` by victim hero id, damage `type`, and match minute. Aggregates only.
//! `cargo run -p mapcro-replay --release --example damage_ratio_probe -- <replay.dem>`
use boon::Parser;
use prost::Message;
use std::collections::{BTreeMap, HashSet};
fn main() {
    let path = std::env::args_os().nth(1).expect("replay path");
    // (hero, type, minute) -> ratios
    let mut out = BTreeMap::<(i64, i32, i32), Vec<f32>>::new();
    let mut seen = 0usize;
    Parser::from_file(std::path::Path::new(&path)).expect("opens").run_to_end_with_events_filtered(&HashSet::from(["CCitadelPlayerPawn"]), |ctx, events| {
        for e in events.iter().filter(|e| e.msg_type == 300) {
            seen += 1;
            let Ok(m) = boon_proto::proto::CCitadelUserMessageDamage::decode(&e.payload[..]) else { continue };
            let (Some(v), Some(pre), Some(d)) = (m.entindex_victim, m.pre_damage, m.damage) else { continue };
            if pre <= 0.0 { continue; }
            let Some(ent) = ctx.entities().get(v) else { continue };
            if ent.class_name.as_ref() != "CCitadelPlayerPawn" { continue; }
            let s = ctx.serializers().get("CCitadelPlayerPawn").expect("pawn");
            let hero = s.resolve_field_key("m_CCitadelHeroComponent.m_spawnedHero.m_nHeroID").and_then(|k| ent.fields.get(&k)).map(|v| format!("{v:?}")).unwrap_or_default();
            let hero: i64 = hero.chars().filter(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(-1);
            out.entry((hero, m.r#type.unwrap_or(-1) * 1000 + m.citadel_type.unwrap_or(-1), ctx.tick() / 3840)).or_default().push((d as f32 + m.damage_absorbed.unwrap_or(0.0)) / pre);
        }
    }).expect("parses");
    eprintln!("{seen} damage messages");
    for ((h, t, min), mut r) in out {
        r.sort_by(f32::total_cmp);
        println!("{h}\t{t}\t{min}\t{}\tmin {:.3}\tmed {:.3}\tmax {:.3}", r.len(), r[0], r[r.len() / 2], r[r.len() - 1]);
    }
}
