//! Minimal KV1 text parser tests.

use mapcro_extract::Error;
use mapcro_extract::kv1::{Kv1Value, flatten, parse};

const SAMPLE: &str = "\u{feff}\"lang\"\n{\n\t// a comment\n\t\"Language\"\t\"english\"\n\t\"Tokens\"\n\t{\n\t\t\"hero_inferno:n\" \"Infernus\"\n\t\t\"escaped\" \"a\\\"b\\\\c\\n\"\n\t\t/* block comment */\n\t\t\"hero_hornet:n\" \"Vindicta\"\n\t}\n}\n";

#[test]
fn parses_nested_localisation() {
    let parsed = parse(SAMPLE).expect("parse KV1");
    let Kv1Value::Block(root) = parsed else {
        panic!("root must be a block");
    };
    assert_eq!(root.len(), 1);
    assert_eq!(root[0].0, "lang");

    let tokens = flatten(SAMPLE).expect("flatten KV1");
    assert_eq!(tokens.get("Language").map(String::as_str), Some("english"));
    assert_eq!(
        tokens.get("hero_inferno:n").map(String::as_str),
        Some("Infernus")
    );
    assert_eq!(
        tokens.get("hero_hornet:n").map(String::as_str),
        Some("Vindicta")
    );
    assert_eq!(
        tokens.get("escaped").map(String::as_str),
        Some("a\"b\\c\n")
    );
}

#[test]
fn unterminated_block_is_typed() {
    assert!(matches!(
        parse("\"lang\" { \"a\" \"b\""),
        Err(Error::Kv1UnexpectedEnd)
    ));
}

#[test]
fn unterminated_string_is_typed() {
    assert!(matches!(
        parse("\"lang\" { \"a\" \"unterminated"),
        Err(Error::Kv1UnexpectedEnd)
    ));
}

#[test]
fn trailing_value_is_typed() {
    assert!(matches!(
        parse("\"lang\" { } \"extra\" \"value\""),
        Err(Error::Kv1Trailing)
    ));
}
