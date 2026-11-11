use super::*;
use crate::PropertyFilter;

fn two_fields() -> SerializerContainer {
    SerializerContainer::parse(
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
        PROFILE,
    )
    .unwrap()
}

fn scalar_packet() -> Vec<u8> {
    let mut bits = packet_writer(0, CMD_CREATE_DELETE);
    bits.push_bits(0, 1);
    bits.push_bits(7, NUM_SERIAL_NUM_BITS as usize);
    bits.push_uvarint32(0);
    emit_op(&mut bits, 0);
    emit_op(&mut bits, 0);
    emit_op(&mut bits, FINISH);
    bits.push_uvarint32(300);
    bits.push_uvarint32(42);
    bits.finish()
}

fn projected_scalars() -> EntityContainer {
    let schemas = two_fields();
    let filter = PropertyFilter::new(&schemas, [("CTest", ["m_second"])]);
    let mut entities = EntityContainer::with_properties(filter);
    apply_packet(
        &mut entities,
        &scalar_packet(),
        &classes(),
        &schemas,
        &StringTableContainer::new(),
    )
    .unwrap();
    entities
}

#[test]
fn skipping_a_scalar_keeps_the_next_value_aligned() {
    assert_eq!(
        projected_scalars()
            .get(0)
            .unwrap()
            .get_u32(Some(field_key(1))),
        42
    );
}

#[test]
fn unselected_scalar_values_are_not_stored() {
    assert!(
        projected_scalars()
            .get(0)
            .unwrap()
            .field_value(Some(field_key(0)))
            .is_none()
    );
}

#[test]
fn unlisted_classes_keep_all_values() {
    let schemas = two_fields();
    let mut entities =
        EntityContainer::with_properties(PropertyFilter::new(&schemas, [("Other", ["m_first"])]));
    apply_packet(
        &mut entities,
        &scalar_packet(),
        &classes(),
        &schemas,
        &StringTableContainer::new(),
    )
    .unwrap();
    assert_eq!(entities.get(0).unwrap().fields.len(), 2);
}

#[test]
fn missing_optional_paths_do_not_select_other_values() {
    let schemas = two_fields();
    let mut entities =
        EntityContainer::with_properties(PropertyFilter::new(&schemas, [("CTest", ["missing"])]));
    apply_packet(
        &mut entities,
        &scalar_packet(),
        &classes(),
        &schemas,
        &StringTableContainer::new(),
    )
    .unwrap();
    assert!(entities.get(0).unwrap().fields.is_empty());
}

#[test]
fn repeated_class_requests_are_combined() {
    let schemas = two_fields();
    let filter = PropertyFilter::new(&schemas, [("CTest", ["m_first"]), ("CTest", ["m_second"])]);
    let mut entities = EntityContainer::with_properties(filter);
    apply_packet(
        &mut entities,
        &scalar_packet(),
        &classes(),
        &schemas,
        &StringTableContainer::new(),
    )
    .unwrap();
    assert_eq!(entities.get(0).unwrap().fields.len(), 2);
}

#[test]
fn a_different_serializer_schema_is_rejected() {
    let schemas = serializers();
    let mut entities =
        EntityContainer::with_properties(PropertyFilter::new(&schemas, [("CTest", ["m_flag"])]));
    let error = apply_packet(
        &mut entities,
        &create_packet(0, true),
        &classes(),
        &serializers(),
        &StringTableContainer::new(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("different serializer schema"));
}

#[test]
fn cloned_schemas_preserve_filter_identity() {
    let schemas = serializers();
    let cloned = schemas.clone();
    let mut entities =
        EntityContainer::with_properties(PropertyFilter::new(&schemas, [("CTest", ["m_flag"])]));
    apply_packet(
        &mut entities,
        &create_packet(0, true),
        &classes(),
        &cloned,
        &StringTableContainer::new(),
    )
    .unwrap();
    assert!(entities.get(0).unwrap().get_bool(Some(field_key(0))));
}

#[test]
fn class_and_property_filters_can_be_combined() {
    let schemas = two_fields();
    let mut entities =
        EntityContainer::with_properties(PropertyFilter::new(&schemas, [("CTest", ["m_second"])]));
    apply_packet_filtered(
        &mut entities,
        &scalar_packet(),
        &classes(),
        &schemas,
        &StringTableContainer::new(),
        &HashSet::from(["CTest"]),
    )
    .unwrap();
    assert_eq!(entities.get(0).unwrap().fields.len(), 1);
}

#[test]
fn cached_baselines_do_not_restore_unselected_values() {
    let schemas = serializers();
    let mut entities =
        EntityContainer::with_properties(PropertyFilter::new(&schemas, [("CTest", ["missing"])]));
    let tables = baseline_tables(true);
    for index in [0, 1] {
        apply_packet(
            &mut entities,
            &create_packet(index, true),
            &classes(),
            &schemas,
            &tables,
        )
        .unwrap();
    }
    assert!(entities.get(1).unwrap().fields.is_empty());
}

#[test]
fn a_fresh_filter_does_not_reuse_another_filters_baseline_cache() {
    let schemas = serializers();
    let tables = baseline_tables(true);
    let mut omitted =
        EntityContainer::with_properties(PropertyFilter::new(&schemas, [("CTest", ["missing"])]));
    apply_packet(
        &mut omitted,
        &create_packet(0, false),
        &classes(),
        &schemas,
        &tables,
    )
    .unwrap();
    let mut included =
        EntityContainer::with_properties(PropertyFilter::new(&schemas, [("CTest", ["m_flag"])]));
    let mut bits = packet_writer(0, CMD_CREATE_DELETE);
    bits.push_bits(0, 1);
    bits.push_bits(7, NUM_SERIAL_NUM_BITS as usize);
    bits.push_uvarint32(0);
    emit_op(&mut bits, FINISH);
    apply_packet(&mut included, &bits.finish(), &classes(), &schemas, &tables).unwrap();
    assert!(included.get(0).unwrap().get_bool(Some(field_key(0))));
}

#[test]
fn existing_state_is_pruned_before_projected_playback() {
    let schemas = two_fields();
    let mut entities = EntityContainer::new();
    apply_packet(
        &mut entities,
        &scalar_packet(),
        &classes(),
        &schemas,
        &StringTableContainer::new(),
    )
    .unwrap();
    entities
        .project_properties(
            PropertyFilter::new(&schemas, [("CTest", ["m_second"])]),
            &schemas,
        )
        .unwrap();
    assert!(
        entities
            .get(0)
            .unwrap()
            .field_value(Some(field_key(0)))
            .is_none()
    );
}

#[test]
fn an_existing_projection_cannot_be_widened() {
    let schemas = serializers();
    let mut entities =
        EntityContainer::with_properties(PropertyFilter::new(&schemas, [("CTest", ["missing"])]));
    assert!(
        entities
            .project_properties(
                PropertyFilter::new(&schemas, [("CTest", ["m_flag"])]),
                &schemas
            )
            .is_err()
    );
}

#[test]
fn skipped_strings_keep_decode_limits() {
    let schemas = SerializerContainer::parse(
        FlattenedSerializer::new(
            vec![FlattenedSerializerDefinition::new(Some(0), vec![0])],
            vec!["CTest".into(), "char[64]".into(), "m_text".into()],
            vec![FlattenedField::new(Some(1), Some(2))],
        ),
        PROFILE,
    )
    .unwrap();
    let mut entities =
        EntityContainer::with_properties(PropertyFilter::new(&schemas, [("CTest", ["missing"])]));
    let mut bits = packet_writer(0, CMD_CREATE_DELETE);
    bits.push_bits(0, 1);
    bits.push_bits(7, NUM_SERIAL_NUM_BITS as usize);
    bits.push_uvarint32(0);
    emit_op(&mut bits, 0);
    emit_op(&mut bits, FINISH);
    bits.push_c_string("too long");
    let error = entities
        .handle_packet_entities(
            PacketEntities::new(1, &bits.finish(), 0),
            &classes(),
            &schemas,
            &StringTableContainer::new(),
            &mut FieldDecodeContext::with_limits(
                1.0 / 64.0,
                DecodeLimits::default().with_max_field_string_bytes(2),
            ),
            &mut Vec::new(),
        )
        .unwrap_err();
    assert!(error.to_string().contains("limit"));
}

#[test]
fn truncated_unselected_values_still_fail() {
    let schemas = two_fields();
    let mut bytes = scalar_packet();
    bytes.truncate(bytes.len() - 2);
    let mut entities =
        EntityContainer::with_properties(PropertyFilter::new(&schemas, [("CTest", ["missing"])]));
    assert!(
        apply_packet(
            &mut entities,
            &bytes,
            &classes(),
            &schemas,
            &StringTableContainer::new()
        )
        .is_err()
    );
}

fn array_schema() -> SerializerContainer {
    SerializerContainer::parse(
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
    .unwrap()
}

fn array_value(index: u32, value: u32) -> Vec<u8> {
    let mut bits = BitWriter::default();
    emit_op(&mut bits, 8);
    bits.push_ubitvarfp(index);
    emit_op(&mut bits, FINISH);
    bits.push_uvarint32(value);
    bits.finish()
}

fn apply_fields(
    entity: &mut Entity,
    schemas: &SerializerContainer,
    filter: &PropertyFilter,
    bytes: &[u8],
) {
    entity
        .apply_update::<true>(
            &mut BitReader::new(bytes),
            schemas.get("CTest").unwrap(),
            &mut FieldDecodeContext::new(1.0 / 64.0),
            &mut Vec::new(),
            filter.get("CTest"),
        )
        .unwrap();
}

#[test]
fn selecting_an_array_retains_future_elements_above_255() {
    let schemas = array_schema();
    let filter = PropertyFilter::new(&schemas, [("CTest", ["m_values"])]);
    let mut entity = Entity::new(0, 0, "CTest".into());
    apply_fields(&mut entity, &schemas, &filter, &array_value(256, 99));
    assert!(matches!(
        entity.get_by_name("m_values.256", schemas.get("CTest").unwrap()),
        Some(FieldValue::U32(99) | FieldValue::U64(99))
    ));
}

#[test]
fn selecting_one_array_element_does_not_select_its_siblings() {
    let schemas = array_schema();
    let filter = PropertyFilter::new(&schemas, [("CTest", ["m_values.1"])]);
    let mut entity = Entity::new(0, 0, "CTest".into());
    apply_fields(&mut entity, &schemas, &filter, &array_value(256, 99));
    assert!(entity.fields.is_empty());
}

#[test]
fn unrequested_array_lengths_still_remove_selected_children() {
    let schemas = array_schema();
    let filter = PropertyFilter::new(&schemas, [("CTest", ["m_values.1"])]);
    let mut entity = Entity::new(0, 0, "CTest".into());
    apply_fields(&mut entity, &schemas, &filter, &array_value(1, 99));
    for count in [0, 2] {
        let mut bits = BitWriter::default();
        emit_op(&mut bits, 0);
        emit_op(&mut bits, FINISH);
        bits.push_uvarint32(count);
        apply_fields(&mut entity, &schemas, &filter, &bits.finish());
    }
    assert!(
        entity
            .get_by_name("m_values.1", schemas.get("CTest").unwrap())
            .is_none()
    );
}

#[test]
fn unrequested_pointer_presence_still_removes_selected_children() {
    let schemas = SerializerContainer::parse(
        FlattenedSerializer::new(
            vec![
                FlattenedSerializerDefinition::new(Some(1), vec![1]),
                FlattenedSerializerDefinition::new(Some(0), vec![0]),
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
        ),
        PROFILE,
    )
    .unwrap();
    let filter = PropertyFilter::new(&schemas, [("CTest", ["m_child.m_value"])]);
    let mut entity = Entity::new(0, 0, "CTest".into());
    entity.fields.insert(
        schemas
            .get("CTest")
            .unwrap()
            .resolve_field_key("m_child.m_value")
            .unwrap(),
        FieldValue::U32(99),
    );
    let mut bits = BitWriter::default();
    emit_single_bool_update(&mut bits, false);
    apply_fields(&mut entity, &schemas, &filter, &bits.finish());
    assert!(
        entity
            .get_by_name("m_child.m_value", schemas.get("CTest").unwrap())
            .is_none()
    );
}

#[test]
fn slot_reuse_does_not_restore_unselected_fields() {
    let schemas = serializers();
    let mut entities =
        EntityContainer::with_properties(PropertyFilter::new(&schemas, [("CTest", ["missing"])]));
    for serial in [7, 8] {
        apply_packet(
            &mut entities,
            &create_packet_with_serial(0, serial, true),
            &classes(),
            &schemas,
            &StringTableContainer::new(),
        )
        .unwrap();
    }
    assert!(entities.get(0).unwrap().fields.is_empty());
}
