//! SQLite storage (spec §9). WAL with `synchronous=FULL`: when a write returns, it survives a
//! crash or power loss. Rooms wait for that before acknowledging anything.

use mapcro_engine::wire::LinkRole;
use mapcro_schema::{ClientId, Doc, Reject, Tx};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("stored data is corrupt: {0}")]
    Corrupt(String),
    #[error("storage thread failed")]
    Join,
}

/// Everything needed to rebuild a board's authority.
pub struct StoredBoard {
    pub base: Doc,
    pub base_seq: u64,
    pub log: Vec<Tx>,
    pub rejections: Vec<(ClientId, u64, Reject)>,
}

pub struct LinkRow {
    pub hash: String,
    pub board: String,
    pub role: LinkRole,
    pub label: String,
    pub created_at: i64,
    pub revoked: bool,
}

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

const SCHEMA_VERSION: i64 = 1;

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
        let version: Option<i64> = conn
            .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get::<_, String>(0))
            .optional()?
            .map(|v| v.parse().unwrap_or(-1));
        match version {
            None => {
                conn.execute("INSERT INTO meta (key, value) VALUES ('schema_version', ?1)", [SCHEMA_VERSION.to_string()])?;
            }
            Some(SCHEMA_VERSION) => {}
            Some(v) => return Err(StoreError::Corrupt(format!("database schema {v}, this server knows {SCHEMA_VERSION}"))),
        }
        Ok(Store { conn: Arc::new(Mutex::new(conn)) })
    }

    /// Run a closure on the connection off the async runtime.
    async fn with<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn.lock().map_err(|_| StoreError::Join)?;
            f(&mut guard)
        })
        .await
        .map_err(|_| StoreError::Join)?
    }

    pub async fn ping(&self) -> Result<(), StoreError> {
        self.with(|c| Ok(c.query_row("SELECT 1", [], |r| r.get::<_, i64>(0)).map(|_| ())?)).await
    }

    pub async fn create_board(&self, id: String, base: Doc, owner_hash: String, now: i64) -> Result<(), StoreError> {
        let base = serde_json::to_string(&base).map_err(corrupt)?;
        self.with(move |c| {
            let t = c.transaction()?;
            t.execute("INSERT INTO boards (id, created_at, base_doc, base_seq) VALUES (?1, ?2, ?3, 0)", params![id, now, base])?;
            t.execute(
                "INSERT INTO links (hash, board, role, label, created_at) VALUES (?1, ?2, 'owner', 'owner', ?3)",
                params![owner_hash, id, now],
            )?;
            t.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn load_board(&self, id: String) -> Result<Option<StoredBoard>, StoreError> {
        self.with(move |c| {
            let Some((base, base_seq)) = c
                .query_row("SELECT base_doc, base_seq FROM boards WHERE id = ?1", [&id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
                })
                .optional()?
            else {
                return Ok(None);
            };
            let base: Doc = serde_json::from_str(&base).map_err(corrupt)?;
            mapcro_schema::validate_doc(&base).map_err(|r| StoreError::Corrupt(format!("base document: {r}")))?;
            let mut stmt = c.prepare("SELECT seq, tx FROM ops WHERE board = ?1 ORDER BY seq")?;
            let mut log = Vec::new();
            let mut expected = base_seq + 1;
            for row in stmt.query_map([&id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
                let (seq, tx) = row?;
                if seq != expected {
                    return Err(StoreError::Corrupt(format!("op log gap at {seq}, expected {expected}")));
                }
                expected += 1;
                log.push(serde_json::from_str(&tx).map_err(corrupt)?);
            }
            let mut stmt = c.prepare("SELECT client, cseq, reason FROM rejections WHERE board = ?1")?;
            let mut rejections = Vec::new();
            for row in stmt.query_map([&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))? {
                let (client, cseq, reason) = row?;
                let client: ClientId = serde_json::from_value(serde_json::Value::String(client)).map_err(corrupt)?;
                rejections.push((client, cseq as u64, serde_json::from_str(&reason).map_err(corrupt)?));
            }
            Ok(Some(StoredBoard { base, base_seq: base_seq as u64, log, rejections }))
        })
        .await
    }

    pub async fn append_op(&self, board: String, seq: u64, tx: &Tx) -> Result<(), StoreError> {
        let tx = serde_json::to_string(tx).map_err(corrupt)?;
        self.with(move |c| {
            c.execute("INSERT INTO ops (board, seq, tx) VALUES (?1, ?2, ?3)", params![board, seq as i64, tx])?;
            Ok(())
        })
        .await
    }

    pub async fn add_rejection(&self, board: String, client: ClientId, cseq: u64, reason: &Reject) -> Result<(), StoreError> {
        let reason = serde_json::to_string(reason).map_err(corrupt)?;
        let client = serde_json::to_value(client).map_err(corrupt)?.as_str().unwrap_or_default().to_owned();
        self.with(move |c| {
            c.execute(
                "INSERT OR IGNORE INTO rejections (board, client, cseq, reason) VALUES (?1, ?2, ?3, ?4)",
                params![board, client, cseq as i64, reason],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn link(&self, hash: String) -> Result<Option<LinkRow>, StoreError> {
        self.with(move |c| {
            let row = c
                .query_row(
                    "SELECT hash, board, role, label, created_at, revoked_at IS NOT NULL FROM links WHERE hash = ?1",
                    [&hash],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, String>(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                )
                .optional()?;
            row.map(|(hash, board, role, label, created_at, revoked)| {
                Ok(LinkRow { hash, board, role: parse_role(&role)?, label, created_at, revoked })
            })
            .transpose()
        })
        .await
    }

    pub async fn add_link(&self, hash: String, board: String, role: LinkRole, label: String, now: i64) -> Result<(), StoreError> {
        self.with(move |c| {
            c.execute(
                "INSERT INTO links (hash, board, role, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![hash, board, role_str(role), label, now],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn links_for(&self, board: String) -> Result<Vec<LinkRow>, StoreError> {
        self.with(move |c| {
            let mut stmt = c.prepare(
                "SELECT hash, board, role, label, created_at, revoked_at IS NOT NULL FROM links WHERE board = ?1 ORDER BY created_at",
            )?;
            let rows = stmt.query_map([&board], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get::<_, String>(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            })?;
            let mut out = Vec::new();
            for row in rows {
                let (hash, board, role, label, created_at, revoked) = row?;
                out.push(LinkRow { hash, board, role: parse_role(&role)?, label, created_at, revoked });
            }
            Ok(out)
        })
        .await
    }

    /// Revoke a non-owner link by its public id (a prefix of its hash). Returns the full hash.
    pub async fn revoke(&self, board: String, link_id: String, now: i64) -> Result<Option<String>, StoreError> {
        self.with(move |c| {
            let hash: Option<String> = c
                .query_row(
                    "SELECT hash FROM links WHERE board = ?1 AND substr(hash, 1, 16) = ?2 AND role != 'owner'",
                    params![board, link_id],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(h) = &hash {
                c.execute("UPDATE links SET revoked_at = ?1 WHERE hash = ?2 AND revoked_at IS NULL", params![now, h])?;
            }
            Ok(hash)
        })
        .await
    }
}
