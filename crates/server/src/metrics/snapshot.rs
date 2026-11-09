//! Minute snapshots: each minute, what changed (counters and histograms as deltas, gauges as
//! their value and peak) becomes rows in `metric_rows` (`db.rs`). Rows are per window, so a
//! restart loses at most the minute in progress, and totals are sums of rows.

use super::{Family, Kind, Value};
use std::collections::HashMap;

pub fn unix_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Rows are minutes (`MINUTE`) for 7 days, then hours (`HOUR`) for 400.
pub const MINUTE: i64 = 60;
pub const HOUR: i64 = 3600;

/// Sparse histogram buckets: `(lower, upper, count)`, upper `None` for +Inf.
pub type Buckets = Vec<(f64, Option<f64>, u64)>;

/// One metric cell over one window.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// The window's length: `MINUTE` or `HOUR`.
    pub res: i64,
    /// The window's start, unix seconds.
    pub t: i64,
    pub name: String,
    pub labels: String,
    pub kind: Kind,
    /// Counter: events in the window. Gauge: the mean of its samples. Histogram: observations.
    pub value: f64,
    /// Gauge: the samples' sum. Histogram: the observations' sum.
    pub sum: Option<f64>,
    /// Gauge: samples in the window.
    pub n: Option<i64>,
    /// Gauge: the highest it reached in the window.
    pub max: Option<f64>,
    /// Histogram only.
    pub buckets: Option<Buckets>,
}

impl Row {
    /// Fold `other` (the same cell, an overlapping or later window) into this one.
    pub fn merge(&mut self, other: &Row) {
        match self.kind {
            Kind::Counter => self.value += other.value,
            Kind::Gauge => {
                let sum = self.sum.unwrap_or(self.value) + other.sum.unwrap_or(other.value);
                let n = self.n.unwrap_or(1) + other.n.unwrap_or(1);
                self.sum = Some(sum);
                self.n = Some(n);
                self.value = sum / n as f64;
                self.max = Some(self.max.unwrap_or(self.value).max(other.max.unwrap_or(other.value)));
            }
            Kind::Histogram => {
                self.value += other.value;
                self.sum = Some(self.sum.unwrap_or(0.0) + other.sum.unwrap_or(0.0));
                let mut b = self.buckets.take().unwrap_or_default();
                for (lo, hi, n) in other.buckets.iter().flatten() {
                    match b.iter_mut().find(|x| x.0 == *lo && x.1 == *hi) {
                        Some(x) => x.2 += n,
                        None => b.push((*lo, *hi, *n)),
                    }
                }
                b.sort_by(|x, y| x.0.total_cmp(&y.0));
                self.buckets = Some(b);
            }
        }
    }
}

/// What the last snapshot saw, to turn running totals into a window's deltas.
#[derive(Default)]
pub struct Snapshotter {
    last: HashMap<(&'static str, String), Value>,
}

impl Snapshotter {
    /// The rows for the window starting at `t` (a minute). Counters and histograms that didn't
    /// move write nothing; every gauge that has a value writes its sample.
    pub fn rows(&mut self, families: &[&dyn Family], t: i64) -> Vec<Row> {
        let mut out = Vec::new();
        for f in families {
            for r in f.read(true) {
                let key = (f.name(), r.labels.clone());
                let prev = self.last.get(&key);
                let row = |value, sum, n, max, buckets| Row { res: MINUTE, t, name: f.name().to_owned(), labels: r.labels.clone(), kind: f.kind(), value, sum, n, max, buckets };
                match &r.value {
                    Value::Counter(now) => {
                        let before = match prev {
                            Some(Value::Counter(b)) => *b,
                            _ => 0,
                        };
                        let d = now.saturating_sub(before);
                        if d > 0 {
                            out.push(row(d as f64, None, None, None, None));
                        }
                    }
                    Value::Gauge { now, peak } => out.push(row(*now, Some(*now), Some(1), Some(*peak), None)),
                    Value::Histogram { bounds, buckets, count, sum } => {
                        let (pb, pc, ps) = match prev {
                            Some(Value::Histogram { buckets: b, count: c, sum: s, .. }) => (b.clone(), *c, *s),
                            _ => (vec![0; buckets.len()], 0, 0.0),
                        };
                        let dc = count.saturating_sub(pc);
                        if dc > 0 {
                            let db: Vec<u64> = buckets.iter().zip(pb.iter().chain(std::iter::repeat(&0))).map(|(a, b)| a.saturating_sub(*b)).collect();
                            out.push(row(dc as f64, Some(sum - ps), None, None, Some(super::sparse(bounds, &db))));
                        }
                    }
                }
                self.last.insert(key, r.value);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::{Counter, Gauge, Histogram};

    #[test]
    fn windows_hold_deltas_and_quiet_counters_write_nothing() {
        static B: [f64; 2] = [1.0, 10.0];
        let c: Counter<()> = Counter::new("c", "c");
        let g: Gauge<()> = Gauge::new("g", "g");
        let h: Histogram<()> = Histogram::new("h", "h", &B);
        let mut s = Snapshotter::default();
        c.add((), 3);
        g.set((), 5.0);
        g.set((), 2.0);
        h.observe((), 0.5);
        h.observe((), 5.0);
        let rows = s.rows(&[&c, &g, &h], 60);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].value, 3.0);
        assert_eq!((rows[1].value, rows[1].max), (2.0, Some(5.0)), "a gauge's value and its peak");
        assert_eq!(rows[2].buckets, Some(vec![(0.0, Some(1.0), 1), (1.0, Some(10.0), 1)]));
        c.add((), 1);
        h.observe((), 50.0);
        let rows = s.rows(&[&c, &g, &h], 120);
        assert_eq!(rows[0].value, 1.0, "the delta, not the total");
        assert_eq!((rows[1].value, rows[1].max), (2.0, Some(2.0)));
        assert_eq!(rows[2].buckets, Some(vec![(10.0, None, 1)]));
        assert_eq!(rows[2].sum, Some(50.0));
        let rows = s.rows(&[&c, &g, &h], 180);
        assert_eq!(rows.len(), 1, "only the gauge: nothing else moved");
    }

    #[test]
    fn merging_sums_counts_and_averages_gauges() {
        let base = Row { res: MINUTE, t: 0, name: "g".into(), labels: String::new(), kind: Kind::Gauge, value: 2.0, sum: Some(2.0), n: Some(1), max: Some(3.0), buckets: None };
        let mut a = base.clone();
        a.merge(&Row { value: 4.0, sum: Some(4.0), max: Some(9.0), ..base.clone() });
        assert_eq!((a.value, a.n, a.max), (3.0, Some(2), Some(9.0)));
        let h = Row { kind: Kind::Histogram, value: 2.0, sum: Some(3.0), n: None, max: None, buckets: Some(vec![(0.0, Some(1.0), 2)]), ..base.clone() };
        let mut b = h.clone();
        b.merge(&Row { value: 1.0, sum: Some(7.0), buckets: Some(vec![(5.0, None, 1)]), ..h.clone() });
        b.merge(&h);
        assert_eq!(b.value, 5.0);
        assert_eq!(b.sum, Some(13.0));
        assert_eq!(b.buckets, Some(vec![(0.0, Some(1.0), 4), (5.0, None, 1)]));
    }
}
