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
    pub clients: Vec<(ClientId, [u8; 32])>,
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
}

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

/// Database schema version. Each step in `migrate` takes the database one version forward.
const SCHEMA_VERSION: i64 = 3;

/// v1 → v2: links remember which link minted them (editors can share; revocation cascades).
fn migrate(conn: &Connection, from: i64) -> Result<(), StoreError> {
    let mut v = from;
    while v < SCHEMA_VERSION {
        match v {
            1 => conn.execute_batch(
                "ALTER TABLE links ADD COLUMN minted_by TEXT REFERENCES links(hash);
                 CREATE INDEX IF NOT EXISTS links_by_parent ON links(minted_by);",
            )?,
            // v2 → v3: client ids are bound to a secret (security review H1).
            2 => conn.execute_batch(
                "CREATE TABLE clients (
                   board TEXT NOT NULL REFERENCES boards(id),
                   client TEXT NOT NULL,
                   secret_hash BLOB NOT NULL,
                   PRIMARY KEY (board, client)
                 ) WITHOUT ROWID;",
            )?,
            other => return Err(StoreError::Corrupt(format!("no migration from schema {other}"))),
        }
        v += 1;
        conn.execute("UPDATE meta SET value = ?1 WHERE key = 'schema_version'", [v.to_string()])?;
        tracing::info!(to = v, "migrated database schema");
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
                // A fresh database is created at v1 above, then migrated like any other.
                conn.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '1')", [])?;
                migrate(&conn, 1)?;
            }
            Some(v) if v == SCHEMA_VERSION => {}
            Some(v) if (1..SCHEMA_VERSION).contains(&v) => migrate(&conn, v)?,
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
            #[allow(clippy::explicit_counter_loop)] // the counter is checked against the row, not used as an index
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
            let mut stmt = c.prepare("SELECT client, secret_hash FROM clients WHERE board = ?1")?;
            let mut clients = Vec::new();
            for row in stmt.query_map([&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))? {
                let (client, hash) = row?;
                let client: ClientId = serde_json::from_value(serde_json::Value::String(client)).map_err(corrupt)?;
                let hash: [u8; 32] = hash.try_into().map_err(|_| StoreError::Corrupt("secret hash length".into()))?;
                clients.push((client, hash));
            }
            Ok(Some(StoredBoard { base, base_seq: base_seq as u64, log, rejections, clients }))
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

    pub async fn add_client(&self, board: String, client: ClientId, secret_hash: [u8; 32]) -> Result<(), StoreError> {
        let client = serde_json::to_value(client).map_err(corrupt)?.as_str().unwrap_or_default().to_owned();
        self.with(move |c| {
            c.execute(
                "INSERT OR IGNORE INTO clients (board, client, secret_hash) VALUES (?1, ?2, ?3)",
                params![board, client, secret_hash.to_vec()],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn prune_rejections(&self, board: String, client: ClientId, below: u64) -> Result<(), StoreError> {
        let client = serde_json::to_value(client).map_err(corrupt)?.as_str().unwrap_or_default().to_owned();
        self.with(move |c| {
            c.execute("DELETE FROM rejections WHERE board = ?1 AND client = ?2 AND cseq < ?3", params![board, client, below as i64])?;
            Ok(())
        })
        .await
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
                    "SELECT hash, board, role, label, created_at, revoked_at IS NOT NULL, minted_by FROM links WHERE hash = ?1",
                    [&hash],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, String>(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
                )
                .optional()?;
            row.map(|(hash, board, role, label, created_at, revoked, minted_by)| {
                Ok(LinkRow { hash, board, role: parse_role(&role)?, label, created_at, revoked, minted_by })
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
                out.push(LinkRow { hash, board, role: parse_role(&role)?, label, created_at, revoked, minted_by });
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
    fn a_database_from_the_future_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("db.sqlite");
        Store::open(&path).expect("create");
        Connection::open(&path)
            .expect("open")
            .execute("UPDATE meta SET value = '99' WHERE key = 'schema_version'", [])
            .expect("bump");
        assert!(matches!(Store::open(&path), Err(StoreError::Corrupt(_))));
    }
}
