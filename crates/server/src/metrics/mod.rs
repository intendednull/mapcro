//! Observability (docs/specs/observability.md): a small in-process registry of counters, gauges
//! and fixed-bucket histograms, snapshotted to SQLite every minute and served as Prometheus text
//! on a loopback-only listener.
//!
//! Hand-rolled rather than the `metrics` crate: every label here is a Rust enum (spec §5, no
//! free text becomes a label), the snapshot needs to read every value back each minute, and the
//! whole thing is a few hundred lines with no new dependencies (journal
//! 2026-11-08-observability).
//!
//! **Adding a metric** is two steps, both in `catalog.rs`: a label enum if it needs one
//! (`label!`), and one line in `registry!`. Then record it at the call site, e.g. `metrics::get().boards_created.inc((How::New,))`. The spec's "Adding a
//! metric" section has the rules.

pub mod catalog;
pub mod db;
pub mod failures;
pub mod sample;
pub mod snapshot;
pub mod users;

pub use catalog::*;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;

/// The registry. Everything records through this.
pub fn get() -> &'static Metrics {
    static M: LazyLock<Metrics> = LazyLock::new(Metrics::new);
    &M
}

/// The collector's state between snapshots.
struct Collector {
    snap: snapshot::Snapshotter,
    cpu: sample::Cpu,
}

fn collector() -> &'static tokio::sync::Mutex<Collector> {
    static C: LazyLock<tokio::sync::Mutex<Collector>> =
        LazyLock::new(|| tokio::sync::Mutex::new(Collector { snap: Default::default(), cpu: Default::default() }));
    &C
}

/// Sample the gauges and write the window starting at `t` to the database.
async fn snapshot_to_db(app: &crate::AppState, t: i64) {
    let mut c = collector().lock().await;
    let Collector { snap, cpu } = &mut *c;
    sample::sample(app, cpu).await;
    let now = snapshot::unix_now();
    let failures = failures::take();
    let users = users::counts(now);
    if let Err(failures) = write_window(&app.store, snap, &get().families(), t, failures, users, now).await {
        failures::restore(failures);
    }
}

/// Write one window, then move the snapshotter on; if the write fails, leave it where it was
/// (the next window carries this one's deltas and peaks) and hand the failures back.
async fn write_window(
    store: &crate::store::Store,
    snap: &mut snapshot::Snapshotter,
    families: &[&dyn Family],
    t: i64,
    failures: Vec<failures::Failure>,
    users: Vec<(i64, u64)>,
    now: i64,
) -> Result<(), Vec<failures::Failure>> {
    let (rows, pending) = snap.rows(families, t);
    match store.write_metrics(rows, failures.clone(), users, now).await {
        Ok(()) => {
            snap.commit(pending);
            Ok(())
        }
        Err(e) => {
            tracing::warn!(error = %e, "metrics snapshot not written");
            snap.restore(pending);
            Err(failures)
        }
    }
}

/// Write a snapshot every minute, just after the minute ends, for the minute that ended.
/// `METRICS_EVERY_S` (tests) snapshots more often; each lands in its minute's row.
pub fn spawn(app: crate::AppState) {
    let every = std::env::var("METRICS_EVERY_S").ok().and_then(|v| v.parse::<u64>().ok()).filter(|s| (1..60).contains(s));
    tokio::spawn(async move {
        loop {
            let now = snapshot::unix_now();
            let wait = match every {
                Some(s) => s,
                None => ((now.div_euclid(snapshot::MINUTE) + 1) * snapshot::MINUTE - now) as u64 + 1,
            };
            tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
            let t = (snapshot::unix_now() - 1).div_euclid(snapshot::MINUTE) * snapshot::MINUTE;
            snapshot_to_db(&app, t).await;
        }
    });
}

/// On shutdown: write the minute in progress (a restart within it merges into the same row).
pub async fn flush(app: &crate::AppState) {
    let now = snapshot::unix_now();
    snapshot_to_db(app, now.div_euclid(snapshot::MINUTE) * snapshot::MINUTE).await;
}

/// `GET /metrics` on the loopback-only listener (`METRICS_ADDR`): never on the public one.
pub async fn serve(app: crate::AppState, addr: std::net::SocketAddr) {
    use axum::routing::get as route_get;
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(%addr, error = %e, "metrics listener not bound; /metrics is off");
            return;
        }
    };
    tracing::info!(%addr, "metrics listening");
    let router = axum::Router::new().route(
        "/metrics",
        route_get(|axum::extract::State(app): axum::extract::State<crate::AppState>| async move {
            {
                let mut c = collector().lock().await;
                sample::sample(&app, &mut c.cpu).await;
            }
            ([(axum::http::header::CONTENT_TYPE, "text/plain; version=0.0.4")], render(&get().families()))
        }),
    );
    if let Err(e) = axum::serve(listener, router.with_state(app)).await {
        tracing::error!(error = %e, "metrics listener failed");
    }
}

/// A fixed set of label values: an enum made with `label!`.
pub trait Label: Copy + Send + Sync + 'static {
    /// The label's name, e.g. `route`.
    const KEY: &'static str;
    /// Every value, in declaration order.
    const ALL: &'static [Self];
    fn as_str(self) -> &'static str;
    fn index(self) -> usize;
}

/// Declare a label enum: its name in metrics, and each variant's value.
///
/// ```ignore
/// label! { pub enum How: "how" { New => "new", Clone => "clone" } }
/// ```
#[macro_export]
macro_rules! label {
    ($(#[$m:meta])* $vis:vis enum $name:ident : $key:literal { $($(#[$vm:meta])* $var:ident => $s:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        $vis enum $name { $($(#[$vm])* $var),+ }
        impl $crate::metrics::Label for $name {
            const KEY: &'static str = $key;
            const ALL: &'static [Self] = &[$(Self::$var),+];
            fn as_str(self) -> &'static str { match self { $(Self::$var => $s),+ } }
            fn index(self) -> usize { self as usize }
        }
    };
}

/// A metric's label set: `()`, `(A,)` or `(A, B)` of `Label`s. Each combination is one cell.
pub trait Labels: Copy + Send + Sync + 'static {
    fn keys() -> Vec<&'static str>;
    fn cells() -> usize;
    fn index(self) -> usize;
    /// The values of cell `i`.
    fn values(i: usize) -> Vec<&'static str>;
}

impl Labels for () {
    fn keys() -> Vec<&'static str> {
        Vec::new()
    }
    fn cells() -> usize {
        1
    }
    fn index(self) -> usize {
        0
    }
    fn values(_: usize) -> Vec<&'static str> {
        Vec::new()
    }
}

impl<A: Label> Labels for (A,) {
    fn keys() -> Vec<&'static str> {
        vec![A::KEY]
    }
    fn cells() -> usize {
        A::ALL.len()
    }
    fn index(self) -> usize {
        self.0.index()
    }
    fn values(i: usize) -> Vec<&'static str> {
        vec![A::ALL[i].as_str()]
    }
}

impl<A: Label, B: Label> Labels for (A, B) {
    fn keys() -> Vec<&'static str> {
        vec![A::KEY, B::KEY]
    }
    fn cells() -> usize {
        A::ALL.len() * B::ALL.len()
    }
    fn index(self) -> usize {
        self.0.index() * B::ALL.len() + self.1.index()
    }
    fn values(i: usize) -> Vec<&'static str> {
        vec![A::ALL[i / B::ALL.len()].as_str(), B::ALL[i % B::ALL.len()].as_str()]
    }
}

/// `route=api_match,status_class=2xx`: a cell's labels as stored, from the enums only.
fn label_string<L: Labels>(i: usize) -> String {
    L::keys().iter().zip(L::values(i)).map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(",")
}

fn add_f64(cell: &AtomicU64, d: f64) {
    let _ = cell.try_update(Ordering::Relaxed, Ordering::Relaxed, |b| Some((f64::from_bits(b) + d).to_bits()));
}

fn max_f64(cell: &AtomicU64, v: f64) {
    let _ = cell.try_update(Ordering::Relaxed, Ordering::Relaxed, |b| {
        let cur = f64::from_bits(b);
        (cur.is_nan() || v > cur).then_some(v.to_bits())
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Counter,
    Gauge,
    Histogram,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Counter => "counter",
            Kind::Gauge => "gauge",
            Kind::Histogram => "histogram",
        }
    }
}

/// One cell's value as read.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// Total since start.
    Counter(u64),
    /// Now, and the highest since the last snapshot.
    Gauge { now: f64, peak: f64 },
    /// Per-bucket counts (the last is +Inf), their total and the sum of observations.
    Histogram { bounds: &'static [f64], buckets: Vec<u64>, count: u64, sum: f64 },
}

/// One cell of a family, read.
#[derive(Clone, Debug)]
pub struct Reading {
    pub labels: String,
    pub pairs: Vec<(&'static str, &'static str)>,
    pub value: Value,
}

/// What every metric is, for the exporter and the snapshot.
pub trait Family: Sync {
    fn name(&self) -> &'static str;
    fn help(&self) -> &'static str;
    fn kind(&self) -> Kind;
    /// Every cell with a value (a gauge never set is left out). `take_peaks` restarts gauges'
    /// highs from their current value (the snapshot does; a scrape doesn't).
    fn read(&self, take_peaks: bool) -> Vec<Reading>;
}

fn pairs<L: Labels>(i: usize) -> Vec<(&'static str, &'static str)> {
    L::keys().into_iter().zip(L::values(i)).collect()
}

/// A count of events. Only goes up.
pub struct Counter<L: Labels> {
    name: &'static str,
    help: &'static str,
    cells: Vec<AtomicU64>,
    _l: std::marker::PhantomData<L>,
}

impl<L: Labels> Counter<L> {
    pub fn new(name: &'static str, help: &'static str) -> Self {
        Counter { name, help, cells: (0..L::cells()).map(|_| AtomicU64::new(0)).collect(), _l: Default::default() }
    }
    pub fn inc(&self, l: L) {
        self.add(l, 1);
    }
    pub fn add(&self, l: L, n: u64) {
        self.cells[l.index()].fetch_add(n, Ordering::Relaxed);
    }
}

impl<L: Labels> Family for Counter<L> {
    fn name(&self) -> &'static str {
        self.name
    }
    fn help(&self) -> &'static str {
        self.help
    }
    fn kind(&self) -> Kind {
        Kind::Counter
    }
    fn read(&self, _: bool) -> Vec<Reading> {
        self.cells
            .iter()
            .enumerate()
            .map(|(i, c)| Reading { labels: label_string::<L>(i), pairs: pairs::<L>(i), value: Value::Counter(c.load(Ordering::Relaxed)) })
            .collect()
    }
}

/// A value now (rooms open, bytes free). Keeps its high since the last snapshot, so a minute's
/// peak isn't lost between samples.
pub struct Gauge<L: Labels> {
    name: &'static str,
    help: &'static str,
    now: Vec<AtomicU64>,
    peak: Vec<AtomicU64>,
    _l: std::marker::PhantomData<L>,
}

impl<L: Labels> Gauge<L> {
    pub fn new(name: &'static str, help: &'static str) -> Self {
        let unset = || AtomicU64::new(f64::NAN.to_bits());
        Gauge { name, help, now: (0..L::cells()).map(|_| unset()).collect(), peak: (0..L::cells()).map(|_| unset()).collect(), _l: Default::default() }
    }
    pub fn set(&self, l: L, v: f64) {
        let i = l.index();
        self.now[i].store(v.to_bits(), Ordering::Relaxed);
        max_f64(&self.peak[i], v);
    }
    /// Add `d` (negative to take away); an unset gauge starts from 0.
    pub fn add(&self, l: L, d: f64) {
        let i = l.index();
        let _ = self.now[i].try_update(Ordering::Relaxed, Ordering::Relaxed, |b| {
            let cur = f64::from_bits(b);
            Some(((if cur.is_nan() { 0.0 } else { cur }) + d).to_bits())
        });
        max_f64(&self.peak[i], f64::from_bits(self.now[i].load(Ordering::Relaxed)));
    }
}

impl<L: Labels> Family for Gauge<L> {
    fn name(&self) -> &'static str {
        self.name
    }
    fn help(&self) -> &'static str {
        self.help
    }
    fn kind(&self) -> Kind {
        Kind::Gauge
    }
    fn read(&self, take_peaks: bool) -> Vec<Reading> {
        (0..L::cells())
            .filter_map(|i| {
                let now = f64::from_bits(self.now[i].load(Ordering::Relaxed));
                if now.is_nan() {
                    return None;
                }
                let peak = if take_peaks { f64::from_bits(self.peak[i].swap(now.to_bits(), Ordering::Relaxed)) } else { f64::from_bits(self.peak[i].load(Ordering::Relaxed)) };
                Some(Reading { labels: label_string::<L>(i), pairs: pairs::<L>(i), value: Value::Gauge { now, peak: if peak.is_nan() { now } else { peak.max(now) } } })
            })
            .collect()
    }
}

/// Durations and sizes, in fixed buckets (upper bounds, inclusive; one more for +Inf).
pub struct Histogram<L: Labels> {
    name: &'static str,
    help: &'static str,
    bounds: &'static [f64],
    cells: Vec<HistCell>,
    _l: std::marker::PhantomData<L>,
}

struct HistCell {
    buckets: Vec<AtomicU64>,
    count: AtomicU64,
    sum: AtomicU64,
}

/// The bucket an observation falls in: the first bound it doesn't exceed, else +Inf.
pub fn bucket_of(bounds: &[f64], v: f64) -> usize {
    bounds.iter().position(|b| v <= *b).unwrap_or(bounds.len())
}

impl<L: Labels> Histogram<L> {
    pub fn new(name: &'static str, help: &'static str, bounds: &'static [f64]) -> Self {
        debug_assert!(bounds.windows(2).all(|w| w[0] < w[1]), "{name}: bounds must increase");
        let cell = || HistCell { buckets: (0..=bounds.len()).map(|_| AtomicU64::new(0)).collect(), count: AtomicU64::new(0), sum: AtomicU64::new(0f64.to_bits()) };
        Histogram { name, help, bounds, cells: (0..L::cells()).map(|_| cell()).collect(), _l: Default::default() }
    }
    pub fn observe(&self, l: L, v: f64) {
        if !v.is_finite() {
            return;
        }
        let c = &self.cells[l.index()];
        c.buckets[bucket_of(self.bounds, v)].fetch_add(1, Ordering::Relaxed);
        c.count.fetch_add(1, Ordering::Relaxed);
        add_f64(&c.sum, v);
    }
    /// Observe the time since `start`, in milliseconds.
    pub fn observe_ms(&self, l: L, start: std::time::Instant) {
        self.observe(l, start.elapsed().as_secs_f64() * 1000.0);
    }
}

impl<L: Labels> Family for Histogram<L> {
    fn name(&self) -> &'static str {
        self.name
    }
    fn help(&self) -> &'static str {
        self.help
    }
    fn kind(&self) -> Kind {
        Kind::Histogram
    }
    fn read(&self, _: bool) -> Vec<Reading> {
        self.cells
            .iter()
            .enumerate()
            .map(|(i, c)| Reading {
                labels: label_string::<L>(i),
                pairs: pairs::<L>(i),
                value: Value::Histogram {
                    bounds: self.bounds,
                    buckets: c.buckets.iter().map(|b| b.load(Ordering::Relaxed)).collect(),
                    count: c.count.load(Ordering::Relaxed),
                    sum: f64::from_bits(c.sum.load(Ordering::Relaxed)),
                },
            })
            .collect()
    }
}

/// The `q` quantile (0..1) of sparse buckets `(lower, upper, count)` (upper `None` is +Inf),
/// interpolated linearly within its bucket, as Prometheus does. A quantile in the +Inf bucket
/// is that bucket's lower bound. `None` when there are no observations.
pub fn quantile(buckets: &[(f64, Option<f64>, u64)], q: f64) -> Option<f64> {
    let mut b: Vec<_> = buckets.iter().filter(|x| x.2 > 0).copied().collect();
    b.sort_by(|x, y| x.0.total_cmp(&y.0));
    let total: u64 = b.iter().map(|x| x.2).sum();
    if total == 0 {
        return None;
    }
    let rank = q.clamp(0.0, 1.0) * total as f64;
    let mut seen = 0u64;
    for (lo, hi, n) in &b {
        if (seen + n) as f64 >= rank {
            let Some(hi) = hi else { return Some(*lo) };
            let within = (rank - seen as f64) / *n as f64;
            return Some(lo + (hi - lo) * within);
        }
        seen += n;
    }
    b.last().map(|x| x.1.unwrap_or(x.0))
}

/// Dense bucket counts as sparse `(lower, upper, count)`, empty buckets left out.
pub fn sparse(bounds: &[f64], buckets: &[u64]) -> Vec<(f64, Option<f64>, u64)> {
    buckets
        .iter()
        .enumerate()
        .filter(|(_, n)| **n > 0)
        .map(|(i, n)| (if i == 0 { 0.0 } else { bounds[i - 1] }, bounds.get(i).copied(), *n))
        .collect()
}

fn prom_f64(v: f64) -> String {
    if v.is_infinite() {
        if v > 0.0 { "+Inf".into() } else { "-Inf".into() }
    } else {
        format!("{v}")
    }
}

fn prom_labels(pairs: &[(&str, &str)], extra: Option<(&str, String)>) -> String {
    let mut all: Vec<String> = pairs.iter().map(|(k, v)| format!("{k}=\"{v}\"")).collect();
    if let Some((k, v)) = extra {
        all.push(format!("{k}=\"{v}\""));
    }
    if all.is_empty() { String::new() } else { format!("{{{}}}", all.join(",")) }
}

/// Every family in the Prometheus text format (0.0.4). Names get a `mapcro_` prefix, counters a
/// `_total` suffix. Label values come from the enums, so none needs escaping.
pub fn render(families: &[&dyn Family]) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    for f in families {
        let name = match f.kind() {
            Kind::Counter => format!("mapcro_{}_total", f.name()),
            _ => format!("mapcro_{}", f.name()),
        };
        let _ = writeln!(out, "# HELP {name} {}", f.help());
        let _ = writeln!(out, "# TYPE {name} {}", f.kind().as_str());
        for r in f.read(false) {
            match &r.value {
                Value::Counter(n) => {
                    let _ = writeln!(out, "{name}{} {n}", prom_labels(&r.pairs, None));
                }
                Value::Gauge { now, .. } => {
                    let _ = writeln!(out, "{name}{} {}", prom_labels(&r.pairs, None), prom_f64(*now));
                }
                Value::Histogram { bounds, buckets, count, sum } => {
                    let mut cum = 0;
                    for (i, n) in buckets.iter().enumerate() {
                        cum += n;
                        let le = bounds.get(i).copied().unwrap_or(f64::INFINITY);
                        let _ = writeln!(out, "{name}_bucket{} {cum}", prom_labels(&r.pairs, Some(("le", prom_f64(le)))));
                    }
                    let _ = writeln!(out, "{name}_sum{} {}", prom_labels(&r.pairs, None), prom_f64(*sum));
                    let _ = writeln!(out, "{name}_count{} {count}", prom_labels(&r.pairs, None));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    crate::label! { enum Colour: "colour" { Red => "red", Blue => "blue" } }
    crate::label! { enum Size: "size" { S => "s", M => "m", L => "l" } }

    #[test]
    fn label_tuples_index_every_cell_once() {
        let mut seen = std::collections::HashSet::new();
        for c in Colour::ALL {
            for s in Size::ALL {
                let i = (*c, *s).index();
                assert!(seen.insert(i));
                assert_eq!(<(Colour, Size)>::values(i), vec![c.as_str(), s.as_str()]);
            }
        }
        assert_eq!(seen.len(), <(Colour, Size)>::cells());
        assert_eq!(label_string::<(Colour, Size)>((Colour::Blue, Size::M).index()), "colour=blue,size=m");
    }

    #[test]
    fn buckets_take_the_first_bound_not_exceeded() {
        let b = [1.0, 5.0, 10.0];
        assert_eq!(bucket_of(&b, 0.2), 0);
        assert_eq!(bucket_of(&b, 1.0), 0, "upper bounds are inclusive");
        assert_eq!(bucket_of(&b, 1.01), 1);
        assert_eq!(bucket_of(&b, 10.0), 2);
        assert_eq!(bucket_of(&b, 11.0), 3, "past the last bound is +Inf");
        static B: [f64; 3] = [1.0, 5.0, 10.0];
        let h: Histogram<()> = Histogram::new("t", "t", &B);
        for v in [0.5, 2.0, 3.0, 50.0] {
            h.observe((), v);
        }
        h.observe((), f64::NAN);
        let Value::Histogram { buckets, count, sum, .. } = &h.read(false)[0].value else { panic!() };
        assert_eq!(buckets, &vec![1, 2, 0, 1]);
        assert_eq!(*count, 4, "NaN is not observed");
        assert_eq!(*sum, 55.5);
    }

    #[test]
    fn quantiles_interpolate_within_the_bucket() {
        // 10 in (0, 10], 10 in (10, 20]: the median is at the boundary, p75 halfway up the second.
        let b = vec![(0.0, Some(10.0), 10), (10.0, Some(20.0), 10)];
        assert_eq!(quantile(&b, 0.5), Some(10.0));
        assert_eq!(quantile(&b, 0.75), Some(15.0));
        assert_eq!(quantile(&b, 0.25), Some(5.0));
        // In +Inf: its lower bound.
        let inf = vec![(0.0, Some(10.0), 1), (10.0, None, 9)];
        assert_eq!(quantile(&inf, 0.9), Some(10.0));
        assert_eq!(quantile(&[], 0.5), None);
        // Sparse buckets keep their own lower bounds, not the previous non-empty one.
        static B: [f64; 4] = [1.0, 2.0, 5.0, 10.0];
        let s = sparse(&B, &[0, 0, 4, 0, 0]);
        assert_eq!(s, vec![(2.0, Some(5.0), 4)]);
        assert_eq!(quantile(&s, 0.5), Some(3.5));
    }

    #[test]
    fn a_failed_snapshot_write_lands_in_the_next_minute() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("db.sqlite");
        let store = crate::store::Store::open(&path).expect("store");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
        let c: Counter<()> = Counter::new("c", "c");
        let g: Gauge<()> = Gauge::new("g", "g");
        let mut snap = snapshot::Snapshotter::default();
        let fams: [&dyn Family; 2] = [&c, &g];
        let failure = failures::Failure { t: 60, kind: "http", code: "x", message: "m".into() };
        c.add((), 3);
        g.set((), 9.0);
        g.set((), 1.0);
        // Minute 60's write fails: its table is gone.
        let raw = rusqlite::Connection::open(&path).expect("raw");
        raw.execute_batch("DROP TABLE metric_rows").expect("drop");
        let back = rt.block_on(write_window(&store, &mut snap, &fams, 60, vec![failure.clone()], vec![], 100));
        assert_eq!(back, Err(vec![failure]), "the failures come back to be restored");
        raw.execute_batch(db::SCHEMA).expect("table back");
        c.add((), 2);
        rt.block_on(write_window(&store, &mut snap, &fams, 120, vec![], vec![], 160)).expect("minute 120 written");
        let counter = db::rows(&raw, "c", 0, 1000).expect("rows");
        assert_eq!(counter.iter().map(|r| (r.t, r.value)).collect::<Vec<_>>(), [(120, 5.0)], "minute 60's 3 carried into 120");
        let gauge = db::rows(&raw, "g", 0, 1000).expect("rows");
        assert_eq!(gauge.iter().map(|r| (r.t, r.max)).collect::<Vec<_>>(), [(120, Some(9.0))], "and its peak");
        // Once written, the baseline moves on and the held peak is spent.
        c.add((), 1);
        rt.block_on(write_window(&store, &mut snap, &fams, 180, vec![], vec![], 220)).expect("minute 180 written");
        let counter = db::rows(&raw, "c", 180, 1000).expect("rows");
        assert_eq!(counter.iter().map(|r| r.value).collect::<Vec<_>>(), [1.0]);
        let gauge = db::rows(&raw, "g", 180, 1000).expect("rows");
        assert_eq!(gauge.iter().map(|r| r.max).collect::<Vec<_>>(), [Some(1.0)]);
    }

    #[test]
    fn gauges_keep_their_peak_until_taken() {
        let g: Gauge<()> = Gauge::new("g", "g");
        assert!(g.read(false).is_empty(), "never set: not reported");
        g.add((), 1.0);
        g.add((), 4.0);
        g.add((), -3.0);
        assert_eq!(g.read(true)[0].value, Value::Gauge { now: 2.0, peak: 5.0 });
        assert_eq!(g.read(true)[0].value, Value::Gauge { now: 2.0, peak: 2.0 }, "the peak restarts at now");
    }

    #[test]
    fn prometheus_text_has_cumulative_buckets_and_no_free_text() {
        static B: [f64; 2] = [1.0, 2.0];
        let c: Counter<(Colour,)> = Counter::new("hits", "Hits.");
        c.inc((Colour::Blue,));
        let h: Histogram<()> = Histogram::new("lat_ms", "Latency.", &B);
        h.observe((), 0.5);
        h.observe((), 1.5);
        let text = render(&[&c, &h]);
        assert!(text.contains("mapcro_hits_total{colour=\"blue\"} 1\n"), "{text}");
        assert!(text.contains("mapcro_hits_total{colour=\"red\"} 0\n"));
        assert!(text.contains("mapcro_lat_ms_bucket{le=\"1\"} 1\n"));
        assert!(text.contains("mapcro_lat_ms_bucket{le=\"2\"} 2\n"));
        assert!(text.contains("mapcro_lat_ms_bucket{le=\"+Inf\"} 2\n"));
        assert!(text.contains("mapcro_lat_ms_count 2\n"));
    }
}
