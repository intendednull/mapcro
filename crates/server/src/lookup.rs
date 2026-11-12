//! `mapcro-server stats timelines <match id>` (docs/specs/observability.md §4, spec §11 Scope):
//! every timeline the server holds for one match, for the lead to find what a feedback issue's
//! sender saw. An upload is cached under its board's scope (16 hex digits of the board id's
//! hash) and a clone's carried upload is a hard link of it under the clone's scope, so the match
//! id alone doesn't find them through the API; this does, from the files.
//!
//! Read-only: it lists `DATA_DIR/replays/<id>-*.json`, reads each one to its stamp and the
//! worker's check (`timeline::validate`), maps scopes to board ids from the `boards` table
//! (opened read-only, as `stats` does), and reads the boards' match lists (`attached/`). It
//! prints sizes, stamps and ids, never a timeline's contents: no names, no positions.
//! Serves nothing to users.

use crate::stats::{bytes, stamp};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// One cached timeline file.
struct Entry {
    file: String,
    scope: String,
    /// `cdn` (fetched from Valve, every board), `upload` (a board's demo, parsed by the worker)
    /// or `client` (parsed on the user's machine, the upload's scope).
    source: &'static str,
    board: Option<String>,
    format: Option<u32>,
    tier: Option<String>,
    build: Option<u32>,
    duration_s: Option<u32>,
    size: u64,
    mtime: i64,
    /// `current`, `stale` (older than this server's format: lacks layers, re-fetched on open
    /// when it's `cdn`), `newer` (written by a newer server), or `unreadable`.
    state: &'static str,
    /// The worker's output check, as a cached timeline must pass it: `ok` or why not.
    check: String,
    ino: (u64, u64),
    nlink: u64,
}

/// A timeline's stamp: the fields it's listed by, and nothing that names anyone.
#[derive(Deserialize)]
struct Stamp {
    #[serde(default)]
    format: u32,
    #[serde(default)]
    source: String,
    #[serde(default)]
    tier: String,
    #[serde(default)]
    build: u32,
    #[serde(default)]
    duration_s: u32,
}

fn mtime(m: &std::fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs() as i64)
}

/// Scope → board id, from the boards the database holds (a board that expired is gone: its
/// scope stays unresolved). None without a database.
fn boards(dir: &Path) -> Option<HashMap<String, String>> {
    let path = dir.join("mapcro.sqlite");
    if !path.is_file() {
        return None;
    }
    let c = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    c.execute_batch("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;")
        .ok()?;
    let mut st = c.prepare("SELECT id FROM boards").ok()?;
    let ids = st.query_map([], |r| r.get::<_, String>(0)).ok()?;
    Some(
        ids.flatten()
            .map(|id| (crate::replays::scope_of(&id), id))
            .collect(),
    )
}

/// The scopes whose board match list (`attached/<scope>.json`) holds the match.
fn attached(dir: &Path, id: u64) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir.join("attached")) else {
        return Vec::new();
    };
    let mut v: Vec<String> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let scope = name.strip_suffix(".json")?.to_owned();
            if e.metadata().ok()?.len() > 64 * 1024 {
                return None; // a list is 20 ids at most
            }
            let ids: Vec<u64> = serde_json::from_slice(&std::fs::read(e.path()).ok()?).ok()?;
            ids.contains(&id).then_some(scope)
        })
        .collect();
    v.sort();
    v
}

fn entries(dir: &Path, id: u64, boards: &HashMap<String, String>) -> Result<Vec<Entry>, String> {
    let cache = dir.join("replays");
    let rd = match std::fs::read_dir(&cache) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("cannot list {}: {e}", cache.display())),
    };
    let prefix = format!("{id}-");
    let mut out = Vec::new();
    for e in rd.flatten() {
        let Ok(name) = e.file_name().into_string() else {
            continue;
        };
        let Some(scope) = name
            .strip_prefix(&prefix)
            .and_then(|s| s.strip_suffix(".json"))
        else {
            continue;
        };
        if !(scope == "cdn" || (scope.len() == 16 && scope.bytes().all(|b| b.is_ascii_hexdigit())))
        {
            continue;
        }
        // Not followed: the cache holds files the server wrote, never links.
        let Ok(m) = std::fs::symlink_metadata(e.path()) else {
            continue;
        };
        if !m.is_file() {
            continue;
        }
        let raw = std::fs::read(e.path()).ok();
        let st = raw
            .as_deref()
            .and_then(|b| serde_json::from_slice::<Stamp>(b).ok());
        let check = match raw.as_deref().map(mapcro_replay::timeline::validate) {
            None => "unreadable".to_owned(),
            Some(Err(why)) => why.to_owned(),
            Some(Ok(t)) if t.match_id != id => "another match's id".to_owned(),
            Some(Ok(_)) => "ok".to_owned(),
        };
        let now = mapcro_replay::timeline::FORMAT;
        out.push(Entry {
            file: name.clone(),
            scope: scope.to_owned(),
            source: match (scope, &st) {
                ("cdn", _) => "cdn",
                (_, Some(s)) if s.source == crate::replays::CLIENT_SOURCE => "client",
                _ => "upload",
            },
            board: boards.get(scope).cloned(),
            state: match &st {
                None => "unreadable",
                Some(s) if s.format < now => "stale",
                Some(s) if s.format > now => "newer",
                Some(_) => "current",
            },
            format: st.as_ref().map(|s| s.format),
            tier: st.as_ref().map(|s| s.tier.clone()),
            build: st.as_ref().map(|s| s.build),
            duration_s: st.as_ref().map(|s| s.duration_s),
            check,
            size: m.len(),
            mtime: mtime(&m),
            ino: (m.dev(), m.ino()),
            nlink: m.nlink(),
        });
    }
    // The shared one first, then by when it was cached.
    out.sort_by(|a, b| {
        (a.scope != "cdn", a.mtime, &a.scope).cmp(&(b.scope != "cdn", b.mtime, &b.scope))
    });
    Ok(out)
}

fn mmss(s: u32) -> String {
    format!("{}:{:02}", s / 60, s % 60)
}

/// The query: a report (text and data) for `match_id` in `dir`.
pub fn timelines(dir: &Path, id: &str) -> Result<(String, Value), String> {
    if !crate::matches::valid_id(id) {
        return Err(format!("{id:?} isn't a match id"));
    }
    let n: u64 = id.parse().map_err(|_| format!("{id:?} isn't a match id"))?;
    let known = boards(dir);
    let map = known.clone().unwrap_or_default();
    let list = entries(dir, n, &map)?;

    // Names of one file (a clone's carried upload): numbered in the order listed.
    let mut file_no: HashMap<(u64, u64), usize> = HashMap::new();
    let mut names: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    for e in &list {
        let next = file_no.len() + 1;
        let k = *file_no.entry(e.ino).or_insert(next);
        names.entry(k).or_default().push(e.scope.clone());
    }

    let fmt = mapcro_replay::timeline::FORMAT;
    let mut t = format!(
        "match {id}: {} cached timeline{} (this server's format: {fmt})\n",
        list.len(),
        if list.len() == 1 { "" } else { "s" }
    );
    if known.is_none() {
        t.push_str("  (no database here: board ids unresolved)\n");
    }
    if !list.is_empty() {
        t.push_str(&format!(
            "  {:<4} {:<7} {:<16}  {:<22}  {:>6} {:<7} {:>5} {:>6} {:>8}  {:<16}  {:<8} check\n",
            "file",
            "source",
            "scope",
            "board",
            "format",
            "tier",
            "build",
            "length",
            "size",
            "cached (UTC)",
            "state"
        ));
    }
    let mut rows = Vec::new();
    for e in &list {
        let k = file_no[&e.ino];
        let board = match (&e.board, e.scope.as_str()) {
            (_, "cdn") => "(every board)".to_owned(),
            (Some(b), _) => b.clone(),
            (None, _) => "(no board)".to_owned(),
        };
        let dash = || "-".to_owned();
        t.push_str(&format!(
            "  {:<4} {:<7} {:<16}  {:<22}  {:>6} {:<7} {:>5} {:>6} {:>8}  {:<16}  {:<8} {}\n",
            format!("#{k}"),
            e.source,
            e.scope,
            board,
            e.format.map_or_else(dash, |f| f.to_string()),
            e.tier
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(dash),
            e.build.map_or_else(dash, |b| b.to_string()),
            e.duration_s.map_or_else(dash, mmss),
            bytes(e.size as f64),
            stamp(e.mtime),
            e.state,
            e.check,
        ));
        rows.push(json!({
            "file": e.file, "file_no": k, "source": e.source, "scope": e.scope, "board": e.board,
            "format": e.format, "tier": e.tier, "build": e.build, "duration_s": e.duration_s,
            "bytes": e.size, "cached": e.mtime, "state": e.state, "check": e.check, "links": e.nlink,
        }));
    }
    let mut linked = Vec::new();
    for (k, scopes) in &names {
        let e = list.iter().find(|e| file_no[&e.ino] == *k).expect("listed");
        if scopes.len() > 1 || e.nlink > 1 {
            t.push_str(&format!(
                "  #{k} is one file under {} name{} ({} here: {}): hard links, a clone's carried upload\n",
                e.nlink,
                if e.nlink == 1 { "" } else { "s" },
                scopes.len(),
                scopes.join(", ")
            ));
            linked.push(json!({ "file_no": k, "names": e.nlink, "scopes": scopes }));
        }
    }

    let meta = dir.join("matches").join(format!("{id}.json"));
    let meta_at = std::fs::symlink_metadata(&meta)
        .ok()
        .filter(|m| m.is_file());
    match &meta_at {
        Some(m) => t.push_str(&format!(
            "  metadata summary: cached {} ({})\n",
            stamp(mtime(m)),
            bytes(m.len() as f64)
        )),
        None => t.push_str("  metadata summary: not cached\n"),
    }
    let refused = std::fs::read_to_string(dir.join("matches").join(format!("{id}.refused")))
        .ok()
        .map(|s| s.trim().to_owned());
    if let Some(r) = &refused {
        t.push_str(&format!("  refused: {r}\n"));
    }
    let on = attached(dir, n);
    if !on.is_empty() {
        t.push_str(&format!(
            "  open on {} board{}:\n",
            on.len(),
            if on.len() == 1 { "" } else { "s" }
        ));
        for s in &on {
            let has = list.iter().find(|e| &e.scope == s).map_or("", |e| e.source);
            let sees = if has.is_empty() {
                if list.iter().any(|e| e.scope == "cdn") {
                    "cdn"
                } else {
                    "metadata"
                }
            } else {
                has
            };
            t.push_str(&format!(
                "    {s}  {:<22}  sees {sees}\n",
                map.get(s).map_or("(no board)", String::as_str)
            ));
        }
    }
    if !list.is_empty() {
        t.push_str(&format!(
            "  pull one: just pull-timeline {id} <scope or board> [--dev]\n"
        ));
    }
    let data = json!({
        "match_id": n, "format": fmt, "timelines": rows, "linked": linked,
        "metadata": meta_at.as_ref().map(|m| json!({ "cached": mtime(m), "bytes": m.len() })),
        "refused": refused,
        "attached": on.iter().map(|s| json!({ "scope": s, "board": map.get(s) })).collect::<Vec<_>>(),
    });
    Ok((t, data))
}
