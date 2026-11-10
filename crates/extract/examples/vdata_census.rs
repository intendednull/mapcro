//! Probe: print a vdata file as JSON, or list VPK entry paths under a prefix.
//!
//! `cargo run -p mapcro-extract --example vdata_census -- <citadel dir> vdata <path>`
//! `cargo run -p mapcro-extract --example vdata_census -- <citadel dir> list <prefix>`
//! `cargo run -p mapcro-extract --example vdata_census -- <citadel dir> text <path>`

use mapcro_extract::{GameDir, Value, Vpk};
use std::path::Path;

fn json(v: &Value) -> serde_json::Value {
    match v {
        Value::Null => serde_json::Value::Null,
        Value::Bool(b) => (*b).into(),
        Value::Int(n) => (*n).into(),
        Value::UInt(n) => (*n).into(),
        Value::Double(f) => {
            serde_json::Number::from_f64(*f).map_or(serde_json::Value::Null, Into::into)
        }
        Value::String(s) => s.clone().into(),
        Value::BinaryBlob(b) => format!("<{} bytes>", b.len()).into(),
        Value::Array(a) => a.iter().map(json).collect(),
        Value::Object(o) => o
            .iter()
            .map(|(k, v)| (k.clone(), json(v)))
            .collect::<serde_json::Map<_, _>>()
            .into(),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let game = Path::new(&args[0]);
    match args[1].as_str() {
        "vdata" => {
            let value = mapcro_extract::vdata(game, &args[2]).expect("vdata");
            println!(
                "{}",
                serde_json::to_string_pretty(&json(&value)).expect("json")
            );
        }
        "list" => {
            let vpk = Vpk::open(&GameDir::new(game).expect("game"), "pak01_dir.vpk").expect("vpk");
            for entry in vpk.entries().filter(|e| e.path.starts_with(&args[2])) {
                println!("{} {}", entry.path, entry.size());
            }
        }
        "text" => {
            let vpk = Vpk::open(&GameDir::new(game).expect("game"), "pak01_dir.vpk").expect("vpk");
            let bytes = vpk.read(&args[2]).expect("read");
            print!("{}", String::from_utf8_lossy(&bytes));
        }
        other => panic!("unknown mode {other}"),
    }
}
