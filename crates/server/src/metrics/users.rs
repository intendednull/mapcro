//! Distinct users per day (spec §5): each client key (an IPv4 address or IPv6 /64, the unit the
//! limits already use) is hashed with a random salt that lives only in memory and only for the
//! UTC day. The set of hashes stays in memory too; only the day's count is written. At midnight
//! the salt and the set are dropped, so days can't be linked and no key can be recovered.

use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::Mutex;

/// Past this many a day the set stops growing (about 6 MB); the count says "at least".
pub const MAX_PER_DAY: usize = 200_000;

pub struct Users {
    day: i64,
    salt: [u8; 32],
    seen: HashSet<[u8; 16]>,
    /// A finished day's count, until the snapshot writes it.
    ended: Option<(i64, u64)>,
}

fn fresh_salt() -> [u8; 32] {
    let mut s = [0u8; 32];
    getrandom::fill(&mut s).expect("OS random number generator unavailable");
    s
}

/// Days since 1970-01-01, UTC.
pub fn day_of(unix: i64) -> i64 {
    unix.div_euclid(86_400)
}

impl Users {
    pub fn new(now: i64) -> Users {
        Users { day: day_of(now), salt: fresh_salt(), seen: HashSet::new(), ended: None }
    }

    /// A new UTC day: keep the old day's count for the snapshot, forget its salt and set.
    fn roll(&mut self, now: i64) {
        let today = day_of(now);
        if today != self.day {
            self.ended = Some((self.day, self.seen.len() as u64));
            self.day = today;
            self.salt = fresh_salt();
            self.seen = HashSet::new();
            // A quiet midnight must not leave yesterday's count on the gauge until a user is
            // seen again.
            crate::metrics::get().users_today.set((), 0.0);
        }
    }

    pub fn saw(&mut self, key: IpAddr, now: i64) {
        self.roll(now);
        if self.seen.len() >= MAX_PER_DAY {
            return;
        }
        let mut h = Sha256::new();
        h.update(self.salt);
        match key {
            IpAddr::V4(v4) => h.update(v4.octets()),
            IpAddr::V6(v6) => h.update(v6.octets()),
        }
        let d = h.finalize();
        let mut short = [0u8; 16];
        short.copy_from_slice(&d[..16]);
        self.seen.insert(short);
    }

    /// The counts to write: a day that just ended (final), then today's so far.
    pub fn counts(&mut self, now: i64) -> Vec<(i64, u64)> {
        self.roll(now);
        let mut out: Vec<(i64, u64)> = self.ended.take().into_iter().collect();
        out.push((self.day, self.seen.len() as u64));
        out
    }

    #[cfg(test)]
    fn salt(&self) -> [u8; 32] {
        self.salt
    }
}

fn users() -> &'static Mutex<Users> {
    static U: std::sync::LazyLock<Mutex<Users>> = std::sync::LazyLock::new(|| Mutex::new(Users::new(crate::metrics::snapshot::unix_now())));
    &U
}

/// Count `key` (already `api::client_key`'d) as a user today.
pub fn saw(key: IpAddr) {
    let now = crate::metrics::snapshot::unix_now();
    let mut u = users().lock().unwrap_or_else(|e| e.into_inner());
    u.saw(key, now);
    crate::metrics::get().users_today.set((), u.seen.len() as f64);
}

pub fn counts(now: i64) -> Vec<(i64, u64)> {
    users().lock().unwrap_or_else(|e| e.into_inner()).counts(now)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A day rolling over writes the global `users_today` gauge, so the tests here that roll a
    /// day run one at a time; in parallel, one's reset raced another's read.
    static GAUGE: Mutex<()> = Mutex::new(());
    fn one_at_a_time() -> std::sync::MutexGuard<'static, ()> {
        GAUGE.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn a_key_counts_once_a_day_and_the_salt_resets_at_midnight() {
        let _one = one_at_a_time();
        let day = 20_400 * 86_400; // a midnight, UTC
        let mut u = Users::new(day + 10);
        let a = IpAddr::from([203, 0, 113, 7]);
        let b = IpAddr::from([198, 51, 100, 1]);
        u.saw(a, day + 10);
        u.saw(a, day + 3600);
        u.saw(b, day + 7200);
        assert_eq!(u.counts(day + 7300), vec![(20_400, 2)]);
        let salt = u.salt();
        // Just before midnight: the same day, same salt.
        u.saw(a, day + 86_399);
        assert_eq!(u.salt(), salt);
        // After midnight: a new salt, an empty set, and the old day's final count once.
        u.saw(a, day + 86_400 + 5);
        assert_ne!(u.salt(), salt, "the salt is replaced at midnight");
        assert_eq!(u.counts(day + 86_400 + 60), vec![(20_400, 2), (20_401, 1)]);
        assert_eq!(u.counts(day + 86_400 + 120), vec![(20_401, 1)], "the ended day is written once");
    }

    #[test]
    fn a_quiet_midnight_still_rolls_over() {
        let _one = one_at_a_time();
        let day = 20_400 * 86_400;
        let mut u = Users::new(day);
        u.saw(IpAddr::from([10, 0, 0, 1]), day + 1);
        let salt = u.salt();
        assert_eq!(u.counts(day + 86_400 + 1), vec![(20_400, 1), (20_401, 0)]);
        assert_ne!(u.salt(), salt);
    }

    fn gauge() -> f64 {
        use crate::metrics::{Family, Value};
        match crate::metrics::get().users_today.read(false).into_iter().next().map(|r| r.value) {
            Some(Value::Gauge { now, .. }) => now,
            _ => f64::NAN,
        }
    }

    #[test]
    fn a_quiet_midnight_resets_the_users_today_gauge() {
        let _one = one_at_a_time();
        let day = 20_400 * 86_400;
        let mut u = Users::new(day);
        u.saw(IpAddr::from([10, 0, 0, 1]), day + 1);
        // Yesterday's count, as `saw` left it on the gauge.
        crate::metrics::get().users_today.set((), 1.0);
        assert_eq!(gauge(), 1.0);
        // The snapshot rolls the day with nobody seen since: the gauge must read 0, not 1.
        assert_eq!(u.counts(day + 86_400 + 1), vec![(20_400, 1), (20_401, 0)]);
        assert_eq!(gauge(), 0.0);
    }
}
