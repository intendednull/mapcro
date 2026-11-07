//! The game directory and its allow-list.
//!
//! The Deadlock `citadel` folder also contains per-account files (`account_*.stats`,
//! `cache_*.soc`, `cfg/`). The extractor must never touch them, so every path goes through
//! [`GameDir::path`], which refuses anything outside a fixed list of archive files.

use std::fs::File;
use std::path::{Path, PathBuf};

use crate::{Error, Result};

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
    /// Only the VPK directory file, its numbered chunks, the midtown map VPK and `steam.inf`
    /// are allowed. In particular nothing under `cfg/`, `account_*` or `cache_*` is.
    pub fn is_allowed(relative: &str) -> bool {
        if matches!(
            relative,
            "steam.inf" | "maps/dl_midtown.vpk" | "pak01_dir.vpk"
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
