//! Asset packs (spec §12): extracted once by the server operator into `PACKS_DIR/<any name>/`,
//! served read-only. A pack's id is the SHA-256 of its `pack.json`, so URLs are immutable and
//! cache forever. Only files the manifest lists are served, and only after their hash checks.

use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Deserialize)]
struct Manifest {
    game: Game,
    #[serde(default)]
    blobs: BTreeMap<String, Blob>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Game {
    /// A number in the extractor's schema-2 manifests, a string in older ones; served as a string.
    #[serde(deserialize_with = "string_or_number")]
    pub client_version: String,
    #[serde(default, deserialize_with = "string_or_number")]
    pub source_revision: String,
    #[serde(default)]
    pub date: String,
}

fn string_or_number<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum V {
        S(String),
        N(u64),
    }
    Ok(match V::deserialize(d)? {
        V::S(s) => s,
        V::N(n) => n.to_string(),
    })
}

#[derive(Deserialize)]
struct Blob {
    sha256: String,
    mime: String,
    file: String,
}

struct Served {
    path: PathBuf,
    mime: &'static str,
}

pub struct Pack {
    pub id: String,
    pub game: Game,
    manifest: Vec<u8>,
    /// Relative file name (as in the manifest) → where it is on disk.
    files: BTreeMap<String, Served>,
}

#[derive(Default)]
pub struct Packs {
    /// Newest client version first.
    pub list: Vec<Pack>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Only image and data types the client loads (the names table is JSON, schema 4); anything else
/// in a manifest is refused.
fn mime(m: &str) -> Option<&'static str> {
    match m {
        "image/png" => Some("image/png"),
        "image/svg+xml" => Some("image/svg+xml"),
        "image/webp" => Some("image/webp"),
        "application/json" => Some("application/json"),
        _ => None,
    }
}

fn safe_relative(f: &str) -> bool {
    !f.is_empty()
        && !f.starts_with('/')
        && f.split('/').all(|p| !p.is_empty() && p != "." && p != ".." && !p.contains('\\'))
}

/// Newest first: the highest game build, then, between packs of one build (a re-extract that adds
/// art), the one whose `pack.json` was written last. The extractor writes it; `tar` keeps its time
/// when the pack is placed (docs/deploy.md). New boards open on the first.
fn newest_first<T>(list: &mut [(T, std::time::SystemTime)], build: impl Fn(&T) -> u64) {
    list.sort_by(|(a, ta), (b, tb)| build(b).cmp(&build(a)).then(tb.cmp(ta)));
}

impl Packs {
    /// Index every pack under `dir`. A pack that fails validation is skipped with an error
    /// in the log, never half-served.
    pub fn load(dir: &std::path::Path) -> Result<Packs, String> {
        let mut list = Vec::new();
        let entries = std::fs::read_dir(dir).map_err(|e| format!("PACKS_DIR {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let root = entry.path();
            // Dot-directories are copies still being placed (docs/deploy.md): never load them.
            if entry.file_name().to_string_lossy().starts_with('.') || !root.join("pack.json").is_file() {
                continue;
            }
            match Self::load_one(&root) {
                Ok(p) => {
                    tracing::info!(pack = p.id, version = p.game.client_version, files = p.files.len(), "asset pack");
                    let made = std::fs::metadata(root.join("pack.json")).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                    list.push((p, made));
                }
                Err(e) => tracing::error!(dir = %root.display(), error = e, "skipping invalid asset pack"),
            }
        }
        newest_first(&mut list, |p: &Pack| p.game.client_version.parse::<u64>().unwrap_or(0));
        Ok(Packs { list: list.into_iter().map(|(p, _)| p).collect() })
    }

    fn load_one(root: &std::path::Path) -> Result<Pack, String> {
        let manifest = std::fs::read(root.join("pack.json")).map_err(|e| e.to_string())?;
        let m: Manifest = serde_json::from_slice(&manifest).map_err(|e| e.to_string())?;
        let mut files = BTreeMap::new();
        for (key, blob) in m.blobs {
            if !safe_relative(&blob.file) {
                return Err(format!("blob {key}: unsafe path {:?}", blob.file));
            }
            let mime = mime(&blob.mime).ok_or_else(|| format!("blob {key}: type {:?} not served", blob.mime))?;
            let path = root.join(&blob.file);
            let bytes = std::fs::read(&path).map_err(|e| format!("blob {key}: {e}"))?;
            if hex(&Sha256::digest(&bytes)) != blob.sha256 {
                return Err(format!("blob {key}: hash mismatch"));
            }
            files.insert(blob.file, Served { path, mime });
        }
        Ok(Pack { id: hex(&Sha256::digest(&manifest)), game: m.game, manifest, files })
    }

    fn get(&self, id: &str) -> Option<&Pack> {
        self.list.iter().find(|p| p.id == id)
    }
}

#[derive(Serialize)]
struct PackInfo {
    pack_id: String,
    game: Game,
}

pub async fn list(State(app): State<crate::AppState>) -> Response {
    let v: Vec<PackInfo> = app.packs.list.iter().map(|p| PackInfo { pack_id: p.id.clone(), game: p.game.clone() }).collect();
    axum::Json(v).into_response()
}

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

pub async fn file(State(app): State<crate::AppState>, Path((id, rest)): Path<(String, String)>) -> Response {
    let Some(pack) = app.packs.get(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if rest == "pack.json" {
        return ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, IMMUTABLE)], pack.manifest.clone())
            .into_response();
    }
    let Some(served) = pack.files.get(&rest) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tokio::fs::read(&served.path).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, served.mime), (header::CACHE_CONTROL, IMMUTABLE)], bytes).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "asset pack file vanished");
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{mime, newest_first};

    #[test]
    fn only_listed_types_are_served() {
        for m in [
            "image/png",
            "image/svg+xml",
            "image/webp",
            "application/json",
        ] {
            assert_eq!(mime(m), Some(m));
        }
        for m in [
            "text/html",
            "application/javascript",
            "text/plain",
            "application/json; charset=utf-8",
            "",
        ] {
            assert_eq!(mime(m), None, "{m}");
        }
    }
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn the_highest_build_wins_then_the_latest_extract_of_it() {
        let at = |s| UNIX_EPOCH + Duration::from_secs(s);
        let mut list = vec![(("6860", "badges"), at(100)), (("6799", "old"), at(900)), (("6860", "rejuv"), at(200)), (("6860", "first"), at(50))];
        newest_first(&mut list, |p| p.0.parse().unwrap());
        let order: Vec<_> = list.iter().map(|(p, _)| p.1).collect();
        assert_eq!(order, ["rejuv", "badges", "first", "old"]);
    }
}
