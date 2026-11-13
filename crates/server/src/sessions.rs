//! Sessions: several boards as tabs (docs/specs/sessions.md). The server side: creating a
//! session and adding boards to it as grants. A session's links reuse the board link handlers
//! (api.rs, with `RoomKind::Session`), its document is a room like a board's, and opening a
//! tab's board through it is `auth::resolve`.
//!
//! A board token is presented once, in a request body, and dropped: it is never logged, stored,
//! echoed or put in the session's document (§3.2).

use crate::api::{client_ip, client_key, err, internal, now, server_full};
use crate::auth::{self, Denied, RoomKind, min_role};
use crate::store::{GrantWrite, NewGrant};
use crate::{AppState, links};
use axum::Json;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use mapcro_engine::wire::LinkRole;
use mapcro_schema::{BoardId, GrantId, LIMITS, Record, RecordId};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Grants one session link may add in an hour (§3.8).
pub const GRANTS_PER_LINK_PER_HOUR: u32 = 120;
/// Grants one address may add in an hour (§3.8).
pub const GRANTS_PER_ADDRESS_PER_HOUR: u32 = 240;

/// Live grants one session may hold (§3.8): as many as it may hold tabs.
const MAX_LIVE_GRANTS: u64 = LIMITS.max_tabs as u64;
/// Live grants one top-level link may mint on a board (§3.8). Any link to a board, a view
/// link too, may add it to a session, and each grant is a links row on the board. Counting per
/// top-level ancestor link (the one the owner minted) means a holder fills only its own
/// allowance, never the owner's, and can't dodge it by minting child links.
pub const MAX_GRANTS_PER_BOARD: u64 = 50;

/// The per-link and per-address hourly windows on adding grants: each one writes a `links` row
/// on somebody's board (§3.8).
#[derive(Default)]
pub struct GrantLimiter {
    windows: Mutex<(Windows<String>, Windows<IpAddr>)>,
}

/// Each key's window start and count.
type Windows<K> = HashMap<K, (Instant, u32)>;

impl GrantLimiter {
    fn allow(&self, link: &str, ip: IpAddr) -> bool {
        let mut w = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let hour = Duration::from_secs(3600);
        w.0.retain(|_, (start, _)| now.duration_since(*start) < hour);
        w.1.retain(|_, (start, _)| now.duration_since(*start) < hour);
        let by_link = w.0.get(link).map_or(0, |e| e.1);
        let by_ip = w.1.get(&ip).map_or(0, |e| e.1);
        if by_link >= GRANTS_PER_LINK_PER_HOUR || by_ip >= GRANTS_PER_ADDRESS_PER_HOUR {
            return false;
        }
        w.0.entry(link.to_owned()).or_insert((now, 0)).1 += 1;
        w.1.entry(ip).or_insert((now, 0)).1 += 1;
        true
    }
}

fn random_id() -> RecordId {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS random number generator unavailable");
    RecordId(u128::from_le_bytes(b))
}

/// One line of at most `max` characters: newlines become spaces, the rest is cut.
fn one_line(s: &str, max: usize) -> String {
    let s: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(max)
        .collect();
    s.trim().to_owned()
}

/// The board link a body presents for `board`, and the role it holds, if it's a live board link
/// to that board. Not found, revoked, another board's or a session's all read the same.
#[allow(clippy::result_large_err)] // the error *is* the HTTP response
async fn board_link(
    app: &AppState,
    board: &str,
    token: &str,
) -> Result<(String, LinkRole), Response> {
    let refused = || err(StatusCode::FORBIDDEN, "not a link to this board");
    if !links::plausible_board_id(board) || !links::plausible_token(token) {
        return Err(refused());
    }
    let hash = links::hash(token);
    match app.store.link(hash.clone()).await {
        Ok(Some(l)) if l.board == board && !l.revoked && l.kind == RoomKind::Board => {
            Ok((hash, l.role))
        }
        Ok(_) => Err(refused()),
        Err(e) => Err(internal(e)),
    }
}

/// The role a grant gets: what the adder's link holds, never more than edit (owner powers are
/// never delegated), and lowered by `asked` if asked (§3.2 step 3).
fn grant_role(held: LinkRole, asked: Option<LinkRole>) -> LinkRole {
    min_role(
        min_role(held, LinkRole::Edit),
        asked.unwrap_or(LinkRole::Edit),
    )
}

/// The grant's links row label on the board: "Session: <title>", as a label may be (§3.2).
fn grant_label(session_title: &str) -> String {
    one_line(&format!("Session: {session_title}"), LIMITS.max_label)
}

/// A grant to write for `board`, with a fresh grant id and a links row whose token nobody holds.
fn new_grant(
    session: &str,
    board: &str,
    role: LinkRole,
    label: String,
    minted_by: String,
    added_by: String,
) -> NewGrant {
    NewGrant {
        session: session.to_owned(),
        grant_id: links::random_b64(16),
        board: board.to_owned(),
        // The token is thrown away at once: the row is usable only through the session.
        link_hash: links::hash(&links::new_token()),
        role,
        label,
        minted_by,
        added_by,
        now: now(),
        max_live: MAX_LIVE_GRANTS,
        max_per_board: MAX_GRANTS_PER_BOARD,
    }
}

#[derive(Serialize)]
struct GrantInfo {
    grant_id: String,
    board: String,
    role: LinkRole,
}

#[derive(Deserialize)]
pub struct CreateSession {
    #[serde(default)]
    title: String,
    /// A first tab: this board, opened through the link `board_token` (§7.3).
    #[serde(default)]
    board: Option<String>,
    #[serde(default)]
    board_token: Option<String>,
    #[serde(default)]
    role: Option<LinkRole>,
}

#[derive(Serialize)]
struct CreatedSession {
    session: String,
    owner_token: String,
    /// The first tab's record id, when the session was made from a board.
    #[serde(skip_serializing_if = "Option::is_none")]
    tab: Option<RecordId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    grant: Option<GrantInfo>,
}

/// `POST /api/sessions`: a new session, owner token back. With `board` and `board_token`, its
/// first tab is that board, through a grant made in the same request (§7.3). Counts against
/// the board creation limits and caps, as a board does (§3.8).
pub async fn create(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<CreateSession>,
) -> Response {
    let ip = client_ip(peer, &headers);
    if !app.limiter.allow(
        ip,
        app.config.create_per_hour,
        app.config.create_global_per_hour,
    ) {
        return err(
            StatusCode::TOO_MANY_REQUESTS,
            "too many boards created; try again later",
        );
    }
    let title = body.title.trim();
    if title.chars().count() > LIMITS.max_title || title.chars().any(char::is_control) {
        return err(StatusCode::BAD_REQUEST, "invalid title");
    }
    let title = if title.is_empty() {
        "Untitled session".to_owned()
    } else {
        title.to_owned()
    };
    let session = links::new_board_id();
    let owner_token = links::new_token();
    let owner_hash = links::hash(&owner_token);
    let mut first = None;
    match (&body.board, &body.board_token) {
        (None, None) => {}
        (Some(board), Some(token)) => {
            let (minted_by, held) = match board_link(&app, board, token).await {
                Ok(l) => l,
                Err(r) => return r,
            };
            if !app.grants.allow(&owner_hash, client_key(ip)) {
                return err(
                    StatusCode::TOO_MANY_REQUESTS,
                    "too many games added; try again later",
                );
            }
            // The tab is named for the board, as its title reads now (§7.2).
            let name = match app.rooms.snapshot(board).await {
                Ok(doc) => doc
                    .iter_live()
                    .find_map(|(_, r)| {
                        if let Record::BoardMeta(m) = r {
                            Some(one_line(&m.title, LIMITS.max_name))
                        } else {
                            None
                        }
                    })
                    .unwrap_or_default(),
                Err(e) => return internal(e),
            };
            let role = grant_role(held, body.role);
            let g = new_grant(
                &session,
                board,
                role,
                grant_label(&title),
                minted_by,
                owner_hash.clone(),
            );
            first = Some((board.clone(), name, g));
        }
        _ => return err(StatusCode::BAD_REQUEST, "board and board_token go together"),
    }
    let mut tab_id = None;
    let doc = mapcro_schema::session_genesis(
        || {
            let id = random_id();
            tab_id = Some(id); // the last id drawn is the tab's (the meta's is first)
            id
        },
        &title,
        &first
            .as_ref()
            .map(|(b, name, g)| {
                vec![(
                    BoardId(b.clone()),
                    GrantId(g.grant_id.clone()),
                    name.clone(),
                )]
            })
            .unwrap_or_default(),
    );
    let info = first.as_ref().map(|(b, _, g)| GrantInfo {
        grant_id: g.grant_id.clone(),
        board: b.clone(),
        role: g.role,
    });
    let grant = first.map(|(_, _, g)| g);
    let had_grant = grant.is_some();
    match app
        .store
        .create_room(
            RoomKind::Session,
            session.clone(),
            doc,
            owner_hash,
            now(),
            app.config.max_boards,
            app.config.max_storage_bytes,
            grant,
        )
        .await
    {
        Ok(GrantWrite::Written) => (
            StatusCode::CREATED,
            Json(CreatedSession {
                session,
                owner_token,
                tab: tab_id.filter(|_| had_grant),
                grant: info,
            }),
        )
            .into_response(),
        // The board link was revoked between the check and the write.
        Ok(GrantWrite::Refused | GrantWrite::Existing(_)) => err(StatusCode::FORBIDDEN, "not a link to this board"),
        Ok(GrantWrite::BoardFull) => err(StatusCode::CONFLICT, "board full"),
        Ok(GrantWrite::Full) => err(StatusCode::CONFLICT, "session full"),
        Err(crate::store::StoreError::Full) => server_full(),
        Err(e) => internal(e),
    }
}

#[derive(Deserialize)]
pub struct AddGrant {
    board: String,
    board_token: String,
    /// "Can view": an editor may add a board view-only (§12, decision 2). Only ever lowers.
    #[serde(default)]
    role: Option<LinkRole>,
}

/// `POST /api/sessions/{s}/grants`: a session editor delegates its access to a board to the
/// session (§3.2). The client then adds the `Tab` with an ordinary edit, so it's in the adder's
/// undo. The answer never holds a board token.
pub async fn add_grant(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(session): Path<String>,
    headers: HeaderMap,
    Json(body): Json<AddGrant>,
) -> Response {
    let caller = match auth::own_link(&app, &session, RoomKind::Session, &headers).await {
        Ok(a) if a.can_edit() => a,
        Ok(_) => return err(StatusCode::FORBIDDEN, "this link can only view"),
        Err(Denied::Missing) => return err(StatusCode::UNAUTHORIZED, "link token required"),
        Err(Denied::Refused) => return err(StatusCode::FORBIDDEN, "not a link to this session"),
        Err(Denied::Storage(e)) => return internal(e),
        Err(Denied::Unavailable) => return err(StatusCode::SERVICE_UNAVAILABLE, "busy; try again"),
    };
    let (minted_by, held) = match board_link(&app, &body.board, &body.board_token).await {
        Ok(l) => l,
        Err(r) => return r,
    };
    if !app
        .grants
        .allow(&caller.link_hash, client_key(client_ip(peer, &headers)))
    {
        return err(
            StatusCode::TOO_MANY_REQUESTS,
            "too many games added; try again later",
        );
    }
    let title = match app.rooms.snapshot(&session).await {
        Ok(doc) => doc
            .iter_live()
            .find_map(|(_, r)| {
                if let Record::SessionMeta(m) = r {
                    Some(m.title.clone())
                } else {
                    None
                }
            })
            .unwrap_or_default(),
        Err(e) => return internal(e),
    };
    let role = grant_role(held, body.role);
    let g = new_grant(
        &session,
        &body.board,
        role,
        grant_label(&title),
        minted_by,
        caller.link_hash,
    );
    let mut info = GrantInfo {
        grant_id: g.grant_id.clone(),
        board: body.board,
        role,
    };
    match app.store.add_grant(g).await {
        Ok(GrantWrite::Written) => (StatusCode::CREATED, Json(info)).into_response(),
        // Added already, through this link at this role: that grant.
        Ok(GrantWrite::Existing(id)) => {
            info.grant_id = id;
            (StatusCode::OK, Json(info)).into_response()
        }
        Ok(GrantWrite::Refused) => err(StatusCode::FORBIDDEN, "not a link to this board"),
        Ok(GrantWrite::Full) => err(StatusCode::CONFLICT, "session full"),
        Ok(GrantWrite::BoardFull) => err(StatusCode::CONFLICT, "board full"),
        Err(e) => internal(e),
    }
}

/// `DELETE /api/sessions/{s}/grants/{g}`: withdraw a grant from the session's side (§3.7). Its
/// links row on the board is revoked, so connections through it close and its tabs read "No
/// access". The session's owner may, and so may the session link that added it; nobody else,
/// and never through a grant. Not found and not yours read the same.
pub async fn withdraw_grant(
    State(app): State<AppState>,
    Path((session, grant)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let caller = match auth::own_link(&app, &session, RoomKind::Session, &headers).await {
        Ok(a) => a,
        Err(Denied::Missing) => return err(StatusCode::UNAUTHORIZED, "link token required"),
        Err(Denied::Refused) => return err(StatusCode::FORBIDDEN, "not a link to this session"),
        Err(Denied::Storage(e)) => return internal(e),
        Err(Denied::Unavailable) => return err(StatusCode::SERVICE_UNAVAILABLE, "busy; try again"),
    };
    let not_found = || err(StatusCode::NOT_FOUND, "no such grant");
    if !mapcro_schema::is_id22(&grant) {
        return not_found();
    }
    let is_owner = caller.role == LinkRole::Owner;
    match app
        .store
        .revoke_grant(session, grant, caller.link_hash, is_owner, now())
        .await
    {
        // Committed: now close what came in through it.
        Ok(Some((board, link_hash))) => {
            app.rooms.revoke_in(&board, vec![link_hash]);
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(None) => not_found(),
        Err(e) => internal(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_grant_never_holds_more_than_edit_or_the_adders_role() {
        use LinkRole::*;
        for (held, asked, want) in [
            (Owner, None, Edit),
            (Owner, Some(Owner), Edit),
            (Owner, Some(View), View),
            (Edit, None, Edit),
            (Edit, Some(View), View),
            (View, None, View),
            (View, Some(Edit), View),
            (View, Some(Owner), View),
        ] {
            assert_eq!(grant_role(held, asked), want, "{held:?} asked {asked:?}");
        }
    }

    #[test]
    fn grant_labels_fit_a_label() {
        let l = grant_label(&"x\ny".repeat(40));
        assert!(
            l.chars().count() <= LIMITS.max_label && !l.contains('\n'),
            "{l}"
        );
        assert!(l.starts_with("Session: "));
    }

    #[test]
    fn the_grant_limiter_counts_per_link_and_per_address() {
        let l = GrantLimiter::default();
        let a: IpAddr = "10.0.0.1".parse().expect("ip");
        let b: IpAddr = "10.0.0.2".parse().expect("ip");
        for _ in 0..GRANTS_PER_LINK_PER_HOUR {
            assert!(l.allow("one", a));
        }
        assert!(
            !l.allow("one", b),
            "the link's hour is spent, from any address"
        );
        for _ in 0..GRANTS_PER_ADDRESS_PER_HOUR - GRANTS_PER_LINK_PER_HOUR {
            assert!(l.allow("two", a));
        }
        assert!(
            !l.allow("three", a),
            "the address's hour is spent, for any link"
        );
        assert!(l.allow("three", b));
    }
}
