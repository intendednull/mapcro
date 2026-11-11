//! Stat-viewer probe: each change of a controller's `m_vecStatViewerModifierValues`, keyed by
//! hero id (never names or account ids). Prints `tick\thero\tmodifier:ability:valtype:value …\titems`.
//! `cargo run -p mapcro-replay --release --example statviewer_probe -- <replay.dem>`
use boon::{FieldValue, Parser};
use std::collections::{HashMap, HashSet};
fn n(v: Option<&FieldValue>) -> String {
    match v { Some(FieldValue::I32(n)) => n.to_string(), Some(FieldValue::U32(n)) => n.to_string(), Some(FieldValue::U64(n)) => n.to_string(), Some(FieldValue::I64(n)) => n.to_string(), Some(FieldValue::F32(n)) => format!("{n}"), Some(x) => format!("{x:?}"), None => "-".into() }
}
fn main() {
    let path = std::env::args_os().nth(1).expect("replay path");
    let mut last = HashMap::<i32, String>::new();
    const C: &str = "CCitadelPlayerController";
    const V: &str = "m_PlayerDataGlobal.m_vecStatViewerModifierValues";
    Parser::from_file(std::path::Path::new(&path)).expect("opens").run_to_end_with_events_filtered(&HashSet::from([C]), |ctx, _| {
        let Some(s) = ctx.serializers().get(C) else { return };
        let k = |p: &str| s.resolve_field_key(p);
        for (_, e) in ctx.entities().iter().filter(|(_, e)| e.class_name.as_ref() == C) {
            let hero = n(k("m_PlayerDataGlobal.m_nHeroID").and_then(|k| e.fields.get(&k)));
            let count = match k(V).and_then(|k| e.fields.get(&k)) { Some(FieldValue::U32(c)) => *c as usize, Some(FieldValue::I32(c)) => *c as usize, Some(FieldValue::U64(c)) => *c as usize, _ => 0 };
            let mut parts = Vec::new();
            for i in 0..count {
                let f = |x: &str| n(k(&format!("{V}.{i}.{x}")).and_then(|k| e.fields.get(&k)));
                parts.push(format!("{}:{}:{}:{}", f("m_SourceModifierID"), f("m_SourceAbilityID"), f("m_eValType"), f("m_flValue")));
            }
            let uc = match k("m_PlayerDataGlobal.m_vecUpgrades").and_then(|k| e.fields.get(&k)) { Some(FieldValue::U32(c)) => *c as usize, Some(FieldValue::I32(c)) => *c as usize, Some(FieldValue::U64(c)) => *c as usize, _ => 0 };
            let items: Vec<String> = (0..uc).map(|i| n(k(&format!("m_PlayerDataGlobal.m_vecUpgrades.{i}")).and_then(|k| e.fields.get(&k)))).collect();
            let line = format!("{}\t{}", parts.join(" "), items.join(","));
            if last.get(&e.index) != Some(&line) {
                println!("{}\t{hero}\t{line}", ctx.tick());
                last.insert(e.index, line);
            }
        }
    }).expect("parses");
}
