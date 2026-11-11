//! A demo to a gzip timeline, parsed by `crates/replay` in a **child process**: the app runs its
//! own executable again with [`CHILD_ARG`]. A separate process, not a thread, because:
//!
//! - a panic, an abort or a stack overflow in the parser on a bad demo ends the child, not the
//!   shell and its tray;
//! - a process can be killed at the time limit; a thread can't be stopped;
//! - the memory the parser maps and allocates goes back to the system when it exits (and a
//!   per-process cap is possible later: a Windows Job object; backlog).
//!
//! The protocol is the worker's (`crates/replay/src/worker.rs`): the child writes the timeline
//! JSON to the out path and exits 0, or prints its reason code (`old_map`, `brawl`, …) and exits
//! 1. The parent checks the timeline (`timeline::validate`, as the server will) and gzips it.

use mapcro_replay::{reason, timeline};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The argument that makes the app's executable a parse child.
pub const CHILD_ARG: &str = "--mapcro-parse-replay";

/// A demo bigger than this isn't parsed (the worker's default, `worker::Limits`).
pub const MAX_DEM_BYTES: u64 = 1 << 30;

/// The child is killed after this (the 504 MB reference replay takes ~5 s on one core).
pub const TIMEOUT: Duration = Duration::from_secs(300);

/// In the app's `main`, before anything else: when started as a parse child, parse and return
/// the exit code. `args` is `std::env::args_os()`.
pub fn child_main(args: &[OsString]) -> Option<i32> {
    if args.get(1).and_then(|a| a.to_str()) != Some(CHILD_ARG) {
        return None;
    }
    let (Some(demo), Some(out), Some(id)) = (args.get(2), args.get(3), args.get(4).and_then(|a| a.to_str()?.parse::<u64>().ok())) else {
        return Some(2);
    };
    Some(match mapcro_replay::worker::job(Path::new(demo), Path::new(out), id, MAX_DEM_BYTES) {
        Ok(()) => 0,
        Err(why) => {
            println!("{why}");
            1
        }
    })
}

/// Parse match `id`'s demo at `demo` in a child (`exe` with [`CHILD_ARG`]), using `scratch` for
/// its output; the timeline, checked and gzipped, or a reason code.
pub fn parse(exe: &Path, demo: &Path, id: u64, scratch: &Path, timeout: Duration) -> Result<Vec<u8>, &'static str> {
    let len = std::fs::metadata(demo).map_err(|_| reason::PARSE_FAILED)?.len();
    if len > MAX_DEM_BYTES {
        return Err(reason::TOO_LARGE);
    }
    std::fs::create_dir_all(scratch).map_err(|_| reason::PARSE_FAILED)?;
    let out = scratch.join(format!("{id}-{}.json", std::process::id()));
    let _ = std::fs::remove_file(&out);
    let result = run_child(exe, demo, &out, id, timeout).and_then(|()| read_timeline(&out, id));
    let _ = std::fs::remove_file(&out);
    let _ = std::fs::remove_file(out.with_extension("dem"));
    result.and_then(|json| gzip(&json))
}

fn run_child(exe: &Path, demo: &Path, out: &Path, id: u64, timeout: Duration) -> Result<(), &'static str> {
    let mut cmd = Command::new(exe);
    cmd.arg(CHILD_ARG).arg(demo).arg(out).arg(id.to_string()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    quiet(&mut cmd);
    let mut child = cmd.spawn().map_err(|_| reason::PARSE_FAILED)?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(reason::TIMEOUT);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return Err(reason::PARSE_FAILED),
        }
    };
    let mut said = String::new();
    if let Some(o) = child.stdout.take() {
        let _ = o.take(64).read_to_string(&mut said);
    }
    if status.success() {
        return Ok(());
    }
    Err(reason::ALL.iter().copied().find(|r| *r == said.trim()).unwrap_or(reason::PARSE_FAILED))
}

/// A child of the app's: no console window, and (Windows) below-normal priority, so a game in
/// progress isn't slowed.
pub(crate) fn quiet(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn read_timeline(out: &Path, id: u64) -> Result<Vec<u8>, &'static str> {
    let f = std::fs::File::open(out).map_err(|_| reason::PARSE_FAILED)?;
    let mut json = Vec::new();
    f.take(timeline::MAX_BYTES + 1).read_to_end(&mut json).map_err(|_| reason::PARSE_FAILED)?;
    if json.len() as u64 > timeline::MAX_BYTES {
        return Err(reason::TOO_LARGE);
    }
    let tl = timeline::validate(&json).map_err(|_| reason::PARSE_FAILED)?;
    if tl.match_id != id {
        return Err(reason::PARSE_FAILED);
    }
    Ok(json)
}

/// Gzip, as the upload sends it (`content-encoding: gzip`).
pub fn gzip(bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
    let mut e = flate2::write::GzEncoder::new(Vec::with_capacity(bytes.len() / 3), flate2::Compression::default());
    e.write_all(bytes).map_err(|_| reason::PARSE_FAILED)?;
    e.finish().map_err(|_| reason::PARSE_FAILED)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_child_argument_makes_a_child() {
        let a = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(child_main(&a(&["app"])), None);
        assert_eq!(child_main(&a(&["app", "--other"])), None);
        assert_eq!(child_main(&a(&["app", CHILD_ARG, "d.dem"])), Some(2));
        assert_eq!(child_main(&a(&["app", CHILD_ARG, "d.dem", "o.json", "x"])), Some(2));
    }

    #[test]
    fn the_child_refuses_a_file_that_is_not_a_demo() {
        let t = tempfile::tempdir().expect("tempdir");
        let demo = t.path().join("1.dem");
        std::fs::write(&demo, b"not a demo at all").expect("write");
        let out = t.path().join("o.json");
        let args: Vec<OsString> = vec!["app".into(), CHILD_ARG.into(), demo.into(), out.clone().into(), "1".into()];
        assert_eq!(child_main(&args), Some(1));
        assert!(!out.exists());
    }

    #[test]
    fn gzip_round_trips() {
        use std::io::Read;
        let z = gzip(b"{\"a\":1}").expect("gzip");
        assert_eq!(&z[..2], &[0x1f, 0x8b]);
        let mut back = String::new();
        flate2::read::GzDecoder::new(&z[..]).read_to_string(&mut back).expect("gunzip");
        assert_eq!(back, "{\"a\":1}");
    }

    /// The parent's side of the protocol, with a stand-in child (a shell script).
    #[cfg(unix)]
    mod with_a_stand_in_child {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn child(dir: &Path, body: &str) -> std::path::PathBuf {
            let p = dir.join("child.sh");
            // $1 is CHILD_ARG, $2 the demo, $3 the out path, $4 the match id.
            std::fs::write(&p, format!("#!/bin/sh\n[ \"$1\" = {CHILD_ARG} ] || exit 9\n{body}\n")).expect("script");
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            p
        }
        fn demo(dir: &Path) -> std::path::PathBuf {
            let p = dir.join("5.dem");
            std::fs::write(&p, b"PBDEMS2\0").expect("demo");
            p
        }

        #[test]
        fn a_reason_from_the_child_comes_back() {
            let t = tempfile::tempdir().expect("tempdir");
            let exe = child(t.path(), "echo brawl; exit 1");
            assert_eq!(parse(&exe, &demo(t.path()), 5, &t.path().join("s"), TIMEOUT), Err(reason::BRAWL));
            let exe = child(t.path(), "echo something else; exit 1");
            assert_eq!(parse(&exe, &demo(t.path()), 5, &t.path().join("s"), TIMEOUT), Err(reason::PARSE_FAILED));
            // Killed (as a crash would end it): no reason, parse_failed.
            let exe = child(t.path(), "kill -9 $$");
            assert_eq!(parse(&exe, &demo(t.path()), 5, &t.path().join("s"), TIMEOUT), Err(reason::PARSE_FAILED));
        }

        #[test]
        fn a_child_past_the_time_limit_is_killed() {
            let t = tempfile::tempdir().expect("tempdir");
            let exe = child(t.path(), "exec sleep 30");
            let started = Instant::now();
            assert_eq!(parse(&exe, &demo(t.path()), 5, &t.path().join("s"), Duration::from_millis(300)), Err(reason::TIMEOUT));
            assert!(started.elapsed() < Duration::from_secs(10));
        }

        #[test]
        fn output_that_is_not_a_timeline_for_this_match_is_refused() {
            let t = tempfile::tempdir().expect("tempdir");
            let exe = child(t.path(), "echo '{\"not\":\"a timeline\"}' > \"$3\"");
            assert_eq!(parse(&exe, &demo(t.path()), 5, &t.path().join("s"), TIMEOUT), Err(reason::PARSE_FAILED));
            // Nothing left behind in the scratch folder.
            assert_eq!(std::fs::read_dir(t.path().join("s")).expect("scratch").count(), 0);
        }
    }
}
