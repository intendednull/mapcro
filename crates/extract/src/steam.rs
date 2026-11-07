//! `steam.inf` parsing.

use crate::allow::GameDir;
use crate::{Error, Result};

/// The subset of `steam.inf` that identifies the installed build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SteamInfo {
    pub client_version: u64,
    pub source_revision: u64,
    pub version_date: String,
    pub version_time: String,
}

impl SteamInfo {
    /// Read and parse `steam.inf` from the game directory.
    pub fn read(game: &GameDir) -> Result<Self> {
        let text = std::fs::read_to_string(game.path("steam.inf")?)?;
        Self::parse(&text)
    }

    /// Parse the `Key=Value` lines of a `steam.inf`.
    pub fn parse(text: &str) -> Result<Self> {
        let mut client_version = None;
        let mut source_revision = None;
        let mut version_date = None;
        let mut version_time = None;

        for line in text.lines() {
            let line = line.trim().trim_start_matches('\u{feff}');
            if line.is_empty() || line.starts_with("//") {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let value = value.trim();

            match key.trim() {
                "ClientVersion" => {
                    client_version = Some(
                        value
                            .parse()
                            .map_err(|_| Error::InvalidSteamValue("ClientVersion"))?,
                    );
                }
                "SourceRevision" => {
                    source_revision = Some(
                        value
                            .parse()
                            .map_err(|_| Error::InvalidSteamValue("SourceRevision"))?,
                    );
                }
                "VersionDate" => version_date = Some(value.to_owned()),
                "VersionTime" => version_time = Some(value.to_owned()),
                _ => {}
            }
        }

        Ok(Self {
            client_version: client_version.ok_or(Error::MissingSteamField("ClientVersion"))?,
            source_revision: source_revision.ok_or(Error::MissingSteamField("SourceRevision"))?,
            version_date: version_date.ok_or(Error::MissingSteamField("VersionDate"))?,
            version_time: version_time.ok_or(Error::MissingSteamField("VersionTime"))?,
        })
    }
}
