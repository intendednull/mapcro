//! Which folder the replay picker lists (desktop/README.md, "The replays folder"): the one the
//! user chose with **Change folder**, kept in the app's config folder, while it's still there;
//! else Deadlock's own, found through Steam (`steam::locate`). Looked up when the picker asks, not
//! watched. The chosen path never leaves the app: the page sees match ids only.

use std::path::{Path, PathBuf};

/// The file in the app's config folder that keeps the chosen folder.
pub const CHOSEN_FILE: &str = "replays-folder.txt";

/// Why there's no folder to list. Carries no path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoFolder {
    /// Steam or Deadlock wasn't found (the code says which), and nothing was chosen.
    Missing(&'static str),
    /// Deadlock's folder is where it should be, but not made yet (the game makes it on the first
    /// download).
    NotYet,
}

impl NoFolder {
    /// What the page is told: `not_found` either way (it offers Change folder and the file).
    pub fn code(self) -> &'static str {
        "not_found"
    }
    /// What's logged: which step failed.
    pub fn reason(self) -> &'static str {
        match self {
            NoFolder::Missing(c) => c,
            NoFolder::NotYet => "no_folder_yet",
        }
    }
}

/// The folder to list: `chosen` while it's a folder, else what `locate` finds, if it's made.
pub fn resolve<E>(chosen: Option<&Path>, locate: impl FnOnce() -> Result<PathBuf, E>, code: impl FnOnce(E) -> &'static str) -> Result<PathBuf, NoFolder> {
    if let Some(c) = chosen.filter(|c| c.is_dir()) {
        return Ok(c.to_owned());
    }
    match locate() {
        Ok(d) if d.is_dir() => Ok(d),
        Ok(_) => Err(NoFolder::NotYet),
        Err(e) => Err(NoFolder::Missing(code(e))),
    }
}

/// The folder chosen earlier, if one was kept in `config`.
pub fn load(config: &Path) -> Option<PathBuf> {
    let s = std::fs::read_to_string(config.join(CHOSEN_FILE)).ok()?;
    let p = PathBuf::from(s.trim_end_matches(['\r', '\n']));
    (p.is_absolute()).then_some(p)
}

/// Keep `dir` as the chosen folder (written whole, then renamed in).
pub fn save(config: &Path, dir: &Path) -> std::io::Result<()> {
    let s = dir.to_str().ok_or_else(|| std::io::Error::other("not unicode"))?;
    std::fs::create_dir_all(config)?;
    let tmp = config.join(format!("{CHOSEN_FILE}.tmp"));
    std::fs::write(&tmp, s)?;
    std::fs::rename(&tmp, config.join(CHOSEN_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn never() -> Result<PathBuf, &'static str> {
        panic!("Steam isn't asked while the chosen folder is there")
    }

    #[test]
    fn the_chosen_folder_wins_while_it_is_there() {
        let t = tempfile::tempdir().expect("tempdir");
        let chosen = t.path().join("mine");
        std::fs::create_dir(&chosen).expect("mkdir");
        assert_eq!(resolve(Some(&chosen), never, |e| e), Ok(chosen.clone()));
        // Gone (an unplugged drive): back to Deadlock's own.
        let steam = t.path().join("replays");
        std::fs::create_dir(&steam).expect("mkdir");
        assert_eq!(resolve(Some(&t.path().join("gone")), || Ok::<_, &str>(steam.clone()), |e| e), Ok(steam.clone()));
        assert_eq!(resolve(None, || Ok::<_, &str>(steam.clone()), |e| e), Ok(steam));
    }

    #[test]
    fn no_folder_says_why_without_a_path() {
        let t = tempfile::tempdir().expect("tempdir");
        assert_eq!(resolve(None, || Ok::<_, &str>(t.path().join("not-made")), |e| e), Err(NoFolder::NotYet));
        assert_eq!(resolve(None, || Err::<PathBuf, _>("no_steam"), |e| e), Err(NoFolder::Missing("no_steam")));
        assert_eq!(NoFolder::Missing("no_steam").code(), "not_found");
        assert_eq!(NoFolder::NotYet.reason(), "no_folder_yet");
    }

    #[test]
    fn the_choice_is_kept_and_read_back() {
        let t = tempfile::tempdir().expect("tempdir");
        let config = t.path().join("config");
        assert_eq!(load(&config), None);
        let dir = t.path().join("Steam Library").join("replays");
        save(&config, &dir).expect("save");
        assert_eq!(load(&config), Some(dir.clone()));
        let other = t.path().join("other");
        save(&config, &other).expect("save again");
        assert_eq!(load(&config), Some(other));
        // A relative path (a hand-edited file) isn't taken.
        std::fs::write(config.join(CHOSEN_FILE), "replays").expect("write");
        assert_eq!(load(&config), None);
    }
}
