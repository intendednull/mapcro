//! Binary KV3 unit tests against synthetic, test-generated blobs.

mod support;

use mapcro_extract::Error;
use mapcro_extract::kv3::{Value, decode};
use support::{T, encode_kv3};

fn tree() -> T {
    T::Object(vec![
        ("name", T::Str("test".into())),
        ("count", T::Int(42)),
        ("big", T::Int(5_000_000_000)),
        ("pi", T::Double(3.5)),
        ("enabled", T::Bool(true)),
        ("nothing", T::Null),
        (
            "list",
            T::Array(vec![T::Int(1), T::Str("two".into()), T::Bool(false)]),
        ),
        (
            "nested",
            T::Object(vec![("x", T::Double(-1.0)), ("y", T::Int(9))]),
        ),
    ])
}

fn assert_tree(root: &Value) {
    assert_eq!(root.get("name").and_then(Value::as_str), Some("test"));
    assert_eq!(root.get("count").and_then(Value::as_i64), Some(42));
    assert_eq!(
        root.get("big").and_then(Value::as_i64),
        Some(5_000_000_000)
    );
    assert_eq!(root.get("pi").and_then(Value::as_f64), Some(3.5));
    assert_eq!(root.get("enabled").and_then(Value::as_bool), Some(true));
    assert_eq!(root.get("nothing"), Some(&Value::Null));

    let list = root
        .get("list")
        .and_then(Value::as_array)
        .expect("list array");
    assert_eq!(list.len(), 3);
    assert_eq!(list[0].as_i64(), Some(1));
    assert_eq!(list[1].as_str(), Some("two"));
    assert_eq!(list[2].as_bool(), Some(false));

    let nested = root.get("nested").expect("nested object");
    assert_eq!(nested.get("x").and_then(Value::as_f64), Some(-1.0));
    assert_eq!(nested.get("y").and_then(Value::as_i64), Some(9));
}

#[test]
fn uncompressed_round_trip() {
    let encoded = encode_kv3(&tree(), 0);
    let decoded = decode(&encoded).expect("decode uncompressed KV3");
    assert_tree(&decoded);
}

#[test]
fn lz4_round_trip() {
    let encoded = encode_kv3(&tree(), 1);
    let decoded = decode(&encoded).expect("decode LZ4 KV3");
    assert_tree(&decoded);
}

#[test]
fn zstd_round_trip() {
    let encoded = encode_kv3(&tree(), 2);
    let decoded = decode(&encoded).expect("decode zstd KV3");
    assert_tree(&decoded);
}

#[test]
fn bad_magic_is_typed() {
    let mut encoded = encode_kv3(&tree(), 0);
    encoded[0..4].copy_from_slice(&0u32.to_le_bytes());
    assert!(matches!(decode(&encoded), Err(Error::Kv3BadMagic)));
}

#[test]
fn unsupported_version_is_typed() {
    let mut encoded = encode_kv3(&tree(), 0);
    encoded[0..4].copy_from_slice(&0x4B56_3304u32.to_le_bytes());
    assert!(matches!(
        decode(&encoded),
        Err(Error::UnsupportedKv3Version(4))
    ));
}

#[test]
fn unsupported_compression_is_typed() {
    let mut encoded = encode_kv3(&tree(), 0);
    encoded[20..24].copy_from_slice(&9u32.to_le_bytes());
    assert!(matches!(
        decode(&encoded),
        Err(Error::UnsupportedKv3Compression(9))
    ));
}

#[test]
fn truncated_header_is_typed() {
    let encoded = encode_kv3(&tree(), 0);
    assert!(matches!(
        decode(&encoded[..10]),
        Err(Error::TruncatedKv3)
    ));
}

#[test]
fn oversized_decompressed_length_is_typed() {
    let mut encoded = encode_kv3(&tree(), 0);
    encoded[72..76].copy_from_slice(&i32::MAX.to_le_bytes());
    assert!(matches!(decode(&encoded), Err(Error::Kv3TooLarge)));
}

#[test]
fn oversized_type_count_is_typed() {
    let mut encoded = encode_kv3(&tree(), 0);
    encoded[40..44].copy_from_slice(&i32::MAX.to_le_bytes());
    assert!(matches!(decode(&encoded), Err(Error::Kv3TooLarge)));
}

#[test]
fn deep_nesting_is_typed() {
    let mut value = T::Int(1);
    for _ in 0..100 {
        value = T::Array(vec![value]);
    }
    let encoded = encode_kv3(&value, 0);
    assert!(matches!(
        decode(&encoded),
        Err(Error::Kv3NestingTooDeep)
    ));
}

#[test]
fn bad_trailer_is_typed() {
    let mut encoded = encode_kv3(&tree(), 0);
    let length = encoded.len();
    encoded[length - 4..length].copy_from_slice(&0u32.to_le_bytes());
    assert!(matches!(decode(&encoded), Err(Error::Kv3BadTrailer(0))));
}
