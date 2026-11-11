//! Where Deadlock's replays folder is, opening only what that takes (desktop/README.md, Privacy):
//!
//! 1. The Steam root: `steamlocate::locate_all`, which reads the registry key on Windows
//!    (`HKLM\SOFTWARE\Wow6432Node\Valve\Steam` `InstallPath`) and tests a fixed set of candidate
//!    paths on Linux with `is_dir`. It lists nothing.
//! 2. `<root>/steamapps/libraryfolders.vdf`: its `apps` map names the library that has Deadlock.
//! 3. That library's `steamapps/appmanifest_1422450.acf`, for `installdir`.
//! 4. `<library>/steamapps/common/<installdir>/game/citadel/replays`.
//!
//! Not `SteamDir::find_app`: it builds each `Library` with `read_dir` of its `steamapps`, which
//! lists every installed game's manifest (steamlocate 2.1.1 `library.rs` `Library::from_dir`).

use crate::vdf::{self, Kv};
use std::path::{Path, PathBuf};

/// Deadlock's Steam app id.
pub const DEADLOCK: u32 = 1_422_450;

/// Neither file is anywhere near this; a bigger one isn't Steam's.
const MAX_FILE_BYTES: u64 = 1 << 20;

/// Why the replays folder wasn't found. Carries no path (it's shown and logged).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Missing {
    /// No Steam install found.
    NoSteam,
    /// `libraryfolders.vdf` couldn't be read or parsed.
    NoLibraries,
    /// No library lists Deadlock, and none has its manifest.
    NotInstalled,
    /// The manifest couldn't be read, or its `installdir` isn't one plain folder name.
    BadManifest,
}

impl Missing {
    pub fn code(self) -> &'static str {
        match self {
            Missing::NoSteam => "no_steam",
            Missing::NoLibraries => "no_libraries",
            Missing::NotInstalled => "not_installed",
            Missing::BadManifest => "bad_manifest",
        }
    }
}

/// The replays folder under the first Steam root that has Deadlock. The folder itself may not
/// exist yet (the game makes it on the first download).
pub fn locate() -> Result<PathBuf, Missing> {
    let roots = steamlocate::locate_all().map_err(|_| Missing::NoSteam)?;
    let mut last = Missing::NoSteam;
    for root in roots {
        match replays_in(root.path()) {
            Ok(p) => return Ok(p),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// The replays folder for the Steam install at `root`.
pub fn replays_in(root: &Path) -> Result<PathBuf, Missing> {
    let vdf = read_small(&root.join("steamapps").join("libraryfolders.vdf")).ok_or(Missing::NoLibraries)?;
    let libs = libraries(&vdf).ok_or(Missing::NoLibraries)?;
    // The library whose `apps` lists Deadlock; else (a stale vdf) the first whose manifest exists,
    // tested by name rather than by listing the folder.
    let lib = libs
        .iter()
        .find(|l| l.has_deadlock)
        .map(|l| l.path.clone())
        .or_else(|| libs.iter().map(|l| l.path.clone()).find(|p| manifest_path(p).is_file()))
        .ok_or(Missing::NotInstalled)?;
    let acf = read_small(&manifest_path(&lib)).ok_or(Missing::BadManifest)?;
    let dir = install_dir(&acf).ok_or(Missing::BadManifest)?;
    Ok(lib.join("steamapps").join("common").join(dir).join("game").join("citadel").join("replays"))
}

fn manifest_path(lib: &Path) -> PathBuf {
    lib.join("steamapps").join(format!("appmanifest_{DEADLOCK}.acf"))
}

fn read_small(p: &Path) -> Option<String> {
    use std::io::Read;
    let f = std::fs::File::open(p).ok()?;
    let mut s = String::new();
    f.take(MAX_FILE_BYTES + 1).read_to_string(&mut s).ok()?;
    (s.len() as u64 <= MAX_FILE_BYTES).then_some(s)
}

/// A library from `libraryfolders.vdf`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Library {
    pub path: PathBuf,
    /// Its `apps` map has Deadlock.
    pub has_deadlock: bool,
}

/// The libraries `libraryfolders.vdf` lists, in its order. Also takes the old layout, where a
/// numbered key's value is the path itself.
pub fn libraries(src: &str) -> Option<Vec<Library>> {
    let (root, v) = vdf::parse(src)?;
    if !root.eq_ignore_ascii_case("libraryfolders") {
        return None;
    }
    let id = DEADLOCK.to_string();
    let out: Vec<Library> = v
        .pairs()
        .iter()
        .filter(|(k, _)| k.bytes().all(|b| b.is_ascii_digit()))
        .filter_map(|(_, lib)| match lib {
            Kv::Str(p) => Some(Library { path: PathBuf::from(p), has_deadlock: false }),
            Kv::Obj(_) => {
                let path = lib.get("path")?.str()?;
                let has_deadlock = lib.get("apps").is_some_and(|a| a.get(&id).is_some());
                Some(Library { path: PathBuf::from(path), has_deadlock })
            }
        })
        .filter(|l| !l.path.as_os_str().is_empty())
        .collect();
    Some(out)
}

/// The manifest's `installdir`, when it is one plain folder name (never a path out of
/// `common`).
pub fn install_dir(src: &str) -> Option<String> {
    let (root, v) = vdf::parse(src)?;
    if !root.eq_ignore_ascii_case("AppState") {
        return None;
    }
    let dir = v.get("installdir")?.str()?;
    let plain = !dir.is_empty() && dir != "." && dir != ".." && !dir.contains(['/', '\\', ':', '\0']);
    plain.then(|| dir.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Steam's current layout (fixture written for this test, shaped like a real file; the ids
    // other than Deadlock's are arbitrary).
    const LIBRARYFOLDERS: &str = r#""libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"label"		""
		"contentid"		"1"
		"totalsize"		"0"
		"update_clean_bytes_tally"		"0"
		"time_last_update_verified"		"0"
		"apps"
		{
			"228980"		"1"
		}
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
		"label"		""
		"contentid"		"2"
		"totalsize"		"1"
		"apps"
		{
			"1422450"		"1"
		}
	}
}
"#;

    const MANIFEST: &str = r#""AppState"
{
	"appid"		"1422450"
	"universe"		"1"
	"name"		"Deadlock"
	"StateFlags"		"4"
	"installdir"		"Deadlock"
	"InstalledDepots"
	{
		"1422456"
		{
			"manifest"		"1"
			"size"		"1"
		}
	}
}
"#;

    #[test]
    fn libraryfolders_names_the_library_with_deadlock() {
        let libs = libraries(LIBRARYFOLDERS).expect("parses");
        assert_eq!(
            libs,
            vec![
                Library { path: PathBuf::from(r"C:\Program Files (x86)\Steam"), has_deadlock: false },
                Library { path: PathBuf::from(r"D:\SteamLibrary"), has_deadlock: true },
            ]
        );
    }

    #[test]
    fn the_old_libraryfolders_layout_and_other_roots() {
        let old = "\"LibraryFolders\"\n{\n\t\"TimeNextStatsReport\"\t\"1\"\n\t\"ContentStatsID\"\t\"2\"\n\t\"1\"\t\"/mnt/games/steam\"\n}\n";
        assert_eq!(libraries(old), Some(vec![Library { path: PathBuf::from("/mnt/games/steam"), has_deadlock: false }]));
        assert_eq!(libraries(MANIFEST), None);
        assert_eq!(libraries("not vdf {"), None);
    }

    #[test]
    fn manifest_gives_a_plain_install_dir_only() {
        assert_eq!(install_dir(MANIFEST).as_deref(), Some("Deadlock"));
        for bad in ["..", "../..", "a/b", r"a\b", "C:x", ""] {
            let src = MANIFEST.replace("\"installdir\"\t\t\"Deadlock\"", &format!("\"installdir\" \"{}\"", bad.replace('\\', "\\\\")));
            assert_eq!(install_dir(&src), None, "{bad:?}");
        }
        assert_eq!(install_dir(LIBRARYFOLDERS), None);
    }

    /// A Steam root and a second library on disk, as the two files describe them.
    fn steam_with_deadlock_in_second_library(listed: bool) -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::tempdir().expect("tempdir");
        let root = t.path().join("Steam");
        let lib = t.path().join("Library");
        std::fs::create_dir_all(root.join("steamapps")).expect("root");
        std::fs::create_dir_all(lib.join("steamapps")).expect("lib");
        let apps = if listed { format!("\"apps\" {{ \"{DEADLOCK}\" \"1\" }}") } else { String::new() };
        let vdf = format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" \"apps\" {{ \"228980\" \"1\" }} }} \"1\" {{ \"path\" \"{}\" {apps} }} }}",
            esc(&root),
            esc(&lib)
        );
        std::fs::write(root.join("steamapps/libraryfolders.vdf"), vdf).expect("vdf");
        std::fs::write(lib.join(format!("steamapps/appmanifest_{DEADLOCK}.acf")), MANIFEST).expect("acf");
        (t, lib)
    }
    fn esc(p: &Path) -> String {
        p.display().to_string().replace('\\', "\\\\")
    }

    #[test]
    fn finds_the_replays_folder_from_the_two_files() {
        for listed in [true, false] {
            let (t, lib) = steam_with_deadlock_in_second_library(listed);
            let got = replays_in(&t.path().join("Steam")).expect("found");
            assert_eq!(got, lib.join("steamapps/common/Deadlock/game/citadel/replays"), "listed: {listed}");
        }
    }

    #[test]
    fn says_what_is_missing() {
        let t = tempfile::tempdir().expect("tempdir");
        assert_eq!(replays_in(t.path()), Err(Missing::NoLibraries));
        std::fs::create_dir_all(t.path().join("steamapps")).expect("dir");
        let vdf = format!("\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}", esc(t.path()));
        std::fs::write(t.path().join("steamapps/libraryfolders.vdf"), &vdf).expect("vdf");
        assert_eq!(replays_in(t.path()), Err(Missing::NotInstalled));
        std::fs::write(manifest_path(t.path()), "\"AppState\" { \"installdir\" \"..\" }").expect("acf");
        assert_eq!(replays_in(t.path()), Err(Missing::BadManifest));
    }
}
