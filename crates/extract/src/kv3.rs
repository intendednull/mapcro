//! Binary KV3 (Source 2's compiled KeyValues3) reader.
//!
//! Ported from ValveResourceFormat (MIT), `Resource/ResourceTypes/BinaryKV3.cs`,
//! `BinaryKV3.NodeType.cs` and `BinaryKV3.Serialization.cs`:
//! <https://github.com/ValveResourceFormat/ValveResourceFormat>
//!
//! Only version 5 is accepted. Every length, offset and lane is bounds-checked; decompressed data
//! is capped at 64 MiB and value nesting at 64 levels, so hostile input returns a typed error
//! rather than panicking or allocating without bound.

use std::io::Read;

use crate::{Error, Result};

const MAX_DECOMPRESSED: usize = 64 * 1024 * 1024;
const MAX_DEPTH: usize = 64;
const MAX_ELEMENTS: usize = 4 * 1024 * 1024;
const KV3_MAGIC: u32 = 0x4B56_3300;
const KV3_TRAILER: u32 = 0xFFEE_DD00;
const LZ4_FRAME_SIZE: u16 = 16384;

/// A decoded KV3 value. Object keys keep their on-disk order.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Double(f64),
    String(String),
    BinaryBlob(Vec<u8>),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(entries) => entries
                .iter()
                .find(|(entry_key, _)| entry_key == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Int(value) => Some(*value),
            Value::UInt(value) => i64::try_from(*value).ok(),
            _ => None,
        }
    }

    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Value::UInt(value) => Some(*value),
            Value::Int(value) => u64::try_from(*value).ok(),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Double(value) => Some(*value),
            Value::Int(value) => Some(*value as f64),
            Value::UInt(value) => Some(*value as f64),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(values) => Some(values),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, Value)]> {
        match self {
            Value::Object(entries) => Some(entries),
            _ => None,
        }
    }
}

/// Decode a binary KV3 v5 payload (the bytes starting with the `\x05 3VK` magic).
pub fn decode(data: &[u8]) -> Result<Value> {
    let mut reader = Reader::new(data);
    let magic = reader.u32()?;
    if magic & 0xFFFF_FF00 != KV3_MAGIC {
        return Err(Error::Kv3BadMagic);
    }

    let version = (magic & 0xFF) as u8;
    if version != 5 {
        return Err(Error::UnsupportedKv3Version(version));
    }

    decode_v5(&mut reader)
}

fn decode_v5(reader: &mut Reader<'_>) -> Result<Value> {
    let _format = reader.bytes(16)?;
    let compression = reader.u32()?;
    if compression > 2 {
        return Err(Error::UnsupportedKv3Compression(compression));
    }

    let dictionary_id = reader.u16()?;
    if dictionary_id != 0 {
        return Err(Error::MalformedKv3);
    }

    let frame_size = reader.u16()?;
    if compression == 1 {
        if frame_size != LZ4_FRAME_SIZE {
            return Err(Error::MalformedKv3);
        }
    } else if frame_size != 0 {
        return Err(Error::MalformedKv3);
    }

    let count_bytes1 = count(reader.i32()?)?;
    let count_bytes4 = count(reader.i32()?)?;
    let count_bytes8 = count(reader.i32()?)?;
    let count_types = count(reader.i32()?)?;
    let _count_objects = reader.u16()?;
    let _count_arrays = reader.u16()?;
    let size_uncompressed_total = size(reader.i32()?)?;
    let size_compressed_total = size(reader.i32()?)?;
    let count_blocks = count(reader.i32()?)?;
    let size_binary_blobs = size(reader.i32()?)?;

    let count_bytes2 = count(reader.i32()?)?;
    let size_block_compressed_sizes = size(reader.i32()?)?;

    let size_uncompressed_buffer1 = size(reader.i32()?)?;
    let size_compressed_buffer1 = size(reader.i32()?)?;
    let size_uncompressed_buffer2 = size(reader.i32()?)?;
    let size_compressed_buffer2 = size(reader.i32()?)?;
    let count_bytes1_buffer2 = count(reader.i32()?)?;
    let count_bytes2_buffer2 = count(reader.i32()?)?;
    let count_bytes4_buffer2 = count(reader.i32()?)?;
    let count_bytes8_buffer2 = count(reader.i32()?)?;
    let _count_nodes = reader.i32()?;
    let count_objects_buffer2 = count(reader.i32()?)?;
    let _count_arrays = reader.i32()?;
    let _count_array_elements = reader.i32()?;

    let declared_total = size_uncompressed_buffer1
        .checked_add(size_uncompressed_buffer2)
        .ok_or(Error::Kv3TooLarge)?;
    if declared_total != size_uncompressed_total || size_binary_blobs > MAX_DECOMPRESSED {
        return Err(Error::Kv3TooLarge);
    }

    let compressed1 = reader.bytes(size_compressed_buffer1)?;
    let buffer1 = decompress_buffer(
        compressed1,
        size_uncompressed_buffer1,
        compression,
    )?;
    let compressed2 = reader.bytes(size_compressed_buffer2)?;
    let buffer2 = decompress_buffer(
        compressed2,
        size_uncompressed_buffer2,
        compression,
    )?;

    // Buffer 1 is the auxiliary lane and also holds the string table.
    let mut cursor1 = Slice::new(&buffer1);
    let mut aux = Buffers::from_cursor(&mut cursor1, count_bytes1, count_bytes2, count_bytes4, count_bytes8)?;
    if cursor1.remaining() != 0 {
        return Err(Error::MalformedKv3);
    }
    if count_bytes4 == 0 {
        return Err(Error::MalformedKv3);
    }
    let string_count = count(aux.b4.i32()?)?;
    let strings = read_strings(&mut aux.b1, string_count)?;

    // Buffer 2 is the main lane: object lengths, lanes, types, then the blob table/trailer.
    let mut cursor2 = Slice::new(&buffer2);
    let object_length_bytes = count_objects_buffer2
        .checked_mul(4)
        .ok_or(Error::Kv3TooLarge)?;
    let object_lengths = Slice::new(cursor2.take(object_length_bytes)?);
    let main = Buffers::from_cursor(
        &mut cursor2,
        count_bytes1_buffer2,
        count_bytes2_buffer2,
        count_bytes4_buffer2,
        count_bytes8_buffer2,
    )?;
    let types = Slice::new(cursor2.take(count_types)?);

    let mut blobs = Vec::new();
    if count_blocks > 0 {
        let mut lengths = Vec::with_capacity(count_blocks.min(1024));
        let mut total_blob_bytes = 0usize;
        for _ in 0..count_blocks {
            let length = usize::try_from(cursor2.i32()?).map_err(|_| Error::Kv3BlobOutOfRange)?;
            total_blob_bytes = total_blob_bytes
                .checked_add(length)
                .ok_or(Error::Kv3TooLarge)?;
            if total_blob_bytes > MAX_DECOMPRESSED {
                return Err(Error::Kv3TooLarge);
            }
            lengths.push(length);
        }
        let trailer = cursor2.u32()?;
        if trailer != KV3_TRAILER {
            return Err(Error::Kv3BadTrailer(trailer));
        }
        if total_blob_bytes != size_binary_blobs {
            return Err(Error::MalformedKv3);
        }

        blobs = lengths
            .iter()
            .map(|length| vec![0u8; *length])
            .collect::<Vec<_>>();

        match compression {
            0 => {
                for blob in &mut blobs {
                    let bytes = reader.bytes(blob.len())?;
                    blob.copy_from_slice(bytes);
                }
            }
            1 => {
                let mut history = Vec::new();
                for blob in &mut blobs {
                    let mut offset = 0usize;
                    while offset < blob.len() {
                        let compressed_length = usize::from(cursor2.u16()?);
                        if compressed_length == 0 {
                            return Err(Error::Kv3Decompress);
                        }
                        let compressed = reader.bytes(compressed_length)?;
                        let dictionary_start = history.len().saturating_sub(65_535);
                        let dictionary = &history[dictionary_start..];
                        let written = lz4_flex::block::decompress_into_with_dict(
                            compressed,
                            &mut blob[offset..],
                            dictionary,
                        )
                        .map_err(|_| Error::Kv3Decompress)?;
                        if written == 0 {
                            return Err(Error::Kv3Decompress);
                        }
                        history.extend_from_slice(&blob[offset..offset + written]);
                        offset += written;
                    }
                }
                if cursor2.remaining() != 0 {
                    return Err(Error::MalformedKv3);
                }
            }
            2 => {
                if size_block_compressed_sizes != 0 {
                    return Err(Error::MalformedKv3);
                }
                let compressed_length = size_compressed_total
                    .checked_sub(size_compressed_buffer1)
                    .and_then(|value| value.checked_sub(size_compressed_buffer2))
                    .ok_or(Error::MalformedKv3)?;
                let compressed = reader.bytes(compressed_length)?;
                let decompressed = zstd_decompress_frames(compressed, total_blob_bytes)?;
                let mut position = 0usize;
                for blob in &mut blobs {
                    let length = blob.len();
                    blob.copy_from_slice(&decompressed[position..position + length]);
                    position += length;
                }
            }
            _ => return Err(Error::UnsupportedKv3Compression(compression)),
        }

        if compression != 1 && cursor2.remaining() != size_block_compressed_sizes {
            return Err(Error::MalformedKv3);
        }

        let trailer = reader.u32()?;
        if trailer != KV3_TRAILER {
            return Err(Error::Kv3BadTrailer(trailer));
        }
    } else {
        if size_binary_blobs != 0 {
            return Err(Error::MalformedKv3);
        }
        let trailer = cursor2.u32()?;
        if trailer != KV3_TRAILER {
            return Err(Error::Kv3BadTrailer(trailer));
        }
        if cursor2.remaining() != size_block_compressed_sizes {
            return Err(Error::MalformedKv3);
        }
    }

    let mut types = types;
    let (root_type, root_flag) = read_type(&mut types)?;
    let mut context = Context {
        main,
        aux,
        object_lengths,
        strings,
        blobs,
        next_blob: 0,
    };
    let root = read_value(
        &mut context,
        &mut types,
        root_type,
        root_flag,
        Lane::Main,
        0,
    )?;
    if types.remaining() != 0 {
        return Err(Error::MalformedKv3);
    }
    if context.next_blob != context.blobs.len() {
        return Err(Error::MalformedKv3);
    }

    Ok(root)
}

fn decompress_buffer(input: &[u8], expected: usize, compression: u32) -> Result<Vec<u8>> {
    match compression {
        0 => {
            if input.len() != expected {
                return Err(Error::MalformedKv3);
            }
            Ok(input.to_vec())
        }
        1 => {
            let mut output = vec![0u8; expected];
            let written = lz4_flex::block::decompress_into(input, &mut output)
                .map_err(|_| Error::Kv3Decompress)?;
            if written != expected {
                return Err(Error::Kv3Decompress);
            }
            Ok(output)
        }
        2 => zstd_decompress(input, expected),
        other => Err(Error::UnsupportedKv3Compression(other)),
    }
}

fn zstd_decompress(input: &[u8], expected: usize) -> Result<Vec<u8>> {
    let mut decoder = ruzstd::decoding::StreamingDecoder::new_with_max_window_size(
        input,
        MAX_DECOMPRESSED as u64,
    )
    .map_err(|_| Error::Kv3Decompress)?;
    let mut output = vec![0u8; expected];
    decoder
        .read_exact(&mut output)
        .map_err(|_| Error::Kv3Decompress)?;
    Ok(output)
}

fn zstd_decompress_frames(input: &[u8], expected: usize) -> Result<Vec<u8>> {
    let mut cursor = std::io::Cursor::new(input);
    let mut output = Vec::with_capacity(expected.min(MAX_DECOMPRESSED));
    while output.len() < expected {
        let start = cursor.position();
        if start >= input.len() as u64 {
            break;
        }

        let mut decoder = ruzstd::decoding::StreamingDecoder::new_with_max_window_size(
            &mut cursor,
            MAX_DECOMPRESSED as u64,
        )
        .map_err(|_| Error::Kv3Decompress)?;
        let mut buffer = [0u8; 16 * 1024];
        loop {
            let read = decoder
                .read(&mut buffer)
                .map_err(|_| Error::Kv3Decompress)?;
            if read == 0 {
                break;
            }
            if output
                .len()
                .checked_add(read)
                .ok_or(Error::Kv3TooLarge)?
                > expected
            {
                return Err(Error::Kv3TooLarge);
            }
            output.extend_from_slice(&buffer[..read]);
        }
        drop(decoder);

        if cursor.position() == start {
            return Err(Error::Kv3Decompress);
        }
    }

    if output.len() != expected {
        return Err(Error::Kv3Decompress);
    }
    Ok(output)
}

#[derive(Clone, Copy)]
enum Lane {
    Main,
    Aux,
}

struct Context<'a> {
    main: Buffers<'a>,
    aux: Buffers<'a>,
    object_lengths: Slice<'a>,
    strings: Vec<String>,
    blobs: Vec<Vec<u8>>,
    next_blob: usize,
}

struct Buffers<'a> {
    b1: Slice<'a>,
    b2: Slice<'a>,
    b4: Slice<'a>,
    b8: Slice<'a>,
}

impl<'a> Buffers<'a> {
    fn from_cursor(
        cursor: &mut Slice<'a>,
        bytes1: usize,
        bytes2: usize,
        bytes4: usize,
        bytes8: usize,
    ) -> Result<Self> {
        let b1 = Slice::new(cursor.take(bytes1)?);

        let b2 = if bytes2 > 0 {
            cursor.align(2)?;
            Slice::new(cursor.take(bytes2.checked_mul(2).ok_or(Error::Kv3TooLarge)?)?)
        } else {
            Slice::new(&[])
        };

        let b4 = if bytes4 > 0 {
            cursor.align(4)?;
            Slice::new(cursor.take(bytes4.checked_mul(4).ok_or(Error::Kv3TooLarge)?)?)
        } else {
            Slice::new(&[])
        };

        let b8 = if bytes8 > 0 {
            cursor.align(8)?;
            Slice::new(cursor.take(bytes8.checked_mul(8).ok_or(Error::Kv3TooLarge)?)?)
        } else {
            Slice::new(&[])
        };

        Ok(Self { b1, b2, b4, b8 })
    }
}

fn read_value(
    context: &mut Context<'_>,
    types: &mut Slice<'_>,
    datatype: u8,
    _flag: u8,
    lane: Lane,
    depth: usize,
) -> Result<Value> {
    if depth > MAX_DEPTH {
        return Err(Error::Kv3NestingTooDeep);
    }

    match datatype {
        1 => Ok(Value::Null),
        2 => Ok(Value::Bool(read_u8(context, lane)? != 0)),
        3 => Ok(Value::Int(read_i64(context, lane)?)),
        4 => Ok(Value::UInt(read_u64(context, lane)?)),
        5 => Ok(Value::Double(read_f64(context, lane)?)),
        6 => {
            let id = context.main.b4.i32()?;
            Ok(Value::String(get_string(&context.strings, id)))
        }
        7 => {
            let index = context.next_blob;
            let blob = context
                .blobs
                .get(index)
                .ok_or(Error::Kv3BlobOutOfRange)?;
            context.next_blob = index + 1;
            Ok(Value::BinaryBlob(blob.clone()))
        }
        8 => {
            let length = read_count(&mut context.main.b4)?;
            let mut values = Vec::new();
            for _ in 0..length {
                let (value_type, value_flag) = read_type(types)?;
                values.push(read_value(
                    context,
                    types,
                    value_type,
                    value_flag,
                    Lane::Main,
                    depth + 1,
                )?);
            }
            Ok(Value::Array(values))
        }
        9 => {
            let length = read_count(&mut context.object_lengths)?;
            let mut entries = Vec::new();
            for _ in 0..length {
                let (value_type, value_flag) = read_type(types)?;
                let key_id = context.main.b4.i32()?;
                let key = get_string(&context.strings, key_id);
                let value = read_value(
                    context,
                    types,
                    value_type,
                    value_flag,
                    Lane::Main,
                    depth + 1,
                )?;
                insert_member(&mut entries, key, value);
            }
            Ok(Value::Object(entries))
        }
        10 | 24 | 25 => {
            let length = if datatype == 24 || datatype == 25 {
                usize::from(context.main.b1.u8()?)
            } else {
                read_count(&mut context.main.b4)?
            };
            if length == 0 {
                return Err(Error::MalformedKv3);
            }

            let (value_type, value_flag) = read_type(types)?;
            let element_lane = if datatype == 25 { Lane::Aux } else { Lane::Main };
            let mut values = Vec::new();
            for _ in 0..length {
                values.push(read_value(
                    context,
                    types,
                    value_type,
                    value_flag,
                    element_lane,
                    depth + 1,
                )?);
            }
            Ok(Value::Array(values))
        }
        11 => Ok(Value::Int(i64::from(read_i32(context, lane)?))),
        12 => Ok(Value::UInt(u64::from(read_u32(context, lane)?))),
        13 => Ok(Value::Bool(true)),
        14 => Ok(Value::Bool(false)),
        15 => Ok(Value::Int(0)),
        16 => Ok(Value::Int(1)),
        17 => Ok(Value::Double(0.0)),
        18 => Ok(Value::Double(1.0)),
        19 => Ok(Value::Double(f64::from(read_f32(context, lane)?))),
        20 => Ok(Value::Int(i64::from(read_i16(context, lane)?))),
        21 => Ok(Value::UInt(u64::from(read_u16(context, lane)?))),
        22 => Ok(Value::Int(i64::from(read_i8(context, lane)?))),
        23 => Ok(Value::UInt(u64::from(read_u8(context, lane)?))),
        26 => Ok(Value::UInt(0)),
        27 => Ok(Value::UInt(1)),
        other => Err(Error::InvalidKv3Type(other)),
    }
}

// The type stream is threaded through `read_value` explicitly because it is not part of the
// value lanes (it lives after them in buffer 2).

fn read_type(types: &mut Slice<'_>) -> Result<(u8, u8)> {
    let mut databyte = types.u8()?;
    let mut flag = 0u8;

    if databyte & 0x80 != 0 {
        flag = types.u8()?;
        if flag == 0 || flag > 7 {
            return Err(Error::MalformedKv3);
        }
    }

    if databyte & 0x40 != 0 {
        types.u8()?;
    }

    databyte &= 0x3F;
    Ok((databyte, flag))
}

fn read_strings(lane: &mut Slice<'_>, count: usize) -> Result<Vec<String>> {
    if count > lane.remaining() {
        return Err(Error::Kv3StringTable);
    }

    let mut strings = Vec::with_capacity(count.min(1024));
    for _ in 0..count {
        let rest = lane.remaining_slice();
        let end = rest
            .iter()
            .position(|byte| *byte == 0)
            .ok_or(Error::Kv3StringTable)?;
        let text = std::str::from_utf8(&rest[..end]).map_err(|_| Error::Kv3StringTable)?;
        strings.push(text.to_owned());
        lane.skip(end + 1)?;
    }
    Ok(strings)
}

fn get_string(strings: &[String], id: i32) -> String {
    usize::try_from(id)
        .ok()
        .and_then(|index| strings.get(index))
        .cloned()
        .unwrap_or_default()
}

fn insert_member(entries: &mut Vec<(String, Value)>, key: String, value: Value) {
    if let Some(existing) = entries.iter_mut().find(|(entry_key, _)| *entry_key == key) {
        existing.1 = value;
    } else {
        entries.push((key, value));
    }
}

fn read_count(slice: &mut Slice<'_>) -> Result<usize> {
    let value = usize::try_from(slice.i32()?).map_err(|_| Error::MalformedKv3)?;
    if value > MAX_ELEMENTS {
        return Err(Error::Kv3TooLarge);
    }
    Ok(value)
}

fn count(value: i32) -> Result<usize> {
    let value = usize::try_from(value).map_err(|_| Error::MalformedKv3)?;
    if value > MAX_ELEMENTS {
        return Err(Error::Kv3TooLarge);
    }
    Ok(value)
}

fn size(value: i32) -> Result<usize> {
    let value = usize::try_from(value).map_err(|_| Error::MalformedKv3)?;
    if value > MAX_DECOMPRESSED {
        return Err(Error::Kv3TooLarge);
    }
    Ok(value)
}

fn read_u8(context: &mut Context<'_>, lane: Lane) -> Result<u8> {
    match lane {
        Lane::Main => context.main.b1.u8(),
        Lane::Aux => context.aux.b1.u8(),
    }
}

fn read_i8(context: &mut Context<'_>, lane: Lane) -> Result<i8> {
    match lane {
        Lane::Main => context.main.b1.i8(),
        Lane::Aux => context.aux.b1.i8(),
    }
}

fn read_u16(context: &mut Context<'_>, lane: Lane) -> Result<u16> {
    match lane {
        Lane::Main => context.main.b2.u16(),
        Lane::Aux => context.aux.b2.u16(),
    }
}

fn read_i16(context: &mut Context<'_>, lane: Lane) -> Result<i16> {
    match lane {
        Lane::Main => context.main.b2.i16(),
        Lane::Aux => context.aux.b2.i16(),
    }
}

fn read_u32(context: &mut Context<'_>, lane: Lane) -> Result<u32> {
    match lane {
        Lane::Main => context.main.b4.u32(),
        Lane::Aux => context.aux.b4.u32(),
    }
}

fn read_i32(context: &mut Context<'_>, lane: Lane) -> Result<i32> {
    match lane {
        Lane::Main => context.main.b4.i32(),
        Lane::Aux => context.aux.b4.i32(),
    }
}

fn read_u64(context: &mut Context<'_>, lane: Lane) -> Result<u64> {
    match lane {
        Lane::Main => context.main.b8.u64(),
        Lane::Aux => context.aux.b8.u64(),
    }
}

fn read_i64(context: &mut Context<'_>, lane: Lane) -> Result<i64> {
    match lane {
        Lane::Main => context.main.b8.i64(),
        Lane::Aux => context.aux.b8.i64(),
    }
}

fn read_f32(context: &mut Context<'_>, lane: Lane) -> Result<f32> {
    match lane {
        Lane::Main => context.main.b4.f32(),
        Lane::Aux => context.aux.b4.f32(),
    }
}

fn read_f64(context: &mut Context<'_>, lane: Lane) -> Result<f64> {
    match lane {
        Lane::Main => context.main.b8.f64(),
        Lane::Aux => context.aux.b8.f64(),
    }
}

struct Slice<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> Slice<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.position)
    }

    fn remaining_slice(&self) -> &'a [u8] {
        &self.data[self.position..]
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8]> {
        let end = self
            .position
            .checked_add(length)
            .ok_or(Error::TruncatedKv3)?;
        let bytes = self
            .data
            .get(self.position..end)
            .ok_or(Error::TruncatedKv3)?;
        self.position = end;
        Ok(bytes)
    }

    fn skip(&mut self, length: usize) -> Result<()> {
        self.take(length).map(|_| ())
    }

    fn align(&mut self, alignment: usize) -> Result<()> {
        let mask = alignment - 1;
        let aligned = self
            .position
            .checked_add(mask)
            .ok_or(Error::TruncatedKv3)?
            & !mask;
        if aligned > self.data.len() {
            return Err(Error::TruncatedKv3);
        }
        self.position = aligned;
        Ok(())
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn i8(&mut self) -> Result<i8> {
        Ok(self.u8()? as i8)
    }

    fn u16(&mut self) -> Result<u16> {
        let bytes = self.take(2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn i16(&mut self) -> Result<i16> {
        Ok(self.u16()? as i16)
    }

    fn u32(&mut self) -> Result<u32> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn i32(&mut self) -> Result<i32> {
        Ok(self.u32()? as i32)
    }

    fn u64(&mut self) -> Result<u64> {
        let bytes = self.take(8)?;
        Ok(u64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]))
    }

    fn i64(&mut self) -> Result<i64> {
        Ok(self.u64()? as i64)
    }

    fn f32(&mut self) -> Result<f32> {
        Ok(f32::from_bits(self.u32()?))
    }

    fn f64(&mut self) -> Result<f64> {
        Ok(f64::from_bits(self.u64()?))
    }
}

struct Reader<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    fn bytes(&mut self, length: usize) -> Result<&'a [u8]> {
        let end = self
            .position
            .checked_add(length)
            .ok_or(Error::TruncatedKv3)?;
        let bytes = self
            .data
            .get(self.position..end)
            .ok_or(Error::TruncatedKv3)?;
        self.position = end;
        Ok(bytes)
    }

    fn u16(&mut self) -> Result<u16> {
        let bytes = self.bytes(2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn u32(&mut self) -> Result<u32> {
        let bytes = self.bytes(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn i32(&mut self) -> Result<i32> {
        Ok(self.u32()? as i32)
    }
}
