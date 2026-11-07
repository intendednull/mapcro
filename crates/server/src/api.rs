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
    /// Allow a creation from `ip` if both its own and the server-wide hourly budgets have room.
    fn allow(&self, ip: IpAddr, per_hour: u32, global_per_hour: u32) -> bool {
        let mut w = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        w.retain(|_, (start, _)| now.duration_since(*start) < Duration::from_secs(3600));
        let total: u32 = w.values().map(|(_, n)| *n).sum();
        if total >= global_per_hour {
            return false;
        }
        let entry = w.entry(client_key(ip)).or_insert((now, 0));
        if entry.1 >= per_hour {
            return false;
        }
        entry.1 += 1;
        true
    }
}

/// The unit a limit applies to: an IPv4 address, or an IPv6 /64. One host commonly owns a whole
/// /64, so per-address IPv6 limits are trivially rotated around (security review M2).
pub fn client_key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let s = v6.segments();
                IpAddr::V6(std::net::Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
        },
    }
}

/// The client's address. Behind Caddy (loopback peer) trust its X-Forwarded-For; otherwise the peer.
pub fn client_ip(peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
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
    if !app.limiter.allow(client_ip(peer, &headers), app.config.create_per_hour, app.config.create_global_per_hour) {
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

/// The caller's link from `Authorization: Bearer <token>`, if it may manage links on this board:
/// the owner, or an editor (who manages the links it minted). View links can't.
#[allow(clippy::result_large_err)] // the error *is* the HTTP response
async fn require_manager(app: &AppState, board: &str, headers: &HeaderMap) -> Result<crate::store::LinkRow, Response> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|t| links::plausible_token(t))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "link token required"))?;
    match app.store.link(links::hash(token)).await {
        Ok(Some(l)) if l.board == board && !l.revoked && matches!(l.role, LinkRole::Owner | LinkRole::Edit) => Ok(l),
        Ok(_) => Err(err(StatusCode::FORBIDDEN, "this link cannot share")),
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
    let caller = match require_manager(&app, &board, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if body.role == LinkRole::Owner {
        return err(StatusCode::BAD_REQUEST, "owner links cannot be minted");
    }
    let Some(label) = clean_label(&body.label, 40) else {
        return err(StatusCode::BAD_REQUEST, "invalid label");
    };
    let token = links::new_token();
    let hash = links::hash(&token);
    let link_id = links::link_id(&hash).to_owned();
    match app.store.add_link(hash, board, body.role, label, caller.hash, now()).await {
        Ok(true) => (StatusCode::CREATED, Json(Minted { link_id, token })).into_response(),
        // The caller's link was revoked between the check and the insert.
        Ok(false) => err(StatusCode::FORBIDDEN, "this link cannot share"),
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
    /// Public id of the link that minted this one.
    minted_by: Option<String>,
}

pub async fn list_links(State(app): State<AppState>, Path(board): Path<String>, headers: HeaderMap) -> Response {
    let caller = match require_manager(&app, &board, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let is_owner = caller.role == LinkRole::Owner;
    match app.store.links_visible_to(board, caller.hash, is_owner).await {
        Ok(rows) => Json(
            rows.into_iter()
                .map(|l| LinkInfo {
                    link_id: links::link_id(&l.hash).to_owned(),
                    role: l.role,
                    label: l.label,
                    created_at: l.created_at,
                    revoked: l.revoked,
                    minted_by: l.minted_by.as_deref().map(|h| links::link_id(h).to_owned()),
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
    let caller = match require_manager(&app, &board, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let is_owner = caller.role == LinkRole::Owner;
    match app.store.revoke(board.clone(), link_id, caller.hash, is_owner, now()).await {
        Ok(hashes) if !hashes.is_empty() => {
            if let Some(room) = app.rooms.lookup(&board) {
                for link_hash in hashes {
                    let _ = room.send(crate::room::RoomCmd::Revoke { link_hash }).await;
                }
            }
            StatusCode::NO_CONTENT.into_response()
        }
        // Not found and not yours look the same, so link ids can't be probed.
        Ok(_) => err(StatusCode::NOT_FOUND, "no such link"),
        Err(e) => internal(e),
    }
}

#[derive(Serialize)]
struct Rotated {
    owner_token: String,
}

/// Replace a (possibly leaked) owner token (security review M4). The caller presents the current
/// owner token and gets a new one; the old one stops working, and its live sessions close.
pub async fn rotate_owner(State(app): State<AppState>, Path(board): Path<String>, headers: HeaderMap) -> Response {
    let caller = match require_manager(&app, &board, &headers).await {
        Ok(c) if c.role == LinkRole::Owner => c,
        Ok(_) => return err(StatusCode::FORBIDDEN, "only the owner can rotate the owner token"),
        Err(r) => return r,
    };
    let token = links::new_token();
    match app.store.rotate_owner(board.clone(), caller.hash.clone(), links::hash(&token), now()).await {
        Ok(true) => {
            if let Some(room) = app.rooms.lookup(&board) {
                let _ = room.send(crate::room::RoomCmd::Revoke { link_hash: caller.hash }).await;
            }
            Json(Rotated { owner_token: token }).into_response()
        }
        Ok(false) => err(StatusCode::CONFLICT, "owner token changed concurrently"),
        Err(e) => internal(e),
    }
}

#[derive(Deserialize)]
pub struct CloneBoard {
    #[serde(default)]
    title: Option<String>,
}

/// Copy a board's current state into a brand-new board with fresh links (operator, 2026-11-06):
/// the way to "drop" someone is to move to a clone and not share its links with them. Any
/// valid link can clone, since anyone who can see a board could copy it by hand. History,
/// presence and links are not copied. Counts against the creation limits.
pub async fn clone_board(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(board): Path<String>,
    headers: HeaderMap,
    Json(body): Json<CloneBoard>,
) -> Response {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|t| links::plausible_token(t));
    let Some(token) = token else {
        return err(StatusCode::UNAUTHORIZED, "link token required");
    };
    match app.store.link(links::hash(token)).await {
        Ok(Some(l)) if l.board == board && !l.revoked => {}
        Ok(_) => return err(StatusCode::FORBIDDEN, "not a link to this board"),
        Err(e) => return internal(e),
    }
    if !app.limiter.allow(client_ip(peer, &headers), app.config.create_per_hour, app.config.create_global_per_hour) {
        return err(StatusCode::TOO_MANY_REQUESTS, "too many boards created; try again later");
    }
    let mut doc = match app.rooms.snapshot(&board).await {
        Ok(d) => d,
        Err(e) => return internal(e),
    };
    if let Some(title) = body.title {
        let Some(title) = clean_label(&title, mapcro_schema::LIMITS.max_title) else {
            return err(StatusCode::BAD_REQUEST, "invalid title");
        };
        if !title.is_empty() {
            doc = mapcro_schema::retitle(doc, &title);
        }
    }
    let new_board = links::new_board_id();
    let owner_token = links::new_token();
    match app.store.create_board(new_board.clone(), doc, links::hash(&owner_token), now()).await {
        Ok(()) => (StatusCode::CREATED, Json(Created { board: new_board, owner_token })).into_response(),
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
