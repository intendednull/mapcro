//! How stored rows are encoded (spec §9). The inner format is always the JSON the engine
//! serializes, so `#[serde(default)]` field additions keep working; the codec only compresses
//! it. Each row names its codec, so old rows stay readable and a new dictionary is a new codec
//! alongside the old, never a replacement.
//!
//! - `json`: the JSON as is (every row written before schema v4).
//! - `zstd-v1`: zstd at level 3 with the static dictionary `dict/ops-v1.zdict`, trained on
//!   simulation data by `just zdict`. The frame is written without its 4-byte magic number (the
//!   codec tag already says what it is), without a dictionary id or checksum, and with its
//!   content size, which bounds the buffer a read allocates.

use std::cell::RefCell;

/// The dictionary `zstd-v1` rows are written with. Never change it in place: a different
/// dictionary is `zstd-v2`, with its own file.
static DICT_V1: &[u8] = include_bytes!("../dict/ops-v1.zdict");
const LEVEL: i32 = 3;
const MAGIC: [u8; 4] = 0xFD2F_B528u32.to_le_bytes();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    Json,
    ZstdV1,
}

#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("unknown codec {0:?}")]
    Unknown(String),
    #[error("compressed row is corrupt: {0}")]
    Corrupt(String),
    #[error("row decodes to {0} bytes, over the {1}-byte limit")]
    TooLarge(u64, usize),
}

impl Codec {
    pub fn as_str(self) -> &'static str {
        match self {
            Codec::Json => "json",
            Codec::ZstdV1 => "zstd-v1",
        }
    }

    pub fn parse(s: &str) -> Result<Codec, CodecError> {
        match s {
            "json" => Ok(Codec::Json),
            "zstd-v1" => Ok(Codec::ZstdV1),
            other => Err(CodecError::Unknown(other.to_owned())),
        }
    }
}

thread_local! {
    static COMPRESSOR: RefCell<Option<zstd::bulk::Compressor<'static>>> = const { RefCell::new(None) };
    static DECOMPRESSOR: RefCell<Option<zstd::bulk::Decompressor<'static>>> = const { RefCell::new(None) };
}

fn compressor() -> std::io::Result<zstd::bulk::Compressor<'static>> {
    use zstd::stream::raw::CParameter;
    let mut c = zstd::bulk::Compressor::with_dictionary(LEVEL, DICT_V1)?;
    c.set_parameter(CParameter::DictIdFlag(false))?;
    c.set_parameter(CParameter::ChecksumFlag(false))?;
    c.set_parameter(CParameter::ContentSizeFlag(true))?;
    Ok(c)
}

/// Encode JSON for storage: `zstd-v1`, or the JSON itself if compressing doesn't make it smaller.
pub fn encode(json: &[u8]) -> (Codec, Vec<u8>) {
    let compressed = COMPRESSOR.with(|cell| {
        let mut cell = cell.borrow_mut();
        if cell.is_none() {
            *cell = compressor().ok();
        }
        cell.as_mut().and_then(|c| c.compress(json).ok())
    });
    match compressed {
        Some(frame) if frame.starts_with(&MAGIC) && frame.len() - MAGIC.len() < json.len() => {
            (Codec::ZstdV1, frame[MAGIC.len()..].to_vec())
        }
        _ => (Codec::Json, json.to_vec()),
    }
}

/// Decode a stored row back to its JSON, refusing anything that would decode past `limit`.
pub fn decode(codec: Codec, stored: &[u8], limit: usize) -> Result<Vec<u8>, CodecError> {
    match codec {
        Codec::Json if stored.len() > limit => Err(CodecError::TooLarge(stored.len() as u64, limit)),
        Codec::Json => Ok(stored.to_vec()),
        Codec::ZstdV1 => {
            let mut frame = Vec::with_capacity(MAGIC.len() + stored.len());
            frame.extend_from_slice(&MAGIC);
            frame.extend_from_slice(stored);
            let size = match zstd::zstd_safe::get_frame_content_size(&frame) {
                Ok(Some(n)) => n,
                _ => return Err(CodecError::Corrupt("no content size".into())),
            };
            if size > limit as u64 {
                return Err(CodecError::TooLarge(size, limit));
            }
            let out = DECOMPRESSOR.with(|cell| {
                let mut cell = cell.borrow_mut();
                if cell.is_none() {
                    *cell = Some(zstd::bulk::Decompressor::with_dictionary(DICT_V1).map_err(|e| CodecError::Corrupt(e.to_string()))?);
                }
                let d = cell.as_mut().ok_or_else(|| CodecError::Corrupt("no decompressor".into()))?;
                d.decompress(&frame, size as usize).map_err(|e| CodecError::Corrupt(e.to_string()))
            })?;
            if out.len() as u64 != size {
                return Err(CodecError::Corrupt("content size mismatch".into()));
            }
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_falls_back_to_json_when_smaller() {
        let tx = br#"{"client":"0123456789abcdef0123456789abcdef","cseq":7,"kind":"Edit","ops":[{"Set":{"id":"00000000000000000000000000000001","value":{"PlayerPos":{"x":120,"y":-3400}}}}]}"#;
        let (codec, stored) = encode(tx);
        assert_eq!(codec, Codec::ZstdV1);
        assert!(stored.len() < tx.len() / 2, "{} of {}", stored.len(), tx.len());
        assert_eq!(decode(codec, &stored, 1 << 16).expect("decodes"), tx);
        // Two bytes don't compress: stored as JSON.
        assert_eq!(encode(b"{}"), (Codec::Json, b"{}".to_vec()));
    }

    #[test]
    fn decoding_is_bounded_and_rejects_garbage() {
        let big = format!(r#"{{"text":"{}"}}"#, "a".repeat(10_000));
        let (codec, stored) = encode(big.as_bytes());
        assert!(matches!(decode(codec, &stored, 1000), Err(CodecError::TooLarge(..))));
        assert!(decode(Codec::ZstdV1, b"not a frame", 1000).is_err());
        assert!(Codec::parse("zstd-v9").is_err());
    }
}
