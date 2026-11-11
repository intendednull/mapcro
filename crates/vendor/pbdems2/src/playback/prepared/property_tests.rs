use super::*;
use crate::demo::{CommandFrame, HEADER_SIZE, MAGIC, command};
use crate::entity::field_path::test_support::{FINISH, PLUS_ONE, emit_op};
use crate::entity::{
    BareCharEncoding, ClassEntry, DecodeProfile, FlattenedField, FlattenedSerializer,
    FlattenedSerializerDefinition, PacketEntities, PreciseQAngleMode,
};
use crate::playback::CommandContext;
use crate::test_utils::BitWriter;

struct Adapter;
impl DemoAdapter for Adapter {
    type Error = Error;
    fn handle_command(
        &mut self,
        frame: &CommandFrame<'_>,
        body: &[u8],
        context: &mut CommandContext<'_, '_>,
    ) -> crate::Result<()> {
        match frame.header().cmd {
            command::SEND_TABLES => context.install_serializers(
                FlattenedSerializer::new(
                    vec![FlattenedSerializerDefinition::new(Some(0), vec![0, 1])],
                    vec![
                        "CTest".into(),
                        "uint32".into(),
                        "m_first".into(),
                        "m_second".into(),
                    ],
                    vec![
                        FlattenedField::new(Some(1), Some(2)),
                        FlattenedField::new(Some(1), Some(3)),
                    ],
                ),
                DecodeProfile::new(
                    BareCharEncoding::NullTerminatedString,
                    PreciseQAngleMode::Centered,
                ),
            ),
            command::CLASS_INFO => {
                context.install_class_info([ClassEntry::new(0, "CTest", "CTest")])
            }
            command::PACKET | command::SIGNON_PACKET | command::FULL_PACKET => {
                context.apply_packet_entities(PacketEntities::new(1, body, 0))
            }
            _ => Ok(()),
        }
    }
}
impl CheckpointAdapter for Adapter {
    type Checkpoint = ();
    fn checkpoint(&self) {}
    fn from_checkpoint(_: &()) -> Self {
        Self
    }
}
fn packet(create: bool, first: u32, second: Option<u32>) -> Vec<u8> {
    let mut bits = BitWriter::default();
    bits.push_ubitvar(0);
    bits.push_bits(if create { 2 } else { 0 }, 2);
    if create {
        bits.push_bits(0, 1);
        bits.push_bits(7, 17);
        bits.push_uvarint32(0);
    }
    emit_op(&mut bits, PLUS_ONE);
    if second.is_some() {
        emit_op(&mut bits, PLUS_ONE);
    }
    emit_op(&mut bits, FINISH);
    bits.push_uvarint32(first);
    if let Some(value) = second {
        bits.push_uvarint32(value);
    }
    bits.finish()
}
fn push(bytes: &mut Vec<u8>, kind: i32, tick: u8, data: &[u8]) {
    assert!(data.len() < 128);
    bytes.extend_from_slice(&[kind as u8, tick, data.len() as u8]);
    bytes.extend_from_slice(data);
}
fn fixture() -> Vec<u8> {
    let mut bytes = Vec::from(MAGIC);
    bytes.resize(HEADER_SIZE, 0);
    push(&mut bytes, command::SEND_TABLES, 0, &[]);
    push(&mut bytes, command::CLASS_INFO, 0, &[]);
    push(
        &mut bytes,
        command::SIGNON_PACKET,
        0,
        &packet(true, 300, Some(42)),
    );
    push(&mut bytes, command::SYNC_TICK, 0, &[]);
    push(
        &mut bytes,
        command::PACKET,
        1,
        &packet(false, 301, Some(43)),
    );
    push(
        &mut bytes,
        command::FULL_PACKET,
        2,
        &packet(true, 302, Some(44)),
    );
    push(&mut bytes, command::PACKET, 3, &packet(false, 303, None));
    push(&mut bytes, command::STOP, 4, &[]);
    bytes
}
fn filter(prepared: &PreparedPlayback<Adapter>, path: &str) -> PropertyFilter {
    PropertyFilter::new(prepared.initial_state().serializers(), [("CTest", [path])])
}
fn second(state: &ParserState) -> u64 {
    let key = state
        .serializers()
        .get("CTest")
        .unwrap()
        .resolve_field_key("m_second");
    state.entities().get(0).unwrap().get_u64(key).unwrap()
}
fn has_first(state: &ParserState) -> bool {
    let key = state
        .serializers()
        .get("CTest")
        .unwrap()
        .resolve_field_key("m_first");
    state.entities().get(0).unwrap().field_value(key).is_some()
}
#[test]
fn prepared_projection_removes_unselected_signon_values() {
    let bytes = fixture();
    let parser = DemoParser::new(&bytes).unwrap();
    let prepared = parser.prepare(Adapter, 1.0 / 64.0).unwrap();
    let session = prepared
        .session_with_properties(parser, filter(&prepared, "m_second"))
        .unwrap();
    assert!(!has_first(session.state()));
}
#[test]
fn projected_playback_matches_full_requested_values_at_each_tick() {
    let bytes = fixture();
    let parser = DemoParser::new(&bytes).unwrap();
    let prepared = parser.prepare(Adapter, 1.0 / 64.0).unwrap();
    let mut full = Vec::new();
    let mut projected = Vec::new();
    prepared
        .session(parser)
        .unwrap()
        .run_to_end(|state| full.push((state.tick(), second(state))))
        .unwrap();
    prepared
        .session_with_properties(parser, filter(&prepared, "m_second"))
        .unwrap()
        .run_to_end(|state| projected.push((state.tick(), second(state))))
        .unwrap();
    assert_eq!(projected, full);
}
#[test]
fn projected_seek_matches_the_full_pass() {
    let bytes = fixture();
    let parser = DemoParser::new(&bytes).unwrap();
    let prepared = parser.prepare(Adapter, 1.0 / 64.0).unwrap();
    let mut expected = 0;
    prepared
        .session(parser)
        .unwrap()
        .run_to_end(|state| {
            if state.tick() == 3 {
                expected = second(state);
            }
        })
        .unwrap();
    let seek = prepared
        .session_with_properties(parser, filter(&prepared, "m_second"))
        .unwrap()
        .parse_to_tick(3)
        .unwrap();
    assert_eq!(second(&seek), expected);
}
#[test]
fn projected_keyframe_segments_do_not_revive_unselected_fields() {
    let bytes = fixture();
    let parser = DemoParser::new(&bytes).unwrap();
    let prepared = parser.prepare(Adapter, 1.0 / 64.0).unwrap();
    let state = prepared
        .session_with_properties(parser, filter(&prepared, "m_second"))
        .unwrap()
        .decode_segment(
            Some(prepared.index().full_packets()[0].offset()),
            4,
            &HashSet::from(["CTest"]),
            |_| {},
        )
        .unwrap();
    assert!(!has_first(&state));
}
#[test]
fn checkpoint_continuation_keeps_the_original_property_selection() {
    let bytes = fixture();
    let parser = DemoParser::new(&bytes).unwrap();
    let prepared = parser.prepare(Adapter, 1.0 / 64.0).unwrap();
    let checkpoint = prepared
        .session_with_properties(parser, filter(&prepared, "m_second"))
        .unwrap()
        .checkpoint_through(1, &HashSet::from(["CTest"]), |_, _| Ok(()))
        .unwrap();
    let continued = checkpoint.replay_through(parser, 3, |_, _| Ok(())).unwrap();
    assert!(!has_first(continued.state()));
}
#[test]
fn independent_sessions_can_use_different_filters_in_parallel() {
    let bytes = fixture();
    let parser = DemoParser::new(&bytes).unwrap();
    let prepared = parser.prepare(Adapter, 1.0 / 64.0).unwrap();
    let results = std::thread::scope(|scope| {
        let handles: Vec<_> = ["m_first", "m_second"]
            .into_iter()
            .map(|path| {
                let prepared = &prepared;
                scope.spawn(move || {
                    let state = prepared
                        .session_with_properties(parser, filter(prepared, path))
                        .unwrap()
                        .run_to_end(|_| {})
                        .unwrap();
                    let key = state
                        .serializers()
                        .get("CTest")
                        .unwrap()
                        .resolve_field_key(path);
                    state.entities().get(0).unwrap().get_u64(key).unwrap()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(results, [303, 44]);
}
#[test]
fn an_unfiltered_session_remains_complete_after_a_filtered_session() {
    let bytes = fixture();
    let parser = DemoParser::new(&bytes).unwrap();
    let prepared = parser.prepare(Adapter, 1.0 / 64.0).unwrap();
    prepared
        .session_with_properties(parser, filter(&prepared, "m_second"))
        .unwrap()
        .run_to_end(|_| {})
        .unwrap();
    let state = prepared
        .session(parser)
        .unwrap()
        .run_to_end(|_| {})
        .unwrap();
    assert!(has_first(&state));
}
#[test]
fn the_header_index_detects_post_signon_schema_changes() {
    let mut bytes = fixture();
    bytes.truncate(bytes.len() - 3);
    push(&mut bytes, command::SEND_TABLES, 3, &[]);
    push(&mut bytes, command::STOP, 4, &[]);
    let parser = DemoParser::new(&bytes).unwrap();
    let prepared = parser.prepare(Adapter, 1.0 / 64.0).unwrap();
    assert!(prepared.index().has_schema_changes());
}
#[test]
fn projected_playback_rejects_later_schema_replacement() {
    let mut bytes = fixture();
    bytes.truncate(bytes.len() - 3);
    push(&mut bytes, command::SEND_TABLES, 3, &[]);
    push(&mut bytes, command::STOP, 4, &[]);
    let parser = DemoParser::new(&bytes).unwrap();
    let prepared = parser.prepare(Adapter, 1.0 / 64.0).unwrap();
    assert!(
        prepared
            .session_with_properties(parser, filter(&prepared, "m_second"))
            .unwrap()
            .run_to_end(|_| {})
            .is_err()
    );
}
