//! The `pack.json` manifest written next to the extracted PNGs.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::Result;
use crate::steam::SteamInfo;

/// Manifest schema version.
pub const SCHEMA: u32 = 1;

#[derive(Debug, Serialize)]
pub struct Pack {
    pub schema: u32,
    pub extractor: Extractor,
    pub game: Game,
    pub sources: Vec<Source>,
    pub blobs: BTreeMap<String, Blob>,
}

#[derive(Debug, Serialize)]
pub struct Extractor {
    pub name: &'static str,
    pub version: &'static str,
}

#[derive(Debug, Serialize)]
pub struct Game {
    pub client_version: u64,
    pub source_revision: u64,
    pub date: String,
}

/// The cheap "did anything change" key: one record per VPK entry we read.
#[derive(Debug, Serialize)]
pub struct Source {
    /// Archive that holds the payload, for example `pak01_303.vpk`.
    pub vpk: String,
    /// Path inside the VPK.
    pub path: String,
    /// Lowercase hexadecimal CRC32 from the VPK directory tree.
    pub crc32: String,
    /// Total entry size in bytes.
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct Blob {
    pub sha256: String,
    pub w: u32,
    pub h: u32,
    pub mime: &'static str,
    pub file: String,
}

impl Pack {
    pub fn new(info: &SteamInfo) -> Self {
        Self {
            schema: SCHEMA,
            extractor: Extractor {
                name: env!("CARGO_PKG_NAME"),
                version: env!("CARGO_PKG_VERSION"),
            },
            game: Game {
                client_version: info.client_version,
                source_revision: info.source_revision,
                date: info.version_date.clone(),
            },
            sources: Vec::new(),
            blobs: BTreeMap::new(),
        }
    }

    pub fn add_source(&mut self, vpk: String, path: String, crc32: u32, size: u64) {
        self.sources.push(Source {
            vpk,
            path,
            crc32: format!("{crc32:08x}"),
            size,
        });
    }

    pub fn add_blob(&mut self, logical_key: String, file: String, sha256: String, w: u32, h: u32) {
        self.blobs.insert(
            logical_key,
            Blob {
                sha256,
                w,
                h,
                mime: "image/png",
                file,
            },
        );
    }

    pub fn sort_sources(&mut self) {
        self.sources
            .sort_by(|left, right| left.path.cmp(&right.path).then(left.vpk.cmp(&right.vpk)));
    }

    pub fn to_json(&self) -> Result<Vec<u8>> {
        Ok(serde_json::to_vec_pretty(self)?)
    }
}
