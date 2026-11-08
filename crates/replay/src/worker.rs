//! The on-disk queue (spec §6a, "Replay worker"). The server and the worker share one directory
//! and nothing else, and neither can write where the other writes (security review
//! 2026-11-08, M1/M2):
//!
//! ```text
//! inbox/<job>.dem|.bz2|.zst   the server's: complete, magic-checked files. The worker can
//!                             only read it, and the server deletes a job's file when it
//!                             collects the job's result, so the demo goes when its parse ends
//! outbox/<job>.parsing        the worker's: the job it is on now
//! outbox/<job>.json           the timeline; the server checks it and caches it
//! outbox/<job>.failed         one reason code from `reason`
//! work/                       the worker's own scratch (a decompressed demo, a result being
//!                             written); the server never touches it
//! ```
//!
//! A job name is `<match id>-<scope>` (`[0-9a-z-]`, ≤ 64 bytes). Each job runs in a child process
//! (this binary, `job` mode) under a wall-clock timeout; the service's cgroup caps memory and
//! CPU, and a child killed by the kernel fails its job, not the worker.

use crate::reason;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

pub struct Limits {
    /// Wall clock per job, decompression and parse together.
    pub timeout: Duration,
    /// The largest `.dem` a compressed download may expand to.
    pub max_dem_bytes: u64,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { timeout: Duration::from_secs(300), max_dem_bytes: 1024 * 1024 * 1024 }
    }
}

pub use crate::{job_match_id as match_id, valid_job};

pub fn dirs(root: &Path) -> [PathBuf; 3] {
    ["inbox", "outbox", "work"].map(|d| root.join(d))
}

/// `<job>` and its extension, if `file` is a queued job.
fn job_of(file: &Path) -> Option<(String, String)> {
    let name = file.file_name()?.to_str()?;
    let (job, ext) = name.rsplit_once('.')?;
    (valid_job(job) && matches!(ext, "dem" | "bz2" | "zst")).then(|| (job.to_owned(), ext.to_owned()))
}

fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = dir.join(format!(".{name}.tmp"));
    let _ = std::fs::remove_file(&tmp);
    std::fs::write(&tmp, bytes)?;
    // The server reads results as a group member (umask 0077 would hide them).
    set_mode(&tmp, 0o640);
    std::fs::rename(&tmp, dir.join(name))
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}
#[cfg(not(unix))]
fn set_mode(_: &Path, _: u32) {}

fn fail(root: &Path, job: &str, why: &str) {
    let _ = write_atomic(&root.join("outbox"), &format!("{job}.failed"), why.as_bytes());
}

/// Whether `job` has a result waiting in the outbox (the server hasn't collected it yet).
fn finished(root: &Path, job: &str) -> bool {
    let out = root.join("outbox");
    out.join(format!("{job}.json")).exists() || out.join(format!("{job}.failed")).exists()
}

/// The oldest queued job with no result yet, and not tried in this run.
fn next(root: &Path, tried: &HashSet<String>) -> Option<PathBuf> {
    let mut jobs: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(root.join("inbox"))
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.path())
        .filter(|p| job_of(p).is_some_and(|(j, _)| !tried.contains(&j) && !finished(root, &j)))
        .map(|p| (std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH), p))
        .collect();
    jobs.sort();
    jobs.into_iter().next().map(|(_, p)| p)
}

/// After a crash: the job it was on fails, and its scratch files go.
pub fn recover(root: &Path) {
    if let Ok(rd) = std::fs::read_dir(root.join("outbox")) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(job) = name.strip_suffix(".parsing") {
                if valid_job(job) && !finished(root, job) {
                    fail(root, job, reason::PARSE_FAILED);
                }
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    if let Ok(rd) = std::fs::read_dir(root.join("work")) {
        for e in rd.flatten() {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Run one queued job to a result. Returns false when nothing is waiting.
pub fn run_one(root: &Path, exe: &Path, limits: &Limits, tried: &mut HashSet<String>) -> bool {
    let Some(src) = next(root, tried) else { return false };
    let Some((job, _)) = job_of(&src) else { return false };
    tried.insert(job.clone());
    let marker = root.join("outbox").join(format!("{job}.parsing"));
    let _ = std::fs::write(&marker, b"");
    set_mode(&marker, 0o640);
    let out = root.join("work").join(format!("{job}.json"));
    let started = Instant::now();
    let result = run_child(exe, &src, &out, match_id(&job), limits);
    // The expanded copy goes now; the server deletes the original when it collects the result.
    let _ = std::fs::remove_file(out.with_extension("dem"));
    match result {
        Ok(()) => {
            set_mode(&out, 0o640);
            if std::fs::rename(&out, root.join("outbox").join(format!("{job}.json"))).is_err() {
                fail(root, &job, reason::PARSE_FAILED);
            }
            eprintln!("mapcro-replay: {job} done in {:.1} s", started.elapsed().as_secs_f64());
        }
        Err(why) => {
            fail(root, &job, why);
            eprintln!("mapcro-replay: {job} failed ({why}) after {:.1} s", started.elapsed().as_secs_f64());
        }
    }
    let _ = std::fs::remove_file(&out);
    let _ = std::fs::remove_file(&marker);
    true
}

/// SIGBUS: the memory-mapped demo changed or shrank under the parser.
const SIGBUS: i32 = 7;

fn run_child(exe: &Path, input: &Path, out: &Path, match_id: u64, limits: &Limits) -> Result<(), &'static str> {
    let mut child = Command::new(exe)
        .arg("job")
        .arg(input)
        .arg(out)
        .arg(match_id.to_string())
        .arg(limits.max_dem_bytes.to_string())
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| reason::PARSE_FAILED)?;
    let deadline = Instant::now() + limits.timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(reason::TIMEOUT);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => return Err(reason::PARSE_FAILED),
        }
    };
    let mut said = String::new();
    if let Some(mut o) = child.stdout.take() {
        let _ = o.by_ref().take(64).read_to_string(&mut said);
    }
    if status.success() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        match status.signal() {
            // A demo that changed or shrank while mapped (security review 2026-11-08, L5).
            Some(SIGBUS) => return Err(reason::CORRUPT),
            // Otherwise the kernel killed it: the cgroup's memory cap.
            Some(_) => return Err(reason::TOO_LARGE),
            None => {}
        }
    }
    Err(reason::ALL.iter().copied().find(|r| *r == said.trim()).unwrap_or(reason::PARSE_FAILED))
}

/// `job` mode, in the child: decompress if needed, parse, derive, write the timeline.
pub fn job(input: &Path, out: &Path, match_id: u64, max_dem_bytes: u64) -> Result<(), &'static str> {
    let dem = expand(input, &out.with_extension("dem"), max_dem_bytes)?;
    let obs = crate::parse::observe(&dem, match_id)?;
    let t = crate::derive::derive(&obs, crate::map::current()).map_err(|e| match e {
        crate::derive::Refused::OldMap => reason::OLD_MAP,
        crate::derive::Refused::Empty => reason::NOT_A_REPLAY,
    })?;
    let bytes = serde_json::to_vec(&t).map_err(|_| reason::PARSE_FAILED)?;
    if bytes.len() as u64 > crate::timeline::MAX_BYTES {
        return Err(reason::TOO_LARGE);
    }
    std::fs::write(out, bytes).map_err(|_| reason::PARSE_FAILED)
}

/// A `.dem` path for `input`: itself, or a streamed, capped decompression to `scratch`.
fn expand(input: &Path, scratch: &Path, max: u64) -> Result<PathBuf, &'static str> {
    let mut head = [0u8; 8];
    let mut f = std::fs::File::open(input).map_err(|_| reason::PARSE_FAILED)?;
    let n = f.read(&mut head).map_err(|_| reason::PARSE_FAILED)?;
    let head = &head[..n];
    if head == crate::DEM_MAGIC {
        return Ok(input.to_owned());
    }
    let f = std::fs::File::open(input).map_err(|_| reason::PARSE_FAILED)?;
    let reader: Box<dyn Read> = if crate::is_bz2(head) {
        Box::new(bzip2::read::MultiBzDecoder::new(std::io::BufReader::new(f)))
    } else if head.starts_with(crate::ZSTD_MAGIC) {
        let mut d = zstd::stream::read::Decoder::new(f).map_err(|_| reason::NOT_A_REPLAY)?;
        // zstd's default limit (128 MiB): the decoder's memory stays inside the job's budget.
        d.window_log_max(27).map_err(|_| reason::PARSE_FAILED)?;
        Box::new(d)
    } else {
        return Err(reason::NOT_A_REPLAY);
    };
    let dem = scratch.to_owned();
    let mut out = std::fs::File::create(&dem).map_err(|_| reason::PARSE_FAILED)?;
    let copied = std::io::copy(&mut reader.take(max + 1), &mut out).map_err(|_| reason::NOT_A_REPLAY)?;
    out.flush().map_err(|_| reason::PARSE_FAILED)?;
    if copied > max {
        let _ = std::fs::remove_file(&dem);
        return Err(reason::TOO_LARGE);
    }
    Ok(dem)
}

/// `work` mode: the service. Polls the inbox; `once` stops when it's empty (tests).
pub fn serve(root: &Path, limits: &Limits, once: bool) -> std::io::Result<()> {
    for d in dirs(root) {
        if !d.is_dir() {
            return Err(std::io::Error::other(format!("{} is not a directory", d.display())));
        }
    }
    let exe = std::env::current_exe()?;
    recover(root);
    let mut tried = HashSet::new();
    loop {
        // Jobs the server has collected leave the inbox; forget them.
        tried.retain(|j: &String| ["dem", "bz2", "zst"].iter().any(|e| root.join("inbox").join(format!("{j}.{e}")).exists()));
        if !run_one(root, &exe, limits, &mut tried) {
            if once {
                return Ok(());
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_names() {
        assert!(valid_job("122134063-cdn"));
        assert!(valid_job("122134063-0123456789abcdef"));
        for bad in ["", "-cdn", "abc-cdn", "1/2-cdn", "1.dem", "1-A", &format!("1-{}", "a".repeat(64))] {
            assert!(!valid_job(bad), "{bad}");
        }
        assert_eq!(match_id("122134063-cdn"), 122134063);
        assert_eq!(job_of(Path::new("/x/inbox/5-cdn.bz2")), Some(("5-cdn".into(), "bz2".into())));
        assert_eq!(job_of(Path::new("/x/inbox/.5-cdn.part")), None);
        assert_eq!(job_of(Path::new("/x/inbox/5-cdn.exe")), None);
    }

    #[test]
    fn compressed_inputs_expand_under_a_cap() {
        let dir = tempfile::tempdir().expect("dir");
        let body: Vec<u8> = crate::DEM_MAGIC.iter().copied().chain(std::iter::repeat_n(7u8, 10_000)).collect();
        let bz = dir.path().join("1-a.bz2");
        let mut enc = bzip2::write::BzEncoder::new(std::fs::File::create(&bz).expect("f"), bzip2::Compression::fast());
        enc.write_all(&body).expect("w");
        enc.finish().expect("finish");
        let scratch = dir.path().join("x.dem");
        let dem = expand(&bz, &scratch, 1 << 20).expect("expands");
        assert_eq!(std::fs::read(&dem).expect("read"), body);
        assert_eq!(expand(&bz, &scratch, 1000), Err(reason::TOO_LARGE));
        assert!(!scratch.exists(), "a capped expansion leaves nothing behind");

        let zst = dir.path().join("2-a.zst");
        std::fs::write(&zst, zstd::encode_all(&body[..], 3).expect("zstd")).expect("w");
        assert_eq!(std::fs::read(expand(&zst, &scratch, 1 << 20).expect("expands")).expect("read"), body);

        let junk = dir.path().join("3-a.dem");
        std::fs::write(&junk, b"MZ\x90\0not a demo").expect("w");
        assert_eq!(expand(&junk, &scratch, 1 << 20), Err(reason::NOT_A_REPLAY));
    }

    /// A child killed by SIGBUS (a demo changed under its memory map) is `corrupt`; one killed
    /// otherwise (the memory cap) is `too_large` (security review 2026-11-08, L5).
    #[cfg(unix)]
    #[test]
    fn a_child_killed_by_a_signal_says_why() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("dir");
        let script = |name: &str, sig: &str| {
            let p = dir.path().join(name);
            std::fs::write(&p, format!("#!/bin/sh\nkill -{sig} $$\n")).expect("script");
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            p
        };
        let (input, out) = (dir.path().join("1-a.dem"), dir.path().join("1-a.json"));
        let limits = Limits::default();
        assert_eq!(run_child(&script("bus", "BUS"), &input, &out, 1, &limits), Err(reason::CORRUPT));
        assert_eq!(run_child(&script("kill", "KILL"), &input, &out, 1, &limits), Err(reason::TOO_LARGE));
    }
}
