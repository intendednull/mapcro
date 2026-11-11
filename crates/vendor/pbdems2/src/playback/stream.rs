//! Forward playback over any [`Read`], without the whole file in memory.
//!
//! mapcro patch (crates/vendor/VENDORED.md). The commands are read in order through a bounded
//! buffer: the reader's buffer, one encoded body and one decoded body. There is no index, so
//! there is no seeking, but a full forward pass needs none: the sequence of `handle_command`
//! calls and tick callbacks is the one [`super::PlaybackSession`]'s forward run makes.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read};

use super::{CheckpointAdapter, CommandContext, ParserState};
use crate::demo::{COMPRESSED_FLAG, CmdHeader, CommandFrame, HEADER_SIZE, MAGIC, command};
use crate::entity::{FieldDecodeContext, PropertyFilter};
use crate::error::{Error, Result};
use crate::limits::DecodeLimits;

/// The error context of a run that met a schema command after signon with a property
/// selection ([`StreamPlayback::project_properties`]).
pub const SCHEMA_CHANGED: &str = "schema command after signon in a run with a property selection";

/// The reader's buffer: what the stream holds besides one command's bodies.
const READ_BUFFER: usize = 256 * 1024;

/// A demo initialized through `DEM_SyncTick` from a stream, ready for one forward run.
pub struct StreamPlayback<R: Read, A> {
    reader: Commands<R>,
    state: ParserState,
    adapter: A,
    file_header: Option<Vec<u8>>,
    synced: bool,
    projected: bool,
}

/// The command stream: header and encoded body, one command at a time.
struct Commands<R: Read> {
    reader: BufReader<R>,
    offset: usize,
    index: usize,
    encoded: Vec<u8>,
    limits: DecodeLimits,
}

impl<R: Read> Commands<R> {
    /// The next command's header (its body is in `self.encoded`) and its start and end
    /// offsets, or `None` at the end of the stream. A stream that ends inside a command is an
    /// error, as in [`crate::demo::CommandIter`].
    fn next(&mut self) -> Result<Option<(CmdHeader, (usize, usize))>> {
        let start = self.offset;
        let fail = |header: Option<&CmdHeader>, source: Error| Error::Command {
            offset: start,
            command: header.map(|h| h.cmd),
            tick: header.map(|h| h.tick),
            source: Box::new(source),
        };
        if self.reader.fill_buf()?.is_empty() {
            return Ok(None);
        }
        let raw_cmd = self.varint().map_err(|e| fail(None, e))?;
        let tick = self.varint().map_err(|e| fail(None, e))?;
        let size = self.varint().map_err(|e| fail(None, e))?;
        let header = CmdHeader::new(
            (raw_cmd & !COMPRESSED_FLAG) as i32,
            tick as i32,
            raw_cmd & COMPRESSED_FLAG != 0,
            size,
        );
        let size = size as usize;
        self.limits
            .ensure(
                "encoded command body",
                size,
                self.limits.max_command_body_bytes(),
            )
            .map_err(|e| fail(Some(&header), e))?;
        self.encoded.clear();
        // Grows only as bytes arrive, so a corrupt size on a short stream can't allocate it.
        (&mut self.reader)
            .take(size as u64)
            .read_to_end(&mut self.encoded)?;
        if self.encoded.len() < size {
            let short = Error::Overflow {
                needed: size * 8,
                available: self.encoded.len() * 8,
            };
            return Err(fail(Some(&header), short));
        }
        self.offset += size;
        self.index += 1;
        Ok(Some((header, (start, self.offset))))
    }

    /// An unsigned varint of at most five bytes, as [`crate::io::ByteReader::read_uvarint32`] reads it.
    fn varint(&mut self) -> Result<u32> {
        let mut result = 0_u32;
        for i in 0..5 {
            let Some(&byte) = self.reader.fill_buf()?.first() else {
                return Err(Error::Overflow {
                    needed: 8,
                    available: 0,
                });
            };
            self.reader.consume(1);
            self.offset += 1;
            result |= u32::from(byte & 0x7f) << (7 * i);
            if byte & 0x80 == 0 {
                break;
            }
        }
        Ok(result)
    }
}

impl<R: Read, A: CheckpointAdapter> StreamPlayback<R, A> {
    /// Read the file header and the signon through `DEM_SyncTick`, as
    /// [`super::DemoParser::prepare`] does, and restore the adapter from its checkpoint
    /// there, as a session does.
    pub fn initialize(
        reader: R,
        mut adapter: A,
        default_tick_interval: f32,
    ) -> std::result::Result<Self, A::Error> {
        let limits = DecodeLimits::default();
        let mut reader = BufReader::with_capacity(READ_BUFFER, reader);
        let mut magic = [0_u8; HEADER_SIZE];
        reader.read_exact(&mut magic).map_err(|_| {
            A::Error::from(Error::Parse {
                context: "file too small for demo header".into(),
            })
        })?;
        if magic[..8] != MAGIC {
            let mut got = [0_u8; 8];
            got.copy_from_slice(&magic[..8]);
            return Err(A::Error::from(Error::InvalidMagic { got }));
        }
        let mut reader = Commands {
            reader,
            offset: HEADER_SIZE,
            index: 0,
            encoded: Vec::new(),
            limits,
        };
        let mut state = ParserState::new(default_tick_interval).map_err(A::Error::from)?;
        let mut body = Vec::new();
        let mut field_decode_context =
            FieldDecodeContext::with_limits(default_tick_interval, limits);
        let mut field_paths = Vec::new();
        let mut file_header = None;
        let mut synced = false;
        while let Some((header, span)) = reader.next().map_err(A::Error::from)? {
            match header.cmd {
                command::STOP => break,
                command::SYNC_TICK => {
                    synced = true;
                    break;
                }
                _ => {}
            }
            let frame =
                CommandFrame::streamed(reader.index - 1, span, header, &reader.encoded, limits);
            frame.decode_body(&mut body).map_err(A::Error::from)?;
            if header.cmd == command::FILE_HEADER && file_header.is_none() {
                file_header = Some(body.clone());
            }
            let mut context = CommandContext {
                state: &mut state,
                field_decode_context: &mut field_decode_context,
                field_paths: &mut field_paths,
                limits,
                class_filter: None,
            };
            adapter.handle_command(&frame, &body, &mut context)?;
        }
        state.require_initialized().map_err(A::Error::from)?;
        state.string_tables.update_instance_baselines();
        state.entities.clear_entity_changes();
        let adapter = A::from_checkpoint(&adapter.checkpoint());
        Ok(Self {
            reader,
            state,
            adapter,
            file_header,
            synced,
            projected: false,
        })
    }

    /// Parser state after signon.
    pub const fn state(&self) -> &ParserState {
        &self.state
    }

    /// The adapter, to configure before the run.
    pub const fn adapter_mut(&mut self) -> &mut A {
        &mut self.adapter
    }

    /// The decoded body of the first `DEM_FileHeader`, if the signon had one.
    pub fn file_header(&self) -> Option<&[u8]> {
        self.file_header.as_deref()
    }

    /// Keep only the selected properties, as
    /// [`super::PreparedPlayback::session_with_properties`] does. A stream can't know ahead
    /// whether schema commands follow signon, so the run fails if one does; play the demo
    /// again without a selection then.
    pub fn project_properties(
        &mut self,
        filter: PropertyFilter,
    ) -> std::result::Result<(), A::Error> {
        self.state
            .entities
            .project_properties(filter, &self.state.serializers)
            .map_err(A::Error::from)?;
        self.projected = true;
        Ok(())
    }

    /// Play to the end, creating only `class_filter`'s entities: the forward run of
    /// [`super::PlaybackSession::try_run_to_end_filtered_with_adapter`].
    pub fn try_run_to_end_filtered_with_adapter<F>(
        mut self,
        class_filter: &HashSet<&str>,
        mut on_tick: F,
    ) -> std::result::Result<ParserState, A::Error>
    where
        F: FnMut(&ParserState, &mut A) -> std::result::Result<(), A::Error>,
    {
        if !self.synced {
            return Ok(self.state);
        }
        let limits = self.reader.limits;
        let state = &mut self.state;
        let adapter = &mut self.adapter;
        let mut body = Vec::new();
        let mut field_decode_context = FieldDecodeContext::with_limits(state.tick_interval, limits);
        let mut field_paths = Vec::new();
        let mut last_tick = None;
        let mut emitted_final_tick = false;
        while let Some((header, span)) = self.reader.next().map_err(A::Error::from)? {
            if last_tick.is_some_and(|last| last != header.tick) {
                on_tick(state, adapter)?;
                state.clear_tick_changes();
            }
            last_tick = Some(header.tick);
            state.tick = header.tick;
            if header.cmd == command::STOP {
                if header.tick >= 0 {
                    on_tick(state, adapter)?;
                    emitted_final_tick = true;
                }
                break;
            }
            if self.projected && matches!(header.cmd, command::SEND_TABLES | command::CLASS_INFO) {
                return Err(A::Error::from(Error::Parse {
                    context: SCHEMA_CHANGED.into(),
                }));
            }
            let frame = CommandFrame::streamed(
                self.reader.index - 1,
                span,
                header,
                &self.reader.encoded,
                limits,
            );
            frame.decode_body(&mut body).map_err(A::Error::from)?;
            let mut context = CommandContext {
                state,
                field_decode_context: &mut field_decode_context,
                field_paths: &mut field_paths,
                limits,
                class_filter: Some(class_filter),
            };
            adapter.handle_command(&frame, &body, &mut context)?;
        }
        if !emitted_final_tick && last_tick.is_some_and(|tick| tick >= 0) {
            on_tick(state, adapter)?;
        }
        Ok(self.state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds one byte per read, so every header crosses the reader's buffer.
    struct Trickle<'a>(&'a [u8]);

    impl Read for Trickle<'_> {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let Some((&b, rest)) = self.0.split_first() else {
                return Ok(0);
            };
            if out.is_empty() {
                return Ok(0);
            }
            out[0] = b;
            self.0 = rest;
            Ok(1)
        }
    }

    fn demo() -> Vec<u8> {
        let mut bytes = Vec::from(MAGIC);
        bytes.resize(HEADER_SIZE, 0);
        // A two-byte command id and tick, and bodies of 0, 3 and 200 bytes.
        for (cmd, tick, len) in [(7_u32, 300_u32, 3_usize), (7, 300, 200), (0, 301, 0)] {
            for v in [cmd, tick, len as u32] {
                let mut v = v;
                loop {
                    let b = (v & 0x7f) as u8;
                    v >>= 7;
                    bytes.push(if v == 0 { b } else { b | 0x80 });
                    if v == 0 {
                        break;
                    }
                }
            }
            bytes.extend((0..len).map(|i| i as u8));
        }
        bytes
    }

    fn read_all(reader: impl Read) -> Vec<(i32, i32, Vec<u8>, (usize, usize))> {
        let mut commands = Commands {
            reader: BufReader::with_capacity(4, reader),
            offset: 0,
            index: 0,
            encoded: Vec::new(),
            limits: DecodeLimits::default(),
        };
        let mut out = Vec::new();
        while let Some((h, span)) = commands.next().expect("reads") {
            out.push((h.cmd, h.tick, commands.encoded.clone(), span));
        }
        out
    }

    #[test]
    fn streamed_commands_match_the_borrowed_iterator() {
        let bytes = demo();
        let demo = crate::demo::Demo::new(&bytes).expect("demo");
        let borrowed: Vec<_> = demo
            .commands()
            .map(|f| f.expect("frame"))
            .map(|f| {
                (
                    f.header().cmd,
                    f.header().tick,
                    f.encoded_body().to_vec(),
                    (f.offset() - HEADER_SIZE, f.end_offset() - HEADER_SIZE),
                )
            })
            .collect();
        assert_eq!(borrowed.len(), 3);
        assert_eq!(read_all(&bytes[HEADER_SIZE..]), borrowed);
        assert_eq!(read_all(Trickle(&bytes[HEADER_SIZE..])), borrowed);
    }

    #[test]
    fn a_short_stream_is_an_error_not_an_end() {
        let bytes = demo();
        for cut in [HEADER_SIZE + 1, HEADER_SIZE + 8, bytes.len() - 1] {
            let mut commands = Commands {
                reader: BufReader::with_capacity(4, &bytes[HEADER_SIZE..cut]),
                offset: 0,
                index: 0,
                encoded: Vec::new(),
                limits: DecodeLimits::default(),
            };
            let mut result = Ok(Some((CmdHeader::new(0, 0, false, 0), (0, 0))));
            while let Ok(Some(_)) = result {
                result = commands.next();
            }
            assert!(result.is_err(), "cut at {cut}");
        }
    }
}
