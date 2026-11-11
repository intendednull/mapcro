//! Numeric scoreboard-field census. Prints aggregate ranges only; never player identifiers.
use boon::{FieldValue, Parser};
use std::collections::{BTreeMap, HashSet};
fn main() {
    let path = std::env::args_os().nth(1).expect("replay path");
    let mut ranges = BTreeMap::<(String, String), (f64, f64, usize)>::new();
    let mut last = -1;
    Parser::from_file(std::path::Path::new(&path)).expect("opens").run_to_end_with_events_filtered(
        &HashSet::from(["CCitadelPlayerController", "CCitadelPlayerPawn"]), |ctx, _| {
            let sec = ctx.tick() / 64;
            if sec == last { return; }
            last = sec;
            for (_, e) in ctx.entities().iter().filter(|(_, e)| e.active) {
                let Some(ser) = ctx.serializers().get(e.class_name.as_ref()) else { continue };
                for (&key, v) in &e.fields {
                    let Some(path) = ser.field_name_for_key(key) else { continue };
                    let lower = path.to_ascii_lowercase();
                    if !["level", "kills", "assists", "maxhealth", "resist", "progression", "statviewer", "itembar", "tier", "bullet", "spirit", "armor"].iter().any(|p| lower.contains(p)) { continue; }
                    let v = match v { FieldValue::I32(n) => f64::from(*n), FieldValue::U32(n) => f64::from(*n), FieldValue::F32(n) => f64::from(*n), FieldValue::I64(n) => *n as f64, _ => continue };
                    if !v.is_finite() { continue; }
                    let r = ranges.entry((e.class_name.to_string(), path)).or_insert((v, v, 0));
                    r.0 = r.0.min(v); r.1 = r.1.max(v); r.2 += 1;
                }
            }
        }).expect("parses");
    for ((class, path), (lo, hi, n)) in ranges { println!("{class}\t{path}\t{lo}\t{hi}\t{n}"); }
}
