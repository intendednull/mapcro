//! HUD style, layout and minimap sources exported for visual parity.

use std::path::Path;

use crate::pack::HudSource;
use crate::{allow, panorama, resource, sha256_hex, Error, Result, Vpk};

const SOURCES: [(&str, &str, Kind); 10] = [
    (
        "hud/hud_minimap.vcss",
        "panorama/styles/hud_minimap.vcss_c",
        Kind::Style,
    ),
    (
        "hud/hud.vcss",
        "panorama/styles/hud.vcss_c",
        Kind::Style,
    ),
    (
        "hud/hud_minimap.vxml",
        "panorama/layout/hud_minimap.vxml_c",
        Kind::Layout,
    ),
    (
        "hud/hud.vxml",
        "panorama/layout/hud.vxml_c",
        Kind::Layout,
    ),
    (
        "hud/citadel_hud_top_bar.vxml",
        "panorama/layout/citadel_hud_top_bar.vxml_c",
        Kind::Layout,
    ),
    (
        "hud/citadel_hud_top_bar_player.vxml",
        "panorama/layout/citadel_hud_top_bar_player.vxml_c",
        Kind::Layout,
    ),
    (
        "hud/citadel_hud_top_bar_team.vxml",
        "panorama/layout/citadel_hud_top_bar_team.vxml_c",
        Kind::Layout,
    ),
    (
        "hud/citadel_hud_top_bar.vcss",
        "panorama/styles/citadel_hud_top_bar.vcss_c",
        Kind::Style,
    ),
    (
        "hud/hero_badge.vxml",
        "panorama/layout/hero_badge.vxml_c",
        Kind::Layout,
    ),
    (
        "hud/hero_badge.vcss",
        "panorama/styles/hero_badge.vcss_c",
        Kind::Style,
    ),
];

#[derive(Clone, Copy, Debug)]
enum Kind {
    Style,
    Layout,
}

/// Write the ten HUD source files and record them in `pack.json`.
pub fn extract(
    vpk: &Vpk,
    out_dir: &Path,
    pack: &mut crate::pack::Pack,
    files: &mut Vec<String>,
) -> Result<()> {
    for (key, source, kind) in SOURCES {
        if !allow::is_hud_source_allowed(source) {
            return Err(Error::PathNotAllowed(source.to_owned()));
        }
        let Some(entry) = vpk.entry(source) else {
            continue;
        };
        let bytes = vpk.read_entry(entry)?;

        let resource = resource::parse(&bytes)?;
        let text = match kind {
            Kind::Style => {
                let block = resource.block(b"DATA").ok_or(Error::MissingDataBlock)?;
                let payload = panorama::text_payload(block.data, resource.version)?;
                String::from_utf8(payload.to_vec()).map_err(|_| Error::InvalidUtf8)?
            }
            Kind::Layout => {
                let block = resource.block(b"LaCo").ok_or(Error::MissingDataBlock)?;
                panorama::layout_xml(block.data)?
            }
        };

        let path = out_dir.join(key);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, text.as_bytes())?;

        pack.add_source(
            entry.archive_name(vpk.dir_name()),
            entry.path.clone(),
            entry.crc32,
            entry.size(),
        );
        pack.hud_sources.push(HudSource {
            key: key.to_owned(),
            source: source.to_owned(),
            file: key.to_owned(),
            sha256: sha256_hex(text.as_bytes()),
            bytes: text.len() as u64,
        });
        files.push(key.to_owned());
    }

    Ok(())
}
