//! Source 2 resource containers and the BGRA8888 texture path.
//!
//! The container layout is ported from ValveResourceFormat (MIT), specifically
//! `ValveResourceFormat/Resource/Resource.cs` and
//! `ValveResourceFormat/Resource/ResourceTypes/Texture.cs`:
//! <https://github.com/ValveResourceFormat/ValveResourceFormat>
//!
//! A `.vtex_c` is a resource container with a block table and a `DATA` block holding a texture
//! header. The mip pixel data itself follows the container (VRF calls this `FullFileSize`); the
//! container's own `FileSize` field stops at the end of the `DATA` block. Mips are stored
//! smallest first, so mip 0 is the last chunk.
//!
//! Only format 28 (BGRA8888, uncompressed) is supported, which is what the Deadlock minimap
//! layers and hero portraits use.

use crate::{Error, Result};

const RESOURCE_HEADER_VERSION: u16 = 12;
const TEXTURE_VERSION: u16 = 1;
const FORMAT_BGRA8888: u8 = 28;
const EXTRA_COMPRESSED_MIP_SIZE: u32 = 4;
const BYTES_PER_PIXEL: u64 = 4;
const TEXTURE_HEADER_LEN: usize = 40;

/// A decoded, tightly packed RGBA8 image.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Texture {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Decode mip 0 of a BGRA8888 `.vtex_c` resource into RGBA8.
pub fn decode_vtex(data: &[u8]) -> Result<Texture> {
    let mut reader = Reader::new(data);
    let _file_size = reader.u32()?;
    let header_version = reader.u16()?;
    if header_version != RESOURCE_HEADER_VERSION {
        return Err(Error::UnsupportedResourceVersion(header_version));
    }
    let _resource_version = reader.u16()?;
    let block_offset = reader.u32()?;
    let block_count = reader.u32()?;

    let data_len = u64::try_from(data.len()).map_err(|_| Error::DimensionsOverflow)?;
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

    let mut data_block = None;
    for index in 0..block_count {
        let position = usize::try_from(table + u64::from(index) * 12)
            .map_err(|_| Error::BlockTableOutOfBounds)?;
        let block_type = &data[position..position + 4];
        let stored_offset = u32::from_le_bytes(
            data[position + 4..position + 8]
                .try_into()
                .map_err(|_| Error::BlockTableOutOfBounds)?,
        );
        let size = u32::from_le_bytes(
            data[position + 8..position + 12]
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
                String::from_utf8_lossy(block_type).into_owned(),
            ));
        }

        if block_type == b"DATA" {
            data_block = Some((
                usize::try_from(offset).map_err(|_| Error::BlockTableOutOfBounds)?,
                usize::try_from(size).map_err(|_| Error::BlockTableOutOfBounds)?,
            ));
        }
    }

    let (data_offset, data_size) = data_block.ok_or(Error::MissingDataBlock)?;
    parse_texture(data, data_offset, data_size)
}

fn parse_texture(data: &[u8], data_offset: usize, data_size: usize) -> Result<Texture> {
    if data_size < TEXTURE_HEADER_LEN {
        return Err(Error::TextureHeaderTooSmall);
    }
    let block = &data[data_offset..data_offset + data_size];

    let version = u16_at(block, 0)?;
    if version != TEXTURE_VERSION {
        return Err(Error::UnsupportedTextureVersion(version));
    }

    let width = u32::from(u16_at(block, 20)?);
    let height = u32::from(u16_at(block, 22)?);
    let depth = u16_at(block, 24)?;
    let format = block[26];
    let mip_count = block[27];
    let extra_data_offset = u32_at(block, 32)?;
    let extra_data_count = u32_at(block, 36)?;

    if width == 0 || height == 0 {
        return Err(Error::ZeroDimensions);
    }
    if depth != 1 {
        return Err(Error::UnsupportedDepth(depth));
    }
    if format != FORMAT_BGRA8888 {
        return Err(Error::UnsupportedFormat(format));
    }
    if mip_count == 0 {
        return Err(Error::NoMipLevels);
    }
    if mip_count > 32 {
        return Err(Error::InvalidMipCount(mip_count));
    }

    check_extra_data(block, extra_data_offset, extra_data_count)?;

    // Mips are stored smallest first. Accumulate their sizes so mip 0 can be located at the end.
    let mut expected = 0u64;
    let mut mip0_offset = 0u64;
    for level in (0..mip_count).rev() {
        let mip_width = u64::from(mip_dimension(width, level));
        let mip_height = u64::from(mip_dimension(height, level));
        let mip_size = mip_width
            .checked_mul(mip_height)
            .and_then(|pixels| pixels.checked_mul(BYTES_PER_PIXEL))
            .ok_or(Error::DimensionsOverflow)?;
        if level == 0 {
            mip0_offset = expected;
        }
        expected = expected
            .checked_add(mip_size)
            .ok_or(Error::DimensionsOverflow)?;
    }

    let texture_start = data_offset
        .checked_add(data_size)
        .ok_or(Error::DimensionsOverflow)?;
    let available = data
        .len()
        .checked_sub(texture_start)
        .ok_or(Error::TextureSizeMismatch {
            expected,
            actual: 0,
        })?;
    let available = u64::try_from(available).map_err(|_| Error::DimensionsOverflow)?;
    if available != expected {
        return Err(Error::TextureSizeMismatch {
            expected,
            actual: available,
        });
    }

    let pixel_start = texture_start
        .checked_add(usize::try_from(mip0_offset).map_err(|_| Error::DimensionsOverflow)?)
        .ok_or(Error::DimensionsOverflow)?;
    let pixel_len = usize::try_from(
        u64::from(width)
            .checked_mul(u64::from(height))
            .and_then(|pixels| pixels.checked_mul(BYTES_PER_PIXEL))
            .ok_or(Error::DimensionsOverflow)?,
    )
    .map_err(|_| Error::DimensionsOverflow)?;
    let bgra =
        data.get(pixel_start..pixel_start + pixel_len)
            .ok_or(Error::TextureSizeMismatch {
                expected,
                actual: available,
            })?;

    let mut rgba = Vec::with_capacity(pixel_len);
    let (pixels, _) = bgra.as_chunks::<4>();
    for pixel in pixels {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }

    Ok(Texture {
        width,
        height,
        rgba,
    })
}

fn check_extra_data(block: &[u8], extra_data_offset: u32, extra_data_count: u32) -> Result<()> {
    if extra_data_count == 0 {
        return Ok(());
    }
    if extra_data_offset < 8 {
        return Err(Error::ExtraDataOutOfBounds);
    }

    let table = 32u64
        .checked_add(u64::from(extra_data_offset))
        .ok_or(Error::ExtraDataOutOfBounds)?;
    let table_len = u64::from(extra_data_count)
        .checked_mul(12)
        .ok_or(Error::ExtraDataOutOfBounds)?;
    let table_end = table
        .checked_add(table_len)
        .ok_or(Error::ExtraDataOutOfBounds)?;
    let block_len = u64::try_from(block.len()).map_err(|_| Error::ExtraDataOutOfBounds)?;
    if table_end > block_len {
        return Err(Error::ExtraDataOutOfBounds);
    }

    for index in 0..extra_data_count {
        let position = usize::try_from(table + u64::from(index) * 12)
            .map_err(|_| Error::ExtraDataOutOfBounds)?;
        let kind = u32::from_le_bytes(
            block[position..position + 4]
                .try_into()
                .map_err(|_| Error::ExtraDataOutOfBounds)?,
        );
        let stored_offset = u32::from_le_bytes(
            block[position + 4..position + 8]
                .try_into()
                .map_err(|_| Error::ExtraDataOutOfBounds)?,
        );
        let size = u32::from_le_bytes(
            block[position + 8..position + 12]
                .try_into()
                .map_err(|_| Error::ExtraDataOutOfBounds)?,
        );

        let start = u64::try_from(position)
            .map_err(|_| Error::ExtraDataOutOfBounds)?
            .checked_add(4)
            .and_then(|value| value.checked_add(u64::from(stored_offset)))
            .ok_or(Error::ExtraDataOutOfBounds)?;
        let end = start
            .checked_add(u64::from(size))
            .ok_or(Error::ExtraDataOutOfBounds)?;
        if end > block_len {
            return Err(Error::ExtraDataOutOfBounds);
        }

        if kind == EXTRA_COMPRESSED_MIP_SIZE {
            return Err(Error::CompressedMips);
        }
    }

    Ok(())
}

fn mip_dimension(base: u32, level: u8) -> u32 {
    base.checked_shr(u32::from(level)).unwrap_or(0).max(1)
}

fn u16_at(data: &[u8], offset: usize) -> Result<u16> {
    let bytes = data
        .get(offset..offset + 2)
        .ok_or(Error::TextureHeaderTooSmall)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn u32_at(data: &[u8], offset: usize) -> Result<u32> {
    let bytes = data
        .get(offset..offset + 4)
        .ok_or(Error::TextureHeaderTooSmall)?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
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
