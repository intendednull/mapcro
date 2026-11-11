//! When a replay has finished downloading: its size and time haven't changed for [`QUIET_MS`].
//! Whether the game writes the file in place or renames it in once complete is unverified
//! (docs/research/desktop-app.md §2), so this assumes the worst: in place, growing. The caller
//! also checks the demo magic before parsing. Pure: the caller passes the time, so tests drive it.

use crate::replays::Replay;
use std::collections::HashMap;

/// A file unchanged this long is taken as complete.
pub const QUIET_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Seen {
    size: u64,
    modified: u64,
    /// When this size and time were first seen.
    since: u64,
    /// Reported (or already there at start).
    done: bool,
}

/// The folder's replays as last seen, and which have been reported settled.
#[derive(Debug, Default)]
pub struct Settle {
    seen: HashMap<String, Seen>,
}

impl Settle {
    /// The replays already there when the app starts: not reported, unless still changing. A
    /// file written within the quiet time may be a download in progress, so it's watched.
    pub fn prime(&mut self, list: &[Replay], now: u64) {
        for r in list {
            let old = now.saturating_sub(r.last_modified) >= QUIET_MS;
            self.seen.insert(r.id.clone(), Seen { size: r.size, modified: r.last_modified, since: now, done: old });
        }
    }

    /// Take a new look at the folder; the ids that have just settled, newest first as given. A
    /// file that changes after it settled (downloaded again) settles, and is reported, again. A
    /// file that's gone is forgotten.
    pub fn observe(&mut self, list: &[Replay], now: u64) -> Vec<String> {
        self.seen.retain(|id, _| list.iter().any(|r| &r.id == id));
        let mut out = Vec::new();
        for r in list {
            let s = self.seen.entry(r.id.clone()).or_insert(Seen { size: r.size, modified: r.last_modified, since: now, done: false });
            if s.size != r.size || s.modified != r.last_modified {
                *s = Seen { size: r.size, modified: r.last_modified, since: now, done: false };
            }
            if !s.done && r.size > 0 && now.saturating_sub(s.since) >= QUIET_MS {
                s.done = true;
                out.push(r.id.clone());
            }
        }
        out
    }

    /// Is any file still waiting to settle? (Then look again soon.)
    pub fn waiting(&self) -> bool {
        self.seen.values().any(|s| !s.done)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(id: &str, size: u64, modified: u64) -> Replay {
        Replay { id: id.into(), last_modified: modified, size }
    }

    #[test]
    fn a_growing_file_waits_until_it_stops() {
        let mut s = Settle::default();
        s.prime(&[], 0);
        assert!(s.observe(&[r("1", 10, 100)], 1_000).is_empty());
        assert!(s.waiting());
        // Still growing: the clock restarts at each change.
        assert!(s.observe(&[r("1", 20, 4_000)], 4_000).is_empty());
        assert!(s.observe(&[r("1", 30, 8_000)], 8_000).is_empty());
        assert!(s.observe(&[r("1", 30, 8_000)], 12_999).is_empty());
        assert_eq!(s.observe(&[r("1", 30, 8_000)], 13_000), ["1"]);
        assert!(!s.waiting());
        // Reported once.
        assert!(s.observe(&[r("1", 30, 8_000)], 60_000).is_empty());
    }

    #[test]
    fn same_size_but_rewritten_restarts_the_wait() {
        let mut s = Settle::default();
        assert!(s.observe(&[r("1", 30, 0)], 0).is_empty());
        assert!(s.observe(&[r("1", 30, 4_000)], 4_000).is_empty());
        assert!(s.observe(&[r("1", 30, 4_000)], 8_000).is_empty());
        assert_eq!(s.observe(&[r("1", 30, 4_000)], 9_000), ["1"]);
    }

    #[test]
    fn files_there_at_start_are_not_reported_unless_still_changing() {
        let mut s = Settle::default();
        let now = 100_000;
        s.prime(&[r("old", 50, now - 60_000), r("fresh", 5, now - 1_000)], now);
        assert!(s.observe(&[r("old", 50, now - 60_000), r("fresh", 9, now + 1_000)], now + 1_000).is_empty());
        assert_eq!(s.observe(&[r("old", 50, now - 60_000), r("fresh", 9, now + 1_000)], now + 6_000), ["fresh"]);
    }

    #[test]
    fn an_empty_file_never_settles_and_a_redownload_reports_again() {
        let mut s = Settle::default();
        assert!(s.observe(&[r("1", 0, 0)], 0).is_empty());
        assert!(s.observe(&[r("1", 0, 0)], 60_000).is_empty());
        assert!(s.waiting());
        assert!(s.observe(&[r("1", 10, 60_000)], 70_000).is_empty());
        assert_eq!(s.observe(&[r("1", 10, 60_000)], 75_000), ["1"]);
        // Deleted, then downloaded again.
        assert!(s.observe(&[], 80_000).is_empty());
        assert!(!s.waiting());
        assert!(s.observe(&[r("1", 10, 90_000)], 90_000).is_empty());
        assert_eq!(s.observe(&[r("1", 10, 90_000)], 95_000), ["1"]);
    }
}
