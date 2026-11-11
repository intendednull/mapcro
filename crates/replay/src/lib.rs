//! mapcro's replay tier (spec §6a): a Deadlock `.dem` becomes a compact match timeline.
//!
//! - [`timeline`]: the format the worker writes and the server serves, and the checks the server
//!   applies before trusting a worker's output (the worker parses untrusted files, so its output
//!   is untrusted too).
//! - [`map`]: the current map's objective sites and lane curves, and the lane projection the web
//!   client uses for `Wave.t`.
//! - [`derive`]: per-second observations to a timeline. Pure; unit-tested without a replay.
//! - [`stat_calc`]: calculated hero stats from a build and a patch's game data (spike).
//! - `parse` (feature `parse`): boon reads a demo into observations.
//! - `worker` (feature `parse`): the on-disk queue, run as its own sandboxed service.

pub mod derive;
pub mod hero_data;
pub mod map;
mod map_data;
pub mod modifiers;
pub mod stat_calc;
pub mod timeline;

#[cfg(feature = "parse")]
pub mod parse;
#[cfg(feature = "parse")]
pub mod parse_hero;
#[cfg(feature = "parse")]
pub mod worker;

/// Source 2 demo files start with these eight bytes.
pub const DEM_MAGIC: &[u8; 8] = b"PBDEMS2\0";
/// bzip2 streams start with `BZh` and a block size digit.
pub fn is_bz2(head: &[u8]) -> bool {
    head.len() >= 4 && &head[..3] == b"BZh" && (b'1'..=b'9').contains(&head[3])
}
/// zstd frames start with this magic (Valve's replay CDN switched to zstd on 2026-07-20).
pub const ZSTD_MAGIC: &[u8; 4] = &[0x28, 0xB5, 0x2F, 0xFD];

/// The first content build with the current map's coordinate encoding and layout (City Never
/// Sleeps, 2026-09-29). Older demos are refused as `old_map` (research §3.5, exploration §8).
pub const FIRST_CURRENT_BUILD: u32 = 6712;

/// The game rules' `m_eGameMode` for the standard 6v6 match (`k_ECitadelGameMode_Normal`); Street
/// Brawl is [`STREET_BRAWL`]. Any other mode is refused.
pub const STANDARD_GAME_MODE: i64 = 1;
/// `k_ECitadelGameMode_StreetBrawl` (4v4).
pub const STREET_BRAWL: i64 = 4;

/// Short reasons a job fails with. The server shows these as labels; nothing else leaves the
/// worker.
pub mod reason {
    pub const OLD_MAP: &str = "old_map";
    pub const NOT_A_REPLAY: &str = "not_a_replay";
    pub const TOO_LARGE: &str = "too_large";
    pub const TIMEOUT: &str = "timeout";
    pub const PARSE_FAILED: &str = "parse_failed";
    /// The demo changed or shrank while being read (SIGBUS on the memory map).
    pub const CORRUPT: &str = "corrupt";
    /// Not the standard 6v6 mode: our map, lanes and objectives don't describe it (2026-11-08).
    /// Street Brawl has its own label; any other mode is `unsupported_mode`.
    pub const UNSUPPORTED_MODE: &str = "unsupported_mode";
    pub const BRAWL: &str = "brawl";
    pub const ALL: [&str; 8] = [OLD_MAP, NOT_A_REPLAY, TOO_LARGE, TIMEOUT, PARSE_FAILED, CORRUPT, UNSUPPORTED_MODE, BRAWL];
}

/// A queue job's name: `<match id>-<scope>`, `[0-9a-z-]`, at most 64 bytes (worker.rs).
pub fn valid_job(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || b == b'-')
        && name.split('-').next().is_some_and(|m| !m.is_empty() && m.len() <= 12 && m.bytes().all(|b| b.is_ascii_digit()))
}

/// The worker's record of one job (docs/specs/observability.md §2, per-job record): its phase
/// times, its peak memory and its sizes. The worker writes it to `outbox/<job>.stats` before
/// the job's result; the server reads it when it collects the result, into its histograms,
/// and deletes it. Numbers only: nothing about the match is kept.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct JobStats {
    /// From the demo landing in the inbox to the worker starting it.
    pub queue_wait_s: Option<f64>,
    /// Expanding a compressed demo (absent for a raw `.dem`).
    pub decompress_s: Option<f64>,
    /// Parsing the demo and deriving its timeline.
    pub parse_s: Option<f64>,
    /// Copying the timeline into the outbox.
    pub publish_s: Option<f64>,
    /// The parse's peak resident memory (its child's `VmHWM`).
    pub peak_rss_bytes: Option<u64>,
    /// The demo as queued (compressed or not).
    pub demo_bytes: Option<u64>,
    pub timeline_bytes: Option<u64>,
}

impl JobStats {
    /// A record file is at most this big.
    pub const MAX_BYTES: u64 = 4096;
}

/// The per-job record's extension, in `outbox/` (and the child's copy in `work/`).
pub const STATS_EXT: &str = "stats";

/// The server's parse order for queued jobs, in `inbox/` (spec §6a, the queue): one job name a
/// line, first to run first. The server writes it (fair across clients); the worker reads it and
/// runs listed jobs in that order, then any others oldest first. A dot name, so it's never a job.
pub const ORDER_FILE: &str = ".order";
/// The order file's size cap: a few hundred names.
pub const ORDER_MAX_BYTES: u64 = 64 * 1024;

/// The job names in an order file, in order: valid names only, each once.
pub fn read_order(bytes: &[u8]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    String::from_utf8_lossy(bytes).lines().map(str::trim).filter(|j| valid_job(j) && seen.insert(j.to_string())).map(str::to_owned).collect()
}

/// The match id a job name starts with.
pub fn job_match_id(job: &str) -> u64 {
    job.split('-').next().and_then(|m| m.parse().ok()).unwrap_or(0)
}

/// The content build in a demo header's `game_directory` (`…/citadel_v6813/…`). The header's
/// `build_num` is the engine build, not the map's (exploration §1).
pub fn content_build(game_directory: &str) -> Option<u32> {
    let rest = game_directory.split("citadel_v").nth(1)?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_build_comes_from_the_game_directory() {
        assert_eq!(content_build("/home/server/citadel_v6813/game/citadel"), Some(6813));
        assert_eq!(content_build("citadel_v6683"), Some(6683));
        assert_eq!(content_build("citadel"), None);
        assert_eq!(content_build("citadel_vX"), None);
    }

    #[test]
    fn magics() {
        assert!(is_bz2(b"BZh91AY"));
        assert!(!is_bz2(b"BZh0"));
        assert!(!is_bz2(b"PBDEMS2\0"));
    }
}
