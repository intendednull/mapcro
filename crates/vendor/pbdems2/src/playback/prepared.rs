//! Reusable signon checkpoints and independent playback sessions.

use std::collections::HashSet;

use crate::PropertyFilter;
use crate::demo::DemoIndex;
use crate::error::Error;
use crate::limits::DecodeLimits;

use super::{DemoAdapter, DemoParser, ParserState, segment_replay_end_tick};

/// A game adapter that can save semantic state and restore a fresh run.
///
/// Checkpoints should omit transient allocations such as packet scratch
/// buffers and per-tick output. This lets one prepared playback seed create
/// inexpensive, isolated sessions for repeated or parallel decoding.
pub trait CheckpointAdapter: DemoAdapter + Sized {
    /// Semantic adapter state and configuration required to continue playback.
    type Checkpoint;

    /// Capture the adapter state after signon or a completed gameplay tick.
    fn checkpoint(&self) -> Self::Checkpoint;

    /// Construct an independent adapter from a checkpoint.
    fn from_checkpoint(checkpoint: &Self::Checkpoint) -> Self;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DemoIdentity {
    address: usize,
    length: usize,
    limits: DecodeLimits,
}

/// One independently decodable range bounded by full-packet keyframes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct PlaybackSegment {
    start_offset: Option<usize>,
    end_tick: i32,
}

impl PlaybackSegment {
    /// Absolute byte offset of the starting full packet.
    ///
    /// The first segment returns `None` and starts from the post-signon
    /// baseline instead.
    pub const fn start_offset(&self) -> Option<usize> {
        self.start_offset
    }

    /// Exclusive tick boundary passed to segmented playback.
    ///
    /// The final segment uses `i32::MAX` so it runs through the end of the demo.
    pub const fn end_tick(&self) -> i32 {
        self.end_tick
    }
}

impl DemoIdentity {
    fn new(parser: &DemoParser<'_>) -> Self {
        let data = parser.demo.data();
        Self {
            address: data.as_ptr() as usize,
            length: data.len(),
            limits: parser.demo.limits(),
        }
    }

    fn matches(&self, parser: &DemoParser<'_>) -> bool {
        *self == Self::new(parser)
    }
}

/// Decoded signon state and seek metadata reusable across playback runs.
///
/// This value does not borrow the encoded demo, so an owning Awpy or Boon
/// parser can cache it without becoming self-referential. A session validates
/// that its borrowed DemoParser views the same allocation with the same decode
/// limits.
///
/// The value is automatically Send and Sync when the adapter checkpoint and
/// neutral parser state are, allowing independent sessions to be created from
/// scoped worker threads.
pub struct PreparedPlayback<A: CheckpointAdapter> {
    initial_state: ParserState,
    adapter_checkpoint: A::Checkpoint,
    index: DemoIndex,
    identity: DemoIdentity,
}

impl<A: CheckpointAdapter> PreparedPlayback<A> {
    /// Neutral parser state captured immediately after signon.
    pub const fn initial_state(&self) -> &ParserState {
        &self.initial_state
    }

    /// Header-only index built during preparation.
    pub const fn index(&self) -> &DemoIndex {
        &self.index
    }

    /// Split playback into at most `max_segments` full-packet-bounded ranges.
    ///
    /// Segment zero starts from the post-signon baseline. Every later segment
    /// starts at an evenly spaced full packet, and each non-final segment ends
    /// immediately before the next segment's keyframe tick. A zero budget is
    /// treated as one. The result is never empty, even when the demo has no
    /// full packets.
    pub fn segment_plan(&self, max_segments: usize) -> Vec<PlaybackSegment> {
        let full_packets = self.index.full_packets();
        let interval_count = full_packets.len().saturating_add(1);
        let count = max_segments.max(1).min(interval_count);
        let boundary_index = |segment: usize| segment * interval_count / count - 1;
        (0..count)
            .map(|i| PlaybackSegment {
                start_offset: (i != 0).then(|| full_packets[boundary_index(i)].offset()),
                end_tick: if i == count - 1 {
                    i32::MAX
                } else {
                    full_packets[boundary_index(i + 1)].tick()
                },
            })
            .collect()
    }

    /// Create an isolated one-run session over the original demo allocation.
    pub fn session<'demo, 'prepared>(
        &'prepared self,
        parser: DemoParser<'demo>,
    ) -> std::result::Result<PlaybackSession<'demo, 'prepared, A>, A::Error> {
        if !self.identity.matches(&parser) {
            return Err(A::Error::from(Error::Parse {
                context: "prepared playback belongs to a different demo buffer or decode limits"
                    .into(),
            }));
        }

        Ok(PlaybackSession {
            parser,
            prepared: self,
            state: self.initial_state.clone(),
            adapter: A::from_checkpoint(&self.adapter_checkpoint),
        })
    }
    /// Create an independent session with a fixed property selection.
    ///
    /// Compile the filter from [`Self::initial_state`]'s serializers. Initial
    /// entities, baselines, deltas, seeks, segments, and checkpoints all retain
    /// the same selection. Omitted values cannot be recovered by widening it;
    /// create a new session instead. Unlisted classes remain fully decoded.
    pub fn session_with_properties<'demo, 'prepared>(
        &'prepared self,
        parser: DemoParser<'demo>,
        properties: PropertyFilter,
    ) -> std::result::Result<PlaybackSession<'demo, 'prepared, A>, A::Error> {
        let mut session = self.session(parser)?;
        session
            .state
            .entities
            .project_properties(properties, &session.state.serializers)
            .map_err(A::Error::from)?;
        Ok(session)
    }
}

/// One independent playback run restored from a PreparedPlayback seed.
///
/// Playback methods consume the session so its mutable entity, string-table,
/// and adapter state cannot accidentally leak into another run.
pub struct PlaybackSession<'demo, 'prepared, A: CheckpointAdapter> {
    parser: DemoParser<'demo>,
    prepared: &'prepared PreparedPlayback<A>,
    state: ParserState,
    adapter: A,
}

/// Exact completed-tick state, next command cursor, and adapter configuration.
///
/// Unlike a full-packet seek, continuation preserves all prior packet deltas.
/// The demo allocation, decode limits, and entity filter cannot change.
pub struct PlaybackCheckpoint<A: CheckpointAdapter> {
    state: ParserState,
    adapter_checkpoint: A::Checkpoint,
    next_offset: usize,
    identity: DemoIdentity,
    classes: HashSet<String>,
}

impl<A: CheckpointAdapter> PlaybackCheckpoint<A> {
    /// State at the last completed tick, without per-tick change records.
    pub const fn state(&self) -> &ParserState {
        &self.state
    }

    /// Continue through an inclusive tick using the original entity filter.
    /// The checkpoint remains reusable for independent continuations.
    pub fn replay_through<F>(
        &self,
        parser: DemoParser<'_>,
        target_tick: i32,
        on_tick: F,
    ) -> std::result::Result<Self, A::Error>
    where
        F: FnMut(&ParserState, &mut A) -> std::result::Result<(), A::Error>,
    {
        if !self.identity.matches(&parser) || target_tick < self.state.tick() {
            return Err(A::Error::from(Error::Parse {
                context: "checkpoint requires the original demo and a nondecreasing tick".into(),
            }));
        }
        let classes = self.classes.iter().map(String::as_str).collect();
        Self::capture(
            parser,
            self.state.clone(),
            A::from_checkpoint(&self.adapter_checkpoint),
            self.next_offset,
            target_tick,
            &classes,
            on_tick,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn capture<F>(
        parser: DemoParser<'_>,
        mut state: ParserState,
        mut adapter: A,
        start: usize,
        target_tick: i32,
        classes: &HashSet<&str>,
        on_tick: F,
    ) -> std::result::Result<Self, A::Error>
    where
        F: FnMut(&ParserState, &mut A) -> std::result::Result<(), A::Error>,
    {
        let next_offset = parser.replay_cursor(
            &mut adapter,
            &mut state,
            start,
            Some(target_tick),
            Some(classes),
            on_tick,
        )?;
        state.clear_tick_changes();
        Ok(Self {
            state,
            adapter_checkpoint: adapter.checkpoint(),
            next_offset,
            identity: DemoIdentity::new(&parser),
            classes: classes.iter().map(|name| (*name).to_owned()).collect(),
        })
    }
}

impl<'demo, A: CheckpointAdapter> PlaybackSession<'demo, '_, A> {
    /// Replay packet deltas from signon and capture an exact inclusive tick.
    pub fn checkpoint_through<F>(
        self,
        target_tick: i32,
        classes: &HashSet<&str>,
        on_tick: F,
    ) -> std::result::Result<PlaybackCheckpoint<A>, A::Error>
    where
        F: FnMut(&ParserState, &mut A) -> std::result::Result<(), A::Error>,
    {
        PlaybackCheckpoint::capture(
            self.parser,
            self.state,
            self.adapter,
            self.prepared
                .index
                .stream_start()
                .unwrap_or(self.parser.demo.data().len()),
            target_tick,
            classes,
            on_tick,
        )
    }
    /// Initial session state before playback begins.
    pub const fn state(&self) -> &ParserState {
        &self.state
    }

    /// Restored game adapter for this session.
    pub const fn adapter(&self) -> &A {
        &self.adapter
    }

    /// Mutably configure or inspect the restored game adapter before playback.
    pub const fn adapter_mut(&mut self) -> &mut A {
        &mut self.adapter
    }

    /// Decode every post-signon command with an infallible state callback.
    pub fn run_to_end<F>(self, on_tick: F) -> std::result::Result<ParserState, A::Error>
    where
        F: FnMut(&ParserState),
    {
        let mut on_tick = on_tick;
        self.try_run_to_end(|state| {
            on_tick(state);
            Ok(())
        })
    }

    /// Decode every post-signon command with a fallible state callback.
    pub fn try_run_to_end<F>(self, on_tick: F) -> std::result::Result<ParserState, A::Error>
    where
        F: FnMut(&ParserState) -> std::result::Result<(), A::Error>,
    {
        let mut on_tick = on_tick;
        self.try_run_to_end_with_adapter(|state, _| on_tick(state))
    }

    /// Decode every command and expose mutable adapter state at each tick.
    pub fn run_to_end_with_adapter<F>(
        self,
        on_tick: F,
    ) -> std::result::Result<ParserState, A::Error>
    where
        F: FnMut(&ParserState, &mut A),
    {
        let mut on_tick = on_tick;
        self.try_run_to_end_with_adapter(|state, adapter| {
            on_tick(state, adapter);
            Ok(())
        })
    }

    /// Fallible full playback with mutable adapter access at each tick.
    pub fn try_run_to_end_with_adapter<F>(
        mut self,
        on_tick: F,
    ) -> std::result::Result<ParserState, A::Error>
    where
        F: FnMut(&ParserState, &mut A) -> std::result::Result<(), A::Error>,
    {
        if let Some(start) = self.prepared.index.stream_start() {
            self.parser.replay(
                &mut self.adapter,
                &mut self.state,
                start,
                None,
                None,
                on_tick,
            )?;
        }
        Ok(self.state)
    }

    /// Decode every command while materializing only filtered entity classes.
    pub fn run_to_end_filtered<F>(
        self,
        class_filter: &HashSet<&str>,
        on_tick: F,
    ) -> std::result::Result<ParserState, A::Error>
    where
        F: FnMut(&ParserState),
    {
        let mut on_tick = on_tick;
        self.try_run_to_end_filtered(class_filter, |state| {
            on_tick(state);
            Ok(())
        })
    }

    /// Fallible filtered playback with a state-only callback.
    pub fn try_run_to_end_filtered<F>(
        self,
        class_filter: &HashSet<&str>,
        on_tick: F,
    ) -> std::result::Result<ParserState, A::Error>
    where
        F: FnMut(&ParserState) -> std::result::Result<(), A::Error>,
    {
        let mut on_tick = on_tick;
        self.try_run_to_end_filtered_with_adapter(class_filter, |state, _| on_tick(state))
    }

    /// Filter entities and expose mutable adapter state at each tick.
    pub fn run_to_end_filtered_with_adapter<F>(
        self,
        class_filter: &HashSet<&str>,
        on_tick: F,
    ) -> std::result::Result<ParserState, A::Error>
    where
        F: FnMut(&ParserState, &mut A),
    {
        let mut on_tick = on_tick;
        self.try_run_to_end_filtered_with_adapter(class_filter, |state, adapter| {
            on_tick(state, adapter);
            Ok(())
        })
    }

    /// Fallible filtered playback with mutable adapter access at each tick.
    pub fn try_run_to_end_filtered_with_adapter<F>(
        mut self,
        class_filter: &HashSet<&str>,
        on_tick: F,
    ) -> std::result::Result<ParserState, A::Error>
    where
        F: FnMut(&ParserState, &mut A) -> std::result::Result<(), A::Error>,
    {
        if let Some(start) = self.prepared.index.stream_start() {
            self.parser.replay(
                &mut self.adapter,
                &mut self.state,
                start,
                None,
                Some(class_filter),
                on_tick,
            )?;
        }
        Ok(self.state)
    }

    /// Seek from the nearest full packet and replay through target_tick.
    pub fn parse_to_tick(mut self, target_tick: i32) -> std::result::Result<ParserState, A::Error> {
        let start = self
            .prepared
            .index
            .full_packet_at_or_before(target_tick)
            .map(|position| position.offset())
            .or(self.prepared.index.stream_start());
        if let Some(start) = start {
            self.parser.replay(
                &mut self.adapter,
                &mut self.state,
                start,
                Some(target_tick),
                None,
                |_, _| Ok(()),
            )?;
        }
        Ok(self.state)
    }

    /// Decode one segment with an infallible state callback.
    ///
    /// A full-packet restart is exact only for classes the game fully
    /// re-keyframes in that snapshot. The consumer must choose a compatible
    /// class_filter.
    pub fn decode_segment<F>(
        self,
        start: Option<usize>,
        end_tick: i32,
        class_filter: &HashSet<&str>,
        on_tick: F,
    ) -> std::result::Result<ParserState, A::Error>
    where
        F: FnMut(&ParserState),
    {
        let mut on_tick = on_tick;
        self.try_decode_segment(start, end_tick, class_filter, |state| {
            on_tick(state);
            Ok(())
        })
    }

    /// Decode one segment with a fallible state callback.
    pub fn try_decode_segment<F>(
        self,
        start: Option<usize>,
        end_tick: i32,
        class_filter: &HashSet<&str>,
        on_tick: F,
    ) -> std::result::Result<ParserState, A::Error>
    where
        F: FnMut(&ParserState) -> std::result::Result<(), A::Error>,
    {
        let mut on_tick = on_tick;
        self.try_decode_segment_with_adapter(start, end_tick, class_filter, |state, _| {
            on_tick(state)
        })
    }

    /// Decode one segment and expose mutable adapter state at each tick.
    pub fn decode_segment_with_adapter<F>(
        self,
        start: Option<usize>,
        end_tick: i32,
        class_filter: &HashSet<&str>,
        on_tick: F,
    ) -> std::result::Result<ParserState, A::Error>
    where
        F: FnMut(&ParserState, &mut A),
    {
        let mut on_tick = on_tick;
        self.try_decode_segment_with_adapter(start, end_tick, class_filter, |state, adapter| {
            on_tick(state, adapter);
            Ok(())
        })
    }

    /// Fallible segment playback with mutable adapter access at each tick.
    pub fn try_decode_segment_with_adapter<F>(
        mut self,
        start: Option<usize>,
        end_tick: i32,
        class_filter: &HashSet<&str>,
        on_tick: F,
    ) -> std::result::Result<ParserState, A::Error>
    where
        F: FnMut(&ParserState, &mut A) -> std::result::Result<(), A::Error>,
    {
        if let Some(start) = start.or(self.prepared.index.stream_start()) {
            self.parser.replay(
                &mut self.adapter,
                &mut self.state,
                start,
                segment_replay_end_tick(end_tick),
                Some(class_filter),
                on_tick,
            )?;
        }
        Ok(self.state)
    }
}

impl<'demo> DemoParser<'demo> {
    /// Decode signon and build a reusable playback seed.
    ///
    /// The adapter is consumed so its semantic state can be checkpointed at
    /// DEM_SyncTick without requiring it or its scratch buffers to be cloned.
    pub fn prepare<A: CheckpointAdapter>(
        &self,
        mut adapter: A,
        default_tick_interval: f32,
    ) -> std::result::Result<PreparedPlayback<A>, A::Error> {
        let (initial_state, stream_start) = self.initialize(&mut adapter, default_tick_interval)?;
        let index = self.demo.index().map_err(A::Error::from)?;
        if stream_start != index.stream_start() {
            return Err(A::Error::from(Error::Parse {
                context: "signon stream start did not match the command index".into(),
            }));
        }

        Ok(PreparedPlayback {
            initial_state,
            adapter_checkpoint: adapter.checkpoint(),
            index,
            identity: DemoIdentity::new(self),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Result;
    use crate::demo::{CommandFrame, HEADER_SIZE, MAGIC, command};
    use crate::entity::{
        BareCharEncoding, ClassEntry, DecodeProfile, FlattenedSerializer,
        FlattenedSerializerDefinition, PreciseQAngleMode,
    };
    use crate::playback::CommandContext;

    #[derive(Debug, Default)]
    struct StatefulAdapter {
        signon_marker: u32,
        scratch: Vec<u8>,
        tick_messages: Vec<i32>,
    }

    impl DemoAdapter for StatefulAdapter {
        type Error = Error;

        fn handle_command(
            &mut self,
            frame: &CommandFrame<'_>,
            _body: &[u8],
            context: &mut CommandContext<'_, '_>,
        ) -> Result<()> {
            match frame.header().cmd {
                command::SEND_TABLES => context.install_serializers(
                    FlattenedSerializer {
                        serializers: vec![FlattenedSerializerDefinition {
                            serializer_name_sym: Some(0),
                            fields_index: vec![],
                        }],
                        symbols: vec!["CTest".into()],
                        fields: vec![],
                    },
                    DecodeProfile::new(
                        BareCharEncoding::NullTerminatedString,
                        PreciseQAngleMode::Centered,
                    ),
                ),
                command::CLASS_INFO => {
                    context.install_class_info([ClassEntry::new(0, "CTest", "CTest")])
                }
                command::SIGNON_PACKET => {
                    self.signon_marker = 7;
                    self.scratch.resize(1024, 0x5a);
                    Ok(())
                }
                command::PACKET | command::FULL_PACKET => {
                    self.tick_messages.push(frame.header().tick);
                    self.scratch.push(frame.header().tick as u8);
                    Ok(())
                }
                _ => Ok(()),
            }
        }
    }

    impl CheckpointAdapter for StatefulAdapter {
        type Checkpoint = u32;

        fn checkpoint(&self) -> Self::Checkpoint {
            self.signon_marker
        }

        fn from_checkpoint(checkpoint: &Self::Checkpoint) -> Self {
            Self {
                signon_marker: *checkpoint,
                scratch: Vec::new(),
                tick_messages: Vec::new(),
            }
        }
    }

    fn push_command(bytes: &mut Vec<u8>, cmd: i32, tick: u8) {
        bytes.extend_from_slice(&[cmd as u8, tick, 0]);
    }

    fn fixture() -> Vec<u8> {
        let mut bytes = Vec::from(MAGIC);
        bytes.resize(HEADER_SIZE, 0);
        push_command(&mut bytes, command::SEND_TABLES, 0);
        push_command(&mut bytes, command::CLASS_INFO, 0);
        push_command(&mut bytes, command::SIGNON_PACKET, 0);
        push_command(&mut bytes, command::SYNC_TICK, 0);
        push_command(&mut bytes, command::PACKET, 1);
        push_command(&mut bytes, command::FULL_PACKET, 2);
        push_command(&mut bytes, command::PACKET, 3);
        push_command(&mut bytes, command::STOP, 4);
        bytes
    }

    fn repeated_tick_fixture() -> Vec<u8> {
        let mut bytes = fixture();
        bytes.splice(
            HEADER_SIZE + 6 * 3..HEADER_SIZE + 6 * 3,
            [command::PACKET as u8, 2, 0],
        );
        bytes
    }

    fn checkpoint_at_second_tick(bytes: &[u8]) -> PlaybackCheckpoint<StatefulAdapter> {
        let parser = DemoParser::new(bytes).unwrap();
        parser
            .prepare(StatefulAdapter::default(), 1.0 / 30.0)
            .unwrap()
            .session(parser)
            .unwrap()
            .checkpoint_through(2, &HashSet::from(["CTest"]), |_, adapter| {
                adapter.tick_messages.clear();
                Ok(())
            })
            .unwrap()
    }

    #[test]
    fn checkpoints_capture_every_command_in_the_completed_tick() {
        let bytes = repeated_tick_fixture();
        let parser = DemoParser::new(&bytes).unwrap();
        let prepared = parser
            .prepare(StatefulAdapter::default(), 1.0 / 30.0)
            .unwrap();
        let mut ticks = Vec::new();
        let checkpoint = prepared
            .session(parser)
            .unwrap()
            .checkpoint_through(2, &HashSet::from(["CTest"]), |state, adapter| {
                ticks.push((state.tick(), adapter.tick_messages.clone()));
                adapter.tick_messages.clear();
                Ok(())
            })
            .unwrap();
        assert_eq!(ticks, [(1, vec![1]), (2, vec![2, 2])]);
        assert_eq!(checkpoint.state().tick(), 2);
    }

    #[test]
    fn resumed_checkpoints_emit_only_later_ticks() {
        let bytes = repeated_tick_fixture();
        let checkpoint = checkpoint_at_second_tick(&bytes);
        let mut ticks = Vec::new();
        let next = checkpoint
            .replay_through(DemoParser::new(&bytes).unwrap(), 3, |state, adapter| {
                ticks.push((state.tick(), adapter.tick_messages.clone()));
                Ok(())
            })
            .unwrap();
        assert_eq!(ticks, [(3, vec![3])]);
        assert_eq!(next.state().tick(), 3);
    }

    #[test]
    fn checkpoints_can_be_replayed_more_than_once() {
        let bytes = repeated_tick_fixture();
        let checkpoint = checkpoint_at_second_tick(&bytes);
        let replay = || {
            let mut ticks = Vec::new();
            checkpoint
                .replay_through(DemoParser::new(&bytes).unwrap(), 4, |state, adapter| {
                    ticks.push((state.tick(), adapter.tick_messages.clone()));
                    adapter.tick_messages.clear();
                    Ok(())
                })
                .unwrap();
            ticks
        };
        assert_eq!(replay(), replay());
    }

    #[test]
    fn resumed_checkpoints_can_continue_to_the_stop_tick() {
        let bytes = repeated_tick_fixture();
        let parser = DemoParser::new(&bytes).unwrap();
        let next = checkpoint_at_second_tick(&bytes)
            .replay_through(parser, 3, |_, _| Ok(()))
            .unwrap();
        let mut ticks = Vec::new();
        next.replay_through(parser, 4, |state, _| {
            ticks.push(state.tick());
            Ok(())
        })
        .unwrap();
        assert_eq!(ticks, [4]);
    }

    #[test]
    fn checkpoints_reject_different_demo_storage() {
        let bytes = repeated_tick_fixture();
        let checkpoint = checkpoint_at_second_tick(&bytes);
        let other = bytes.clone();
        assert_ne!(bytes.as_ptr(), other.as_ptr());
        assert!(
            checkpoint
                .replay_through(DemoParser::new(&other).unwrap(), 3, |_, _| Ok(()))
                .is_err()
        );
    }

    #[test]
    fn checkpoints_reject_backward_targets() {
        let bytes = repeated_tick_fixture();
        assert!(
            checkpoint_at_second_tick(&bytes)
                .replay_through(DemoParser::new(&bytes).unwrap(), 1, |_, _| Ok(()))
                .is_err()
        );
    }

    #[test]
    fn checkpoints_reject_changed_decode_limits() {
        let bytes = repeated_tick_fixture();
        let checkpoint = checkpoint_at_second_tick(&bytes);
        let limits = DecodeLimits::default().with_max_command_body_bytes(1024);
        assert!(
            checkpoint
                .replay_through(
                    DemoParser::with_limits(&bytes, limits).unwrap(),
                    3,
                    |_, _| Ok(())
                )
                .is_err()
        );
    }

    #[test]
    fn checkpoints_do_not_emit_the_completed_tick_again() {
        let bytes = repeated_tick_fixture();
        let checkpoint = checkpoint_at_second_tick(&bytes);
        let same = checkpoint
            .replay_through(DemoParser::new(&bytes).unwrap(), 2, |_, _| {
                panic!("must not re-emit a completed tick")
            })
            .unwrap();
        assert_eq!(same.state().tick(), 2);
    }

    fn segmented_fixture() -> Vec<u8> {
        let mut bytes = Vec::from(MAGIC);
        bytes.resize(HEADER_SIZE, 0);
        push_command(&mut bytes, command::SEND_TABLES, 0);
        push_command(&mut bytes, command::CLASS_INFO, 0);
        push_command(&mut bytes, command::SIGNON_PACKET, 0);
        push_command(&mut bytes, command::SYNC_TICK, 0);
        for tick in 1..=9 {
            let cmd = if tick % 2 == 0 {
                command::FULL_PACKET
            } else {
                command::PACKET
            };
            push_command(&mut bytes, cmd, tick);
        }
        push_command(&mut bytes, command::STOP, 10);
        bytes
    }

    fn assert_send_sync<T: Send + Sync>() {}

    #[test]
    fn preparation_captures_signon_and_index_without_borrowing() {
        assert_send_sync::<PreparedPlayback<StatefulAdapter>>();

        let bytes = fixture();
        let parser = DemoParser::new(&bytes).expect("valid demo");
        let prepared = parser
            .prepare(StatefulAdapter::default(), 1.0 / 30.0)
            .expect("valid preparation");

        assert!(prepared.initial_state().is_initialized());
        assert_eq!(prepared.initial_state().tick_interval(), 1.0 / 30.0);
        assert_eq!(prepared.index().distinct_ticks(), [1, 2, 3]);
        assert_eq!(prepared.index().full_packets().len(), 1);

        let session = prepared.session(parser).expect("matching demo");
        assert_eq!(session.adapter().signon_marker, 7);
        assert!(session.adapter().scratch.is_empty());
    }

    #[test]
    fn preparation_indexes_every_full_packet() {
        let bytes = segmented_fixture();
        let prepared = DemoParser::new(&bytes)
            .unwrap()
            .prepare(StatefulAdapter::default(), 1.0 / 30.0)
            .unwrap();
        assert_eq!(
            prepared
                .index()
                .full_packets()
                .iter()
                .map(|position| position.tick())
                .collect::<Vec<_>>(),
            [2, 4, 6, 8]
        );
    }

    #[test]
    fn segment_plan_balances_workers_at_full_packets() {
        let bytes = segmented_fixture();
        let prepared = DemoParser::new(&bytes)
            .unwrap()
            .prepare(StatefulAdapter::default(), 1.0 / 30.0)
            .unwrap();
        let full_packets = prepared.index().full_packets();
        let boundaries = prepared
            .segment_plan(3)
            .iter()
            .map(|segment| (segment.start_offset(), segment.end_tick()))
            .collect::<Vec<_>>();
        assert_eq!(
            boundaries,
            [
                (None, 2),
                (Some(full_packets[0].offset()), 6),
                (Some(full_packets[2].offset()), i32::MAX)
            ]
        );
    }

    #[test]
    fn segment_plan_caps_the_worker_count_at_available_segments() {
        let bytes = segmented_fixture();
        let prepared = DemoParser::new(&bytes)
            .unwrap()
            .prepare(StatefulAdapter::default(), 1.0 / 30.0)
            .unwrap();
        let full_packets = prepared.index().full_packets();
        let plan = prepared.segment_plan(usize::MAX);
        assert_eq!(plan.len(), full_packets.len() + 1);
        assert_eq!((plan[0].start_offset(), plan[0].end_tick()), (None, 2));
        assert_eq!(
            (
                plan.last().unwrap().start_offset(),
                plan.last().unwrap().end_tick()
            ),
            (Some(full_packets[3].offset()), i32::MAX)
        );
    }

    #[test]
    fn zero_workers_still_produce_one_complete_segment() {
        let bytes = segmented_fixture();
        let prepared = DemoParser::new(&bytes)
            .unwrap()
            .prepare(StatefulAdapter::default(), 1.0 / 30.0)
            .unwrap();
        let boundaries = prepared
            .segment_plan(0)
            .iter()
            .map(|segment| (segment.start_offset(), segment.end_tick()))
            .collect::<Vec<_>>();
        assert_eq!(boundaries, [(None, i32::MAX)]);
    }

    #[test]
    fn decoding_planned_segments_visits_each_tick_once() {
        let bytes = segmented_fixture();
        let parser = DemoParser::new(&bytes).unwrap();
        let prepared = parser
            .prepare(StatefulAdapter::default(), 1.0 / 30.0)
            .unwrap();
        let mut ticks = Vec::new();
        for segment in prepared.segment_plan(3) {
            prepared
                .session(parser)
                .unwrap()
                .decode_segment(
                    segment.start_offset(),
                    segment.end_tick(),
                    &HashSet::from(["CTest"]),
                    |state| ticks.push(state.tick()),
                )
                .unwrap();
        }
        assert_eq!(ticks, (1..=10).collect::<Vec<_>>());
    }

    #[test]
    fn prepared_and_cold_playback_match() {
        let bytes = fixture();
        let parser = DemoParser::new(&bytes).expect("valid demo");

        let mut cold_ticks = Vec::new();
        let cold = parser
            .run_to_end(&mut StatefulAdapter::default(), 1.0 / 30.0, |state| {
                cold_ticks.push(state.tick())
            })
            .expect("cold playback");

        let prepared = parser
            .prepare(StatefulAdapter::default(), 1.0 / 30.0)
            .expect("valid preparation");
        let mut prepared_ticks = Vec::new();
        let restored = prepared
            .session(parser)
            .expect("matching demo")
            .run_to_end(|state| prepared_ticks.push(state.tick()))
            .expect("prepared playback");

        assert_eq!(prepared_ticks, cold_ticks);
        assert_eq!(restored.tick(), cold.tick());

        let cold_seek = parser
            .parse_to_tick(&mut StatefulAdapter::default(), 1.0 / 30.0, 2)
            .expect("cold seek");
        let prepared_seek = prepared
            .session(parser)
            .expect("matching demo")
            .parse_to_tick(2)
            .expect("prepared seek");
        assert_eq!(prepared_seek.tick(), cold_seek.tick());
    }

    #[test]
    fn prepared_filter_segment_and_callback_failures_match_cold_semantics() {
        let bytes = fixture();
        let parser = DemoParser::new(&bytes).expect("valid demo");
        let prepared = parser
            .prepare(StatefulAdapter::default(), 1.0 / 30.0)
            .expect("valid preparation");
        let filter = HashSet::from(["CTest"]);

        let mut filtered_ticks = Vec::new();
        prepared
            .session(parser)
            .expect("matching demo")
            .run_to_end_filtered(&filter, |state| filtered_ticks.push(state.tick()))
            .expect("filtered playback");
        assert_eq!(filtered_ticks, [1, 2, 3, 4]);

        let start = prepared.index().full_packets()[0].offset();
        let mut segment_ticks = Vec::new();
        let segment = prepared
            .session(parser)
            .expect("matching demo")
            .decode_segment(Some(start), 3, &filter, |state| {
                segment_ticks.push(state.tick());
            })
            .expect("segment playback");
        assert_eq!(segment_ticks, [2]);
        assert_eq!(segment.tick(), 2);

        let mut failed_ticks = Vec::new();
        let error = prepared
            .session(parser)
            .expect("matching demo")
            .try_run_to_end_with_adapter(|state, adapter| {
                failed_ticks.push(state.tick());
                adapter.tick_messages.clear();
                if state.tick() == 2 {
                    return Err(Error::Parse {
                        context: "prepared consumer failed".into(),
                    });
                }
                Ok(())
            })
            .err()
            .expect("callback failure must abort playback");
        assert_eq!(failed_ticks, [1, 2]);
        assert!(matches!(
            error,
            Error::Parse { context } if context == "prepared consumer failed"
        ));
    }

    #[test]
    fn callbacks_can_drain_adapter_state_without_crossing_sessions() {
        let bytes = fixture();
        let parser = DemoParser::new(&bytes).expect("valid demo");
        let prepared = parser
            .prepare(StatefulAdapter::default(), 1.0 / 30.0)
            .expect("valid preparation");

        let mut observed = Vec::new();
        prepared
            .session(parser)
            .expect("matching demo")
            .run_to_end_with_adapter(|state, adapter| {
                assert_eq!(adapter.signon_marker, 7);
                observed.push((state.tick(), std::mem::take(&mut adapter.tick_messages)));
            })
            .expect("prepared playback");
        assert_eq!(
            observed,
            [(1, vec![1]), (2, vec![2]), (3, vec![3]), (4, vec![])]
        );

        let session = prepared.session(parser).expect("independent session");
        assert_eq!(session.adapter().signon_marker, 7);
        assert!(session.adapter().tick_messages.is_empty());
        assert!(session.adapter().scratch.is_empty());
    }

    #[test]
    fn rejects_other_buffers_and_decode_limits() {
        let bytes = fixture();
        let parser = DemoParser::new(&bytes).expect("valid demo");
        let prepared = parser
            .prepare(StatefulAdapter::default(), 1.0 / 30.0)
            .expect("valid preparation");

        let other_bytes = fixture();
        let other = DemoParser::new(&other_bytes).expect("valid other demo");
        assert!(prepared.session(other).is_err());

        let other_limits = DecodeLimits::default().with_max_command_body_bytes(1024);
        let other = DemoParser::with_limits(&bytes, other_limits).expect("valid alternate view");
        assert!(prepared.session(other).is_err());
    }

    #[test]
    fn prepared_sessions_run_independently_in_parallel() {
        let bytes = fixture();
        let parser = DemoParser::new(&bytes).expect("valid demo");
        let prepared = parser
            .prepare(StatefulAdapter::default(), 1.0 / 30.0)
            .expect("valid preparation");

        let results = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    let prepared = &prepared;
                    scope.spawn(move || {
                        let mut ticks = Vec::new();
                        prepared
                            .session(parser)
                            .expect("matching demo")
                            .run_to_end(|state| ticks.push(state.tick()))
                            .expect("parallel playback");
                        ticks
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().expect("worker did not panic"))
                .collect::<Vec<_>>()
        });

        assert_eq!(results, [vec![1, 2, 3, 4], vec![1, 2, 3, 4]]);
    }
}

#[cfg(test)]
mod property_tests;
