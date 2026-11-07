//! Synthetic fixtures shared by the integration tests. Every byte is generated here; no Valve
//! data is used.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub struct FixtureEntry {
    pub path: String,
    pub data: Vec<u8>,
    pub crc_override: Option<u32>,
}

impl FixtureEntry {
    pub fn new(path: &str, data: Vec<u8>) -> Self {
        Self {
            path: path.to_owned(),
            data,
            crc_override: None,
        }
    }
}

pub struct Fixture {
    _dir: tempfile::TempDir,
    pub game: PathBuf,
}

pub fn build_fixture(entries: &[FixtureEntry], map_entries: &[FixtureEntry]) -> Fixture {
    let dir = tempfile::tempdir().expect("create temp dir");
    let game = dir.path().join("citadel");
    std::fs::create_dir_all(game.join("maps")).expect("create maps dir");
    std::fs::write(
        game.join("steam.inf"),
        b"ClientVersion=1234\nServerVersion=1234\nSourceRevision=5678\nVersionDate=Jan 02 2030\nVersionTime=03:04:05\n",
    )
    .expect("write steam.inf");

    let mut chunk = Vec::new();
    let mut tree = Vec::new();
    for entry in entries {
        append_tree_entry(&mut tree, entry, &mut chunk, 0);
    }
    tree.push(0);

    std::fs::write(game.join("pak01_000.vpk"), &chunk).expect("write chunk");
    std::fs::write(game.join("pak01_dir.vpk"), vpk_dir(&tree, chunk.len() as u32))
        .expect("write dir vpk");

    let mut map_chunk = Vec::new();
    let mut map_tree = Vec::new();
    for entry in map_entries {
        append_tree_entry(&mut map_tree, entry, &mut map_chunk, 0x7FFF);
    }
    map_tree.push(0);
    let mut map_vpk = vpk_dir(&map_tree, map_chunk.len() as u32);
    map_vpk.extend_from_slice(&map_chunk);
    std::fs::write(game.join("maps/dl_midtown.vpk"), &map_vpk).expect("write map vpk");

    Fixture { _dir: dir, game }
}

fn append_tree_entry(
    tree: &mut Vec<u8>,
    entry: &FixtureEntry,
    chunk: &mut Vec<u8>,
    archive: u16,
) {
    let (extension, folder, name) = split_vpk_path(&entry.path);
    let offset = chunk.len() as u32;
    let crc = entry
        .crc_override
        .unwrap_or_else(|| crc32fast::hash(&entry.data));

    tree.extend_from_slice(extension.as_bytes());
    tree.push(0);
    tree.extend_from_slice(folder.as_bytes());
    tree.push(0);
    tree.extend_from_slice(name.as_bytes());
    tree.push(0);
    tree.extend_from_slice(&crc.to_le_bytes());
    tree.extend_from_slice(&0u16.to_le_bytes());
    tree.extend_from_slice(&archive.to_le_bytes());
    tree.extend_from_slice(&offset.to_le_bytes());
    tree.extend_from_slice(&(entry.data.len() as u32).to_le_bytes());
    tree.extend_from_slice(&0xFFFFu16.to_le_bytes());
    tree.push(0);
    tree.push(0);

    chunk.extend_from_slice(&entry.data);
}

pub fn vpk_dir(tree: &[u8], file_data_size: u32) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&0x55AA_1234u32.to_le_bytes());
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(tree.len() as u32).to_le_bytes());
    out.extend_from_slice(&file_data_size.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(tree);
    out
}

fn split_vpk_path(path: &str) -> (String, String, String) {
    let (folder, file) = match path.rsplit_once('/') {
        Some((folder, file)) => (folder.to_owned(), file.to_owned()),
        None => (" ".to_owned(), path.to_owned()),
    };
    let (name, extension) = match file.rsplit_once('.') {
        Some((name, extension)) => (name.to_owned(), extension.to_owned()),
        None => (file, String::new()),
    };
    (extension, folder, name)
}

pub fn build_vtex(width: u16, height: u16, format: u8, pixels: &[u8]) -> Vec<u8> {
    build_vtex_with_extra(width, height, format, 1, pixels, None)
}

pub fn build_vtex_with_extra(
    width: u16,
    height: u16,
    format: u8,
    mip_count: u8,
    pixels: &[u8],
    extra: Option<(u32, &[u8])>,
) -> Vec<u8> {
    let data_offset = 40usize;
    let extra_count = u32::from(extra.is_some());

    let mut data = Vec::new();
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&[0u8; 16]);
    data.extend_from_slice(&width.to_le_bytes());
    data.extend_from_slice(&height.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes());
    data.push(format);
    data.push(mip_count);
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&8u32.to_le_bytes());
    data.extend_from_slice(&extra_count.to_le_bytes());
    if let Some((kind, payload)) = extra {
        data.extend_from_slice(&kind.to_le_bytes());
        data.extend_from_slice(&8u32.to_le_bytes());
        data.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        data.extend_from_slice(payload);
    }
    assert!(data.len() >= 40);

    let data_size = data.len();
    let file_size = data_offset + data_size;

    let mut out = Vec::new();
    out.extend_from_slice(&(file_size as u32).to_le_bytes());
    out.extend_from_slice(&12u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&8u32.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(b"DATA");
    out.extend_from_slice(&((data_offset as u32) - 20).to_le_bytes());
    out.extend_from_slice(&(data_size as u32).to_le_bytes());
    out.resize(data_offset, 0);
    out.extend_from_slice(&data);
    assert_eq!(out.len(), file_size);
    out.extend_from_slice(pixels);
    out
}

pub fn kv3_resource(kv3: &[u8]) -> Vec<u8> {
    resource_with_block(b"DATA", kv3)
}

pub fn resource_with_block(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let data_offset = 28usize;
    let file_size = data_offset + payload.len();
    let mut out = Vec::new();
    out.extend_from_slice(&(file_size as u32).to_le_bytes());
    out.extend_from_slice(&12u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&8u32.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(&((data_offset as u32) - 20).to_le_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.resize(data_offset, 0);
    out.extend_from_slice(payload);
    out
}

pub fn panorama_resource(text: &[u8], version: u16) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0u32.to_le_bytes());
    payload.extend_from_slice(&0u16.to_le_bytes());
    payload.extend_from_slice(text);

    let data_offset = 28usize;
    let file_size = data_offset + payload.len();
    let mut out = Vec::new();
    out.extend_from_slice(&(file_size as u32).to_le_bytes());
    out.extend_from_slice(&12u16.to_le_bytes());
    out.extend_from_slice(&version.to_le_bytes());
    out.extend_from_slice(&8u32.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(b"DATA");
    out.extend_from_slice(&((data_offset as u32) - 20).to_le_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.resize(data_offset, 0);
    out.extend_from_slice(&payload);
    out
}

pub fn known_pixels() -> (Vec<u8>, Vec<u8>) {
    let mut bgra = Vec::new();
    let mut rgba = Vec::new();
    for index in 0..8u8 {
        let blue = index;
        let green = 10 + index;
        let red = 20 + index;
        let alpha = 200 + index;
        bgra.extend_from_slice(&[blue, green, red, alpha]);
        rgba.extend_from_slice(&[red, green, blue, alpha]);
    }
    (bgra, rgba)
}

pub fn read_png(path: &Path) -> (u32, u32, Vec<u8>) {
    let file = std::fs::File::open(path).expect("open png");
    let decoder = png::Decoder::new(std::io::BufReader::new(file));
    let mut reader = decoder.read_info().expect("read png info");
    let mut buffer = vec![0u8; reader.output_buffer_size().expect("png buffer size")];
    let info = reader.next_frame(&mut buffer).expect("read png frame");
    buffer.truncate(info.buffer_size());
    (info.width, info.height, buffer)
}

/// Minimal KV3 value tree used by the test-only encoder.
#[derive(Clone, Debug, PartialEq)]
pub enum T {
    Null,
    Bool(bool),
    Int(i64),
    Double(f64),
    Str(String),
    Array(Vec<T>),
    Object(Vec<(&'static str, T)>),
}

pub fn encode_kv3(value: &T, compression: u32) -> Vec<u8> {
    let mut encoder = Encoder {
        types: Vec::new(),
        b1: Vec::new(),
        b2: Vec::new(),
        b4: Vec::new(),
        b8: Vec::new(),
        object_lengths: Vec::new(),
        strings: Vec::new(),
        string_ids: BTreeMap::new(),
    };

    encoder.write_type(value);
    encoder.write_data(value);

    let mut buffer1 = encoder.b1.clone();
    while !buffer1.len().is_multiple_of(4) {
        buffer1.push(0);
    }
    buffer1.extend_from_slice(&(encoder.strings.len() as i32).to_le_bytes());

    let mut buffer2 = Vec::new();
    for length in &encoder.object_lengths {
        buffer2.extend_from_slice(&length.to_le_bytes());
    }
    while !buffer2.len().is_multiple_of(4) {
        buffer2.push(0);
    }
    buffer2.extend_from_slice(&encoder.b4);
    if !encoder.b8.is_empty() {
        while !buffer2.len().is_multiple_of(8) {
            buffer2.push(0);
        }
        buffer2.extend_from_slice(&encoder.b8);
    }
    buffer2.extend_from_slice(&encoder.types);
    buffer2.extend_from_slice(&0xFFEE_DD00u32.to_le_bytes());

    let (compressed1, compressed2, frame_size) = match compression {
        0 => (buffer1.clone(), buffer2.clone(), 0u16),
        1 => (
            lz4_flex::block::compress(&buffer1),
            lz4_flex::block::compress(&buffer2),
            16384u16,
        ),
        2 => (
            ruzstd::encoding::compress_to_vec(
                buffer1.as_slice(),
                ruzstd::encoding::CompressionLevel::Fastest,
            ),
            ruzstd::encoding::compress_to_vec(
                buffer2.as_slice(),
                ruzstd::encoding::CompressionLevel::Fastest,
            ),
            0u16,
        ),
        other => panic!("unsupported test compression {other}"),
    };

    let mut out = Vec::new();
    out.extend_from_slice(&0x4B56_3305u32.to_le_bytes());
    out.extend_from_slice(&[0u8; 16]);
    out.extend_from_slice(&compression.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&frame_size.to_le_bytes());
    out.extend_from_slice(&(encoder.b1.len() as i32).to_le_bytes());
    out.extend_from_slice(&1i32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&(encoder.types.len() as i32).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&((buffer1.len() + buffer2.len()) as i32).to_le_bytes());
    out.extend_from_slice(&((compressed1.len() + compressed2.len()) as i32).to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&(buffer1.len() as i32).to_le_bytes());
    out.extend_from_slice(&(compressed1.len() as i32).to_le_bytes());
    out.extend_from_slice(&(buffer2.len() as i32).to_le_bytes());
    out.extend_from_slice(&(compressed2.len() as i32).to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&((encoder.b4.len() / 4) as i32).to_le_bytes());
    out.extend_from_slice(&((encoder.b8.len() / 8) as i32).to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&(encoder.object_lengths.len() as i32).to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&compressed1);
    out.extend_from_slice(&compressed2);
    out
}

struct Encoder {
    types: Vec<u8>,
    b1: Vec<u8>,
    b2: Vec<u8>,
    b4: Vec<u8>,
    b8: Vec<u8>,
    object_lengths: Vec<i32>,
    strings: Vec<String>,
    string_ids: BTreeMap<String, i32>,
}

impl Encoder {
    fn write_type(&mut self, value: &T) {
        let kind = match value {
            T::Null => 1,
            T::Bool(true) => 13,
            T::Bool(false) => 14,
            T::Int(value) if i32::try_from(*value).is_ok() => 11,
            T::Int(_) => 3,
            T::Double(_) => 5,
            T::Str(_) => 6,
            T::Array(_) => 8,
            T::Object(_) => 9,
        };
        self.types.push(kind);
    }

    fn write_data(&mut self, value: &T) {
        match value {
            T::Null | T::Bool(_) => {}
            T::Int(value) => {
                if let Ok(value) = i32::try_from(*value) {
                    self.b4.extend_from_slice(&value.to_le_bytes());
                } else {
                    self.b8.extend_from_slice(&value.to_le_bytes());
                }
            }
            T::Double(value) => self.b8.extend_from_slice(&value.to_le_bytes()),
            T::Str(value) => {
                let id = self.intern(value);
                self.b4.extend_from_slice(&id.to_le_bytes());
            }
            T::Array(values) => {
                self.b4
                    .extend_from_slice(&(values.len() as i32).to_le_bytes());
                for value in values {
                    self.write_type(value);
                    self.write_data(value);
                }
            }
            T::Object(entries) => {
                self.object_lengths.push(entries.len() as i32);
                for (key, value) in entries {
                    self.write_type(value);
                    let id = self.intern(key);
                    self.b4.extend_from_slice(&id.to_le_bytes());
                    self.write_data(value);
                }
            }
        }
    }

    fn intern(&mut self, value: &str) -> i32 {
        if let Some(id) = self.string_ids.get(value) {
            return *id;
        }
        let id = self.strings.len() as i32;
        self.strings.push(value.to_owned());
        self.string_ids.insert(value.to_owned(), id);
        self.b1.extend_from_slice(value.as_bytes());
        self.b1.push(0);
        id
    }
}

pub fn path_entry(path: &str, data: Vec<u8>) -> FixtureEntry {
    FixtureEntry::new(path, data)
}
