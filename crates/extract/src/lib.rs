//! mapcro game-asset extractor.
//!
//! Reads a local Deadlock `citadel` install, extracts the minimap layers, hero portraits, hero
//! records, map entities, HUD icons and HUD sources, and writes a content-addressed `pack.json`.
//! Only allow-listed files are opened, and no extracted art is ever written inside the repository.
//!
//! The VPK reader, binary KV3 reader and Source 2 resource/texture decoders are pure Rust; the
//! container and KV3 layouts are ported from ValveResourceFormat (MIT), credited in [`kv3`] and
//! [`vtex`].

mod allow;
mod entities;
mod error;
mod heroes;
mod hud;
mod icons;
pub mod kv1;
pub mod kv3;
mod pack;
mod panorama;
mod png_out;
mod resource;
mod steam;
mod vpk;
mod vtex;

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

pub use allow::GameDir;
pub use error::{Error, Result};
pub use kv3::Value;
pub use pack::{
    Blob, Entity, EntitySource, Extractor, Game, Hero, HudSource, Icon, Pack, SCHEMA, SkippedIcon,
    Source,
};
pub use png_out::{encode_png, write_png};
pub use steam::SteamInfo;
pub use vpk::{Entry, Vpk};
pub use vtex::{Texture, decode_vtex, format_label};

use sha2::{Digest, Sha256};

const HEROES_PATH: &str = "scripts/heroes.vdata_c";
const HERO_NAMES_PATH: &str =
    "resource/localization/citadel_gc_hero_names/citadel_gc_hero_names_english.txt";
const ENTITIES_VPK: &str = "maps/dl_midtown.vpk";
const ENTITIES_PATH: &str = "maps/dl_midtown/entities/default_ents.vents_c";

/// The three midtown minimap layers and their logical keys / output paths.
const MINIMAP_LAYERS: [(&str, &str, &str); 3] = [
    (
        "panorama/images/minimap/base/minimap_midtown_mid_psd.vtex_c",
        "map/minimap_midtown_mid",
        "map/minimap_midtown_mid.png",
    ),
    (
        "panorama/images/minimap/base/minimap_midtown_mid_tunnels_psd.vtex_c",
        "map/minimap_midtown_mid_tunnels",
        "map/minimap_midtown_mid_tunnels.png",
    ),
    (
        "panorama/images/minimap/base/minimap_midtown_rat_tunnels_psd.vtex_c",
        "map/minimap_midtown_rat_tunnels",
        "map/minimap_midtown_rat_tunnels.png",
    ),
];

/// What a successful extraction wrote.
#[derive(Debug)]
pub struct ExtractReport {
    pub pack: PathBuf,
    /// PNG/SVG/text paths relative to the output directory.
    pub files: Vec<String>,
    pub sources: usize,
    pub blobs: usize,
}

/// Extract the minimap layers, heroes, map entities, HUD icons and HUD sources into `out_dir`.
pub fn extract(game_dir: &Path, out_dir: &Path) -> Result<ExtractReport> {
    guard_output(game_dir, out_dir)?;

    let game = GameDir::new(game_dir)?;
    let steam = SteamInfo::read(&game)?;
    let vpk = Vpk::open(&game, "pak01_dir.vpk")?;

    std::fs::create_dir_all(out_dir)?;

    let mut pack = Pack::new(&steam);
    let mut files = Vec::new();

    for (entry_path, logical_key, file) in MINIMAP_LAYERS {
        extract_one(
            &vpk,
            out_dir,
            entry_path,
            logical_key,
            file,
            &mut pack,
            &mut files,
        )?;
    }

    pack.heroes = extract_heroes(&vpk, &game, out_dir, &mut pack, &mut files)?;

    let entities = match Vpk::open(&game, ENTITIES_VPK) {
        Ok(map) => extract_entities(&map, &mut pack)?,
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            entities::Extraction {
                entities: Vec::new(),
                geometry_hash: entities::geometry_hash(&[]),
            }
        }
        Err(error) => return Err(error),
    };
    pack.entities = entities
        .entities
        .into_iter()
        .map(|entity| Entity {
            key: entity.key,
            kind: entity.kind,
            team: entity.team,
            lane: entity.lane,
            world: entity.world,
            src: EntitySource {
                classname: entity.src.classname,
                hammeruniqueid: entity.src.hammeruniqueid,
                targetname: entity.src.targetname,
            },
            nodes: entity.nodes,
        })
        .collect();
    pack.geometry_hash = entities.geometry_hash;

    icons::extract(&vpk, out_dir, &mut pack, &mut files)?;
    hud::extract(&vpk, out_dir, &mut pack, &mut files)?;

    pack.sort_sources();
    let pack_bytes = pack.to_json()?;
    let pack_path = out_dir.join("pack.json");
    std::fs::write(&pack_path, &pack_bytes)?;

    Ok(ExtractReport {
        pack: pack_path,
        files,
        sources: pack.sources.len(),
        blobs: pack.blobs.len(),
    })
}

fn extract_heroes(
    vpk: &Vpk,
    game: &GameDir,
    out_dir: &Path,
    pack: &mut Pack,
    files: &mut Vec<String>,
) -> Result<Vec<Hero>> {
    let Some(entry) = vpk.entry(HEROES_PATH) else {
        return Ok(Vec::new());
    };
    let bytes = vpk.read_entry(entry)?;
    let resource = resource::parse(&bytes)?;
    let block = resource.block(b"DATA").ok_or(Error::MissingDataBlock)?;
    let root = kv3::decode(block.data)?;

    pack.add_source(
        entry.archive_name(vpk.dir_name()),
        entry.path.clone(),
        entry.crc32,
        entry.size(),
    );

    let names = match read_localisation(vpk, game, pack)? {
        Some(text) => kv1::flatten(&text)?,
        None => BTreeMap::new(),
    };

    let heroes = heroes::parse(&root, &names)?;
    let mut output = Vec::with_capacity(heroes.len());

    for mut hero in heroes {
        if hero.is_playable()
            && let Some(entry_path) = hero.minimap_entry.clone()
            && let Some(portrait) = vpk.entry(&entry_path)
        {
            let bytes = vpk.read_entry(portrait)?;
            let texture = decode_vtex(&bytes)?;
            let blob_key = format!("heroes/{}", hero.hero_id);
            let file = format!("{blob_key}.png");
            let png = write_png(
                &out_dir.join(&file),
                texture.width,
                texture.height,
                &texture.rgba,
            )?;
            let sha256 = sha256_hex(&png);

            pack.add_blob(
                blob_key.clone(),
                file.clone(),
                sha256,
                texture.width,
                texture.height,
            );
            pack.add_source(
                portrait.archive_name(vpk.dir_name()),
                portrait.path.clone(),
                portrait.crc32,
                portrait.size(),
            );
            hero.minimap_blob = Some(blob_key);
            files.push(file);
        }

        output.push(Hero {
            hero_id: hero.hero_id,
            class_name: hero.class_name,
            name: hero.name,
            dev_state: hero.dev_state,
            disabled: hero.disabled,
            minimap_blob: hero.minimap_blob,
        });
    }

    Ok(output)
}

fn read_localisation(vpk: &Vpk, game: &GameDir, pack: &mut Pack) -> Result<Option<String>> {
    if let Some(entry) = vpk.entry(HERO_NAMES_PATH) {
        let bytes = vpk.read_entry(entry)?;
        pack.add_source(
            entry.archive_name(vpk.dir_name()),
            entry.path.clone(),
            entry.crc32,
            entry.size(),
        );
        return String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| Error::InvalidUtf8);
    }

    match game.path(HERO_NAMES_PATH) {
        Ok(path) => {
            let bytes = std::fs::read(path)?;
            pack.add_source(
                "loose".to_owned(),
                HERO_NAMES_PATH.to_owned(),
                crc32fast::hash(&bytes),
                bytes.len() as u64,
            );
            String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| Error::InvalidUtf8)
        }
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn extract_entities(map: &Vpk, pack: &mut Pack) -> Result<entities::Extraction> {
    let Some(entry) = map.entry(ENTITIES_PATH) else {
        return Ok(entities::Extraction {
            entities: Vec::new(),
            geometry_hash: entities::geometry_hash(&[]),
        });
    };
    let bytes = map.read_entry(entry)?;
    let resource = resource::parse(&bytes)?;
    let block = resource.block(b"DATA").ok_or(Error::MissingDataBlock)?;
    let root = kv3::decode(block.data)?;

    pack.add_source(
        entry.archive_name(map.dir_name()),
        entry.path.clone(),
        entry.crc32,
        entry.size(),
    );

    entities::extract(&root)
}

fn extract_one(
    vpk: &Vpk,
    out_dir: &Path,
    entry_path: &str,
    logical_key: &str,
    file: &str,
    pack: &mut Pack,
    files: &mut Vec<String>,
) -> Result<()> {
    let bytes = vpk.read(entry_path)?;
    let texture = decode_vtex(&bytes)?;
    let png = write_png(
        &out_dir.join(file),
        texture.width,
        texture.height,
        &texture.rgba,
    )?;
    let sha256 = sha256_hex(&png);

    pack.add_blob(
        logical_key.to_owned(),
        file.to_owned(),
        sha256,
        texture.width,
        texture.height,
    );

    let entry = vpk
        .entry(entry_path)
        .ok_or_else(|| Error::EntryNotFound(entry_path.to_owned()))?;
    pack.add_source(
        entry.archive_name(vpk.dir_name()),
        entry.path.clone(),
        entry.crc32,
        entry.size(),
    );

    files.push(file.to_owned());
    Ok(())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Refuse an output directory inside the game install or inside this repository.
fn guard_output(game_dir: &Path, out_dir: &Path) -> Result<()> {
    let game = resolve_path(game_dir)?;
    let out = resolve_path(out_dir)?;

    if out.starts_with(&game) {
        return Err(Error::OutputInsideGame(out));
    }

    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo = resolve_path(&manifest.join("..").join(".."))?;
    if out.starts_with(&repo) {
        return Err(Error::OutputInsideRepo(out));
    }

    Ok(())
}

/// Make a path absolute and lexically clean, then resolve symlinks in its longest existing
/// prefix. This lets the output guard compare a not-yet-created directory against real ones.
fn resolve_path(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };

    let mut lexical = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => lexical.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                lexical.pop();
            }
            Component::Normal(part) => lexical.push(part),
        }
    }

    let mut existing = lexical.as_path();
    let mut tail = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name() else {
            return Ok(lexical);
        };
        tail.push(name.to_owned());
        let Some(parent) = existing.parent() else {
            return Ok(lexical);
        };
        existing = parent;
    }

    let mut resolved = existing.canonicalize()?;
    for part in tail.iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}
