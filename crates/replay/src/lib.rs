//! mapcro's replay tier (spec §6a): a Deadlock `.dem` becomes a compact match timeline.
//!
//! - [`timeline`]: the format the worker writes and the server serves, and the checks the server
//!   applies before trusting a worker's output (the worker parses untrusted files, so its output
//!   is untrusted too).
//! - [`map`]: the current map's objective sites and lane curves, and the lane projection the web
//!   client uses for `Wave.t`.
//! - [`derive`]: per-second observations to a timeline. Pure; unit-tested without a replay.
//! - `parse` (feature `parse`): boon reads a demo into observations.
//! - `worker` (feature `parse`): the on-disk queue, run as its own sandboxed service.

pub mod derive;
pub mod map;
mod map_data;
pub mod timeline;

#[cfg(feature = "parse")]
pub mod parse;
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

/// Short reasons a job fails with. The server shows these as labels; nothing else leaves the
/// worker.
pub mod reason {
    pub const OLD_MAP: &str = "old_map";
    pub const NOT_A_REPLAY: &str = "not_a_replay";
    pub const TOO_LARGE: &str = "too_large";
    pub const TIMEOUT: &str = "timeout";
    pub const PARSE_FAILED: &str = "parse_failed";
    pub const ALL: [&str; 5] = [OLD_MAP, NOT_A_REPLAY, TOO_LARGE, TIMEOUT, PARSE_FAILED];
}

/// A queue job's name: `<match id>-<scope>`, `[0-9a-z-]`, at most 64 bytes (worker.rs).
pub fn valid_job(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || b == b'-')
        && name.split('-').next().is_some_and(|m| !m.is_empty() && m.len() <= 12 && m.bytes().all(|b| b.is_ascii_digit()))
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
