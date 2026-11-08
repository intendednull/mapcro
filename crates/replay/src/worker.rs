//! The on-disk queue (spec §6a, "Replay worker"). The server and the worker share one directory
//! and nothing else, and neither can write where the other writes (security review
//! 2026-11-08, M1/M2):
//!
//! ```text
//! inbox/<job>.dem|.bz2|.zst   the server's: complete, magic-checked files. The worker can
//!                             only read it, and the server deletes a job's file when it
//!                             collects the job's result, so the demo goes when its parse ends
//! inbox/.order                the server's parse order, one job a line
//! outbox/<job>.parsing        the worker's: a job it is on now
//! outbox/<job>.json           the timeline; the server checks it and caches it
//! outbox/<job>.failed         one reason code from `reason`
//! work/                       the worker's own scratch (a decompressed demo, a result being
//!                             written); the server never touches it
//! ```
//!
//! A job name is `<match id>-<scope>` (`[0-9a-z-]`, ≤ 64 bytes). Up to `REPLAY_WORKERS` jobs run
//! at once, each in a child process (this binary, `job` mode) under its own wall-clock timeout;
//! the service's cgroup caps memory and CPU, and a child killed by the kernel fails its job, not
//! the worker or the other jobs. The order is the server's (`inbox/.order`, fair across clients),
//! else oldest first.

use crate::reason;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

pub struct Limits {
    /// Wall clock per job, decompression and parse together.
    pub timeout: Duration,
    /// The largest `.dem` a compressed download may expand to.
    pub max_dem_bytes: u64,
    /// Jobs parsed at once, each in its own child under its own wall clock.
    pub workers: usize,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { timeout: Duration::from_secs(300), max_dem_bytes: 1024 * 1024 * 1024, workers: 2 }
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

/// The server's parse order (`inbox/.order`), if it wrote one: never through a link, capped.
fn order(root: &Path) -> Vec<String> {
    use std::os::unix::fs::OpenOptionsExt;
    let Ok(f) = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(root.join("inbox").join(crate::ORDER_FILE)) else { return Vec::new() };
    if !f.metadata().is_ok_and(|m| m.is_file()) {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    let _ = f.take(crate::ORDER_MAX_BYTES).read_to_end(&mut bytes);
    crate::read_order(&bytes)
}

/// The next queued job with no result yet, not tried in this run: the first the server's order
/// lists, else the oldest (a job queued before the order was written, or with no server).
fn next(root: &Path, tried: &HashSet<String>) -> Option<PathBuf> {
    let mut jobs: Vec<(SystemTime, String, PathBuf)> = std::fs::read_dir(root.join("inbox"))
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.path())
        .filter_map(|p| job_of(&p).map(|(j, _)| (j, p)))
        .filter(|(j, _)| !tried.contains(j) && !finished(root, j))
        .map(|(j, p)| (std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH), j, p))
        .collect();
    for j in order(root) {
        if let Some(i) = jobs.iter().position(|(_, name, _)| *name == j) {
            return Some(jobs.swap_remove(i).2);
        }
    }
    jobs.sort();
    jobs.into_iter().next().map(|(_, _, p)| p)
}

/// `work/<job>.requeued`: the job was put back once after a restart (the worker's own scratch:
/// it can't write the inbox, and the server drops unknown files in the outbox).
fn requeued(root: &Path, job: &str) -> PathBuf {
    root.join("work").join(format!("{job}.requeued"))
}

fn queued(root: &Path, job: &str) -> bool {
    ["dem", "bz2", "zst"].iter().any(|e| root.join("inbox").join(format!("{job}.{e}")).exists())
}

/// After a restart: a job it was on goes back in the queue once (a deploy restarts the worker
/// mid-parse, and the demo is fine), and fails if it was put back already (it may be what
/// brought the worker down). Its scratch files go.
pub fn recover(root: &Path) {
    if let Ok(rd) = std::fs::read_dir(root.join("outbox")) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(job) = name.strip_suffix(".parsing") {
                if valid_job(job) && !finished(root, job) {
                    let again = !requeued(root, job).exists() && queued(root, job) && std::fs::write(requeued(root, job), b"").is_ok();
                    if again {
                        eprintln!("mapcro-replay: {job} put back after a restart");
                    } else {
                        fail(root, job, reason::PARSE_FAILED);
                    }
                }
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    if let Ok(rd) = std::fs::read_dir(root.join("work")) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            // A put-back job's mark stays while it waits to run again.
            if name.strip_suffix(".requeued").is_some_and(|job| queued(root, job) && !finished(root, job)) {
                continue;
            }
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// A job being parsed: its child, under its own wall clock.
struct Running {
    job: String,
    child: Child,
    deadline: Instant,
    started: Instant,
    out: PathBuf,
    marker: PathBuf,
}

/// Start the next queued job in a child: `None` when nothing is waiting, `Some(None)` when its
/// child couldn't start (the job fails).
fn start(root: &Path, exe: &Path, limits: &Limits, tried: &mut HashSet<String>) -> Option<Option<Running>> {
    let src = next(root, tried)?;
    let (job, _) = job_of(&src)?;
    tried.insert(job.clone());
    let marker = root.join("outbox").join(format!("{job}.parsing"));
    let _ = std::fs::write(&marker, b"");
    set_mode(&marker, 0o640);
    let out = root.join("work").join(format!("{job}.json"));
    let started = Instant::now();
    match spawn_child(exe, &src, &out, match_id(&job), limits) {
        Ok(child) => Some(Some(Running { child, job, deadline: started + limits.timeout, started, out, marker })),
        Err(e) => {
            fail(root, &job, reason::PARSE_FAILED);
            let _ = std::fs::remove_file(&marker);
            eprintln!("mapcro-replay: {job} not started ({e})");
            Some(None)
        }
    }
}

/// Its outcome once the child is done, or killed past its wall clock (checked first: a result
/// seen only after the deadline is late); `None` while it runs.
fn poll(r: &mut Running) -> Option<Result<(), &'static str>> {
    if Instant::now() >= r.deadline {
        let _ = r.child.kill();
        let _ = r.child.wait();
        return Some(Err(reason::TIMEOUT));
    }
    match r.child.try_wait() {
        Ok(Some(status)) => Some(outcome(&mut r.child, status)),
        Ok(None) => None,
        Err(_) => {
            let _ = r.child.kill();
            let _ = r.child.wait();
            Some(Err(reason::PARSE_FAILED))
        }
    }
}

/// Publish a finished job's result (or its failure) and clear its scratch and marker.
fn finish(root: &Path, r: Running, result: Result<(), &'static str>) {
    let job = &r.job;
    // The expanded copy goes now; the server deletes the original when it collects the result.
    let _ = std::fs::remove_file(r.out.with_extension("dem"));
    let secs = r.started.elapsed().as_secs_f64();
    match result {
        // Published by copy, not rename: work/ and outbox/ are separate mounts in the worker's
        // sandbox (nix/module.nix BindPaths), and a rename across them fails with EXDEV. That
        // failed every successful parse in production on 2026-11-08, as "done" with no result.
        Ok(()) => match std::fs::read(&r.out).and_then(|b| write_atomic(&root.join("outbox"), &format!("{job}.json"), &b)) {
            Ok(()) => eprintln!("mapcro-replay: {job} done in {secs:.1} s"),
            Err(e) => {
                fail(root, job, reason::PARSE_FAILED);
                eprintln!("mapcro-replay: {job} parsed but not published ({e}) after {secs:.1} s");
            }
        },
        Err(why) => {
            fail(root, job, why);
            eprintln!("mapcro-replay: {job} failed ({why}) after {secs:.1} s");
        }
    }
    let _ = std::fs::remove_file(&r.out);
    let _ = std::fs::remove_file(requeued(root, job));
    let _ = std::fs::remove_file(&r.marker);
}

/// Run one queued job to a result. Returns false when nothing is waiting.
pub fn run_one(root: &Path, exe: &Path, limits: &Limits, tried: &mut HashSet<String>) -> bool {
    let Some(started) = start(root, exe, limits, tried) else { return false };
    let Some(mut r) = started else { return true };
    let result = loop {
        if let Some(res) = poll(&mut r) {
            break res;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    finish(root, r, result);
    true
}

/// SIGBUS: the memory-mapped demo changed or shrank under the parser.
const SIGBUS: i32 = 7;

fn spawn_child(exe: &Path, input: &Path, out: &Path, match_id: u64, limits: &Limits) -> std::io::Result<Child> {
    Command::new(exe)
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
}

/// A child's exit as the job's outcome: its reason on stdout, or the signal that killed it.
fn outcome(child: &mut Child, status: std::process::ExitStatus) -> Result<(), &'static str> {
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

#[cfg(test)]
fn run_child(exe: &Path, input: &Path, out: &Path, match_id: u64, limits: &Limits) -> Result<(), &'static str> {
    let child = spawn_child(exe, input, out, match_id, limits).map_err(|_| reason::PARSE_FAILED)?;
    let now = Instant::now();
    let mut r = Running { job: String::new(), child, deadline: now + limits.timeout, started: now, out: out.to_owned(), marker: PathBuf::new() };
    loop {
        if let Some(res) = poll(&mut r) {
            return res;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// `job` mode, in the child: decompress if needed, parse, derive, write the timeline.
pub fn job(input: &Path, out: &Path, match_id: u64, max_dem_bytes: u64) -> Result<(), &'static str> {
    let dem = expand(input, &out.with_extension("dem"), max_dem_bytes)?;
    let obs = crate::parse::observe(&dem, match_id)?;
    let t = crate::derive::derive(&obs, crate::map::current()).map_err(|e| e.reason())?;
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
    serve_with(root, &std::env::current_exe()?, limits, once)
}

/// The service with `exe` as the child (tests give it a stand-in). Up to `limits.workers` jobs
/// run at once, each in its own child under its own wall clock; one failing, killed or timed out
/// fails only its job.
pub fn serve_with(root: &Path, exe: &Path, limits: &Limits, once: bool) -> std::io::Result<()> {
    for d in dirs(root) {
        if !d.is_dir() {
            return Err(std::io::Error::other(format!("{} is not a directory", d.display())));
        }
    }
    recover(root);
    let workers = limits.workers.max(1);
    let mut tried = HashSet::new();
    let mut running: Vec<Running> = Vec::new();
    loop {
        // Jobs the server has collected leave the inbox; forget them (not the ones running).
        tried.retain(|j: &String| running.iter().any(|r| r.job == *j) || ["dem", "bz2", "zst"].iter().any(|e| root.join("inbox").join(format!("{j}.{e}")).exists()));
        let mut i = 0;
        while i < running.len() {
            match poll(&mut running[i]) {
                Some(result) => finish(root, running.swap_remove(i), result),
                None => i += 1,
            }
        }
        while running.len() < workers {
            let Some(started) = start(root, exe, limits, &mut tried) else { break };
            running.extend(started);
        }
        if running.is_empty() {
            if once {
                return Ok(());
            }
            std::thread::sleep(Duration::from_secs(1));
        } else {
            std::thread::sleep(Duration::from_millis(100));
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
    /// work/ and outbox/ on different filesystems, as in the worker's sandbox, where they are
    /// separate bind mounts: a finished timeline still reaches the outbox. On 2026-11-08 a rename
    /// across them failed every successful parse in production.
    #[cfg(unix)]
    #[test]
    fn a_result_crosses_from_work_to_outbox_on_another_filesystem() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = tempfile::tempdir().expect("root");
        let Ok(other) = tempfile::tempdir_in("/dev/shm") else { return };
        let dev = |p: &Path| std::fs::metadata(p).map(|m| m.dev()).unwrap_or(0);
        if dev(root.path()) == dev(other.path()) {
            return; // no second filesystem here to cross
        }
        for d in ["inbox", "outbox"] {
            std::fs::create_dir(root.path().join(d)).expect("dir");
        }
        std::os::unix::fs::symlink(other.path(), root.path().join("work")).expect("work on the other filesystem");
        std::fs::write(root.path().join("inbox").join("5-cdn.dem"), b"demo").expect("job");
        let exe = root.path().join("child.sh");
        std::fs::write(&exe, "#!/bin/sh\nprintf '{\"t\":1}' > \"$3\"\n").expect("script");
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        assert!(run_one(root.path(), &exe, &Limits::default(), &mut HashSet::new()));
        let outbox = root.path().join("outbox");
        assert!(!outbox.join("5-cdn.failed").exists(), "the job was marked failed");
        assert_eq!(std::fs::read(outbox.join("5-cdn.json")).expect("published"), br#"{"t":1}"#);
        assert_eq!(std::fs::metadata(outbox.join("5-cdn.json")).expect("meta").permissions().mode() & 0o777, 0o640);
    }

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

    /// A stand-in child: by its job's match id, sleeps (1: 1 s, 9: forever, else 0.2 s),
    /// then writes a timeline. Each start is logged, with the markers present, to `log`.
    #[cfg(unix)]
    fn stand_in(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let exe = dir.join("child.sh");
        let log = dir.join("log");
        let script = format!(
            "#!/bin/sh\nPATH={path}\necho \"$(basename \"$2\") $(ls {out} | grep -c parsing)\" >> {log}\ncase \"$(basename \"$2\")\" in 1-*) sleep 1;; 9-*) exec sleep 600;; *) sleep 0.2;; esac\nprintf '{{\"t\":1}}' > \"$3\"\n",
            path = std::env::var("PATH").unwrap_or_default(),
            out = dir.join("q/outbox").display(),
            log = log.display()
        );
        std::fs::write(&exe, script).expect("script");
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        exe
    }

    fn queue_in(dir: &Path) -> PathBuf {
        let q = dir.join("q");
        for d in ["inbox", "outbox", "work"] {
            std::fs::create_dir_all(q.join(d)).expect("dir");
        }
        q
    }

    /// N jobs run at once, each in its own child: two 1 s jobs take about 1 s, not 2, and both
    /// were parsing together.
    #[cfg(unix)]
    #[test]
    fn workers_run_jobs_at_once() {
        let dir = tempfile::tempdir().expect("dir");
        let q = queue_in(dir.path());
        let exe = stand_in(dir.path());
        for j in ["1-aaaaaaaaaaaaaaaa", "1-cdn"] {
            std::fs::write(q.join("inbox").join(format!("{j}.dem")), b"demo").expect("job");
        }
        let t = Instant::now();
        serve_with(&q, &exe, &Limits { workers: 2, ..Limits::default() }, true).expect("serve");
        let took = t.elapsed();
        assert!(took < Duration::from_millis(1800), "two 1 s jobs in {took:?}: not at once");
        for j in ["1-aaaaaaaaaaaaaaaa", "1-cdn"] {
            assert!(q.join("outbox").join(format!("{j}.json")).exists(), "{j} done");
        }
        let log = std::fs::read_to_string(dir.path().join("log")).expect("log");
        assert!(log.lines().any(|l| l.ends_with(" 2")), "both markers while one ran: {log}");
        // One at a time takes the two in turn.
        let dir = tempfile::tempdir().expect("dir");
        let q = queue_in(dir.path());
        let exe = stand_in(dir.path());
        for j in ["1-aaaaaaaaaaaaaaaa", "1-cdn"] {
            std::fs::write(q.join("inbox").join(format!("{j}.dem")), b"demo").expect("job");
        }
        let t = Instant::now();
        serve_with(&q, &exe, &Limits { workers: 1, ..Limits::default() }, true).expect("serve");
        assert!(t.elapsed() >= Duration::from_secs(2), "one worker runs them in turn");
    }

    /// Each child keeps its own wall clock: one that hangs is killed as `timeout` while the
    /// others beside it finish.
    #[cfg(unix)]
    #[test]
    fn a_hung_job_times_out_alone() {
        let dir = tempfile::tempdir().expect("dir");
        let q = queue_in(dir.path());
        let exe = stand_in(dir.path());
        for j in ["9-cdn", "2-cdn", "3-cdn", "4-cdn"] {
            std::fs::write(q.join("inbox").join(format!("{j}.dem")), b"demo").expect("job");
        }
        let t = Instant::now();
        serve_with(&q, &exe, &Limits { workers: 2, timeout: Duration::from_secs(2), ..Limits::default() }, true).expect("serve");
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
        assert_eq!(std::fs::read_to_string(q.join("outbox/9-cdn.failed")).expect("timed out"), reason::TIMEOUT);
        for j in ["2-cdn", "3-cdn", "4-cdn"] {
            assert!(q.join("outbox").join(format!("{j}.json")).exists(), "{j} finished beside the hung one");
        }
        assert!(std::fs::read_dir(q.join("outbox")).expect("outbox").flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".parsing")));
    }

    /// The server's order decides which job runs next; jobs it doesn't list go after, oldest
    /// first, and its junk lines are ignored.
    #[test]
    fn the_servers_order_comes_first() {
        let dir = tempfile::tempdir().expect("dir");
        let q = queue_in(dir.path());
        for (i, j) in ["5-cdn", "6-cdn", "7-cdn"].iter().enumerate() {
            let p = q.join("inbox").join(format!("{j}.dem"));
            std::fs::write(&p, b"demo").expect("job");
            let t = SystemTime::now() - Duration::from_secs(100 - i as u64);
            std::fs::File::options().write(true).open(&p).and_then(|f| f.set_modified(t)).expect("mtime");
        }
        let name = |p: Option<PathBuf>| p.and_then(|p| job_of(&p)).map(|(j, _)| j);
        assert_eq!(name(next(&q, &HashSet::new())).as_deref(), Some("5-cdn"), "oldest first with no order");
        std::fs::write(q.join("inbox").join(crate::ORDER_FILE), "../x\n7-cdn\n\n8-cdn\n6-cdn\n").expect("order");
        assert_eq!(name(next(&q, &HashSet::new())).as_deref(), Some("7-cdn"));
        let tried: HashSet<String> = ["7-cdn".to_owned()].into();
        assert_eq!(name(next(&q, &tried)).as_deref(), Some("6-cdn"));
        let tried: HashSet<String> = ["7-cdn".to_owned(), "6-cdn".to_owned()].into();
        assert_eq!(name(next(&q, &tried)).as_deref(), Some("5-cdn"), "unlisted jobs still run");
    }

    /// A restart mid-parse (a deploy) puts the job back once, and it runs again to its result;
    /// a job that was on when the worker went down a second time fails, so a demo that brings
    /// the worker down isn't tried forever.
    #[cfg(unix)]
    #[test]
    fn a_restart_puts_the_job_back_once() {
        let dir = tempfile::tempdir().expect("dir");
        let q = queue_in(dir.path());
        let exe = stand_in(dir.path());
        let on = |job: &str| {
            std::fs::write(q.join("outbox").join(format!("{job}.parsing")), b"").expect("parsing");
            std::fs::write(q.join("work").join(format!("{job}.json")), b"half").expect("scratch");
        };
        std::fs::write(q.join("inbox/1-cdn.dem"), b"demo").expect("job");
        on("1-cdn");
        recover(&q);
        assert!(!q.join("outbox/1-cdn.failed").exists(), "a first restart doesn't fail it");
        assert!(!q.join("outbox/1-cdn.parsing").exists() && !q.join("work/1-cdn.json").exists());
        serve_with(&q, &exe, &Limits::default(), true).expect("serve");
        assert!(q.join("outbox/1-cdn.json").exists(), "it ran again to its result");
        assert!(!q.join("work/1-cdn.requeued").exists(), "its mark goes with its result");
        // Put back once already, and on again when the worker went down: it fails this time.
        std::fs::write(q.join("inbox/2-cdn.dem"), b"demo").expect("job");
        on("2-cdn");
        recover(&q);
        assert!(q.join("work/2-cdn.requeued").exists());
        recover(&q);
        assert!(q.join("work/2-cdn.requeued").exists(), "a restart while it waits costs nothing");
        on("2-cdn");
        recover(&q);
        assert_eq!(std::fs::read_to_string(q.join("outbox/2-cdn.failed")).expect("failed"), reason::PARSE_FAILED);
        assert!(!q.join("work/2-cdn.requeued").exists());
        // One that finished before the restart keeps its result: nothing is failed beside it.
        std::fs::write(q.join("inbox/3-cdn.dem"), b"demo").expect("job");
        std::fs::write(q.join("work/3-cdn.requeued"), b"").expect("mark");
        on("3-cdn");
        std::fs::write(q.join("outbox/3-cdn.json"), b"{}").expect("result");
        recover(&q);
        assert!(!q.join("outbox/3-cdn.failed").exists() && q.join("outbox/3-cdn.json").exists());
    }
}
