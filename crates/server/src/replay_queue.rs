//! The replay queue's order, admission and estimates (spec §6a, "The queue"): pure, so fairness,
//! the budgets and the wait are tested apart from HTTP and the files (`replays.rs` holds the
//! state and calls these).
//!
//! - **Fair:** round-robin across clients. A client's k-th job, counting the ones it already has
//!   further along, is in round k; rounds go in order, and arrival order within one. So one
//!   client with many jobs can't keep another's first one waiting behind them.
//! - **The line:** transfers wait for room in it, uploads (as reservations) and fetches alike,
//!   in that fair order. Each that starts takes its bytes and a job from the queue's budget and
//!   a slot of its kind.
//! - **The parse order:** queued files in the same fair order, which the worker follows.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Instant;

/// Who a job is for, for fairness: the client that asked (its address key), or the job itself
/// when the server doesn't know (a file queued before a restart).
pub type Client = String;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// A reservation for an upload: when it starts, the client may send its file.
    Upload,
    /// A fetch from Valve's CDN waiting to download.
    Fetch,
}

/// A transfer waiting in line.
#[derive(Clone, Debug)]
pub struct Waiting {
    pub job: String,
    pub client: Client,
    pub kind: Kind,
    /// Arrival order.
    pub seq: u64,
    /// What it will hold on disk: an upload's declared size, a fetch's cap.
    pub bytes: u64,
    /// Last asked about by its client (a reservation lapses without it).
    pub touched: Instant,
}

/// The fair order of `items` (indices into it): `key` gives each one's client and arrival, and
/// `prior` how many jobs each client already has further along.
pub fn fair<T>(items: &[T], key: impl Fn(&T) -> (&str, u64), prior: &HashMap<Client, usize>) -> Vec<usize> {
    let mut by_arrival: Vec<usize> = (0..items.len()).collect();
    by_arrival.sort_by_key(|&i| key(&items[i]).1);
    let mut seen: HashMap<&str, usize> = HashMap::new();
    let mut ranked: Vec<(usize, u64, usize)> = by_arrival
        .into_iter()
        .map(|i| {
            let (client, seq) = key(&items[i]);
            let n = seen.entry(client).or_insert_with(|| prior.get(client).copied().unwrap_or(0));
            let round = *n;
            *n += 1;
            (round, seq, i)
        })
        .collect();
    ranked.sort_unstable();
    ranked.into_iter().map(|(_, _, i)| i).collect()
}

/// What's free for transfers to start.
#[derive(Clone, Copy, Debug)]
pub struct Room {
    pub bytes: u64,
    pub jobs: usize,
    pub uploads: usize,
    pub downloads: usize,
}

/// Which of `line` start now (indices), walking `order`. Each takes its bytes and a job from the
/// room and a slot of its kind. One that only lacks a slot of its kind, or whose client is
/// uploading already (one upload at a time each), is passed over; one the bytes or jobs left
/// can't hold stops the walk, so a large upload isn't starved by smaller ones behind it.
pub fn admit(line: &[Waiting], order: &[usize], mut room: Room, uploading: &HashSet<Client>) -> Vec<usize> {
    let mut start = Vec::new();
    let mut busy: HashSet<&str> = uploading.iter().map(String::as_str).collect();
    for &i in order {
        let w = &line[i];
        let slot = match w.kind {
            Kind::Upload => room.uploads > 0 && !busy.contains(w.client.as_str()),
            Kind::Fetch => room.downloads > 0,
        };
        if !slot {
            continue;
        }
        if room.jobs == 0 || w.bytes > room.bytes {
            break;
        }
        room.jobs -= 1;
        room.bytes -= w.bytes;
        match w.kind {
            Kind::Upload => {
                room.uploads -= 1;
                busy.insert(&w.client);
            }
            Kind::Fetch => room.downloads -= 1,
        }
        start.push(i);
    }
    start
}

/// Reservations nobody has asked about within `ttl` (their client went away): their indices.
pub fn lapsed(line: &[Waiting], now: Instant, ttl: std::time::Duration) -> Vec<usize> {
    line.iter().enumerate().filter(|(_, w)| w.kind == Kind::Upload && now.saturating_duration_since(w.touched) >= ttl).map(|(i, _)| i).collect()
}

/// How many samples make an estimate worth showing.
pub const MIN_SAMPLES: usize = 3;
const KEEP: usize = 20;

/// Recent parse and download times, in seconds.
#[derive(Default)]
pub struct Stats {
    parse: VecDeque<f64>,
    download: VecDeque<f64>,
}

fn push(v: &mut VecDeque<f64>, s: f64) {
    if v.len() == KEEP {
        v.pop_front();
    }
    v.push_back(s);
}

fn mean(v: &VecDeque<f64>) -> Option<f64> {
    (v.len() >= MIN_SAMPLES).then(|| v.iter().sum::<f64>() / v.len() as f64)
}

impl Stats {
    pub fn parsed(&mut self, secs: f64) {
        push(&mut self.parse, secs);
    }
    pub fn downloaded(&mut self, secs: f64) {
        push(&mut self.download, secs);
    }
    pub fn parse_mean(&self) -> Option<f64> {
        mean(&self.parse)
    }
    pub fn download_mean(&self) -> Option<f64> {
        mean(&self.download)
    }
}

/// Seconds until a queued job's timeline is ready, with `ahead` jobs before it (those parsing
/// included) and `workers` parsing at once: the rounds before its own, then its own.
pub fn parse_eta(ahead: usize, workers: usize, parse: f64) -> u64 {
    ((ahead / workers.max(1) + 1) as f64 * parse).ceil() as u64
}

/// Seconds until a fetch waiting in line is ready: its download's turn and the download, then
/// the parse behind the `queued` jobs already waiting for one.
pub fn fetch_eta(ahead: usize, downloads: usize, download: f64, queued: usize, workers: usize, parse: f64) -> u64 {
    ((ahead / downloads.max(1) + 1) as f64 * download).ceil() as u64 + parse_eta(queued, workers, parse)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn w(job: &str, client: &str, kind: Kind, seq: u64, bytes: u64) -> Waiting {
        Waiting { job: job.into(), client: client.into(), kind, seq, bytes, touched: Instant::now() }
    }

    fn jobs(line: &[Waiting], idx: &[usize]) -> Vec<String> {
        idx.iter().map(|&i| line[i].job.clone()).collect()
    }

    fn order(line: &[Waiting], prior: &HashMap<Client, usize>) -> Vec<String> {
        jobs(line, &fair(line, |w| (w.client.as_str(), w.seq), prior))
    }

    #[test]
    fn clients_take_turns() {
        // A asked for four first; B and C each for one later.
        let line = vec![
            w("a1", "A", Kind::Upload, 1, 1),
            w("a2", "A", Kind::Fetch, 2, 1),
            w("a3", "A", Kind::Upload, 3, 1),
            w("a4", "A", Kind::Fetch, 4, 1),
            w("b1", "B", Kind::Fetch, 5, 1),
            w("c1", "C", Kind::Upload, 6, 1),
            w("b2", "B", Kind::Upload, 7, 1),
        ];
        assert_eq!(order(&line, &HashMap::new()), ["a1", "b1", "c1", "a2", "b2", "a3", "a4"]);
        // A job A already has further along (parsing, say) puts A a round behind.
        let prior: HashMap<Client, usize> = [("A".to_owned(), 1)].into();
        assert_eq!(order(&line, &prior), ["b1", "c1", "a1", "b2", "a2", "a3", "a4"]);
    }

    #[test]
    fn arrival_decides_within_a_round_whatever_the_input_order() {
        let line = vec![w("b1", "B", Kind::Fetch, 9, 1), w("a1", "A", Kind::Fetch, 3, 1), w("a2", "A", Kind::Fetch, 4, 1)];
        assert_eq!(order(&line, &HashMap::new()), ["a1", "b1", "a2"]);
    }

    fn room(bytes: u64, jobs: usize, uploads: usize, downloads: usize) -> Room {
        Room { bytes, jobs, uploads, downloads }
    }

    #[test]
    fn admission_keeps_the_budgets() {
        let line = vec![w("a1", "A", Kind::Upload, 1, 400), w("b1", "B", Kind::Upload, 2, 400), w("c1", "C", Kind::Upload, 3, 400)];
        let all: Vec<usize> = (0..3).collect();
        let none = HashSet::new();
        assert_eq!(jobs(&line, &admit(&line, &all, room(1000, 10, 10, 10), &none)), ["a1", "b1"], "bytes");
        assert_eq!(jobs(&line, &admit(&line, &all, room(800, 10, 10, 10), &none)), ["a1", "b1"], "exactly full fits");
        assert_eq!(jobs(&line, &admit(&line, &all, room(10_000, 1, 10, 10), &none)), ["a1"], "jobs");
        assert_eq!(jobs(&line, &admit(&line, &all, room(10_000, 10, 2, 10), &none)), ["a1", "b1"], "upload slots");
        assert!(admit(&line, &all, room(399, 10, 10, 10), &none).is_empty());
    }

    #[test]
    fn a_full_slot_passes_over_but_full_room_stops_the_walk() {
        let line = vec![w("f1", "A", Kind::Fetch, 1, 100), w("u1", "B", Kind::Upload, 2, 100), w("big", "C", Kind::Upload, 3, 900), w("u2", "D", Kind::Upload, 4, 100)];
        let all: Vec<usize> = (0..4).collect();
        let none = HashSet::new();
        // No download slot: the fetch is passed over, the uploads behind it go, until one the
        // bytes can't hold.
        assert_eq!(jobs(&line, &admit(&line, &all, room(1000, 10, 10, 0), &none)), ["u1", "big"]);
        assert_eq!(jobs(&line, &admit(&line, &all, room(950, 10, 10, 0), &none)), ["u1"], "the big one stops the walk");
        // The big upload doesn't fit: nothing behind it jumps it.
        assert_eq!(jobs(&line, &admit(&line, &all, room(1000, 10, 10, 10), &none)), ["f1", "u1"]);
        // With room for it, all go.
        assert_eq!(jobs(&line, &admit(&line, &all, room(1200, 10, 10, 10), &none)), ["f1", "u1", "big", "u2"]);
    }

    #[test]
    fn download_slots_are_counted() {
        let line = vec![w("f1", "A", Kind::Fetch, 1, 1), w("f2", "B", Kind::Fetch, 2, 1), w("f3", "C", Kind::Fetch, 3, 1), w("u1", "D", Kind::Upload, 4, 1)];
        let all: Vec<usize> = (0..4).collect();
        assert_eq!(jobs(&line, &admit(&line, &all, room(100, 10, 10, 2), &HashSet::new())), ["f1", "f2", "u1"]);
        assert_eq!(jobs(&line, &admit(&line, &all, room(100, 10, 10, 1), &HashSet::new())), ["f1", "u1"]);
    }

    #[test]
    fn one_upload_at_a_time_per_client() {
        let line = vec![w("a1", "A", Kind::Upload, 1, 1), w("a2", "A", Kind::Upload, 2, 1), w("af", "A", Kind::Fetch, 3, 1), w("b1", "B", Kind::Upload, 4, 1)];
        let all: Vec<usize> = (0..4).collect();
        assert_eq!(jobs(&line, &admit(&line, &all, room(100, 10, 10, 10), &HashSet::new())), ["a1", "af", "b1"]);
        let uploading: HashSet<Client> = ["A".to_owned()].into();
        assert_eq!(jobs(&line, &admit(&line, &all, room(100, 10, 10, 10), &uploading)), ["af", "b1"], "A is uploading already");
    }

    #[test]
    fn reservations_lapse_fetches_dont() {
        let now = Instant::now();
        let mut line = vec![w("a1", "A", Kind::Upload, 1, 1), w("f1", "A", Kind::Fetch, 2, 1), w("b1", "B", Kind::Upload, 3, 1)];
        line[0].touched = now - Duration::from_secs(30);
        line[1].touched = now - Duration::from_secs(30);
        line[2].touched = now - Duration::from_secs(5);
        assert_eq!(lapsed(&line, now, Duration::from_secs(20)), [0]);
        assert_eq!(lapsed(&line, now, Duration::from_secs(5)), [0, 2], "at the ttl exactly, it's gone");
    }

    #[test]
    fn estimates_need_samples_and_count_rounds() {
        let mut s = Stats::default();
        s.parsed(4.0);
        s.parsed(6.0);
        assert_eq!(s.parse_mean(), None, "two samples aren't an estimate");
        s.parsed(5.0);
        assert_eq!(s.parse_mean(), Some(5.0));
        for _ in 0..KEEP {
            s.parsed(10.0);
        }
        assert_eq!(s.parse_mean(), Some(10.0), "only recent ones count");
        assert_eq!(s.download_mean(), None, "downloads are kept apart");
        for d in [6.0, 8.0, 10.0] {
            s.downloaded(d);
        }
        assert_eq!(s.download_mean(), Some(8.0));
        assert_eq!(s.parse_mean(), Some(10.0));
        assert_eq!(parse_eta(0, 2, 5.0), 5);
        assert_eq!(parse_eta(1, 2, 5.0), 5, "one ahead, two workers: it starts now");
        assert_eq!(parse_eta(3, 2, 5.0), 10);
        assert_eq!(parse_eta(3, 1, 5.0), 20);
        assert_eq!(fetch_eta(0, 2, 8.0, 0, 2, 5.0), 13);
        assert_eq!(fetch_eta(2, 2, 8.0, 2, 2, 5.0), 26);
    }
}
