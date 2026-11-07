//! mapcro-server. Config from env; binds 127.0.0.1:$PORT behind Caddy (infra contract).

mod api;
mod config;
mod links;
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
}

fn header(name: &'static str, value: &'static str) -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::overriding(HeaderName::from_static(name), HeaderValue::from_static(value))
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
    let state = AppState {
        rooms: room::Rooms::new(store.clone(), config.room_idle),
        store,
        limiter: Arc::new(api::CreateLimiter::default()),
        sockets: Arc::default(),
        config: Arc::new(config.clone()),
    };

    let mut app = Router::new()
        .route("/healthz", get(api::healthz))
        .route("/ws", get(ws::upgrade))
        .route("/api/boards", post(api::create_board))
        .route("/api/boards/{board}/links", post(api::mint_link).get(api::list_links))
        .route("/api/boards/{board}/links/{link}", delete(api::revoke_link))
        .route("/api/boards/{board}/owner/rotate", post(api::rotate_owner));
    if let Some(web) = &config.web_dir {
        let index = web.join("index.html");
        app = app.fallback_service(ServeDir::new(web).fallback(ServeFile::new(index)));
    }
    let app = app
        .layer(RequestBodyLimitLayer::new(16 * 1024))
        .layer(header("referrer-policy", "no-referrer"))
        .layer(header("x-content-type-options", "nosniff"))
        .layer(header("strict-transport-security", "max-age=63072000; includeSubDomains"))
        .layer(header("cross-origin-opener-policy", "same-origin"))
        .layer(header("cross-origin-resource-policy", "same-origin"))
        .layer(header("x-frame-options", "DENY"))
        .layer(header(
            "content-security-policy",
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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
