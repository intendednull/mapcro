use rustc_hash::FxHashMap;

use crate::entity::field_path::test_support::{FINISH, emit_op, emit_single_bool_update};
use crate::entity::{
    BareCharEncoding, ClassEntry, CreateStringTable, DecodeProfile, FlattenedField,
    FlattenedSerializer, FlattenedSerializerDefinition, PreciseQAngleMode,
};
use crate::limits::DecodeLimits;
use crate::position::cell_to_world;
use crate::test_utils::BitWriter;

use super::*;

const PROFILE: DecodeProfile = DecodeProfile::new(
    BareCharEncoding::NullTerminatedString,
    PreciseQAngleMode::Centered,
);

#[test]
fn entity_updates_use_replaced_serializer_schema_after_clone_and_reset() {
    let class_info = classes();
    let original = serializers();
    let tables = StringTableContainer::new();
    let mut entities = EntityContainer::new();
    apply_packet(
        &mut entities,
        &create_packet(0, true),
        &class_info,
        &original,
        &tables,
    )
    .unwrap();
    let mut cloned = entities.clone();
    let replacement = SerializerContainer::parse(
        FlattenedSerializer::new(
            vec![FlattenedSerializerDefinition::new(Some(0), vec![0])],
            vec!["CTest".into(), "uint32".into(), "m_flag".into()],
            vec![FlattenedField::new(Some(1), Some(2))],
        ),
        PROFILE,
    )
    .unwrap();
    let mut writer = packet_writer(0, 0);
    emit_op(
        &mut writer,
        crate::entity::field_path::test_support::PLUS_ONE,
    );
    emit_op(&mut writer, FINISH);
    writer.push_uvarint32(77);
    apply_packet(
        &mut cloned,
        &writer.finish(),
        &class_info,
        &replacement,
        &tables,
    )
    .unwrap();
    assert_eq!(cloned.get(0).unwrap().get_u32(Some(field_key(0))), 77);
    apply_packet(
        &mut entities,
        &update_packet(0, false),
        &class_info,
        &original,
        &tables,
    )
    .unwrap();
    assert!(!entities.get(0).unwrap().get_bool(Some(field_key(0))));

    cloned = EntityContainer::new();
    apply_packet(
        &mut cloned,
        &create_packet(0, true),
        &class_info,
        &original,
        &tables,
    )
    .unwrap();
    assert!(cloned.get(0).unwrap().get_bool(Some(field_key(0))));
}

proptest::proptest! {
    #[test]
    fn occupancy_matches_slots_after_mixed_mutations(
        operations in proptest::collection::vec((0_u8..7, 0_usize..64), 0..256),
    ) {
        let mut entities = EntityContainer::new();
        for (operation, index) in operations {
            match operation {
                0 => { entities.insert(Entity::new(index as i32, 0, "CTest".into())).unwrap(); }
                1 => entities.put_entity(index as i32, Entity::new(index as i32, 0, "CTest".into())),
                2 => entities.delete_entity(index as i32),
                3 => entities.handle_leave(index as i32, false),
                4 => entities.reserve_slots(index).unwrap(),
                5 => entities.clear_tick_changes(),
                _ => entities = entities.clone(),
            }
            let expected = entities.slots().iter().filter(|slot| slot.is_some()).count();
            proptest::prop_assert_eq!(entities.len(), expected);
            proptest::prop_assert_eq!(entities.is_empty(), expected == 0);
            proptest::prop_assert_eq!(entities.iter().count(), expected);
        }
    }
}

#[test]
fn occupancy_survives_rejected_mutations_and_clone_changes() {
    let mut entities = EntityContainer::new();
    entities.insert(Entity::new(5, 0, "CTest".into())).unwrap();
    assert!(entities.insert(Entity::new(-1, 0, "CTest".into())).is_err());
    assert!(
        entities
            .reserve_slots(MAX_ENTITY_INDEX as usize + 2)
            .is_err()
    );
    assert!(entities.take_entity(-1).is_none());
    assert!(entities.take_entity(16_384).is_none());
    let mut cloned = entities.clone();
    cloned.delete_entity(5);
    cloned.delete_entity(5);
    assert!(cloned.is_empty());
    assert_eq!(cloned.len(), 0);
    assert_eq!(entities.len(), 1);
    assert!(!entities.is_empty());
    entities.reserve_slots(5).unwrap();
    assert_eq!(entities.len(), 0);
    assert!(entities.is_empty());
}

fn field_key(index: u8) -> u64 {
    FieldPath {
        data: [i16::from(index), 0, 0, 0, 0, 0, 0],
        last: 0,
        finished: false,
    }
    .pack()
}

fn serializers() -> SerializerContainer {
    SerializerContainer::parse(
        FlattenedSerializer::new(
            vec![FlattenedSerializerDefinition::new(Some(0), vec![0])],
            vec!["CTest".to_owned(), "bool".to_owned(), "m_flag".to_owned()],
            vec![FlattenedField::new(Some(1), Some(2))],
        ),
        PROFILE,
    )
    .expect("valid serializer fixture")
}

fn classes() -> ClassInfo {
    ClassInfo::try_from_entries([ClassEntry::new(0, "CTest", "")]).expect("valid class fixture")
}

fn packet_writer(index: u32, command: u8) -> BitWriter {
    let mut writer = BitWriter::default();
    writer.push_ubitvar(index);
    writer.push_bits(u64::from(command), 2);
    writer
}

fn create_packet(index: u32, value: bool) -> Vec<u8> {
    create_packet_with_serial(index, 7, value)
}

fn create_packet_with_serial(index: u32, serial: u32, value: bool) -> Vec<u8> {
    let mut writer = packet_writer(index, CMD_CREATE_DELETE);
    writer.push_bits(0, 1);
    writer.push_bits(u64::from(serial), NUM_SERIAL_NUM_BITS as usize);
    writer.push_uvarint32(0);
    emit_single_bool_update(&mut writer, value);
    writer.finish()
}

fn update_packet(index: u32, value: bool) -> Vec<u8> {
    let mut writer = packet_writer(index, 0);
    emit_single_bool_update(&mut writer, value);
    writer.finish()
}

fn apply_packet(
    entities: &mut EntityContainer,
    data: &[u8],
    class_info: &ClassInfo,
    serializer_container: &SerializerContainer,
    string_tables: &StringTableContainer,
) -> Result<()> {
    entities.handle_packet_entities(
        PacketEntities::new(1, data, 0),
        class_info,
        serializer_container,
        string_tables,
        &mut FieldDecodeContext::new(1.0 / 64.0),
        &mut Vec::new(),
    )
}

fn apply_packet_filtered(
    entities: &mut EntityContainer,
    data: &[u8],
    class_info: &ClassInfo,
    serializer_container: &SerializerContainer,
    string_tables: &StringTableContainer,
    class_filter: &HashSet<&str>,
) -> Result<()> {
    entities.handle_packet_entities_filtered(
        PacketEntities::new(1, data, 0),
        class_info,
        serializer_container,
        string_tables,
        &mut FieldDecodeContext::new(1.0 / 64.0),
        class_filter,
        &mut Vec::new(),
    )
}

#[test]
fn entity_ids_combine_slot_and_serial_without_changing_storage() {
    let entity = Entity::from_fields(5, 7, 0, "CTest", true, FxHashMap::default()).unwrap();
    assert_eq!(entity.id(), EntityId::new(5, 7));

    let mut entities = EntityContainer::new();
    entities.insert(entity).unwrap();
    assert_eq!(entities.entity_changes()[0].id(), EntityId::new(5, 7));
}

#[cfg(feature = "serde")]
#[test]
fn entity_ids_and_lifecycle_changes_serialize() {
    let mut entities = EntityContainer::new();
    entities
        .insert(Entity::from_fields(5, 7, 0, "CTest", true, FxHashMap::default()).unwrap())
        .unwrap();
    let change = &entities.entity_changes()[0];

    assert_eq!(
        serde_json::to_value(change.id()).unwrap(),
        serde_json::json!({ "index": 5, "serial": 7 })
    );
    assert_eq!(
        serde_json::to_value(change).unwrap(),
        serde_json::json!({
            "kind": "Created",
            "index": 5,
            "serial": 7,
            "class_id": 0,
            "class_name": "CTest"
        })
    );
}

#[test]
fn protobuf_handles_distinguish_absent_invalid_and_serialized_indices() {
    assert_eq!(protobuf_handle_index(None), None);
    assert_eq!(protobuf_handle_index(Some(INVALID_ENTITY_HANDLE)), None);
    assert_eq!(protobuf_handle_index(Some((5 << 14) | 123)), Some(123));
}

fn accessor_entity() -> Entity {
    let values = [
        FieldValue::U32(7),
        FieldValue::U64(8),
        FieldValue::I32(-9),
        FieldValue::I64(-10),
        FieldValue::F32(1.25),
        FieldValue::Bool(true),
        FieldValue::QAngle([1.0, 2.0, 3.0]),
        FieldValue::Vector3([4.0, 5.0, 6.0]),
        FieldValue::FloatVector(vec![7.0, 8.0, 9.0, 10.0]),
        FieldValue::String(b"hello".to_vec()),
        FieldValue::String(vec![0xff]),
    ];
    let fields = values
        .into_iter()
        .enumerate()
        .map(|(index, value)| (field_key(index as u8), value))
        .collect::<FxHashMap<_, _>>();
    Entity::from_fields(12, 3, 0, "CTest", true, fields).unwrap()
}

#[test]
fn integer_accessors_read_all_integer_variants() {
    let entity = accessor_entity();
    for (index, expected) in [(0, 7_i64), (1, 8), (2, -9), (3, -10)] {
        assert_eq!(entity.get_i64(Some(field_key(index))), expected);
    }
}

#[test]
fn unsigned_accessors_preserve_integer_bits() {
    let entity = accessor_entity();
    for (index, expected) in [(0, 7), (1, 8), (2, (-9_i32) as u32), (3, (-10_i64) as u32)] {
        assert_eq!(entity.get_u32(Some(field_key(index))), expected);
    }
}

#[test]
fn float_accessor_reads_float_fields() {
    assert_eq!(accessor_entity().get_f32(Some(field_key(4))), 1.25);
}

#[test]
fn bool_accessor_reads_bool_fields() {
    assert!(accessor_entity().get_bool(Some(field_key(5))));
}

#[test]
fn qangle_accessor_reads_angle_fields() {
    assert_eq!(
        accessor_entity().get_qangle(Some(field_key(6))),
        [1.0, 2.0, 3.0]
    );
}

#[test]
fn vector_accessor_reads_fixed_and_dynamic_vectors() {
    let entity = accessor_entity();
    assert_eq!(entity.get_vector3(Some(field_key(7))), [4.0, 5.0, 6.0]);
    assert_eq!(entity.get_vector3(Some(field_key(8))), [7.0, 8.0, 9.0]);
}

#[test]
fn byte_accessor_preserves_string_bytes() {
    assert_eq!(
        accessor_entity().get_bytes(Some(field_key(9))),
        Some(&b"hello"[..])
    );
}

#[test]
fn borrowed_string_accessor_preserves_valid_utf8() {
    assert_eq!(
        accessor_entity().get_str(Some(field_key(9))).unwrap(),
        Some("hello")
    );
}

#[test]
fn owned_string_accessor_preserves_valid_utf8() {
    assert_eq!(
        accessor_entity().get_string(Some(field_key(9))).as_deref(),
        Some("hello")
    );
}

#[test]
fn string_accessor_rejects_invalid_utf8() {
    assert!(accessor_entity().get_str(Some(field_key(10))).is_err());
}

#[test]
fn handle_accessor_preserves_signed_wire_bits() {
    let entity = accessor_entity();
    assert_eq!(entity.get_handle(Some(field_key(0))), Some(7));
    assert_eq!(entity.get_handle(Some(field_key(2))), Some((-9_i32) as u32));
}

#[test]
fn u64_accessor_preserves_signed_wire_bits() {
    assert_eq!(
        accessor_entity().get_u64(Some(field_key(3))),
        Some((-10_i64) as u64)
    );
}

#[test]
fn typed_accessor_converts_compatible_values() {
    assert_eq!(
        accessor_entity()
            .try_get::<u32>(Some(field_key(0)))
            .unwrap(),
        Some(7)
    );
}

#[test]
fn integer_accessor_defaults_for_absent_fields() {
    assert_eq!(accessor_entity().get_i64(None), 0);
}

#[test]
fn unsigned_accessor_defaults_for_incompatible_fields() {
    assert_eq!(accessor_entity().get_u32(Some(field_key(4))), 0);
}

#[test]
fn float_accessor_defaults_for_incompatible_fields() {
    assert_eq!(accessor_entity().get_f32(Some(field_key(5))), 0.0);
}

#[test]
fn bool_accessor_defaults_for_incompatible_fields() {
    assert!(!accessor_entity().get_bool(Some(field_key(4))));
}

#[test]
fn angle_accessor_defaults_for_absent_fields() {
    assert_eq!(accessor_entity().get_qangle(None), [0.0; 3]);
}

#[test]
fn vector_accessor_defaults_for_incompatible_fields() {
    assert_eq!(accessor_entity().get_vector3(Some(field_key(4))), [0.0; 3]);
}

#[test]
fn handle_accessor_rejects_incompatible_fields() {
    assert!(accessor_entity().get_handle(Some(field_key(4))).is_none());
}

#[test]
fn u64_accessor_rejects_incompatible_fields() {
    assert!(accessor_entity().get_u64(Some(field_key(4))).is_none());
}

#[test]
fn byte_accessor_rejects_incompatible_fields() {
    assert!(accessor_entity().get_bytes(Some(field_key(4))).is_none());
}

#[test]
fn field_lookup_returns_none_without_a_key() {
    assert!(accessor_entity().field_value(None).is_none());
}

#[test]
fn resolves_fields_by_name_and_computes_world_position() {
    let serializer_container = serializers();
    let serializer = serializer_container.get("CTest").unwrap();
    let mut fields = FxHashMap::default();
    fields.insert(field_key(0), FieldValue::Bool(true));
    for (index, value) in [(1, 32_i32), (2, 33), (3, 31)] {
        fields.insert(field_key(index), FieldValue::I32(value));
    }
    for (index, value) in [(4, 1.5_f32), (5, 2.5), (6, 3.5)] {
        fields.insert(field_key(index), FieldValue::F32(value));
    }
    let entity = Entity::from_fields(0, 0, 0, "CTest", true, fields).unwrap();

    assert!(matches!(
        entity.get_by_name("m_flag", serializer),
        Some(FieldValue::Bool(true))
    ));
    assert!(entity.get_by_name("missing", serializer).is_none());
    assert_eq!(
        entity.world_position(
            [Some(field_key(1)), Some(field_key(2)), Some(field_key(3))],
            [Some(field_key(4)), Some(field_key(5)), Some(field_key(6))],
        ),
        [
            cell_to_world(32, 1.5),
            cell_to_world(33, 2.5),
            cell_to_world(31, 3.5),
        ]
    );
}

#[test]
fn validates_entity_and_container_indices_and_tracks_replacements() {
    assert!(Entity::from_fields(-1, 0, 0, "bad", true, FxHashMap::default()).is_err());
    assert!(
        Entity::from_fields(
            MAX_ENTITY_INDEX as i32 + 1,
            0,
            0,
            "bad",
            true,
            FxHashMap::default(),
        )
        .is_err()
    );

    let mut container = EntityContainer::new();
    container.reserve_slots(4).unwrap();
    assert_eq!(container.slot_count(), 4);
    assert_eq!(container.slots().len(), 4);
    assert!(
        container
            .reserve_slots(MAX_ENTITY_INDEX as usize + 2)
            .is_err()
    );

    let first = Entity::new(2, 1, "First".into());
    assert!(container.insert(first).unwrap().is_none());
    let second = Entity::new(2, 2, "Second".into());
    let replaced = container.insert(second).unwrap().expect("previous entity");
    assert_eq!(&*replaced.class_name, "First");
    assert_eq!(&*container.get_by_handle(2).unwrap().class_name, "Second");
    assert_eq!(container.updated_indices(), &[2, 2]);
    assert_eq!(
        container
            .entity_changes()
            .iter()
            .map(|change| change.kind)
            .collect::<Vec<_>>(),
        [
            EntityChangeKind::Created,
            EntityChangeKind::Deleted,
            EntityChangeKind::Created,
        ]
    );
    container.clear_updated();
    assert!(container.updated_indices().is_empty());
    assert_eq!(container.entity_changes().len(), 3);
    container.clear_entity_changes();
    assert!(container.entity_changes().is_empty());
    assert!(container.get(-1).is_none());
}

fn decode_packets(packets: &[Vec<u8>], filtered: bool) -> EntityContainer {
    let mut entities = EntityContainer::new();
    let class_info = classes();
    let serializer_container = serializers();
    let tables = StringTableContainer::new();
    for packet in packets {
        entities.clear_tick_changes();
        if filtered {
            apply_packet_filtered(
                &mut entities,
                packet,
                &class_info,
                &serializer_container,
                &tables,
                &HashSet::from(["CTest"]),
            )
            .unwrap();
        } else {
            apply_packet(
                &mut entities,
                packet,
                &class_info,
                &serializer_container,
                &tables,
            )
            .unwrap();
        }
    }
    entities
}

#[test]
fn packet_create_records_the_entity_identity() {
    for filtered in [false, true] {
        let entities = decode_packets(&[create_packet(5, true)], filtered);
        assert!(entities.get(5).unwrap().active);
        assert!(entities.get(5).unwrap().get_bool(Some(field_key(0))));
        assert_eq!(entities.updated_indices(), &[5]);
        let created = &entities.entity_changes()[0];
        assert_eq!(
            (created.kind, created.index, created.serial),
            (EntityChangeKind::Created, 5, 7)
        );
    }
}

#[test]
fn packet_update_records_the_changed_value() {
    for filtered in [false, true] {
        let entities = decode_packets(&[create_packet(5, true), update_packet(5, false)], filtered);
        assert!(!entities.get(5).unwrap().get_bool(Some(field_key(0))));
        assert_eq!(entities.entity_changes()[0].kind, EntityChangeKind::Updated);
        assert_eq!(entities.updated_indices(), &[5]);
    }
}

#[test]
fn packet_leave_retains_an_inactive_entity() {
    for filtered in [false, true] {
        let entities = decode_packets(
            &[create_packet(5, true), packet_writer(5, CMD_LEAVE).finish()],
            filtered,
        );
        assert!(!entities.get(5).unwrap().active);
        assert_eq!(entities.len(), 1);
        assert!(entities.updated_indices().is_empty());
        assert_eq!(entities.entity_changes()[0].kind, EntityChangeKind::LeftPvs);
    }
}

#[test]
fn packet_update_reactivates_an_entity_after_leave() {
    for filtered in [false, true] {
        let entities = decode_packets(
            &[
                create_packet(5, false),
                packet_writer(5, CMD_LEAVE).finish(),
                update_packet(5, true),
            ],
            filtered,
        );
        assert!(entities.get(5).unwrap().active);
        assert!(entities.get(5).unwrap().get_bool(Some(field_key(0))));
        assert_eq!(entities.updated_indices(), &[5]);
        assert_eq!(
            entities.entity_changes()[0].kind,
            EntityChangeKind::Reactivated
        );
    }
}

#[test]
fn packet_delete_preserves_the_removed_entity_identity() {
    for filtered in [false, true] {
        let entities = decode_packets(
            &[
                create_packet(5, true),
                packet_writer(5, CMD_LEAVE | CMD_CREATE_DELETE).finish(),
            ],
            filtered,
        );
        assert!(entities.get(5).is_none());
        let deleted = &entities.entity_changes()[0];
        assert_eq!(deleted.kind, EntityChangeKind::Deleted);
        assert_eq!((deleted.index, deleted.serial, deleted.class_id), (5, 7, 0));
        assert_eq!(&*deleted.class_name, "CTest");
    }
}

#[test]
fn slot_reuse_emits_old_delete_before_new_create() {
    let class_info = classes();
    let serializer_container = serializers();
    let tables = StringTableContainer::new();
    let mut entities = EntityContainer::new();

    apply_packet(
        &mut entities,
        &create_packet_with_serial(5, 7, true),
        &class_info,
        &serializer_container,
        &tables,
    )
    .unwrap();
    entities.clear_tick_changes();
    apply_packet(
        &mut entities,
        &create_packet_with_serial(5, 19, false),
        &class_info,
        &serializer_container,
        &tables,
    )
    .unwrap();

    let changes = entities.entity_changes();
    assert_eq!(entities.len(), 1);
    assert_eq!(changes.len(), 2);
    assert_eq!(
        (changes[0].kind, changes[0].index, changes[0].serial),
        (EntityChangeKind::Deleted, 5, 7)
    );
    assert_eq!(
        (changes[1].kind, changes[1].index, changes[1].serial),
        (EntityChangeKind::Created, 5, 19)
    );
    assert_eq!(entities.updated_indices(), &[5]);
}

#[test]
fn entity_create_applies_the_instance_baseline_before_the_delta() {
    let mut baseline = BitWriter::default();
    emit_single_bool_update(&mut baseline, true);
    let baseline = baseline.finish();

    let mut table_bits = BitWriter::default();
    table_bits.push_bool(true);
    table_bits.push_bool(true);
    table_bits.push_bool(false);
    table_bits.push_c_string("0");
    table_bits.push_bool(true);
    table_bits.push_bits(baseline.len() as u64, 17);
    table_bits.push_bytes(&baseline);
    let mut tables = StringTableContainer::new();
    tables
        .handle_create(CreateStringTable::new(
            super::super::string_tables::INSTANCE_BASELINE_TABLE_NAME,
            1,
            table_bits.finish(),
        ))
        .unwrap();
    tables.update_instance_baselines();

    let mut create = packet_writer(1, CMD_CREATE_DELETE);
    create.push_bits(0, 1);
    create.push_bits(0, NUM_SERIAL_NUM_BITS as usize);
    create.push_uvarint32(0);
    emit_op(&mut create, FINISH);
    let mut entities = EntityContainer::new();
    apply_packet(
        &mut entities,
        &create.finish(),
        &classes(),
        &serializers(),
        &tables,
    )
    .unwrap();

    assert!(entities.get(1).unwrap().get_bool(Some(field_key(0))));
}

#[test]
fn filtered_create_removes_a_previously_tracked_occupant() {
    let mut entities = EntityContainer::new();
    entities.insert(Entity::new(2, 99, "stale".into())).unwrap();
    entities.clear_tick_changes();
    apply_packet_filtered(
        &mut entities,
        &create_packet(2, true),
        &classes(),
        &serializers(),
        &StringTableContainer::new(),
        &HashSet::new(),
    )
    .unwrap();
    assert!(entities.get(2).is_none());
    assert_eq!(entities.skipped_class(2), Some(0));
    assert_eq!(entities.len(), 0);
    assert_eq!(entities.entity_changes().len(), 1);
    assert_eq!(entities.entity_changes()[0].kind, EntityChangeKind::Deleted);
}

#[test]
fn filtered_update_does_not_report_changes_for_skipped_classes() {
    let mut entities = EntityContainer::new();
    entities.set_skipped(2, Some(0));
    apply_packet_filtered(
        &mut entities,
        &update_packet(2, false),
        &classes(),
        &serializers(),
        &StringTableContainer::new(),
        &HashSet::new(),
    )
    .unwrap();
    assert!(entities.updated_indices().is_empty());
    assert!(entities.entity_changes().is_empty());
}

#[test]
fn selected_create_clears_the_skipped_class_marker() {
    let mut entities = EntityContainer::new();
    entities.set_skipped(2, Some(0));
    apply_packet_filtered(
        &mut entities,
        &create_packet(2, true),
        &classes(),
        &serializers(),
        &StringTableContainer::new(),
        &HashSet::from(["CTest"]),
    )
    .unwrap();
    assert!(entities.get(2).is_some());
    assert_eq!(entities.skipped_class(2), None);
}

#[test]
fn filtered_leave_and_delete_keep_then_clear_skipped_class_state() {
    let mut entities = EntityContainer::new();
    entities.set_skipped(3, Some(0));
    entities.handle_leave_filtered(3, false);
    assert_eq!(entities.skipped_class(3), Some(0));
    assert!(entities.entity_changes().is_empty());
    entities.handle_leave_filtered(3, true);
    assert_eq!(entities.skipped_class(3), None);
    assert!(entities.entity_changes().is_empty());

    entities.put_entity(3, Entity::new(3, 0, "CTest".into()));
    entities.clear_tick_changes();
    entities.handle_leave_filtered(3, false);
    assert!(!entities.get(3).unwrap().active);
    assert_eq!(entities.entity_changes()[0].kind, EntityChangeKind::LeftPvs);
    entities.clear_tick_changes();
    entities.handle_leave_filtered(3, true);
    assert!(entities.get(3).is_none());
    assert_eq!(entities.entity_changes()[0].kind, EntityChangeKind::Deleted);
}

fn decode_empty_container(packet: PacketEntities<'_>, limits: DecodeLimits) -> Result<()> {
    EntityContainer::new().handle_packet_entities(
        packet,
        &classes(),
        &serializers(),
        &StringTableContainer::new(),
        &mut FieldDecodeContext::with_limits(1.0 / 64.0, limits),
        &mut Vec::new(),
    )
}

#[test]
fn packet_validation_rejects_negative_update_counts() {
    let error = decode_empty_container(PacketEntities::new(-1, &[], 0), DecodeLimits::default())
        .unwrap_err();
    assert!(
        matches!(error, Error::Parse { context } if context.contains("negative packet-entity"))
    );
}

#[test]
fn packet_validation_enforces_the_update_limit() {
    let error = decode_empty_container(
        PacketEntities::new(1, &[], 0),
        DecodeLimits::default().with_max_packet_entity_updates(0),
    )
    .unwrap_err();
    assert!(matches!(
        error,
        Error::LimitExceeded {
            resource: "packet entity updates",
            ..
        }
    ));
}

#[test]
fn packet_validation_rejects_out_of_range_indices() {
    let data = packet_writer(MAX_ENTITY_INDEX as u32 + 1, 0).finish();
    let error = decode_empty_container(PacketEntities::new(1, &data, 0), DecodeLimits::default())
        .unwrap_err();
    assert!(matches!(error, Error::Parse { context } if context.contains("out of range")));
}

#[test]
fn packet_validation_rejects_updates_for_missing_entities() {
    let data = packet_writer(0, 0).finish();
    let error = decode_empty_container(PacketEntities::new(1, &data, 0), DecodeLimits::default())
        .unwrap_err();
    assert!(matches!(error, Error::Parse { context } if context.contains("non-existent entity")));
}

#[test]
fn pvs_skip_avoids_updating_a_missing_entity() {
    let mut packet = packet_writer(0, 0);
    packet.push_bits(1, 2);
    let mut entities = EntityContainer::new();
    entities
        .handle_packet_entities(
            PacketEntities::new(1, &packet.finish(), 1),
            &classes(),
            &serializers(),
            &StringTableContainer::new(),
            &mut FieldDecodeContext::new(1.0 / 64.0),
            &mut Vec::new(),
        )
        .expect("PVS skip does not require an entity");
    assert!(entities.is_empty());
}

#[test]
fn create_errors_identify_unknown_classes_serializers_and_fields() {
    let mut header = packet_writer(0, CMD_CREATE_DELETE);
    header.push_bits(0, 1);
    header.push_bits(0, NUM_SERIAL_NUM_BITS as usize);
    header.push_uvarint32(0);
    let header = header.finish();
    let tables = StringTableContainer::new();

    let unknown_class = apply_packet(
        &mut EntityContainer::new(),
        &header,
        &ClassInfo::empty(),
        &SerializerContainer::default(),
        &tables,
    )
    .expect_err("class ID is unknown");
    assert!(
        matches!(unknown_class, Error::Parse { context } if context.contains("unknown class_id 0"))
    );

    let missing_serializer = apply_packet(
        &mut EntityContainer::new(),
        &header,
        &classes(),
        &SerializerContainer::default(),
        &tables,
    )
    .expect_err("serializer is missing");
    assert!(
        matches!(missing_serializer, Error::Parse { context } if context.contains("no serializer for CTest"))
    );

    let mut invalid_field = packet_writer(0, CMD_CREATE_DELETE);
    invalid_field.push_bits(0, 1);
    invalid_field.push_bits(0, NUM_SERIAL_NUM_BITS as usize);
    invalid_field.push_uvarint32(0);
    emit_op(&mut invalid_field, 1);
    emit_op(&mut invalid_field, FINISH);
    invalid_field.push_bool(true);
    let field_error = apply_packet(
        &mut EntityContainer::new(),
        &invalid_field.finish(),
        &classes(),
        &serializers(),
        &tables,
    )
    .expect_err("field index exceeds serializer");
    assert!(
        matches!(field_error, Error::Parse { context } if context.contains("field path out of range"))
    );
}

#[test]
fn full_handles_reject_stale_serials_and_invalid_sentinels() {
    let mut entities = EntityContainer::new();
    let mut entity = Entity::new(2, 1, "Pawn".into());
    entity.serial = 9;
    entity.active = false; // Dormancy is not deletion.
    entities.insert(entity).unwrap();
    assert!(entities.get_by_handle((9 << 14) | 2).is_some());
    assert!(entities.get_by_handle((10 << 14) | 2).is_none());
    assert!(entities.get_by_handle((9 << 14) | 3).is_none());
    let mut replacement = Entity::new(2, 1, "Pawn".into());
    replacement.serial = 10;
    entities.insert(replacement).unwrap();
    assert!(entities.get_by_handle((9 << 14) | 2).is_none());
    assert!(entities.get_by_handle((10 << 14) | 2).is_some());
    for handle in [INVALID_ENTITY_HANDLE, u32::MAX] {
        let mut entity = Entity::new((handle & ENTITY_HANDLE_INDEX_MASK) as i32, 1, "Pawn".into());
        entity.serial = handle >> 14;
        entities.insert(entity).unwrap();
        assert!(entities.get_by_handle(handle).is_none());
    }
}
#[test]
fn pointer_clear_removes_child_value() {
    let definitions = FlattenedSerializer::new(
        vec![
            FlattenedSerializerDefinition::new(Some(1), vec![1]),
            FlattenedSerializerDefinition::new(Some(0), vec![0, 1]),
        ],
        vec![
            "CTest".into(),
            "CChild".into(),
            "CChild*".into(),
            "m_child".into(),
            "uint32".into(),
            "m_value".into(),
        ],
        vec![
            FlattenedField::new(Some(2), Some(3)).with_serializer_name_sym(Some(1)),
            FlattenedField::new(Some(4), Some(5)),
        ],
    );
    let serializers = SerializerContainer::parse(definitions, PROFILE).unwrap();
    let serializer = serializers.get("CTest").unwrap();
    let mut entity = Entity::new(0, 0, "CTest".into());
    let child = serializer.resolve_field_key("m_child.m_value").unwrap();
    entity.fields.insert(child, FieldValue::U32(42));
    let mut partial = BitWriter::default();
    emit_single_bool_update(&mut partial, true);
    entity
        .apply_update::<false>(
            &mut BitReader::new(&partial.finish()),
            serializer,
            &mut FieldDecodeContext::new(1.0 / 64.0),
            &mut Vec::new(),
            None,
        )
        .unwrap();
    assert_eq!(entity.get_u32(Some(child)), 42);
    let mut update = BitWriter::default();
    emit_single_bool_update(&mut update, false);
    entity
        .apply_update::<false>(
            &mut BitReader::new(&update.finish()),
            serializer,
            &mut FieldDecodeContext::new(1.0 / 64.0),
            &mut Vec::new(),
            None,
        )
        .unwrap();
    assert!(matches!(
        entity.get_by_name("m_child", serializer),
        Some(FieldValue::Bool(false))
    ));
    assert!(
        entity.get_by_name("m_child.m_value", serializer).is_none(),
        "child still present after pointer is false: {:?}",
        entity.get_by_name("m_child.m_value", serializer)
    );
}

#[test]
fn dynamic_array_shrink_then_grow_does_not_restore_old_child() {
    let serializers = SerializerContainer::parse(
        FlattenedSerializer::new(
            vec![FlattenedSerializerDefinition::new(Some(0), vec![0])],
            vec![
                "CTest".into(),
                "CNetworkUtlVectorBase< uint32 >".into(),
                "m_values".into(),
            ],
            vec![FlattenedField::new(Some(1), Some(2))],
        ),
        PROFILE,
    )
    .unwrap();
    let serializer = serializers.get("CTest").unwrap();
    let mut entity = Entity::new(0, 0, "CTest".into());
    let child = serializer.resolve_field_key("m_values.1").unwrap();
    entity.fields.insert(child, FieldValue::U32(99));
    for count in [0, 2] {
        let mut update = BitWriter::default();
        emit_op(&mut update, 0);
        emit_op(&mut update, FINISH);
        update.push_uvarint32(count);
        entity
            .apply_update::<false>(
                &mut BitReader::new(&update.finish()),
                serializer,
                &mut FieldDecodeContext::new(1.0 / 64.0),
                &mut Vec::new(),
                None,
            )
            .unwrap();
    }
    assert!(
        entity.get_by_name("m_values.1", serializer).is_none(),
        "removed array element returned after regrowth: {:?}",
        entity.get_by_name("m_values.1", serializer)
    );
}
#[test]
fn array_index_256_must_not_alias_zero() {
    let serializers = SerializerContainer::parse(
        FlattenedSerializer::new(
            vec![FlattenedSerializerDefinition::new(Some(0), vec![0])],
            vec![
                "CTest".into(),
                "CNetworkUtlVectorBase< uint32 >".into(),
                "m_values".into(),
            ],
            vec![FlattenedField::new(Some(1), Some(2))],
        ),
        PROFILE,
    )
    .unwrap();
    let serializer = serializers.get("CTest").unwrap();
    assert_ne!(
        serializer.resolve_field_key("m_values.0"),
        serializer.resolve_field_key("m_values.256")
    );
}
#[test]
fn wire_array_index_256_must_not_alias_zero() {
    let mut update = BitWriter::default();
    emit_op(&mut update, 8);
    update.push_ubitvarfp(256);
    emit_op(&mut update, FINISH);
    let mut paths = Vec::new();
    field_path::read_field_paths(&mut BitReader::new(&update.finish()), &mut paths).unwrap();
    assert_eq!(paths[0].get(0), 0);
    assert_eq!(paths[0].get(1), 256, "wire array index was truncated");
}

#[test]
fn wire_field_paths_reject_unrepresentable_components() {
    for (op, value) in [(8, 4096), (8, 0x7fff_ffff), (4, 0x7fff_ffff)] {
        let mut update = BitWriter::default();
        emit_op(&mut update, op);
        update.push_ubitvarfp(value);
        emit_op(&mut update, FINISH);
        let mut paths = Vec::new();
        assert!(matches!(
            field_path::read_field_paths(&mut BitReader::new(&update.finish()), &mut paths),
            Err(Error::Parse { .. })
        ));
        assert!(paths.is_empty());
    }
}

fn baseline_tables(value: bool) -> StringTableContainer {
    let mut baseline = BitWriter::default();
    emit_single_bool_update(&mut baseline, value);
    let bytes = baseline.finish();
    encoded_baseline_tables(&bytes)
}

fn encoded_baseline_tables(bytes: &[u8]) -> StringTableContainer {
    let mut bits = BitWriter::default();
    bits.push_bool(true);
    bits.push_bool(true);
    bits.push_bool(false);
    bits.push_c_string("0");
    bits.push_bool(true);
    bits.push_bits(bytes.len() as u64, 17);
    bits.push_bytes(bytes);
    let mut tables = StringTableContainer::new();
    tables
        .handle_create(CreateStringTable::new(
            super::super::string_tables::INSTANCE_BASELINE_TABLE_NAME,
            1,
            bits.finish(),
        ))
        .unwrap();
    tables.update_instance_baselines();
    tables
}

fn apply_cached_baseline(
    cache: &mut BaselineCache,
    tables: &StringTableContainer,
    schemas: &SerializerContainer,
    context: &mut FieldDecodeContext,
) -> Result<bool> {
    let mut entity = Entity::new(0, 0, "CTest".into());
    cache.apply::<false>(
        &mut entity,
        schemas.get("CTest").unwrap(),
        schemas,
        tables,
        context,
        &mut Vec::new(),
        None,
    )?;
    Ok(entity.get_bool(Some(field_key(0))))
}

fn populated_baseline_cache() -> (
    BaselineCache,
    SerializerContainer,
    StringTableContainer,
    FieldDecodeContext,
) {
    let schemas = serializers();
    let tables = baseline_tables(true);
    let mut context = FieldDecodeContext::new(1.0 / 64.0);
    let mut cache = BaselineCache::default();
    apply_cached_baseline(&mut cache, &tables, &schemas, &mut context).unwrap();
    (cache, schemas, tables, context)
}

#[test]
fn unchanged_baselines_reuse_one_cache_entry() {
    let (mut cache, schemas, tables, mut context) = populated_baseline_cache();
    assert!(apply_cached_baseline(&mut cache, &tables, &schemas, &mut context).unwrap());
    assert_eq!(cache.entries.len(), 1);
}

#[test]
fn cloned_baseline_caches_start_empty() {
    let cache = populated_baseline_cache().0;
    let cloned = cache.clone();
    assert!(cloned.entries.is_empty());
    assert!(!cache.entries.is_empty());
}

#[test]
fn changed_baseline_bytes_replace_cached_values() {
    let (mut cache, schemas, _, mut context) = populated_baseline_cache();
    assert!(
        !apply_cached_baseline(&mut cache, &baseline_tables(false), &schemas, &mut context)
            .unwrap()
    );
}

#[test]
fn replacement_schemas_invalidate_cached_baselines() {
    let (mut cache, _, tables, mut context) = populated_baseline_cache();
    let replacement = serializers();
    apply_cached_baseline(&mut cache, &tables, &replacement, &mut context).unwrap();
    assert!(Arc::ptr_eq(
        &cache.entries[&0].schema,
        replacement.schema_id()
    ));
}

#[test]
fn cached_baselines_still_enforce_stricter_decode_limits() {
    let (mut cache, schemas, tables, _) = populated_baseline_cache();
    let mut context = FieldDecodeContext::with_limits(
        1.0 / 30.0,
        DecodeLimits::default().with_max_field_paths(0),
    );
    assert!(apply_cached_baseline(&mut cache, &tables, &schemas, &mut context).is_err());
}

#[test]
fn cached_simulation_time_uses_the_current_tick_interval() {
    let schemas = SerializerContainer::parse(
        FlattenedSerializer::new(
            vec![FlattenedSerializerDefinition::new(Some(0), vec![0])],
            vec![
                "CTest".into(),
                "float32".into(),
                "m_flSimulationTime".into(),
                "simtime".into(),
            ],
            vec![FlattenedField::new(Some(1), Some(2)).with_encoder_sym(Some(3))],
        ),
        PROFILE,
    )
    .unwrap();
    let mut bits = BitWriter::default();
    emit_op(&mut bits, 0);
    emit_op(&mut bits, FINISH);
    bits.push_uvarint32(128);
    let tables = encoded_baseline_tables(&bits.finish());
    let mut cache = BaselineCache::default();
    let mut entity = Entity::new(0, 0, "CTest".into());
    let mut context = FieldDecodeContext::new(1.0 / 64.0);
    for (interval, seconds) in [(1.0 / 64.0, 2.0), (1.0 / 32.0, 4.0)] {
        context.set_tick_interval(interval);
        cache
            .apply::<false>(
                &mut entity,
                schemas.get("CTest").unwrap(),
                &schemas,
                &tables,
                &mut context,
                &mut Vec::new(),
                None,
            )
            .unwrap();
        assert_eq!(entity.get_f32(Some(field_key(0))), seconds);
    }
}

#[test]
fn wide_array_values_survive_independently_and_shrink_removes_only_discarded_elements() {
    let schemas = SerializerContainer::parse(
        FlattenedSerializer::new(
            vec![FlattenedSerializerDefinition::new(Some(0), vec![0])],
            vec![
                "CTest".into(),
                "CNetworkUtlVectorBase< uint32 >".into(),
                "m_values".into(),
            ],
            vec![FlattenedField::new(Some(1), Some(2))],
        ),
        PROFILE,
    )
    .unwrap();
    let serializer = schemas.get("CTest").unwrap();
    let mut entity = Entity::new(0, 0, "CTest".into());
    let mut bits = BitWriter::default();
    emit_op(&mut bits, 0); // vector length
    emit_op(&mut bits, 5); // element 0
    emit_op(&mut bits, 4); // element 256: PlusN adds five
    bits.push_ubitvarfp(251);
    emit_op(&mut bits, FINISH);
    for value in [257, 11, 22] {
        bits.push_uvarint32(value);
    }
    entity
        .apply_update::<false>(
            &mut BitReader::new(&bits.finish()),
            serializer,
            &mut FieldDecodeContext::new(1.0 / 64.0),
            &mut Vec::new(),
            None,
        )
        .unwrap();
    let zero = serializer.resolve_field_key("m_values.0").unwrap();
    let wide = serializer.resolve_field_key("m_values.256").unwrap();
    assert_eq!(entity.get_u32(Some(zero)), 11);
    assert_eq!(entity.get_u32(Some(wide)), 22);
    for length in [1, 257] {
        let mut bits = BitWriter::default();
        emit_op(&mut bits, 0);
        emit_op(&mut bits, FINISH);
        bits.push_uvarint32(length);
        entity
            .apply_update::<false>(
                &mut BitReader::new(&bits.finish()),
                serializer,
                &mut FieldDecodeContext::new(1.0 / 64.0),
                &mut Vec::new(),
                None,
            )
            .unwrap();
        assert_eq!(entity.get_u32(Some(zero)), 11);
        assert!(entity.field_value(Some(wide)).is_none());
    }
    assert!(serializer.resolve_field_key("m_values.4096").is_none());
}

mod property_filter;
