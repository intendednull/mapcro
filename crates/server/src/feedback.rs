//! The feedback form (spec §11a): `POST /api/feedback` with a title and a description opens an
//! issue on the project's GitHub repository; `GET /api/feedback` says whether it's on.
//!
//! **Privacy:** the issue holds the cleaned title and description and a fixed footer with the
//! build id. Nothing about the sender (address, client key, board, link, name, user agent) is
//! put in it, logged or counted; the submitted text is never logged either.
//!
//! **Safety:** the text is trimmed, stripped of control characters, length-checked here (the
//! client's limits are a courtesy), and every `@` is followed by a zero-width joiner, so an
//! issue can't mention (and notify) a GitHub user or team.
//!
//! **Abuse:** 3 issues per client key an hour and 30 server-wide a day by default
//! (`FEEDBACK_PER_CLIENT_PER_HOUR`, `FEEDBACK_GLOBAL_PER_DAY`); past them, 429 with
//! `Retry-After`. Only a submission that passes validation counts against them.

use crate::AppState;
use crate::api::{client_ip, client_key};
use crate::config::FeedbackConfig;
use crate::metrics::{ApiResult, FeedbackRejection};
use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Characters, after trimming and stripping.
pub const MAX_TITLE: usize = 120;
pub const MAX_DESCRIPTION: usize = 5000;
/// The request body cap: a 5,000-character description of 4-byte characters, a title, and JSON.
pub const MAX_BODY_BYTES: usize = 32 * 1024;
/// GitHub's answer is read up to this much (an issue's JSON is a few kilobytes).
const MAX_ANSWER_BYTES: u64 = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);
const LABEL: &str = "feedback";
/// Follows every `@`, so `@user` and `@org/team` don't link or notify (GitHub's mention syntax
/// needs a name character straight after the `@`).
const ZWJ: char = '\u{200D}';

// ---- cleaning and validation ----

/// Trim, unify line ends, and drop control characters. A description keeps its newlines and
/// tabs; a title is one line.
pub fn clean(s: &str, multiline: bool) -> String {
    let s = s.replace("\r\n", "\n").replace('\r', "\n");
    let kept: String = s.chars().filter(|&c| !c.is_control() || (multiline && (c == '\n' || c == '\t'))).collect();
    kept.trim().to_owned()
}

/// Make mentions and cross-references inert, so an issue opened under the operator's account
/// can't ping anyone or drop "mentioned this" backlinks into other repositories:
/// - a zero-width joiner after every `@`: `@user`, `@org/team`, and `owner/repo@sha`;
/// - after a `#` that follows a name character: `owner/repo#123`, `owner#123` (a plain `#123`,
///   this repository's own, stays a link);
/// - inside every `github.com` (any case), so no GitHub URL (issue, PR, commit, discussion,
///   anything) is a link or a reference.
pub fn neutralise(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    let mut prev: Option<char> = None;
    for (i, c) in s.char_indices() {
        out.push(c);
        let names = prev.is_some_and(|p| p.is_alphanumeric() || "-_./".contains(p));
        if c == '@' || (c == '#' && names) {
            out.push(ZWJ);
        }
        // After "github", when ".com" follows: "github\u{200D}.com".
        if (c == 'b' || c == 'B') && i >= 5 {
            let start = i + 1 - 6;
            let github = s.get(start..i + 1).is_some_and(|w| w.eq_ignore_ascii_case("github"));
            if github && s.get(i + 1..i + 5).is_some_and(|w| w.eq_ignore_ascii_case(".com")) {
                out.push(ZWJ);
            }
        }
        prev = Some(c);
    }
    out
}

/// What was wrong with a submission (a message the client can show).
#[derive(Debug, PartialEq)]
pub enum Invalid {
    TitleEmpty,
    TitleTooLong,
    DescriptionEmpty,
    DescriptionTooLong,
}

impl Invalid {
    fn message(&self) -> &'static str {
        match self {
            Invalid::TitleEmpty => "a title is required",
            Invalid::TitleTooLong => "the title is longer than 120 characters",
            Invalid::DescriptionEmpty => "a description is required",
            Invalid::DescriptionTooLong => "the description is longer than 5,000 characters",
        }
    }
}

/// The issue's title and body for a submission, or why it's refused. Lengths are checked on the
/// cleaned text, before neutralising (which adds characters the sender didn't type).
pub fn issue(title: &str, description: &str, build: &str) -> Result<(String, String), Invalid> {
    let title = clean(title, false);
    let description = clean(description, true);
    match title.chars().count() {
        0 => return Err(Invalid::TitleEmpty),
        n if n > MAX_TITLE => return Err(Invalid::TitleTooLong),
        _ => {}
    }
    match description.chars().count() {
        0 => return Err(Invalid::DescriptionEmpty),
        n if n > MAX_DESCRIPTION => return Err(Invalid::DescriptionTooLong),
        _ => {}
    }
    let body = format!("{}\n\n---\n— Sent from the mapcro feedback form (build {build})", neutralise(&description));
    Ok((neutralise(&title), body))
}

// ---- limits ----

/// Sliding windows: per client key an hour, and server-wide a day.
#[derive(Default)]
pub struct Limiter {
    inner: Mutex<Windows>,
}

#[derive(Default)]
struct Windows {
    clients: HashMap<IpAddr, Vec<Instant>>,
    global: Vec<Instant>,
}

const HOUR: Duration = Duration::from_secs(3600);
const DAY: Duration = Duration::from_secs(86_400);

impl Limiter {
    /// Take one submission for `client`, or say how long until one is allowed.
    pub fn admit(&self, client: IpAddr, per_client: u32, global: u32, now: Instant) -> Result<(), Duration> {
        let mut w = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        w.global.retain(|t| now.duration_since(*t) < DAY);
        w.clients.retain(|_, v| {
            v.retain(|t| now.duration_since(*t) < HOUR);
            !v.is_empty()
        });
        // The wait until the oldest counted submission leaves its window.
        let wait = |times: &[Instant], cap: u32, window: Duration| -> Option<Duration> {
            let cap = cap as usize;
            if cap == 0 {
                return Some(window);
            }
            if times.len() < cap {
                return None;
            }
            Some(window.saturating_sub(now.duration_since(times[times.len() - cap])))
        };
        if let Some(d) = wait(&w.global, global, DAY) {
            return Err(d);
        }
        if let Some(d) = wait(w.clients.get(&client).map_or(&[][..], Vec::as_slice), per_client, HOUR) {
            return Err(d);
        }
        w.global.push(now);
        w.clients.entry(client).or_default().push(now);
        Ok(())
    }
}

// ---- GitHub ----

#[derive(Serialize)]
struct NewIssue<'a> {
    title: &'a str,
    body: &'a str,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    labels: &'a [&'a str],
}

#[derive(Deserialize)]
struct CreatedIssue {
    html_url: String,
}

enum GitHub {
    Created(String),
    /// 422: the request was valid JSON but GitHub refused a field (for us, the label).
    Unprocessable,
    Failed(ApiResult),
}

fn post_issue(cfg: &FeedbackConfig, title: &str, body: &str, labels: &[&str]) -> GitHub {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .http_status_as_error(false)
        .max_redirects(0)
        .user_agent("mapcro-feedback (https://mapcro.dmgdeadlock.com)")
        .build()
        .into();
    let url = format!("{}/repos/{}/issues", cfg.api, cfg.repo);
    let sent = agent
        .post(&url)
        .header("Authorization", &format!("Bearer {}", cfg.token.expose()))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send_json(NewIssue { title, body, labels });
    let mut r = match sent {
        Ok(r) => r,
        Err(e) => return GitHub::Failed(ApiResult::of_error(&e)),
    };
    match r.status().as_u16() {
        201 => {}
        422 => return GitHub::Unprocessable,
        code => return GitHub::Failed(ApiResult::of_status(code)),
    }
    match r.body_mut().with_config().limit(MAX_ANSWER_BYTES).read_json::<CreatedIssue>() {
        // Only an https link goes back to the browser, which renders it as a link.
        Ok(c) if c.html_url.starts_with("https://") => GitHub::Created(c.html_url),
        Ok(_) => GitHub::Failed(ApiResult::Shape),
        Err(e) => GitHub::Failed(ApiResult::of_error(&e)),
    }
}

/// Open the issue with the label; if GitHub refuses the label, once more without it.
fn create(cfg: &FeedbackConfig, title: &str, body: &str) -> Result<String, ApiResult> {
    match post_issue(cfg, title, body, &[LABEL]) {
        GitHub::Created(url) => Ok(url),
        GitHub::Failed(r) => Err(r),
        GitHub::Unprocessable => match post_issue(cfg, title, body, &[]) {
            GitHub::Created(url) => Ok(url),
            GitHub::Unprocessable => Err(ApiResult::Refused),
            GitHub::Failed(r) => Err(r),
        },
    }
}

// ---- handlers ----

fn reject(reason: FeedbackRejection, status: StatusCode, msg: &str) -> Response {
    crate::metrics::get().feedback_rejected.inc((reason,));
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

/// `GET /api/feedback`: whether the form is on (the client hides its button when it isn't).
pub async fn status(State(app): State<AppState>) -> Response {
    Json(serde_json::json!({ "enabled": app.config.feedback.is_some() })).into_response()
}

#[derive(Deserialize)]
pub struct Submit {
    title: String,
    description: String,
}

/// `POST /api/feedback`: `{title, description}` → 201 `{url}` of the new issue.
pub async fn send(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<Submit>, JsonRejection>,
) -> Response {
    let Some(cfg) = app.config.feedback.clone() else {
        return reject(FeedbackRejection::Disabled, StatusCode::NOT_FOUND, "feedback is not enabled on this server");
    };
    let Ok(Json(body)) = body else {
        return reject(FeedbackRejection::Invalid, StatusCode::BAD_REQUEST, "expected a title and a description");
    };
    let (title, text) = match issue(&body.title, &body.description, mapcro_schema::BUILD_ID) {
        Ok(x) => x,
        Err(e) => return reject(FeedbackRejection::Invalid, StatusCode::BAD_REQUEST, e.message()),
    };
    let client = client_key(client_ip(peer, &headers));
    if let Err(wait) = app.feedback.admit(client, cfg.per_client_per_hour, cfg.global_per_day, Instant::now()) {
        let secs = wait.as_secs().max(1);
        let mut r = reject(FeedbackRejection::RateLimited, StatusCode::TOO_MANY_REQUESTS, "too much feedback sent; try again later");
        if let Ok(v) = HeaderValue::from_str(&secs.to_string()) {
            r.headers_mut().insert(header::RETRY_AFTER, v);
        }
        return r;
    }
    let done = tokio::task::spawn_blocking(move || create(&cfg, &title, &text)).await;
    match done {
        Ok(Ok(url)) => {
            crate::metrics::get().feedback_sent.inc(());
            (StatusCode::CREATED, Json(serde_json::json!({ "url": url }))).into_response()
        }
        Ok(Err(result)) => {
            use crate::metrics::Label;
            use crate::metrics::failures::Part::Word;
            // The outcome's kind only: never the text, the token or the sender.
            tracing::warn!(result = result.as_str(), "feedback: GitHub didn't create the issue");
            crate::metrics::failures::record(
                crate::metrics::failures::FailureKind::Upstream,
                result.as_str(),
                &[Word("github"), Word("issues"), Word(result.as_str())],
            );
            reject(FeedbackRejection::GithubError, StatusCode::BAD_GATEWAY, "GitHub didn't take the feedback; try again in a few minutes")
        }
        Err(_) => reject(FeedbackRejection::GithubError, StatusCode::BAD_GATEWAY, "GitHub didn't take the feedback; try again in a few minutes"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn clean_trims_and_strips_control_characters() {
        assert_eq!(clean("  hi\u{0}\u{7}there \u{1b}[31m ", false), "hithere [31m");
        // A title is one line; a description keeps newlines and tabs, with CRLF unified.
        assert_eq!(clean("a\r\nb\tc", false), "abc");
        assert_eq!(clean("\n a\r\nb\tc\rd \n", true), "a\nb\tc\nd");
        assert_eq!(clean("x\u{85}y\u{9f}", true), "xy");
        assert_eq!(clean(" \n\t ", true), "");
    }

    #[test]
    fn mentions_are_neutralised() {
        assert_eq!(neutralise("@octocat"), "@\u{200D}octocat");
        assert_eq!(neutralise("hi @org/team and a@b.c @@x"), "hi @\u{200D}org/team and a@\u{200D}b.c @\u{200D}@\u{200D}x");
        // Nothing left that GitHub reads as a mention: an @ straight before a name character.
        let out = neutralise("ping @intendednull, @Some-User_1 @ok");
        let chars: Vec<char> = out.chars().collect();
        for w in chars.windows(2) {
            assert!(!(w[0] == '@' && (w[1].is_alphanumeric() || w[1] == '-' || w[1] == '_')), "{out:?}");
        }
        assert_eq!(neutralise("no mentions"), "no mentions");
    }

    /// What GitHub would still link as a reference to another repository, or a mention.
    fn linkable(s: &str) -> Vec<String> {
        let c: Vec<char> = s.chars().collect();
        let name = |x: char| x.is_alphanumeric() || "-_./".contains(x);
        let mut found = Vec::new();
        for i in 0..c.len() {
            let next = c.get(i + 1).copied();
            if c[i] == '@' && next.is_some_and(char::is_alphanumeric) {
                found.push(format!("@ at {i}"));
            }
            if c[i] == '#' && i > 0 && name(c[i - 1]) && next.is_some_and(|n| n.is_ascii_digit()) {
                found.push(format!("# at {i}"));
            }
        }
        if s.to_ascii_lowercase().contains("github.com") {
            found.push("github.com".into());
        }
        found
    }

    #[test]
    fn cross_repo_references_are_neutralised() {
        let refs = [
            "see foo/bar#123",
            "foo#7",
            "fix in some-org/some.repo@a1b2c3d",
            "https://github.com/foo/bar/issues/1",
            "https://github.com/foo/bar/pull/2/files",
            "https://GitHub.COM/foo/bar/commit/a1b2c3d4",
            "<https://www.github.com/foo/bar/discussions/3>",
            "[x](https://github.com/foo/bar/issues/9)",
            "github.com/foo/bar/issues/4",
        ];
        for r in refs {
            assert!(!linkable(r).is_empty(), "the check sees {r:?}");
            let out = neutralise(r);
            assert!(linkable(&out).is_empty(), "{r:?} -> {out:?}: {:?}", linkable(&out));
            // Only joiners are added: the text reads the same.
            assert_eq!(out.replace(ZWJ, ""), r);
        }
        assert_eq!(neutralise("foo/bar#12"), "foo/bar#\u{200D}12");
        assert_eq!(neutralise("https://github.com/x"), "https://github\u{200D}.com/x");
        // This repository's own #123, a heading, and "github" alone stay as they are.
        for keep in ["see #123", "(#45)", "# Heading", "#1 first", "on github, not .com", "githubXcom"] {
            assert_eq!(neutralise(keep), keep);
        }
    }

    #[test]
    fn issue_validates_cleaned_lengths_and_neutralises_both_fields() {
        assert_eq!(issue("  ", "body", "b"), Err(Invalid::TitleEmpty));
        assert_eq!(issue("\u{0}\u{1}", "body", "b"), Err(Invalid::TitleEmpty));
        assert_eq!(issue("t", " \n ", "b"), Err(Invalid::DescriptionEmpty));
        assert_eq!(issue(&"x".repeat(121), "d", "b"), Err(Invalid::TitleTooLong));
        assert_eq!(issue("t", &"x".repeat(5001), "b"), Err(Invalid::DescriptionTooLong));
        // Limits count characters, not bytes, after trimming.
        assert!(issue(&format!("  {}  ", "é".repeat(120)), &"日".repeat(5000), "b").is_ok());
        // Neutralising after the check: 120 @s is a valid title.
        let (t, b) = issue(&"@".repeat(120), "hi @you", "abc123").expect("valid");
        assert_eq!(t.chars().filter(|&c| c == ZWJ).count(), 120);
        assert_eq!(b, "hi @\u{200D}you\n\n---\n— Sent from the mapcro feedback form (build abc123)");
    }

    #[test]
    fn limiter_per_client_and_global_with_retry_after() {
        let l = Limiter::default();
        let t0 = Instant::now();
        let a = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1));
        let b = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2));
        for i in 0..3 {
            assert_eq!(l.admit(a, 3, 5, t0 + Duration::from_secs(i * 60)), Ok(()));
        }
        // The fourth waits for the first to leave the hour: 60 min - 10 min since it.
        assert_eq!(l.admit(a, 3, 5, t0 + Duration::from_secs(600)), Err(Duration::from_secs(3000)));
        // Another client has its own budget, until the global one is spent.
        assert_eq!(l.admit(b, 3, 5, t0 + Duration::from_secs(600)), Ok(()));
        assert_eq!(l.admit(b, 3, 5, t0 + Duration::from_secs(600)), Ok(()));
        let c = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 3));
        assert_eq!(l.admit(c, 3, 5, t0 + Duration::from_secs(700)), Err(DAY - Duration::from_secs(700)));
        // A refused attempt isn't counted; an hour on, `a` may send again, but the day is full.
        assert_eq!(l.admit(a, 3, 5, t0 + HOUR), Err(DAY - HOUR));
        assert_eq!(l.admit(a, 3, 100, t0 + HOUR), Ok(()));
    }
}
