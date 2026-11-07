//! A minimal VPK v1/v2 reader.
//!
//! The tree parser follows the stdlib prototype in the research notes; the reader differs from
//! it by checking every length, validating entry paths, verifying each entry's CRC32 and reading
//! only the requested byte range from a chunk (never the whole chunk file).

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};

use crate::allow::GameDir;
use crate::{Error, Result};

const VPK_MAGIC: u32 = 0x55AA_1234;
const VPK_V2_HEADER: u64 = 28;
const VPK_V1_HEADER: u64 = 12;

/// One file inside a VPK directory tree.
#[derive(Clone, Debug)]
pub struct Entry {
    /// Full VPK path, for example `panorama/images/heroes/archer_mm_psd.vtex_c`.
    pub path: String,
    /// CRC32 of the complete payload (preload bytes followed by archive bytes).
    pub crc32: u32,
    /// Bytes stored directly in the directory tree.
    pub preload: Vec<u8>,
    /// Archive index, or `0x7fff` when the payload lives in the directory file itself.
    pub archive: u16,
    /// Byte offset inside the archive (or inside the directory file's data section).
    pub offset: u32,
    /// Number of bytes stored in the archive, excluding `preload`.
    pub length: u32,
}

impl Entry {
    /// Total size of the entry as the caller sees it.
    pub fn size(&self) -> u64 {
        self.preload.len() as u64 + u64::from(self.length)
    }

    /// File that holds the payload: the directory file for `0x7fff`, otherwise a numbered chunk.
    pub fn archive_name(&self, dir_name: &str) -> String {
        if self.archive == 0x7FFF {
            dir_name.to_owned()
        } else {
            format!("pak01_{:03}.vpk", self.archive)
        }
    }
}

/// An opened VPK directory tree.
#[derive(Debug)]
pub struct Vpk {
    game: GameDir,
    dir_name: String,
    data_base: u64,
    entries: Vec<Entry>,
    index: HashMap<String, usize>,
}

impl Vpk {
    /// Read and parse the directory tree of `dir_name` (usually `pak01_dir.vpk`).
    pub fn open(game: &GameDir, dir_name: &str) -> Result<Self> {
        if !GameDir::is_allowed(dir_name) {
            return Err(Error::PathNotAllowed(dir_name.to_owned()));
        }

        let mut file = game.open(dir_name)?;
        let file_len = file.metadata()?.len();

        let mut header = [0u8; 28];
        let mut read = 0usize;
        while read < header.len() {
            match file.read(&mut header[read..])? {
                0 => break,
                count => read += count,
            }
        }

        if read < 12 {
            return Err(Error::TruncatedVpk);
        }

        let magic = u32::from_le_bytes(header[0..4].try_into().map_err(|_| Error::TruncatedVpk)?);
        if magic != VPK_MAGIC {
            return Err(Error::NotVpk);
        }

        let version = u32::from_le_bytes(header[4..8].try_into().map_err(|_| Error::TruncatedVpk)?);
        let tree_size = u64::from(u32::from_le_bytes(
            header[8..12].try_into().map_err(|_| Error::TruncatedVpk)?,
        ));

        let (header_size, data_base) = match version {
            1 => (
                VPK_V1_HEADER,
                VPK_V1_HEADER
                    .checked_add(tree_size)
                    .ok_or(Error::TruncatedVpk)?,
            ),
            2 => {
                if read < 28 {
                    return Err(Error::TruncatedVpk);
                }
                (
                    VPK_V2_HEADER,
                    VPK_V2_HEADER
                        .checked_add(tree_size)
                        .ok_or(Error::TruncatedVpk)?,
                )
            }
            other => return Err(Error::UnsupportedVpkVersion(other)),
        };

        let tree_end = header_size
            .checked_add(tree_size)
            .ok_or(Error::TruncatedVpk)?;
        if tree_end > file_len {
            return Err(Error::TruncatedVpk);
        }

        let tree_len = usize::try_from(tree_size).map_err(|_| Error::TruncatedVpk)?;
        let mut tree = vec![0u8; tree_len];
        file.seek(SeekFrom::Start(header_size))?;
        file.read_exact(&mut tree)?;

        let entries = parse_tree(&tree)?;
        let mut index = HashMap::with_capacity(entries.len());
        for (position, entry) in entries.iter().enumerate() {
            index.entry(entry.path.clone()).or_insert(position);
        }

        Ok(Self {
            game: game.clone(),
            dir_name: dir_name.to_owned(),
            data_base,
            entries,
            index,
        })
    }

    pub fn dir_name(&self) -> &str {
        &self.dir_name
    }

    pub fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.entries.iter()
    }

    pub fn entry(&self, path: &str) -> Option<&Entry> {
        self.index
            .get(path)
            .and_then(|position| self.entries.get(*position))
    }

    /// Read one entry by path and verify its CRC32.
    pub fn read(&self, path: &str) -> Result<Vec<u8>> {
        let entry = self
            .entry(path)
            .ok_or_else(|| Error::EntryNotFound(path.to_owned()))?;
        self.read_entry(entry)
    }

    /// Read one entry and verify its CRC32.
    pub fn read_entry(&self, entry: &Entry) -> Result<Vec<u8>> {
        validate_entry_path(&entry.path)?;

        let capacity =
            usize::try_from(entry.size()).map_err(|_| Error::EntryTooLarge(entry.path.clone()))?;
        let mut payload = Vec::with_capacity(capacity);
        payload.extend_from_slice(&entry.preload);

        if entry.length > 0 {
            let archive_name = entry.archive_name(&self.dir_name);
            let mut archive = self.game.open(&archive_name)?;
            let archive_len = archive.metadata()?.len();

            let start = if entry.archive == 0x7FFF {
                self.data_base
                    .checked_add(u64::from(entry.offset))
                    .ok_or_else(|| Error::TruncatedEntry(entry.path.clone()))?
            } else {
                u64::from(entry.offset)
            };
            let end = start
                .checked_add(u64::from(entry.length))
                .ok_or_else(|| Error::TruncatedEntry(entry.path.clone()))?;
            if end > archive_len {
                return Err(Error::TruncatedEntry(entry.path.clone()));
            }

            archive.seek(SeekFrom::Start(start))?;
            let mut bytes = vec![
                0u8;
                usize::try_from(entry.length)
                    .map_err(|_| Error::EntryTooLarge(entry.path.clone()))?
            ];
            archive.read_exact(&mut bytes)?;
            payload.extend_from_slice(&bytes);
        }

        let actual = crc32fast::hash(&payload);
        if actual != entry.crc32 {
            return Err(Error::CrcMismatch {
                path: entry.path.clone(),
                expected: entry.crc32,
                actual,
            });
        }

        Ok(payload)
    }
}

fn parse_tree(tree: &[u8]) -> Result<Vec<Entry>> {
    let mut cursor = Cursor::new(tree);
    let mut entries = Vec::new();

    loop {
        let extension = cursor.cstr()?;
        if extension.is_empty() {
            break;
        }

        loop {
            let folder = cursor.cstr()?;
            if folder.is_empty() {
                break;
            }

            loop {
                let name = cursor.cstr()?;
                if name.is_empty() {
                    break;
                }

                let crc32 = cursor.u32()?;
                let preload_len = cursor.u16()?;
                let archive = cursor.u16()?;
                let offset = cursor.u32()?;
                let length = cursor.u32()?;
                let terminator = cursor.u16()?;
                if terminator != 0xFFFF {
                    return Err(Error::BadTerminator(terminator));
                }

                let preload = cursor.bytes(usize::from(preload_len))?.to_vec();
                let path = if folder == " " {
                    format!("{name}.{extension}")
                } else {
                    format!("{folder}/{name}.{extension}")
                };
                validate_entry_path(&path)?;

                entries.push(Entry {
                    path,
                    crc32,
                    preload,
                    archive,
                    offset,
                    length,
                });
            }
        }
    }

    Ok(entries)
}

/// Reject absolute paths and any `.` or `..` component. A file literally named `foo..bar` is
/// fine; only a whole component that is exactly `..` is traversal.
pub fn validate_entry_path(path: &str) -> Result<()> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') {
        return Err(Error::UnsafePath(path.to_owned()));
    }

    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(Error::UnsafePath(path.to_owned()));
        }
    }

    Ok(())
}

struct Cursor<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    fn bytes(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self.position.checked_add(len).ok_or(Error::MalformedTree)?;
        let bytes = self
            .data
            .get(self.position..end)
            .ok_or(Error::MalformedTree)?;
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

    fn cstr(&mut self) -> Result<&'a str> {
        let rest = self.data.get(self.position..).ok_or(Error::MalformedTree)?;
        let end = rest
            .iter()
            .position(|byte| *byte == 0)
            .ok_or(Error::MalformedTree)?;
        let bytes = &rest[..end];
        let text = std::str::from_utf8(bytes).map_err(|_| Error::MalformedTree)?;
        self.position += end + 1;
        Ok(text)
    }
}
