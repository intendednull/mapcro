//! Texture decoder tests with synthetic blocks.

mod support;

use mapcro_extract::decode_vtex;
use support::{build_vtex, build_vtex_with_extra};

#[test]
fn dxt1_block_decodes_known_colour() {
    // color0 = red (RGB565 0xF800), color1 = blue (0x001F), all indices 0.
    let block = [0x00, 0xF8, 0x1F, 0x00, 0x00, 0x00, 0x00, 0x00];
    let texture = decode_vtex(&build_vtex(4, 4, 1, &block)).expect("decode DXT1");
    assert_eq!((texture.width, texture.height), (4, 4));
    assert_eq!(texture.rgba, [255, 0, 0, 255].repeat(16));
}

#[test]
fn dxt5_block_decodes_known_colour() {
    // alpha0 = 255, alpha1 = 0, all alpha indices 0; colour block is red.
    let block = [
        255, 0, 0, 0, 0, 0, 0, 0, 0x00, 0xF8, 0x1F, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];
    let texture = decode_vtex(&build_vtex(4, 4, 2, &block)).expect("decode DXT5");
    assert_eq!((texture.width, texture.height), (4, 4));
    assert_eq!(texture.rgba, [255, 0, 0, 255].repeat(16));
}

fn zeros(width: usize, height: usize) -> Vec<u8> {
    vec![0u8; width * height * 4]
}

fn compressed_mips(method: u32) -> Vec<u8> {
    let mip0 = zeros(16, 16);
    let mip1 = zeros(8, 8);
    let (compressed0, compressed1) = match method {
        1 => (
            lz4_flex::block::compress(&mip0),
            lz4_flex::block::compress(&mip1),
        ),
        2 => (
            ruzstd::encoding::compress_to_vec(
                mip0.as_slice(),
                ruzstd::encoding::CompressionLevel::Fastest,
            ),
            ruzstd::encoding::compress_to_vec(
                mip1.as_slice(),
                ruzstd::encoding::CompressionLevel::Fastest,
            ),
        ),
        _ => panic!("unsupported test method"),
    };
    assert!(compressed0.len() < mip0.len());
    assert!(compressed1.len() < mip1.len());

    let mut payload = Vec::new();
    payload.extend_from_slice(&method.to_le_bytes());
    payload.extend_from_slice(&12u32.to_le_bytes());
    payload.extend_from_slice(&2u32.to_le_bytes());
    payload.extend_from_slice(&(compressed0.len() as u32).to_le_bytes());
    payload.extend_from_slice(&(compressed1.len() as u32).to_le_bytes());

    let mut pixels = Vec::new();
    pixels.extend_from_slice(&compressed1);
    pixels.extend_from_slice(&compressed0);

    build_vtex_with_extra(16, 16, 28, 2, &pixels, Some((4, &payload)))
}

#[test]
fn lz4_compressed_mips_decode() {
    let texture = decode_vtex(&compressed_mips(1)).expect("decode LZ4 mips");
    assert_eq!((texture.width, texture.height), (16, 16));
    assert_eq!(texture.rgba, zeros(16, 16));
}

#[test]
fn zstd_compressed_mips_decode() {
    let texture = decode_vtex(&compressed_mips(2)).expect("decode zstd mips");
    assert_eq!((texture.width, texture.height), (16, 16));
    assert_eq!(texture.rgba, zeros(16, 16));
}
