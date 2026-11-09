//! Map-objective census of the entity lump: every classname with its count, and for the
//! neutral-objective classes each record's position and identifying keys
//! (docs/research/map-objectives-audit.md). Read-only; prints to stdout.
//!
//! `cargo run -p mapcro-extract --example lump_census -- <citadel dir> [class substring…]`

use mapcro_extract::Value;
use std::collections::BTreeMap;

/// Classname fragments that are neutral objectives, or might be.
const NEUTRAL: [&str; 14] = [
    "neutral",
    "sinner",
    "camp",
    "statue",
    "breakable",
    "boss",
    "koth",
    "idol",
    "powerup",
    "vault",
    "punchable",
    "shrine",
    "pickup",
    "minimap",
];

fn scalar(v: &Value) -> Option<String> {
    Some(match v {
        Value::Bool(b) => b.to_string(),
        Value::Int(n) => n.to_string(),
        Value::UInt(n) => n.to_string(),
        Value::Double(f) => format!("{f:.1}"),
        Value::String(s) if !s.is_empty() => s.clone(),
        _ => return None,
    })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(game) = args.get(1) else {
        eprintln!("usage: lump_census <citadel dir> [class substring…]");
        std::process::exit(2);
    };
    let wanted: Vec<String> = if args.len() > 2 {
        args[2..].to_vec()
    } else {
        NEUTRAL.iter().map(|s| (*s).to_owned()).collect()
    };
    let root = mapcro_extract::entity_lump(std::path::Path::new(game)).expect("entity lump");
    let records = root
        .get("m_entityKeyValues")
        .and_then(Value::as_array)
        .expect("m_entityKeyValues");
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut detail = Vec::new();
    for r in records {
        let r = r
            .get("keyValues3Data")
            .and_then(|kv| kv.get("values"))
            .unwrap_or(r);
        let Some(class) = r.get("classname").and_then(Value::as_str) else {
            continue;
        };
        *counts.entry(class.to_owned()).or_default() += 1;
        let lc = class.to_lowercase();
        if !wanted.iter().any(|w| lc.contains(w.as_str())) {
            continue;
        }
        let fields: Vec<String> = r
            .as_object()
            .unwrap_or(&[])
            .iter()
            .filter(|(k, _)| k != "classname")
            .filter_map(|(k, v)| match v {
                Value::Array(a) if k == "origin" => Some(format!(
                    "origin={}",
                    a.iter()
                        .filter_map(Value::as_f64)
                        .map(|f| format!("{f:.0}"))
                        .collect::<Vec<_>>()
                        .join(",")
                )),
                _ => scalar(v).map(|s| format!("{k}={s}")),
            })
            .collect();
        detail.push(format!("{class}\t{}", fields.join("\t")));
    }
    println!("# classname counts ({} records)", records.len());
    for (c, n) in &counts {
        println!("{n}\t{c}");
    }
    println!("# neutral-objective records");
    detail.sort();
    for d in detail {
        println!("{d}");
    }
}
