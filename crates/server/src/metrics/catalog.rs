//! Every metric the server records, and the fixed label values they take. Adding a metric
//! happens here (see the spec's "Adding a metric"): a label enum if it needs one (`label!`), and
//! one line in `registry!`.
//!
//! Privacy (spec §5): a label is always one of these enums. Never a board id, match id, token,
//! name, address or anything a client sent.

use super::{Counter, Family, Gauge, Histogram};
use crate::label;

// ---- labels ----

label! {
    /// An HTTP route by its template (axum's matched path), never the raw URI.
    pub enum Route: "route" {
        Healthz => "healthz",
        Ws => "ws",
        Boards => "boards",
        BoardLinks => "board_links",
        BoardLink => "board_link",
        OwnerRotate => "owner_rotate",
        BoardClone => "board_clone",
        Packs => "packs",
        Match => "match",
        PackFile => "pack_file",
        ReplayUpload => "replay_upload",
        ReplayTimeline => "replay_timeline",
        Replay => "replay",
        ReplayFetch => "replay_fetch",
        ReplayReserve => "replay_reserve",
        BoardMatch => "board_match",
        BoardMatches => "board_matches",
        Sessions => "sessions",
        SessionGrants => "session_grants",
        SessionLinks => "session_links",
        SessionLink => "session_link",
        SessionRotate => "session_rotate",
        Feedback => "feedback",
        Assets => "assets",
        /// The client's pages and files (the fallback).
        Page => "page",
        Other => "other",
    }
}

impl Route {
    /// The route for axum's matched path; `None` (the fallback) is a page.
    pub fn from_template(t: Option<&str>) -> Route {
        let Some(t) = t else { return Route::Page };
        match t {
            "/healthz" => Route::Healthz,
            "/ws" => Route::Ws,
            "/api/boards" => Route::Boards,
            "/api/boards/{board}/links" => Route::BoardLinks,
            "/api/boards/{board}/links/{link}" => Route::BoardLink,
            "/api/boards/{board}/owner/rotate" => Route::OwnerRotate,
            "/api/boards/{board}/clone" => Route::BoardClone,
            "/api/packs" => Route::Packs,
            "/api/matches/{id}" => Route::Match,
            "/packs/{pack}/{*file}" => Route::PackFile,
            "/api/boards/{board}/replays/{id}/upload" => Route::ReplayUpload,
            "/api/boards/{board}/replays/{id}/timeline" => Route::ReplayTimeline,
            "/api/boards/{board}/replays/{id}" => Route::Replay,
            "/api/boards/{board}/replays/{id}/fetch" => Route::ReplayFetch,
            "/api/boards/{board}/replays/{id}/reserve" => Route::ReplayReserve,
            "/api/boards/{board}/matches/{id}" => Route::BoardMatch,
            "/api/boards/{board}/matches" => Route::BoardMatches,
            "/api/sessions" => Route::Sessions,
            "/api/sessions/{board}/grants" => Route::SessionGrants,
            "/api/sessions/{board}/links" => Route::SessionLinks,
            "/api/sessions/{board}/links/{link}" => Route::SessionLink,
            "/api/sessions/{board}/owner/rotate" => Route::SessionRotate,
            "/api/feedback" => Route::Feedback,
            t if t.starts_with("/assets") => Route::Assets,
            _ => Route::Other,
        }
    }
}

label! {
    pub enum StatusClass: "status_class" {
        S1xx => "1xx",
        S2xx => "2xx",
        S3xx => "3xx",
        S4xx => "4xx",
        S5xx => "5xx",
    }
}

impl StatusClass {
    pub fn of(status: u16) -> StatusClass {
        match status {
            ..200 => StatusClass::S1xx,
            200..300 => StatusClass::S2xx,
            300..400 => StatusClass::S3xx,
            400..500 => StatusClass::S4xx,
            _ => StatusClass::S5xx,
        }
    }
}

label! {
    /// How a WebSocket ended: the server's close reason, or the client going away.
    pub enum WsEnd: "reason" {
        Unauthorized => "unauthorized",
        Revoked => "revoked",
        Abuse => "abuse",
        TooSlow => "too_slow",
        StorageFailure => "storage_failure",
        Protocol => "protocol",
        ShuttingDown => "shutting_down",
        Full => "full",
        TooMany => "too_many",
        Busy => "busy",
        Outdated => "outdated",
        /// The client closed it, or the network dropped it.
        Gone => "gone",
    }
}

impl From<Option<mapcro_engine::wire::CloseReason>> for WsEnd {
    fn from(r: Option<mapcro_engine::wire::CloseReason>) -> WsEnd {
        use mapcro_engine::wire::CloseReason as C;
        match r {
            None => WsEnd::Gone,
            Some(C::Unauthorized) => WsEnd::Unauthorized,
            Some(C::Revoked) => WsEnd::Revoked,
            Some(C::Abuse) => WsEnd::Abuse,
            Some(C::TooSlow) => WsEnd::TooSlow,
            Some(C::StorageFailure) => WsEnd::StorageFailure,
            Some(C::Protocol) => WsEnd::Protocol,
            Some(C::ShuttingDown) => WsEnd::ShuttingDown,
            Some(C::Full) => WsEnd::Full,
            Some(C::TooMany) => WsEnd::TooMany,
            Some(C::Busy) => WsEnd::Busy,
            Some(C::Outdated) => WsEnd::Outdated,
        }
    }
}

label! {
    /// Why the engine refused an op (`mapcro_schema::Reject`).
    pub enum RejectReason: "reason" {
        EmptyTx => "empty_tx",
        TooManyOps => "too_many_ops",
        TooManyRecords => "too_many_records",
        TooManyScenes => "too_many_scenes",
        IdTaken => "id_taken",
        NoSuchRecord => "no_such_record",
        Immutable => "immutable",
        WrongField => "wrong_field",
        MismatchedSetIf => "mismatched_set_if",
        TextTooLong => "text_too_long",
        BadText => "bad_text",
        OutOfBounds => "out_of_bounds",
        BadObjectiveKey => "bad_objective_key",
        BadOrderKey => "bad_order_key",
        NoSuchScene => "no_such_scene",
        NoSuchSlot => "no_such_slot",
        Duplicate => "duplicate",
        IncompleteScene => "incomplete_scene",
        LastScene => "last_scene",
        SceneCycle => "scene_cycle",
        Forbidden => "forbidden",
        BadStroke => "bad_stroke",
        TxTooLarge => "tx_too_large",
        BoardFull => "board_full",
        ServerFull => "server_full",
        WrongDocKind => "wrong_doc_kind",
        SessionFull => "session_full",
    }
}

impl From<&mapcro_schema::Reject> for RejectReason {
    fn from(r: &mapcro_schema::Reject) -> RejectReason {
        use mapcro_schema::Reject as R;
        match r {
            R::EmptyTx => RejectReason::EmptyTx,
            R::TooManyOps => RejectReason::TooManyOps,
            R::TooManyRecords => RejectReason::TooManyRecords,
            R::TooManyScenes => RejectReason::TooManyScenes,
            R::IdTaken => RejectReason::IdTaken,
            R::NoSuchRecord => RejectReason::NoSuchRecord,
            R::Immutable => RejectReason::Immutable,
            R::WrongField => RejectReason::WrongField,
            R::MismatchedSetIf => RejectReason::MismatchedSetIf,
            R::TextTooLong => RejectReason::TextTooLong,
            R::BadText => RejectReason::BadText,
            R::OutOfBounds => RejectReason::OutOfBounds,
            R::BadObjectiveKey => RejectReason::BadObjectiveKey,
            R::BadOrderKey => RejectReason::BadOrderKey,
            R::NoSuchScene => RejectReason::NoSuchScene,
            R::NoSuchSlot => RejectReason::NoSuchSlot,
            R::Duplicate => RejectReason::Duplicate,
            R::IncompleteScene => RejectReason::IncompleteScene,
            R::LastScene => RejectReason::LastScene,
            R::SceneCycle => RejectReason::SceneCycle,
            R::Forbidden => RejectReason::Forbidden,
            R::BadStroke => RejectReason::BadStroke,
            R::TxTooLarge => RejectReason::TxTooLarge,
            R::BoardFull => RejectReason::BoardFull,
            R::ServerFull => RejectReason::ServerFull,
            R::WrongDocKind => RejectReason::WrongDocKind,
            R::SessionFull => RejectReason::SessionFull,
        }
    }
}

label! {
    /// How a board came to be.
    pub enum How: "how" { New => "new", Clone => "clone", Import => "import" }
}

label! {
    /// Which tier of a match was served: the API summary or the full replay.
    pub enum Tier: "tier" { Summary => "summary", Full => "full" }
}

label! {
    /// Where a match's data came from.
    pub enum MatchPath: "path" { Cached => "cached", Fetched => "fetched", Uploaded => "uploaded" }
}

label! {
    /// deadlock-api's endpoints we call. `salts` is the free read (`disable_steam=true`),
    /// `salts_steam` the read that may ask Steam: only that one spends the 3/h budget.
    pub enum Endpoint: "endpoint" { Metadata => "metadata", SteamProfiles => "steam_profiles", Salts => "salts", SaltsSteam => "salts_steam" }
}

label! {
    /// How an upstream call ended.
    pub enum ApiResult: "result" {
        Ok => "ok",
        NotFound => "not_found",
        RateLimited => "rate_limited",
        Upstream5xx => "upstream_5xx",
        Timeout => "timeout",
        /// The answer wasn't what we read (bad JSON, missing fields).
        Shape => "shape",
        /// No answer: DNS, connect or TLS failed.
        Unreachable => "unreachable",
        /// Another 4xx, or a redirect.
        Refused => "refused",
        TooLarge => "too_large",
    }
}

impl ApiResult {
    /// A status other than 200 (which is `Ok` once the body reads).
    pub fn of_status(status: u16) -> ApiResult {
        match status {
            200 => ApiResult::Ok,
            404 => ApiResult::NotFound,
            429 => ApiResult::RateLimited,
            500.. => ApiResult::Upstream5xx,
            _ => ApiResult::Refused,
        }
    }
    /// A ureq error with no status.
    pub fn of_error(e: &ureq::Error) -> ApiResult {
        match e {
            ureq::Error::Timeout(_) => ApiResult::Timeout,
            ureq::Error::BodyExceedsLimit(_) => ApiResult::TooLarge,
            ureq::Error::Json(_) => ApiResult::Shape,
            ureq::Error::Io(io) if io.kind() == std::io::ErrorKind::TimedOut => ApiResult::Timeout,
            _ => ApiResult::Unreachable,
        }
    }
}

label! {
    /// Why the replay queue refused a transfer.
    pub enum QueueRefusal: "reason" { Busy => "busy", QueueFull => "queue_full", RateLimited => "rate_limited", Other => "other" }
}

impl QueueRefusal {
    pub fn from_code(code: &str) -> QueueRefusal {
        match code {
            "busy" => QueueRefusal::Busy,
            "queue_full" => QueueRefusal::QueueFull,
            "rate_limited" => QueueRefusal::RateLimited,
            _ => QueueRefusal::Other,
        }
    }
}

label! {
    /// How a replay job got its demo, or `client`: a timeline parsed on the user's machine
    /// (`POST …/timeline`), no demo at all.
    pub enum Source: "source" { Fetched => "fetched", Uploaded => "uploaded", Client => "client" }
}

label! {
    /// How a replay job ended: `done`, or its reason code (`mapcro_replay::reason`, and the
    /// fetch's own).
    pub enum JobOutcome: "outcome" {
        Done => "done",
        OldMap => "old_map",
        NotAReplay => "not_a_replay",
        TooLarge => "too_large",
        Timeout => "timeout",
        ParseFailed => "parse_failed",
        Corrupt => "corrupt",
        UnsupportedMode => "unsupported_mode",
        Brawl => "brawl",
        NoReplay => "no_replay",
        Expired => "expired",
        UpstreamDown => "upstream_down",
        UpstreamLimited => "upstream_limited",
        UpstreamShape => "upstream_shape",
        // A client-parsed timeline's refusals (`replays::client_timeline`).
        OutdatedParser => "outdated_parser",
        NewerParser => "newer_parser",
        NotATimeline => "not_a_timeline",
        WrongMatch => "wrong_match",
        BadEncoding => "bad_encoding",
        Other => "other",
    }
}

impl JobOutcome {
    pub fn from_code(code: &str) -> JobOutcome {
        use crate::metrics::Label;
        JobOutcome::ALL.iter().copied().find(|o| o.as_str() == code).unwrap_or(JobOutcome::Other)
    }
}

label! {
    /// Why a feedback submission didn't become an issue.
    pub enum FeedbackRejection: "reason" {
        Invalid => "invalid",
        RateLimited => "rate_limited",
        GithubError => "github_error",
        Disabled => "disabled",
    }
}

label! {
    /// A systemd unit, for its cgroup's memory and CPU.
    pub enum Unit: "unit" { Server => "mapcro", Worker => "mapcro-replay" }
}

label! {
    pub enum Cache: "cache" { Replays => "replays", Matches => "matches" }
}

// ---- buckets ----

/// Milliseconds, 1 ms to 10 s.
pub static MS: [f64; 14] = [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10000.0, 30000.0];
/// Seconds, 0.1 s to 10 min.
pub static SECS: [f64; 15] = [0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 30.0, 60.0, 120.0, 300.0, 600.0, 1800.0, 3600.0];
/// A presence frame's bytes: ~300 in Sandbox, ~450–600 in Player, ~1,450 with a laser trail
/// (docs/plans/2026-11-11-view-state-sync.md, "How it travels").
pub static PRESENCE: [f64; 11] = [128.0, 256.0, 384.0, 512.0, 640.0, 768.0, 1024.0, 1536.0, 2048.0, 4096.0, 8192.0];
/// Messages in a group commit.
pub static BATCH: [f64; 8] = [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0];
const MIB: f64 = 1024.0 * 1024.0;
/// A parse's peak resident memory.
pub static RSS: [f64; 10] = [32.0 * MIB, 64.0 * MIB, 128.0 * MIB, 192.0 * MIB, 256.0 * MIB, 384.0 * MIB, 512.0 * MIB, 640.0 * MIB, 768.0 * MIB, 1024.0 * MIB];
/// A parse's peak anonymous memory: ~32 MB for a 44-minute match (docs/research/parser-memory.md).
pub static ANON: [f64; 11] = [8.0 * MIB, 16.0 * MIB, 24.0 * MIB, 32.0 * MIB, 48.0 * MIB, 64.0 * MIB, 96.0 * MIB, 128.0 * MIB, 192.0 * MIB, 256.0 * MIB, 384.0 * MIB];
/// File sizes: a demo (~300-500 MB) or a timeline (~1-10 MB).
pub static FILE: [f64; 12] = [
    0.25 * MIB,
    MIB,
    2.0 * MIB,
    5.0 * MIB,
    10.0 * MIB,
    20.0 * MIB,
    50.0 * MIB,
    100.0 * MIB,
    200.0 * MIB,
    350.0 * MIB,
    500.0 * MIB,
    800.0 * MIB,
];

// ---- the registry ----

/// The registry's fields, each with its constructor: one line per metric. Generates
/// `Metrics`, `Metrics::new` and `Metrics::families` together, so a metric can't be recorded
/// without also being exported and snapshotted.
macro_rules! registry {
    ($($(#[$m:meta])* $field:ident : $ty:ty = $init:expr),* $(,)?) => {
        pub struct Metrics { $($(#[$m])* pub $field: $ty),* }
        impl Metrics {
            #[allow(clippy::new_without_default)]
            pub fn new() -> Metrics {
                Metrics { $($field: $init),* }
            }
            /// Every metric, for `/metrics` and the snapshot.
            pub fn families(&self) -> Vec<&dyn Family> {
                vec![$(&self.$field),*]
            }
        }
    };
}

registry! {
    // HTTP and sync
    http_requests: Counter<(Route, StatusClass)> = Counter::new("http_requests", "HTTP requests by route template and status class."),
    ws_opens: Counter<()> = Counter::new("ws_opens", "WebSockets upgraded."),
    ws_closes: Counter<(WsEnd,)> = Counter::new("ws_closes", "WebSockets ended, by close reason (gone: the client left)."),
    ops_rejected: Counter<(RejectReason,)> = Counter::new("ops_rejected", "Edits the engine refused, by reason."),
    outdated_reloads: Counter<()> = Counter::new("outdated_reloads", "Clients told to reload for an outdated build."),
    connections_open: Gauge<()> = Gauge::new("connections_open", "WebSockets open now."),
    rooms_open: Gauge<()> = Gauge::new("rooms_open", "Boards loaded in memory now."),
    commit_batch_size: Histogram<()> = Histogram::new("commit_batch_size", "Engine messages per group commit.", &BATCH),
    commit_ms: Histogram<()> = Histogram::new("commit_ms", "Milliseconds per group commit (one transaction, one fsync).", &MS),
    op_ack_ms: Histogram<()> = Histogram::new("op_ack_ms", "Milliseconds from a room taking an edit to its ack (excludes the room's queue).", &MS),
    presence_bytes: Histogram<()> = Histogram::new("presence_bytes", "Bytes in a presence frame a client sent (the whole frame, resent on every change).", &PRESENCE),
    // usage
    boards_created: Counter<(How,)> = Counter::new("boards_created", "Boards created: new, cloned or imported."),
    feedback_sent: Counter<()> = Counter::new("feedback_sent", "Feedback submissions that became GitHub issues."),
    feedback_rejected: Counter<(FeedbackRejection,)> = Counter::new("feedback_rejected", "Feedback submissions refused, by reason."),
    matches_opened: Counter<(Tier, MatchPath)> = Counter::new("matches_opened", "Matches served, by tier and where the data came from."),
    users_today: Gauge<()> = Gauge::new("users_today", "Distinct clients today (UTC), from a daily salted hash; the count only."),
    // deadlock-api
    deadlock_api_calls: Counter<(Endpoint, ApiResult)> = Counter::new("deadlock_api_calls", "Calls to deadlock-api, by endpoint and result."),
    deadlock_api_backoff_s: Gauge<()> = Gauge::new("deadlock_api_backoff_s", "Seconds left in the salts endpoint's 429 backoff."),
    // the replay queue and jobs
    queue_waiting: Gauge<()> = Gauge::new("queue_waiting", "Replay transfers waiting in line."),
    queue_bytes: Gauge<()> = Gauge::new("queue_bytes", "Bytes the replay queue holds or has reserved."),
    queue_max_bytes: Gauge<()> = Gauge::new("queue_max_bytes", "The replay queue's byte budget."),
    queue_max_waiting: Gauge<()> = Gauge::new("queue_max_waiting", "Waiting transfers past which new ones are refused."),
    parses_running: Gauge<()> = Gauge::new("parses_running", "Replay parses under way."),
    queue_refusals: Counter<(QueueRefusal,)> = Counter::new("queue_refusals", "Replay transfers refused, by reason."),
    replay_jobs: Counter<(Source, JobOutcome)> = Counter::new("replay_jobs", "Replay jobs ended, by source and outcome."),
    replay_job_s: Histogram<(Source,)> = Histogram::new("replay_job_s", "Seconds from a replay job queued to its result collected.", &SECS),
    queue_wait_s: Histogram<()> = Histogram::new("queue_wait_s", "Seconds a queued demo waited for a worker.", &SECS),
    download_s: Histogram<()> = Histogram::new("download_s", "Seconds to download a demo from Valve's CDN.", &SECS),
    decompress_s: Histogram<()> = Histogram::new("decompress_s", "Seconds to decompress a demo.", &SECS),
    parse_s: Histogram<()> = Histogram::new("parse_s", "Seconds to parse a demo and derive its timeline.", &SECS),
    publish_s: Histogram<()> = Histogram::new("publish_s", "Seconds to publish a timeline to the outbox.", &SECS),
    parse_peak_rss_bytes: Histogram<()> = Histogram::new("parse_peak_rss_bytes", "A parse's peak resident memory, with the mapped demo's file pages.", &RSS),
    parse_peak_anon_bytes: Histogram<()> = Histogram::new("parse_peak_anon_bytes", "A parse's peak anonymous memory (what a memory cap has to hold).", &ANON),
    zstd_window_bytes: Histogram<()> = Histogram::new("zstd_window_bytes", "A zstd download's window size (the decoder's memory).", &FILE),
    demo_bytes: Histogram<()> = Histogram::new("demo_bytes", "A parsed demo's size as queued.", &FILE),
    timeline_bytes: Histogram<()> = Histogram::new("timeline_bytes", "A parsed timeline's size.", &FILE),
    // storage and the host
    db_bytes: Gauge<()> = Gauge::new("db_bytes", "The database's size."),
    db_max_bytes: Gauge<()> = Gauge::new("db_max_bytes", "The database's size cap (MAX_STORAGE_BYTES)."),
    boards_stored: Gauge<()> = Gauge::new("boards_stored", "Boards stored."),
    boards_max: Gauge<()> = Gauge::new("boards_max", "The board cap (MAX_BOARDS)."),
    cache_bytes: Gauge<(Cache,)> = Gauge::new("cache_bytes", "Bytes in the match and replay caches."),
    disk_free_bytes: Gauge<()> = Gauge::new("disk_free_bytes", "Free bytes on the state directory's filesystem."),
    disk_total_bytes: Gauge<()> = Gauge::new("disk_total_bytes", "Total bytes of the state directory's filesystem."),
    unit_memory_bytes: Gauge<(Unit,)> = Gauge::new("unit_memory_bytes", "A unit's cgroup memory.current."),
    unit_memory_peak_bytes: Gauge<(Unit,)> = Gauge::new("unit_memory_peak_bytes", "A unit's cgroup memory.peak (since its start)."),
    unit_memory_max_bytes: Gauge<(Unit,)> = Gauge::new("unit_memory_max_bytes", "A unit's cgroup memory.max (absent: no cap)."),
    unit_memory_anon_bytes: Gauge<(Unit,)> = Gauge::new("unit_memory_anon_bytes", "A unit's cgroup memory.stat anon: memory that isn't page cache (development: the server's RssAnon)."),
    server_rss_peak_bytes: Gauge<()> = Gauge::new("server_rss_peak_bytes", "The server process's peak resident memory since the previous sample (VmHWM, reset each sample)."),
    unit_cpu_cores: Gauge<(Unit,)> = Gauge::new("unit_cpu_cores", "A unit's CPU use over the last minute, in cores."),
    unit_oom_kills: Gauge<(Unit,)> = Gauge::new("unit_oom_kills", "OOM kills in a unit's cgroup since its start."),
    // the collector itself
    failures_dropped: Counter<()> = Counter::new("failures_dropped", "Failure rows dropped for the per-minute cap."),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::Label;

    /// Label values are short snake_case words: nothing that could carry an id.
    fn plain<L: Label>() {
        let mut seen = std::collections::HashSet::new();
        for v in L::ALL {
            let s = v.as_str();
            assert!(!s.is_empty() && s.len() <= 24, "{}={s}", L::KEY);
            assert!(s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-'), "{}={s}", L::KEY);
            assert!(seen.insert(s), "{}={s} twice", L::KEY);
            assert_eq!(L::ALL[v.index()].as_str(), s, "index matches ALL");
        }
    }

    #[test]
    fn label_enums_are_plain_and_distinct() {
        plain::<Route>();
        plain::<StatusClass>();
        plain::<WsEnd>();
        plain::<RejectReason>();
        plain::<How>();
        plain::<Tier>();
        plain::<MatchPath>();
        plain::<Endpoint>();
        plain::<ApiResult>();
        plain::<QueueRefusal>();
        plain::<Source>();
        plain::<JobOutcome>();
        plain::<Unit>();
        plain::<Cache>();
        plain::<FeedbackRejection>();
    }

    #[test]
    fn routes_come_from_templates_never_raw_paths() {
        assert_eq!(Route::from_template(Some("/api/boards/{board}/links/{link}")), Route::BoardLink);
        assert_eq!(Route::from_template(Some("/api/matches/{id}")), Route::Match);
        assert_eq!(Route::from_template(Some("/api/feedback")), Route::Feedback);
        assert_eq!(Route::from_template(None), Route::Page);
        // A raw path (with an id in it) is never a template: it lands in `other`.
        assert_eq!(Route::from_template(Some("/api/matches/123456")), Route::Other);
    }

    #[test]
    fn every_replay_reason_has_an_outcome() {
        for r in mapcro_replay::reason::ALL {
            assert_ne!(JobOutcome::from_code(r), JobOutcome::Other, "{r}");
        }
        assert_eq!(JobOutcome::from_code("something new"), JobOutcome::Other);
    }

    #[test]
    fn metric_names_are_unique() {
        let m = Metrics::new();
        let mut seen = std::collections::HashSet::new();
        for f in m.families() {
            assert!(seen.insert(f.name()), "{} twice", f.name());
        }
    }

    #[test]
    fn status_classes() {
        assert_eq!(StatusClass::of(101), StatusClass::S1xx);
        assert_eq!(StatusClass::of(204), StatusClass::S2xx);
        assert_eq!(StatusClass::of(404), StatusClass::S4xx);
        assert_eq!(StatusClass::of(502), StatusClass::S5xx);
    }
}
