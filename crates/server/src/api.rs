//! HTTP API: create boards, mint, list and revoke links (spec §11). No accounts: the owner
//! token, held by the creator's device, is the only key to link management.

use crate::{AppState, links};
use axum::Json;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use mapcro_engine::wire::LinkRole;
use mapcro_schema::{RecordId, genesis};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

fn internal(e: impl std::fmt::Display) -> Response {
    tracing::error!(error = %e, "request failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

fn clean_label(s: &str, max: usize) -> Option<String> {
    let s = s.trim();
    (s.chars().count() <= max && !s.chars().any(char::is_control)).then(|| s.to_owned())
}

/// Per-IP fixed-window limiter for board creation (storage spam, spec §11).
#[derive(Default)]
pub struct CreateLimiter {
    windows: Mutex<HashMap<IpAddr, (Instant, u32)>>,
}

impl CreateLimiter {
    fn allow(&self, ip: IpAddr, per_hour: u32) -> bool {
        let mut w = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        w.retain(|_, (start, _)| now.duration_since(*start) < Duration::from_secs(3600));
        let entry = w.entry(ip).or_insert((now, 0));
        entry.1 += 1;
        entry.1 <= per_hour
    }
}

/// The client's address. Behind Caddy (loopback peer) trust its X-Forwarded-For; otherwise the peer.
fn client_ip(peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
    if peer.ip().is_loopback()
        && let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next_back())
            .and_then(|v| v.trim().parse().ok())
    {
        return ip;
    }
    peer.ip()
}

#[derive(Deserialize)]
pub struct CreateBoard {
    #[serde(default)]
    title: String,
}

#[derive(Serialize)]
struct Created {
    board: String,
    owner_token: String,
}

pub async fn create_board(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<CreateBoard>,
) -> Response {
    if !app.limiter.allow(client_ip(peer, &headers), app.config.create_per_hour) {
        return err(StatusCode::TOO_MANY_REQUESTS, "too many boards created; try again later");
    }
    let Some(title) = clean_label(&body.title, mapcro_schema::LIMITS.max_title) else {
        return err(StatusCode::BAD_REQUEST, "invalid title");
    };
    let title = if title.is_empty() { "Untitled board".to_owned() } else { title };
    let mut ids = Vec::new();
    let doc = genesis(
        || {
            let mut b = [0u8; 16];
            getrandom::fill(&mut b).expect("OS random number generator unavailable");
            let id = RecordId(u128::from_le_bytes(b));
            ids.push(id);
            id
        },
        &title,
    );
    let board = links::new_board_id();
    let owner_token = links::new_token();
    match app.store.create_board(board.clone(), doc, links::hash(&owner_token), now()).await {
        Ok(()) => (StatusCode::CREATED, Json(Created { board, owner_token })).into_response(),
        Err(e) => internal(e),
    }
}

/// Checks the `Authorization: Bearer <owner token>` header against this board.
#[allow(clippy::result_large_err)] // the error *is* the HTTP response
async fn require_owner(app: &AppState, board: &str, headers: &HeaderMap) -> Result<(), Response> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|t| links::plausible_token(t))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "owner token required"))?;
    match app.store.link(links::hash(token)).await {
        Ok(Some(l)) if l.board == board && l.role == LinkRole::Owner && !l.revoked => Ok(()),
        Ok(_) => Err(err(StatusCode::FORBIDDEN, "not the owner of this board")),
        Err(e) => Err(internal(e)),
    }
}

#[derive(Deserialize)]
pub struct MintLink {
    role: LinkRole,
    #[serde(default)]
    label: String,
}

#[derive(Serialize)]
struct Minted {
    link_id: String,
    token: String,
}

pub async fn mint_link(
    State(app): State<AppState>,
    Path(board): Path<String>,
    headers: HeaderMap,
    Json(body): Json<MintLink>,
) -> Response {
    if let Err(r) = require_owner(&app, &board, &headers).await {
        return r;
    }
    if body.role == LinkRole::Owner {
        return err(StatusCode::BAD_REQUEST, "owner links cannot be minted");
    }
    let Some(label) = clean_label(&body.label, 40) else {
        return err(StatusCode::BAD_REQUEST, "invalid label");
    };
    let token = links::new_token();
    let hash = links::hash(&token);
    let link_id = links::link_id(&hash).to_owned();
    match app.store.add_link(hash, board, body.role, label, now()).await {
        Ok(()) => (StatusCode::CREATED, Json(Minted { link_id, token })).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Serialize)]
struct LinkInfo {
    link_id: String,
    role: LinkRole,
    label: String,
    created_at: i64,
    revoked: bool,
}

pub async fn list_links(State(app): State<AppState>, Path(board): Path<String>, headers: HeaderMap) -> Response {
    if let Err(r) = require_owner(&app, &board, &headers).await {
        return r;
    }
    match app.store.links_for(board).await {
        Ok(rows) => Json(
            rows.into_iter()
                .map(|l| LinkInfo {
                    link_id: links::link_id(&l.hash).to_owned(),
                    role: l.role,
                    label: l.label,
                    created_at: l.created_at,
                    revoked: l.revoked,
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => internal(e),
    }
}

pub async fn revoke_link(
    State(app): State<AppState>,
    Path((board, link_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = require_owner(&app, &board, &headers).await {
        return r;
    }
    match app.store.revoke(board.clone(), link_id, now()).await {
        Ok(Some(hash)) => {
            if let Some(room) = app.rooms.lookup(&board) {
                let _ = room.send(crate::room::RoomCmd::Revoke { link_hash: hash }).await;
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(None) => err(StatusCode::NOT_FOUND, "no such link"),
        Err(e) => internal(e),
    }
}

pub async fn healthz(State(app): State<AppState>) -> Response {
    match app.store.ping().await {
        Ok(()) => (StatusCode::OK, format!("ok rooms={}", app.rooms.open_count())).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "health check failed");
            (StatusCode::SERVICE_UNAVAILABLE, "storage unavailable").into_response()
        }
    }
}
