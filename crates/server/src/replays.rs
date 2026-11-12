//! Match import's replay tier (spec §6a, §11): demos in, compact timelines out, parsed by a
//! separate sandboxed worker (`crates/replay`, its own systemd service). This process never
//! parses a demo: it streams bytes to disk under caps, hands complete files to the worker's
//! queue, and checks what comes back before caching or serving it.
//!
//! **Trust boundaries.** Upload bodies and the CDN's bytes are untrusted and only ever written
//! to disk (never held in memory, never parsed here beyond an 8-byte magic check). The worker's
//! output is untrusted too: it is size-capped and shape-checked (`mapcro_replay::timeline::
//! validate`) before it reaches the cache. deadlock-api's salts response is untrusted: only two
//! numbers are taken from it, and the CDN URL is built from them, so it can't point us elsewhere.
//!
//! **Scope.** A demo carries no match id, so an upload's claim can't be checked: an uploaded
//! timeline is visible only on the board that uploaded it, and its clones (`carry_to_clone`). A
//! timeline fetched from Valve's CDN by match id is shared by every board. A timeline parsed on
//! the user's machine (`client_timeline`) is no more trusted than a demo: it gets the worker's
//! checks and the upload's scope, and the server stamps its `source` as `client`.
//!
//! **Queue** (`REPLAY_DIR`, shared with the worker; crates/replay/src/worker.rs): `inbox/` is
//! the server's alone (complete, magic-checked files, written as `.<job>.part`, opened with
//! O_EXCL|O_NOFOLLOW, and renamed); the worker only reads it. `outbox/` is the worker's: a
//! `.parsing` marker, then `<job>.json` or `<job>.failed`. A result counts only for a job whose
//! file the server put in `inbox/` (security review 2026-11-08, M1/M2). A job is
//! `<match id>-<scope>`: `cdn`, or 16 hex digits of the board id's hash.
//!
//! **Privacy:** nothing here reads a demo; the worker never reads Steam or account ids, and the
//! demo is deleted when its parse ends.

use crate::api::{client_ip, client_key};
use crate::replay_queue::{self, Client, Kind, Room, Stats, Waiting};
use crate::{AppState, links};
use axum::Router;
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::StreamExt;
use mapcro_engine::wire::LinkRole;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tokio::io::AsyncWriteExt;

/// Limits, from the environment, read once (spec §11 lists them with their defaults).
pub struct Settings {
    pub api_base: String,
    /// `None`: Valve's `http://replay{cluster}.valve.net`. Tests point it at a fake.
    pub cdn_base: Option<String>,
    pub max_upload: u64,
    pub max_download: u64,
    /// Bytes the queue (inbox and work, plus transfers in flight at their size) may hold.
    pub max_queue_bytes: u64,
    /// Jobs on disk or on their way there (queued, parsing, transferring).
    pub max_queued: usize,
    /// Transfers waiting in line past this are refused (`queue_full`): the last resort.
    pub max_waiting: usize,
    /// A reservation nobody asks about for this long lapses (its client went away). Long enough
    /// for a hidden tab, whose timers Chrome slows to about one a minute.
    pub reserve_ttl: Duration,
    /// A turn given must be used (its upload started) within this, or it goes: a turn holds an
    /// upload slot and its bytes, so asking alone can't keep one.
    pub grant_use: Duration,
    /// Jobs the worker parses at once (its `REPLAY_WORKERS`), for the wait estimate.
    pub workers: usize,
    /// Bytes of cached timelines; the oldest go first past it.
    pub max_cache_bytes: u64,
    pub uploads_at_once: usize,
    /// CDN downloads at once; more wait in line (as do any the queue has no room for).
    pub downloads_at_once: usize,
    /// Turns given for uploads (reservations whose turn came, used or not) per client per hour.
    /// Fetches have no hourly cap of ours: deadlock-api's own answers pace them (a 429 backs
    /// off), and the queue's room bounds what we hold (operator, 2026-11-08); only how many a
    /// client has waiting at once is capped (`PER_CLIENT_WAITING`).
    pub per_client: usize,
    /// Timelines parsed on the user's machine (`POST …/timeline`) per client per hour. Its own
    /// count: such a timeline takes no queue slot or parse, only a JSON check.
    pub timelines_per_client: usize,
    /// A client-parsed timeline's body as sent, gzipped or not. Decoded, it may be at most
    /// `timeline::MAX_BYTES` (6 MiB) whatever this says.
    pub max_timeline_body: u64,
    /// No body bytes for this long ends an upload.
    pub idle: Duration,
    /// A whole upload or download.
    pub transfer: Duration,
    /// A job still queued after this (the worker is down) is dropped.
    pub stale: Duration,
    /// Seconds after a match's end before which its salts aren't looked up through Steam, and
    /// at which a match with no replay salt yet is tried again (`SALT_PASS_S`).
    pub salt_pass_s: u64,
}

fn settings() -> &'static Settings {
    static S: OnceLock<Settings> = OnceLock::new();
    S.get_or_init(|| {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let num = |k: &str, d: u64| var(k).and_then(|v| v.parse().ok()).unwrap_or(d);
        const MIB: u64 = 1024 * 1024;
        Settings {
            api_base: var("MATCH_API_BASE").unwrap_or_else(|| "https://api.deadlock-api.com".into()).trim_end_matches('/').to_owned(),
            cdn_base: var("REPLAY_CDN_BASE").map(|b| b.trim_end_matches('/').to_owned()),
            // A 35-minute demo is ~480 MB; the largest seen, 557 MB (research §3.3).
            max_upload: num("REPLAY_MAX_UPLOAD_BYTES", 800 * MIB),
            max_download: num("REPLAY_MAX_DOWNLOAD_BYTES", 800 * MIB),
            // Fetches arrive compressed (~330 MB for a 35-minute match), uploads raw (~500 MB):
            // 8 GiB is ~16 to 24 jobs, a few minutes of parsing (journal 2026-11-08-replay-capacity).
            max_queue_bytes: num("REPLAY_MAX_QUEUE_BYTES", 8 * 1024 * MIB),
            max_queued: num("REPLAY_MAX_QUEUED", 24) as usize,
            max_waiting: num("REPLAY_MAX_WAITING", 64) as usize,
            reserve_ttl: Duration::from_secs(num("REPLAY_RESERVE_TTL_S", 90)),
            grant_use: Duration::from_secs(num("REPLAY_GRANT_USE_S", 75)),
            workers: num("REPLAY_WORKERS", 2).max(1) as usize,
            max_cache_bytes: num("REPLAY_MAX_CACHE_BYTES", 1024 * MIB),
            uploads_at_once: num("REPLAY_UPLOADS_AT_ONCE", 4) as usize,
            downloads_at_once: num("REPLAY_DOWNLOADS_AT_ONCE", 2) as usize,
            per_client: num("REPLAY_PER_CLIENT_PER_HOUR", 6) as usize,
            timelines_per_client: num("REPLAY_TIMELINES_PER_CLIENT_PER_HOUR", 30) as usize,
            // Format 8 is ~41 KB a match minute raw and gzips ~3×: a 60-minute match is ~0.8 MB.
            max_timeline_body: num("REPLAY_MAX_TIMELINE_BYTES", 4 * MIB),
            idle: Duration::from_secs(num("REPLAY_IDLE_S", 60)),
            transfer: Duration::from_secs(num("REPLAY_TRANSFER_S", 1800)),
            stale: Duration::from_secs(num("REPLAY_STALE_S", 3600)),
            salt_pass_s: num("REPLAY_SALT_PASS_S", SALT_PASS_S),
        }
    })
}

/// What the server remembers about jobs between polls (lost on restart, which is harmless:
/// a lost failure reads as "none" and can be retried, and a queued file is parsed in arrival
/// order).
#[derive(Default)]
struct Jobs {
    fetching: HashSet<String>,
    uploading: HashSet<String>,
    uploads_by_client: HashMap<IpAddr, usize>,
    /// Transfers waiting for room, in arrival order: reservations for uploads, and fetches.
    line: Vec<Waiting>,
    /// Reservations whose turn came, held for their upload to start: bytes, client, last asked.
    granted: HashMap<String, Grant>,
    /// Fetches in line, told when their download starts (dropped: they left the line).
    turns: HashMap<String, tokio::sync::oneshot::Sender<()>>,
    /// Bytes each transfer under way may write (an upload's size, a download's cap).
    flight: HashMap<String, u64>,
    /// Each job's client and arrival, for the fair order, from its arrival until it's collected.
    owner: HashMap<String, (Client, u64)>,
    seq: u64,
    /// When the collector first saw each job parsing.
    parse_started: HashMap<String, Instant>,
    /// The queue as the collector last saw it: queued jobs in the fair order (as the worker runs
    /// them), and how many are parsing.
    queued_order: Vec<String>,
    parsing_now: usize,
    /// The line in the fair order, as the last `schedule` left it.
    line_order: Vec<String>,
    stats: Stats,
    failed: HashMap<String, (&'static str, Instant)>,
    /// Turns given for uploads, per client: the hourly limit counts them.
    starts: HashMap<Client, Vec<Instant>>,
    /// Fetches downloading now (the rest of `fetching` wait in line for room).
    downloading: HashSet<String>,
    /// Matches whose fetch can't work for a while, by match id: no salts or demo (until the
    /// salts are likely to have come, `no_replay_for`), the download failed, the match is past
    /// Valve's three weeks, or its lookup would spend deadlock-api's Steam budget while that's
    /// backing us off (`upstream_limited`, until the backoff ends). Until then, opening the match
    /// doesn't ask deadlock-api again. "Fetch replay" goes past it, but not past the backoff.
    negative: HashMap<String, (&'static str, Instant)>,
    /// deadlock-api's salts endpoint said 429 (in practice its Steam limit, met by a lookup of a
    /// match it has no row for): no Steam-capable lookup asks it before this, and the last wait,
    /// which the next 429 doubles. Free reads of the rows it holds still go (`salts`).
    backoff: Option<(Instant, Duration)>,
    /// Opens whose fetch didn't start on its own for our caps (`fetch_refused`), by the board's
    /// job for the match: its status says `busy` for a while, so the opener hears why.
    skipped: HashMap<String, Instant>,
    /// Matches whose CDN timeline was cached in an older format and was fetched again on open
    /// (`auto_fetch`): once a match, whatever came of it, so opening it again doesn't (lost on
    /// restart, which costs at most one more fetch).
    refreshed: HashSet<String>,
    /// Client-parsed timelines sent, per client, for their hourly cap (`client_timeline`).
    timelines: HashMap<Client, Vec<Instant>>,
}

struct Grant {
    bytes: u64,
    client: Client,
    touched: Instant,
    /// When its turn came: it must be used within `grant_use`.
    at: Instant,
}

fn jobs() -> &'static Mutex<Jobs> {
    static J: OnceLock<Mutex<Jobs>> = OnceLock::new();
    J.get_or_init(Mutex::default)
}

fn lock() -> std::sync::MutexGuard<'static, Jobs> {
    jobs().lock().unwrap_or_else(|p| p.into_inner())
}

const HOUR: Duration = Duration::from_secs(3600);
const FAILED_FOR: Duration = Duration::from_secs(3600);
/// How long a match's fetch that can't work isn't tried again on its own.
const NEGATIVE_FOR: Duration = Duration::from_secs(6 * 3600);
/// Rows without a replay salt get one mostly in a pass about two hours after the match ends: 10%
/// have one at 1 h, 42% at 2 h, then 45–48% to 32 h (docs/research/deadlock-api-salts.md
/// "Results"; 13 of 19 arrived at 120–121 min). Plus a few minutes for Cloudflare's cache.
const SALT_PASS_S: u64 = 2 * 3600 + 10 * 60;
/// Valve keeps a replay three weeks from the match's start; past that, opening it doesn't try.
const REPLAY_KEPT_S: u64 = 21 * 24 * 3600;
/// How long an open whose fetch our caps skipped says so (`Jobs::skipped`).
const SKIPPED_FOR: Duration = Duration::from_secs(600);
/// A 429 without `Retry-After` waits this, doubling, up to an hour.
const BACKOFF_FIRST: Duration = Duration::from_secs(60);
const BACKOFF_MAX: Duration = HOUR;

/// Upload turns `client` was given this hour, plus the reservations it has waiting for one.
fn turns_used(j: &mut Jobs, client: &str) -> usize {
    let now = Instant::now();
    j.starts.retain(|_, v| {
        v.retain(|t| now.duration_since(*t) < HOUR);
        !v.is_empty()
    });
    j.starts.get(client).map_or(0, Vec::len) + j.line.iter().filter(|w| w.kind == Kind::Upload && w.client == client).count()
}

/// Whether `client` can't ask for another upload turn this hour: the turns it was given and
/// those it waits for count, so a turn taken and left unused still costs one.
fn over_limit(j: &mut Jobs, client: &str) -> bool {
    turns_used(j, client) >= settings().per_client
}

/// Why a new fetch from `client` can't join the line, if it can't: it has this many waiting
/// already, or the line is at its cap (the last resort, as for uploads).
fn fetch_refused(j: &Jobs, client: &str) -> Option<(StatusCode, &'static str)> {
    if j.line.iter().filter(|w| w.kind == Kind::Fetch && w.client == client).count() >= PER_CLIENT_WAITING {
        return Some((StatusCode::TOO_MANY_REQUESTS, "busy"));
    }
    (j.line.len() >= settings().max_waiting).then_some((StatusCode::SERVICE_UNAVAILABLE, "queue_full"))
}

/// The salts endpoint is backing off: its 429 hasn't cleared yet.
fn limited(j: &Jobs) -> bool {
    j.backoff.is_some_and(|(until, _)| Instant::now() < until)
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Whether a match that ended at `ended` (unix seconds) is still before deadlock-api's salts
/// pass (`SALT_PASS_S`): a Steam lookup for it then has never found a replay salt that the free
/// read lacked, so it isn't spent (salts "Results", conclusion 1). Not known: not fresh.
fn fresh(ended: Option<u64>, now: u64) -> bool {
    ended.is_some_and(|e| now.saturating_sub(e) < settings().salt_pass_s)
}

/// How long a match whose salts carry no replay salt (or that has no row yet) isn't asked about
/// again on its own: until the salts pass if it's before it, else `NEGATIVE_FOR` (one more try
/// later; past a day, one rarely comes).
fn no_replay_for(ended: Option<u64>, now: u64) -> Duration {
    match ended.map(|e| now.saturating_sub(e)) {
        Some(age) if age < settings().salt_pass_s => Duration::from_secs(settings().salt_pass_s - age),
        _ => NEGATIVE_FOR,
    }
}

/// A 429 from the salts endpoint: wait what it said, else twice the last wait (60 s first). It
/// holds back only lookups that can spend the Steam budget; reads of stored rows still go.
fn back_off(j: &mut Jobs, retry_after: Option<Duration>) {
    let last = j.backoff.map(|(_, d)| d);
    let wait = retry_after.unwrap_or_else(|| last.map_or(BACKOFF_FIRST, |d| d * 2)).min(BACKOFF_MAX);
    j.backoff = Some((Instant::now() + wait, wait));
}

/// Why a match's fetch can't work for now, if it can't.
fn negative(j: &Jobs, id: &str) -> Option<&'static str> {
    j.negative.get(id).filter(|(_, until)| Instant::now() < *until).map(|(why, _)| *why)
}

// ---- paths ----

pub fn routes() -> Router<AppState> {
    Router::new()
        // The two routes without the 16 KiB body limit: each applies its own cap while reading.
        .route("/api/boards/{board}/replays/{id}/upload", post(upload))
        // Its own caps too, on the body as sent and decoded (`client_timeline`).
        .route("/api/boards/{board}/replays/{id}/timeline", post(client_timeline))
        .merge(
            Router::new()
                .route("/api/boards/{board}/replays/{id}", get(status))
                .route("/api/boards/{board}/replays/{id}/fetch", post(fetch))
                .route("/api/boards/{board}/replays/{id}/reserve", post(reserve).delete(release))
                // A timeline is 1–2 MB of JSON that compresses ~3× (FORMAT 7 study).
                .route("/api/boards/{board}/matches/{id}", get(timeline).layer(crate::compression()).put(attach))
                .route("/api/boards/{board}/matches", get(attached))
                .layer(tower_http::limit::RequestBodyLimitLayer::new(16 * 1024)),
        )
}

fn root(app: &AppState) -> Option<&FsPath> {
    app.config.replay_dir.as_deref()
}

fn cache_dir(app: &AppState) -> PathBuf {
    app.config.data_dir.join("replays")
}

pub(crate) fn scope_of(board: &str) -> String {
    links::hash(board)[..16].to_owned()
}

fn job_name(id: &str, scope: &str) -> String {
    format!("{id}-{scope}")
}

const EXTS: [&str; 3] = ["dem", "bz2", "zst"];

fn err(status: StatusCode, code: &str) -> Response {
    // Every refusal of the queue's passes through here.
    if matches!(code, "busy" | "queue_full" | "rate_limited") {
        crate::metrics::get().queue_refusals.inc((crate::metrics::QueueRefusal::from_code(code),));
    }
    (status, axum::Json(serde_json::json!({ "error": code }))).into_response()
}

/// A job's source: fetched jobs are the match's `cdn` scope, uploads a board's.
fn source_of(job: &str) -> crate::metrics::Source {
    if job.ends_with("-cdn") { crate::metrics::Source::Fetched } else { crate::metrics::Source::Uploaded }
}

/// The queue's gauges, for the metrics snapshot.
pub fn sample_metrics(app: &AppState) {
    let m = crate::metrics::get();
    let Some(root) = root(app) else { return };
    let s = settings();
    let j = lock();
    let (bytes, _) = queue_usage(root, &j.flight);
    let held: u64 = j.flight.values().sum::<u64>() + j.granted.values().map(|g| g.bytes).sum::<u64>();
    m.queue_waiting.set((), j.line.len() as f64);
    m.queue_bytes.set((), (bytes + held) as f64);
    m.queue_max_bytes.set((), s.max_queue_bytes as f64);
    m.queue_max_waiting.set((), s.max_waiting as f64);
    m.parses_running.set((), j.parsing_now as f64);
    let left = j.backoff.map_or(0.0, |(until, _)| until.saturating_duration_since(Instant::now()).as_secs_f64());
    m.deadlock_api_backoff_s.set((), left);
}

fn json(body: serde_json::Value) -> Response {
    (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], axum::Json(body)).into_response()
}

/// The worker reads queued files as a member of the queue's group (nix/module.nix): set on the
/// open file, never by path.
fn group_readable() -> std::fs::Permissions {
    use std::os::unix::fs::PermissionsExt;
    std::fs::Permissions::from_mode(0o640)
}

/// The caller's role on `board`, from `Authorization: Bearer <token>`.
#[allow(clippy::result_large_err)] // the error *is* the HTTP response
async fn role(app: &AppState, board: &str, headers: &HeaderMap) -> Result<LinkRole, Response> {
    if !links::plausible_board_id(board) {
        return Err(err(StatusCode::NOT_FOUND, "no_board"));
    }
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|t| links::plausible_token(t))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "link_required"))?;
    match app.store.link(links::hash(token)).await {
        Ok(Some(l)) if l.board == board && !l.revoked => Ok(l.role),
        Ok(_) => Err(err(StatusCode::FORBIDDEN, "not_this_board")),
        Err(e) => {
            tracing::error!(error = %e, "link lookup failed");
            Err(err(StatusCode::INTERNAL_SERVER_ERROR, "internal"))
        }
    }
}

#[allow(clippy::result_large_err)]
async fn editor(app: &AppState, board: &str, headers: &HeaderMap) -> Result<(), Response> {
    match role(app, board, headers).await? {
        LinkRole::Owner | LinkRole::Edit => Ok(()),
        _ => Err(err(StatusCode::FORBIDDEN, "view_only")),
    }
}

// ---- job state, read from the queue and the cache ----

#[derive(Debug, PartialEq)]
enum State_ {
    None,
    /// An upload's reservation in line, with how many are ahead (0 once its turn came).
    Waiting(usize),
    Fetching,
    Uploading,
    /// Waiting for the parser (or, for a fetch, its download): how many are ahead, and the
    /// estimated seconds until its timeline is ready when recent times allow one.
    Queued(usize, Option<u64>),
    Parsing,
    Done,
    Failed(&'static str),
}

fn exists_any(dir: &FsPath, job: &str) -> bool {
    EXTS.iter().any(|e| dir.join(format!("{job}.{e}")).exists())
}

/// A queued file's place for the parser: those parsing and those before it in the fair order.
fn parse_place(j: &Jobs, job: &str) -> (usize, Option<u64>) {
    let s = settings();
    let ahead = j.parsing_now + j.queued_order.iter().position(|q| q == job).unwrap_or(j.queued_order.len());
    (ahead, j.stats.parse_mean().map(|p| replay_queue::parse_eta(ahead, s.workers, p)))
}

/// A transfer's place in line: how many are ahead of it, and how many of those are fetches.
fn line_place(j: &Jobs, job: &str) -> Option<(usize, usize)> {
    let i = j.line_order.iter().position(|q| q == job)?;
    let fetches = j.line_order[..i].iter().filter(|q| j.line.iter().any(|w| &w.job == *q && w.kind == Kind::Fetch)).count();
    Some((i, fetches))
}

/// A job's state. Work under way comes before a cached timeline: a stale CDN timeline fetched
/// again (`auto_fetch`) is served meanwhile, and its status follows the new job, so the client
/// watches it and swaps the new timeline in when it's `done`.
fn job_state(app: &AppState, job: &str) -> State_ {
    let Some(root) = root(app) else { return State_::None };
    let cached = cache_dir(app).join(format!("{job}.json")).exists();
    {
        let j = lock();
        if j.uploading.contains(job) {
            return State_::Uploading;
        }
        if j.granted.contains_key(job) {
            return State_::Waiting(0);
        }
        if let Some(w) = j.line.iter().find(|w| w.job == job) {
            let (ahead, fetches) = line_place(&j, job).unwrap_or((j.line.len(), 0));
            if w.kind == Kind::Upload {
                return State_::Waiting(ahead);
            }
            let s = settings();
            let eta = j.stats.download_mean().zip(j.stats.parse_mean()).map(|(d, p)| replay_queue::fetch_eta(fetches, s.downloads_at_once, d, j.parsing_now + j.queued_order.len(), s.workers, p));
            return State_::Queued(ahead, eta);
        }
        if j.fetching.contains(job) {
            return State_::Fetching;
        }
        // A failed refetch leaves the timeline it would have replaced: that's still done.
        if let Some((why, _)) = j.failed.get(job).filter(|_| !cached) {
            return State_::Failed(why);
        }
    }
    if exists_any(&root.join("inbox"), job) {
        let out = root.join("outbox");
        // Started, or finished and waiting for the collector (within a second).
        let started = ["parsing", "json", "failed"].iter().any(|e| out.join(format!("{job}.{e}")).exists());
        if started {
            return State_::Parsing;
        }
        let (ahead, eta) = parse_place(&lock(), job);
        return State_::Queued(ahead, eta);
    }
    if cached {
        return State_::Done;
    }
    State_::None
}

/// Where a job's timeline is cached.
fn cached_path(app: &AppState, job: &str) -> PathBuf {
    cache_dir(app).join(format!("{job}.json"))
}

/// A cached timeline's format stamp (0 before the stamp) and its `source` (`client` when it was
/// parsed on the user's machine), if it can be read.
#[derive(Deserialize)]
struct Stamp {
    #[serde(default)]
    format: u32,
    #[serde(default)]
    source: String,
}

async fn cached_stamp(app: &AppState, job: &str) -> Option<Stamp> {
    let bytes = tokio::fs::read(cached_path(app, job)).await.ok()?;
    serde_json::from_slice::<Stamp>(&bytes).ok()
}

fn is_stale(s: &Stamp) -> bool {
    s.format < mapcro_replay::timeline::FORMAT
}

/// Whether a cached timeline predates the worker's current format (backlog, "Replay timeline
/// format versions"): it lacks the layers added since.
async fn stale(app: &AppState, job: &str) -> bool {
    cached_stamp(app, job).await.is_some_and(|s| is_stale(&s))
}

fn state_json(s: &State_, source: &str) -> serde_json::Value {
    match s {
        State_::None => serde_json::json!({ "state": "none" }),
        State_::Waiting(ahead) => serde_json::json!({ "state": "waiting", "source": source, "ahead": ahead }),
        State_::Fetching => serde_json::json!({ "state": "fetching", "source": source }),
        State_::Uploading => serde_json::json!({ "state": "uploading", "source": source }),
        State_::Queued(ahead, eta) => {
            let mut v = serde_json::json!({ "state": "queued", "source": source, "ahead": ahead });
            if let Some(eta) = eta {
                v["eta_s"] = (*eta).into();
            }
            v
        }
        State_::Parsing => serde_json::json!({ "state": "parsing", "source": source }),
        State_::Done => serde_json::json!({ "state": "done", "source": source }),
        State_::Failed(why) => serde_json::json!({ "state": "failed", "reason": why, "source": source }),
    }
}

/// Bytes in the queue's inbox and work directories, and the complete files queued. A transfer
/// under way (in `flight`) counts at its size elsewhere, so its partial file doesn't here.
fn queue_usage(root: &FsPath, flight: &HashMap<String, u64>) -> (u64, usize) {
    let mut bytes = 0;
    let mut queued = 0;
    for d in ["inbox", "work"] {
        let Ok(rd) = std::fs::read_dir(root.join(d)) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if d == "inbox" && name.starts_with('.') && flight.contains_key(name.trim_start_matches('.').split('.').next().unwrap_or("")) {
                continue;
            }
            if let Ok(m) = e.metadata() {
                bytes += m.len();
                if d == "inbox" && !name.starts_with('.') {
                    queued += 1;
                }
            }
        }
    }
    (bytes, queued)
}

/// Each client's jobs past the line (transferring, queued or parsing): a fair turn counts them.
fn prior(j: &Jobs) -> HashMap<Client, usize> {
    let waiting: HashSet<&str> = j.line.iter().map(|w| w.job.as_str()).collect();
    let mut n: HashMap<Client, usize> = HashMap::new();
    for (job, (client, _)) in &j.owner {
        if !waiting.contains(job.as_str()) {
            *n.entry(client.clone()).or_default() += 1;
        }
    }
    n
}

/// Lapse reservations nobody asks about, then start what the room holds, in the fair order:
/// a fetch moves to downloading, a reservation is granted (held for its upload to start).
fn schedule(j: &mut Jobs, root: &FsPath) {
    let s = settings();
    let now = Instant::now();
    for i in replay_queue::lapsed(&j.line, now, s.reserve_ttl).into_iter().rev() {
        let w = j.line.remove(i);
        j.owner.remove(&w.job);
        tracing::info!(job = w.job, "replay reservation lapsed");
    }
    // A turn nobody used in time goes, asked about or not: its client starts over at the back.
    let lapsed: Vec<String> = j
        .granted
        .iter()
        .filter(|(_, g)| now.saturating_duration_since(g.touched) >= s.reserve_ttl || now.saturating_duration_since(g.at) >= s.grant_use)
        .map(|(k, _)| k.clone())
        .collect();
    for job in lapsed {
        j.granted.remove(&job);
        j.owner.remove(&job);
        tracing::info!(job, "replay turn lapsed unused");
    }
    let (bytes, queued) = queue_usage(root, &j.flight);
    let held: u64 = j.flight.values().sum::<u64>() + j.granted.values().map(|g| g.bytes).sum::<u64>();
    let room = Room {
        bytes: s.max_queue_bytes.saturating_sub(bytes + held),
        jobs: s.max_queued.saturating_sub(queued + j.flight.len() + j.granted.len()),
        uploads: s.uploads_at_once.saturating_sub(j.uploading.len() + j.granted.len()),
        downloads: s.downloads_at_once.saturating_sub(j.downloading.len()),
    };
    let prior = prior(j);
    let order = replay_queue::fair(&j.line, |w| (w.client.as_str(), w.seq), &prior);
    let busy: HashSet<Client> = j.uploads_by_client.keys().map(IpAddr::to_string).chain(j.granted.values().map(|g| g.client.clone())).collect();
    let mut start = replay_queue::admit(&j.line, &order, room, &busy);
    j.line_order = order.iter().filter(|i| !start.contains(i)).map(|&i| j.line[i].job.clone()).collect();
    start.sort_unstable();
    for i in start.into_iter().rev() {
        let w = j.line.remove(i);
        match w.kind {
            Kind::Upload => {
                j.starts.entry(w.client.clone()).or_default().push(now);
                j.granted.insert(w.job, Grant { bytes: w.bytes, client: w.client, touched: now, at: now });
            }
            Kind::Fetch => {
                if let Some(tx) = j.turns.remove(&w.job) {
                    let _ = tx.send(());
                }
                j.flight.insert(w.job.clone(), w.bytes);
                j.downloading.insert(w.job);
            }
        }
    }
}

/// A new arrival's client and place in arrival order.
fn arrive(j: &mut Jobs, job: &str, client: &Client) -> u64 {
    j.seq += 1;
    let seq = j.seq;
    j.owner.insert(job.to_owned(), (client.clone(), seq));
    seq
}

// ---- handlers ----

/// `GET /api/boards/{board}/replays/{id}`: the replay tier's state for this board and match.
/// The board's own upload comes first, then a CDN fetch.
pub async fn status(State(app): State<AppState>, Path((board, id)): Path<(String, String)>, headers: HeaderMap) -> Response {
    if let Err(r) = role(&app, &board, &headers).await {
        return r;
    }
    if !crate::matches::valid_id(&id) {
        return err(StatusCode::BAD_REQUEST, "bad_id");
    }
    if root(&app).is_none() {
        return json(serde_json::json!({ "state": "off" }));
    }
    let mine = job_name(&id, &scope_of(&board));
    let up = job_state(&app, &mine);
    if up != State_::None {
        let mut v = state_json(&up, "upload");
        // An older parse of this board's upload: its demo is gone, so uploading it again is the
        // way to the newer layers (the client offers "Upload replay file").
        if up == State_::Done
            && let Some(stamp) = cached_stamp(&app, &mine).await
        {
            if is_stale(&stamp) {
                v["stale"] = true.into();
            }
            // Parsed on the user's machine, not by our worker (`client_timeline`).
            if stamp.source == CLIENT_SOURCE {
                v["client"] = true.into();
            }
        }
        return json(v);
    }
    let mut cdn = job_state(&app, &job_name(&id, "cdn"));
    if cdn == State_::None {
        // Why it isn't fetching on its own: the chip's hint says so.
        let j = lock();
        if let Some(why) = negative(&j, &id) {
            cdn = State_::Failed(why);
        } else if j.skipped.get(&job_name(&id, &scope_of(&board))).is_some_and(|at| at.elapsed() < SKIPPED_FOR) {
            cdn = State_::Failed("busy");
        }
    }
    // Past Valve's three weeks with nothing cached: no fetch can work, remembered or not (the
    // negative cache forgets after hours, and a restart forgets it all).
    if cdn == State_::None && crate::matches::cached_span(&app, &id).await.is_some_and(|(start, _)| expired(start)) {
        cdn = State_::Failed("expired");
    }
    json(state_json(&cdn, "cdn"))
}

/// `GET /api/boards/{board}/matches/{id}`: the richest timeline there is for this board: its
/// uploaded replay, else a fetched one, else the match metadata (v1).
pub async fn timeline(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((board, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let who = match role(&app, &board, &headers).await {
        Ok(r) => r,
        Err(r) => return r,
    };
    if !crate::matches::valid_id(&id) {
        return err(StatusCode::BAD_REQUEST, "bad_id");
    }
    if root(&app).is_some() {
        for scope in [scope_of(&board), "cdn".to_owned()] {
            if let Ok(bytes) = tokio::fs::read(cached_path(&app, &job_name(&id, &scope))).await {
                let path = if scope == "cdn" { crate::metrics::MatchPath::Fetched } else { crate::metrics::MatchPath::Uploaded };
                crate::metrics::get().matches_opened.inc((crate::metrics::Tier::Full, path));
                // A board that already had the match (no fresh attach) still upgrades an older
                // fetched timeline when an editor opens it: the same once-a-match refresh as an
                // attach (`auto_fetch`), its old timeline served meanwhile (2026-11-09: a board's
                // match kept a format-0 timeline, no respawns, because only attach checked).
                if scope == "cdn" && matches!(who, LinkRole::Owner | LinkRole::Edit) {
                    auto_fetch(&app, &board, &id, client_key(client_ip(peer, &headers)).to_string()).await;
                }
                return ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")], bytes).into_response();
            }
        }
    }
    // The board's answer changes when a replay arrives: never let a browser keep the metadata
    // (its own route says max-age, which kept the upgrade from showing).
    let mut r = crate::matches::get(State(app), ConnectInfo(peer), headers, Path(id)).await;
    r.headers_mut().insert(header::CACHE_CONTROL, axum::http::HeaderValue::from_static("no-store"));
    r
}

/// The matches a board has opened, newest first (spec §6b): kept by the server beside the board,
/// not in its document, so attaching one needs no schema change. At most this many.
pub const ATTACHED_MAX: usize = 20;

fn attached_path(app: &AppState, board: &str) -> PathBuf {
    app.config.data_dir.join("attached").join(format!("{}.json", scope_of(board)))
}

async fn read_attached(app: &AppState, board: &str) -> Vec<u64> {
    let Ok(bytes) = tokio::fs::read(attached_path(app, board)).await else { return Vec::new() };
    let ids: Vec<u64> = serde_json::from_slice(&bytes).unwrap_or_default();
    ids.into_iter().take(ATTACHED_MAX).collect()
}

/// `GET /api/boards/{board}/matches`: the matches this board has opened, newest first.
pub async fn attached(State(app): State<AppState>, Path(board): Path<String>, headers: HeaderMap) -> Response {
    if let Err(r) = role(&app, &board, &headers).await {
        return r;
    }
    json(serde_json::json!({ "matches": read_attached(&app, &board).await }))
}

/// `PUT /api/boards/{board}/matches/{id}`: an editor attaches a match to the board (it moves to
/// the front if it was there already).
pub async fn attach(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((board, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = editor(&app, &board, &headers).await {
        return r;
    }
    if !crate::matches::valid_id(&id) {
        return err(StatusCode::BAD_REQUEST, "bad_id");
    }
    let Ok(n) = id.parse::<u64>() else { return err(StatusCode::BAD_REQUEST, "bad_id") };
    if let Some(why) = crate::matches::refused(&app, &id).await {
        return err(StatusCode::UNPROCESSABLE_ENTITY, why);
    }
    let mut ids = read_attached(&app, &board).await;
    ids.retain(|x| *x != n);
    ids.insert(0, n);
    ids.truncate(ATTACHED_MAX);
    let path = attached_path(&app, &board);
    let bytes = serde_json::to_vec(&ids).unwrap_or_default();
    let written = tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(path.parent().unwrap_or(FsPath::new(".")))?;
        write_atomic(&path, &bytes)
    })
    .await;
    match written {
        Ok(Ok(())) => {
            auto_fetch(&app, &board, &id, client_key(client_ip(peer, &headers)).to_string()).await;
            json(serde_json::json!({ "matches": ids }))
        }
        _ => err(StatusCode::INTERNAL_SERVER_ERROR, "internal"),
    }
}

/// A clone carries its source's matches (operator, 2026-11-09: "we lose the replay player when
/// we clone a board"): the match list and each uploaded timeline are kept beside the board by
/// its id's hash, so a copy of the document alone opened with no match. Fetched timelines are
/// shared by every board already. An uploaded one is hard-linked under the clone's own scope: no
/// new parse, and the two names live apart (a re-upload or the cache's trim replaces or removes
/// one name, never the other's bytes). Access: any link that may clone may already read these
/// (`timeline` asks only for a role), so the clone sees nothing its source's links didn't; the
/// names carry only the clone's hash. An upload still under way isn't carried. Best effort: the
/// clone is made either way.
pub async fn carry_to_clone(app: &AppState, from: &str, to: &str) {
    let ids = read_attached(app, from).await;
    if ids.is_empty() {
        return;
    }
    let (list, cache) = (attached_path(app, to), cache_dir(app));
    let (from, to) = (scope_of(from), scope_of(to));
    let carried = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        for id in &ids {
            let src = cache.join(format!("{}.json", job_name(&id.to_string(), &from)));
            let dst = cache.join(format!("{}.json", job_name(&id.to_string(), &to)));
            match std::fs::hard_link(&src, &dst) {
                Ok(()) => {}
                Err(_) if !src.exists() => {} // no upload of this match on the source
                Err(_) => {
                    // Another filesystem, or links refused: a copy, renamed in.
                    let tmp = dst.with_extension("tmp");
                    std::fs::copy(&src, &tmp)?;
                    std::fs::rename(&tmp, &dst)?;
                }
            }
        }
        std::fs::create_dir_all(list.parent().unwrap_or(FsPath::new(".")))?;
        write_atomic(&list, &serde_json::to_vec(&ids).unwrap_or_default())
    })
    .await;
    if !matches!(carried, Ok(Ok(()))) {
        tracing::warn!("a clone's matches not carried");
    }
}

/// The matches a board has opened, newest first, for its export (boardfile.rs).
pub async fn attached_ids(app: &AppState, board: &str) -> Vec<u64> {
    read_attached(app, board).await
}

/// An imported board's matches (boardfile.rs, spec §6): the file's list, by id only, as an
/// attach would leave it. Ids out of range, repeats and matches refused for their mode are
/// dropped; at most [`ATTACHED_MAX`]. No timeline comes with a file: the newest match starts
/// its fetch from Valve as an attach does, and a match only an upload had asks for the replay
/// again where it can't come (the prompt, §6b). Returns the list kept.
pub async fn attach_imported(app: &AppState, board: &str, ids: &[u64], client: Client) -> Vec<u64> {
    let mut kept: Vec<u64> = Vec::new();
    for &n in ids {
        if kept.len() >= ATTACHED_MAX {
            break;
        }
        let id = n.to_string();
        if !crate::matches::valid_id(&id) || kept.contains(&n) || crate::matches::refused(app, &id).await.is_some() {
            continue;
        }
        kept.push(n);
    }
    let Some(&first) = kept.first() else { return kept };
    let path = attached_path(app, board);
    let bytes = serde_json::to_vec(&kept).unwrap_or_default();
    let written = tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(path.parent().unwrap_or(FsPath::new(".")))?;
        write_atomic(&path, &bytes)
    })
    .await;
    if !matches!(written, Ok(Ok(()))) {
        tracing::warn!("an imported board's matches not written");
        return Vec::new();
    }
    auto_fetch(app, board, &first.to_string(), client).await;
    kept
}

/// Whether a match that started at `start` (unix seconds) is past Valve's three weeks.
fn expired(start: u64) -> bool {
    unix_now().saturating_sub(start) > REPLAY_KEPT_S
}

/// Opening a match tries for its full replay on its own (operator, 2026-11-08): the CDN fetch
/// starts unless the replay is there or coming (fetched, or this board's upload), the match is
/// past Valve's three weeks, or its fetch can't work for now (`negative`: that includes a match
/// whose lookup met deadlock-api's backoff). A backoff alone doesn't stop it: the match's salts
/// may be a stored row, read for free (`salts`). The mode refusal came first (`attach`). One job
/// for every board.
///
/// A fetched timeline in an older format than the worker's is fetched and parsed again, once a
/// match, the same way (the same line, caps and fairness), while the old one is served; the new
/// one replaces it when it's parsed. Past the three weeks the old one stays.
async fn auto_fetch(app: &AppState, board: &str, id: &str, client: Client) {
    let Some(root) = root(app).map(FsPath::to_owned) else { return };
    let job = job_name(id, "cdn");
    let refresh = match job_state(app, &job) {
        State_::None => false,
        State_::Done => {
            let tried = lock().refreshed.contains(id);
            if tried || !stale(app, &job).await {
                return;
            }
            true
        }
        _ => return,
    };
    if job_state(app, &job_name(id, &scope_of(board))) != State_::None {
        return; // this board's own upload, done or under way (or just failed)
    }
    {
        let j = lock();
        if j.fetching.contains(&job) || negative(&j, id).is_some() {
            return;
        }
    }
    let Some((start, ended)) = crate::matches::cached_span(app, id).await else { return };
    let mut j = lock();
    if expired(start) {
        j.negative.insert(id.to_owned(), ("expired", Instant::now() + NEGATIVE_FOR));
        return;
    }
    if j.fetching.contains(&job) || negative(&j, id).is_some() {
        return;
    }
    let mine = job_name(id, &scope_of(board));
    j.skipped.retain(|_, at| at.elapsed() < SKIPPED_FOR);
    if fetch_refused(&j, &client).is_some() {
        j.skipped.insert(mine, Instant::now());
        return;
    }
    j.skipped.remove(&mine);
    if refresh && !j.refreshed.insert(id.to_owned()) {
        return; // another open got there first
    }
    j.fetching.insert(job.clone());
    let turn = enqueue_fetch(&mut j, &root, &job, &client);
    drop(j);
    tracing::info!(job, refresh, "replay fetch started on open");
    spawn_fetch(root, id.to_owned(), job, turn, Some(ended));
}

/// `POST /api/boards/{board}/replays/{id}/upload`: an editor's `.dem`, streamed to the queue.
pub async fn upload(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((board, id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if let Err(r) = editor(&app, &board, &headers).await {
        return r;
    }
    if !crate::matches::valid_id(&id) {
        return err(StatusCode::BAD_REQUEST, "bad_id");
    }
    if let Some(why) = crate::matches::refused(&app, &id).await {
        return err(StatusCode::UNPROCESSABLE_ENTITY, why);
    }
    let Some(root) = root(&app).map(FsPath::to_owned) else { return err(StatusCode::SERVICE_UNAVAILABLE, "replays_off") };
    let s = settings();
    let declared = headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > s.max_upload) {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "too_large");
    }
    let job = job_name(&id, &scope_of(&board));
    match job_state(&app, &job) {
        State_::Uploading | State_::Queued(..) | State_::Parsing | State_::Fetching => return err(StatusCode::CONFLICT, "in_progress"),
        _ => {}
    }
    let client = client_key(client_ip(peer, &headers));
    let cap = {
        let mut j = lock();
        if j.uploads_by_client.get(&client).copied().unwrap_or(0) >= 1 {
            return err(StatusCode::TOO_MANY_REQUESTS, "busy");
        }
        if j.uploading.contains(&job) {
            return err(StatusCode::CONFLICT, "in_progress");
        }
        // Its reservation's turn came (the client reserved first, spec §6a; the turn counted
        // against the hourly limit when given), or it takes a turn now if one is free for it;
        // else the line is ahead of it.
        let cap = match j.granted.get(&job) {
            Some(g) => g.bytes.min(s.max_upload),
            None => {
                if j.line.iter().any(|w| w.job == job) {
                    return err(StatusCode::SERVICE_UNAVAILABLE, "queue_full");
                }
                if over_limit(&mut j, &client.to_string()) {
                    return err(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
                }
                let bytes = declared.unwrap_or(s.max_upload);
                let seq = arrive(&mut j, &job, &client.to_string());
                j.line.push(Waiting { job: job.clone(), client: client.to_string(), kind: Kind::Upload, seq, bytes, touched: Instant::now() });
                schedule(&mut j, &root);
                if !j.granted.contains_key(&job) {
                    j.line.retain(|w| w.job != job);
                    j.owner.remove(&job);
                    j.line_order.retain(|q| *q != job);
                    return err(StatusCode::SERVICE_UNAVAILABLE, "queue_full");
                }
                bytes
            }
        };
        let g = j.granted.remove(&job);
        if !j.owner.contains_key(&job) {
            arrive(&mut j, &job, &g.map_or_else(|| client.to_string(), |g| g.client));
        }
        j.uploading.insert(job.clone());
        j.flight.insert(job.clone(), cap);
        *j.uploads_by_client.entry(client).or_default() += 1;
        j.failed.remove(&job);
        cap
    };
    // Released however the upload ends, a dropped connection included (hyper drops this
    // future): the slot frees and a partial file goes.
    let slot = UploadSlot { job: job.clone(), client, root: root.clone() };
    let result = receive(&root, &job, body, s, cap).await;
    drop(slot);
    match result {
        Ok(bytes) => {
            // A new upload replaces this board's older timeline for the match.
            let _ = tokio::fs::remove_file(cache_dir(&app).join(format!("{job}.json"))).await;
            tracing::info!(match_id = id, bytes, "replay uploaded");
            (StatusCode::ACCEPTED, axum::Json(serde_json::json!({ "state": "queued", "source": "upload" }))).into_response()
        }
        Err((code, why)) => err(code, why),
    }
}

/// A client may hold this many reservations waiting at once (its tabs and boards together).
const PER_CLIENT_WAITING: usize = 4;

#[derive(Deserialize)]
struct ReserveBody {
    bytes: u64,
}

/// `POST /api/boards/{board}/replays/{id}/reserve` `{"bytes": n}`: an editor's place in line
/// for an upload of `n` bytes (spec §6a). The client asks again every few seconds, which keeps
/// the reservation; one not asked about for `REPLAY_RESERVE_TTL_S` lapses. It answers `ready`
/// (send the file now), `waiting` with how many are ahead, or `done` when the board already
/// has the match's fetched replay (nothing to send).
pub async fn reserve(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((board, id)): Path<(String, String)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if let Err(r) = editor(&app, &board, &headers).await {
        return r;
    }
    if !crate::matches::valid_id(&id) {
        return err(StatusCode::BAD_REQUEST, "bad_id");
    }
    if let Some(why) = crate::matches::refused(&app, &id).await {
        return err(StatusCode::UNPROCESSABLE_ENTITY, why);
    }
    let Some(root) = root(&app).map(FsPath::to_owned) else { return err(StatusCode::SERVICE_UNAVAILABLE, "replays_off") };
    let Ok(ReserveBody { bytes }) = serde_json::from_slice(&body) else { return err(StatusCode::BAD_REQUEST, "bad_request") };
    let s = settings();
    if bytes > s.max_upload {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "too_large");
    }
    if bytes < 8 {
        return err(StatusCode::UNSUPPORTED_MEDIA_TYPE, "not_a_replay");
    }
    // The match's replay from Valve is here already, or being fetched again in a newer format:
    // the board uses it (spec §6a, Dedupe).
    if cached_path(&app, &job_name(&id, "cdn")).exists() {
        return json(state_json(&State_::Done, "cdn"));
    }
    let job = job_name(&id, &scope_of(&board));
    match job_state(&app, &job) {
        State_::Uploading | State_::Queued(..) | State_::Parsing => return err(StatusCode::CONFLICT, "in_progress"),
        _ => {}
    }
    let client = client_key(client_ip(peer, &headers)).to_string();
    let mut j = lock();
    let now = Instant::now();
    if let Some(g) = j.granted.get_mut(&job) {
        g.touched = now;
        g.bytes = g.bytes.max(bytes);
        return json(serde_json::json!({ "state": "ready", "source": "upload" }));
    }
    if let Some(w) = j.line.iter_mut().find(|w| w.job == job) {
        w.touched = now;
        w.bytes = bytes;
    } else {
        if over_limit(&mut j, &client) {
            return err(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
        }
        if j.line.iter().filter(|w| w.kind == Kind::Upload && w.client == client).count() >= PER_CLIENT_WAITING {
            return err(StatusCode::TOO_MANY_REQUESTS, "busy");
        }
        // The last resort: a line this long won't move for a long while.
        if j.line.len() >= s.max_waiting {
            return err(StatusCode::SERVICE_UNAVAILABLE, "queue_full");
        }
        let seq = arrive(&mut j, &job, &client);
        j.line.push(Waiting { job: job.clone(), client, kind: Kind::Upload, seq, bytes, touched: now });
        j.failed.remove(&job);
    }
    schedule(&mut j, &root);
    if j.granted.contains_key(&job) {
        return json(serde_json::json!({ "state": "ready", "source": "upload" }));
    }
    let ahead = line_place(&j, &job).map_or(j.line.len(), |(a, _)| a);
    json(state_json(&State_::Waiting(ahead), "upload"))
}

/// `DELETE /api/boards/{board}/replays/{id}/reserve`: the editor gave up waiting (cancelled).
pub async fn release(State(app): State<AppState>, Path((board, id)): Path<(String, String)>, headers: HeaderMap) -> Response {
    if let Err(r) = editor(&app, &board, &headers).await {
        return r;
    }
    if !crate::matches::valid_id(&id) {
        return err(StatusCode::BAD_REQUEST, "bad_id");
    }
    let Some(root) = root(&app).map(FsPath::to_owned) else { return err(StatusCode::SERVICE_UNAVAILABLE, "replays_off") };
    let job = job_name(&id, &scope_of(&board));
    let mut j = lock();
    let had = j.granted.remove(&job).is_some() || j.line.iter().any(|w| w.job == job && w.kind == Kind::Upload);
    j.line.retain(|w| !(w.job == job && w.kind == Kind::Upload));
    if had {
        j.owner.remove(&job);
        schedule(&mut j, &root);
    }
    StatusCode::NO_CONTENT.into_response()
}

/// Why a client-parsed timeline was refused: the status and the code (`{"error": code}`).
type Refusal = (StatusCode, &'static str);

/// Read a body of at most `cap` bytes, `idle` at most between chunks.
async fn read_capped_body(body: Body, cap: u64, idle: Duration) -> Result<Vec<u8>, Refusal> {
    let mut stream = body.into_data_stream();
    let mut out = Vec::new();
    loop {
        match tokio::time::timeout(idle, stream.next()).await {
            Err(_) => return Err((StatusCode::REQUEST_TIMEOUT, "timeout")),
            Ok(None) => return Ok(out),
            Ok(Some(Err(_))) => return Err((StatusCode::BAD_REQUEST, "aborted")),
            Ok(Some(Ok(chunk))) => {
                if (out.len() + chunk.len()) as u64 > cap {
                    return Err((StatusCode::PAYLOAD_TOO_LARGE, "too_large"));
                }
                out.extend_from_slice(&chunk);
            }
        }
    }
}

/// A client-parsed timeline's body to its checked, server-stamped bytes: decoded under the
/// decoded cap (`timeline::MAX_BYTES`, so a gzip bomb stops there), its format stamp checked
/// before anything else (an old app hears "update", not a shape error), then the same checks a
/// worker's timeline gets (`collect`), and `source` set to `client` by the server.
fn check_client_timeline(body: &[u8], gzip: bool, match_id: u64) -> Result<Vec<u8>, Refusal> {
    use mapcro_replay::timeline::{FORMAT, MAX_BYTES, validate};
    use std::io::Read;
    let unprocessable = StatusCode::UNPROCESSABLE_ENTITY;
    let decoded;
    let json = if gzip {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(body).take(MAX_BYTES + 1).read_to_end(&mut out).map_err(|_| (StatusCode::BAD_REQUEST, "bad_encoding"))?;
        decoded = out;
        &decoded[..]
    } else {
        body
    };
    if json.len() as u64 > MAX_BYTES {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "too_large"));
    }
    #[derive(Deserialize)]
    struct Stamp {
        #[serde(default)]
        format: u32,
    }
    let Stamp { format } = serde_json::from_slice(json).map_err(|_| (unprocessable, "not_a_timeline"))?;
    if format < FORMAT {
        return Err((unprocessable, "outdated_parser"));
    }
    if format > FORMAT {
        return Err((unprocessable, "newer_parser"));
    }
    let mut t = validate(json).map_err(|_| (unprocessable, "not_a_timeline"))?;
    if t.match_id != match_id {
        return Err((unprocessable, "wrong_match"));
    }
    t.source = CLIENT_SOURCE.to_owned();
    serde_json::to_vec(&t).map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "internal"))
}

/// The `source` the server stamps on a timeline parsed on the user's machine.
pub(crate) const CLIENT_SOURCE: &str = "client";

/// A refusal's words for the person: only where the code alone doesn't say what to do.
fn refusal_message(code: &str) -> Option<&'static str> {
    match code {
        "outdated_parser" => Some("Update the mapcro app"),
        "newer_parser" => Some("This mapcro app is newer than the server. Try again later"),
        _ => None,
    }
}

/// `POST /api/boards/{board}/replays/{id}/timeline`: a timeline parsed on the user's machine
/// (the desktop app, later a parse in the browser), JSON, gzipped (`Content-Encoding: gzip`) or
/// not (spec §6a, "Timelines parsed on the user's machine"). It takes no queue slot and no parse:
/// it is checked as a worker's timeline is and cached for this board alone, as an upload's is
/// (a forger reaches only a board they can draw on anyway). The mode refusal holds as for
/// uploads: the timeline carries no mode, so only the match's metadata can say Brawl.
pub async fn client_timeline(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((board, id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if let Err(r) = editor(&app, &board, &headers).await {
        return r;
    }
    if !crate::matches::valid_id(&id) {
        return err(StatusCode::BAD_REQUEST, "bad_id");
    }
    let Ok(match_id) = id.parse::<u64>() else { return err(StatusCode::BAD_REQUEST, "bad_id") };
    if let Some(why) = crate::matches::refused(&app, &id).await {
        return err(StatusCode::UNPROCESSABLE_ENTITY, why);
    }
    if root(&app).is_none() {
        return err(StatusCode::SERVICE_UNAVAILABLE, "replays_off");
    }
    let s = settings();
    let encoding = headers.get(header::CONTENT_ENCODING).map(|v| v.to_str().unwrap_or("?").trim().to_ascii_lowercase());
    let gzip = match encoding.as_deref() {
        None | Some("identity") => false,
        Some("gzip" | "x-gzip") => true,
        Some(_) => return err(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_encoding"),
    };
    // Sent plain, the body is the decoded timeline: its cap is the decoded one.
    let cap = if gzip { s.max_timeline_body } else { mapcro_replay::timeline::MAX_BYTES };
    let declared = headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    let started = Instant::now();
    let refused = |code: StatusCode, why: &'static str| {
        job_ended_as(crate::metrics::Source::Client, crate::metrics::JobOutcome::from_code(why), started.elapsed().as_secs_f64());
        let mut v = serde_json::json!({ "error": why });
        if let Some(m) = refusal_message(why) {
            v["message"] = m.into();
        }
        (code, axum::Json(v)).into_response()
    };
    if declared.is_some_and(|n| n > cap) {
        return refused(StatusCode::PAYLOAD_TOO_LARGE, "too_large");
    }
    let job = job_name(&id, &scope_of(&board));
    match job_state(&app, &job) {
        State_::Uploading | State_::Queued(..) | State_::Parsing => return err(StatusCode::CONFLICT, "in_progress"),
        _ => {}
    }
    {
        // Every timeline sent counts, taken or not: the check is the cost.
        let client = client_key(client_ip(peer, &headers)).to_string();
        let mut j = lock();
        let now = Instant::now();
        j.timelines.retain(|_, v| {
            v.retain(|t| now.duration_since(*t) < HOUR);
            !v.is_empty()
        });
        let sent = j.timelines.entry(client).or_default();
        if sent.len() >= s.timelines_per_client {
            drop(j);
            return err(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
        }
        sent.push(now);
    }
    let bytes = match read_capped_body(body, cap, s.idle).await {
        Ok(b) => b,
        Err((code, why)) => return refused(code, why),
    };
    let path = cached_path(&app, &job);
    let checked = tokio::task::spawn_blocking(move || {
        let out = check_client_timeline(&bytes, gzip, match_id)?;
        write_atomic(&path, &out).map_err(|e| {
            tracing::error!(error = %e, "client timeline not written");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal")
        })?;
        Ok::<usize, Refusal>(out.len())
    })
    .await
    .unwrap_or(Err((StatusCode::INTERNAL_SERVER_ERROR, "internal")));
    match checked {
        Ok(n) => {
            lock().failed.remove(&job);
            job_ended_as(crate::metrics::Source::Client, crate::metrics::JobOutcome::Done, started.elapsed().as_secs_f64());
            tracing::info!(match_id = id, bytes = n, "client timeline cached");
            let mut v = state_json(&State_::Done, "upload");
            v["client"] = true.into();
            json(v)
        }
        Err((code, why)) => {
            tracing::info!(match_id = id, why, "client timeline refused");
            refused(code, why)
        }
    }
}

/// An upload in flight: its place in the limits, and its partial file.
struct UploadSlot {
    job: String,
    client: IpAddr,
    root: PathBuf,
}

impl Drop for UploadSlot {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.root.join("inbox").join(format!(".{}.part", self.job)));
        let mut j = lock();
        j.uploading.remove(&self.job);
        j.flight.remove(&self.job);
        if !exists_any(&self.root.join("inbox"), &self.job) {
            j.owner.remove(&self.job); // it never reached the queue
        }
        if let Some(n) = j.uploads_by_client.get_mut(&self.client) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                j.uploads_by_client.remove(&self.client);
            }
        }
        // Its room is free (or its file now holds it): the next in line may start.
        schedule(&mut j, &self.root);
    }
}

/// Stream `body` to `inbox/.<job>.part` under the caps, check the magic, then queue it.
async fn receive(root: &FsPath, job: &str, body: Body, s: &Settings, cap: u64) -> Result<u64, (StatusCode, &'static str)> {
    let inbox = root.join("inbox");
    let part = inbox.join(format!(".{job}.part"));
    // Never through a link, never over a file that's there (security review 2026-11-08, M1).
    let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).custom_flags(libc::O_NOFOLLOW).open(&part).await.map_err(|e| {
        tracing::error!(error = %e, "replay inbox not writable");
        (StatusCode::INTERNAL_SERVER_ERROR, "internal")
    })?;
    file.set_permissions(group_readable()).await.map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "internal"))?;
    let deadline = tokio::time::Instant::now() + s.transfer;
    let mut stream = body.into_data_stream();
    let mut n: u64 = 0;
    let mut head: Vec<u8> = Vec::with_capacity(8);
    let outcome: Result<(), (StatusCode, &'static str)> = async {
        loop {
            let wait = s.idle.min(deadline.saturating_duration_since(tokio::time::Instant::now()));
            let chunk = match tokio::time::timeout(wait, stream.next()).await {
                Err(_) => return Err((StatusCode::REQUEST_TIMEOUT, "timeout")),
                Ok(None) => break,
                Ok(Some(Err(_))) => return Err((StatusCode::BAD_REQUEST, "aborted")),
                Ok(Some(Ok(c))) => c,
            };
            n += chunk.len() as u64;
            if n > cap {
                return Err((StatusCode::PAYLOAD_TOO_LARGE, "too_large"));
            }
            if head.len() < 8 {
                head.extend(chunk.iter().take(8 - head.len()));
                if head.len() == 8 && head != mapcro_replay::DEM_MAGIC {
                    return Err((StatusCode::UNSUPPORTED_MEDIA_TYPE, "not_a_replay"));
                }
            }
            file.write_all(&chunk).await.map_err(|_| (StatusCode::INSUFFICIENT_STORAGE, "queue_full"))?;
        }
        if head.len() < 8 {
            return Err((StatusCode::UNSUPPORTED_MEDIA_TYPE, "not_a_replay"));
        }
        file.flush().await.map_err(|_| (StatusCode::INSUFFICIENT_STORAGE, "queue_full"))?;
        Ok(())
    }
    .await;
    drop(file);
    match outcome {
        Ok(()) => {
            tokio::fs::rename(&part, inbox.join(format!("{job}.dem"))).await.map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "internal"))?;
            Ok(n)
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(e)
        }
    }
}

/// `POST /api/boards/{board}/replays/{id}/fetch`: fetch the match's demo from Valve's CDN
/// (salts from deadlock-api), for every board. "Fetch replay": it tries again past a failure.
pub async fn fetch(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((board, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = editor(&app, &board, &headers).await {
        return r;
    }
    if !crate::matches::valid_id(&id) {
        return err(StatusCode::BAD_REQUEST, "bad_id");
    }
    if let Some(why) = crate::matches::refused(&app, &id).await {
        return err(StatusCode::UNPROCESSABLE_ENTITY, why);
    }
    let Some(root) = root(&app).map(FsPath::to_owned) else { return err(StatusCode::SERVICE_UNAVAILABLE, "replays_off") };
    let ended = crate::matches::cached_span(&app, &id).await.map(|(_, end)| end);
    let job = job_name(&id, "cdn");
    match job_state(&app, &job) {
        // A failure is tried again: pressing "Fetch replay" goes past the negative cache.
        State_::None | State_::Failed(_) => {}
        st => return (StatusCode::ACCEPTED, axum::Json(state_json(&st, "cdn"))).into_response(),
    }
    let turn = {
        let mut j = lock();
        if j.fetching.contains(&job) {
            return (StatusCode::ACCEPTED, axum::Json(state_json(&State_::Fetching, "cdn"))).into_response();
        }
        // deadlock-api's rate limit is the one limit a press doesn't go past: a match whose
        // lookup met it waits for the backoff (any other may be a stored row, read for free).
        if limited(&j) && negative(&j, &id) == Some("upstream_limited") {
            return err(StatusCode::TOO_MANY_REQUESTS, "upstream_limited");
        }
        // A client waits for a few at once, and the line has its last resort: a fetch waiting
        // costs nothing to ask for, so it's capped like a reservation.
        let client = client_key(client_ip(peer, &headers)).to_string();
        if let Some((code, why)) = fetch_refused(&j, &client) {
            return err(code, why);
        }
        j.failed.remove(&job);
        j.negative.remove(&id);
        j.fetching.insert(job.clone());
        enqueue_fetch(&mut j, &root, &job, &client)
    };
    spawn_fetch(root, id, job, turn, ended);
    (StatusCode::ACCEPTED, axum::Json(state_json(&State_::Fetching, "cdn"))).into_response()
}

/// A fetch joins the line (fair across clients, beside uploads) and starts if there's room. The
/// receiver hears when its download may start.
fn enqueue_fetch(j: &mut Jobs, root: &FsPath, job: &str, client: &Client) -> tokio::sync::oneshot::Receiver<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    j.turns.insert(job.to_owned(), tx);
    let seq = arrive(j, job, client);
    j.line.push(Waiting { job: job.to_owned(), client: client.clone(), kind: Kind::Fetch, seq, bytes: settings().max_download, touched: Instant::now() });
    schedule(j, root);
    rx
}

/// Run a fetch already in `fetching` and in line: wait to be told its turn came (a download slot
/// and the queue's room; a burst waits rather than being refused), then salts, then the demo.
/// Its failure is recorded. `ended`: the match's end (unix seconds), when its metadata is cached.
fn spawn_fetch(root: PathBuf, id: String, job: String, turn: tokio::sync::oneshot::Receiver<()>, ended: Option<u64>) {
    tokio::spawn(async move {
        let s = settings();
        let told = tokio::time::timeout(s.stale, turn).await;
        let outcome = {
            let mut j = lock();
            if j.downloading.contains(&job) {
                Ok(())
            } else if told.is_err() {
                // Waited past the stale limit: it gives up its place.
                j.line.retain(|w| w.job != job);
                j.turns.remove(&job);
                Err(("queue_full", None))
            } else {
                Err(("internal", None)) // dropped from the line
            }
        };
        let began = Instant::now();
        let outcome = match outcome {
            Ok(()) => {
                let (r2, id2, j2) = (root.clone(), id.clone(), job.clone());
                tokio::task::spawn_blocking(move || {
                    salts(&id2, ended).and_then(|(cluster, salt)| {
                        let t = Instant::now();
                        let n = download(&r2, &id2, &j2, cluster, salt).map_err(|why| (why, None))?;
                        crate::metrics::get().download_s.observe((), t.elapsed().as_secs_f64());
                        Ok(n)
                    })
                })
                .await
                .unwrap_or(Err(("upstream_down", None)))
            }
            Err(e) => Err(e),
        };
        let mut j = lock();
        j.fetching.remove(&job);
        j.downloading.remove(&job);
        j.flight.remove(&job);
        match &outcome {
            Ok(_) => j.stats.downloaded(began.elapsed().as_secs_f64()),
            Err(_) => {
                j.owner.remove(&job);
            }
        }
        // Its slot is free: the next in line may start.
        schedule(&mut j, &root);
        match outcome {
            Ok(bytes) => tracing::info!(job, bytes, "replay fetched"),
            Err((why, retry_after)) => {
                tracing::info!(job, why, "replay fetch failed");
                job_ended(&job, crate::metrics::JobOutcome::from_code(why), began.elapsed().as_secs_f64());
                // The status reads each from where it's kept: the backoff, the match's negative
                // cache, or (ours, not the match's) the job's failure.
                match why {
                    // Only this match waits for the backoff: its lookup is the kind that spends the
                    // Steam budget. Others still read their stored rows.
                    "upstream_limited" => {
                        if retry_after.is_some() || !limited(&j) {
                            back_off(&mut j, retry_after);
                        }
                        let until = j.backoff.map_or_else(|| Instant::now() + BACKOFF_FIRST, |(until, _)| until);
                        j.negative.insert(id, (why, until));
                    }
                    "no_replay" => {
                        j.negative.insert(id, (why, Instant::now() + no_replay_for(ended, unix_now())));
                    }
                    "queue_full" | "internal" => {
                        j.failed.insert(job, (why, Instant::now()));
                    }
                    _ => {
                        j.negative.insert(id, (why, Instant::now() + NEGATIVE_FOR));
                    }
                }
            }
        }
    });
}

#[derive(Deserialize)]
struct Salts {
    cluster_id: Option<u32>,
    replay_salt: Option<u64>,
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .max_redirects(0)
        .user_agent("mapcro (https://mapcro.dmgdeadlock.com)")
        .build()
        .into()
}

/// How one salts read went.
#[derive(Debug, PartialEq)]
enum Read {
    Salts(u32, u64),
    /// A stored row without a replay salt.
    NoSalt,
    /// No row (404). From a free read: the match isn't in its database. From a Steam-capable
    /// one: the GC had nothing (`steam_failed`, an invalid match).
    NoRow,
    /// The free 400 "won't be fetched, as it has metadata already": no row, and Steam won't be
    /// asked for this match. Checked before the limiter, so it spends nothing.
    HasMetadata,
    Limited(Option<Duration>),
}

/// The match's replay salts from deadlock-api, or why not (with a 429's `Retry-After`). Blocking.
/// deadlock-api answers a stored row before its rate limiter, so reading a match it has costs
/// nothing; only a match with no row (and no metadata: that's a free 400) reaches the limiter, 3
/// an hour per address (300 with a key), and then the GC, the one path that can create a working
/// replay salt (docs/research/deadlock-api-salts.md "When the backend asks the GC", "Results").
/// So the free read (`disable_steam=true`) goes first, whatever the backoff; the Steam-capable
/// one only for a match with no row that is past the salts pass (`fresh`) while we aren't backed
/// off.
fn salts(id: &str, ended: Option<u64>) -> Result<(u32, u64), (&'static str, Option<Duration>)> {
    let no = |why| Err((why, None));
    match read_salts(id, false).map_err(|why| (why, None))? {
        Read::Salts(cluster, salt) => return Ok((cluster, salt)),
        Read::NoSalt | Read::HasMetadata => return no("no_replay"),
        Read::Limited(after) => return Err(("upstream_limited", after)),
        Read::NoRow => {}
    }
    if fresh(ended, unix_now()) {
        return no("no_replay");
    }
    if limited(&lock()) {
        return no("upstream_limited");
    }
    match read_salts(id, true).map_err(|why| (why, None))? {
        Read::Salts(cluster, salt) => Ok((cluster, salt)),
        Read::NoSalt | Read::NoRow | Read::HasMetadata => no("no_replay"),
        Read::Limited(after) => Err(("upstream_limited", after)),
    }
}

/// One read of the salts endpoint: free (`steam: false`, `disable_steam=true`) or one that may
/// ask Steam. Counted under its own endpoint, so `stats` shows the Steam-capable ones apart.
fn read_salts(id: &str, steam: bool) -> Result<Read, &'static str> {
    use crate::metrics::{ApiResult, Endpoint};
    let s = settings();
    let (endpoint, query) = if steam { (Endpoint::SaltsSteam, "") } else { (Endpoint::Salts, "?disable_steam=true") };
    let called = |r: ApiResult| crate::matches::upstream(endpoint, r);
    let mut r = crate::matches::api_get(&agent(Duration::from_secs(20)), &format!("{}/v1/matches/{id}/salts{query}", s.api_base)).call().map_err(|e| {
        called(ApiResult::of_error(&e));
        "upstream_down"
    })?;
    match r.status().as_u16() {
        200 => {}
        404 => {
            called(ApiResult::NotFound);
            return Ok(Read::NoRow);
        }
        429 => {
            called(ApiResult::RateLimited);
            let after = r.headers().get(header::RETRY_AFTER).and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok()).map(Duration::from_secs);
            return Ok(Read::Limited(after));
        }
        400 if r.body_mut().with_config().limit(4 * 1024).read_to_string().is_ok_and(|b| b.contains("metadata already")) => {
            // An answer, as a 404 is: there are no salts to have.
            called(ApiResult::NotFound);
            return Ok(Read::HasMetadata);
        }
        status => {
            called(ApiResult::of_status(status));
            return Err("upstream_down");
        }
    }
    let salts: Salts = r.body_mut().with_config().limit(64 * 1024).read_json().map_err(|e| {
        called(ApiResult::of_error(&e));
        "upstream_shape"
    })?;
    called(ApiResult::Ok);
    Ok(match (salts.cluster_id, salts.replay_salt) {
        (Some(cluster), Some(salt)) => Read::Salts(cluster, salt),
        _ => Read::NoSalt,
    })
}

/// The demo, streamed to `inbox/.<job>.part` under the size cap. Blocking.
fn download(root: &FsPath, id: &str, job: &str, cluster: u32, salt: u64) -> Result<u64, &'static str> {
    let s = settings();
    // Built from two numbers, never taken from the response: it can only name Valve's CDN.
    let url = match &s.cdn_base {
        Some(base) => format!("{base}/{cluster}/1422450/{id}_{salt}.dem.bz2"),
        None => format!("http://replay{cluster}.valve.net/1422450/{id}_{salt}.dem.bz2"),
    };
    let mut r = agent(s.transfer).get(&url).call().map_err(|_| "upstream_down")?;
    match r.status().as_u16() {
        200 => {}
        404 | 403 => return Err("no_replay"),
        _ => return Err("upstream_down"),
    }
    let part = root.join("inbox").join(format!(".{job}.part"));
    let result = (|| {
        let mut file = new_file(&part).map_err(|_| "internal")?;
        file.set_permissions(group_readable()).map_err(|_| "internal")?;
        let mut reader = r.body_mut().with_config().limit(s.max_download).reader();
        let mut head = [0u8; 8];
        let mut got = 0;
        while got < 8 {
            match std::io::Read::read(&mut reader, &mut head[got..]) {
                Ok(0) => break,
                Ok(k) => got += k,
                Err(_) => return Err("upstream_down"),
            }
        }
        let head = &head[..got];
        let ext = if head == mapcro_replay::DEM_MAGIC {
            "dem"
        } else if mapcro_replay::is_bz2(head) {
            "bz2"
        } else if head.starts_with(mapcro_replay::ZSTD_MAGIC) {
            "zst"
        } else {
            return Err("not_a_replay");
        };
        std::io::Write::write_all(&mut file, head).map_err(|_| "queue_full")?;
        let n = std::io::copy(&mut reader, &mut file).map_err(|e| {
            // ureq reports the cap as an I/O error wrapping BodyExceedsLimit.
            if e.to_string().contains("limit") { "too_large" } else { "upstream_down" }
        })?;
        Ok((ext, n + got as u64))
    })();
    match result {
        Ok((ext, n)) => {
            std::fs::rename(&part, root.join("inbox").join(format!("{job}.{ext}"))).map_err(|_| "internal")?;
            Ok(n)
        }
        Err(why) => {
            let _ = std::fs::remove_file(&part);
            Err(why)
        }
    }
}

// ---- the collector: results in, stale jobs out ----

/// Make the queue's directories if they're missing (the NixOS module makes them with the
/// right owners), then collect results every second.
pub fn spawn(app: AppState) {
    let Some(root) = root(&app).map(FsPath::to_owned) else { return };
    for d in ["inbox", "outbox", "work"] {
        let _ = std::fs::create_dir_all(root.join(d));
    }
    let _ = std::fs::create_dir_all(cache_dir(&app));
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let (root, cache) = (root.clone(), cache_dir(&app));
            let _ = tokio::task::spawn_blocking(move || collect(&root, &cache)).await;
        }
    });
}

/// A new file, never through a symbolic link or over an existing file.
fn new_file(path: &FsPath) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().write(true).create_new(true).custom_flags(libc::O_NOFOLLOW).open(path)
}

/// A worker's file, not through a link, at most `max` bytes.
fn read_capped(path: &FsPath, max: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let f = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path).ok()?;
    if !f.metadata().ok()?.is_file() {
        return None;
    }
    let mut out = Vec::new();
    f.take(max + 1).read_to_end(&mut out).ok()?;
    (out.len() as u64 <= max).then_some(out)
}

fn age(path: &FsPath) -> Duration {
    std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).unwrap_or_default()
}

fn write_atomic(path: &FsPath, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

fn out_path(root: &FsPath, job: &str, ext: &str) -> PathBuf {
    root.join("outbox").join(format!("{job}.{ext}"))
}

/// A replay job is over: count it by source and outcome, time it, and log a failure.
fn job_ended(job: &str, outcome: crate::metrics::JobOutcome, secs: f64) {
    job_ended_as(source_of(job), outcome, secs);
}

fn job_ended_as(source: crate::metrics::Source, outcome: crate::metrics::JobOutcome, secs: f64) {
    use crate::metrics::{JobOutcome, Label};
    let m = crate::metrics::get();
    m.replay_jobs.inc((source, outcome));
    m.replay_job_s.observe((source,), secs);
    if outcome != JobOutcome::Done {
        use crate::metrics::failures::Part::{Dec, Word};
        crate::metrics::failures::record(
            crate::metrics::failures::FailureKind::ReplayJob,
            outcome.as_str(),
            &[Word("replay"), Word(source.as_str()), Word(outcome.as_str()), Word("after"), Dec(secs), Word("s")],
        );
    }
}

/// The worker's record of a job (phase times, peak memory, sizes) into the histograms. The
/// worker is untrusted: only finite, non-negative numbers under a day or 64 GiB count.
fn ingest(r: &mapcro_replay::JobStats) {
    let m = crate::metrics::get();
    let secs = |v: Option<f64>| v.filter(|x| x.is_finite() && *x >= 0.0 && *x < 86_400.0);
    let size = |v: Option<u64>| v.filter(|x| *x < 64 << 30).map(|x| x as f64);
    if let Some(v) = secs(r.queue_wait_s) {
        m.queue_wait_s.observe((), v);
    }
    if let Some(v) = secs(r.decompress_s) {
        m.decompress_s.observe((), v);
    }
    if let Some(v) = secs(r.parse_s) {
        m.parse_s.observe((), v);
    }
    if let Some(v) = secs(r.publish_s) {
        m.publish_s.observe((), v);
    }
    if let Some(v) = size(r.peak_rss_bytes) {
        m.parse_peak_rss_bytes.observe((), v);
    }
    if let Some(v) = size(r.peak_anon_bytes) {
        m.parse_peak_anon_bytes.observe((), v);
    }
    if let Some(v) = size(r.zstd_window_bytes) {
        m.zstd_window_bytes.observe((), v);
    }
    if let Some(v) = size(r.demo_bytes) {
        m.demo_bytes.observe((), v);
    }
    if let Some(v) = size(r.timeline_bytes) {
        m.timeline_bytes.observe((), v);
    }
}

fn collect(root: &FsPath, cache: &FsPath) {
    let s = settings();
    let fail = |job: &str, why: &'static str| {
        lock().failed.insert(job.to_owned(), (why, Instant::now()));
    };
    if let Ok(rd) = std::fs::read_dir(root.join("outbox")) {
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            let Some((job, ext)) = name.rsplit_once('.').map(|(j, x)| (j.to_owned(), x.to_owned())) else { continue };
            if name.starts_with('.') || ext == "parsing" {
                continue; // being written, or in progress
            }
            // The per-job record belongs to its result and is read and removed with it. When the
            // result was collected earlier in this pass the record is already gone; one still
            // waiting for its result is left for it. A record with no job at all is only a
            // stale-file cleanup, never worker output to warn about.
            if ext == mapcro_replay::STATS_EXT {
                if !p.exists() {
                    continue;
                }
                let result = out_path(root, &job, "json").exists() || out_path(root, &job, "failed").exists();
                if mapcro_replay::valid_job(&job) && (exists_any(&root.join("inbox"), &job) || result) {
                    continue;
                }
                if age(&p) >= s.stale {
                    tracing::warn!(file = name, "replay worker output for no queued job, dropped");
                    let _ = std::fs::remove_file(&p);
                }
                continue;
            }
            // Only results for jobs this server queued, bound to the job's own scope: a worker
            // can't publish a timeline nobody asked for (security review 2026-11-08, M2).
            if !mapcro_replay::valid_job(&job) || !(ext == "json" || ext == "failed") || !exists_any(&root.join("inbox"), &job) {
                tracing::warn!(file = name, "replay worker output for no queued job, dropped");
                let _ = std::fs::remove_file(&p);
                continue;
            }
            let bytes = read_capped(&p, mapcro_replay::timeline::MAX_BYTES);
            let mut parsed = false;
            if ext == "failed" {
                let said = bytes.unwrap_or_default();
                let why = mapcro_replay::reason::ALL.iter().copied().find(|r| r.as_bytes() == said.trim_ascii()).unwrap_or(mapcro_replay::reason::PARSE_FAILED);
                tracing::info!(job, why, "replay job failed");
                fail(&job, why);
            } else {
                let checked = bytes
                    .ok_or("unreadable or too large")
                    .and_then(|b| mapcro_replay::timeline::validate(&b))
                    .and_then(|t| if t.match_id == mapcro_replay::job_match_id(&job) { Ok(t) } else { Err("wrong match") });
                match checked.and_then(|t| serde_json::to_vec(&t).map_err(|_| "json")) {
                    Ok(bytes) => match write_atomic(&cache.join(format!("{job}.json")), &bytes) {
                        Ok(()) => {
                            parsed = true;
                            tracing::info!(job, bytes = bytes.len(), "replay timeline cached");
                        }
                        Err(e) => {
                            tracing::error!(error = %e, job, "replay cache not written");
                            fail(&job, mapcro_replay::reason::PARSE_FAILED);
                        }
                    },
                    Err(why) => {
                        tracing::warn!(job, why, "replay worker output refused");
                        fail(&job, mapcro_replay::reason::PARSE_FAILED);
                    }
                }
            }
            // The job is over: count it, with the worker's record of it; its result and its demo go.
            let queued_for = EXTS.iter().map(|x| root.join("inbox").join(format!("{job}.{x}"))).find(|f| f.exists()).map(|f| age(&f).as_secs_f64());
            let outcome = if parsed { crate::metrics::JobOutcome::Done } else { crate::metrics::JobOutcome::from_code(lock().failed.get(&job).map_or("parse_failed", |f| f.0)) };
            job_ended(&job, outcome, queued_for.unwrap_or(0.0));
            let record = out_path(root, &job, mapcro_replay::STATS_EXT);
            if let Some(stats) = read_capped(&record, mapcro_replay::JobStats::MAX_BYTES).and_then(|b| serde_json::from_slice::<mapcro_replay::JobStats>(&b).ok()) {
                ingest(&stats);
            }
            let _ = std::fs::remove_file(&record);
            let _ = std::fs::remove_file(&p);
            for x in EXTS {
                let _ = std::fs::remove_file(root.join("inbox").join(format!("{job}.{x}")));
            }
            let mut j = lock();
            // Seen parsing for a while, or finished between two looks (under a second). Only a
            // parse that made a timeline is a sample: a refusal or a crash ends in no time and
            // would make the wait look shorter than it is.
            let took = j.parse_started.remove(&job).map_or(1.0, |t| t.elapsed().as_secs_f64().max(1.0));
            if parsed {
                j.stats.parsed(took);
            }
            j.owner.remove(&job);
        }
    }
    // A queued job the worker never took (it's down) and partial transfers nobody finished. A
    // job being parsed is the worker's (its own wall clock bounds it): its age counts from when
    // its parse was first seen, not from its arrival, so a long wait in the queue doesn't
    // delete a demo under the parser.
    let (busy, parsing): (HashSet<String>, HashMap<String, Instant>) = {
        let j = lock();
        (j.uploading.iter().chain(&j.fetching).cloned().collect(), j.parse_started.clone())
    };
    let out = root.join("outbox");
    if let Ok(rd) = std::fs::read_dir(root.join("inbox")) {
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            let job = name.trim_start_matches('.').split('.').next().unwrap_or("").to_owned();
            if name == mapcro_replay::ORDER_FILE || busy.contains(&job) {
                continue;
            }
            let aged = if !name.starts_with('.') && out.join(format!("{job}.parsing")).exists() {
                parsing.get(&job).is_some_and(|t| t.elapsed() >= s.stale)
            } else {
                age(&p) >= s.stale
            };
            if !aged {
                continue;
            }
            let _ = std::fs::remove_file(&p);
            if !name.starts_with('.') && mapcro_replay::valid_job(&job) {
                fail(&job, mapcro_replay::reason::TIMEOUT);
                job_ended(&job, crate::metrics::JobOutcome::Timeout, s.stale.as_secs_f64());
            }
        }
    }
    lock().failed.retain(|_, (_, at)| at.elapsed() < FAILED_FOR);
    order(root);
    trim_cache(cache, s.max_cache_bytes);
}

/// The queue as it stands: note what's parsing and since when, put the queued files in the fair
/// order and write it for the worker (`inbox/.order`), forget jobs that left, and start what the
/// room now holds.
fn order(root: &FsPath) {
    let inbox = root.join("inbox");
    let queued: Vec<(String, SystemTime)> = std::fs::read_dir(&inbox)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    let (job, ext) = name.rsplit_once('.')?;
                    (EXTS.contains(&ext) && mapcro_replay::valid_job(job)).then(|| (job.to_owned(), e.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH)))
                })
                .collect()
        })
        .unwrap_or_default();
    let out = root.join("outbox");
    let started = |job: &str| ["parsing", "json", "failed"].iter().any(|e| out.join(format!("{job}.{e}")).exists());
    let (parsing, waiting): (Vec<_>, Vec<_>) = queued.into_iter().partition(|(job, _)| started(job));
    let mut j = lock();
    let now = Instant::now();
    for (job, _) in &parsing {
        j.parse_started.entry(job.clone()).or_insert(now);
    }
    let on_disk: HashSet<&str> = parsing.iter().chain(&waiting).map(|(job, _)| job.as_str()).collect();
    let live: HashSet<String> = j.line.iter().map(|w| w.job.clone()).chain(j.granted.keys().cloned()).chain(j.uploading.iter().cloned()).chain(j.fetching.iter().cloned()).collect();
    j.owner.retain(|job, _| on_disk.contains(job.as_str()) || live.contains(job));
    // Only those parsing now: a parse the worker put back (it restarted) starts afresh.
    let now_parsing: HashSet<&str> = parsing.iter().map(|(job, _)| job.as_str()).collect();
    j.parse_started.retain(|job, _| now_parsing.contains(job.as_str()));
    // A file the server knows nothing of (queued before a restart) is its own client, in the
    // order its file arrived.
    let keyed: Vec<(String, Client, u64)> = waiting
        .iter()
        .map(|(job, at)| match j.owner.get(job) {
            Some((c, seq)) => (job.clone(), c.clone(), *seq),
            None => (job.clone(), format!("job:{job}"), at.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)),
        })
        .collect();
    let mut prior: HashMap<Client, usize> = HashMap::new();
    for (job, _) in &parsing {
        if let Some((c, _)) = j.owner.get(job) {
            *prior.entry(c.clone()).or_default() += 1;
        }
    }
    let order: Vec<String> = replay_queue::fair(&keyed, |(_, c, seq)| (c.as_str(), *seq), &prior).into_iter().map(|i| keyed[i].0.clone()).collect();
    let changed = order != j.queued_order;
    j.queued_order = order.clone();
    j.parsing_now = parsing.len();
    schedule(&mut j, root);
    drop(j);
    if changed || !inbox.join(mapcro_replay::ORDER_FILE).exists() {
        let mut text = order.join("\n");
        text.push('\n');
        if let Err(e) = publish(&inbox, mapcro_replay::ORDER_FILE, text.as_bytes()) {
            tracing::warn!(error = %e, "replay order not written");
        }
    }
}

/// Write `name` in `dir` the way the queue's files are written: a new file, never through a
/// link, group-readable, renamed in.
fn publish(dir: &FsPath, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = dir.join(format!("{name}.tmp"));
    let _ = std::fs::remove_file(&tmp);
    let mut f = new_file(&tmp)?;
    f.set_permissions(group_readable())?;
    f.write_all(bytes)?;
    drop(f);
    std::fs::rename(&tmp, dir.join(name))
}

/// Past the cache's byte cap, the least recently written timelines go. A clone's upload is a
/// hard link to its source's (`carry_to_clone`): its bytes count once, and free only when the
/// last name goes.
fn trim_cache(cache: &FsPath, max: u64) {
    use std::os::unix::fs::MetadataExt;
    let Ok(rd) = std::fs::read_dir(cache) else { return };
    let mut files: Vec<(SystemTime, u64, u64, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((m.modified().ok()?, m.ino(), m.len(), e.path()))
        })
        .collect();
    let mut names: HashMap<u64, usize> = HashMap::new();
    let mut total: u64 = 0;
    for (_, ino, len, _) in &files {
        let n = names.entry(*ino).or_default();
        if *n == 0 {
            total += len;
        }
        *n += 1;
    }
    if total <= max {
        return;
    }
    files.sort();
    for (_, ino, len, p) in files {
        if total <= max {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            let n = names.entry(ino).or_default();
            *n = n.saturating_sub(1);
            if *n == 0 {
                total -= len;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A match with no replay salt yet is held until the salts pass (2 h 10 min after its end),
    /// then 6 h; with no end known, 6 h. Only before the pass is it fresh (no Steam lookup).
    #[test]
    fn no_replay_holds_until_the_salts_pass_then_six_hours() {
        let end = 1_000_000;
        assert_eq!(no_replay_for(Some(end), end + 60), Duration::from_secs(SALT_PASS_S - 60));
        assert_eq!(no_replay_for(Some(end), end + 30 * 60), Duration::from_secs(100 * 60));
        assert_eq!(no_replay_for(Some(end), end + SALT_PASS_S), NEGATIVE_FOR);
        assert_eq!(no_replay_for(Some(end), end + 3 * 86_400), NEGATIVE_FOR);
        assert_eq!(no_replay_for(None, end), NEGATIVE_FOR);
        // A clock behind the match's end reads as just ended.
        assert_eq!(no_replay_for(Some(end), end - 100), Duration::from_secs(SALT_PASS_S));
        assert!(fresh(Some(end), end + SALT_PASS_S - 1));
        assert!(!fresh(Some(end), end + SALT_PASS_S));
        assert!(!fresh(None, end));
    }

    #[test]
    fn job_names_fit_the_workers_rules() {
        let scope = scope_of("AAAAAAAAAAAAAAAAAAAAAA");
        assert_eq!(scope.len(), 16);
        assert!(mapcro_replay::valid_job(&job_name("130816395", &scope)));
        assert!(mapcro_replay::valid_job(&job_name("130816395", "cdn")));
        assert_ne!(scope_of("AAAAAAAAAAAAAAAAAAAAAA"), scope_of("AAAAAAAAAAAAAAAAAAAAAB"));
    }

    /// A hidden tab's timers run about once a minute (Chrome's intensive throttling): its place
    /// must outlast that between two asks, and so must a turn given between two asks, or a
    /// tab in the background starts over at the back for ever. A turn still lapses unused
    /// before a place would (finding 2026-11-08, queue review).
    #[test]
    fn places_and_turns_outlast_a_hidden_tabs_minute() {
        let s = settings();
        assert!(s.reserve_ttl >= Duration::from_secs(80), "{:?}", s.reserve_ttl);
        assert!(s.grant_use > Duration::from_secs(65) && s.grant_use < s.reserve_ttl, "{:?}", s.grant_use);
    }

    #[test]
    fn a_place_in_line_counts_the_fetches_ahead() {
        let w = |job: &str, kind: Kind| Waiting { job: job.into(), client: job.into(), kind, seq: 0, bytes: 1, touched: Instant::now() };
        let j = Jobs {
            line: vec![w("1-cdn", Kind::Fetch), w("2-aaaaaaaaaaaaaaaa", Kind::Upload), w("3-cdn", Kind::Fetch), w("4-cdn", Kind::Fetch)],
            line_order: ["2-aaaaaaaaaaaaaaaa", "1-cdn", "3-cdn", "4-cdn"].map(String::from).to_vec(),
            ..Jobs::default()
        };
        assert_eq!(line_place(&j, "2-aaaaaaaaaaaaaaaa"), Some((0, 0)));
        assert_eq!(line_place(&j, "3-cdn"), Some((2, 1)));
        assert_eq!(line_place(&j, "4-cdn"), Some((3, 2)));
        assert_eq!(line_place(&j, "9-cdn"), None);
    }

    #[test]
    fn the_cache_trims_oldest_first() {
        let dir = tempfile::tempdir().expect("dir");
        for (i, name) in ["a", "b", "c"].iter().enumerate() {
            let p = dir.path().join(format!("{name}.json"));
            std::fs::write(&p, vec![0u8; 100]).expect("write");
            let t = SystemTime::now() - Duration::from_secs(100 - i as u64 * 10);
            std::fs::File::options().write(true).open(&p).and_then(|f| f.set_modified(t)).expect("mtime");
        }
        trim_cache(dir.path(), 250);
        assert!(!dir.path().join("a.json").exists());
        assert!(dir.path().join("b.json").exists() && dir.path().join("c.json").exists());
    }

    /// A clone's upload, hard-linked to its source's, counts once: two names of one 100-byte
    /// timeline beside a 100-byte one fit a 250-byte cap, and nothing goes.
    #[test]
    fn the_cache_counts_a_linked_timeline_once() {
        let dir = tempfile::tempdir().expect("dir");
        std::fs::write(dir.path().join("a.json"), vec![0u8; 100]).expect("write");
        std::fs::hard_link(dir.path().join("a.json"), dir.path().join("a2.json")).expect("link");
        std::fs::write(dir.path().join("b.json"), vec![0u8; 100]).expect("write");
        trim_cache(dir.path(), 250);
        assert!(["a", "a2", "b"].iter().all(|n| dir.path().join(format!("{n}.json")).exists()));
        // Past the cap, the older timeline's names both go before the bytes count as freed.
        let t = SystemTime::now() - Duration::from_secs(100);
        std::fs::File::options().write(true).open(dir.path().join("a.json")).and_then(|f| f.set_modified(t)).expect("mtime");
        trim_cache(dir.path(), 150);
        assert!(!dir.path().join("a.json").exists() && !dir.path().join("a2.json").exists());
        assert!(dir.path().join("b.json").exists());
    }
}
