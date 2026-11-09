//! The game directory and its allow-list.
//!
//! The Deadlock `citadel` folder also contains per-account files (`account_*.stats`,
//! `cache_*.soc`, `cfg/`). The extractor must never touch them, so every path goes through
//! [`GameDir::path`], which refuses anything outside a fixed list of archive files.

use std::fs::File;
use std::path::{Path, PathBuf};

use crate::{Error, Result};

/// Exact VPK entries for the fixed top-bar art.
pub const TOPBAR_FIXED: [&str; 10] = [
    "panorama/images/hero_badges/hero_image_mask_psd.vtex_c",
    "panorama/images/hud/top_bar/icon_ultimate.vsvg_c",
    "panorama/images/hud/top_bar/icon_ultimate_off.vsvg_c",
    "panorama/images/control_icons/lock_psd.vtex_c",
    "panorama/images/hud/core/icon_team1_psd.vtex_c",
    "panorama/images/hud/core/icon_team2_psd.vtex_c",
    "panorama/images/masks/dust_01_psd.vtex_c",
    "panorama/images/hud/healthbar/healthbar_backer_vert_border.vsvg_c",
    "panorama/images/hud/healthbar/healthbar_backer_vert_mask.vsvg_c",
    "panorama/images/hud/icons/skull.vsvg_c",
];

/// Exact VPK entries for the HUD source files.
pub const HUD_SOURCES: [&str; 11] = [
    "panorama/styles/hud_minimap.vcss_c",
    "panorama/styles/hud.vcss_c",
    "panorama/layout/hud_minimap.vxml_c",
    "panorama/layout/hud.vxml_c",
    "panorama/layout/citadel_hud_top_bar.vxml_c",
    "panorama/layout/citadel_hud_top_bar_player.vxml_c",
    "panorama/layout/citadel_hud_top_bar_team.vxml_c",
    "panorama/styles/citadel_hud_top_bar.vcss_c",
    "panorama/layout/hero_badge.vxml_c",
    "panorama/styles/hero_badge.vcss_c",
    // The palette the others name (colorEnemy, offWhite, team1Color...).
    "panorama/styles/citadel_base_styles.vcss_c",
];

/// Whether a VPK entry may be read for the top-bar art.
///
/// This is deliberately narrow: the ten fixed paths above, plus the
/// `panorama/images/heroes/*_psd.vtex_c` hero-portrait pattern.
pub fn is_topbar_entry_allowed(relative: &str) -> bool {
    TOPBAR_FIXED.contains(&relative) || is_hero_portrait_entry(relative)
}

/// Whether a VPK entry may be read as a HUD source file.
pub fn is_hud_source_allowed(relative: &str) -> bool {
    HUD_SOURCES.contains(&relative)
}

fn is_hero_portrait_entry(relative: &str) -> bool {
    let Some(rest) = relative.strip_prefix("panorama/images/heroes/") else {
        return false;
    };
    let Some(stem) = rest.strip_suffix("_psd.vtex_c") else {
        return false;
    };
    !stem.is_empty() && !stem.contains('/')
}

/// The game's `citadel` directory, restricted to the files the extractor needs.
#[derive(Clone, Debug)]
pub struct GameDir {
    root: PathBuf,
}

impl GameDir {
    /// Canonicalize `root` and remember it. Fails if `root` is not a directory.
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().canonicalize()?;
        if !root.is_dir() {
            return Err(Error::NotADirectory(root));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Whether `relative` names one of the files the extractor is allowed to open.
    ///
    /// Only the VPK directory file, its numbered chunks, the midtown map VPK, `steam.inf` and the
    /// English hero-name localisation file are allowed. In particular nothing under `cfg/`,
    /// `account_*` or `cache_*` is.
    pub fn is_allowed(relative: &str) -> bool {
        if matches!(
            relative,
            "steam.inf"
                | "maps/dl_midtown.vpk"
                | "pak01_dir.vpk"
                | "resource/localization/citadel_gc_hero_names/citadel_gc_hero_names_english.txt"
        ) {
            return true;
        }

        let Some(number) = relative
            .strip_prefix("pak01_")
            .and_then(|rest| rest.strip_suffix(".vpk"))
        else {
            return false;
        };

        number.len() == 3 && number.bytes().all(|byte| byte.is_ascii_digit())
    }

    /// Resolve an allow-listed relative path inside the game directory.
    ///
    /// The path is checked three ways: the name must be allow-listed, every component must be a
    /// normal component (no `..`, no absolute paths, no backslashes), and the canonicalized
    /// result must still live under the game directory (so a symlink cannot escape).
    pub fn path(&self, relative: &str) -> Result<PathBuf> {
        if !Self::is_allowed(relative) {
            return Err(Error::PathNotAllowed(relative.to_owned()));
        }

        let joined = self.root.join(relative_path(relative)?);
        let canonical = joined.canonicalize()?;
        if !canonical.starts_with(&self.root) {
            return Err(Error::UnsafePath(relative.to_owned()));
        }
        Ok(canonical)
    }

    /// Open an allow-listed file.
    pub fn open(&self, relative: &str) -> Result<File> {
        Ok(File::open(self.path(relative)?)?)
    }
}

fn relative_path(relative: &str) -> Result<PathBuf> {
    if relative.is_empty() || relative.starts_with('/') || relative.contains('\\') {
        return Err(Error::UnsafePath(relative.to_owned()));
    }

    let mut path = PathBuf::new();
    for part in relative.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(Error::UnsafePath(relative.to_owned()));
        }
        path.push(part);
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topbar_allow_list_is_narrow() {
        for path in TOPBAR_FIXED {
            assert!(is_topbar_entry_allowed(path), "{path}");
        }
        assert!(is_topbar_entry_allowed(
            "panorama/images/heroes/inferno_vertical_psd.vtex_c"
        ));
        assert!(is_topbar_entry_allowed(
            "panorama/images/heroes/inferno_mm_psd.vtex_c"
        ));

        assert!(!is_topbar_entry_allowed(
            "panorama/images/heroes/../evil_psd.vtex_c"
        ));
        assert!(!is_topbar_entry_allowed(
            "panorama/images/heroes/sub/inferno_vertical_psd.vtex_c"
        ));
        assert!(!is_topbar_entry_allowed(
            "panorama/images/minimap/ammo_box_psd.vtex_c"
        ));
        assert!(!is_topbar_entry_allowed("panorama/images/heroes/empty_psd.vtex_c/../x"));
    }

    #[test]
    fn hud_source_allow_list_is_exact() {
        for path in HUD_SOURCES {
            assert!(is_hud_source_allowed(path), "{path}");
        }
        assert!(!is_hud_source_allowed("panorama/styles/other.vcss_c"));
        assert!(!is_hud_source_allowed("panorama/styles/hud.vcss"));
    }
}
