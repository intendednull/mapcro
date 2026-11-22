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
//!
//! **A file brings in nothing an edit couldn't.** A map-state row, or a scene's state, whose
//! reader is still being deployed is refused in a file as it is in a transaction (`Admit`,
//! docs/specs/map-state.md §4.3), at any file version: a server rolled back to before the reader
//! couldn't load the board.

use crate::api::{Created, client_ip, err, internal, now, require_link, server_full};
use crate::{AppState, links};
use axum::Json;
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use mapcro_schema::{Admit, BUILD_ID, Doc, LIMITS, Record, RecordId};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::time::Duration;

/// What the file says it is.
pub const FORMAT: &str = "mapcro-board";
/// The file format's version. A change to the file's shape, or a record change that an older
/// build's file can't be read into by serde defaults alone, bumps it and adds a step to
/// [`upgrade`]: a pure function from the old version's shape to the next.
///
/// Version 2 is version 1 with a `rows` header: how many map-state rows the build that wrote
/// the file knew (docs/specs/map-state.md §4.3). The reader release read it and wrote version
/// 1; this build writes rows, so it writes version 2: a build from before the reader says
/// "Newer file" rather than dropping the values, which its lenient record parsing would.
///
/// Version 3 is version 2's shape holding a field the builds deployed as store v11 (ce1ec0c)
/// and v12 (3aa59af) read but refuse from outside: a scene name over 24 characters or a
/// comment's side (feedback #56, #59). They read up to version 2, so they say "Newer file" for
/// such a file rather than "Bad file". A board without either is still written as version 2, and
/// imports there. (A stroke's colour is a field write, never in a file: a file holds records.)
///
/// Version 4 is version 2's shape holding a scene that holds its own heroes (`has_heroes`,
/// map-state D2), which the builds deployed as store v12 (18b41c6) and v13 (8efbfac) read but
/// refuse from outside. v13 reads up to version 3 and v12 up to 2, so both say "Newer file" for
/// it. Every scene this build saves from a match holds its heroes, so most of its files are
/// version 4; a board with none is version 3 or 2 as before.
/// Version 5 and 6 (map-state phase 5 Groups A & B, TD-108) are in `mapcro_schema::FILE_VERSIONS`
/// alongside versions 3 and 4; `READS` and `VERSION` derive automatically from the highest live
/// entry (`reads_file_version()`), so flipping rows `Live` in R2/R3 bumps them without touching
/// this file.
pub const VERSION: u64 = mapcro_schema::reads_file_version();
/// The newest version this build reads.
pub const READS: u64 = VERSION;
/// The largest file, either way. A board this size as JSON is the largest the server sends as
/// one snapshot (`room::SNAPSHOT_MAX_BYTES`); real boards are kilobytes to a few hundred. The
/// schema's own limits allow ~64 MB, which would never fit the room memory budget as a body.
pub const MAX_BYTES: usize = crate::room::SNAPSHOT_MAX_BYTES;
/// Nesting, in arrays and objects. The format's deepest value (a stroke's point) is at 7.
pub const MAX_DEPTH: usize = 10;
/// Downloads being built at once, server-wide, by what they hold in KiB: 32 MiB. One costs
/// twice the board's JSON (its copy of the board, and the file); past the budget a download is
/// refused ("busy"), not queued, so a burst of them never holds memory waiting. A board near
/// [`MAX_BYTES`] takes half, so two of the largest run at once; a real board, a few hundred KiB.
pub const EXPORT_BUDGET_KIB: usize = 32 * 1024;
/// Imports reading or parsing at once, server-wide: each holds up to [`MAX_BYTES`] of body and
/// its parse. Past it, refused ("busy") before any of the body is read.
pub const IMPORTS_AT_ONCE: usize = 4;
/// An import's body must arrive within this. A real file is kilobytes; the largest takes this
/// long at about 5 Mbit/s. A body that stalls holds its slot no longer.
pub const IMPORT_READ: Duration = Duration::from_secs(15);

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
    /// Version 2: the map-state rows its writer knew. A file with more than this build has holds
    /// keys it can't read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u64>,
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

fn file(doc: &Doc, matches: Vec<u64>, exported_at: i64) -> BoardFile {
    let records = mapcro_schema::export_records(doc);
    // The oldest version that says what the file holds (TD-108): version 2 imports on the v11
    // build, version 3 on v13, version 4 on v14/v15, version 5 on R2+, version 6 on R3+.
    let version = mapcro_schema::file_version(&records);
    BoardFile {
        format: FORMAT.to_owned(),
        version,
        build: BUILD_ID.to_owned(),
        exported_at,
        records,
        matches,
        // The rows this build writes, not the ones it only reads: the file must still import
        // on the reader release a rollback goes to.
        rows: Some(mapcro_schema::written_rows() as u64),
    }
}

/// The board's file, into a buffer of `capacity` (the file's size, if known: no regrowth).
pub fn write(doc: &Doc, matches: Vec<u64>, exported_at: i64, capacity: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(capacity);
    match serde_json::to_writer(&mut out, &file(doc, matches, exported_at)) {
        Ok(()) => out,
        Err(_) => Vec::new(),
    }
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
    #[serde(default)]
    rows: Option<u64>,
}

/// A file of any version this build reads, as the current one. Version 1 is the first; an
/// older version's step goes here (`2 => from_v1(serde_json::from_slice::<V1>(bytes)?)`).
fn upgrade(version: u64, bytes: &[u8]) -> Result<BoardFile, Refusal> {
    match version {
        // Versions 2 to 4 only add a header and fields this build reads, so all parse as the
        // current shape.
        1..=READS => serde_json::from_slice::<BoardFile>(bytes).map_err(|_| Refusal::NotABoard),
        v if v > READS => Err(Refusal::Newer),
        _ => Err(Refusal::NotABoard),
    }
}

/// A new board's document and match list from a file, under fresh ids from `next_id`.
/// Titled "Imported board" if the file's title is blank. `admit` is what a record may carry
/// now (the route's is `Admit::DEPLOYED`); a record it refuses makes the file invalid.
pub fn read(bytes: &[u8], next_id: impl FnMut() -> RecordId, admit: &Admit) -> Result<(Doc, Vec<u64>), Refusal> {
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
    // A file from a build with more map-state rows than this one: its records may name keys
    // this build can't hold. Said before the records are parsed, where it would read as damage.
    if head.rows.is_some_and(|n| n > mapcro_schema::ROWS.len() as u64) {
        return Err(Refusal::Newer);
    }
    let file = upgrade(head.version, bytes)?;
    if file.matches.len() > crate::replays::ATTACHED_MAX {
        return Err(Refusal::Invalid);
    }
    let doc = mapcro_schema::import_records(file.records, next_id, admit).map_err(|_| Refusal::Invalid)?;
    // The board as the server holds it, not the file's bytes: a file can be shorter than its
    // board (a point as `[0,0]`). Past the cap, the board couldn't be sent as one snapshot nor
    // downloaded again.
    if json_len(&doc) > MAX_BYTES || json_len(&self::file(&doc, file.matches.clone(), i64::MAX)) > MAX_BYTES {
        return Err(Refusal::TooLarge);
    }
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

/// `value`'s length as JSON, counted, not built.
fn json_len(value: &impl Serialize) -> usize {
    struct Count(usize);
    impl std::io::Write for Count {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0 += b.len();
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut n = Count(0);
    match serde_json::to_writer(&mut n, value) {
        Ok(()) => n.0,
        Err(_) => usize::MAX,
    }
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
/// Clone: anyone who can see the board could copy it by hand. Its size is known before
/// anything is copied (the room's snapshot), so a board too large for a file is refused first,
/// and the copy and the file are built under the server-wide [`EXPORT_BUDGET_KIB`].
pub async fn export(State(app): State<AppState>, Path(board): Path<String>, headers: HeaderMap) -> Response {
    if let Err(r) = require_link(&app, &board, &headers).await {
        return r;
    }
    // The whole document as JSON (deleted records too): a file is never larger, less its header.
    let json = match app.rooms.doc_bytes(&board).await {
        Ok(Some(n)) => n,
        Ok(None) => return refuse(Refusal::TooLarge),
        Err(e) => return internal(e),
    };
    let kib = (2 * json / 1024 + 1).min(EXPORT_BUDGET_KIB) as u32;
    let Ok(_permit) = app.exports.clone().try_acquire_many_owned(kib) else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "busy");
    };
    let doc = match app.rooms.snapshot(&board).await {
        Ok(d) => d,
        Err(e) => return internal(e),
    };
    let matches = crate::replays::attached_ids(&app, &board).await;
    let bytes = match tokio::task::spawn_blocking(move || write(&doc, matches, now(), json + 1024)).await {
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
///
/// Nothing of the body is read until the request has passed every check that needs none of it:
/// a JSON body from this site or no browser at all (a cross-site page can't post one without a
/// preflight, which nothing here answers), a stated length under the cap, a free import slot
/// ([`IMPORTS_AT_ONCE`]) and the creation limits. Then it must arrive within [`IMPORT_READ`].
pub async fn import(State(app): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Body) -> Response {
    let json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|m| m.trim().eq_ignore_ascii_case("application/json"));
    if !json {
        return err(StatusCode::UNSUPPORTED_MEDIA_TYPE, "content_type");
    }
    if let Some(origin) = headers.get(header::ORIGIN)
        && !app.config.allowed_origins.iter().any(|o| o.as_bytes() == origin.as_bytes())
    {
        return err(StatusCode::FORBIDDEN, "origin");
    }
    let Some(length) = headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok()) else {
        return err(StatusCode::LENGTH_REQUIRED, "length_required");
    };
    if length > MAX_BYTES {
        return refuse(Refusal::TooLarge);
    }
    let Ok(_slot) = app.imports.clone().try_acquire_owned() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "busy");
    };
    let ip = client_ip(peer, &headers);
    if !app.limiter.allow(ip, app.config.create_per_hour, app.config.create_global_per_hour) {
        return err(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    let body = match tokio::time::timeout(IMPORT_READ, axum::body::to_bytes(body, MAX_BYTES)).await {
        Ok(Ok(b)) => b,
        Ok(Err(_)) => return refuse(Refusal::TooLarge),
        Err(_) => return err(StatusCode::REQUEST_TIMEOUT, "timeout"),
    };
    let read = tokio::task::spawn_blocking(move || read(&body, random_id, &Admit::DEPLOYED)).await;
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
    fn a_file_says_the_rows_this_build_writes_not_the_ones_it_only_reads() {
        use mapcro_schema::{ROWS, Status};
        let mut n = 0u128;
        let doc = mapcro_schema::genesis(
            || {
                n += 1;
                RecordId(n)
            },
            "t",
        );
        let head: Head = serde_json::from_slice(&write(&doc, Vec::new(), 0, 0)).expect("head");
        let rows = head.rows.expect("version 2 has rows") as usize;
        // Every row below it is written, and it stops at the first that is only read.
        assert!(ROWS[..rows].iter().all(|r| r.status != Status::Ahead));
        assert!(ROWS.get(rows).is_none_or(|r| r.status == Status::Ahead));
        assert_eq!(rows, mapcro_schema::written_rows());
        // A reader that knows exactly those rows takes the file; `read` refuses one above its own.
        assert!(head.rows.is_some_and(|n| n <= ROWS.len() as u64));
    }

    /// The file says version 3 only when the v11 build would refuse what it holds (a scene
    /// name over 24 characters, a comment's side), so that build answers "Newer file" for it,
    /// and imports every other file this build writes.
    #[test]
    fn a_file_is_version_3_only_when_it_holds_what_the_v11_build_refuses() {
        use mapcro_schema::{Callout, FieldValue, Op, Side, Status, Tx, TxKind, WorldPos};
        /// The newest file version the v11 build reads, and its gate.
        const V11_READS: u64 = 2;
        let v11 = Admit { long_scene_name: Status::Ahead, callout_side: Status::Ahead, stroke_color: Status::Ahead, ..Admit::DEPLOYED };
        let base = mapcro_schema::genesis(ids(0), "t");
        let scene = base.iter_live().find(|(_, r)| matches!(r, Record::Scene(_))).map(|(id, _)| id).expect("scene");
        let with = |ops: Vec<Op>| {
            let mut doc = base.clone();
            if !ops.is_empty() {
                mapcro_schema::apply_tx(&mut doc, &Tx { client: mapcro_schema::ClientId(1), cseq: 0, kind: TxKind::Edit, ops }).expect("edit");
            }
            write(&doc, Vec::new(), 0, 0)
        };
        let comment = |side| Op::Create { id: RecordId(900), record: Record::Callout(Callout { scene, pos: WorldPos::default(), text: "x".into(), color: Some(3), side }) };
        let name = |n: usize| Op::Set { id: scene, value: FieldValue::SceneName("é".repeat(n)) };
        for (what, ops, newer) in [
            ("nothing new", vec![], false),
            ("a comment above", vec![comment(Side::Above)], false),
            ("a 24-character name", vec![name(LIMITS.max_name)], false),
            ("a comment on its left", vec![comment(Side::Left)], true),
            ("a 25-character name", vec![name(LIMITS.max_name + 1)], true),
            ("both", vec![comment(Side::Below), name(LIMITS.max_scene_name)], true),
        ] {
            let bytes = with(ops);
            let head: Head = serde_json::from_slice(&bytes).expect("head");
            assert_eq!(head.version > V11_READS, newer, "{what}");
            assert_eq!(head.version, if newer { 3 } else { 2 }, "{what}");
            // What v11 does with it: a version it reads, then its gate. Never "Bad file".
            if !newer {
                read(&bytes, ids(1000), &v11).unwrap_or_else(|e| panic!("{what}: the v11 build imports it: {e:?}"));
            } else {
                assert_eq!(read(&bytes, ids(1000), &v11).err(), Some(Refusal::Invalid), "{what}: as version 2 it would be a bad file");
            }
            read(&bytes, ids(1000), &Admit::DEPLOYED).unwrap_or_else(|e| panic!("{what}: imports here: {e:?}"));
        }
    }

    /// The file says version 4 ([`VERSION`]) only when the v13 build (8efbfac, reading up to
    /// version 3) would refuse what it holds: a scene's state with `has_heroes`. That build, and
    /// the v12 one (18b41c6, up to 2), answer "Newer file" for it, and import every other file
    /// this build writes. (Before the writer such a board was written as version 2: a bad file
    /// there.)
    #[test]
    fn a_file_is_version_4_only_when_it_holds_what_the_v13_build_refuses() {
        use mapcro_schema::Status;
        /// The newest file version the v13 and v12 builds read, and their gate.
        const V13_READS: u64 = 3;
        const V12_READS: u64 = 2;
        let v13 = Admit { row: |r| if r.key() == "has_heroes" { Status::Ahead } else { r.row().status }, ..Admit::DEPLOYED };
        let reading = |reads: u64| move |bytes: &[u8]| -> Result<(), Refusal> {
            let head: Head = serde_json::from_slice(bytes).map_err(|_| Refusal::NotABoard)?;
            if head.version > reads { Err(Refusal::Newer) } else { read(bytes, ids(1000), &v13).map(|_| ()) }
        };
        let (v13_reads, v12_reads) = (reading(V13_READS), reading(V12_READS));
        let state = |more: serde_json::Value| move |v: &mut serde_json::Value| {
            let scene = first(v, "Scene").0;
            records(v).push(serde_json::json!([STATE_ID, { "SceneState": { "scene": scene, "more": more.clone() } }]));
        };
        let long = |v: &mut serde_json::Value| first(v, "Scene").1["name"] = serde_json::json!("n".repeat(LIMITS.max_scene_name));
        let rows = mapcro_schema::ROWS.len();
        type Change<'a> = Box<dyn Fn(&mut serde_json::Value) + 'a>;
        let cases: [(&str, Change, u64); 6] = [
            ("nothing new", Box::new(|_| {}), 2),
            ("a scene's state without it", Box::new(state(serde_json::json!({ "rows": rows, "has_builds": true }))), 2),
            ("a long name", Box::new(long), 3),
            ("a scene that holds its heroes", Box::new(state(serde_json::json!({ "rows": rows, "has_heroes": true }))), 4),
            ("the flag said false", Box::new(state(serde_json::json!({ "rows": rows, "has_heroes": false }))), 4),
            ("both", Box::new(|v: &mut serde_json::Value| { long(v); state(serde_json::json!({ "rows": rows, "has_heroes": true }))(v) }), 4),
        ];
        for (what, change, version) in cases {
            let (doc, _) = read(&file_with(change), ids(1000), &Admit::DEPLOYED).unwrap_or_else(|e| panic!("{what}: imports here: {e:?}"));
            let bytes = write(&doc, Vec::new(), 0, 0);
            let head: Head = serde_json::from_slice(&bytes).expect("head");
            assert_eq!(head.version, version, "{what}");
            // What v13 and v12 do with it: import it, or say it is newer. Never "Bad file".
            assert_eq!(v13_reads(&bytes).err(), (version > V13_READS).then_some(Refusal::Newer), "{what}: on the v13 build");
            if version > V12_READS {
                assert_eq!(v12_reads(&bytes).err(), Some(Refusal::Newer), "{what}: on the v12 build");
            } else {
                v12_reads(&bytes).unwrap_or_else(|e| panic!("{what}: the v12 build imports it: {e:?}"));
            }
            read(&bytes, ids(1000), &Admit::DEPLOYED).unwrap_or_else(|e| panic!("{what}: imports here: {e:?}"));
            // As version 3 it would be a bad file on the v13 build.
            if version == 4 {
                let mut as3: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
                as3["version"] = serde_json::json!(3);
                assert_eq!(v13_reads(&serde_json::to_vec(&as3).expect("json")).err(), Some(Refusal::Invalid), "{what}");
            }
        }
    }

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
        let bytes = write(&doc, vec![130816395], 0, 0);
        assert!(!too_deep(&bytes, 6), "a board without strokes is shallower");
        let deepest = br#"{"records":[["0",{"Stroke":{"points":[{"x":0}]}}]]}"#;
        assert!(!too_deep(deepest, 7) && too_deep(deepest, 6));
    }

    fn ids(start: u128) -> impl FnMut() -> RecordId {
        let mut n = start;
        move || {
            n += 1;
            RecordId(n)
        }
    }

    /// A board's file as JSON, changed by `f`.
    fn file_with(f: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
        let doc = mapcro_schema::genesis(ids(0), "Scrim");
        let mut v: serde_json::Value = serde_json::from_slice(&write(&doc, Vec::new(), 0, 0)).expect("json");
        f(&mut v);
        serde_json::to_vec(&v).expect("json")
    }

    fn records(v: &mut serde_json::Value) -> &mut Vec<serde_json::Value> {
        v["records"].as_array_mut().expect("records")
    }

    /// The first record of `kind`: `(its id, its body)`.
    fn first<'a>(v: &'a mut serde_json::Value, kind: &str) -> (serde_json::Value, &'a mut serde_json::Value) {
        let r = records(v).iter_mut().find(|r| r[1].get(kind).is_some()).unwrap_or_else(|| panic!("no {kind}"));
        (r[0].clone(), &mut r[1][kind])
    }

    const STATE_ID: &str = "00000000000000000000000000005000";

    /// A snapshot as the writer release will save it: registry values on a hero, a scene's
    /// state, and a marker and a lane with none.
    fn snapshot(v: &mut serde_json::Value, version: u64) {
        use serde_json::json;
        let scene = first(v, "Scene").0;
        first(v, "PlayerState").1["more"] = json!({ "hero": 13, "name": "Solo", "items": [9000, -1, 4294967295u64], "level": 12, "health": 55 });
        records(v).push(json!([STATE_ID, { "SceneState": { "scene": scene, "more": { "rows": mapcro_schema::ROWS.len(), "has_builds": true, "build": 6839 } } }]));
        records(v).push(json!(["00000000000000000000000000005001", { "ObjectiveState": { "scene": scene, "key": "walker:amber:lane1:1", "status": "Destroyed", "more": {} } }]));
        records(v).push(json!(["00000000000000000000000000005002", { "Wave": { "scene": scene, "lane": "lane1", "t": 400 } }]));
        v["version"] = json!(version);
        if version >= 2 {
            v["rows"] = json!(mapcro_schema::ROWS.len());
        }
    }

    /// While a row or the scene's state is `Ahead`, a file holding it makes no board, whatever
    /// version it says it is: a version-1 header doesn't get a version-2 body past admission.
    #[test]
    fn a_file_holding_a_row_or_kind_still_ahead_is_refused_at_either_version() {
        use mapcro_schema::Status;
        let ahead = Admit { row: |_| Status::Ahead, scene_state: Status::Ahead, unfit_undo: Status::Ahead, ..Admit::AHEAD };
        read(&file_with(|_| {}), ids(1000), &ahead).expect("a board with neither imports");
        for version in [1, 2] {
            assert_eq!(read(&file_with(|v| snapshot(v, version)), ids(1000), &ahead).err(), Some(Refusal::Invalid), "version {version}");
            let hero_only = file_with(|v| {
                first(v, "PlayerState").1["more"] = serde_json::json!({ "level": 3 });
                v["version"] = serde_json::json!(version);
            });
            assert_eq!(read(&hero_only, ids(1000), &ahead).err(), Some(Refusal::Invalid), "version {version}");
            let state_only = file_with(|v| {
                let scene = first(v, "Scene").0;
                records(v).push(serde_json::json!([STATE_ID, { "SceneState": { "scene": scene } }]));
                v["version"] = serde_json::json!(version);
            });
            assert_eq!(read(&state_only, ids(1000), &ahead).err(), Some(Refusal::Invalid), "version {version}");
            // The rows live and the kind not: the hero's values alone are not enough.
            let rows_live = Admit { row: |_| Status::Live, scene_state: Status::Ahead, unfit_undo: Status::Ahead, ..Admit::AHEAD };
            assert_eq!(read(&state_only, ids(1000), &rows_live).err(), Some(Refusal::Invalid), "version {version}");
            read(&hero_only, ids(1000), &rows_live).expect("the row is live");
        }
    }

    /// Once they are written (the writer release), a version-2 file holding a snapshot imports,
    /// and the board's own file holds every value (map-state spec §4.3, §9).
    #[test]
    fn a_snapshot_imports_once_its_rows_are_live_and_exports_the_same_values() {
        use serde_json::json;
        let bytes = file_with(|v| snapshot(v, 2));
        let (doc, _) = read(&bytes, ids(1000), &Admit::READS).expect("imports");
        let mut out: serde_json::Value = serde_json::from_slice(&write(&doc, Vec::new(), 0, 0)).expect("json");
        assert_eq!(out["version"], 2, "this build writes rows: version 2, which a build from before the reader refuses as newer");
        // The rows this build writes (review F1), whatever a test's gate let the board hold.
        assert_eq!(out["rows"], json!(mapcro_schema::written_rows()));
        let find = |v: &mut serde_json::Value, kind: &str| -> Vec<serde_json::Value> { records(v).iter().filter_map(|r| r[1].get(kind).cloned()).collect() };
        let states = find(&mut out, "SceneState");
        assert_eq!(states.len(), 1);
        assert_eq!(states[0]["more"], json!({ "rows": mapcro_schema::ROWS.len(), "has_builds": true, "build": 6839 }));
        let heroes: Vec<_> = find(&mut out, "PlayerState").into_iter().filter(|p| p.get("more").is_some()).collect();
        assert_eq!(heroes.len(), 1, "an empty `more` is not written");
        assert_eq!(heroes[0]["more"], json!({ "hero": 13, "name": "Solo", "items": [9000, -1, 4294967295u64], "level": 12, "health": 55 }));
        assert!(find(&mut out, "ObjectiveState")[0].get("more").is_none());
        // And a second scene state for the same scene is refused, as on the board.
        let twice = file_with(|v| {
            snapshot(v, 2);
            let scene = first(v, "Scene").0;
            records(v).push(json!(["00000000000000000000000000005003", { "SceneState": { "scene": scene } }]));
        });
        assert_eq!(read(&twice, ids(1000), &Admit::READS).err(), Some(Refusal::Invalid));
    }

    /// TD-108: `READS` derives from `FILE_VERSIONS` (4 in R1), `rows` header is `written_rows()`
    /// (16 in R1), v5/v6 files are refused as `Newer` on R1, and exporting a board loaded with
    /// Group A / Group B rows tags it v5 / v6 respectively.
    #[test]
    fn phase5_file_versions_are_derived_from_the_table_and_refused_as_newer_in_r1() {
        use serde_json::json;
        assert_eq!(READS, 4);
        assert_eq!(VERSION, 4);
        // v5 and v6 files are refused as `Newer` on R1 (before body parsing).
        for version in [5u64, 6u64] {
            let bytes = file_with(|v| v["version"] = json!(version));
            assert_eq!(read(&bytes, ids(1000), &Admit::DEPLOYED).err(), Some(Refusal::Newer), "v{version}");
        }
        // A v4 file carrying a Group A or Group B row is refused as `Invalid` under `Admit::DEPLOYED`
        // (even though `head.rows == 40` is within `ROWS.len()`).
        let v4_group_a = file_with(|v| {
            let scene = first(v, "Scene").0;
            records(v).push(json!([STATE_ID, { "SceneState": { "scene": scene, "more": { "rows": 27, "has_sight": true } } }]));
            v["version"] = json!(4);
            v["rows"] = json!(27);
        });
        assert_eq!(read(&v4_group_a, ids(1000), &Admit::DEPLOYED).err(), Some(Refusal::Invalid));
        let (doc_a, _) = read(&v4_group_a, ids(1000), &Admit::READS).expect("reads admits Group A");
        let out_a: serde_json::Value = serde_json::from_slice(&write(&doc_a, Vec::new(), 0, 0)).expect("json");
        assert_eq!(out_a["version"], 5);
        assert_eq!(out_a["rows"], json!(mapcro_schema::written_rows()));

        let v4_group_b = file_with(|v| {
            let scene = first(v, "Scene").0;
            records(v).push(json!([STATE_ID, { "SceneState": { "scene": scene, "more": { "rows": 40, "has_sight": true, "has_camps": true } } }]));
            v["version"] = json!(4);
            v["rows"] = json!(40);
        });
        assert_eq!(read(&v4_group_b, ids(1000), &Admit::DEPLOYED).err(), Some(Refusal::Invalid));
        let (doc_b, _) = read(&v4_group_b, ids(1000), &Admit::READS).expect("reads admits Group B");
        let out_b: serde_json::Value = serde_json::from_slice(&write(&doc_b, Vec::new(), 0, 0)).expect("json");
        assert_eq!(out_b["version"], 6);
        assert_eq!(out_b["rows"], json!(mapcro_schema::written_rows()));
    }
}
