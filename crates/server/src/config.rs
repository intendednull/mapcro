//! Configuration from the environment (infra contract: env only, fail fast).

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub addr: SocketAddr,
    pub data_dir: PathBuf,
    /// Origins allowed to open WebSockets, e.g. `https://mapcro.dmgdeadlock.com`. Comma-separated.
    pub allowed_origins: Vec<String>,
    /// Built web client to serve, if any.
    pub web_dir: Option<PathBuf>,
    /// Directory of extracted asset packs, one per subdirectory (spec §12).
    pub packs_dir: Option<PathBuf>,
    /// Board creations allowed per client IP per hour.
    pub create_per_hour: u32,
    /// Board creations allowed server-wide per hour (a backstop against address rotation).
    pub create_global_per_hour: u32,
    /// How long an empty room stays loaded.
    pub room_idle: std::time::Duration,
    /// Per-board caps: history length and stored bytes, distinct editing clients (spec §9;
    /// security review 2026-11-07, C1 and H-B). `BOARD_MAX_OPS` (100,000), `BOARD_MAX_BYTES`
    /// (20 MiB as stored, compressed: ~100,000 realistic edits take ~11 MB), `BOARD_MAX_CLIENTS`
    /// (1024), `BOARD_MAX_REJECTIONS` (4096 stored rejections). A full board refuses edits with
    /// `BoardFull` and stays readable. History is on disk only, so these bound disk and cold-load
    /// time, not memory; a cold load reads at most this much.
    pub quota: mapcro_engine::Quota,
    /// Boards loaded in memory at once (`MAX_OPEN_ROOMS`, 256). Measured: 256 small rooms at once
    /// are 87 MB resident. At the cap, an idle room is unloaded early; if none is idle, joins
    /// are refused with `busy` (M-B; journal 2026-11-07-security-fixes).
    pub max_open_rooms: usize,
    /// What open rooms may occupy together by their estimates (`ROOM_MEMORY_BYTES`, 128 MiB). A
    /// room costs its document (kilobytes, up to ~20 MB at the schema's limits) plus a fixed
    /// base. Measured with `MALLOC_ARENA_MAX=2`: rooms of the largest documents fill the budget
    /// at 8 rooms and 183 MB peak, inside `MemoryMax=256M` with 29% headroom. Past it, idle rooms
    /// unload, joins are `busy`, and edits that grow memory are refused as `ServerFull`.
    pub room_memory_bytes: usize,
    /// Boards the server stores (`MAX_BOARDS`, 5000). Creation past it is refused with 507.
    pub max_boards: u64,
    /// The database's size cap in bytes (`MAX_STORAGE_BYTES`, 2 GiB). Past it, creation is
    /// refused with 507 and edits with `ServerFull`.
    pub max_storage_bytes: u64,
    /// The replay worker's queue (`REPLAY_DIR`, spec §6a), shared with the `mapcro-replay`
    /// service. Unset: no replay tier; match import serves the metadata alone.
    pub replay_dir: Option<PathBuf>,
    /// Where `/metrics` (Prometheus text) is served (`METRICS_ADDR`, e.g. `127.0.0.1:9464`).
    /// Loopback only, and never the public listener, so Caddy can't proxy it. Unset: off.
    pub metrics_addr: Option<SocketAddr>,
    /// The feedback form (spec §11a, feedback.rs): on when `FEEDBACK_GITHUB_TOKEN_FILE` names a
    /// file holding a usable token. Unset, unreadable or empty: off (the client hides it).
    pub feedback: Option<FeedbackConfig>,
}

/// Where feedback goes and how much of it is allowed.
#[derive(Clone, Debug)]
pub struct FeedbackConfig {
    pub token: Secret,
    /// `owner/repo` (`FEEDBACK_GITHUB_REPO`, default `intendednull/mapcro`).
    pub repo: String,
    /// GitHub's REST API (`FEEDBACK_GITHUB_API`, default `https://api.github.com`); tests point
    /// it at a local fake.
    pub api: String,
    /// `FEEDBACK_PER_CLIENT_PER_HOUR` (3), per `api::client_key`.
    pub per_client_per_hour: u32,
    /// `FEEDBACK_GLOBAL_PER_DAY` (30), server-wide.
    pub global_per_day: u32,
}

/// A credential: its `Debug` never shows the value, so a logged config can't leak it.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// A token read from the file `key` names, the way `DEADLOCK_API_KEY_FILE` is (matches.rs): a
/// systemd credential path, never a value in the environment. A missing or unusable file turns
/// the feature off with a warning that names neither the value nor its contents.
fn token_file(var: &impl Fn(&str) -> Option<String>, key: &str) -> Option<Secret> {
    let path = var(key)?;
    match std::fs::read_to_string(&path) {
        Ok(k) if !k.trim().is_empty() && k.trim().bytes().all(|b| b.is_ascii_graphic()) => Some(Secret(k.trim().to_owned())),
        Ok(_) => {
            tracing::warn!("{key} holds no usable token; feedback is off");
            None
        }
        Err(e) => {
            tracing::warn!(error = %e.kind(), "{key} unreadable; feedback is off");
            None
        }
    }
}

fn feedback(var: &impl Fn(&str) -> Option<String>) -> Result<Option<FeedbackConfig>, String> {
    let repo = var("FEEDBACK_GITHUB_REPO").unwrap_or_else(|| "intendednull/mapcro".into());
    let ok_part = |s: &str| !s.is_empty() && s != "." && s != ".." && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b));
    if !matches!(repo.split_once('/'), Some((o, r)) if ok_part(o) && ok_part(r)) {
        return Err(format!("FEEDBACK_GITHUB_REPO {repo:?} must be owner/repo"));
    }
    let api = var("FEEDBACK_GITHUB_API").unwrap_or_else(|| "https://api.github.com".into()).trim_end_matches('/').to_owned();
    // A plain-http fake only on loopback, port and all: `http://localhost.example` is not one.
    if !(api.starts_with("https://") || api.starts_with("http://127.0.0.1:") || api.starts_with("http://localhost:")) {
        return Err("FEEDBACK_GITHUB_API must be https (or a localhost fake for tests)".into());
    }
    let per_client_per_hour = num(var, "FEEDBACK_PER_CLIENT_PER_HOUR", 3)?;
    let global_per_day = num(var, "FEEDBACK_GLOBAL_PER_DAY", 30)?;
    Ok(token_file(var, "FEEDBACK_GITHUB_TOKEN_FILE").map(|token| FeedbackConfig { token, repo, api, per_client_per_hour, global_per_day }))
}

/// Defaults; see the field docs above for what each bounds and how it was measured.
const BOARD_MAX_OPS: usize = 100_000;
const BOARD_MAX_BYTES: usize = 20 * 1024 * 1024;
const MAX_OPEN_ROOMS: usize = 256;
const ROOM_MEMORY_BYTES: usize = 128 * 1024 * 1024;

fn num<T: std::str::FromStr>(var: &impl Fn(&str) -> Option<String>, key: &str, default: T) -> Result<T, String> {
    match var(key) {
        Some(v) => v.parse().map_err(|_| format!("{key} must be a number")),
        None => Ok(default),
    }
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let port: u16 = var("PORT").ok_or("PORT is required")?.parse().map_err(|_| "PORT must be a port number")?;
        let host: IpAddr = var("HOST").unwrap_or_else(|| "127.0.0.1".into()).parse().map_err(|_| "HOST must be an IP address")?;
        let data_dir = PathBuf::from(var("DATA_DIR").ok_or("DATA_DIR is required")?);
        if !data_dir.is_dir() {
            return Err(format!("DATA_DIR {} is not a directory", data_dir.display()));
        }
        let allowed_origins: Vec<String> = var("PUBLIC_ORIGIN")
            .ok_or("PUBLIC_ORIGIN is required (e.g. https://mapcro.dmgdeadlock.com)")?
            .split(',')
            .map(|s| s.trim().trim_end_matches('/').to_owned())
            .collect();
        for o in &allowed_origins {
            if !(o.starts_with("https://") || o.starts_with("http://localhost") || o.starts_with("http://127.0.0.1")) {
                return Err(format!("PUBLIC_ORIGIN {o:?} must be https (or a localhost origin for development)"));
            }
        }
        let web_dir = var("WEB_DIR").map(PathBuf::from);
        if let Some(w) = &web_dir
            && !w.join("index.html").is_file()
        {
            return Err(format!("WEB_DIR {} has no index.html", w.display()));
        }
        let packs_dir = var("PACKS_DIR").map(PathBuf::from);
        if let Some(p) = &packs_dir
            && !p.is_dir()
        {
            return Err(format!("PACKS_DIR {} is not a directory", p.display()));
        }
        let create_per_hour = match var("CREATE_PER_HOUR") {
            Some(v) => v.parse().map_err(|_| "CREATE_PER_HOUR must be a number")?,
            None => 30,
        };
        let create_global_per_hour = match var("CREATE_GLOBAL_PER_HOUR") {
            Some(v) => v.parse().map_err(|_| "CREATE_GLOBAL_PER_HOUR must be a number")?,
            None => 500,
        };
        let room_idle = match var("ROOM_IDLE_SECS") {
            Some(v) => std::time::Duration::from_secs(v.parse().map_err(|_| "ROOM_IDLE_SECS must be a number")?),
            None => crate::room::IDLE_UNLOAD,
        };
        let d = mapcro_engine::Quota::default();
        let quota = mapcro_engine::Quota {
            max_log_ops: num(&var, "BOARD_MAX_OPS", BOARD_MAX_OPS)?,
            max_log_bytes: num(&var, "BOARD_MAX_BYTES", BOARD_MAX_BYTES)?,
            max_clients: num(&var, "BOARD_MAX_CLIENTS", d.max_clients)?,
            max_rejections: num(&var, "BOARD_MAX_REJECTIONS", d.max_rejections)?,
        };
        let max_open_rooms = num(&var, "MAX_OPEN_ROOMS", MAX_OPEN_ROOMS)?;
        if max_open_rooms == 0 {
            return Err("MAX_OPEN_ROOMS must be at least 1".into());
        }
        let room_memory_bytes = num(&var, "ROOM_MEMORY_BYTES", ROOM_MEMORY_BYTES)?;
        let max_boards = num(&var, "MAX_BOARDS", 5000)?;
        let max_storage_bytes = num(&var, "MAX_STORAGE_BYTES", 2 * 1024 * 1024 * 1024)?;
        let replay_dir = var("REPLAY_DIR").map(PathBuf::from);
        if let Some(r) = &replay_dir
            && !r.is_dir()
        {
            return Err(format!("REPLAY_DIR {} is not a directory", r.display()));
        }
        let metrics_addr: Option<SocketAddr> = match var("METRICS_ADDR") {
            Some(v) => Some(v.parse().map_err(|_| "METRICS_ADDR must be an address and port, e.g. 127.0.0.1:9464")?),
            None => None,
        };
        if let Some(m) = metrics_addr {
            if !m.ip().is_loopback() {
                return Err(format!("METRICS_ADDR {m} must be a loopback address: /metrics is never public"));
            }
            if m.port() == port {
                return Err("METRICS_ADDR must not be the public PORT".into());
            }
        }
        let feedback = feedback(&var)?;
        Ok(Config {
            addr: SocketAddr::new(host, port),
            data_dir,
            allowed_origins,
            web_dir,
            packs_dir,
            create_per_hour,
            create_global_per_hour,
            room_idle,
            quota,
            max_open_rooms,
            room_memory_bytes,
            max_boards,
            max_storage_bytes,
            replay_dir,
            metrics_addr,
            feedback,
        })
    }
}
