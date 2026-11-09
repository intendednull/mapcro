//! The metrics tables (schema v6, `store.rs` migrates): minute and hourly rows, the
//! recent-failures log, and the daily user counts. Written once a minute by the collector, read
//! by `mapcro-server stats`.

use super::Kind;
use super::failures::Failure;
use super::snapshot::{Buckets, HOUR, MINUTE, Row};
use rusqlite::{Connection, OptionalExtension, params};

/// v5 → v6 (`store::migrate`).
pub const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS metric_rows (
      res INTEGER NOT NULL,
      t INTEGER NOT NULL,
      name TEXT NOT NULL,
      labels TEXT NOT NULL,
      kind TEXT NOT NULL,
      value REAL NOT NULL,
      sum REAL,
      n INTEGER,
      max REAL,
      buckets TEXT,
      PRIMARY KEY (res, name, labels, t)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS metric_rows_by_time ON metric_rows(res, t);
    CREATE TABLE IF NOT EXISTS failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      t INTEGER NOT NULL,
      kind TEXT NOT NULL,
      code TEXT NOT NULL,
      build TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS failures_by_time ON failures(t);
    CREATE TABLE IF NOT EXISTS daily_users (
      day INTEGER PRIMARY KEY,
      users INTEGER NOT NULL
    );";

/// Minute rows are kept this long, then rolled into hours.
pub const MINUTES_KEPT_S: i64 = 7 * 86_400;
/// Hourly rows are kept this long.
pub const HOURS_KEPT_S: i64 = 400 * 86_400;
/// The failures log keeps at most this many rows, and none older than `FAILURES_KEPT_S`.
pub const FAILURES_KEPT: i64 = 1000;
pub const FAILURES_KEPT_S: i64 = 30 * 86_400;

fn kind_of(s: &str) -> Kind {
    match s {
        "gauge" => Kind::Gauge,
        "histogram" => Kind::Histogram,
        _ => Kind::Counter,
    }
}

fn buckets_json(b: &Option<Buckets>) -> Option<String> {
    b.as_ref().map(|b| serde_json::to_string(b).unwrap_or_else(|_| "[]".into()))
}

fn row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    let kind: String = r.get(4)?;
    let buckets: Option<String> = r.get(9)?;
    Ok(Row {
        res: r.get(0)?,
        t: r.get(1)?,
        name: r.get(2)?,
        labels: r.get(3)?,
        kind: kind_of(&kind),
        value: r.get(5)?,
        sum: r.get(6)?,
        n: r.get(7)?,
        max: r.get(8)?,
        buckets: buckets.and_then(|b| serde_json::from_str(&b).ok()),
    })
}

const COLUMNS: &str = "res, t, name, labels, kind, value, sum, n, max, buckets";

/// Write `row`, merged into the row already there for its window (a restart within a minute,
/// or a rollup into an hour that has rows).
fn upsert(c: &Connection, row: &Row) -> rusqlite::Result<()> {
    let existing = c
        .query_row(
            &format!("SELECT {COLUMNS} FROM metric_rows WHERE res = ?1 AND name = ?2 AND labels = ?3 AND t = ?4"),
            params![row.res, row.name, row.labels, row.t],
            row_from,
        )
        .optional()?;
    let merged = match existing {
        Some(mut e) => {
            e.merge(row);
            e
        }
        None => row.clone(),
    };
    c.execute(
        &format!("INSERT OR REPLACE INTO metric_rows ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"),
        params![merged.res, merged.t, merged.name, merged.labels, merged.kind.as_str(), merged.value, merged.sum, merged.n, merged.max, buckets_json(&merged.buckets)],
    )?;
    Ok(())
}

/// One minute's snapshot: its rows, the failures since the last, the user counts; then the
/// rollup and retention. One transaction.
pub fn write(c: &mut Connection, rows: &[Row], failures: &[Failure], users: &[(i64, u64)], build: &str, now: i64) -> rusqlite::Result<()> {
    let t = c.transaction()?;
    for r in rows {
        upsert(&t, r)?;
    }
    for f in failures {
        t.execute("INSERT INTO failures (t, kind, code, build, message) VALUES (?1, ?2, ?3, ?4, ?5)", params![f.t, f.kind, f.code, build, f.message])?;
    }
    for (day, n) in users {
        t.execute(
            "INSERT INTO daily_users (day, users) VALUES (?1, ?2) ON CONFLICT(day) DO UPDATE SET users = max(users, excluded.users)",
            params![day, *n as i64],
        )?;
    }
    rollup(&t, now)?;
    retain(&t, now)?;
    t.commit()
}

/// Minute rows older than 7 days become hourly rows. The cutoff is on an hour, so each hour is
/// rolled whole.
pub fn rollup(c: &Connection, now: i64) -> rusqlite::Result<usize> {
    let cutoff = (now - MINUTES_KEPT_S).div_euclid(HOUR) * HOUR;
    let old: Vec<Row> = c
        .prepare(&format!("SELECT {COLUMNS} FROM metric_rows WHERE res = ?1 AND t < ?2 ORDER BY t"))?
        .query_map(params![MINUTE, cutoff], row_from)?
        .collect::<Result<_, _>>()?;
    let mut hours: std::collections::BTreeMap<(i64, String, String), Row> = Default::default();
    for r in &old {
        let hour = r.t.div_euclid(HOUR) * HOUR;
        hours
            .entry((hour, r.name.clone(), r.labels.clone()))
            .and_modify(|h| h.merge(r))
            .or_insert_with(|| Row { res: HOUR, t: hour, ..r.clone() });
    }
    for h in hours.values() {
        upsert(c, h)?;
    }
    c.execute("DELETE FROM metric_rows WHERE res = ?1 AND t < ?2", params![MINUTE, cutoff])?;
    Ok(old.len())
}

/// Hourly rows past 400 days, failures past 30 days or the newest 1,000, and user counts past
/// 400 days go.
pub fn retain(c: &Connection, now: i64) -> rusqlite::Result<()> {
    c.execute("DELETE FROM metric_rows WHERE res = ?1 AND t < ?2", params![HOUR, now - HOURS_KEPT_S])?;
    c.execute("DELETE FROM failures WHERE t < ?1", params![now - FAILURES_KEPT_S])?;
    c.execute(
        "DELETE FROM failures WHERE id <= (SELECT id FROM failures ORDER BY id DESC LIMIT 1 OFFSET ?1)",
        params![FAILURES_KEPT],
    )?;
    c.execute("DELETE FROM daily_users WHERE day < ?1", params![(now - HOURS_KEPT_S).div_euclid(86_400)])?;
    Ok(())
}

// ---- reading (stats) ----

/// Rows of `name` in `[since, until)`, minutes where there are any and hours before them.
pub fn rows(c: &Connection, name: &str, since: i64, until: i64) -> rusqlite::Result<Vec<Row>> {
    c.prepare(&format!("SELECT {COLUMNS} FROM metric_rows WHERE name = ?1 AND t >= ?2 AND t < ?3 ORDER BY t, res"))?
        .query_map(params![name, since, until], row_from)?
        .collect()
}

/// Every metric name with rows.
pub fn names(c: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    c.prepare("SELECT DISTINCT name, kind FROM metric_rows ORDER BY name")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()
}

pub struct FailureRow {
    pub t: i64,
    pub kind: String,
    pub code: String,
    pub build: String,
    pub message: String,
}

pub fn failures(c: &Connection, since: i64, until: i64) -> rusqlite::Result<Vec<FailureRow>> {
    c.prepare("SELECT t, kind, code, build, message FROM failures WHERE t >= ?1 AND t < ?2 ORDER BY t")?
        .query_map(params![since, until], |r| Ok(FailureRow { t: r.get(0)?, kind: r.get(1)?, code: r.get(2)?, build: r.get(3)?, message: r.get(4)? }))?
        .collect()
}

pub fn daily_users(c: &Connection, since_day: i64, until_day: i64) -> rusqlite::Result<Vec<(i64, i64)>> {
    c.prepare("SELECT day, users FROM daily_users WHERE day >= ?1 AND day < ?2 ORDER BY day")?
        .query_map(params![since_day, until_day], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().expect("db");
        c.execute_batch(SCHEMA).expect("schema");
        c
    }

    fn counter(t: i64, v: f64) -> Row {
        Row { res: MINUTE, t, name: "c".into(), labels: "k=a".into(), kind: Kind::Counter, value: v, sum: None, n: None, max: None, buckets: None }
    }

    fn all(c: &Connection) -> Vec<Row> {
        c.prepare(&format!("SELECT {COLUMNS} FROM metric_rows ORDER BY res, t")).expect("q").query_map([], row_from).expect("q").collect::<Result<_, _>>().expect("rows")
    }

    #[test]
    fn a_restart_within_a_minute_merges_into_its_row() {
        let mut c = db();
        write(&mut c, &[counter(600, 2.0)], &[], &[], "b", 700).expect("write");
        write(&mut c, &[counter(600, 3.0)], &[], &[], "b", 700).expect("write");
        let rows = all(&c);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].value, 5.0);
    }

    #[test]
    fn minutes_roll_into_hours_after_seven_days_and_hours_go_after_400() {
        let mut c = db();
        let day = 86_400;
        let now = 500 * day;
        let old_hour = now - 8 * day; // on an hour boundary
        let mut rows = vec![counter(old_hour, 1.0), counter(old_hour + 60, 2.0), counter(old_hour + 3540, 4.0), counter(old_hour + 3600, 8.0)];
        let g = |t, v: f64, max| Row { name: "g".into(), labels: String::new(), kind: Kind::Gauge, value: v, sum: Some(v), n: Some(1), max: Some(max), ..counter(t, 0.0) };
        rows.push(g(old_hour, 2.0, 2.0));
        rows.push(g(old_hour + 60, 4.0, 10.0));
        rows.push(counter(now - 60, 16.0)); // recent: stays a minute
        rows.push(Row { res: HOUR, ..counter(now - 401 * day, 1.0) }); // past 400 days
        rows.push(Row { res: HOUR, ..counter(now - 399 * day, 1.0) });
        write(&mut c, &rows, &[], &[], "b", now).expect("write");
        let rows = all(&c);
        let minutes: Vec<_> = rows.iter().filter(|r| r.res == MINUTE).collect();
        assert_eq!(minutes.len(), 1, "only the recent minute is left");
        assert_eq!(minutes[0].t, now - 60);
        let hours: Vec<_> = rows.iter().filter(|r| r.res == HOUR).collect();
        let c_hours: Vec<(i64, f64)> = hours.iter().filter(|r| r.name == "c").map(|r| (r.t, r.value)).collect();
        assert_eq!(c_hours, vec![(now - 399 * day, 1.0), (old_hour, 7.0), (old_hour + 3600, 8.0)], "each hour sums its minutes; the 401-day hour is gone");
        let g_hour = hours.iter().find(|r| r.name == "g").expect("gauge hour");
        assert_eq!((g_hour.value, g_hour.n, g_hour.max), (3.0, Some(2), Some(10.0)), "a gauge's hour: its mean and its peak");
    }

    #[test]
    fn failures_keep_the_newest_thousand_within_thirty_days() {
        let mut c = db();
        let now = 100 * 86_400;
        let f = |t| Failure { t, kind: "http", code: "match", message: "x".into() };
        let mut fs: Vec<Failure> = vec![f(now - 31 * 86_400)];
        fs.extend((0..1100).map(|i| f(now - 1000 + i)));
        write(&mut c, &[], &fs, &[], "b", now).expect("write");
        let kept = failures(&c, 0, i64::MAX).expect("read");
        assert_eq!(kept.len(), 1000);
        assert_eq!(kept[0].t, now - 1000 + 100, "the oldest went first");
        assert!(kept.iter().all(|r| r.build == "b"));
    }

    #[test]
    fn user_counts_keep_the_highest_seen_for_a_day() {
        let mut c = db();
        write(&mut c, &[], &[], &[(10, 3)], "b", 0).expect("write");
        write(&mut c, &[], &[], &[(10, 5), (11, 1)], "b", 0).expect("write");
        // A restart starts the in-memory set again: a lower count doesn't overwrite the day.
        write(&mut c, &[], &[], &[(11, 0)], "b", 0).expect("write");
        assert_eq!(daily_users(&c, 0, 100).expect("read"), vec![(10, 5), (11, 1)]);
    }
}
