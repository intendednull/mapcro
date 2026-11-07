//! PNG output.

use std::path::Path;

use crate::{Error, Result};

/// Encode a tightly packed RGBA8 buffer as a PNG.
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>> {
    let expected = usize::try_from(
        u64::from(width)
            .checked_mul(u64::from(height))
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or(Error::DimensionsOverflow)?,
    )
    .map_err(|_| Error::DimensionsOverflow)?;
    if rgba.len() != expected {
        return Err(Error::PixelBufferSize {
            expected,
            actual: rgba.len(),
        });
    }

    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(rgba)?;
    }
    Ok(out)
}

/// Encode and write a PNG, creating parent directories as needed. Returns the encoded bytes.
pub fn write_png(path: &Path, width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>> {
    let bytes = encode_png(width, height, rgba)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, &bytes)?;
    Ok(bytes)
}
