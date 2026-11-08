//! mapcro-server. Config from env; binds 127.0.0.1:$PORT behind Caddy (infra contract).

mod api;
mod codec;
mod config;
mod links;
mod matches;
mod packs;
mod replays;
mod room;
mod store;
mod ws;

use axum::Router;
use axum::http::{HeaderName, HeaderValue};
use axum::routing::{delete, get, post};
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<config::Config>,
    pub store: store::Store,
    pub rooms: room::Rooms,
    pub limiter: Arc<api::CreateLimiter>,
    /// Open WebSockets per client address key.
    pub sockets: Arc<std::sync::Mutex<std::collections::HashMap<std::net::IpAddr, usize>>>,
    pub packs: Arc<packs::Packs>,
    /// Bytes of fresh-join base frames being built and sent at once, in KiB (ws.rs).
    pub base_sends: Arc<tokio::sync::Semaphore>,
}

fn header(name: &'static str, value: &'static str) -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::overriding(HeaderName::from_static(name), HeaderValue::from_static(value))
}

/// Ignore a browser's cached copy of a page: always answer with the current file.
async fn fresh_request(mut req: axum::extract::Request) -> axum::extract::Request {
    let h = req.headers_mut();
    h.remove(axum::http::header::IF_MODIFIED_SINCE);
    h.remove(axum::http::header::IF_NONE_MATCH);
    h.remove(axum::http::header::IF_UNMODIFIED_SINCE);
    h.remove(axum::http::header::IF_RANGE);
    req
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let config = match config::Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("mapcro-server: bad configuration: {e}");
            std::process::exit(2);
        }
    };
    let store = match store::Store::open(&config.data_dir.join("mapcro.sqlite")) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("mapcro-server: cannot open storage: {e}");
            std::process::exit(2);
        }
    };
    let packs = match &config.packs_dir {
        Some(dir) => match packs::Packs::load(dir) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("mapcro-server: {e}");
                std::process::exit(2);
            }
        },
        None => packs::Packs::default(),
    };
    if std::env::var_os("MALLOC_ARENA_MAX").is_none() {
        tracing::warn!("MALLOC_ARENA_MAX is unset: the room memory budget assumes 2 (nix/module.nix sets it)");
    }
    if packs.list.is_empty() {
        tracing::warn!("no asset packs: boards render with placeholder art (set PACKS_DIR)");
    }
    let state = AppState {
        packs: Arc::new(packs),
        rooms: room::Rooms::new(
            store.clone(),
            config.room_idle,
            room::Caps {
                quota: config.quota,
                max_open_rooms: config.max_open_rooms,
                room_memory_bytes: config.room_memory_bytes,
                max_storage_bytes: config.max_storage_bytes,
            },
        ),
        store,
        limiter: Arc::new(api::CreateLimiter::default()),
        sockets: Arc::default(),
        base_sends: Arc::new(tokio::sync::Semaphore::new(ws::BASE_SENDS_KIB)),
        config: Arc::new(config.clone()),
    };
    replays::spawn(state.clone());

    let mut app = Router::new()
        .route("/healthz", get(api::healthz))
        .route("/ws", get(ws::upgrade))
        .route("/api/boards", post(api::create_board))
        .route("/api/boards/{board}/links", post(api::mint_link).get(api::list_links))
        .route("/api/boards/{board}/links/{link}", delete(api::revoke_link))
        .route("/api/boards/{board}/owner/rotate", post(api::rotate_owner))
        .route("/api/boards/{board}/clone", post(api::clone_board))
        .route("/api/packs", get(packs::list))
        .route("/api/matches/{id}", get(matches::get))
        .route("/packs/{pack}/{*file}", get(packs::file));
    if let Some(web) = &config.web_dir {
        // Vite's /assets/* names carry a content hash: cache them forever. Everything else
        // (index.html, the SPA fallback, fonts) must never be served stale after a deploy. The
        // nix store stamps every file 1970, so a browser's If-Modified-Since would always get a
        // 304: drop conditional headers and say no-store.
        let index = web.join("index.html");
        let assets = ServeDir::new(web.join("assets"));
        let pages = ServeDir::new(web).fallback(ServeFile::new(index));
        app = app
            .nest_service(
                "/assets",
                tower::ServiceBuilder::new()
                    .layer(header("cache-control", "public, max-age=31536000, immutable"))
                    .service(assets),
            )
            .fallback_service(
                tower::ServiceBuilder::new()
                    .layer(axum::middleware::map_request(fresh_request))
                    .layer(header("cache-control", "no-store"))
                    .service(pages),
            );
    }
    let app = app
        .layer(RequestBodyLimitLayer::new(16 * 1024))
        // After the 16 KiB limit, so replay uploads stream under their own cap (replays.rs).
        .merge(replays::routes())
        .layer(header("referrer-policy", "no-referrer"))
        .layer(header("x-content-type-options", "nosniff"))
        .layer(header("strict-transport-security", "max-age=63072000; includeSubDomains"))
        .layer(header("cross-origin-opener-policy", "same-origin"))
        .layer(header("cross-origin-resource-policy", "same-origin"))
        .layer(header("x-frame-options", "DENY"))
        .layer(header(
            "content-security-policy",
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; \
             form-action 'none'",
        ))
        .with_state(state);

    let listener = match tokio::net::TcpListener::bind(config.addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("mapcro-server: cannot bind {}: {e}", config.addr);
            std::process::exit(2);
        }
    };
    tracing::info!(addr = %config.addr, "listening");
    let shutdown = async {
        let ctrl_c = tokio::signal::ctrl_c();
        #[cfg(unix)]
        let term = async {
            if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                s.recv().await;
            }
        };
        #[cfg(not(unix))]
        let term = std::future::pending::<()>();
        tokio::select! { _ = ctrl_c => {}, _ = term => {} }
        tracing::info!("shutting down");
    };
    if let Err(e) = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown)
        .await
    {
        eprintln!("mapcro-server: {e}");
        std::process::exit(1);
    }
}
