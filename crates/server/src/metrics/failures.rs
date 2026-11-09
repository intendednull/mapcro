//! The recent-failures log (spec §2): what broke, without opening the journal. Rows wait here
//! and are written with the minute's snapshot; the table keeps the last 1,000 or 30 days,
//! whichever is fewer (`db::retain`).
//!
//! A row is a time, a kind, a code and a short message. Kinds and codes are enums' `as_str`; the
//! message is built by us from fixed words and numbers, then `sanitise`d anyway, so no id,
//! token, address or name lands in it.

use crate::label;
use std::sync::Mutex;

label! {
    pub enum FailureKind: "kind" {
        /// A 5xx answer.
        Http => "http",
        /// A write to the database failed; a room closed rather than lie.
        Storage => "storage",
        /// A call to deadlock-api that didn't answer usefully.
        Upstream => "upstream",
        /// A replay job that ended without a timeline.
        ReplayJob => "replay_job",
    }
}

/// At most this many rows a minute; the rest are counted in `failures_dropped`.
pub const PER_MINUTE: usize = 100;
/// A message is cut to this many characters.
pub const MESSAGE_CHARS: usize = 120;

#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub t: i64,
    pub kind: &'static str,
    pub code: &'static str,
    pub message: String,
}

fn pending() -> &'static Mutex<Vec<Failure>> {
    static P: Mutex<Vec<Failure>> = Mutex::new(Vec::new());
    &P
}

/// Record a failure. `code` is a label enum's `as_str`.
pub fn record(kind: FailureKind, code: &'static str, message: &str) {
    use crate::metrics::Label;
    let mut p = pending().lock().unwrap_or_else(|e| e.into_inner());
    if p.len() >= PER_MINUTE {
        crate::metrics::get().failures_dropped.inc(());
        return;
    }
    p.push(Failure { t: crate::metrics::snapshot::unix_now(), kind: kind.as_str(), code, message: sanitise(message) });
}

/// The rows waiting to be written.
pub fn take() -> Vec<Failure> {
    std::mem::take(&mut *pending().lock().unwrap_or_else(|e| e.into_inner()))
}

/// Put rows back after a failed write (oldest first, still capped).
pub fn restore(mut rows: Vec<Failure>) {
    let mut p = pending().lock().unwrap_or_else(|e| e.into_inner());
    rows.append(&mut p);
    rows.truncate(PER_MINUTE);
    *p = rows;
}

/// A message safe to keep: words that look like an id (a long run of digits, a long token, an
/// address, a path or URL) become placeholders, control characters go, and it is cut short.
pub fn sanitise(message: &str) -> String {
    let words: Vec<String> = message
        .split_whitespace()
        .map(|w| {
            let digits_run = w.split(|c: char| !c.is_ascii_digit()).map(str::len).max().unwrap_or(0);
            let tokenish = w.len() >= 16 && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
            let address = w.matches('.').count() >= 3 && w.chars().any(|c| c.is_ascii_digit()) || w.matches(':').count() >= 2;
            let locator = w.contains('/') || w.contains('@') || w.contains('?') || w.contains('=');
            if address {
                "<addr>".to_owned()
            } else if locator {
                "<path>".to_owned()
            } else if tokenish {
                "<id>".to_owned()
            } else if digits_run >= 5 {
                // A match id is 9-10 digits; times and sizes we write are short.
                "<n>".to_owned()
            } else {
                w.chars().filter(|c| !c.is_control()).collect()
            }
        })
        .collect();
    words.join(" ").chars().take(MESSAGE_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_tokens_and_addresses_are_scrubbed() {
        assert_eq!(sanitise("replay parse_failed after 4.1 s"), "replay parse_failed after 4.1 s");
        assert_eq!(sanitise("match 61234567 not found"), "match <n> not found");
        assert_eq!(sanitise("board Xk3_9aQ-p0Lm2vB7tZ failed"), "board <id> failed");
        assert_eq!(sanitise("from 203.0.113.7 and 2001:db8::1"), "from <addr> and <addr>");
        assert_eq!(sanitise("GET /api/boards/abc/links answered 500"), "GET <path> answered 500");
        assert_eq!(sanitise("x\u{7}y\nz"), "xy z");
        assert_eq!(sanitise(&"a ".repeat(200)).chars().count(), MESSAGE_CHARS);
    }
}
