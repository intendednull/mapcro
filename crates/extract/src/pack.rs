//! The `pack.json` manifest written next to the extracted PNGs.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::Result;
use crate::steam::SteamInfo;

/// Manifest schema version.
pub const SCHEMA: u32 = 3;

#[derive(Debug, Serialize)]
pub struct Pack {
    pub schema: u32,
    pub extractor: Extractor,
    pub game: Game,
    pub sources: Vec<Source>,
    pub blobs: BTreeMap<String, Blob>,
    pub heroes: Vec<Hero>,
    pub entities: Vec<Entity>,
    pub geometry_hash: String,
    pub icons: Vec<Icon>,
    pub icons_skipped: Vec<SkippedIcon>,
    pub hud_sources: Vec<HudSource>,
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

#[derive(Debug, Serialize)]
pub struct Hero {
    pub hero_id: u64,
    pub class_name: String,
    pub name: Option<String>,
    pub dev_state: Option<String>,
    pub disabled: bool,
    pub minimap_blob: Option<String>,
    pub topbar_blob: Option<String>,
    /// The hero card (`m_strIconHeroCard`) the top bar's badge shows, `topbar/heroes/<id>_card`.
    pub card_blob: Option<String>,
    /// The low-health hero card (`m_strIconHeroCardCritical`), `topbar/heroes/<id>_critical`.
    pub critical_blob: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Entity {
    pub key: String,
    pub kind: String,
    pub team: String,
    pub lane: String,
    pub world: [f64; 3],
    pub src: EntitySource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nodes: Option<Vec<[f64; 3]>>,
    /// Camps: `weak`, `medium`, `strong`, `vaults` (the Sinner's Sacrifice) or `midboss`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    /// Teleporters: where this end lets out (world units), beside the other end of its pair.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<[f64; 3]>,
}

#[derive(Debug, Serialize)]
pub struct EntitySource {
    pub classname: String,
    pub hammeruniqueid: String,
    pub targetname: String,
}

#[derive(Debug, Serialize)]
pub struct Icon {
    pub key: String,
    pub source: String,
    pub format: String,
    pub blob: String,
}

#[derive(Debug, Serialize)]
pub struct SkippedIcon {
    pub source: String,
    pub format: String,
}

#[derive(Debug, Serialize)]
pub struct HudSource {
    pub key: String,
    pub source: String,
    pub file: String,
    pub sha256: String,
    pub bytes: u64,
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
            heroes: Vec::new(),
            entities: Vec::new(),
            geometry_hash: String::new(),
            icons: Vec::new(),
            icons_skipped: Vec::new(),
            hud_sources: Vec::new(),
        }
    }

    pub fn add_source(&mut self, vpk: String, path: String, crc32: u32, size: u64) {
        if self
            .sources
            .iter()
            .any(|source| source.vpk == vpk && source.path == path)
        {
            return;
        }
        self.sources.push(Source {
            vpk,
            path,
            crc32: format!("{crc32:08x}"),
            size,
        });
    }

    pub fn add_blob(&mut self, logical_key: String, file: String, sha256: String, w: u32, h: u32) {
        self.add_blob_with_mime(logical_key, file, sha256, w, h, "image/png");
    }

    pub fn add_blob_with_mime(
        &mut self,
        logical_key: String,
        file: String,
        sha256: String,
        w: u32,
        h: u32,
        mime: &'static str,
    ) {
        self.blobs.insert(
            logical_key,
            Blob {
                sha256,
                w,
                h,
                mime,
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
