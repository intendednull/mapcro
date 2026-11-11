//! mapcro-server. Config from env; binds 127.0.0.1:$PORT behind Caddy (infra contract).

mod api;
mod codec;
mod config;
mod feedback;
mod links;
mod matches;
mod metrics;
mod packs;
mod replay_queue;
mod replays;
mod room;
mod stats;
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
    /// The feedback form's per-client and server-wide windows.
    pub feedback: Arc<feedback::Limiter>,
    /// Open WebSockets per client address key.
    pub sockets: Arc<std::sync::Mutex<std::collections::HashMap<std::net::IpAddr, usize>>>,
    pub packs: Arc<packs::Packs>,
    /// Bytes of fresh-join base frames being built and sent at once, in KiB (ws.rs).
    pub base_sends: Arc<tokio::sync::Semaphore>,
}

/// Gzip or zstd for a client that accepts it: for the timeline routes, whose JSON is 1–2 MB and
/// compresses about 3× (the edge proxy doesn't compress it; FORMAT 7 study).
pub fn compression() -> tower_http::compression::CompressionLayer {
    tower_http::compression::CompressionLayer::new().no_br().no_deflate()
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

/// Count every request by its route template and status class (never its raw path: that holds
/// board ids), and log a 5xx in the failures table.
async fn track(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    use metrics::Label;
    let route = metrics::Route::from_template(req.extensions().get::<axum::extract::MatchedPath>().map(|p| p.as_str()));
    let method = match *req.method() {
        axum::http::Method::GET => "GET",
        axum::http::Method::POST => "POST",
        axum::http::Method::PUT => "PUT",
        axum::http::Method::DELETE => "DELETE",
        _ => "other",
    };
    let res = next.run(req).await;
    let status = res.status().as_u16();
    metrics::get().http_requests.inc((route, metrics::StatusClass::of(status)));
    if status >= 500 {
        use metrics::failures::Part;
        metrics::failures::record(
            metrics::failures::FailureKind::Http,
            route.as_str(),
            &[Part::Word(method), Part::Word(route.as_str()), Part::Word("answered"), Part::Int(status.into())],
        );
    }
    res
}

fn main() {
    // `mapcro-server stats …`: read the metrics tables and exit (no server, no config).
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("stats") {
        std::process::exit(stats::main(&args[1..]));
    }
    serve();
}

#[tokio::main]
async fn serve() {
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
    if config.feedback.is_none() {
        tracing::info!("feedback form off (no FEEDBACK_GITHUB_TOKEN_FILE)");
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
        feedback: Arc::default(),
        sockets: Arc::default(),
        base_sends: Arc::new(tokio::sync::Semaphore::new(ws::BASE_SENDS_KIB)),
        config: Arc::new(config.clone()),
    };
    replays::spawn(state.clone());
    metrics::spawn(state.clone());
    // Bound before the public listener, so its address is out before "listening on" below.
    if let Some(addr) = config.metrics_addr
        && let Some(listener) = metrics::bind(addr).await
    {
        tokio::spawn(metrics::serve(state.clone(), listener));
    }

    let mut app = Router::new()
        .route("/healthz", get(api::healthz))
        .route("/ws", get(ws::upgrade))
        .route("/api/boards", post(api::create_board))
        .route("/api/boards/{board}/links", post(api::mint_link).get(api::list_links))
        .route("/api/boards/{board}/links/{link}", delete(api::revoke_link))
        .route("/api/boards/{board}/owner/rotate", post(api::rotate_owner))
        .route("/api/boards/{board}/clone", post(api::clone_board))
        .route("/api/packs", get(packs::list))
        .route("/api/matches/{id}", get(matches::get).layer(compression()))
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
        // Its own cap: a full description of 4-byte characters is past 16 KiB (feedback.rs).
        .merge(
            Router::new()
                .route("/api/feedback", get(feedback::status).post(feedback::send))
                .layer(axum::extract::DefaultBodyLimit::max(feedback::MAX_BODY_BYTES))
                .layer(RequestBodyLimitLayer::new(feedback::MAX_BODY_BYTES)),
        )
        .layer(header("referrer-policy", "no-referrer"))
        .layer(header("x-content-type-options", "nosniff"))
        .layer(header("strict-transport-security", "max-age=63072000; includeSubDomains"))
        .layer(header("cross-origin-opener-policy", "same-origin"))
        .layer(header("cross-origin-resource-policy", "same-origin"))
        .layer(header("x-frame-options", "DENY"))
        .layer(header(
            "content-security-policy",
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' blob: data:; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; \
             form-action 'none'",
        ))
        // Outermost, so every route, the fallback and every status is counted.
        .layer(axum::middleware::from_fn(track))
        .with_state(state.clone());

    let listener = match tokio::net::TcpListener::bind(config.addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("mapcro-server: cannot bind {}: {e}", config.addr);
            std::process::exit(2);
        }
    };
    // The address actually bound (`PORT=0` takes a free one). Whatever started this process
    // waits for this line: from here connections queue, and the port is ours, not a guess.
    let bound = listener.local_addr().unwrap_or(config.addr);
    tracing::info!(addr = %bound, "listening");
    eprintln!("mapcro-server: listening on {bound}");
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
    metrics::flush(&state).await;
}
