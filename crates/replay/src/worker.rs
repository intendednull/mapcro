//! The on-disk queue (spec §6a, "Replay worker"). The server and the worker share one directory
//! and nothing else:
//!
//! ```text
//! inbox/<job>.dem|.bz2|.zst   the server renames a complete, magic-checked file in
//! work/<job>.*                one job at a time; deleted when its parse ends, either way
//! done/<job>.json             the timeline; the server checks it and moves it to its cache
//! failed/<job>                one reason code from `reason`
//! ```
//!
//! A job name is `<match id>-<scope>` (`[0-9a-z-]`, ≤ 64 bytes). Each job runs in a child process
//! (this binary, `job` mode) under a wall-clock timeout; the service's cgroup caps memory and
//! CPU, and a child killed by the kernel fails its job, not the worker.

use crate::reason;
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

pub fn valid_job(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || b == b'-')
        && name.split('-').next().is_some_and(|m| !m.is_empty() && m.len() <= 12 && m.bytes().all(|b| b.is_ascii_digit()))
}

pub fn match_id(job: &str) -> u64 {
    job.split('-').next().and_then(|m| m.parse().ok()).unwrap_or(0)
}

pub fn dirs(root: &Path) -> [PathBuf; 4] {
    ["inbox", "work", "done", "failed"].map(|d| root.join(d))
}

/// `<job>` and its extension, if `file` is a queued job.
fn job_of(file: &Path) -> Option<(String, String)> {
    let name = file.file_name()?.to_str()?;
    let (job, ext) = name.rsplit_once('.')?;
    (valid_job(job) && matches!(ext, "dem" | "bz2" | "zst")).then(|| (job.to_owned(), ext.to_owned()))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    // The server reads results as a group member (umask 0077 would hide them).
    set_mode(&tmp, 0o640);
    std::fs::rename(&tmp, path)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}
#[cfg(not(unix))]
fn set_mode(_: &Path, _: u32) {}

fn fail(root: &Path, job: &str, why: &str) {
    let _ = write_atomic(&root.join("failed").join(job), why.as_bytes());
}

/// The oldest queued job.
fn next(root: &Path) -> Option<PathBuf> {
    let mut jobs: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(root.join("inbox"))
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.path())
        .filter(|p| job_of(p).is_some())
        .map(|p| (std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH), p))
        .collect();
    jobs.sort();
    jobs.into_iter().next().map(|(_, p)| p)
}

/// Jobs left in `work/` by a worker that died mid-parse fail, and their files go.
pub fn recover(root: &Path) {
    let Ok(rd) = std::fs::read_dir(root.join("work")) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if let Some((job, _)) = p.file_name().and_then(|f| f.to_str()).and_then(|f| f.split_once('.')).map(|(j, e)| (j.to_owned(), e.to_owned()))
            && valid_job(&job)
            && !root.join("done").join(format!("{job}.json")).exists()
        {
            fail(root, &job, reason::PARSE_FAILED);
        }
        let _ = std::fs::remove_file(&p);
    }
}

/// Run one queued job to done or failed. Returns false when the inbox is empty.
pub fn run_one(root: &Path, exe: &Path, limits: &Limits) -> bool {
    let Some(src) = next(root) else { return false };
    let Some((job, ext)) = job_of(&src) else { return false };
    let work = root.join("work").join(format!("{job}.{ext}"));
    if std::fs::rename(&src, &work).is_err() {
        // Gone (the server cleaned it up) or unreadable: drop it and move on.
        let _ = std::fs::remove_file(&src);
        return true;
    }
    let out = root.join("work").join(format!("{job}.json"));
    let started = Instant::now();
    let result = run_child(exe, &work, &out, match_id(&job), limits);
    // The demo goes as soon as the parse ends, whatever the outcome.
    let _ = std::fs::remove_file(&work);
    let _ = std::fs::remove_file(work.with_extension("dem"));
    match result {
        Ok(()) => {
            let done = root.join("done").join(format!("{job}.json"));
            set_mode(&out, 0o640);
            if std::fs::rename(&out, &done).is_err() {
                fail(root, &job, reason::PARSE_FAILED);
            }
            eprintln!("mapcro-replay: {job} done in {:.1} s", started.elapsed().as_secs_f64());
        }
        Err(why) => {
            let _ = std::fs::remove_file(&out);
            fail(root, &job, why);
            eprintln!("mapcro-replay: {job} failed ({why}) after {:.1} s", started.elapsed().as_secs_f64());
        }
    }
    true
}

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
    // A child the kernel killed (the cgroup's memory cap) says nothing.
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if status.signal().is_some() {
            return Err(reason::TOO_LARGE);
        }
    }
    Err(reason::ALL.iter().copied().find(|r| *r == said.trim()).unwrap_or(reason::PARSE_FAILED))
}

/// `job` mode, in the child: decompress if needed, parse, derive, write the timeline.
pub fn job(input: &Path, out: &Path, match_id: u64, max_dem_bytes: u64) -> Result<(), &'static str> {
    let dem = expand(input, max_dem_bytes)?;
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

/// A `.dem` path for `input`: itself, or a streamed, capped decompression next to it.
fn expand(input: &Path, max: u64) -> Result<PathBuf, &'static str> {
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
    let dem = input.with_extension("dem");
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
    loop {
        if !run_one(root, &exe, limits) {
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
        let dem = expand(&bz, 1 << 20).expect("expands");
        assert_eq!(std::fs::read(&dem).expect("read"), body);
        assert_eq!(expand(&bz, 1000), Err(reason::TOO_LARGE));
        assert!(!dir.path().join("1-a.dem").exists(), "a capped expansion leaves nothing behind");

        let zst = dir.path().join("2-a.zst");
        std::fs::write(&zst, zstd::encode_all(&body[..], 3).expect("zstd")).expect("w");
        assert_eq!(std::fs::read(expand(&zst, 1 << 20).expect("expands")).expect("read"), body);

        let junk = dir.path().join("3-a.dem");
        std::fs::write(&junk, b"MZ\x90\0not a demo").expect("w");
        assert_eq!(expand(&junk, 1 << 20), Err(reason::NOT_A_REPLAY));
    }
}
