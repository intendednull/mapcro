//! Source 2 texture resources.
//!
//! The container layout is ported from ValveResourceFormat (MIT), `Resource/ResourceTypes/Texture.cs`
//! and `Resource/Resource.cs`:
//! <https://github.com/ValveResourceFormat/ValveResourceFormat>
//!
//! Mips are stored smallest first, so mip 0 is the last chunk. The `DATA` block holds the texture
//! header and optional extra-data table; the pixel payload follows the block in the same file.
//! Supported formats are BGRA8888, RGBA8888, DXT1, DXT5, BC7 and PNG. Mips compressed with LZ4 or
//! zstd are decompressed before decoding.

use crate::resource;
use crate::{Error, Result};

const TEXTURE_VERSION: u16 = 1;
const TEXTURE_HEADER_LEN: usize = 40;
const EXTRA_COMPRESSED_MIP_SIZE: u32 = 4;
const MAX_TEXTURE_BYTES: usize = 64 * 1024 * 1024;

const FORMAT_DXT1: u8 = 1;
const FORMAT_DXT5: u8 = 2;
const FORMAT_RGBA8888: u8 = 4;
const FORMAT_PNG_RGBA8888: u8 = 16;
const FORMAT_BC7: u8 = 20;
const FORMAT_BGRA8888: u8 = 28;

/// A decoded, tightly packed RGBA8 image.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Texture {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    /// Source format number from the texture header.
    pub format: u8,
}

impl Texture {
    /// Human-readable format name for `pack.json`.
    pub fn format_label(&self) -> String {
        format_label(self.format)
    }
}

/// Decode mip 0 of a `.vtex_c` resource into RGBA8.
pub fn decode_vtex(data: &[u8]) -> Result<Texture> {
    let resource = resource::parse(data)?;
    let block = resource.block(b"DATA").ok_or(Error::MissingDataBlock)?;
    let pixel_start = block
        .offset
        .checked_add(block.data.len())
        .ok_or(Error::TruncatedResource)?;
    let pixels = data
        .get(pixel_start..)
        .ok_or(Error::TruncatedResource)?;
    parse_texture(block.data, pixels)
}

/// Human-readable name of a `VTexFormat` value.
pub fn format_label(format: u8) -> String {
    match format {
        FORMAT_DXT1 => "DXT1".to_owned(),
        FORMAT_DXT5 => "DXT5".to_owned(),
        FORMAT_RGBA8888 => "RGBA8888".to_owned(),
        FORMAT_PNG_RGBA8888 => "PNG_RGBA8888".to_owned(),
        FORMAT_BC7 => "BC7".to_owned(),
        FORMAT_BGRA8888 => "BGRA8888".to_owned(),
        other => format!("format-{other}"),
    }
}

fn parse_texture(block: &[u8], pixels: &[u8]) -> Result<Texture> {
    if block.len() < TEXTURE_HEADER_LEN {
        return Err(Error::TextureHeaderTooSmall);
    }

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
    if mip_count == 0 {
        return Err(Error::NoMipLevels);
    }
    if mip_count > 32 {
        return Err(Error::InvalidMipCount(mip_count));
    }

    let extra = parse_extra_data(block, extra_data_offset, extra_data_count, mip_count)?;

    if format == FORMAT_PNG_RGBA8888 {
        return decode_png(pixels, format);
    }

    let info = format_info(format).ok_or(Error::UnsupportedFormat(format))?;
    check_decoded_size(width, height)?;

    let mut mip_sizes = Vec::with_capacity(usize::from(mip_count));
    for level in 0..mip_count {
        mip_sizes.push(mip_size(width, height, level, info)?);
    }

    let mut stored_sizes = Vec::with_capacity(usize::from(mip_count));
    for (level, &uncompressed) in mip_sizes.iter().enumerate() {
        let stored = match &extra.compressed_mips {
            Some(compressed) => uncompressed.min(compressed.sizes[level]),
            None => uncompressed,
        };
        stored_sizes.push(stored);
    }

    let total_stored = stored_sizes
        .iter()
        .try_fold(0usize, |total, size| total.checked_add(*size))
        .ok_or(Error::DimensionsOverflow)?;
    if pixels.len() < total_stored {
        return Err(Error::TextureSizeMismatch {
            expected: total_stored as u64,
            actual: pixels.len() as u64,
        });
    }

    let mip0_offset = stored_sizes
        .iter()
        .skip(1)
        .try_fold(0usize, |total, size| total.checked_add(*size))
        .ok_or(Error::DimensionsOverflow)?;
    let mip0_stored = stored_sizes[0];
    let mip0_uncompressed = mip_sizes[0];
    let mip0_end = mip0_offset
        .checked_add(mip0_stored)
        .ok_or(Error::DimensionsOverflow)?;
    let raw = pixels
        .get(mip0_offset..mip0_end)
        .ok_or(Error::TextureSizeMismatch {
            expected: total_stored as u64,
            actual: pixels.len() as u64,
        })?;

    let decoded = match &extra.compressed_mips {
        Some(compressed) if mip0_stored < mip0_uncompressed => {
            decompress_mip(raw, mip0_uncompressed, compressed.method)?
        }
        _ => raw.to_vec(),
    };

    if decoded.len() < mip0_uncompressed {
        return Err(Error::TextureSizeMismatch {
            expected: mip0_uncompressed as u64,
            actual: decoded.len() as u64,
        });
    }

    let rgba = match info.decoder {
        Decoder::Bgra => bgra_to_rgba(&decoded, width, height)?,
        Decoder::Rgba => rgba_to_rgba(&decoded, width, height)?,
        Decoder::Bc1 => decode_bc(&decoded, width, height, Decoder::Bc1)?,
        Decoder::Bc3 => decode_bc(&decoded, width, height, Decoder::Bc3)?,
        Decoder::Bc7 => decode_bc(&decoded, width, height, Decoder::Bc7)?,
        Decoder::Png => unreachable!("PNG is handled before mip parsing"),
    };

    Ok(Texture {
        width,
        height,
        rgba,
        format,
    })
}

#[derive(Clone, Copy, Debug)]
struct FormatInfo {
    bytes: usize,
    block_compressed: bool,
    decoder: Decoder,
}

#[derive(Clone, Copy, Debug)]
enum Decoder {
    Bgra,
    Rgba,
    Bc1,
    Bc3,
    Bc7,
    Png,
}

fn format_info(format: u8) -> Option<FormatInfo> {
    let (bytes, block_compressed, decoder) = match format {
        FORMAT_DXT1 => (8, true, Decoder::Bc1),
        FORMAT_DXT5 => (16, true, Decoder::Bc3),
        FORMAT_RGBA8888 => (4, false, Decoder::Rgba),
        FORMAT_PNG_RGBA8888 => (4, false, Decoder::Png),
        FORMAT_BC7 => (16, true, Decoder::Bc7),
        FORMAT_BGRA8888 => (4, false, Decoder::Bgra),
        _ => return None,
    };
    Some(FormatInfo {
        bytes,
        block_compressed,
        decoder,
    })
}

fn mip_size(width: u32, height: u32, level: u8, info: FormatInfo) -> Result<usize> {
    let width = mip_dimension(width, level);
    let height = mip_dimension(height, level);
    let pixels = if info.block_compressed {
        u64::from(width.div_ceil(4))
            .checked_mul(u64::from(height.div_ceil(4)))
            .and_then(|blocks| blocks.checked_mul(info.bytes as u64))
    } else {
        u64::from(width)
            .checked_mul(u64::from(height))
            .and_then(|pixels| pixels.checked_mul(info.bytes as u64))
    }
    .ok_or(Error::DimensionsOverflow)?;

    usize::try_from(pixels).map_err(|_| Error::DimensionsOverflow)
}

fn mip_dimension(base: u32, level: u8) -> u32 {
    base.checked_shr(u32::from(level)).unwrap_or(0).max(1)
}

fn check_decoded_size(width: u32, height: u32) -> Result<()> {
    let bytes = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or(Error::DimensionsOverflow)?;
    if bytes > MAX_TEXTURE_BYTES as u64 {
        return Err(Error::DimensionsOverflow);
    }
    Ok(())
}

fn bgra_to_rgba(data: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    let expected = pixel_bytes(width, height)?;
    if data.len() < expected {
        return Err(Error::PixelBufferSize {
            expected,
            actual: data.len(),
        });
    }

    let mut rgba = Vec::with_capacity(expected);
    let (pixels, _) = data[..expected].as_chunks::<4>();
    for pixel in pixels {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    Ok(rgba)
}

fn rgba_to_rgba(data: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    let expected = pixel_bytes(width, height)?;
    if data.len() < expected {
        return Err(Error::PixelBufferSize {
            expected,
            actual: data.len(),
        });
    }
    Ok(data[..expected].to_vec())
}

fn pixel_bytes(width: u32, height: u32) -> Result<usize> {
    usize::try_from(
        u64::from(width)
            .checked_mul(u64::from(height))
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or(Error::DimensionsOverflow)?,
    )
    .map_err(|_| Error::DimensionsOverflow)
}

fn decode_bc(data: &[u8], width: u32, height: u32, decoder: Decoder) -> Result<Vec<u8>> {
    let width = usize::try_from(width).map_err(|_| Error::DimensionsOverflow)?;
    let height = usize::try_from(height).map_err(|_| Error::DimensionsOverflow)?;
    let pixels = width.checked_mul(height).ok_or(Error::DimensionsOverflow)?;
    let mut buffer = vec![0u32; pixels];

    let result = match decoder {
        Decoder::Bc1 => texture2ddecoder::decode_bc1(data, width, height, &mut buffer),
        Decoder::Bc3 => texture2ddecoder::decode_bc3(data, width, height, &mut buffer),
        Decoder::Bc7 => texture2ddecoder::decode_bc7(data, width, height, &mut buffer),
        _ => return Err(Error::TextureDecode("non-block format")),
    };
    result.map_err(|_| Error::TextureDecode("block"))?;

    let mut rgba = Vec::with_capacity(pixels * 4);
    for pixel in buffer {
        let [blue, green, red, alpha] = pixel.to_le_bytes();
        rgba.extend_from_slice(&[red, green, blue, alpha]);
    }
    Ok(rgba)
}

fn decode_png(data: &[u8], format: u8) -> Result<Texture> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(data));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info()?;
    let buffer_size = reader
        .output_buffer_size()
        .ok_or(Error::TextureDecode("PNG"))?;
    if buffer_size > MAX_TEXTURE_BYTES {
        return Err(Error::TextureDecode("PNG too large"));
    }
    let mut buffer = vec![0u8; buffer_size];
    let info = reader.next_frame(&mut buffer)?;
    buffer.truncate(info.buffer_size());

    let width = info.width;
    let height = info.height;
    check_decoded_size(width, height)?;
    let expected = pixel_bytes(width, height)?;

    let rgba = match info.color_type {
        png::ColorType::Rgba => {
            if buffer.len() < expected {
                return Err(Error::PixelBufferSize {
                    expected,
                    actual: buffer.len(),
                });
            }
            buffer[..expected].to_vec()
        }
        png::ColorType::Rgb => {
            let source = expected / 4 * 3;
            if buffer.len() < source {
                return Err(Error::PixelBufferSize {
                    expected: source,
                    actual: buffer.len(),
                });
            }
            let mut rgba = Vec::with_capacity(expected);
            for pixel in buffer[..source].as_chunks::<3>().0 {
                rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
            }
            rgba
        }
        png::ColorType::Grayscale => {
            let source = expected / 4;
            if buffer.len() < source {
                return Err(Error::PixelBufferSize {
                    expected: source,
                    actual: buffer.len(),
                });
            }
            let mut rgba = Vec::with_capacity(expected);
            for value in &buffer[..source] {
                rgba.extend_from_slice(&[*value, *value, *value, 255]);
            }
            rgba
        }
        png::ColorType::GrayscaleAlpha => {
            let source = expected / 4 * 2;
            if buffer.len() < source {
                return Err(Error::PixelBufferSize {
                    expected: source,
                    actual: buffer.len(),
                });
            }
            let mut rgba = Vec::with_capacity(expected);
            for pixel in buffer[..source].as_chunks::<2>().0 {
                rgba.extend_from_slice(&[pixel[0], pixel[0], pixel[0], pixel[1]]);
            }
            rgba
        }
        png::ColorType::Indexed => return Err(Error::TextureDecode("indexed PNG")),
    };

    Ok(Texture {
        width,
        height,
        rgba,
        format,
    })
}

#[derive(Clone, Debug)]
struct CompressedMips {
    method: u32,
    sizes: Vec<usize>,
}

#[derive(Clone, Debug, Default)]
struct ExtraData {
    compressed_mips: Option<CompressedMips>,
}

fn parse_extra_data(
    block: &[u8],
    extra_data_offset: u32,
    extra_data_count: u32,
    mip_count: u8,
) -> Result<ExtraData> {
    if extra_data_count == 0 {
        return Ok(ExtraData::default());
    }
    if extra_data_offset < 8 {
        return Err(Error::ExtraDataOutOfBounds);
    }

    let table = 32usize
        .checked_add(
            usize::try_from(extra_data_offset).map_err(|_| Error::ExtraDataOutOfBounds)?,
        )
        .ok_or(Error::ExtraDataOutOfBounds)?;
    let table_len = usize::try_from(extra_data_count)
        .map_err(|_| Error::ExtraDataOutOfBounds)?
        .checked_mul(12)
        .ok_or(Error::ExtraDataOutOfBounds)?;
    let table_end = table
        .checked_add(table_len)
        .ok_or(Error::ExtraDataOutOfBounds)?;
    if table_end > block.len() {
        return Err(Error::ExtraDataOutOfBounds);
    }

    let mut extra = ExtraData::default();
    for index in 0..extra_data_count {
        let position = table
            .checked_add(
                usize::try_from(index)
                    .map_err(|_| Error::ExtraDataOutOfBounds)?
                    .checked_mul(12)
                    .ok_or(Error::ExtraDataOutOfBounds)?,
            )
            .ok_or(Error::ExtraDataOutOfBounds)?;
        let kind = u32_at(block, position)?;
        let stored_offset = u32_at(
            block,
            position.checked_add(4).ok_or(Error::ExtraDataOutOfBounds)?,
        )?;
        let size = u32_at(
            block,
            position.checked_add(8).ok_or(Error::ExtraDataOutOfBounds)?,
        )?;

        let start = position
            .checked_add(4)
            .and_then(|value| value.checked_add(usize::try_from(stored_offset).ok()?))
            .ok_or(Error::ExtraDataOutOfBounds)?;
        let end = start
            .checked_add(usize::try_from(size).map_err(|_| Error::ExtraDataOutOfBounds)?)
            .ok_or(Error::ExtraDataOutOfBounds)?;
        if end > block.len() {
            return Err(Error::ExtraDataOutOfBounds);
        }

        if kind == EXTRA_COMPRESSED_MIP_SIZE {
            extra.compressed_mips = Some(parse_compressed_mips(&block[start..end], mip_count)?);
        }
    }

    Ok(extra)
}

fn parse_compressed_mips(payload: &[u8], mip_count: u8) -> Result<CompressedMips> {
    if payload.len() < 12 {
        return Err(Error::CompressedMipTable);
    }
    let method = u32_at(payload, 0)?;
    let table_offset = usize::try_from(u32_at(payload, 4)?).map_err(|_| Error::CompressedMipTable)?;
    let count = u32_at(payload, 8)?;
    if count != u32::from(mip_count) {
        return Err(Error::CompressedMipCount);
    }

    let table_len = usize::try_from(count)
        .map_err(|_| Error::CompressedMipTable)?
        .checked_mul(4)
        .ok_or(Error::CompressedMipTable)?;
    let table_end = table_offset
        .checked_add(table_len)
        .ok_or(Error::CompressedMipTable)?;
    if table_end > payload.len() {
        return Err(Error::CompressedMipTable);
    }

    let mut sizes = Vec::with_capacity(usize::try_from(count).map_err(|_| Error::CompressedMipTable)?.min(32));
    for index in 0..count {
        let position = table_offset
            .checked_add(
                usize::try_from(index)
                    .map_err(|_| Error::CompressedMipTable)?
                    .checked_mul(4)
                    .ok_or(Error::CompressedMipTable)?,
            )
            .ok_or(Error::CompressedMipTable)?;
        let value = i32::from_le_bytes(
            payload
                .get(position..position.checked_add(4).ok_or(Error::CompressedMipTable)?)
                .ok_or(Error::CompressedMipTable)?
                .try_into()
                .map_err(|_| Error::CompressedMipTable)?,
        );
        sizes.push(usize::try_from(value).map_err(|_| Error::CompressedMipTable)?);
    }

    Ok(CompressedMips { method, sizes })
}

fn decompress_mip(input: &[u8], expected: usize, method: u32) -> Result<Vec<u8>> {
    match method {
        0 => {
            if input.len() < expected {
                return Err(Error::TextureSizeMismatch {
                    expected: expected as u64,
                    actual: input.len() as u64,
                });
            }
            Ok(input[..expected].to_vec())
        }
        1 => {
            let mut output = vec![0u8; expected];
            let written = lz4_flex::block::decompress_into(input, &mut output)
                .map_err(|_| Error::TextureDecode("LZ4 mip"))?;
            if written != expected {
                return Err(Error::TextureDecode("LZ4 mip"));
            }
            Ok(output)
        }
        2 => {
            use std::io::Read;
            let mut decoder = ruzstd::decoding::StreamingDecoder::new_with_max_window_size(
                input,
                MAX_TEXTURE_BYTES as u64,
            )
            .map_err(|_| Error::TextureDecode("zstd mip"))?;
            let mut output = vec![0u8; expected];
            decoder
                .read_exact(&mut output)
                .map_err(|_| Error::TextureDecode("zstd mip"))?;
            Ok(output)
        }
        other => Err(Error::UnknownMipCompression(other)),
    }
}

fn u16_at(data: &[u8], offset: usize) -> Result<u16> {
    let end = offset
        .checked_add(2)
        .ok_or(Error::TextureHeaderTooSmall)?;
    let bytes = data
        .get(offset..end)
        .ok_or(Error::TextureHeaderTooSmall)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn u32_at(data: &[u8], offset: usize) -> Result<u32> {
    let end = offset
        .checked_add(4)
        .ok_or(Error::TextureHeaderTooSmall)?;
    let bytes = data
        .get(offset..end)
        .ok_or(Error::TextureHeaderTooSmall)?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}
