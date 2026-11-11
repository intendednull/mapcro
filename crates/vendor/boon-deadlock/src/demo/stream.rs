//! A forward parse from any [`Read`], without mapping or loading the whole demo.
//!
//! mapcro patch (crates/vendor/VENDORED.md): [`StreamParser`] is [`super::Parser`]'s
//! `run_to_end_with_properties` over [`pbdems2::StreamPlayback`]. It reads the commands in
//! order through a bounded buffer and can't seek.

use std::collections::HashSet;
use std::io::Read;

use boon_proto::proto::CDemoFileHeader;
use pbdems2::StreamPlayback;
use prost::Message;

use super::adapter::CitadelAdapter;
use super::parser::{Context, GameEvent};
use crate::entity::{ClassInfo, SerializerContainer};
use crate::error::{Error, Result};

impl Error {
    /// Whether a [`StreamParser`] run with a property selection met a schema command after
    /// signon: the demo needs a run without the selection.
    pub fn is_schema_change(&self) -> bool {
        matches!(self, Error::Pbdems2(pbdems2::Error::Parse { context }) if context == pbdems2::playback::SCHEMA_CHANGED)
    }
}

const DEFAULT_TICK_INTERVAL: f32 = 1.0 / 30.0;

/// A demo stream read through signon (`DEM_SyncTick`), ready for one forward run.
pub struct StreamParser<R: Read> {
    playback: StreamPlayback<R, CitadelAdapter>,
}

impl<R: Read> StreamParser<R> {
    /// Check the magic and read the signon.
    pub fn new(reader: R) -> Result<Self> {
        Ok(Self {
            playback: StreamPlayback::initialize(
                reader,
                CitadelAdapter::default(),
                DEFAULT_TICK_INTERVAL,
            )?,
        })
    }

    /// The demo's `DEM_FileHeader`, read during signon.
    pub fn file_header(&self) -> Result<CDemoFileHeader> {
        let body = self.playback.file_header().ok_or_else(|| Error::Parse {
            context: "DEM_FileHeader not found".into(),
        })?;
        CDemoFileHeader::decode(body).map_err(Error::from)
    }

    /// Network class information from signon ([`super::Parser::parse_class_info`]).
    pub fn class_info(&self) -> &ClassInfo {
        self.playback.state().class_info()
    }

    /// Send tables from signon ([`super::Parser::parse_send_tables`]).
    pub fn serializers(&self) -> &SerializerContainer {
        self.playback.state().serializers()
    }

    /// [`super::Parser::run_to_end_with_properties`] over the stream. With a property
    /// selection, a demo whose schema changes after signon fails here, where the mapped
    /// parser falls back to full decoding ([`Error::is_schema_change`]): run it again with
    /// no selection.
    pub fn run_to_end_with_properties<F>(
        mut self,
        class_filter: &HashSet<&str>,
        properties: &[(&str, &[&str])],
        event_types: Option<&HashSet<u32>>,
        mut on_tick: F,
    ) -> Result<()>
    where
        F: FnMut(&Context, &[GameEvent]),
    {
        if !properties.is_empty() {
            let filter = pbdems2::PropertyFilter::new(
                self.playback.state().serializers(),
                properties
                    .iter()
                    .map(|&(class, paths)| (class, paths.iter().copied())),
            );
            self.playback.project_properties(filter)?;
        }
        let collect = event_types.is_some();
        if let Some(event_types) = event_types {
            self.playback.adapter_mut().enable_event_types(event_types);
        }
        self.playback
            .try_run_to_end_filtered_with_adapter(class_filter, |state, adapter| {
                if collect {
                    on_tick(state, adapter.tick_events());
                    adapter.clear_tick_events();
                } else {
                    on_tick(state, &[]);
                }
                Ok(())
            })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use boon_proto::proto::{CDemoFileHeader, CDemoSendTables, EDemoCommands};

    /// The demo of `property_selection_falls_back_for_later_schema_commands`, with a file
    /// header first.
    fn later_schema() -> Vec<u8> {
        let mut bytes = b"PBDEMS2\0".to_vec();
        bytes.extend([0; 8]);
        let tables = CDemoSendTables {
            data: Some(vec![0]),
        }
        .encode_to_vec();
        let header = CDemoFileHeader {
            game_directory: Some("citadel".into()),
            ..Default::default()
        }
        .encode_to_vec();
        for (command, tick, body) in [
            (EDemoCommands::DemFileHeader, 0, header),
            (EDemoCommands::DemSendTables, 0, tables.clone()),
            (EDemoCommands::DemClassInfo, 0, Vec::new()),
            (EDemoCommands::DemSyncTick, 0, Vec::new()),
            (EDemoCommands::DemSendTables, 1, tables),
            (EDemoCommands::DemStop, 2, Vec::new()),
        ] {
            for value in [command as u64, tick, body.len() as u64] {
                prost::encoding::encode_varint(value, &mut bytes);
            }
            bytes.extend(body);
        }
        bytes
    }

    #[test]
    fn a_selection_meeting_a_later_schema_asks_for_a_full_run() {
        let bytes = later_schema();
        let parser = StreamParser::new(&bytes[..]).unwrap();
        assert_eq!(
            parser.file_header().unwrap().game_directory.as_deref(),
            Some("citadel")
        );
        let error = parser
            .run_to_end_with_properties(
                &Default::default(),
                &[("Missing", &["optional"])],
                None,
                |_, _| {},
            )
            .unwrap_err();
        assert!(error.is_schema_change(), "{error}");
        // Without a selection the same stream plays to the end, each tick once.
        let mut ticks = Vec::new();
        StreamParser::new(&bytes[..])
            .unwrap()
            .run_to_end_with_properties(&Default::default(), &[], None, |ctx, _| {
                ticks.push(ctx.tick())
            })
            .unwrap();
        let mut mapped = Vec::new();
        super::super::Parser::from_bytes(bytes)
            .run_to_end_with_properties(&Default::default(), &[], None, |ctx, _| {
                mapped.push(ctx.tick())
            })
            .unwrap();
        assert_eq!(ticks, mapped);
        assert_eq!(ticks, [1, 2]);
    }

    #[test]
    fn a_stream_that_is_not_a_demo_fails_at_once() {
        assert!(matches!(
            StreamParser::new(&b"NOTADEMO--------"[..]),
            Err(Error::Pbdems2(pbdems2::Error::InvalidMagic { .. }))
        ));
        assert!(StreamParser::new(&b"PBDEMS2\0"[..]).is_err());
    }
}
