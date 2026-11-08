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
//! timeline is visible only on the board that uploaded it. A timeline fetched from Valve's CDN by
//! match id is shared by every board.
//!
//! **Queue** (`REPLAY_DIR`, shared with the worker): `inbox/` (complete, magic-checked files,
//! written as `.<job>.part` and renamed), `work/`, `done/`, `failed/`. A job is
//! `<match id>-<scope>`: `cdn`, or 16 hex digits of the board id's hash.
//!
//! **Privacy:** nothing here reads a demo; the worker never reads Steam or account ids, and the
//! demo is deleted when its parse ends.

use crate::api::{client_ip, client_key};
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
    /// Bytes the queue (inbox and work, plus uploads in flight) may hold.
    pub max_queue_bytes: u64,
    pub max_queued: usize,
    /// Bytes of cached timelines; the oldest go first past it.
    pub max_cache_bytes: u64,
    pub uploads_at_once: usize,
    /// Uploads and fetches per client per hour, and fetches server-wide per hour.
    pub per_client: usize,
    pub fetches_per_hour: usize,
    /// No body bytes for this long ends an upload.
    pub idle: Duration,
    /// A whole upload or download.
    pub transfer: Duration,
    /// A job still queued after this (the worker is down) is dropped.
    pub stale: Duration,
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
            max_queue_bytes: num("REPLAY_MAX_QUEUE_BYTES", 3 * 1024 * MIB),
            max_queued: num("REPLAY_MAX_QUEUED", 6) as usize,
            max_cache_bytes: num("REPLAY_MAX_CACHE_BYTES", 1024 * MIB),
            uploads_at_once: num("REPLAY_UPLOADS_AT_ONCE", 2) as usize,
            per_client: num("REPLAY_PER_CLIENT_PER_HOUR", 6) as usize,
            fetches_per_hour: num("REPLAY_FETCHES_PER_HOUR", 20) as usize,
            idle: Duration::from_secs(num("REPLAY_IDLE_S", 60)),
            transfer: Duration::from_secs(num("REPLAY_TRANSFER_S", 1800)),
            stale: Duration::from_secs(num("REPLAY_STALE_S", 3600)),
        }
    })
}

/// What the server remembers about jobs between polls (lost on restart, which is harmless:
/// a lost failure reads as "none" and can be retried).
#[derive(Default)]
struct Jobs {
    fetching: HashSet<String>,
    uploading: HashSet<String>,
    uploads_by_client: HashMap<IpAddr, usize>,
    failed: HashMap<String, (&'static str, Instant)>,
    /// Uploads and fetches started, per client, and fetches server-wide.
    starts: HashMap<IpAddr, Vec<Instant>>,
    fetches: Vec<Instant>,
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

/// Take one start for `client` (and one server-wide fetch), or say which limit refused it.
fn admit(j: &mut Jobs, client: IpAddr, fetch: bool) -> Result<(), &'static str> {
    let s = settings();
    let now = Instant::now();
    j.starts.retain(|_, v| {
        v.retain(|t| now.duration_since(*t) < HOUR);
        !v.is_empty()
    });
    j.fetches.retain(|t| now.duration_since(*t) < HOUR);
    if j.starts.get(&client).map_or(0, Vec::len) >= s.per_client {
        return Err("rate_limited");
    }
    if fetch && j.fetches.len() >= s.fetches_per_hour {
        return Err("busy");
    }
    j.starts.entry(client).or_default().push(now);
    if fetch {
        j.fetches.push(now);
    }
    Ok(())
}

// ---- paths ----

pub fn routes() -> Router<AppState> {
    Router::new()
        // The only route without the 16 KiB body limit: its own cap applies while streaming.
        .route("/api/boards/{board}/replays/{id}/upload", post(upload))
        .merge(
            Router::new()
                .route("/api/boards/{board}/replays/{id}", get(status))
                .route("/api/boards/{board}/replays/{id}/fetch", post(fetch))
                .route("/api/boards/{board}/matches/{id}", get(timeline))
                .layer(tower_http::limit::RequestBodyLimitLayer::new(16 * 1024)),
        )
}

fn root(app: &AppState) -> Option<&FsPath> {
    app.config.replay_dir.as_deref()
}

fn cache_dir(app: &AppState) -> PathBuf {
    app.config.data_dir.join("replays")
}

fn scope_of(board: &str) -> String {
    links::hash(board)[..16].to_owned()
}

fn job_name(id: &str, scope: &str) -> String {
    format!("{id}-{scope}")
}

const EXTS: [&str; 3] = ["dem", "bz2", "zst"];

fn err(status: StatusCode, code: &str) -> Response {
    (status, axum::Json(serde_json::json!({ "error": code }))).into_response()
}

fn json(body: serde_json::Value) -> Response {
    (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], axum::Json(body)).into_response()
}

#[cfg(unix)]
fn group_readable(path: &FsPath) {
    use std::os::unix::fs::PermissionsExt;
    // The worker reads queued files as a member of the queue's group (nix/module.nix).
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o640));
}
#[cfg(not(unix))]
fn group_readable(_: &FsPath) {}

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
    Fetching,
    Uploading,
    Queued,
    Parsing,
    Done,
    Failed(&'static str),
}

fn exists_any(dir: &FsPath, job: &str) -> bool {
    EXTS.iter().any(|e| dir.join(format!("{job}.{e}")).exists())
}

fn job_state(app: &AppState, job: &str) -> State_ {
    let Some(root) = root(app) else { return State_::None };
    if cache_dir(app).join(format!("{job}.json")).exists() {
        return State_::Done;
    }
    {
        let j = lock();
        if j.uploading.contains(job) {
            return State_::Uploading;
        }
        if j.fetching.contains(job) {
            return State_::Fetching;
        }
        if let Some((why, _)) = j.failed.get(job) {
            return State_::Failed(why);
        }
    }
    if exists_any(&root.join("inbox"), job) {
        return State_::Queued;
    }
    if exists_any(&root.join("work"), job) || root.join("done").join(format!("{job}.json")).exists() || root.join("work").join(format!("{job}.json")).exists() {
        return State_::Parsing;
    }
    if root.join("failed").join(job).exists() {
        return State_::Parsing; // the collector picks it up within a second
    }
    State_::None
}

fn state_json(s: &State_, source: &str) -> serde_json::Value {
    match s {
        State_::None => serde_json::json!({ "state": "none" }),
        State_::Fetching => serde_json::json!({ "state": "fetching", "source": source }),
        State_::Uploading => serde_json::json!({ "state": "uploading", "source": source }),
        State_::Queued => serde_json::json!({ "state": "queued", "source": source }),
        State_::Parsing => serde_json::json!({ "state": "parsing", "source": source }),
        State_::Done => serde_json::json!({ "state": "done", "source": source }),
        State_::Failed(why) => serde_json::json!({ "state": "failed", "reason": why, "source": source }),
    }
}

/// Bytes in the queue's inbox and work directories (partial uploads included).
fn queue_bytes(root: &FsPath) -> (u64, usize) {
    let mut bytes = 0;
    let mut queued = 0;
    for d in ["inbox", "work"] {
        let Ok(rd) = std::fs::read_dir(root.join(d)) else { continue };
        for e in rd.flatten() {
            if let Ok(m) = e.metadata() {
                bytes += m.len();
                if d == "inbox" && !e.file_name().to_string_lossy().starts_with('.') {
                    queued += 1;
                }
            }
        }
    }
    (bytes, queued)
}

/// Room in the queue for one more transfer of up to `cap` bytes.
fn room(root: &FsPath, cap: u64) -> Result<(), (StatusCode, &'static str)> {
    let s = settings();
    let (bytes, queued) = queue_bytes(root);
    let in_flight = {
        let j = lock();
        (j.uploading.len() + j.fetching.len()) as u64
    };
    if queued >= s.max_queued {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "queue_full"));
    }
    // Transfers in flight count at their cap: their bytes are still arriving.
    if bytes + (in_flight + 1) * cap > s.max_queue_bytes {
        return Err((StatusCode::INSUFFICIENT_STORAGE, "queue_full"));
    }
    Ok(())
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
    let up = job_state(&app, &job_name(&id, &scope_of(&board)));
    if up != State_::None {
        return json(state_json(&up, "upload"));
    }
    json(state_json(&job_state(&app, &job_name(&id, "cdn")), "cdn"))
}

/// `GET /api/boards/{board}/matches/{id}`: the richest timeline there is for this board: its
/// uploaded replay, else a fetched one, else the match metadata (v1).
pub async fn timeline(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((board, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = role(&app, &board, &headers).await {
        return r;
    }
    if !crate::matches::valid_id(&id) {
        return err(StatusCode::BAD_REQUEST, "bad_id");
    }
    if root(&app).is_some() {
        for scope in [scope_of(&board), "cdn".to_owned()] {
            if let Ok(bytes) = tokio::fs::read(cache_dir(&app).join(format!("{}.json", job_name(&id, &scope)))).await {
                return ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")], bytes).into_response();
            }
        }
    }
    crate::matches::get(State(app), ConnectInfo(peer), headers, Path(id)).await
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
    let Some(root) = root(&app).map(FsPath::to_owned) else { return err(StatusCode::SERVICE_UNAVAILABLE, "replays_off") };
    let s = settings();
    let declared = headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > s.max_upload) {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "too_large");
    }
    let job = job_name(&id, &scope_of(&board));
    match job_state(&app, &job) {
        State_::Uploading | State_::Queued | State_::Parsing | State_::Fetching => return err(StatusCode::CONFLICT, "in_progress"),
        _ => {}
    }
    let client = client_key(client_ip(peer, &headers));
    if let Err((code, why)) = room(&root, s.max_upload) {
        return err(code, why);
    }
    {
        let mut j = lock();
        if j.uploading.len() >= s.uploads_at_once || j.uploads_by_client.get(&client).copied().unwrap_or(0) >= 1 {
            return err(StatusCode::TOO_MANY_REQUESTS, "busy");
        }
        if j.uploading.contains(&job) {
            return err(StatusCode::CONFLICT, "in_progress");
        }
        if let Err(why) = admit(&mut j, client, false) {
            return err(StatusCode::TOO_MANY_REQUESTS, why);
        }
        j.uploading.insert(job.clone());
        *j.uploads_by_client.entry(client).or_default() += 1;
        j.failed.remove(&job);
    }
    let result = receive(&root, &job, body, s).await;
    {
        let mut j = lock();
        j.uploading.remove(&job);
        if let Some(n) = j.uploads_by_client.get_mut(&client) {
            *n -= 1;
            if *n == 0 {
                j.uploads_by_client.remove(&client);
            }
        }
    }
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

/// Stream `body` to `inbox/.<job>.part` under the caps, check the magic, then queue it.
async fn receive(root: &FsPath, job: &str, body: Body, s: &Settings) -> Result<u64, (StatusCode, &'static str)> {
    let inbox = root.join("inbox");
    let part = inbox.join(format!(".{job}.part"));
    let mut file = tokio::fs::File::create(&part).await.map_err(|e| {
        tracing::error!(error = %e, "replay inbox not writable");
        (StatusCode::INTERNAL_SERVER_ERROR, "internal")
    })?;
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
            if n > s.max_upload {
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
            group_readable(&part);
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
/// (salts from deadlock-api), for every board.
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
    let Some(root) = root(&app).map(FsPath::to_owned) else { return err(StatusCode::SERVICE_UNAVAILABLE, "replays_off") };
    let job = job_name(&id, "cdn");
    let st = job_state(&app, &job);
    if st != State_::None {
        // Done, in progress, or failed within the hour: say so instead of fetching again.
        return (StatusCode::ACCEPTED, axum::Json(state_json(&st, "cdn"))).into_response();
    }
    let s = settings();
    if let Err((code, why)) = room(&root, s.max_download) {
        return err(code, why);
    }
    {
        let mut j = lock();
        if j.fetching.contains(&job) {
            return (StatusCode::ACCEPTED, axum::Json(state_json(&State_::Fetching, "cdn"))).into_response();
        }
        if let Err(why) = admit(&mut j, client_key(client_ip(peer, &headers)), true) {
            return err(StatusCode::TOO_MANY_REQUESTS, why);
        }
        j.fetching.insert(job.clone());
    }
    let match_id = id.clone();
    tokio::spawn(async move {
        let j2 = job.clone();
        let outcome = tokio::task::spawn_blocking(move || download(&root, &match_id, &j2)).await.unwrap_or(Err("upstream_down"));
        let mut j = lock();
        j.fetching.remove(&job);
        match outcome {
            Ok(bytes) => tracing::info!(job, bytes, "replay fetched"),
            Err(why) => {
                tracing::info!(job, why, "replay fetch failed");
                j.failed.insert(job, (why, Instant::now()));
            }
        }
    });
    (StatusCode::ACCEPTED, axum::Json(state_json(&State_::Fetching, "cdn"))).into_response()
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

/// Salts, then the demo, streamed to `inbox/.<job>.part` under the size cap. Blocking.
fn download(root: &FsPath, id: &str, job: &str) -> Result<u64, &'static str> {
    let s = settings();
    let mut r = agent(Duration::from_secs(20)).get(&format!("{}/v1/matches/{id}/salts", s.api_base)).call().map_err(|_| "upstream_down")?;
    match r.status().as_u16() {
        200 => {}
        404 => return Err("no_replay"),
        429 => return Err("upstream_limited"),
        _ => return Err("upstream_down"),
    }
    let salts: Salts = r.body_mut().with_config().limit(64 * 1024).read_json().map_err(|_| "upstream_shape")?;
    let (Some(cluster), Some(salt)) = (salts.cluster_id, salts.replay_salt) else { return Err("no_replay") };
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
        let mut file = std::fs::File::create(&part).map_err(|_| "internal")?;
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
            group_readable(&part);
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
    for d in ["inbox", "work", "done", "failed"] {
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

fn age(path: &FsPath) -> Duration {
    std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).unwrap_or_default()
}

fn write_atomic(path: &FsPath, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

fn collect(root: &FsPath, cache: &FsPath) {
    let s = settings();
    let fail = |job: &str, why: &'static str| {
        lock().failed.insert(job.to_owned(), (why, Instant::now()));
    };
    if let Ok(rd) = std::fs::read_dir(root.join("done")) {
        for e in rd.flatten() {
            let p = e.path();
            let Some(job) = p.file_name().and_then(|f| f.to_str()).and_then(|f| f.strip_suffix(".json")).map(str::to_owned) else { continue };
            if !mapcro_replay::valid_job(&job) {
                let _ = std::fs::remove_file(&p);
                continue;
            }
            let ok = std::fs::metadata(&p).is_ok_and(|m| m.len() <= mapcro_replay::timeline::MAX_BYTES);
            let checked = ok
                .then(|| std::fs::read(&p).ok())
                .flatten()
                .ok_or("too large")
                .and_then(|b| mapcro_replay::timeline::validate(&b))
                .and_then(|t| if t.match_id == mapcro_replay::job_match_id(&job) { Ok(t) } else { Err("wrong match") });
            match checked.and_then(|t| serde_json::to_vec(&t).map_err(|_| "json")) {
                Ok(bytes) => match write_atomic(&cache.join(format!("{job}.json")), &bytes) {
                    Ok(()) => tracing::info!(job, bytes = bytes.len(), "replay timeline cached"),
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
            let _ = std::fs::remove_file(&p);
        }
    }
    if let Ok(rd) = std::fs::read_dir(root.join("failed")) {
        for e in rd.flatten() {
            let p = e.path();
            if let Some(job) = p.file_name().and_then(|f| f.to_str()).filter(|j| mapcro_replay::valid_job(j)) {
                let said = std::fs::read(&p).unwrap_or_default();
                let why = mapcro_replay::reason::ALL.iter().copied().find(|r| r.as_bytes() == said.trim_ascii()).unwrap_or(mapcro_replay::reason::PARSE_FAILED);
                fail(job, why);
            }
            let _ = std::fs::remove_file(&p);
        }
    }
    // A queued job the worker never took (it's down) and partial transfers nobody finished.
    let busy: HashSet<String> = {
        let j = lock();
        j.uploading.iter().chain(&j.fetching).cloned().collect()
    };
    if let Ok(rd) = std::fs::read_dir(root.join("inbox")) {
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            let job = name.trim_start_matches('.').split('.').next().unwrap_or("").to_owned();
            if busy.contains(&job) || age(&p) < s.stale {
                continue;
            }
            let _ = std::fs::remove_file(&p);
            if !name.starts_with('.') && mapcro_replay::valid_job(&job) {
                fail(&job, mapcro_replay::reason::TIMEOUT);
            }
        }
    }
    lock().failed.retain(|_, (_, at)| at.elapsed() < FAILED_FOR);
    trim_cache(cache, s.max_cache_bytes);
}

/// Past the cache's byte cap, the least recently written timelines go.
fn trim_cache(cache: &FsPath, max: u64) {
    let Ok(rd) = std::fs::read_dir(cache) else { return };
    let mut files: Vec<(SystemTime, u64, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((m.modified().ok()?, m.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= max {
        return;
    }
    files.sort();
    for (_, len, p) in files {
        if total <= max {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total -= len;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_names_fit_the_workers_rules() {
        let scope = scope_of("AAAAAAAAAAAAAAAAAAAAAA");
        assert_eq!(scope.len(), 16);
        assert!(mapcro_replay::valid_job(&job_name("130816395", &scope)));
        assert!(mapcro_replay::valid_job(&job_name("130816395", "cdn")));
        assert_ne!(scope_of("AAAAAAAAAAAAAAAAAAAAAA"), scope_of("AAAAAAAAAAAAAAAAAAAAAB"));
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
}
