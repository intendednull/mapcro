//! Minimap HUD textures and SVG icons.

use std::path::Path;

use crate::pack::{Icon, SkippedIcon};
use crate::{decode_vtex, format_label, panorama, resource, sha256_hex, write_png, Error, Result, Vpk};

/// Extract every icon directly under `panorama/images/minimap/`, every texture under
/// `panorama/images/minimap/base/`, and the SVG resources beside them.
pub fn extract(
    vpk: &Vpk,
    out_dir: &Path,
    pack: &mut crate::pack::Pack,
    files: &mut Vec<String>,
) -> Result<()> {
    let mut entries = vpk
        .entries()
        .filter(|entry| icon_path(&entry.path).is_some())
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.path.cmp(&right.path));

    for entry in entries {
        let Some((subdirectory, stem, kind)) = icon_path(&entry.path) else {
            continue;
        };
        let key = if subdirectory.is_empty() {
            format!("icons/{stem}")
        } else {
            format!("icons/{subdirectory}/{stem}")
        };

        match kind {
            IconKind::Texture => {
                let file = format!("{key}.png");
                let bytes = vpk.read(&entry.path)?;
                match decode_vtex(&bytes) {
                    Ok(texture) => {
                        let png = write_png(
                            &out_dir.join(&file),
                            texture.width,
                            texture.height,
                            &texture.rgba,
                        )?;
                        let sha256 = sha256_hex(&png);
                        pack.add_blob(
                            key.clone(),
                            file.clone(),
                            sha256,
                            texture.width,
                            texture.height,
                        );
                        pack.add_source(
                            entry.archive_name(vpk.dir_name()),
                            entry.path.clone(),
                            entry.crc32,
                            entry.size(),
                        );
                        pack.icons.push(Icon {
                            key: key.clone(),
                            source: entry.path.clone(),
                            format: texture.format_label(),
                            blob: key,
                        });
                        files.push(file);
                    }
                    Err(Error::UnsupportedFormat(format)) => {
                        pack.icons_skipped.push(SkippedIcon {
                            source: entry.path.clone(),
                            format: format_label(format),
                        });
                    }
                    Err(error) => return Err(error),
                }
            }
            IconKind::Svg => {
                let file = format!("{key}.svg");
                let bytes = vpk.read(&entry.path)?;
                let resource = resource::parse(&bytes)?;
                let block = resource.block(b"DATA").ok_or(Error::MissingDataBlock)?;
                let text = panorama::text_payload(block.data, resource.version)?;
                let text = std::str::from_utf8(text).map_err(|_| Error::InvalidUtf8)?;
                std::fs::write(out_dir.join(&file), text.as_bytes())?;
                let sha256 = sha256_hex(text.as_bytes());
                pack.add_blob_with_mime(
                    key.clone(),
                    file.clone(),
                    sha256,
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
                pack.icons.push(Icon {
                    key: key.clone(),
                    source: entry.path.clone(),
                    format: "svg".to_owned(),
                    blob: key,
                });
                files.push(file);
            }
        }
    }

    Ok(())
}

#[derive(Clone, Copy, Debug)]
enum IconKind {
    Texture,
    Svg,
}

fn icon_path(path: &str) -> Option<(&str, &str, IconKind)> {
    let rest = path.strip_prefix("panorama/images/minimap/")?;

    if let Some(rest) = rest.strip_prefix("base/") {
        let stem = rest.strip_suffix(".vtex_c")?;
        if stem.is_empty() || stem.contains('/') {
            return None;
        }
        return Some(("base", stem, IconKind::Texture));
    }

    if rest.contains('/') {
        return None;
    }

    if let Some(stem) = rest.strip_suffix(".vtex_c") {
        if stem.is_empty() {
            return None;
        }
        return Some(("", stem, IconKind::Texture));
    }

    if let Some(stem) = rest.strip_suffix(".vsvg_c") {
        if stem.is_empty() {
            return None;
        }
        return Some(("", stem, IconKind::Svg));
    }

    None
}
