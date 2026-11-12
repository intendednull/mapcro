//! SQLite storage (spec §9). WAL with `synchronous=FULL`: when a write returns, it survives a
//! crash or power loss. Rooms wait for that before acknowledging anything.

use crate::codec::{self, Codec, CodecError};
use mapcro_engine::wire::LinkRole;
use mapcro_engine::{Authority, Quota};
use mapcro_schema::{ClientId, Doc, Reject, Tx};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("stored data is corrupt: {0}")]
    Corrupt(String),
    #[error("storage thread failed")]
    Join,
    /// A stored board is bigger than this server's caps allow it to load (written under larger
    /// caps). Refused rather than read, so no board can be too big to open safely.
    #[error("board exceeds the load caps: {0}")]
    TooLarge(String),
    /// The server is at its board-count or storage cap.
    #[error("server storage is full")]
    Full,
    /// Catch-up asked for entries that compaction has since dropped (review finding 1). Not a
    /// fault: the client reconnects and is rebased.
    #[error("those entries were compacted away")]
    Compacted,
}

/// Caps on what a board may hold, checked as it loads.
#[derive(Clone, Copy, Debug)]
pub struct LoadCaps {
    pub ops: usize,
    pub bytes: usize,
    pub clients: usize,
    pub rejections: usize,
}

/// The database's size in bytes (pages in use or free; it never shrinks).
fn db_size(c: &Connection) -> rusqlite::Result<u64> {
    c.query_row("SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()", [], |r| r.get::<_, i64>(0))
        .map(|n| n.max(0) as u64)
}

/// A board rebuilt from storage: its authority (document, clients, rejections; no log, and no
/// base document: fresh clients get that from storage too).
pub struct LoadedBoard {
    pub authority: Authority,
    /// The log position the stored base document is at.
    pub base_seq: u64,
}

/// A stored op decodes to at most this much JSON. Rows written since v4 are under
/// `Limits::max_tx_bytes`; older ones were bounded by the old 256 KiB frame.
const OP_DECODE_LIMIT: usize = 1024 * 1024;
/// A stored base document decodes to at most this much JSON.
const DOC_DECODE_LIMIT: usize = 64 * 1024 * 1024;

impl From<CodecError> for StoreError {
    fn from(e: CodecError) -> StoreError {
        StoreError::Corrupt(e.to_string())
    }
}

/// One durable effect of a room's batch (`Store::commit`).
pub enum Write {
    /// Log entry `seq`, encoded (`codec::encode` of its JSON).
    Op { seq: u64, codec: Codec, stored: Vec<u8> },
    Rejection { client: ClientId, cseq: u64, reason: Reject },
    Client { client: ClientId, secret_hash: [u8; 32] },
    /// The client has heard its rejections below `below`: forget them, and keep its next
    /// expected cseq, which they may have been the only record of (review 2026-11-07, finding 2).
    PruneRejections { client: ClientId, below: u64, next_cseq: u64 },
}

enum Row {
    Op(u64, Codec, Vec<u8>),
    Rejection(String, u64, String),
    Client(String, [u8; 32]),
    Prune(String, u64, u64),
}

/// A TEXT (old rows) or BLOB (compressed rows) column's bytes.
fn raw(v: ValueRef<'_>) -> rusqlite::Result<Vec<u8>> {
    match v {
        ValueRef::Text(b) | ValueRef::Blob(b) => Ok(b.to_vec()),
        other => Err(rusqlite::Error::InvalidColumnType(0, "tx".into(), other.data_type())),
    }
}

/// The `Ready` frame for a client with no copy, around the stored base document's JSON. A test
/// checks it equals what serde writes.
pub fn ready_frame(role: LinkRole, doc_json: &str, seq: u64, peer: u64, head: u64) -> String {
    let role = serde_json::to_string(&role).unwrap_or_default();
    format!(r#"{{"t":"ready","role":{role},"base":{{"doc":{doc_json},"seq":{seq}}},"peer":{peer},"head":{head}}}"#)
}

/// The `Entry` frame for a stored transaction, built around its JSON rather than by parsing
/// and reserializing it. A test checks it equals what serde writes.
pub fn entry_frame(seq: u64, tx_json: &str) -> String {
    format!(r#"{{"t":"msg","msg":{{"Entry":{{"seq":{seq},"tx":{tx_json}}}}}}}"#)
}

pub struct LinkRow {
    pub hash: String,
    pub board: String,
    pub role: LinkRole,
    pub label: String,
    pub created_at: i64,
    pub revoked: bool,
    /// The link that minted this one (`None` for the owner link).
    pub minted_by: Option<String>,
    /// What the link's room is: a board or a session (sessions spec §2.1).
    pub kind: RoomKind,
}

/// What a room in the `boards` table is (sessions spec §2.1, §3.6). Board and session ids share
/// a shape and a table, so every link lookup says which, and every route asserts it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoomKind {
    Board,
    Session,
}

impl RoomKind {
    fn as_str(self) -> &'static str {
        match self {
            RoomKind::Board => "board",
            RoomKind::Session => "session",
        }
    }

    fn parse(s: &str) -> Result<RoomKind, StoreError> {
        match s {
            "board" => Ok(RoomKind::Board),
            "session" => Ok(RoomKind::Session),
            other => Err(StoreError::Corrupt(format!("unknown room kind {other:?}"))),
        }
    }
}

/// A grant (sessions spec §3.2): the board it opens and the `links` row that carries its role.
#[derive(Clone, Debug)]
pub struct GrantRow {
    pub board: String,
    pub link_hash: String,
}

/// A grant to write, with its links row on `board` (sessions spec §3.2 step 4).
pub struct NewGrant {
    pub session: String,
    pub grant_id: String,
    pub board: String,
    /// The hash of a token nobody holds: the grant's own link on `board`.
    pub link_hash: String,
    pub role: LinkRole,
    pub label: String,
    /// The board link the adder presented: the grant is minted by it, so it cascades.
    pub minted_by: String,
    /// The session link that added it.
    pub added_by: String,
    pub now: i64,
    /// Live grants a session may hold (§3.8).
    pub max_live: u64,
}

/// What writing a grant came to.
#[derive(Debug, PartialEq, Eq)]
pub enum GrantWrite {
    Written,
    /// The board link or the session link was revoked (or isn't what it was) by now.
    Refused,
    /// The session holds `max_live` live grants.
    Full,
}

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
    /// A second connection for catch-up reads, so a long catch-up never waits behind (or holds
    /// up) the writes rooms make durable. WAL lets it read committed rows concurrently.
    reader: Arc<Mutex<Connection>>,
    /// The database's size as of the last write.
    bytes: Arc<AtomicU64>,
}

/// Database schema version. Each step in `migrate` takes the database one version forward.
const SCHEMA_VERSION: i64 = 7;

/// Whether the step from `from` to `from + 1` is additive: it only adds tables (or other things
/// an older server never reads), so a server that predates it still uses the database correctly.
/// An additive step keeps the database's compatibility floor; any other step raises it to the
/// new version (spec §9, docs/deploy.md "Rollbacks").
///
/// Steps before v6 predate the floor and count as breaking: servers of those versions refuse a
/// newer database whatever it says.
fn additive_step(from: i64) -> bool {
    matches!(from, 5 | 6)
}

/// The oldest server version that can safely open a database at schema `version`: the floor
/// each migration since v1 left. Stored in `meta` as `compat_floor`, for older servers, which
/// can't work it out because they don't know the newer steps.
fn compat_floor(version: i64) -> i64 {
    (1..version).fold(1, |floor, from| if additive_step(from) { floor } else { from + 1 })
}

/// v1 → v2: links remember which link minted them (editors can share; revocation cascades).
///
/// Each step and its version bump are one transaction, so a crash leaves the database at one
/// version or the next, never between (review 2026-11-07, finding 3). Steps that create tables
/// also say IF NOT EXISTS, for a database an older server left half-migrated.
/// Migrations only ever run forwards, up to `to` (this server's version).
fn migrate(conn: &Connection, from: i64, to: i64) -> Result<(), StoreError> {
    let mut v = from;
    while v < to {
        let t = conn.unchecked_transaction()?;
        match v {
            1 => t.execute_batch(
                "ALTER TABLE links ADD COLUMN minted_by TEXT REFERENCES links(hash);
                 CREATE INDEX IF NOT EXISTS links_by_parent ON links(minted_by);",
            )?,
            // v2 → v3: client ids are bound to a secret (security review H1).
            2 => t.execute_batch(
                "CREATE TABLE IF NOT EXISTS clients (
                   board TEXT NOT NULL REFERENCES boards(id),
                   client TEXT NOT NULL,
                   secret_hash BLOB NOT NULL,
                   PRIMARY KEY (board, client)
                 ) WITHOUT ROWID;",
            )?,
            // v3 → v4: rows name their codec (`codec.rs`); existing rows are JSON and stay so.
            3 => t.execute_batch(
                "ALTER TABLE ops ADD COLUMN codec TEXT NOT NULL DEFAULT 'json';
                 ALTER TABLE boards ADD COLUMN base_codec TEXT NOT NULL DEFAULT 'json';",
            )?,
            // v4 → v5: each client's next expected cseq, kept when compaction drops the log
            // entries that showed it (spec §9). Without it a resend of an old transaction would
            // be applied twice.
            4 => t.execute_batch(
                "CREATE TABLE IF NOT EXISTS client_seqs (
                   board TEXT NOT NULL REFERENCES boards(id),
                   client TEXT NOT NULL,
                   next_cseq INTEGER NOT NULL,
                   PRIMARY KEY (board, client)
                 ) WITHOUT ROWID;",
            )?,
            // v5 → v6: the metrics tables (docs/specs/observability.md): minute and hourly
            // rows, the recent-failures log, the daily user counts.
            5 => t.execute_batch(crate::metrics::db::SCHEMA)?,
            // v6 → v7: sessions (docs/specs/sessions.md §2.1). A room says what it is, and a
            // session's grants say which board each opens through which links row. Additive:
            // a v6 server never reads either, and every existing row is a board.
            6 => {
                // A database that went forward and back (a rollback) may have the column already.
                let has_kind: bool =
                    t.query_row("SELECT EXISTS (SELECT 1 FROM pragma_table_info('boards') WHERE name = 'kind')", [], |r| r.get(0))?;
                if !has_kind {
                    t.execute_batch("ALTER TABLE boards ADD COLUMN kind TEXT NOT NULL DEFAULT 'board';")?;
                }
                t.execute_batch(
                    "CREATE TABLE IF NOT EXISTS session_grants (
                       session TEXT NOT NULL REFERENCES boards(id),
                       grant_id TEXT NOT NULL,
                       board TEXT NOT NULL REFERENCES boards(id),
                       link_hash TEXT NOT NULL REFERENCES links(hash),
                       added_by TEXT NOT NULL,
                       created_at INTEGER NOT NULL,
                       PRIMARY KEY (session, grant_id)
                     ) WITHOUT ROWID;
                     CREATE INDEX IF NOT EXISTS session_grants_by_board ON session_grants(board);",
                )?
            }
            other => return Err(StoreError::Corrupt(format!("no migration from schema {other}"))),
        }
        v += 1;
        t.execute("UPDATE meta SET value = ?1 WHERE key = 'schema_version'", [v.to_string()])?;
        set_floor(&t, compat_floor(v))?;
        t.commit()?;
        tracing::info!(to = v, "migrated database schema");
    }
    Ok(())
}

fn set_floor(conn: &Connection, floor: i64) -> Result<(), StoreError> {
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('compat_floor', ?1)", [floor.to_string()])?;
    Ok(())
}

fn meta_i64(conn: &Connection, key: &str) -> Result<Option<i64>, StoreError> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get::<_, String>(0))
        .optional()?
        .map(|v| v.parse().unwrap_or(-1)))
}

/// Bring the database to the version a server of version `known` expects, or refuse it.
///
/// Older databases migrate forwards. A newer one (a rollback after a migration) opens if `known`
/// is at least its `compat_floor`, with a warning, and is left as it is: never migrated
/// backwards, its version and floor untouched. A newer database with no floor (written before
/// the floor existed) is refused, as it always was.
fn reconcile(conn: &Connection, known: i64) -> Result<(), StoreError> {
    match meta_i64(conn, "schema_version")? {
        None => {
            // A fresh database is created at v1, then migrated like any other.
            conn.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '1')", [])?;
            set_floor(conn, compat_floor(1))?;
            migrate(conn, 1, known)?;
        }
        Some(v) if (1..=known).contains(&v) => {
            migrate(conn, v, known)?;
            // A database migrated before the floor existed gets it now.
            set_floor(conn, compat_floor(known))?;
        }
        Some(v) => {
            let floor = meta_i64(conn, "compat_floor")?;
            match floor {
                Some(f) if v > known && (1..=known).contains(&f) => {
                    tracing::warn!(database = v, floor = f, server = known, "database schema is newer than this server; opening it, as its floor allows");
                }
                _ => {
                    return Err(StoreError::Corrupt(format!(
                        "database schema {v} (opens with servers from {}), this server knows {known}",
                        floor.map_or_else(|| v.to_string(), |f| f.to_string())
                    )));
                }
            }
        }
    }
    Ok(())
}

fn role_str(r: LinkRole) -> &'static str {
    match r {
        LinkRole::Owner => "owner",
        LinkRole::Edit => "edit",
        LinkRole::View => "view",
    }
}

fn parse_role(s: &str) -> Result<LinkRole, StoreError> {
    match s {
        "owner" => Ok(LinkRole::Owner),
        "edit" => Ok(LinkRole::Edit),
        "view" => Ok(LinkRole::View),
        other => Err(StoreError::Corrupt(format!("unknown link role {other:?}"))),
    }
}

fn corrupt(e: serde_json::Error) -> StoreError {
    StoreError::Corrupt(e.to_string())
}

impl Store {
    pub fn open(path: &Path) -> Result<Store, StoreError> {
        Store::open_at(path, SCHEMA_VERSION)
    }

    /// Open as a server that knows schema `known` would (tests build older databases with it).
    fn open_at(path: &Path, known: i64) -> Result<Store, StoreError> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS boards (
               id TEXT PRIMARY KEY,
               created_at INTEGER NOT NULL,
               base_doc TEXT NOT NULL,
               base_seq INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS ops (
               board TEXT NOT NULL REFERENCES boards(id),
               seq INTEGER NOT NULL,
               tx TEXT NOT NULL,
               PRIMARY KEY (board, seq)
             ) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS rejections (
               board TEXT NOT NULL REFERENCES boards(id),
               client TEXT NOT NULL,
               cseq INTEGER NOT NULL,
               reason TEXT NOT NULL,
               PRIMARY KEY (board, client, cseq)
             ) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS links (
               hash TEXT PRIMARY KEY,
               board TEXT NOT NULL REFERENCES boards(id),
               role TEXT NOT NULL,
               label TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               revoked_at INTEGER
             );
             CREATE INDEX IF NOT EXISTS links_by_board ON links(board);",
        )?;
        reconcile(&conn, known)?;
        let bytes = Arc::new(AtomicU64::new(db_size(&conn)?));
        let reader = Connection::open(path)?;
        reader.execute_batch("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;")?;
        Ok(Store { conn: Arc::new(Mutex::new(conn)), reader: Arc::new(Mutex::new(reader)), bytes })
    }

    /// The database's size in bytes as of the last write.
    pub fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }

    /// Run a closure on the connection off the async runtime.
    async fn with<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        let conn = self.conn.clone();
        let bytes = self.bytes.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn.lock().map_err(|_| StoreError::Join)?;
            let out = f(&mut guard);
            if let Ok(n) = db_size(&guard) {
                bytes.store(n, Ordering::Relaxed);
            }
            out
        })
        .await
        .map_err(|_| StoreError::Join)?
    }

    /// Run a closure on the reader connection off the async runtime.
    async fn read<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        let reader = self.reader.clone();
        tokio::task::spawn_blocking(move || f(&mut *reader.lock().map_err(|_| StoreError::Join)?))
            .await
            .map_err(|_| StoreError::Join)?
    }

    /// One minute's metrics snapshot, with the rollup and retention (`metrics::db::write`).
    pub async fn write_metrics(
        &self,
        rows: Vec<crate::metrics::snapshot::Row>,
        failures: Vec<crate::metrics::failures::Failure>,
        users: Vec<(i64, u64)>,
        now: i64,
    ) -> Result<(), StoreError> {
        self.with(move |c| Ok(crate::metrics::db::write(c, &rows, &failures, &users, mapcro_schema::BUILD_ID, now)?)).await
    }

    /// Boards stored.
    pub async fn board_count(&self) -> Result<u64, StoreError> {
        self.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM boards", [], |r| r.get::<_, i64>(0))?.max(0) as u64)).await
    }

    pub async fn ping(&self) -> Result<(), StoreError> {
        self.with(|c| Ok(c.query_row("SELECT 1", [], |r| r.get::<_, i64>(0)).map(|_| ())?)).await
    }

    /// Create a board, unless the server already holds `max_boards` or `max_bytes` (then
    /// `StoreError::Full`: storage spam can't fill the disk, security review 2026-11-07, C1/M-A).
    pub async fn create_board(
        &self,
        id: String,
        base: Doc,
        owner_hash: String,
        now: i64,
        max_boards: u64,
        max_bytes: u64,
    ) -> Result<(), StoreError> {
        self.create_room(RoomKind::Board, id, base, owner_hash, now, max_boards, max_bytes, None).await.map(|_| ())
    }

    /// Create a board or a session, under the same caps (sessions count toward `max_boards`,
    /// spec §2.1). A session may come with its first grant, written in the same transaction:
    /// then `false` if the grant was refused, and nothing is written.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_room(
        &self,
        kind: RoomKind,
        id: String,
        base: Doc,
        owner_hash: String,
        now: i64,
        max_boards: u64,
        max_bytes: u64,
        grant: Option<NewGrant>,
    ) -> Result<bool, StoreError> {
        let (base_codec, base) = codec::encode(&serde_json::to_vec(&base).map_err(corrupt)?);
        self.with(move |c| {
            let t = c.transaction()?;
            let boards: i64 = t.query_row("SELECT COUNT(*) FROM boards", [], |r| r.get(0))?;
            if boards as u64 >= max_boards || db_size(&t)? >= max_bytes {
                return Err(StoreError::Full);
            }
            t.execute(
                "INSERT INTO boards (id, created_at, base_doc, base_seq, base_codec, kind) VALUES (?1, ?2, ?3, 0, ?4, ?5)",
                params![id, now, base, base_codec.as_str(), kind.as_str()],
            )?;
            t.execute(
                "INSERT INTO links (hash, board, role, label, created_at) VALUES (?1, ?2, 'owner', 'owner', ?3)",
                params![owner_hash, id, now],
            )?;
            if let Some(g) = grant
                && write_grant(&t, &g)? != GrantWrite::Written
            {
                return Ok(false); // dropped: the transaction rolls back
            }
            t.commit()?;
            Ok(true)
        })
        .await
    }

    /// Write a grant and its links row on the board, atomically refusing if the board link it
    /// comes from or the session link adding it was revoked, so a revocation never misses a
    /// grant made concurrently (sessions spec §3.2).
    pub async fn add_grant(&self, g: NewGrant) -> Result<GrantWrite, StoreError> {
        self.with(move |c| {
            let t = c.transaction()?;
            let w = write_grant(&t, &g)?;
            if w == GrantWrite::Written {
                t.commit()?;
            }
            Ok(w)
        })
        .await
    }

    /// A session's grant, if it exists.
    pub async fn grant(&self, session: String, grant_id: String) -> Result<Option<GrantRow>, StoreError> {
        self.with(move |c| {
            Ok(c.query_row(
                "SELECT board, link_hash FROM session_grants WHERE session = ?1 AND grant_id = ?2",
                params![session, grant_id],
                |r| Ok(GrantRow { board: r.get(0)?, link_hash: r.get(1)? }),
            )
            .optional()?)
        })
        .await
    }

    /// Rebuild a board's authority from storage. Reads one row at a time and keeps only the
    /// document, not the log (the log stays on disk and catch-up reads it from there). Refuses a
    /// board past `caps` rather than reading it, so loading can't exhaust memory (security
    /// review 2026-11-07, C1). `caps.bytes` counts stored, compressed bytes, as the quota does.
    ///
    /// Runs on the reader connection, so a long load never holds up other boards' writes. The
    /// board's own room isn't open while it loads, so nothing writes to it meanwhile.
    pub async fn load_board(&self, id: String, caps: LoadCaps, quota: Quota) -> Result<Option<LoadedBoard>, StoreError> {
        let too_large = |what: &str, cap: usize| StoreError::TooLarge(format!("more than {cap} {what}"));
        self.read(move |c| {
            let Some((base, base_codec, base_seq)) = c
                .query_row("SELECT base_doc, base_codec, base_seq FROM boards WHERE id = ?1", [&id], |r| {
                    Ok((raw(r.get_ref(0)?)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
                })
                .optional()?
            else {
                return Ok(None);
            };
            let base = codec::decode(Codec::parse(&base_codec)?, &base, DOC_DECODE_LIMIT)?;
            let base: Doc = serde_json::from_slice(&base).map_err(corrupt)?;
            mapcro_schema::validate_doc(&base).map_err(|r| StoreError::Corrupt(format!("base document: {r}")))?;
            // The base is the board at `base_seq`; replay what came after. Older rows still kept
            // (the tail compaction leaves for catch-up) are already in the base.
            let mut authority = Authority::from_snapshot(base, base_seq as u64, quota);
            let mut stmt = c.prepare("SELECT seq, codec, tx FROM ops WHERE board = ?1 AND seq > ?2 ORDER BY seq")?;
            let mut rows = stmt.query(params![id, base_seq])?;
            let mut expected = base_seq + 1;
            let (mut ops, mut bytes) = (0usize, 0usize);
            while let Some(row) = rows.next()? {
                let seq: i64 = row.get(0)?;
                if seq != expected {
                    return Err(StoreError::Corrupt(format!("op log gap at {seq}, expected {expected}")));
                }
                expected += 1;
                let stored = raw(row.get_ref(2)?)?;
                ops += 1;
                bytes += stored.len();
                if ops > caps.ops {
                    return Err(too_large("logged transactions", caps.ops));
                }
                if bytes > caps.bytes {
                    return Err(too_large("bytes of history", caps.bytes));
                }
                let json = codec::decode(Codec::parse(&row.get::<_, String>(1)?)?, &stored, OP_DECODE_LIMIT)?;
                let tx: Tx = serde_json::from_slice(&json).map_err(corrupt)?;
                authority
                    .replay(&tx, stored.len())
                    .map_err(|r| StoreError::Corrupt(format!("op {seq} does not replay: {r}")))?;
            }
            drop(rows);
            drop(stmt);
            let mut stmt = c.prepare("SELECT client, cseq, reason FROM rejections WHERE board = ?1")?;
            let mut n = 0;
            for row in stmt.query_map([&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))? {
                let (client, cseq, reason) = row?;
                n += 1;
                if n > caps.rejections {
                    return Err(too_large("stored rejections", caps.rejections));
                }
                let client: ClientId = serde_json::from_value(serde_json::Value::String(client)).map_err(corrupt)?;
                authority.replay_rejection(client, cseq as u64, serde_json::from_str(&reason).map_err(corrupt)?);
            }
            let mut stmt = c.prepare("SELECT client, secret_hash FROM clients WHERE board = ?1")?;
            let mut n = 0;
            for row in stmt.query_map([&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))? {
                let (client, hash) = row?;
                n += 1;
                if n > caps.clients {
                    return Err(too_large("clients", caps.clients));
                }
                let client: ClientId = serde_json::from_value(serde_json::Value::String(client)).map_err(corrupt)?;
                let hash: [u8; 32] = hash.try_into().map_err(|_| StoreError::Corrupt("secret hash length".into()))?;
                authority.replay_client(client, hash);
            }
            let mut stmt = c.prepare("SELECT client, next_cseq FROM client_seqs WHERE board = ?1")?;
            for row in stmt.query_map([&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
                let (client, next) = row?;
                let client: ClientId = serde_json::from_value(serde_json::Value::String(client)).map_err(corrupt)?;
                authority.replay_next_cseq(client, next as u64);
            }
            // What's kept: catch-up is served from the oldest kept entry on; below it, a rebase.
            let (min_seq, kept_bytes): (Option<i64>, i64) =
                c.query_row("SELECT MIN(seq), COALESCE(SUM(length(tx)), 0) FROM ops WHERE board = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            let floor = min_seq.map_or(base_seq, |m| (m - 1).min(base_seq));
            authority.compacted(floor as u64, kept_bytes as usize);
            Ok(Some(LoadedBoard { authority, base_seq: base_seq as u64 }))
        })
        .await
    }

    /// A board's stored base document as JSON, and the seq it's at: what a fresh client starts
    /// from when the board is too big to send as a snapshot (room.rs, `FreshBase::Stored`).
    pub async fn base_json(&self, board: String) -> Result<(String, u64), StoreError> {
        let reader = self.reader.clone();
        tokio::task::spawn_blocking(move || {
            let c = reader.lock().map_err(|_| StoreError::Join)?;
            let (doc, codec, seq) = c.query_row("SELECT base_doc, base_codec, base_seq FROM boards WHERE id = ?1", [&board], |r| {
                Ok((raw(r.get_ref(0)?)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
            })?;
            let json = codec::decode(Codec::parse(&codec)?, &doc, DOC_DECODE_LIMIT)?;
            Ok((String::from_utf8(json).map_err(|e| StoreError::Corrupt(e.to_string()))?, seq as u64))
        })
        .await
        .map_err(|_| StoreError::Join)?
    }

    /// Make a batch of a room's effects durable together: one SQLite transaction, so one fsync
    /// (spec §9, group commit). The room sends nothing that depends on them until this returns.
    pub async fn commit(&self, board: String, writes: Vec<Write>) -> Result<(), StoreError> {
        let id = |client: ClientId| serde_json::to_value(client).map_err(corrupt).map(|v| v.as_str().unwrap_or_default().to_owned());
        let mut rows = Vec::with_capacity(writes.len());
        for w in writes {
            rows.push(match w {
                Write::Op { seq, codec, stored } => Row::Op(seq, codec, stored),
                Write::Rejection { client, cseq, reason } => Row::Rejection(id(client)?, cseq, serde_json::to_string(&reason).map_err(corrupt)?),
                Write::Client { client, secret_hash } => Row::Client(id(client)?, secret_hash),
                Write::PruneRejections { client, below, next_cseq } => Row::Prune(id(client)?, below, next_cseq),
            });
        }
        self.with(move |c| {
            let t = c.transaction()?;
            for row in rows {
                match row {
                    Row::Op(seq, codec, stored) => {
                        t.prepare_cached("INSERT INTO ops (board, seq, codec, tx) VALUES (?1, ?2, ?3, ?4)")?
                            .execute(params![board, seq as i64, codec.as_str(), stored])?;
                    }
                    Row::Rejection(client, cseq, reason) => {
                        t.prepare_cached("INSERT OR IGNORE INTO rejections (board, client, cseq, reason) VALUES (?1, ?2, ?3, ?4)")?
                            .execute(params![board, client, cseq as i64, reason])?;
                    }
                    Row::Client(client, hash) => {
                        t.prepare_cached("INSERT OR IGNORE INTO clients (board, client, secret_hash) VALUES (?1, ?2, ?3)")?
                            .execute(params![board, client, hash.to_vec()])?;
                    }
                    Row::Prune(client, below, next) => {
                        t.prepare_cached("DELETE FROM rejections WHERE board = ?1 AND client = ?2 AND cseq < ?3")?
                            .execute(params![board, client, below as i64])?;
                        t.prepare_cached(
                            "INSERT INTO client_seqs (board, client, next_cseq) VALUES (?1, ?2, ?3)
                             ON CONFLICT (board, client) DO UPDATE SET next_cseq = MAX(next_cseq, excluded.next_cseq)",
                        )?
                        .execute(params![board, client, next as i64])?;
                    }
                }
            }
            t.commit()?;
            Ok(())
        })
        .await
    }

    /// Compact a board's log (spec §9): its base becomes `doc` (encoded) at `base_seq`, and the
    /// log keeps only its newest entries, at most `keep_ops` of them and `keep_bytes`, for
    /// clients slightly behind; older ones go. Each client's next expected cseq is kept, since the
    /// entries that showed it may go. One transaction. Returns the floor (entries at or below it
    /// are gone) and the bytes kept.
    #[allow(clippy::too_many_arguments)]
    pub async fn compact(
        &self,
        board: String,
        codec: Codec,
        doc: Vec<u8>,
        base_seq: u64,
        keep_ops: usize,
        keep_bytes: usize,
        client_seqs: Vec<(ClientId, u64)>,
    ) -> Result<(u64, usize), StoreError> {
        let mut seqs = Vec::with_capacity(client_seqs.len());
        for (client, next) in client_seqs {
            let client = serde_json::to_value(client).map_err(corrupt)?.as_str().unwrap_or_default().to_owned();
            seqs.push((client, next));
        }
        self.with(move |c| {
            let t = c.transaction()?;
            t.execute(
                "UPDATE boards SET base_doc = ?2, base_codec = ?3, base_seq = ?4 WHERE id = ?1",
                params![board, doc, codec.as_str(), base_seq as i64],
            )?;
            // Newest first: keep entries while both budgets allow.
            // If every row fits the budget, the floor stays where earlier compactions left it: just
            // below the oldest row still kept, never back to 0 (review finding 6).
            let mut floor = base_seq;
            let (mut n, mut bytes) = (0usize, 0usize);
            {
                let mut stmt = t.prepare("SELECT seq, length(tx) FROM ops WHERE board = ?1 AND seq <= ?2 ORDER BY seq DESC")?;
                let mut rows = stmt.query(params![board, base_seq as i64])?;
                while let Some(row) = rows.next()? {
                    let (seq, len): (i64, i64) = (row.get(0)?, row.get(1)?);
                    if n + 1 > keep_ops || bytes + len as usize > keep_bytes {
                        floor = seq as u64;
                        break;
                    }
                    n += 1;
                    bytes += len as usize;
                    floor = seq as u64 - 1;
                }
            }
            t.execute("DELETE FROM ops WHERE board = ?1 AND seq <= ?2", params![board, floor as i64])?;
            for (client, next) in seqs {
                t.prepare_cached(
                    "INSERT INTO client_seqs (board, client, next_cseq) VALUES (?1, ?2, ?3)
                     ON CONFLICT (board, client) DO UPDATE SET next_cseq = MAX(next_cseq, excluded.next_cseq)",
                )?
                .execute(params![board, client, next as i64])?;
            }
            let kept: i64 = t.query_row("SELECT COALESCE(SUM(length(tx)), 0) FROM ops WHERE board = ?1", [&board], |r| r.get(0))?;
            t.commit()?;
            Ok((floor, kept as usize))
        })
        .await
    }

    /// `Entry` frames for log positions `from..=to`, as many as fit about `max_bytes` (at least
    /// one), for catch-up. Read on the reader connection, from rows already durable.
    pub async fn entry_frames(&self, board: String, from: u64, to: u64, max_bytes: usize) -> Result<Vec<String>, StoreError> {
        let reader = self.reader.clone();
        tokio::task::spawn_blocking(move || {
            let c = reader.lock().map_err(|_| StoreError::Join)?;
            let mut stmt = c.prepare_cached("SELECT seq, codec, tx FROM ops WHERE board = ?1 AND seq >= ?2 AND seq <= ?3 ORDER BY seq")?;
            let mut rows = stmt.query(params![board, from as i64, to as i64])?;
            let (mut frames, mut bytes) = (Vec::new(), 0usize);
            let mut expected = from as i64;
            while let Some(row) = rows.next()? {
                let seq: i64 = row.get(0)?;
                if seq != expected && expected == from as i64 {
                    // The range starts below what's kept: compacted since it was queued.
                    return Err(StoreError::Compacted);
                }
                if seq != expected {
                    return Err(StoreError::Corrupt(format!("op log gap at {seq}, expected {expected}")));
                }
                expected += 1;
                let json = codec::decode(Codec::parse(&row.get::<_, String>(1)?)?, &raw(row.get_ref(2)?)?, OP_DECODE_LIMIT)?;
                let json = String::from_utf8(json).map_err(|e| StoreError::Corrupt(e.to_string()))?;
                let frame = entry_frame(seq as u64, &json);
                bytes += frame.len();
                frames.push(frame);
                if bytes >= max_bytes {
                    break;
                }
            }
            if frames.is_empty() {
                return Err(StoreError::Compacted); // nothing from `from` on: compacted past it
            }
            Ok(frames)
        })
        .await
        .map_err(|_| StoreError::Join)?
    }

    /// Replace the owner token: the old one stops working at once. Returns false if `old` isn't
    /// this board's live owner link. Links the old owner minted stay valid.
    pub async fn rotate_owner(&self, board: String, old: String, new: String, now: i64) -> Result<bool, StoreError> {
        self.with(move |c| {
            let t = c.transaction()?;
            let n = t.execute(
                "UPDATE links SET revoked_at = ?1 WHERE hash = ?2 AND board = ?3 AND role = 'owner' AND revoked_at IS NULL",
                params![now, old, board],
            )?;
            if n != 1 {
                return Ok(false);
            }
            t.execute(
                "INSERT INTO links (hash, board, role, label, created_at) VALUES (?1, ?2, 'owner', 'owner', ?3)",
                params![new, board, now],
            )?;
            // Keep lineage: the old owner's children now hang off the new owner.
            t.execute("UPDATE links SET minted_by = ?1 WHERE minted_by = ?2", params![new, old])?;
            t.commit()?;
            Ok(true)
        })
        .await
    }

    pub async fn link(&self, hash: String) -> Result<Option<LinkRow>, StoreError> {
        self.with(move |c| {
            let row = c
                .query_row(
                    "SELECT l.hash, l.board, l.role, l.label, l.created_at, l.revoked_at IS NOT NULL, l.minted_by, b.kind
                     FROM links l JOIN boards b ON b.id = l.board WHERE l.hash = ?1",
                    [&hash],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, String>(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get::<_, String>(7)?)),
                )
                .optional()?;
            row.map(|(hash, board, role, label, created_at, revoked, minted_by, kind)| {
                Ok(LinkRow { hash, board, role: parse_role(&role)?, label, created_at, revoked, minted_by, kind: RoomKind::parse(&kind)? })
            })
            .transpose()
        })
        .await
    }

    /// Mint a link on behalf of `parent`, atomically refusing if `parent` is (or just became)
    /// revoked, so a revocation can never miss a link minted concurrently.
    pub async fn add_link(
        &self,
        hash: String,
        board: String,
        role: LinkRole,
        label: String,
        parent: String,
        now: i64,
    ) -> Result<bool, StoreError> {
        self.with(move |c| {
            let n = c.execute(
                "INSERT INTO links (hash, board, role, label, created_at, minted_by)
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6
                 WHERE EXISTS (SELECT 1 FROM links WHERE hash = ?6 AND board = ?2 AND revoked_at IS NULL)",
                params![hash, board, role_str(role), label, now, parent],
            )?;
            Ok(n == 1)
        })
        .await
    }

    /// Links visible to `viewer`: every link for the owner; for anyone else, the links minted
    /// through them (their descendants), not including themselves.
    pub async fn links_visible_to(&self, board: String, viewer: String, is_owner: bool) -> Result<Vec<LinkRow>, StoreError> {
        self.with(move |c| {
            let sql = if is_owner {
                "SELECT hash, board, role, label, created_at, revoked_at IS NOT NULL, minted_by FROM links
                 WHERE board = ?1 AND ?2 = ?2 ORDER BY created_at"
            } else {
                "WITH RECURSIVE sub(hash) AS (
                   SELECT hash FROM links WHERE minted_by = ?2 AND board = ?1
                   UNION SELECT l.hash FROM links l JOIN sub ON l.minted_by = sub.hash
                 )
                 SELECT hash, board, role, label, created_at, revoked_at IS NOT NULL, minted_by FROM links
                 WHERE board = ?1 AND hash IN (SELECT hash FROM sub) ORDER BY created_at"
            };
            let mut stmt = c.prepare(sql)?;
            let rows = stmt.query_map(params![board, viewer], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get::<_, String>(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
            })?;
            let mut out = Vec::new();
            for row in rows {
                let (hash, board, role, label, created_at, revoked, minted_by) = row?;
                // Every link listed is on `board`, whose kind the route already asserted.
                out.push(LinkRow { hash, board, role: parse_role(&role)?, label, created_at, revoked, minted_by, kind: RoomKind::Board });
            }
            Ok(out)
        })
        .await
    }

    /// Revoke the link with public id `link_id` and everything minted through it. `actor` must be
    /// the owner, or an ancestor of the target. Returns the hashes revoked (empty if not allowed
    /// or not found).
    pub async fn revoke(
        &self,
        board: String,
        link_id: String,
        actor: String,
        actor_is_owner: bool,
        now: i64,
    ) -> Result<Vec<String>, StoreError> {
        self.with(move |c| {
            let t = c.transaction()?;
            let target: Option<String> = t
                .query_row(
                    "SELECT hash FROM links WHERE board = ?1 AND substr(hash, 1, 16) = ?2 AND role != 'owner'",
                    params![board, link_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(target) = target else { return Ok(Vec::new()) };
            if !actor_is_owner {
                // The actor must be a strict ancestor of the target.
                let allowed: bool = t.query_row(
                    "WITH RECURSIVE up(hash, parent) AS (
                       SELECT hash, minted_by FROM links WHERE hash = ?1
                       UNION SELECT l.hash, l.minted_by FROM links l JOIN up ON l.hash = up.parent
                     )
                     SELECT EXISTS (SELECT 1 FROM up WHERE parent = ?2)",
                    params![target, actor],
                    |r| r.get(0),
                )?;
                if !allowed {
                    return Ok(Vec::new());
                }
            }
            let mut stmt = t.prepare(
                "WITH RECURSIVE sub(hash) AS (
                   SELECT ?1
                   UNION SELECT l.hash FROM links l JOIN sub ON l.minted_by = sub.hash
                 )
                 SELECT hash FROM sub",
            )?;
            let hashes: Vec<String> = stmt.query_map([&target], |r| r.get(0))?.collect::<Result<_, _>>()?;
            drop(stmt);
            for h in &hashes {
                t.execute("UPDATE links SET revoked_at = ?1 WHERE hash = ?2 AND revoked_at IS NULL", params![now, h])?;
            }
            t.commit()?;
            Ok(hashes)
        })
        .await
    }
}

/// `add_grant`'s body, in the caller's transaction.
fn write_grant(t: &rusqlite::Transaction<'_>, g: &NewGrant) -> Result<GrantWrite, StoreError> {
    let live = |hash: &str, room: &str, kind: RoomKind| -> rusqlite::Result<bool> {
        t.query_row(
            "SELECT EXISTS (SELECT 1 FROM links l JOIN boards b ON b.id = l.board
                            WHERE l.hash = ?1 AND l.board = ?2 AND b.kind = ?3 AND l.revoked_at IS NULL)",
            params![hash, room, kind.as_str()],
            |r| r.get(0),
        )
    };
    if !live(&g.minted_by, &g.board, RoomKind::Board)? || !live(&g.added_by, &g.session, RoomKind::Session)? {
        return Ok(GrantWrite::Refused);
    }
    let held: i64 = t.query_row(
        "SELECT COUNT(*) FROM session_grants s JOIN links l ON l.hash = s.link_hash WHERE s.session = ?1 AND l.revoked_at IS NULL",
        [&g.session],
        |r| r.get(0),
    )?;
    if held as u64 >= g.max_live {
        return Ok(GrantWrite::Full);
    }
    t.execute(
        "INSERT INTO links (hash, board, role, label, created_at, minted_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![g.link_hash, g.board, role_str(g.role), g.label, g.now, g.minted_by],
    )?;
    t.execute(
        "INSERT INTO session_grants (session, grant_id, board, link_hash, added_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![g.session, g.grant_id, g.board, g.link_hash, g.added_by, g.now],
    )?;
    Ok(GrantWrite::Written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_v1_database_migrates_to_current() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("db.sqlite");
        {
            // The v1 schema exactly as it shipped.
            let c = Connection::open(&path).expect("open");
            c.execute_batch(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO meta VALUES ('schema_version', '1');
                 CREATE TABLE boards (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, base_doc TEXT NOT NULL, base_seq INTEGER NOT NULL);
                 CREATE TABLE links (hash TEXT PRIMARY KEY, board TEXT NOT NULL REFERENCES boards(id), role TEXT NOT NULL,
                                     label TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
                 INSERT INTO boards VALUES ('b', 0, '[]', 0);
                 INSERT INTO links VALUES ('h', 'b', 'owner', 'owner', 0, NULL);",
            )
            .expect("v1 schema");
        }
        let _store = Store::open(&path).expect("migrates");
        let c = Connection::open(&path).expect("reopen");
        let v: String = c.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0)).expect("version");
        assert_eq!(v, SCHEMA_VERSION.to_string());
        let parent: Option<String> = c.query_row("SELECT minted_by FROM links WHERE hash = 'h'", [], |r| r.get(0)).expect("column");
        assert_eq!(parent, None);
        // Opening again is a no-op.
        Store::open(&path).expect("idempotent");
    }

    #[test]
    fn ready_frames_match_what_serde_writes() {
        use mapcro_engine::wire::{Base, WireOut};
        let mut n = 0;
        let doc = mapcro_schema::genesis(
            || {
                n += 1;
                mapcro_schema::RecordId(n)
            },
            "t",
        );
        let json = serde_json::to_string(&doc).expect("json");
        let serde = serde_json::to_string(&WireOut::Ready { role: LinkRole::Edit, base: Some(Base { doc, seq: 0 }), peer: 9, head: Some(4) }).expect("json");
        assert_eq!(ready_frame(LinkRole::Edit, &json, 0, 9, 4), serde);
    }

    #[test]
    fn entry_frames_match_what_serde_writes() {
        use mapcro_engine::ServerMsg;
        use mapcro_engine::wire::WireOut;
        let tx: Tx = serde_json::from_str(
            r#"{"client":"0000000000000000000000000000000a","cseq":3,"kind":{"Undo":{"of":2}},"ops":[{"Delete":{"id":"00000000000000000000000000000001"}}]}"#,
        )
        .expect("tx");
        let json = serde_json::to_string(&tx).expect("json");
        let serde = serde_json::to_string(&WireOut::Msg { msg: ServerMsg::Entry { seq: 42, tx } }).expect("json");
        assert_eq!(entry_frame(42, &json), serde);
    }

    #[test]
    fn a_database_from_the_future_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("db.sqlite");
        Store::open(&path).expect("create");
        Connection::open(&path)
            .expect("open")
            .execute_batch("UPDATE meta SET value = '99' WHERE key = 'schema_version'; DELETE FROM meta WHERE key = 'compat_floor';")
            .expect("a newer database from before the floor existed");
        assert!(matches!(Store::open(&path), Err(StoreError::Corrupt(_))), "no floor: refused");
    }

    fn meta(path: &Path, key: &str) -> Option<String> {
        Connection::open(path).expect("open").query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional().expect("meta")
    }

    #[test]
    fn v5_and_v6_servers_open_a_v7_database_without_touching_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("db.sqlite");
        Store::open(&path).expect("create at v7");
        // What a v5 or v6 server's open does with it: v6 and v7 only added, so they may.
        for older in [5, 6] {
            let c = Connection::open(&path).expect("open");
            reconcile(&c, older).expect("an older server opens a v7 database");
            drop(c);
            assert_eq!(meta(&path, "schema_version").as_deref(), Some("7"), "not migrated backwards");
            assert_eq!(meta(&path, "compat_floor").as_deref(), Some("5"));
        }
        // And a v4 server, below the floor, may not.
        let c = Connection::open(&path).expect("open");
        assert!(matches!(reconcile(&c, 4), Err(StoreError::Corrupt(_))));
    }

    #[test]
    fn a_database_whose_floor_is_above_this_server_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("db.sqlite");
        Store::open(&path).expect("create");
        Connection::open(&path)
            .expect("open")
            .execute_batch("UPDATE meta SET value = '9' WHERE key = 'schema_version'; UPDATE meta SET value = '8' WHERE key = 'compat_floor';")
            .expect("a v9 database that a v8 migration broke for older servers");
        assert!(matches!(Store::open(&path), Err(StoreError::Corrupt(_))));
        assert_eq!(meta(&path, "schema_version").as_deref(), Some("9"), "left as it was");
        // The same database with an additive history opens.
        Connection::open(&path).expect("open").execute("UPDATE meta SET value = '7' WHERE key = 'compat_floor'", []).expect("floor");
        Store::open(&path).expect("floor at this server's version: opens");
        assert_eq!(meta(&path, "schema_version").as_deref(), Some("9"), "still not migrated backwards");
    }

    #[test]
    fn the_floor_persists_across_migrations() {
        assert_eq!((1..=7).map(compat_floor).collect::<Vec<_>>(), [1, 2, 3, 4, 5, 5, 5], "v6 and v7 are additive; earlier steps are not");
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("db.sqlite");
        // A database a pre-floor v5 server wrote: no compat_floor row.
        let c = Connection::open(&path).expect("open");
        Store::open(&path).expect("create");
        c.execute_batch("UPDATE meta SET value = '5' WHERE key = 'schema_version'; DELETE FROM meta WHERE key = 'compat_floor';").expect("v5");
        drop(c);
        Store::open(&path).expect("migrates to v7");
        assert_eq!(meta(&path, "schema_version").as_deref(), Some("7"));
        assert_eq!(meta(&path, "compat_floor").as_deref(), Some("5"), "the additive step kept v5's floor");
        // A database migrated before the floor existed gets it on open.
        Connection::open(&path).expect("open").execute("DELETE FROM meta WHERE key = 'compat_floor'", []).expect("drop floor");
        Store::open(&path).expect("reopen");
        assert_eq!(meta(&path, "compat_floor").as_deref(), Some("5"));
    }

    /// A database as a v6 server left it, with what a board in use holds (its base, a log of
    /// edits, a client, a chain of links, one revoked), opens on v7 with every board a board,
    /// every link as it was, and the board loading as it did (sessions spec §2.1, §7.3).
    #[tokio::test]
    async fn a_v6_database_in_use_migrates_to_v7_with_boards_unchanged() {
        use crate::links;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("db.sqlite");
        let mut n = 0u128;
        let doc = mapcro_schema::genesis(
            || {
                n += 1;
                mapcro_schema::RecordId(n)
            },
            "Scrim",
        );
        let scene = doc.iter_live().find(|(_, r)| matches!(r, mapcro_schema::Record::Scene(_))).map(|(id, _)| id).expect("scene");
        let (owner, edit, view, gone) = (links::hash("o"), links::hash("e"), links::hash("v"), links::hash("g"));
        let mut tx_doc = doc.clone();
        let mut writes = Vec::new();
        for seq in 0..5u64 {
            let tx = Tx {
                client: ClientId(7),
                cseq: seq,
                kind: mapcro_schema::TxKind::Edit,
                ops: vec![mapcro_schema::Op::Create {
                    id: mapcro_schema::RecordId(1000 + u128::from(seq)),
                    record: mapcro_schema::Record::Callout(mapcro_schema::Callout { scene, pos: Default::default(), text: format!("c{seq}"), color: None }),
                }],
            };
            mapcro_schema::apply_tx(&mut tx_doc, &tx).expect("edit");
            let (codec, stored) = codec::encode(&serde_json::to_vec(&tx).expect("json"));
            writes.push(Write::Op { seq: seq + 1, codec, stored });
        }
        writes.push(Write::Client { client: ClientId(7), secret_hash: [9; 32] });
        {
            let v6 = Store::open_at(&path, 6).expect("a v6 database");
            assert_eq!(meta(&path, "schema_version").as_deref(), Some("6"));
            // The board row and owner link as v6's `create_board` wrote them (no kind column).
            let (base_codec, base) = codec::encode(&serde_json::to_vec(&doc).expect("json"));
            v6.with(move |c| {
                c.execute("INSERT INTO boards (id, created_at, base_doc, base_seq, base_codec) VALUES ('b', 1, ?1, 0, ?2)", params![base, base_codec.as_str()])?;
                c.execute("INSERT INTO links (hash, board, role, label, created_at) VALUES (?1, 'b', 'owner', 'owner', 1)", [&links::hash("o")])?;
                Ok(())
            })
            .await
            .expect("board");
            assert!(v6.add_link(edit.clone(), "b".into(), LinkRole::Edit, "coach".into(), owner.clone(), 2).await.expect("edit link"));
            assert!(v6.add_link(view.clone(), "b".into(), LinkRole::View, "team".into(), edit.clone(), 3).await.expect("view link"));
            assert!(v6.add_link(gone.clone(), "b".into(), LinkRole::Edit, "old".into(), owner.clone(), 4).await.expect("link"));
            assert_eq!(v6.revoke("b".into(), links::link_id(&gone).into(), owner.clone(), true, 5).await.expect("revoke"), vec![gone.clone()]);
            v6.commit("b".into(), writes).await.expect("log");
        }
        let store = Store::open(&path).expect("migrates");
        assert_eq!(meta(&path, "schema_version").as_deref(), Some("7"));
        assert_eq!(meta(&path, "compat_floor").as_deref(), Some("5"), "additive: a v5 or v6 server still opens it");
        for (hash, role, label, revoked, parent) in [
            (&owner, LinkRole::Owner, "owner", false, None),
            (&edit, LinkRole::Edit, "coach", false, Some(&owner)),
            (&view, LinkRole::View, "team", false, Some(&edit)),
            (&gone, LinkRole::Edit, "old", true, Some(&owner)),
        ] {
            let l = store.link(hash.clone()).await.expect("read").expect("still there");
            assert_eq!((l.board.as_str(), l.role, l.label.as_str(), l.revoked, l.minted_by.as_ref(), l.kind), ("b", role, label, revoked, parent, RoomKind::Board));
        }
        let caps = LoadCaps { ops: 1000, bytes: 1 << 20, clients: 10, rejections: 10 };
        let loaded = store.load_board("b".into(), caps, Quota::default()).await.expect("load").expect("the board");
        assert_eq!(loaded.authority.doc(), &tx_doc, "the board reads as it did, log and all");
        assert_eq!(loaded.authority.log_len(), 5);
        let c = Connection::open(&path).expect("open");
        let kinds: Vec<String> = c.prepare("SELECT kind FROM boards").expect("kind column").query_map([], |r| r.get(0)).expect("rows").collect::<Result<_, _>>().expect("kinds");
        assert_eq!(kinds, ["board"]);
        let grants: i64 = c.query_row("SELECT COUNT(*) FROM session_grants", [], |r| r.get(0)).expect("grants table");
        assert_eq!(grants, 0);
        drop((c, store));
        // A second open is a no-op.
        Store::open(&path).expect("idempotent");
        assert_eq!(meta(&path, "schema_version").as_deref(), Some("7"));
    }
}
