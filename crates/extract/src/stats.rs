//! Per-patch stat tables for calculated hero stats (docs/research/stat-calc-spike.md, "Production
//! plan"). Each table is [`mapcro_stats::StatTable`]: derived numbers only, never a Valve file.
//!
//! - The install's own patch, from its vdata (`heroes`, `abilities`, `generic_data`).
//! - Older patches, from boon-data snapshots the operator fetched (`just stat-data <dir>`, then
//!   `--stat-data <dir>`): `<dir>/versions.json` (boon-data's manifest) and
//!   `<dir>/<snapshot>/{heroes,abilities,misc}.json`, each checked against the manifest's SHA-256.
//!
//! The manifest's `stats` section ([`crate::StatTables`]) maps every build the sources list to
//! the table it reads; the web client picks one per replay build (`web/src/match/stats.ts`).

use std::collections::BTreeMap;
use std::path::Path;

use mapcro_stats::{StatTable, TABLE_FORMAT};

use crate::pack::{Pack, StatTableRef, StatTables};
use crate::{Error, Result, Value, sha256_hex};

/// Blob keys and files: `data/stats/<key>` and `data/stats/<key>.json`.
const STATS_DIR: &str = "data/stats";
/// The boon-data files a table reads.
const BOON_FILES: [&str; 3] = ["heroes.json", "abilities.json", "misc.json"];

/// A decoded KV3 value as JSON, the shape boon-data publishes vdata in.
pub fn to_json(v: &Value) -> serde_json::Value {
    match v {
        Value::Null => serde_json::Value::Null,
        Value::Bool(b) => (*b).into(),
        Value::Int(n) => (*n).into(),
        Value::UInt(n) => (*n).into(),
        Value::Double(f) => serde_json::Number::from_f64(*f).map_or(serde_json::Value::Null, Into::into),
        Value::String(s) => s.clone().into(),
        Value::BinaryBlob(_) => serde_json::Value::Null,
        Value::Array(a) => a.iter().map(to_json).collect(),
        Value::Object(o) => o.iter().map(|(k, v)| (k.clone(), to_json(v))).collect::<serde_json::Map<_, _>>().into(),
    }
}

/// The install's table from its decoded vdata roots.
pub fn install_table(client_version: u32, heroes: &Value, abilities: &Value, generic: &Value) -> StatTable {
    StatTable::from_vdata(client_version, &to_json(heroes), &to_json(abilities), &to_json(generic), crate::token)
}

/// boon-data's snapshots, reduced: the tables by snapshot, every listed build's snapshot, and the
/// newest build the manifest lists.
pub struct BoonTables {
    pub tables: BTreeMap<u32, StatTable>,
    /// Each snapshot's tooltip values (`tooltips::values`), for the tooltips' per-patch overlays.
    pub tooltip_values: BTreeMap<u32, BTreeMap<u32, crate::tooltips::Values>>,
    pub builds: BTreeMap<u32, u32>,
    pub latest: u32,
}

fn stat_err(e: impl std::fmt::Display) -> Error {
    Error::StatData(e.to_string())
}

/// Read and check every snapshot in `dir` (see the module docs). A listed snapshot whose files
/// are absent is an error: a partial fetch must not quietly leave patches out.
pub fn boon_tables(dir: &Path) -> Result<BoonTables> {
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("versions.json"))?).map_err(stat_err)?;
    let versions = manifest["versions"].as_object().ok_or_else(|| stat_err("versions.json has no versions"))?;
    let num = |s: &str| s.parse::<u32>().map_err(|_| stat_err(format!("version {s:?} isn't a number")));
    let mut builds = BTreeMap::new();
    for (version, v) in versions {
        let snapshot = v["snapshot"].as_str().ok_or_else(|| stat_err(format!("version {version} has no snapshot")))?;
        builds.insert(num(version)?, num(snapshot)?);
    }
    let latest = builds.keys().next_back().copied().ok_or_else(|| stat_err("versions.json lists no versions"))?;
    let mut tables = BTreeMap::new();
    let mut tooltip_values = BTreeMap::new();
    for snapshot in builds.values().copied().collect::<std::collections::BTreeSet<_>>() {
        let artifacts = &versions[&snapshot.to_string()]["artifacts"];
        let mut bytes = Vec::new();
        for file in BOON_FILES {
            let want = artifacts[file]["sha256"].as_str().ok_or_else(|| stat_err(format!("{snapshot}/{file}: no sha256 in versions.json")))?;
            let path = dir.join(snapshot.to_string()).join(file);
            let data = std::fs::read(&path).map_err(|e| stat_err(format!("{}: {e}", path.display())))?;
            if sha256_hex(&data) != want {
                return Err(stat_err(format!("{snapshot}/{file}: hash mismatch")));
            }
            bytes.push(data);
        }
        let table = StatTable::from_boon_data(&bytes[0], &bytes[1], &bytes[2]).map_err(|e| stat_err(format!("{snapshot}: {e}")))?;
        if table.client_version != snapshot {
            return Err(stat_err(format!("{snapshot}: heroes.json says client_version {}", table.client_version)));
        }
        tables.insert(snapshot, table);
        let abilities: serde_json::Value = serde_json::from_slice(&bytes[1]).map_err(|e| stat_err(format!("{snapshot}/abilities.json: {e}")))?;
        tooltip_values.insert(snapshot, crate::tooltips::values(crate::tooltips::boon_records(&abilities)));
    }
    Ok(BoonTables { tables, tooltip_values, builds, latest })
}

/// Write the tables as JSON blobs and fill the manifest's `stats` section. The install's table
/// serves its own build, over boon-data's for that build; a table no build reads isn't written.
pub fn write(out_dir: &Path, pack: &mut Pack, files: &mut Vec<String>, install: Option<StatTable>, boon: Option<&BoonTables>) -> Result<()> {
    let mut section = StatTables { format: TABLE_FORMAT, covered_through: 0, builds: BTreeMap::new(), tables: BTreeMap::new() };
    let mut tables: BTreeMap<String, StatTable> = BTreeMap::new();
    if let Some(boon) = boon {
        for (build, snapshot) in &boon.builds {
            section.builds.insert(*build, format!("boon-{snapshot}"));
        }
        tables.extend(boon.tables.iter().map(|(snapshot, t)| (format!("boon-{snapshot}"), t.clone())));
        section.covered_through = boon.latest;
    }
    if let Some(table) = install {
        let key = format!("vdata-{}", table.client_version);
        section.builds.insert(table.client_version, key.clone());
        section.covered_through = section.covered_through.max(table.client_version);
        tables.insert(key, table);
    }
    for (key, table) in tables {
        if !section.builds.values().any(|k| *k == key) {
            continue;
        }
        let json = serde_json::to_vec(&table)?;
        let file = format!("{STATS_DIR}/{key}.json");
        let path = out_dir.join(&file);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, &json)?;
        let blob = format!("{STATS_DIR}/{key}");
        pack.add_blob_with_mime(blob.clone(), file.clone(), sha256_hex(&json), 0, 0, "application/json");
        files.push(file);
        section.tables.insert(key, StatTableRef { blob, client_version: table.client_version, source: table.source });
    }
    if !section.tables.is_empty() {
        pack.stats = Some(section);
    }
    Ok(())
}
