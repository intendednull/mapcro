//! `mapcro-server stats …` (docs/specs/observability.md §4): read-only queries over the metrics
//! tables, for the lead agent first. Short, decision-oriented text by default, health first and
//! each figure against the previous period; `--json` for the full data.
//!
//! ```text
//! mapcro-server stats summary  [--since 24h]
//! mapcro-server stats failures [--since 7d] [--kind http|storage|upstream|replay_job]
//! mapcro-server stats funnel   [--since 7d] [--path cached|fetched|uploaded]
//! mapcro-server stats limits
//! mapcro-server stats usage    [--since 30d] [--by day|week]
//! mapcro-server stats series <metric> [--since 24h] [--labels k=v,…]
//!   common: [--json] [--data-dir DIR] (else $DATA_DIR)
//! ```
//!
//! The database is opened read-only; nothing here writes.

use crate::metrics::db;
use crate::metrics::snapshot::{Buckets, Row};
use crate::metrics::{Kind, quantile};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;

const USAGE: &str = "usage: mapcro-server stats <summary|failures|funnel|limits|usage|series> [flags]
  summary  [--since 24h]                          health, usage, speed, limits vs the period before
  failures [--since 7d] [--kind KIND]             the recent-failures log, grouped
  funnel   [--since 7d] [--path cached|fetched|uploaded]   time to usable/full per day
  limits                                          each resource against its cap: now, peak, trend
  usage    [--since 30d] [--by day|week]          people, boards, matches, features
  series   METRIC [--since 24h] [--labels k=v,…]  one metric's raw rows
common: --json (full data), --data-dir DIR (default $DATA_DIR)";

struct Args {
    cmd: String,
    metric: Option<String>,
    since: Option<i64>,
    kind: Option<String>,
    path: Option<String>,
    by: String,
    labels: Option<String>,
    json: bool,
    data_dir: Option<PathBuf>,
}

/// `90s`, `15m`, `24h`, `7d`, `2w` in seconds.
pub fn parse_span(s: &str) -> Option<i64> {
    let (n, unit) = s.split_at(s.find(|c: char| !c.is_ascii_digit())?);
    let n: i64 = n.parse().ok()?;
    let mul = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86_400,
        "w" => 7 * 86_400,
        _ => return None,
    };
    (n > 0).then_some(n * mul)
}

fn parse_args(a: &[String]) -> Result<Args, String> {
    let mut it = a.iter();
    let mut args = Args { cmd: String::new(), metric: None, since: None, kind: None, path: None, by: "day".into(), labels: None, json: false, data_dir: None };
    while let Some(x) = it.next() {
        let mut val = |name: &str| it.next().cloned().ok_or(format!("{name} needs a value"));
        match x.as_str() {
            "--json" => args.json = true,
            "--since" => args.since = Some(parse_span(&val("--since")?).ok_or("--since takes e.g. 24h, 7d, 2w")?),
            "--kind" => args.kind = Some(val("--kind")?),
            "--path" => args.path = Some(val("--path")?),
            "--by" => args.by = val("--by")?,
            "--labels" => args.labels = Some(val("--labels")?),
            "--data-dir" => args.data_dir = Some(PathBuf::from(val("--data-dir")?)),
            "-h" | "--help" => return Err(String::new()),
            m if !m.starts_with('-') && args.cmd.is_empty() => args.cmd = m.to_owned(),
            m if !m.starts_with('-') && args.cmd == "series" && args.metric.is_none() => args.metric = Some(m.to_owned()),
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    if args.cmd.is_empty() {
        return Err("which query?".into());
    }
    if !matches!(args.by.as_str(), "day" | "week") {
        return Err("--by is day or week".into());
    }
    if let Some(p) = &args.path
        && !matches!(p.as_str(), "cached" | "fetched" | "uploaded")
    {
        return Err("--path is cached, fetched or uploaded".into());
    }
    Ok(args)
}

/// Open the database read-only. A server writing it at the same time is fine (WAL).
fn open(dir: &std::path::Path) -> Result<Connection, String> {
    let path = dir.join("mapcro.sqlite");
    if !path.is_file() {
        return Err(format!("no database at {}", path.display()));
    }
    let c = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    c.execute_batch("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;").map_err(|e| e.to_string())?;
    let has: i64 = c
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'metric_rows'", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if has == 0 {
        return Err("this database has no metrics yet (a server from before schema v6 wrote it)".into());
    }
    Ok(c)
}

/// The command's entry: an exit code.
pub fn main(argv: &[String]) -> i32 {
    let args = match parse_args(argv) {
        Ok(a) => a,
        Err(e) => {
            if !e.is_empty() {
                eprintln!("mapcro-server stats: {e}");
            }
            eprintln!("{USAGE}");
            return 2;
        }
    };
    let Some(dir) = args.data_dir.clone().or_else(|| std::env::var_os("DATA_DIR").filter(|v| !v.is_empty()).map(PathBuf::from)) else {
        eprintln!("mapcro-server stats: pass --data-dir or set DATA_DIR");
        return 2;
    };
    let c = match open(&dir) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("mapcro-server stats: {e}");
            return 1;
        }
    };
    let now = crate::metrics::snapshot::unix_now();
    let out = match args.cmd.as_str() {
        "summary" => summary(&c, now, args.since.unwrap_or(86_400)),
        "failures" => failures(&c, now, args.since.unwrap_or(7 * 86_400), args.kind.as_deref()),
        "funnel" => funnel(&c, now, args.since.unwrap_or(7 * 86_400), args.path.as_deref()),
        "limits" => limits(&c, now),
        "usage" => usage(&c, now, args.since.unwrap_or(30 * 86_400), &args.by),
        "series" => match &args.metric {
            Some(m) => series(&c, now, args.since.unwrap_or(86_400), m, args.labels.as_deref()),
            None => Err("series needs a metric name".into()),
        },
        other => Err(format!("unknown query {other:?}\n{USAGE}")),
    };
    match out {
        Ok(Report { text, data }) => {
            if args.json {
                println!("{}", serde_json::to_string_pretty(&data).unwrap_or_default());
            } else {
                print!("{text}");
            }
            0
        }
        Err(e) => {
            eprintln!("mapcro-server stats: {e}");
            1
        }
    }
}

struct Report {
    text: String,
    data: Value,
}

type Res<T> = Result<T, String>;

fn q<T>(r: rusqlite::Result<T>) -> Res<T> {
    r.map_err(|e| format!("query failed: {e}"))
}

// ---- time ----

/// `2026-11-08` for a day number (days since 1970-01-01).
pub fn date(day: i64) -> String {
    // Howard Hinnant's civil_from_days.
    let z = day + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{m:02}-{d:02}", if m <= 2 { y + 1 } else { y })
}

/// `2026-11-08 14:05` UTC.
pub fn stamp(t: i64) -> String {
    let s = t.rem_euclid(86_400);
    format!("{} {:02}:{:02}", date(t.div_euclid(86_400)), s / 3600, s % 3600 / 60)
}

fn span(s: i64) -> String {
    match s {
        s if s % (7 * 86_400) == 0 => format!("{}w", s / (7 * 86_400)),
        s if s % 86_400 == 0 => format!("{}d", s / 86_400),
        s if s % 3600 == 0 => format!("{}h", s / 3600),
        s => format!("{}m", s / 60),
    }
}

// ---- formatting ----

fn bytes(b: f64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = b;
    let mut i = 0;
    while v >= 1000.0 && i < units.len() - 1 {
        v /= 1000.0;
        i += 1;
    }
    if i == 0 { format!("{v:.0} B") } else { format!("{v:.1} {}", units[i]) }
}

fn num(v: f64) -> String {
    // An empty float sum is -0.
    let v = if v == 0.0 { 0.0 } else { v };
    if (v.fract() == 0.0 && v.abs() < 1e15) || v.abs() >= 100.0 {
        format!("{v:.0}")
    } else if v.abs() >= 10.0 {
        format!("{v:.1}")
    } else {
        format!("{v:.2}")
    }
}

fn opt(v: Option<f64>) -> String {
    v.map(num).unwrap_or_else(|| "-".into())
}

/// `5 (prev 2)`, or `5 (new)` / `0` when nothing either side.
fn vs(now: f64, prev: f64) -> String {
    if prev == 0.0 && now == 0.0 {
        "0".into()
    } else {
        format!("{} (prev {})", num(now), num(prev))
    }
}

/// `label value` pairs, biggest first, as `a 3, b 1`; the labels' values only.
fn breakdown(m: &BTreeMap<String, f64>, keep: impl Fn(&str) -> bool) -> String {
    let mut v: Vec<(&String, &f64)> = m.iter().filter(|(k, n)| **n > 0.0 && keep(k)).collect();
    v.sort_by(|a, b| b.1.total_cmp(a.1));
    v.iter().map(|(k, n)| format!("{} {}", short(k), num(**n))).collect::<Vec<_>>().join(", ")
}

/// `route=match,status_class=5xx` → `match/5xx`.
fn short(labels: &str) -> String {
    if labels.is_empty() {
        return "all".into();
    }
    labels.split(',').map(|p| p.split_once('=').map_or(p, |(_, v)| v)).collect::<Vec<_>>().join("/")
}

fn label<'a>(labels: &'a str, key: &str) -> Option<&'a str> {
    labels.split(',').find_map(|p| p.split_once('=').filter(|(k, _)| *k == key).map(|(_, v)| v))
}

// ---- aggregates ----

/// A counter's total per label set over a window.
fn counter(c: &Connection, name: &str, since: i64, until: i64) -> Res<BTreeMap<String, f64>> {
    let mut m = BTreeMap::new();
    for r in q(db::rows(c, name, since, until))? {
        *m.entry(r.labels).or_insert(0.0) += r.value;
    }
    Ok(m)
}

fn total(m: &BTreeMap<String, f64>) -> f64 {
    m.values().sum()
}

/// A histogram merged over a window, per label set.
fn hist(c: &Connection, name: &str, since: i64, until: i64) -> Res<BTreeMap<String, Row>> {
    let mut m: BTreeMap<String, Row> = BTreeMap::new();
    for r in q(db::rows(c, name, since, until))? {
        match m.get_mut(&r.labels) {
            Some(h) => h.merge(&r),
            None => {
                m.insert(r.labels.clone(), r);
            }
        }
    }
    Ok(m)
}

/// Merge every label set of a histogram into one.
fn hist_all(h: &BTreeMap<String, Row>) -> Option<Row> {
    let mut it = h.values();
    let mut first = it.next()?.clone();
    for r in it {
        first.merge(r);
    }
    Some(first)
}

fn quantiles(r: &Row) -> Value {
    let b: Buckets = r.buckets.clone().unwrap_or_default();
    json!({
        "n": r.value,
        "mean": r.sum.map(|s| if r.value > 0.0 { s / r.value } else { 0.0 }),
        "p50": quantile(&b, 0.5),
        "p90": quantile(&b, 0.9),
        "p99": quantile(&b, 0.99),
    })
}

fn qtext(r: Option<&Row>) -> String {
    match r {
        Some(r) if r.value > 0.0 => {
            let b = r.buckets.clone().unwrap_or_default();
            format!("p50 {} p90 {} p99 {} (n={})", opt(quantile(&b, 0.5)), opt(quantile(&b, 0.9)), opt(quantile(&b, 0.99)), num(r.value))
        }
        _ => "no data".into(),
    }
}

/// A gauge's latest row per label set, and its peak over `[since, now)`.
fn gauge(c: &Connection, name: &str, since: i64, now: i64) -> Res<BTreeMap<String, (i64, f64, f64)>> {
    let mut m: BTreeMap<String, (i64, f64, f64)> = BTreeMap::new();
    for r in q(db::rows(c, name, since, now + 60))? {
        let peak = r.max.unwrap_or(r.value);
        let e = m.entry(r.labels.clone()).or_insert((r.t, r.value, peak));
        if r.t >= e.0 {
            e.0 = r.t;
            e.1 = r.value;
        }
        e.2 = e.2.max(peak);
    }
    Ok(m)
}

fn gauge1(c: &Connection, name: &str, since: i64, now: i64) -> Res<Option<(i64, f64, f64)>> {
    Ok(gauge(c, name, since, now)?.get("").copied())
}

// ---- queries ----

fn summary(c: &Connection, now: i64, len: i64) -> Res<Report> {
    let (since, prev) = (now - len, now - 2 * len);
    let mut t = String::new();
    use std::fmt::Write;
    let _ = writeln!(t, "mapcro stats summary · last {} ({} → {} UTC), vs the {} before", span(len), stamp(since), stamp(now), span(len));

    // Health.
    let http = counter(c, "http_requests", since, now)?;
    let http_p = counter(c, "http_requests", prev, since)?;
    let is5 = |k: &str| label(k, "status_class") == Some("5xx");
    let e5: f64 = http.iter().filter(|(k, _)| is5(k)).map(|(_, v)| v).sum();
    let e5p: f64 = http_p.iter().filter(|(k, _)| is5(k)).map(|(_, v)| v).sum();
    let fails = q(db::failures(c, since, now))?;
    let fails_p = q(db::failures(c, prev, since))?;
    let mut by_code: BTreeMap<String, f64> = BTreeMap::new();
    for f in &fails {
        *by_code.entry(format!("k={},c={}", f.kind, f.code)).or_insert(0.0) += 1.0;
    }
    let jobs = counter(c, "replay_jobs", since, now)?;
    let jobs_p = counter(c, "replay_jobs", prev, since)?;
    let failed = |m: &BTreeMap<String, f64>| m.iter().filter(|(k, _)| label(k, "outcome") != Some("done")).map(|(_, v)| v).sum::<f64>();
    let closes = counter(c, "ws_closes", since, now)?;
    let abnormal = |k: &str| !matches!(label(k, "reason"), Some("gone" | "outdated" | "shutting_down" | "revoked"));
    let rejected = counter(c, "ops_rejected", since, now)?;
    let rejected_p = counter(c, "ops_rejected", prev, since)?;
    let api = counter(c, "deadlock_api_calls", since, now)?;
    let api_p = counter(c, "deadlock_api_calls", prev, since)?;
    let trouble = |m: &BTreeMap<String, f64>| m.iter().filter(|(k, _)| !matches!(label(k, "result"), Some("ok" | "not_found"))).map(|(_, v)| v).sum::<f64>();
    let backoff = gauge1(c, "deadlock_api_backoff_s", since, now)?;
    let oom = gauge(c, "unit_oom_kills", since, now)?;
    let oom_now = gauge(c, "unit_oom_kills", prev, since)?;
    let pct = |a: f64, b: f64| if b > 0.0 { format!(" ({:.0}%)", 100.0 * a / b) } else { String::new() };

    let _ = writeln!(t, "\nHEALTH");
    let _ = writeln!(t, "  5xx answers         {}{}", vs(e5, e5p), sep(&breakdown(&http, is5)));
    let _ = writeln!(t, "  failures logged     {}{}", vs(fails.len() as f64, fails_p.len() as f64), sep(&breakdown(&by_code, |_| true)));
    let _ = writeln!(
        t,
        "  replay jobs failed  {}/{}{} (prev {}/{}){}",
        num(failed(&jobs)),
        num(total(&jobs)),
        pct(failed(&jobs), total(&jobs)),
        num(failed(&jobs_p)),
        num(total(&jobs_p)),
        sep(&breakdown(&jobs, |k| label(k, "outcome") != Some("done")))
    );
    let _ = writeln!(t, "  ws closes, abnormal {}{}", num(closes.iter().filter(|(k, _)| abnormal(k)).map(|(_, v)| v).sum()), sep(&breakdown(&closes, abnormal)));
    let _ = writeln!(t, "  ops rejected        {}{}", vs(total(&rejected), total(&rejected_p)), sep(&breakdown(&rejected, |_| true)));
    let _ = writeln!(
        t,
        "  deadlock-api        {} of {} calls in trouble (prev {} of {}){}; backoff peak {} s",
        num(trouble(&api)),
        num(total(&api)),
        num(trouble(&api_p)),
        num(total(&api_p)),
        sep(&breakdown(&api, |k| !matches!(label(k, "result"), Some("ok" | "not_found")))),
        backoff.map_or("-".into(), |b| num(b.2))
    );
    let oom_text: Vec<String> = oom
        .iter()
        .map(|(k, (_, v, _))| {
            let before = oom_now.get(k).map_or(0.0, |x| x.1);
            format!("{} {}{}", short(k), num(*v), if *v > before { " (new)" } else { "" })
        })
        .collect();
    let _ = writeln!(t, "  oom kills           {}", if oom_text.is_empty() { "no data".into() } else { oom_text.join(", ") });
    // The server's memory peak, split: its own (resident, and the cgroup's anon) against the
    // cgroup's, which counts page cache the kernel reclaims at the cap (TD-4).
    let peak = |name: &str, labels: &str| -> Res<Option<f64>> { Ok(gauge(c, name, since, now)?.get(labels).map(|x| x.2)) };
    let mem = [
        ("rss", peak("server_rss_peak_bytes", "")?),
        ("anon", peak("unit_memory_anon_bytes", "unit=mapcro")?),
        ("cgroup, cache included", peak("unit_memory_peak_bytes", "unit=mapcro")?),
    ];
    let _ = writeln!(t, "  server memory peak  {}", mem.iter().map(|(k, v)| format!("{k} {}", v.map_or("-".into(), bytes))).collect::<Vec<_>>().join(", "));

    // Usage.
    let users = q(db::daily_users(c, since.div_euclid(86_400), now.div_euclid(86_400) + 1))?;
    let opens = counter(c, "ws_opens", since, now)?;
    let opens_p = counter(c, "ws_opens", prev, since)?;
    let boards = counter(c, "boards_created", since, now)?;
    let boards_p = counter(c, "boards_created", prev, since)?;
    let matches = counter(c, "matches_opened", since, now)?;
    let matches_p = counter(c, "matches_opened", prev, since)?;
    let conns = gauge1(c, "connections_open", since, now)?;
    let rooms = gauge1(c, "rooms_open", since, now)?;
    let _ = writeln!(t, "\nUSAGE");
    let _ = writeln!(t, "  people a day        {}", if users.is_empty() { "no data".into() } else { users.iter().map(|(d, n)| format!("{} {n}", &date(*d)[5..])).collect::<Vec<_>>().join(", ") });
    let _ = writeln!(t, "  sockets opened      {}; peak at once {}", vs(total(&opens), total(&opens_p)), conns.map_or("-".into(), |x| num(x.2)));
    let _ = writeln!(t, "  boards created      {}{}; peak open {}", vs(total(&boards), total(&boards_p)), sep(&breakdown(&boards, |_| true)), rooms.map_or("-".into(), |x| num(x.2)));
    let _ = writeln!(t, "  matches opened      {}{}", vs(total(&matches), total(&matches_p)), sep(&breakdown(&matches, |_| true)));
    let feedback = counter(c, "feedback_sent", since, now)?;
    let feedback_p = counter(c, "feedback_sent", prev, since)?;
    let feedback_no = counter(c, "feedback_rejected", since, now)?;
    let _ = writeln!(t, "  feedback sent       {}; refused {}{}", vs(total(&feedback), total(&feedback_p)), num(total(&feedback_no)), sep(&breakdown(&feedback_no, |_| true)));

    // Speed.
    let ack = hist(c, "op_ack_ms", since, now)?;
    let ack_p = hist(c, "op_ack_ms", prev, since)?;
    let commit = hist(c, "commit_ms", since, now)?;
    let job = hist(c, "replay_job_s", since, now)?;
    let parse = hist(c, "parse_s", since, now)?;
    let wait = hist(c, "queue_wait_s", since, now)?;
    let presence = hist(c, "presence_bytes", since, now)?;
    let _ = writeln!(t, "\nSPEED");
    let _ = writeln!(t, "  op ack ms           {} | prev {}", qtext(ack.get("")), qtext(ack_p.get("")));
    let _ = writeln!(t, "  commit ms           {}", qtext(commit.get("")));
    for (k, r) in &job {
        let _ = writeln!(t, "  {:<20}{}", format!("job s, {}", label(k, "source").unwrap_or("?")), qtext(Some(r)));
    }
    let _ = writeln!(t, "  queue wait s        {}", qtext(wait.get("")));
    let _ = writeln!(t, "  parse s             {}", qtext(parse.get("")));
    let _ = writeln!(t, "  presence bytes      {}", qtext(presence.get("")));

    // Limits, one line.
    let lim = limits_data(c, now)?;
    let _ = writeln!(t, "\nLIMITS (now / cap; `stats limits` for peaks and trends)");
    let _ = writeln!(t, "  {}", lim.iter().map(|l| l.brief()).collect::<Vec<_>>().join(" · "));

    let data = json!({
        "window": { "since": since, "until": now, "previous_since": prev },
        "health": {
            "http_5xx": e5, "http_5xx_prev": e5p, "http": http, "http_prev": http_p,
            "failures": fails.len(), "failures_prev": fails_p.len(), "failures_by_kind_code": by_code,
            "replay_jobs": jobs, "replay_jobs_prev": jobs_p,
            "ws_closes": closes, "ops_rejected": rejected, "ops_rejected_prev": rejected_p,
            "deadlock_api_calls": api, "deadlock_api_calls_prev": api_p,
            "deadlock_api_backoff_peak_s": backoff.map(|b| b.2),
            "unit_oom_kills": oom.iter().map(|(k, v)| (k.clone(), v.1)).collect::<BTreeMap<_, _>>(),
            "server_memory_peak": mem.iter().map(|(k, v)| (k.to_string(), *v)).collect::<BTreeMap<_, _>>(),
        },
        "usage": {
            "daily_users": users.iter().map(|(d, n)| json!({ "day": date(*d), "users": n })).collect::<Vec<_>>(),
            "ws_opens": total(&opens), "ws_opens_prev": total(&opens_p),
            "connections_peak": conns.map(|x| x.2), "rooms_peak": rooms.map(|x| x.2),
            "boards_created": boards, "boards_created_prev": boards_p,
            "matches_opened": matches, "matches_opened_prev": matches_p,
            "feedback_sent": total(&feedback), "feedback_sent_prev": total(&feedback_p), "feedback_rejected": feedback_no,
        },
        "speed": {
            "op_ack_ms": ack.get("").map(quantiles), "op_ack_ms_prev": ack_p.get("").map(quantiles),
            "commit_ms": commit.get("").map(quantiles),
            "replay_job_s": job.iter().map(|(k, r)| (k.clone(), quantiles(r))).collect::<BTreeMap<_, _>>(),
            "queue_wait_s": wait.get("").map(quantiles), "parse_s": parse.get("").map(quantiles),
            "presence_bytes": presence.get("").map(quantiles),
        },
        "limits": lim.iter().map(Limit::json).collect::<Vec<_>>(),
    });
    Ok(Report { text: t, data })
}

fn sep(s: &str) -> String {
    if s.is_empty() { String::new() } else { format!("   {s}") }
}

fn failures(c: &Connection, now: i64, len: i64, kind: Option<&str>) -> Res<Report> {
    let rows = q(db::failures(c, now - len, now + 60))?;
    struct G {
        n: u64,
        first: i64,
        last: i64,
        builds: std::collections::BTreeSet<String>,
    }
    let mut groups: BTreeMap<(String, String, String), G> = BTreeMap::new();
    for r in rows.iter().filter(|r| kind.is_none_or(|k| r.kind == k)) {
        let g = groups.entry((r.kind.clone(), r.code.clone(), r.message.clone())).or_insert(G { n: 0, first: r.t, last: r.t, builds: Default::default() });
        g.n += 1;
        g.first = g.first.min(r.t);
        g.last = g.last.max(r.t);
        g.builds.insert(r.build.clone());
    }
    let mut v: Vec<_> = groups.into_iter().collect();
    v.sort_by(|a, b| b.1.n.cmp(&a.1.n).then(b.1.last.cmp(&a.1.last)));
    let mut t = format!("mapcro stats failures · last {}{} · {} rows in {} groups\n", span(len), kind.map(|k| format!(" · kind {k}")).unwrap_or_default(), v.iter().map(|g| g.1.n).sum::<u64>(), v.len());
    for ((k, code, msg), g) in &v {
        t += &format!("  {:>4}×  {k}/{code}  {msg}   first {} last {} build {}\n", g.n, stamp(g.first), stamp(g.last), g.builds.iter().cloned().collect::<Vec<_>>().join(","));
    }
    if v.is_empty() {
        t += "  nothing failed\n";
    }
    let data = json!(v.iter().map(|((k, code, msg), g)| json!({ "kind": k, "code": code, "message": msg, "count": g.n, "first": g.first, "last": g.last, "builds": g.builds })).collect::<Vec<_>>());
    Ok(Report { text: t, data })
}

fn funnel(c: &Connection, now: i64, len: i64, path: Option<&str>) -> Res<Report> {
    let since = (now - len).div_euclid(86_400) * 86_400;
    let mut t = format!("mapcro stats funnel · last {}{} · per day (UTC)\n", span(len), path.map(|p| format!(" · path {p}")).unwrap_or_default());
    let source = |p: Option<&str>| match p {
        Some("fetched") => Some("fetched"),
        Some("uploaded") => Some("uploaded"),
        _ => None,
    };
    let mut days = Vec::new();
    let mut d = since;
    while d < now {
        let pick = |m: BTreeMap<String, Row>, key: &str, want: Option<&str>| -> Option<Row> {
            let sel: BTreeMap<String, Row> = m.into_iter().filter(|(k, _)| want.is_none_or(|w| label(k, key) == Some(w))).collect();
            hist_all(&sel)
        };
        let usable = pick(hist(c, "match_to_usable_ms", d, d + 86_400)?, "path", path);
        let full = pick(hist(c, "match_to_full_ms", d, d + 86_400)?, "path", path);
        let job = if path == Some("cached") { None } else { pick(hist(c, "replay_job_s", d, d + 86_400)?, "source", source(path)) };
        let outcomes: BTreeMap<String, f64> = counter(c, "replay_jobs", d, d + 86_400)?.into_iter().filter(|(k, _)| source(path).is_none_or(|s| label(k, "source") == Some(s))).collect();
        t += &format!(
            "  {}  to usable {}\n              to full   {}\n              job (server) {}{}\n",
            date(d.div_euclid(86_400)),
            qtext(usable.as_ref()),
            qtext(full.as_ref()),
            qtext(job.as_ref()),
            sep(&breakdown(&outcomes, |_| true))
        );
        days.push(json!({
            "day": date(d.div_euclid(86_400)),
            "match_to_usable_ms": usable.as_ref().map(quantiles),
            "match_to_full_ms": full.as_ref().map(quantiles),
            "replay_job_s": job.as_ref().map(quantiles),
            "replay_jobs": outcomes,
        }));
        d += 86_400;
    }
    t += "  (to usable / to full come from the browser's beacons, spec §3; until they ship, the job line is what the server sees)\n";
    Ok(Report { text: t, data: json!({ "path": path, "days": days }) })
}

/// One resource against its cap.
struct Limit {
    name: &'static str,
    now: Option<f64>,
    cap: Option<f64>,
    peak: Option<f64>,
    /// The value a week ago (the oldest row in the last 7 days).
    week_ago: Option<f64>,
    bytes: bool,
}

impl Limit {
    fn fmt(&self, v: f64) -> String {
        if self.bytes { bytes(v) } else { num(v) }
    }
    fn brief(&self) -> String {
        match (self.now, self.cap) {
            (Some(n), Some(c)) => format!("{} {}/{}", self.name, self.fmt(n), self.fmt(c)),
            (Some(n), None) => format!("{} {}", self.name, self.fmt(n)),
            _ => format!("{} -", self.name),
        }
    }
    fn line(&self) -> String {
        let pct = match (self.now, self.cap) {
            (Some(n), Some(c)) if c > 0.0 => format!(" ({:.0}%)", 100.0 * n / c),
            _ => String::new(),
        };
        let trend = match (self.now, self.week_ago) {
            (Some(n), Some(w)) => format!("{}{}", if n >= w { "+" } else { "-" }, self.fmt((n - w).abs())),
            _ => "-".into(),
        };
        format!(
            "  {:<24} now {:<10} cap {:<10}{:<7} peak {:<10} 7d trend {}\n",
            self.name,
            self.now.map_or("-".into(), |v| self.fmt(v)),
            self.cap.map_or("-".into(), |v| self.fmt(v)),
            pct,
            self.peak.map_or("-".into(), |v| self.fmt(v)),
            trend
        )
    }
    fn json(&self) -> Value {
        json!({ "name": self.name, "now": self.now, "cap": self.cap, "peak_7d": self.peak, "week_ago": self.week_ago })
    }
}

fn limits_data(c: &Connection, now: i64) -> Res<Vec<Limit>> {
    let since = now - 7 * 86_400;
    let oldest = |name: &str, labels: &str| -> Res<Option<f64>> {
        Ok(q(db::rows(c, name, since, now + 60))?.into_iter().find(|r| r.labels == labels).map(|r| r.value))
    };
    let g = |name: &str, labels: &str| -> Res<(Option<f64>, Option<f64>)> {
        let m = gauge(c, name, since, now)?;
        Ok(m.get(labels).map_or((None, None), |x| (Some(x.1), Some(x.2))))
    };
    let mut out = Vec::new();
    let cap = |metric: &str, labels: &str| -> Res<Option<f64>> { Ok(gauge(c, metric, since, now)?.get(labels).map(|x| x.1)) };
    let disk_total = cap("disk_total_bytes", "")?;
    // Disk: how much is used of the filesystem.
    let free = gauge(c, "disk_free_bytes", since, now)?.get("").copied();
    let used_old = q(db::rows(c, "disk_free_bytes", since, now + 60))?.first().map(|r| r.value);
    out.push(Limit {
        name: "disk used",
        now: free.zip(disk_total).map(|(f, t)| t - f.1),
        cap: disk_total,
        // The least free is the most used.
        peak: disk_total.zip(q(db::rows(c, "disk_free_bytes", since, now + 60))?.iter().map(|r| r.value).reduce(f64::min)).map(|(t, f)| t - f),
        week_ago: disk_total.zip(used_old).map(|(t, f)| t - f),
        bytes: true,
    });
    let mut add = |name: &'static str, metric: &str, labels: &str, cap: Option<f64>, bytes: bool| -> Res<()> {
        let (n, peak) = g(metric, labels)?;
        out.push(Limit { name, now: n, cap, peak, week_ago: oldest(metric, labels)?, bytes });
        Ok(())
    };
    add("database", "db_bytes", "", cap("db_max_bytes", "")?, true)?;
    add("boards stored", "boards_stored", "", cap("boards_max", "")?, false)?;
    add("replay cache", "cache_bytes", "cache=replays", None, true)?;
    add("match cache", "cache_bytes", "cache=matches", None, true)?;
    add("queue bytes", "queue_bytes", "", cap("queue_max_bytes", "")?, true)?;
    add("queue waiting", "queue_waiting", "", cap("queue_max_waiting", "")?, false)?;
    for (name, unit) in [("memory, server", "unit=mapcro"), ("memory, worker", "unit=mapcro-replay")] {
        add(name, "unit_memory_bytes", unit, cap("unit_memory_max_bytes", unit)?, true)?;
    }
    // Memory that isn't page cache, which a cap can't reclaim (TD-4): the cgroup's anon, and the
    // server process's own peak resident memory each minute.
    for (name, unit) in [("memory anon, server", "unit=mapcro"), ("memory anon, worker", "unit=mapcro-replay")] {
        add(name, "unit_memory_anon_bytes", unit, cap("unit_memory_max_bytes", unit)?, true)?;
    }
    add("memory rss peak, server", "server_rss_peak_bytes", "", cap("unit_memory_max_bytes", "unit=mapcro")?, true)?;
    for (name, unit) in [("cpu cores, server", "unit=mapcro"), ("cpu cores, worker", "unit=mapcro-replay")] {
        add(name, "unit_cpu_cores", unit, None, false)?;
    }
    add("deadlock-api backoff s", "deadlock_api_backoff_s", "", None, false)?;
    Ok(out)
}

fn limits(c: &Connection, now: i64) -> Res<Report> {
    let l = limits_data(c, now)?;
    let mut t = String::from("mapcro stats limits · now against each cap, the 7-day peak and the change over 7 days\n");
    for x in &l {
        t += &x.line();
    }
    // deadlock-api's budget: calls in the last hour by endpoint. `salts_steam` is the one with a
    // budget (it spends it only for a match with no row: 3/h per address without a key, 300
    // with); free salts reads, stored rows and data: 100/s.
    let api = counter(c, "deadlock_api_calls", now - 3600, now + 60)?;
    let mut per: BTreeMap<String, f64> = BTreeMap::new();
    let mut limited: BTreeMap<String, f64> = BTreeMap::new();
    for (k, v) in &api {
        let e = label(k, "endpoint").unwrap_or("?").to_owned();
        *per.entry(e.clone()).or_insert(0.0) += v;
        if label(k, "result") == Some("rate_limited") {
            *limited.entry(e).or_insert(0.0) += v;
        }
    }
    t += &format!(
        "  deadlock-api, last hour  {}\n",
        if per.is_empty() { "no calls".into() } else { per.iter().map(|(e, n)| format!("{e} {} ({} rate limited)", num(*n), num(limited.get(e).copied().unwrap_or(0.0)))).collect::<Vec<_>>().join(", ") }
    );
    let oom = gauge(c, "unit_oom_kills", now - 7 * 86_400, now)?;
    t += &format!("  oom kills (since each unit's start)  {}\n", if oom.is_empty() { "no data".into() } else { breakdown(&oom.iter().map(|(k, v)| (k.clone(), v.1)).collect(), |_| true) });
    if t.lines().count() > 0 && l.iter().all(|x| x.now.is_none()) {
        t += "  (no gauges yet: the server writes its first snapshot a minute after it starts)\n";
    }
    let data = json!({ "limits": l.iter().map(Limit::json).collect::<Vec<_>>(), "deadlock_api_last_hour": api, "unit_oom_kills": oom.iter().map(|(k, v)| (k.clone(), v.1)).collect::<BTreeMap<_, _>>() });
    Ok(Report { text: t, data })
}

fn usage(c: &Connection, now: i64, len: i64, by: &str) -> Res<Report> {
    let step = if by == "week" { 7 * 86_400 } else { 86_400 };
    let start = (now - len).div_euclid(step) * step;
    let mut t = format!("mapcro stats usage · last {} by {by} (UTC)\n", span(len));
    t += "  period       people  sockets  boards(new/clone)  peak conns  matches (tier/path)\n";
    let mut rows = Vec::new();
    let mut p = start;
    while p < now {
        let end = p + step;
        let users = q(db::daily_users(c, p.div_euclid(86_400), end.div_euclid(86_400)))?;
        // A week's people is the busiest day's: days can't be linked (spec §5).
        let people = users.iter().map(|(_, n)| *n).max();
        let opens = total(&counter(c, "ws_opens", p, end)?);
        let boards = counter(c, "boards_created", p, end)?;
        let matches = counter(c, "matches_opened", p, end)?;
        let features = counter(c, "feature_used", p, end)?;
        let conns = gauge1(c, "connections_open", p, end)?.map(|x| x.2);
        let how = |h: &str| boards.get(&format!("how={h}")).copied().unwrap_or(0.0);
        t += &format!(
            "  {}  {:>6}  {:>7}  {:>8}/{:<8}  {:>10}  {}\n",
            date(p.div_euclid(86_400)),
            people.map_or("-".into(), |n| n.to_string()),
            num(opens),
            num(how("new")),
            num(how("clone")),
            conns.map_or("-".into(), num),
            breakdown(&matches, |_| true)
        );
        rows.push(json!({ "from": date(p.div_euclid(86_400)), "people": people, "daily_users": users, "ws_opens": opens, "boards_created": boards, "connections_peak": conns, "matches_opened": matches, "feature_used": features }));
        p = end;
    }
    if by == "week" {
        t += "  (a week's people is its busiest day: days are counted apart and can't be linked)\n";
    }
    Ok(Report { text: t, data: json!(rows) })
}

fn series(c: &Connection, now: i64, len: i64, name: &str, labels: Option<&str>) -> Res<Report> {
    let rows: Vec<Row> = q(db::rows(c, name, now - len, now + 60))?.into_iter().filter(|r| labels.is_none_or(|want| want.split(',').all(|p| r.labels.split(',').any(|x| x == p)))).collect();
    let mut t = format!("mapcro stats series {name} · last {} · {} rows\n", span(len), rows.len());
    if rows.is_empty() {
        let known = q(db::names(c))?;
        t += &format!("  no rows. Metrics with data: {}\n", known.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(", "));
    }
    let mut data = Vec::new();
    for r in &rows {
        let res = if r.res == 60 { "1m" } else { "1h" };
        let line = match r.kind {
            Kind::Counter => num(r.value),
            Kind::Gauge => format!("{} (max {})", num(r.value), opt(r.max)),
            Kind::Histogram => qtext(Some(r)),
        };
        t += &format!("  {} {res}  {:<28} {line}\n", stamp(r.t), if r.labels.is_empty() { "-" } else { &r.labels });
        data.push(json!({
            "t": r.t, "res": r.res, "labels": r.labels, "kind": r.kind.as_str(), "value": r.value, "sum": r.sum, "n": r.n, "max": r.max,
            "quantiles": (r.kind == Kind::Histogram).then(|| quantiles(r)), "buckets": r.buckets,
        }));
    }
    Ok(Report { text: t, data: json!(data) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_and_dates() {
        assert_eq!(parse_span("24h"), Some(86_400));
        assert_eq!(parse_span("7d"), Some(604_800));
        assert_eq!(parse_span("2w"), Some(1_209_600));
        assert_eq!(parse_span("15m"), Some(900));
        assert_eq!(parse_span("h"), None);
        assert_eq!(parse_span("0d"), None);
        assert_eq!(parse_span("3y"), None);
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(20_400), "2025-11-08");
        assert_eq!(date(11_016), "2000-02-29");
        assert_eq!(stamp(20_400 * 86_400 + 3600 + 120), "2025-11-08 01:02");
    }

    #[test]
    fn labels_read_back() {
        assert_eq!(label("route=match,status_class=5xx", "status_class"), Some("5xx"));
        assert_eq!(label("route=match", "nope"), None);
        assert_eq!(short("route=match,status_class=5xx"), "match/5xx");
    }
}
