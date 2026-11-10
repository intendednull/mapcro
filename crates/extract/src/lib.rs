//! mapcro game-asset extractor.
//!
//! Reads a local Deadlock `citadel` install, extracts the minimap layers, hero portraits, hero
//! records, map entities, HUD icons and HUD sources, and writes a content-addressed `pack.json`.
//! Only allow-listed files are opened, and no extracted art is ever written inside the repository.
//!
//! The VPK reader, binary KV3 reader and Source 2 resource/texture decoders are pure Rust; the
//! container and KV3 layouts are ported from ValveResourceFormat (MIT), credited in [`kv3`] and
//! [`vtex`].

mod abilities;
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
mod topbar;
mod vpk;
mod vtex;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use abilities::Kind;
pub use abilities::token;
pub use allow::GameDir;
pub use error::{Error, Result};
pub use kv3::Value;
pub use pack::{
    AbilityTable, Blob, Entity, EntitySource, Extractor, Game, Hero, HudSource, Icon, Pack, SCHEMA,
    SkippedIcon, Source,
};
pub use png_out::{encode_png, write_png};
pub use steam::SteamInfo;
pub use vpk::{Entry, Vpk};
pub use vtex::{Texture, decode_vtex, format_label};

use sha2::{Digest, Sha256};

const HEROES_PATH: &str = "scripts/heroes.vdata_c";
const ABILITIES_PATH: &str = "scripts/abilities.vdata_c";
const MODIFIERS_PATH: &str = "scripts/modifiers.vdata_c";
const GENERIC_PATH: &str = "scripts/generic_data.vdata_c";
/// Files whose records carry modifiers without being abilities: pickups and props, NPC units.
const MODIFIER_HOSTS: [&str; 2] = ["scripts/misc.vdata_c", "scripts/npc_units.vdata_c"];
/// The names table's blob key and file.
const ABILITIES_BLOB: &str = "data/abilities";
const ABILITIES_FILE: &str = "data/abilities.json";
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

    let (heroes, signature) = extract_heroes(&vpk, &game, out_dir, &mut pack, &mut files)?;
    pack.heroes = heroes;
    extract_abilities(&vpk, &game, out_dir, &signature, &mut pack, &mut files)?;

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
            tier: entity.tier.map(str::to_owned),
            exit: entity.exit,
        })
        .collect();
    pack.geometry_hash = entities.geometry_hash;

    icons::extract(&vpk, out_dir, &mut pack, &mut files)?;
    topbar::extract(&vpk, out_dir, &mut pack, &mut files)?;
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
) -> Result<(Vec<Hero>, BTreeSet<String>)> {
    let Some(root) = read_vdata(vpk, HEROES_PATH, pack)? else {
        return Ok((Vec::new(), BTreeSet::new()));
    };

    let names = match read_localisation(vpk, game, pack, HERO_NAMES_PATH)? {
        Some(text) => kv1::flatten(&text)?,
        None => BTreeMap::new(),
    };

    let heroes = heroes::parse(&root, &names)?;
    let mut output = Vec::with_capacity(heroes.len());
    let mut signature = BTreeSet::new();

    for mut hero in heroes {
        if hero.is_playable() {
            signature.extend(hero.abilities.iter().flatten().cloned());
        }
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

        if hero.is_playable()
            && let Some(entry_path) = hero.topbar_entry.clone()
        {
            hero.topbar_blob = topbar::export_hero_portrait(
                vpk,
                out_dir,
                hero.hero_id,
                "",
                &entry_path,
                pack,
                files,
            )?;
        }

        if hero.is_playable()
            && let Some(entry_path) = hero.card_entry.clone()
        {
            hero.card_blob = topbar::export_hero_portrait(
                vpk,
                out_dir,
                hero.hero_id,
                "_card",
                &entry_path,
                pack,
                files,
            )?;
        }

        if hero.is_playable()
            && let Some(entry_path) = hero.critical_entry.clone()
        {
            hero.critical_blob = topbar::export_hero_portrait(
                vpk,
                out_dir,
                hero.hero_id,
                "_critical",
                &entry_path,
                pack,
                files,
            )?;
        }

        output.push(Hero {
            hero_id: hero.hero_id,
            class_name: hero.class_name,
            name: hero.name,
            dev_state: hero.dev_state,
            disabled: hero.disabled,
            minimap_blob: hero.minimap_blob,
            topbar_blob: hero.topbar_blob,
            card_blob: hero.card_blob,
            critical_blob: hero.critical_blob,
            abilities: hero
                .abilities
                .each_ref()
                .map(|name| name.as_deref().map_or(0, token)),
        });
    }

    Ok((output, signature))
}

/// A decoded `.vdata_c` from the VPK, recorded as a source; `None` when the VPK hasn't it.
fn read_vdata(vpk: &Vpk, path: &str, pack: &mut Pack) -> Result<Option<Value>> {
    let Some(entry) = vpk.entry(path) else {
        return Ok(None);
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
    Ok(Some(root))
}

/// The items, abilities and modifiers names table (`data/abilities.json`) and their icons.
fn extract_abilities(
    vpk: &Vpk,
    game: &GameDir,
    out_dir: &Path,
    signature: &BTreeSet<String>,
    pack: &mut Pack,
    files: &mut Vec<String>,
) -> Result<()> {
    let Some(abilities_root) = read_vdata(vpk, ABILITIES_PATH, pack)? else {
        return Ok(());
    };
    let modifiers_root = read_vdata(vpk, MODIFIERS_PATH, pack)?;
    let prices = read_vdata(vpk, GENERIC_PATH, pack)?
        .map(|generic| abilities::prices(&generic))
        .unwrap_or_default();

    // First file wins a key (allow::ABILITY_NAMES is in lookup order); keys are lower-cased.
    let mut names = BTreeMap::new();
    for path in allow::ABILITY_NAMES {
        if let Some(text) = read_localisation(vpk, game, pack, path)? {
            for (key, value) in kv1::flatten(&text)? {
                names.entry(key.to_ascii_lowercase()).or_insert(value);
            }
        }
    }

    let mut hosts = Vec::new();
    for path in MODIFIER_HOSTS {
        if let Some(root) = read_vdata(vpk, path, pack)? {
            hosts.push(root);
        }
    }
    let hosts: Vec<&Value> = hosts.iter().collect();

    let mut table = abilities::parse(
        &abilities_root,
        modifiers_root.as_ref(),
        &hosts,
        &names,
        &prices,
    );
    abilities::fill_from_ability(&mut table);

    // One file per distinct source, shared by every record that names it; a record takes the
    // first of its candidates the pack can carry.
    let mut exported: BTreeMap<String, Option<String>> = BTreeMap::new();
    let (mut icons, mut missing) = (0, 0);
    for record in table.records.values_mut() {
        if record.icon_entries.is_empty() || !abilities::wants_icon(record, signature) {
            continue;
        }
        for entry_path in &record.icon_entries {
            let blob = match exported.get(entry_path) {
                Some(blob) => blob.clone(),
                None => {
                    let blob = export_ability_icon(vpk, out_dir, entry_path, pack, files)?;
                    exported.insert(entry_path.clone(), blob.clone());
                    blob
                }
            };
            if blob.is_some() {
                record.icon = blob;
                break;
            }
        }
        if record.icon.is_some() {
            icons += 1;
        } else {
            missing += 1;
        }
    }

    let json = serde_json::to_vec(&serde_json::json!({
        "records": table.records.iter().map(|(id, r)| (id.to_string(), r)).collect::<BTreeMap<_, _>>(),
    }))?;
    let path = out_dir.join(ABILITIES_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, &json)?;
    pack.add_blob_with_mime(
        ABILITIES_BLOB.to_owned(),
        ABILITIES_FILE.to_owned(),
        sha256_hex(&json),
        0,
        0,
        "application/json",
    );
    files.push(ABILITIES_FILE.to_owned());

    pack.abilities = Some(AbilityTable {
        blob: ABILITIES_BLOB.to_owned(),
        items: table.count(Kind::Item),
        abilities: table.count(Kind::Ability),
        modifiers: table.count(Kind::Modifier),
        icons,
        icons_missing: missing,
        collisions: table.collisions,
    });
    Ok(())
}

/// Decode one allow-listed icon into `abilities/<path under panorama/images>.png` (`.svg` for an
/// SVG). `None` when the path isn't allow-listed, the VPK hasn't it, or its texture format isn't
/// supported.
fn export_ability_icon(
    vpk: &Vpk,
    out_dir: &Path,
    entry_path: &str,
    pack: &mut Pack,
    files: &mut Vec<String>,
) -> Result<Option<String>> {
    if !allow::is_ability_icon_entry(entry_path) {
        return Ok(None);
    }
    let Some(entry) = vpk.entry(entry_path) else {
        return Ok(None);
    };
    let relative = entry_path
        .strip_prefix("panorama/images/")
        .ok_or_else(|| Error::PathNotAllowed(entry_path.to_owned()))?;
    let bytes = vpk.read_entry(entry)?;
    let (key, file) = if let Some(stem) = relative.strip_suffix(".vsvg_c") {
        let resource = resource::parse(&bytes)?;
        let block = resource.block(b"DATA").ok_or(Error::MissingDataBlock)?;
        let text = panorama::text_payload(block.data, resource.version)?;
        let text = std::str::from_utf8(text).map_err(|_| Error::InvalidUtf8)?;
        let key = format!("abilities/{stem}");
        let file = format!("{key}.svg");
        let path = out_dir.join(&file);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, text.as_bytes())?;
        let sha256 = sha256_hex(text.as_bytes());
        pack.add_blob_with_mime(key.clone(), file.clone(), sha256, 0, 0, "image/svg+xml");
        (key, file)
    } else {
        let stem = relative
            .strip_suffix(".vtex_c")
            .ok_or_else(|| Error::PathNotAllowed(entry_path.to_owned()))?;
        let texture = match decode_vtex(&bytes) {
            Ok(texture) => texture,
            Err(Error::UnsupportedFormat(_)) => return Ok(None),
            Err(error) => return Err(error),
        };
        let key = format!("abilities/{stem}");
        let file = format!("{key}.png");
        let png = write_png(
            &out_dir.join(&file),
            texture.width,
            texture.height,
            &texture.rgba,
        )?;
        pack.add_blob(
            key.clone(),
            file.clone(),
            sha256_hex(&png),
            texture.width,
            texture.height,
        );
        (key, file)
    };
    pack.add_source(
        entry.archive_name(vpk.dir_name()),
        entry.path.clone(),
        entry.crc32,
        entry.size(),
    );
    files.push(file);
    Ok(Some(key))
}

fn read_localisation(
    vpk: &Vpk,
    game: &GameDir,
    pack: &mut Pack,
    path: &str,
) -> Result<Option<String>> {
    if let Some(entry) = vpk.entry(path) {
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

    match game.path(path) {
        Ok(full) => {
            let bytes = std::fs::read(full)?;
            pack.add_source(
                "loose".to_owned(),
                path.to_owned(),
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

/// The map's decoded entity lump (`maps/dl_midtown/entities/default_ents.vents_c`), for audits
/// that need every record rather than the pack's kinds (`examples/lump_census.rs`).
pub fn entity_lump(game_dir: &Path) -> Result<Value> {
    let game = GameDir::new(game_dir)?;
    let map = Vpk::open(&game, ENTITIES_VPK)?;
    let bytes = map.read(ENTITIES_PATH)?;
    let resource = resource::parse(&bytes)?;
    let block = resource.block(b"DATA").ok_or(Error::MissingDataBlock)?;
    kv3::decode(block.data)
}

/// A decoded `.vdata_c` from `pak01_dir.vpk` (`scripts/abilities.vdata_c`, say), for audits and
/// probes that need every record (`examples/vdata_census.rs`).
pub fn vdata(game_dir: &Path, path: &str) -> Result<Value> {
    let game = GameDir::new(game_dir)?;
    let vpk = Vpk::open(&game, "pak01_dir.vpk")?;
    let bytes = vpk.read(path)?;
    let resource = resource::parse(&bytes)?;
    let block = resource.block(b"DATA").ok_or(Error::MissingDataBlock)?;
    kv3::decode(block.data)
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
