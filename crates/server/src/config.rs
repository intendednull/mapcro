//! Configuration from the environment (infra contract: env only, fail fast).

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub addr: SocketAddr,
    pub data_dir: PathBuf,
    /// Origins allowed to open WebSockets, e.g. `https://mapcro.example`. Comma-separated.
    pub allowed_origins: Vec<String>,
    /// Built web client to serve, if any.
    pub web_dir: Option<PathBuf>,
    /// Board creations allowed per client IP per hour.
    pub create_per_hour: u32,
    /// Board creations allowed server-wide per hour (a backstop against address rotation).
    pub create_global_per_hour: u32,
    /// How long an empty room stays loaded.
    pub room_idle: std::time::Duration,
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
            .ok_or("PUBLIC_ORIGIN is required (e.g. https://mapcro.example)")?
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
        Ok(Config { addr: SocketAddr::new(host, port), data_dir, allowed_origins, web_dir, create_per_hour, create_global_per_hour, room_idle })
    }
}
