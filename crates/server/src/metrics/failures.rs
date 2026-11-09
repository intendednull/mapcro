//! The recent-failures log (spec §2): what broke, without opening the journal. Rows wait here
//! and are written with the minute's snapshot; the table keeps the last 1,000 or 30 days,
//! whichever is fewer (`db::retain`).
//!
//! A row is a time, a kind, a code and a short message. Kinds and codes are enums' `as_str`; the
//! message is built only from typed `Part`s (`&'static str` words and numbers, long numbers
//! scrubbed), so no id, token, address or name can land in it.

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

/// One piece of a failure message: fixed text or a number, never text from a request.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Part {
    /// A word we wrote: a literal or a label enum's `as_str`.
    Word(&'static str),
    /// A count, a status. Six digits or more is written `<n>` (it could be a match id).
    Int(i64),
    /// A duration or a size, to one decimal place.
    Dec(f64),
}

/// The message `parts` make, words and numbers joined by spaces.
pub fn compose(parts: &[Part]) -> String {
    let s: Vec<String> = parts
        .iter()
        .map(|p| match p {
            Part::Word(w) => w.chars().filter(|c| !c.is_control()).collect(),
            Part::Int(n) => scrub_runs(&n.to_string()),
            Part::Dec(x) => scrub_runs(&format!("{x:.1}")),
        })
        .collect();
    s.join(" ").chars().take(MESSAGE_CHARS).collect()
}

/// Record a failure. `code` is a label enum's `as_str`; the message is made of `parts`, fixed
/// words and numbers, so no free text (an id, a name, a path) can reach the log.
pub fn record(kind: FailureKind, code: &'static str, parts: &[Part]) {
    push(kind, code, compose(parts));
}

fn push(kind: FailureKind, code: &'static str, message: String) {
    use crate::metrics::Label;
    let mut p = pending().lock().unwrap_or_else(|e| e.into_inner());
    if p.len() >= PER_MINUTE {
        crate::metrics::get().failures_dropped.inc(());
        return;
    }
    p.push(Failure { t: crate::metrics::snapshot::unix_now(), kind: kind.as_str(), code, message });
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

fn token_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-'
}

/// Within a word: a run of 8 or more letters, digits, `_` or `-` becomes `<id>` (`<n>` if it is
/// all digits), and a run of 6 or more digits becomes `<n>`, wherever they sit (after a quote,
/// a colon, inside punctuation).
fn scrub_runs(w: &str) -> String {
    let mut out = String::new();
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        let n = run.chars().count();
        if n >= 8 {
            out.push_str(if run.chars().all(|c| c.is_ascii_digit()) { "<n>" } else { "<id>" });
        } else {
            let mut digits = String::new();
            for c in run.chars().chain(std::iter::once(' ')) {
                if c.is_ascii_digit() {
                    digits.push(c);
                    continue;
                }
                out.push_str(if digits.len() >= 6 { "<n>" } else { digits.as_str() });
                digits.clear();
                if c != ' ' {
                    out.push(c);
                }
            }
        }
        run.clear();
    };
    for c in w.chars() {
        if token_char(c) {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    out
}

/// A free-text message made safe to keep, for any free text that must one day be logged:
/// nothing passes any today (`record` takes `Part`s), so this is the fallback, kept tested. Whole words that are an address (`<addr>`), a URL or
/// a path (`<path>`) go; within the rest, anything long enough to be an id, a token or a name
/// goes (`scrub_runs`). Control characters go, and it is cut short. Ordinary long words go too:
/// that is the price of free text, and why `record` takes `Part`s.
#[allow(dead_code)]
pub fn sanitise(message: &str) -> String {
    let words: Vec<String> = message
        .split_whitespace()
        .map(|w| {
            let w: String = w.chars().filter(|c| !c.is_control()).collect();
            let dotted = w.split('.').filter(|p| !p.is_empty()).count() >= 3 && w.chars().any(|c| c.is_ascii_digit());
            let address = dotted || w.matches(':').count() >= 2;
            let lower = w.to_ascii_lowercase();
            let locator = ['/', '\\', '@', '?', '=', '&', '%', '~'].iter().any(|c| w.contains(*c))
                || lower.contains("://")
                || lower.starts_with("www.")
                || lower.contains("http")
                || lower.contains("file:");
            if address {
                "<addr>".to_owned()
            } else if locator {
                "<path>".to_owned()
            } else {
                scrub_runs(&w)
            }
        })
        .filter(|w| !w.is_empty())
        .collect();
    words.join(" ").chars().take(MESSAGE_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_tokens_and_addresses_are_scrubbed() {
        assert_eq!(sanitise("replay upload timeout after 4.1 s"), "replay upload timeout after 4.1 s");
        assert_eq!(sanitise("match 61234567 not found"), "match <n> not found");
        assert_eq!(sanitise("match 612345 and 12345"), "match <n> and 12345");
        assert_eq!(sanitise("board Xk3_9aQ-p0Lm2vB7tZ failed"), "board <id> failed");
        assert_eq!(sanitise("from 203.0.113.7 and 2001:db8::1"), "from <addr> and <addr>");
        assert_eq!(sanitise("GET /api/boards/abc/links answered 500"), "GET <path> <id> 500");
        assert_eq!(sanitise("x\u{7}y\nz"), "xy z");
        assert_eq!(sanitise(&"a ".repeat(200)).chars().count(), MESSAGE_CHARS);
    }

    #[test]
    fn tokens_in_punctuation_names_and_locators_are_scrubbed() {
        // Tokens wrapped in quotes, commas, colons, brackets.
        assert_eq!(sanitise(r#"key "Xk3_9aQ-ZZ", bad"#), r#"key "<id>", bad"#);
        assert_eq!(sanitise("token:abc123def456"), "token:<id>");
        assert_eq!(sanitise("(secret=hunter22)"), "<path>");
        assert_eq!(sanitise("[sk-live_0123]"), "[<id>]");
        assert_eq!(sanitise("'Bearer' 'eyJhbGciOiJIUzI1NiJ9.e30.abc'"), "'Bearer' <addr>");
        // Names: long ones go, short ones can't be told from words.
        assert_eq!(sanitise("player intendednull left"), "player <id> left");
        assert_eq!(sanitise("player Zoë_Player9 left"), "player <id> left");
        assert_eq!(sanitise("player Свенсонович left"), "player <id> left");
        // Digits glued to letters, short runs inside longer ones.
        assert_eq!(sanitise("id#a1234567"), "id#<id>");
        assert_eq!(sanitise("m:123456,"), "m:<n>,");
        // URLs and paths, however written.
        assert_eq!(sanitise("see https://example.com/x"), "see <path>");
        assert_eq!(sanitise("at www.example.com"), "at <path>");
        assert_eq!(sanitise(r"C:\Users\bob"), "<path>");
        assert_eq!(sanitise("mail bob@example.com"), "mail <path>");
        assert_eq!(sanitise("~bob"), "<path>");
        // Controls can't glue a token to a word or hide it.
        assert_eq!(sanitise("ok\u{0}Xk3_9aQ-p0Lm"), "<id>");
        assert_eq!(sanitise("\u{1b}[31m"), "[31m");
    }

    #[test]
    fn parts_keep_our_words_and_scrub_numbers() {
        use Part::*;
        assert_eq!(compose(&[Word("replay"), Word("upload"), Word("parse_failed"), Word("after"), Dec(4.06), Word("s")]), "replay upload parse_failed after 4.1 s");
        assert_eq!(compose(&[Word("GET"), Word("/api/boards"), Word("answered"), Int(503)]), "GET /api/boards answered 503");
        assert_eq!(compose(&[Word("match"), Int(61234567), Dec(1234567.0)]), "match <n> <n>.0");
        assert_eq!(compose(&[Word("x\ny")]), "xy");
    }
}
