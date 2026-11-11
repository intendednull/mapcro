//! The replays folder's `<match id>.dem` files (the same rules as the web's
//! `web/src/player/folder.ts`): only those names are looked at, and a name leaves here only as its
//! match id.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// A replay in the folder: its match id, when it was last written (ms since the epoch), its size.
/// Serialized as the web's `Replay` (`lastModified`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Replay {
    pub id: String,
    pub last_modified: u64,
    pub size: u64,
}

/// The match id a replay file's name is (the game names it `<match id>.dem`), leading zeros
/// dropped; nothing for any other name. A renamed copy (`123 (1).dem`) isn't the game's.
pub fn replay_id(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let digits = lower.strip_suffix(".dem")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let id = digits.trim_start_matches('0');
    // A match id is a u64; nothing longer is one.
    (!id.is_empty() && id.parse::<u64>().is_ok()).then(|| id.to_owned())
}

/// A match id as given by the page: digits only, no leading zero, a u64.
pub fn valid_id(id: &str) -> bool {
    replay_id(&format!("{id}.dem")).as_deref() == Some(id)
}

/// The path of match `id`'s replay in `dir`, for a valid id only (the page never gives a path).
pub fn demo_path(dir: &Path, id: &str) -> Option<PathBuf> {
    valid_id(id).then(|| dir.join(format!("{id}.dem")))
}

/// The folder's replays, newest first (the larger match id first on a tie). Only plain files with
/// a replay's name are looked at (their size and time); links and anything else are skipped.
pub fn list(dir: &Path) -> std::io::Result<Vec<Replay>> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir)? {
        let Ok(e) = e else { continue };
        let Some(id) = e.file_name().to_str().and_then(replay_id) else { continue };
        if !e.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let Ok(m) = e.metadata() else { continue };
        let last_modified = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
        out.push(Replay { id, last_modified, size: m.len() });
    }
    newest_first(&mut out);
    Ok(out)
}

/// Newest first, by when the file was written; the larger match id first on a tie.
pub fn newest_first(list: &mut [Replay]) {
    let key = |r: &Replay| (r.id.len(), r.id.clone());
    list.sort_by(|a, b| b.last_modified.cmp(&a.last_modified).then_with(|| key(b).cmp(&key(a))));
}

/// Does the file start as a Source 2 demo does (`PBDEMS2\0`)? A partly written file may not yet.
pub fn looks_like_demo(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 8];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && &head == mapcro_replay::DEM_MAGIC
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_games_names_are_replays() {
        assert_eq!(replay_id("129738985.dem").as_deref(), Some("129738985"));
        assert_eq!(replay_id("0129738985.DEM").as_deref(), Some("129738985"));
        for bad in ["129738985 (1).dem", "129738985.dem.part", "129738985.dem.bz2", "abc.dem", ".dem", "0.dem", "000.dem", "12-3.dem", "x129.dem", "99999999999999999999999.dem", "129738985", "desktop.ini"] {
            assert_eq!(replay_id(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_page_id_must_be_plain_digits() {
        assert!(valid_id("129738985"));
        for bad in ["", "0", "0129", "12a", "../1", "1/2", "1.dem", " 1"] {
            assert!(!valid_id(bad), "{bad:?}");
            assert_eq!(demo_path(Path::new("r"), bad), None);
        }
        assert_eq!(demo_path(Path::new("r"), "7"), Some(Path::new("r").join("7.dem")));
    }

    #[test]
    fn lists_replays_newest_first_and_nothing_else() {
        let t = tempfile::tempdir().expect("tempdir");
        let d = t.path();
        let at = |name: &str, secs: u64, bytes: &[u8]| {
            let p = d.join(name);
            std::fs::write(&p, bytes).expect("write");
            let f = std::fs::File::options().write(true).open(&p).expect("open");
            f.set_modified(UNIX_EPOCH + std::time::Duration::from_secs(secs)).expect("mtime");
        };
        at("100.dem", 1_000, b"a");
        at("300.dem", 3_000, b"abc");
        at("200.dem", 3_000, b"ab");
        at("notes.txt", 9_000, b"x");
        at("400 (1).dem", 9_000, b"x");
        std::fs::create_dir(d.join("500.dem")).expect("dir");
        let got = list(d).expect("list");
        let ids: Vec<_> = got.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["300", "200", "100"]);
        assert_eq!(got[0], Replay { id: "300".into(), last_modified: 3_000_000, size: 3 });
        let json = serde_json::to_string(&got[2]).expect("json");
        assert_eq!(json, r#"{"id":"100","lastModified":1000000,"size":1}"#);
        assert!(list(&d.join("missing")).is_err());
    }

    #[test]
    fn a_demo_starts_with_its_magic() {
        let t = tempfile::tempdir().expect("tempdir");
        let p = t.path().join("1.dem");
        std::fs::write(&p, b"PBDEMS2\0rest").expect("write");
        assert!(looks_like_demo(&p));
        std::fs::write(&p, b"PBDEM").expect("write");
        assert!(!looks_like_demo(&p));
        std::fs::write(&p, [0u8; 64]).expect("write");
        assert!(!looks_like_demo(&p));
        assert!(!looks_like_demo(&t.path().join("none.dem")));
    }
}
