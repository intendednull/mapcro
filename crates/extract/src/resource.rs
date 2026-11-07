//! Source 2 resource containers.
//!
//! Ported from ValveResourceFormat (MIT), `Resource/Resource.cs`:
//! <https://github.com/ValveResourceFormat/ValveResourceFormat>
//!
//! A resource file starts with a 16-byte header (file size, header version, resource version,
//! block-table offset, block count) followed by a table of 12-byte block entries. Each entry's
//! offset is relative to the entry itself, not to the start of the file.

use crate::{Error, Result};

/// Resource header version understood by this reader.
pub const RESOURCE_HEADER_VERSION: u16 = 12;

/// One block in a resource's block table.
#[derive(Clone, Copy, Debug)]
pub struct Block<'a> {
    pub kind: [u8; 4],
    pub offset: usize,
    pub data: &'a [u8],
}

/// A parsed resource container.
#[derive(Debug)]
pub struct Resource<'a> {
    /// Resource version from the header. Panorama resources use 2 and 3.
    pub version: u16,
    pub blocks: Vec<Block<'a>>,
}

impl<'a> Resource<'a> {
    pub fn block(&self, kind: &[u8; 4]) -> Option<&Block<'a>> {
        self.blocks.iter().find(|block| &block.kind == kind)
    }
}

/// Parse the header and block table of a resource.
pub fn parse(data: &[u8]) -> Result<Resource<'_>> {
    let mut reader = Reader::new(data);
    let _file_size = reader.u32()?;
    let header_version = reader.u16()?;
    if header_version != RESOURCE_HEADER_VERSION {
        return Err(Error::UnsupportedResourceVersion(header_version));
    }
    let version = reader.u16()?;
    let block_offset = reader.u32()?;
    let block_count = reader.u32()?;

    let data_len = u64::try_from(data.len()).map_err(|_| Error::BlockTableOutOfBounds)?;
    let table = 8u64
        .checked_add(u64::from(block_offset))
        .ok_or(Error::BlockTableOutOfBounds)?;
    let table_len = u64::from(block_count)
        .checked_mul(12)
        .ok_or(Error::BlockTableOutOfBounds)?;
    let table_end = table
        .checked_add(table_len)
        .ok_or(Error::BlockTableOutOfBounds)?;
    if table_end > data_len {
        return Err(Error::BlockTableOutOfBounds);
    }

    let mut blocks = Vec::new();
    for index in 0..block_count {
        let position = usize::try_from(table + u64::from(index) * 12)
            .map_err(|_| Error::BlockTableOutOfBounds)?;
        let kind: [u8; 4] = data
            .get(position..position + 4)
            .ok_or(Error::BlockTableOutOfBounds)?
            .try_into()
            .map_err(|_| Error::BlockTableOutOfBounds)?;
        let stored_offset = u32::from_le_bytes(
            data.get(position + 4..position + 8)
                .ok_or(Error::BlockTableOutOfBounds)?
                .try_into()
                .map_err(|_| Error::BlockTableOutOfBounds)?,
        );
        let size = u32::from_le_bytes(
            data.get(position + 8..position + 12)
                .ok_or(Error::BlockTableOutOfBounds)?
                .try_into()
                .map_err(|_| Error::BlockTableOutOfBounds)?,
        );

        let offset = u64::try_from(position)
            .map_err(|_| Error::BlockTableOutOfBounds)?
            .checked_add(4)
            .and_then(|value| value.checked_add(u64::from(stored_offset)))
            .ok_or(Error::BlockTableOutOfBounds)?;
        let end = offset
            .checked_add(u64::from(size))
            .ok_or(Error::BlockTableOutOfBounds)?;
        if end > data_len {
            return Err(Error::BlockOutOfBounds(
                String::from_utf8_lossy(&kind).into_owned(),
            ));
        }

        let offset = usize::try_from(offset).map_err(|_| Error::BlockTableOutOfBounds)?;
        let end = usize::try_from(end).map_err(|_| Error::BlockTableOutOfBounds)?;
        blocks.push(Block {
            kind,
            offset,
            data: &data[offset..end],
        });
    }

    Ok(Resource { version, blocks })
}

struct Reader<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    fn bytes(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .position
            .checked_add(len)
            .ok_or(Error::TruncatedResource)?;
        let bytes = self
            .data
            .get(self.position..end)
            .ok_or(Error::TruncatedResource)?;
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
}
