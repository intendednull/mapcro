//! A board as a file, `<title>.mapcro.json` (spec §6, §11): Download writes one, Import board
//! makes a new board from one. The records' own checks are the schema's (`export_records`,
//! `import_records`); this is the envelope around them and the HTTP routes.
//!
//! **What a file holds:** a header (`format`, `version`, the server's `build`, `exported_at` in
//! unix seconds), the board's live records under their ids, and the ids of the matches it has
//! opened. **What it never holds:** link or owner tokens, link ids or labels, grants, client
//! ids, history, presence, deleted records, or any match timeline (a fetched one comes back by
//! the match id; an uploaded one is asked for again).
//!
//! **An import is untrusted bytes.** It is capped at [`MAX_BYTES`] by the route and checked
//! here for nesting before anything is parsed; the header is read before the body, so a file
//! from a newer build is refused whole ("Newer file"), never half-read. The envelope is strict
//! (an unknown key is refused: a foreign or hand-damaged file), the records are lenient on
//! unknown keys (dropped, never stored: the board is re-serialised from its types), as stored
//! boards and ops always were. Refusals are fixed codes, so no part of a file is ever echoed.

use crate::api::{Created, client_ip, err, internal, now, require_link, server_full};
use crate::{AppState, links};
use axum::Json;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use mapcro_schema::{BUILD_ID, Doc, LIMITS, Record, RecordId};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;

/// What the file says it is.
pub const FORMAT: &str = "mapcro-board";
/// The file format's version. A change to the file's shape, or a record change that an older
/// build's file can't be read into by serde defaults alone, bumps it and adds a step to
/// [`upgrade`]: a pure function from the old version's shape to the next.
pub const VERSION: u64 = 1;
/// The largest file, either way. A board this size as JSON is the largest the server sends as
/// one snapshot (`room::SNAPSHOT_MAX_BYTES`); real boards are kilobytes to a few hundred. The
/// schema's own limits allow ~64 MB, which would never fit the room memory budget as a body.
pub const MAX_BYTES: usize = crate::room::SNAPSHOT_MAX_BYTES;
/// Nesting, in arrays and objects. The format's deepest value (a stroke's point) is at 7.
pub const MAX_DEPTH: usize = 10;

/// The file, as written and read.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BoardFile {
    pub format: String,
    pub version: u64,
    pub build: String,
    pub exported_at: i64,
    pub records: Vec<(RecordId, Record)>,
    #[serde(default)]
    pub matches: Vec<u64>,
}

/// Why a file wasn't imported. Codes, not text: nothing from the file reaches the answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    TooLarge,
    TooDeep,
    /// Not JSON, or not this format at all.
    NotABoard,
    /// From a newer build than this server.
    Newer,
    /// This format, but a record or the board breaks the schema's rules.
    Invalid,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::TooLarge => "too_large",
            Refusal::TooDeep => "too_deep",
            Refusal::NotABoard => "not_a_board",
            Refusal::Newer => "newer",
            Refusal::Invalid => "invalid",
        }
    }

    fn status(self) -> StatusCode {
        match self {
            Refusal::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Refusal::TooDeep | Refusal::NotABoard => StatusCode::BAD_REQUEST,
            Refusal::Newer | Refusal::Invalid => StatusCode::UNPROCESSABLE_ENTITY,
        }
    }
}

/// The board's file.
pub fn write(doc: &Doc, matches: Vec<u64>, exported_at: i64) -> Vec<u8> {
    let file = BoardFile {
        format: FORMAT.to_owned(),
        version: VERSION,
        build: BUILD_ID.to_owned(),
        exported_at,
        records: mapcro_schema::export_records(doc),
        matches,
    };
    serde_json::to_vec(&file).unwrap_or_default()
}

/// Whether `bytes` nest arrays and objects deeper than `max`, outside strings. One pass, no
/// allocation: done before any parse, so depth can't cost a parser's stack or time.
fn too_deep(bytes: &[u8], max: usize) -> bool {
    let (mut depth, mut in_str, mut escaped) = (0usize, false, false);
    for &b in bytes {
        if in_str {
            match b {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_str = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'[' | b'{' => {
                depth += 1;
                if depth > max {
                    return true;
                }
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    false
}

/// The header alone; the rest is skipped unread.
#[derive(Deserialize)]
struct Head {
    format: String,
    version: u64,
}

/// A file of any version this build reads, as the current one. Version 1 is the first; an
/// older version's step goes here (`2 => from_v1(serde_json::from_slice::<V1>(bytes)?)`).
fn upgrade(version: u64, bytes: &[u8]) -> Result<BoardFile, Refusal> {
    match version {
        VERSION => serde_json::from_slice::<BoardFile>(bytes).map_err(|_| Refusal::NotABoard),
        v if v > VERSION => Err(Refusal::Newer),
        _ => Err(Refusal::NotABoard),
    }
}

/// A new board's document and match list from a file, under fresh ids from `next_id`.
/// Titled "Imported board" if the file's title is blank.
pub fn read(bytes: &[u8], next_id: impl FnMut() -> RecordId) -> Result<(Doc, Vec<u64>), Refusal> {
    if bytes.len() > MAX_BYTES {
        return Err(Refusal::TooLarge);
    }
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes); // a byte-order mark
    if too_deep(bytes, MAX_DEPTH) {
        return Err(Refusal::TooDeep);
    }
    let head: Head = serde_json::from_slice(bytes).map_err(|_| Refusal::NotABoard)?;
    if head.format != FORMAT {
        return Err(Refusal::NotABoard);
    }
    let file = upgrade(head.version, bytes)?;
    if file.matches.len() > crate::replays::ATTACHED_MAX {
        return Err(Refusal::Invalid);
    }
    let doc = mapcro_schema::import_records(file.records, next_id).map_err(|_| Refusal::Invalid)?;
    let title = doc
        .iter_live()
        .find_map(|(_, r)| match r {
            Record::BoardMeta(m) => Some(m.title.trim().to_owned()),
            _ => None,
        })
        .unwrap_or_default();
    debug_assert!(title.chars().count() <= LIMITS.max_title);
    let title = if title.is_empty() { "Imported board".to_owned() } else { title };
    Ok((mapcro_schema::retitle(doc, &title), file.matches))
}

fn random_id() -> RecordId {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS random number generator unavailable");
    RecordId(u128::from_le_bytes(b))
}

fn refuse(r: Refusal) -> Response {
    err(r.status(), r.code())
}

/// `GET /api/boards/{board}/export`: the board's file. Any live link, view included, as for
/// Clone: anyone who can see the board could copy it by hand.
pub async fn export(State(app): State<AppState>, Path(board): Path<String>, headers: HeaderMap) -> Response {
    if let Err(r) = require_link(&app, &board, &headers).await {
        return r;
    }
    let doc = match app.rooms.snapshot(&board).await {
        Ok(d) => d,
        Err(e) => return internal(e),
    };
    let matches = crate::replays::attached_ids(&app, &board).await;
    let bytes = match tokio::task::spawn_blocking(move || write(&doc, matches, now())).await {
        Ok(b) => b,
        Err(e) => return internal(e),
    };
    // Never a file this server couldn't import again.
    if bytes.len() > MAX_BYTES {
        return refuse(Refusal::TooLarge);
    }
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
            (header::CONTENT_DISPOSITION, "attachment; filename=\"board.mapcro.json\""),
        ],
        bytes,
    )
        .into_response()
}

#[derive(Serialize)]
struct Imported {
    #[serde(flatten)]
    created: Created,
    title: String,
    matches: Vec<u64>,
}

/// `POST /api/boards/import`: a new board, owned by the caller, from a file's bytes. It never
/// touches an existing board. Shares board creation's limits (per address and server-wide), and
/// an attempt counts whether or not its file is good: the parse is the cost being limited.
pub async fn import(State(app): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Response {
    let ip = client_ip(peer, &headers);
    if !app.limiter.allow(ip, app.config.create_per_hour, app.config.create_global_per_hour) {
        return err(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    let read = tokio::task::spawn_blocking(move || read(&body, random_id)).await;
    let (doc, matches) = match read {
        Ok(Ok(x)) => x,
        Ok(Err(r)) => {
            tracing::info!(why = r.code(), "board import refused");
            return refuse(r);
        }
        Err(e) => return internal(e),
    };
    let title = doc
        .iter_live()
        .find_map(|(_, r)| match r {
            Record::BoardMeta(m) => Some(m.title.clone()),
            _ => None,
        })
        .unwrap_or_default();
    let board = links::new_board_id();
    let owner_token = links::new_token();
    match app.store.create_board(board.clone(), doc, links::hash(&owner_token), now(), app.config.max_boards, app.config.max_storage_bytes).await {
        Ok(()) => {
            let client = crate::api::client_key(ip).to_string();
            let matches = crate::replays::attach_imported(&app, &board, &matches, client).await;
            crate::metrics::get().boards_created.inc((crate::metrics::How::Import,));
            (StatusCode::CREATED, Json(Imported { created: Created { board, owner_token }, title, matches })).into_response()
        }
        Err(crate::store::StoreError::Full) => server_full(),
        Err(e) => internal(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn depth_is_counted_outside_strings() {
        assert!(!too_deep(br#"{"a":[[1]]}"#, 3));
        assert!(too_deep(br#"{"a":[[[1]]]}"#, 3));
        assert!(!too_deep(br#"{"a":"[[[[[[\"[[[["}"#, 1), "brackets in strings, escaped quotes too");
        assert!(too_deep(&b"[".repeat(100_000), MAX_DEPTH));
    }

    #[test]
    fn the_format_s_deepest_value_fits() {
        let mut n = 0u128;
        let doc = mapcro_schema::genesis(
            || {
                n += 1;
                RecordId(n)
            },
            "t",
        );
        let bytes = write(&doc, vec![130816395], 0);
        assert!(!too_deep(&bytes, 6), "a board without strokes is shallower");
        let deepest = br#"{"records":[["0",{"Stroke":{"points":[{"x":0}]}}]]}"#;
        assert!(!too_deep(deepest, 7) && too_deep(deepest, 6));
    }
}
