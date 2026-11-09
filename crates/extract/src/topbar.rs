//! Top-bar art: hero vertical portraits and the fixed HUD images.

use std::path::Path;

use crate::pack::Pack;
use crate::{
    allow, decode_vtex, panorama, resource, sha256_hex, write_png, Error, Result, Vpk,
};

/// Export the fixed top-bar images under `topbar/<stem>`.
pub fn extract(
    vpk: &Vpk,
    out_dir: &Path,
    pack: &mut Pack,
    files: &mut Vec<String>,
) -> Result<()> {
    for source in allow::TOPBAR_FIXED {
        if !allow::is_topbar_entry_allowed(source) {
            return Err(Error::PathNotAllowed(source.to_owned()));
        }
        let Some(entry) = vpk.entry(source) else {
            continue;
        };
        let (stem, svg) = split_entry(source)?;
        let key = format!("topbar/{stem}");

        if svg {
            export_svg(vpk, entry, &key, out_dir, pack, files)?;
        } else {
            export_texture(vpk, entry, &key, out_dir, pack, files)?;
        }
    }

    Ok(())
}

/// Export one hero's portrait as `topbar/heroes/<hero_id><suffix>.png`: the vertical one with
/// suffix `""`, the hero card with `"_card"`, the low-health card with `"_critical"`.
///
/// Returns the blob key, or `None` when the portrait is absent from the VPK.
pub fn export_hero_portrait(
    vpk: &Vpk,
    out_dir: &Path,
    hero_id: u64,
    suffix: &str,
    source: &str,
    pack: &mut Pack,
    files: &mut Vec<String>,
) -> Result<Option<String>> {
    if !allow::is_topbar_entry_allowed(source) {
        return Err(Error::PathNotAllowed(source.to_owned()));
    }
    let Some(entry) = vpk.entry(source) else {
        return Ok(None);
    };

    let key = format!("topbar/heroes/{hero_id}{suffix}");
    export_texture(vpk, entry, &key, out_dir, pack, files)?;
    Ok(Some(key))
}

fn export_texture(
    vpk: &Vpk,
    entry: &crate::Entry,
    key: &str,
    out_dir: &Path,
    pack: &mut Pack,
    files: &mut Vec<String>,
) -> Result<()> {
    let bytes = vpk.read_entry(entry)?;
    let texture = decode_vtex(&bytes)?;
    let file = format!("{key}.png");
    let png = write_png(
        &out_dir.join(&file),
        texture.width,
        texture.height,
        &texture.rgba,
    )?;

    pack.add_blob(
        key.to_owned(),
        file.clone(),
        sha256_hex(&png),
        texture.width,
        texture.height,
    );
    pack.add_source(
        entry.archive_name(vpk.dir_name()),
        entry.path.clone(),
        entry.crc32,
        entry.size(),
    );
    files.push(file);
    Ok(())
}

fn export_svg(
    vpk: &Vpk,
    entry: &crate::Entry,
    key: &str,
    out_dir: &Path,
    pack: &mut Pack,
    files: &mut Vec<String>,
) -> Result<()> {
    let bytes = vpk.read_entry(entry)?;
    let resource = resource::parse(&bytes)?;
    let block = resource.block(b"DATA").ok_or(Error::MissingDataBlock)?;
    let text = panorama::text_payload(block.data, resource.version)?;
    let text = std::str::from_utf8(text).map_err(|_| Error::InvalidUtf8)?;

    let file = format!("{key}.svg");
    if let Some(parent) = out_dir.join(&file).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(out_dir.join(&file), text.as_bytes())?;

    pack.add_blob_with_mime(
        key.to_owned(),
        file.clone(),
        sha256_hex(text.as_bytes()),
        0,
        0,
        "image/svg+xml",
    );
    pack.add_source(
        entry.archive_name(vpk.dir_name()),
        entry.path.clone(),
        entry.crc32,
        entry.size(),
    );
    files.push(file);
    Ok(())
}

fn split_entry(source: &str) -> Result<(&str, bool)> {
    let file = source
        .rsplit_once('/')
        .map(|(_, file)| file)
        .ok_or_else(|| Error::PathNotAllowed(source.to_owned()))?;

    if let Some(stem) = file.strip_suffix(".vtex_c") {
        return Ok((stem, false));
    }
    if let Some(stem) = file.strip_suffix(".vsvg_c") {
        return Ok((stem, true));
    }
    Err(Error::PathNotAllowed(source.to_owned()))
}
