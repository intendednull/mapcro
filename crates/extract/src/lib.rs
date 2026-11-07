//! mapcro game-asset extractor.
//!
//! Reads a local Deadlock `citadel` install, extracts the minimap layers and hero portraits from
//! `pak01_dir.vpk`, and writes a content-addressed `pack.json` plus PNGs. Only allow-listed
//! files are opened, and no extracted art is ever written inside the repository.
//!
//! The VPK reader and the Source 2 resource/texture decoder are standard-library Rust; the
//! container layout is ported from ValveResourceFormat (MIT), credited in [`decode_vtex`].

mod allow;
mod error;
mod pack;
mod png_out;
mod steam;
mod vpk;
mod vtex;

use std::path::{Component, Path, PathBuf};

pub use allow::GameDir;
pub use error::{Error, Result};
pub use pack::{Blob, Extractor, Game, Pack, SCHEMA, Source};
pub use png_out::{encode_png, write_png};
pub use steam::SteamInfo;
pub use vpk::{Entry, Vpk};
pub use vtex::{Texture, decode_vtex};

use sha2::{Digest, Sha256};

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
    /// PNG paths relative to the output directory.
    pub files: Vec<String>,
    pub sources: usize,
    pub blobs: usize,
}

/// Extract the minimap layers and every hero minimap portrait into `out_dir`.
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

    let mut heroes: Vec<(&str, &str)> = vpk
        .entries()
        .filter_map(|entry| hero_stem(&entry.path).map(|stem| (stem, entry.path.as_str())))
        .collect();
    heroes.sort_by(|left, right| left.0.cmp(right.0));

    for (stem, entry_path) in heroes {
        let logical_key = format!("heroes/{stem}");
        let file = format!("heroes/{stem}.png");
        extract_one(
            &vpk,
            out_dir,
            entry_path,
            &logical_key,
            &file,
            &mut pack,
            &mut files,
        )?;
    }

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

/// `panorama/images/heroes/<stem>_mm_psd.vtex_c`, with exactly one path level under `heroes/`.
fn hero_stem(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("panorama/images/heroes/")?;
    let stem = rest.strip_suffix("_mm_psd.vtex_c")?;
    if stem.is_empty() || stem.contains('/') {
        return None;
    }
    Some(stem)
}

fn sha256_hex(bytes: &[u8]) -> String {
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
