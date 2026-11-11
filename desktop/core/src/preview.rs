//! A replay picker card's preview, read from the demo here (`mapcro_replay::preview`; spec §6b,
//! "The Windows app"): the signon and the match's last minute, a few MB, in a fraction of a
//! second. In a **child process**, as the parse is (`parse.rs` says why): the app runs its own
//! executable again with [`CHILD_ARG`]; the child prints the preview's JSON and exits 0, or prints
//! a reason code and exits 1.
//!
//! [`Cache`] keeps each file's preview by its size and time, on disk in the app's cache folder,
//! so listing the folder again (or another run of the app) reads no demo it has read before.
//!
//! Previews carry heroes and scores only: no names, no account ids.

use mapcro_replay::preview::Preview;
use mapcro_replay::reason;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The argument that makes the app's executable a preview child.
pub const CHILD_ARG: &str = "--mapcro-preview-replay";

/// The child is killed after this (129738985: ~0.2 s).
pub const TIMEOUT: Duration = Duration::from_secs(30);

/// A preview's JSON is under 1 KB; a child that says more isn't ours.
const MAX_OUT: u64 = 16 * 1024;

/// In the app's `main`: when started as a preview child, read the preview, print it, and return
/// the exit code. `args` is `std::env::args_os()`: `<exe> CHILD_ARG <demo> <match id>`.
pub fn child_main(args: &[OsString]) -> Option<i32> {
    if args.get(1).and_then(|a| a.to_str()) != Some(CHILD_ARG) {
        return None;
    }
    let (Some(demo), Some(id)) = (args.get(2), args.get(3).and_then(|a| a.to_str()?.parse::<u64>().ok())) else {
        return Some(2);
    };
    Some(match mapcro_replay::preview::read(Path::new(demo), id).and_then(|p| serde_json::to_string(&p).map_err(|_| reason::PARSE_FAILED)) {
        Ok(json) => {
            println!("{json}");
            0
        }
        Err(why) => {
            println!("{why}");
            1
        }
    })
}

/// Match `id`'s preview from the demo at `demo`, read in a child (`exe` with [`CHILD_ARG`]): the
/// preview, checked, or a reason code.
pub fn read(exe: &Path, demo: &Path, id: u64, timeout: Duration) -> Result<Preview, &'static str> {
    let mut cmd = Command::new(exe);
    cmd.arg(CHILD_ARG).arg(demo).arg(id.to_string()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    crate::parse::quiet(&mut cmd);
    let mut child = cmd.spawn().map_err(|_| reason::PARSE_FAILED)?;
    // Read while it runs, so a full pipe can't stall it.
    let out = child.stdout.take().ok_or(reason::PARSE_FAILED)?;
    let reader = std::thread::spawn(move || {
        let mut said = Vec::new();
        let _ = out.take(MAX_OUT + 1).read_to_end(&mut said);
        said
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(reason::TIMEOUT);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => return Err(reason::PARSE_FAILED),
        }
    };
    let said = reader.join().map_err(|_| reason::PARSE_FAILED)?;
    if !status.success() {
        let code = String::from_utf8_lossy(&said[..said.len().min(64)]).trim().to_owned();
        return Err(reason::ALL.iter().copied().find(|r| *r == code).unwrap_or(reason::PARSE_FAILED));
    }
    checked(&said, id)
}

/// The child's answer, if it's a preview of match `id` in the shape the page takes.
pub fn checked(json: &[u8], id: u64) -> Result<Preview, &'static str> {
    if json.len() as u64 > MAX_OUT {
        return Err(reason::PARSE_FAILED);
    }
    let p: Preview = serde_json::from_slice(json).map_err(|_| reason::PARSE_FAILED)?;
    let shaped = p.match_id == id && p.teams.len() == 2 && p.teams.iter().zip(["amber", "sapphire"]).all(|(t, name)| t.team == name && t.heroes.len() <= 12);
    let winner_ok = p.winner.as_deref().is_none_or(|w| w == "amber" || w == "sapphire");
    if shaped && winner_ok { Ok(p) } else { Err(reason::PARSE_FAILED) }
}

/// One file's preview, for the file as it was (size, time in ms), or why it has none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub size: u64,
    pub modified: u64,
    pub result: Result<Preview, String>,
    /// Insertion order, for dropping the oldest past [`Cache::MAX`].
    #[serde(default)]
    pub n: u64,
}

/// The previews read so far, by match id. A file whose size or time changed is read again.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Cache {
    entries: BTreeMap<String, Entry>,
    #[serde(default)]
    next: u64,
}

impl Cache {
    /// Entries kept (each under 1 KB).
    pub const MAX: usize = 2000;
    /// The cache file's name, in the app's cache folder.
    pub const FILE: &str = "previews.json";

    /// The cached answer for match `id`'s file at this size and time.
    pub fn get(&self, id: &str, size: u64, modified: u64) -> Option<&Result<Preview, String>> {
        self.entries.get(id).filter(|e| e.size == size && e.modified == modified).map(|e| &e.result)
    }

    /// Keep an answer. A timeout isn't kept (the machine may only have been busy).
    pub fn put(&mut self, id: &str, size: u64, modified: u64, result: Result<Preview, &'static str>) {
        if result == Err(reason::TIMEOUT) {
            return;
        }
        self.next += 1;
        self.entries.insert(id.to_owned(), Entry { size, modified, result: result.map_err(str::to_owned), n: self.next });
        while self.entries.len() > Self::MAX {
            let Some(oldest) = self.entries.iter().min_by_key(|(_, e)| e.n).map(|(k, _)| k.clone()) else { break };
            self.entries.remove(&oldest);
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The cache in `dir`, or an empty one (missing, unreadable or not ours).
    pub fn load(dir: &Path) -> Cache {
        let Ok(f) = std::fs::File::open(dir.join(Self::FILE)) else { return Cache::default() };
        let mut json = Vec::new();
        if f.take(8 << 20).read_to_end(&mut json).is_err() {
            return Cache::default();
        }
        serde_json::from_slice(&json).unwrap_or_default()
    }

    /// Write the cache to `dir` (a temporary file, then renamed over the old one).
    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join(format!("{}.{}.tmp", Self::FILE, std::process::id()));
        std::fs::write(&tmp, serde_json::to_vec(self).map_err(std::io::Error::other)?)?;
        std::fs::rename(&tmp, dir.join(Self::FILE))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mapcro_replay::preview::{EndPlayer, teams};

    fn preview(id: u64) -> Preview {
        let p = |index, team, hero_id| EndPlayer { index, team, hero_id, kills: 2, souls: 1000 };
        Preview { match_id: id, start_time: 0, duration_s: 1800, game_mode: 1, winner: Some("amber".into()), teams: teams(&[p(1, 2, 7), p(2, 3, 13)]), build: Some(6839) }
    }

    #[test]
    fn only_the_child_argument_makes_a_child() {
        let a = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(child_main(&a(&["app"])), None);
        assert_eq!(child_main(&a(&["app", crate::parse::CHILD_ARG, "d.dem", "o", "1"])), None);
        assert_eq!(child_main(&a(&["app", CHILD_ARG, "d.dem"])), Some(2));
        assert_eq!(child_main(&a(&["app", CHILD_ARG, "d.dem", "x"])), Some(2));
    }

    #[test]
    fn the_child_refuses_a_file_that_is_not_a_demo() {
        let t = tempfile::tempdir().expect("tempdir");
        let demo = t.path().join("1.dem");
        std::fs::write(&demo, b"not a demo at all, not at all").expect("write");
        let args: Vec<OsString> = vec!["app".into(), CHILD_ARG.into(), demo.into(), "1".into()];
        assert_eq!(child_main(&args), Some(1));
    }

    #[test]
    fn only_a_preview_of_this_match_in_the_pages_shape_is_taken() {
        let json = serde_json::to_vec(&preview(5)).expect("json");
        assert_eq!(checked(&json, 5), Ok(preview(5)));
        assert_eq!(checked(&json, 6), Err(reason::PARSE_FAILED));
        assert_eq!(checked(b"{\"not\":1}", 5), Err(reason::PARSE_FAILED));
        let mut p = preview(5);
        p.teams.swap(0, 1);
        assert_eq!(checked(&serde_json::to_vec(&p).expect("json"), 5), Err(reason::PARSE_FAILED));
        let p = Preview { winner: Some("red".into()), ..preview(5) };
        assert_eq!(checked(&serde_json::to_vec(&p).expect("json"), 5), Err(reason::PARSE_FAILED));
    }

    #[test]
    fn the_cache_holds_a_file_until_it_changes_and_survives_a_restart() {
        let t = tempfile::tempdir().expect("tempdir");
        let mut c = Cache::default();
        c.put("5", 100, 7, Ok(preview(5)));
        c.put("6", 200, 8, Err(reason::CORRUPT));
        c.put("7", 300, 9, Err(reason::TIMEOUT));
        assert_eq!(c.get("5", 100, 7), Some(&Ok(preview(5))));
        assert_eq!(c.get("5", 101, 7), None, "a size change is a new file");
        assert_eq!(c.get("5", 100, 8), None, "so is a time change");
        assert_eq!(c.get("6", 200, 8), Some(&Err("corrupt".to_owned())));
        assert_eq!(c.get("7", 300, 9), None, "a timeout isn't kept");
        c.save(t.path()).expect("save");
        let back = Cache::load(t.path());
        assert_eq!(back.get("5", 100, 7), Some(&Ok(preview(5))));
        assert_eq!(back.len(), 2);
        // Not ours: an empty cache.
        std::fs::write(t.path().join(Cache::FILE), b"[1,2").expect("write");
        assert!(Cache::load(t.path()).is_empty());
        assert!(Cache::load(&t.path().join("none")).is_empty());
    }

    #[test]
    fn the_cache_drops_the_oldest_past_its_cap() {
        let mut c = Cache::default();
        for i in 0..Cache::MAX as u64 + 3 {
            c.put(&i.to_string(), 1, 1, Err(reason::CORRUPT));
        }
        assert_eq!(c.len(), Cache::MAX);
        assert_eq!(c.get("0", 1, 1), None);
        assert_eq!(c.get("2", 1, 1), None);
        assert!(c.get("3", 1, 1).is_some());
    }

    /// The parent's side, with a stand-in child (a shell script).
    #[cfg(unix)]
    #[test]
    fn a_stand_in_childs_answers() {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().expect("tempdir");
        let child = |body: &str| {
            let p = t.path().join("child.sh");
            std::fs::write(&p, format!("#!/bin/sh\n[ \"$1\" = {CHILD_ARG} ] || exit 9\n{body}\n")).expect("script");
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            p
        };
        let demo = t.path().join("5.dem");
        let json = serde_json::to_string(&preview(5)).expect("json");
        assert_eq!(read(&child(&format!("echo '{json}'")), &demo, 5, TIMEOUT), Ok(preview(5)));
        assert_eq!(read(&child("echo corrupt; exit 1"), &demo, 5, TIMEOUT), Err(reason::CORRUPT));
        assert_eq!(read(&child("echo what; exit 1"), &demo, 5, TIMEOUT), Err(reason::PARSE_FAILED));
        assert_eq!(read(&child("exec sleep 30"), &demo, 5, Duration::from_millis(200)), Err(reason::TIMEOUT));
        // A child that won't stop talking is cut off and refused.
        assert_eq!(read(&child("yes"), &demo, 5, Duration::from_secs(5)), Err(reason::PARSE_FAILED));
    }
}
