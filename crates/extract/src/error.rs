use std::path::PathBuf;

/// Every failure the extractor can report.
///
/// Texture problems deliberately have typed variants (never a formatted string), so callers can
/// distinguish "this build uses a format we do not support" from a corrupt or truncated file.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("not a directory: {0}")]
    NotADirectory(PathBuf),

    #[error("not a VPK archive")]
    NotVpk,

    #[error("unsupported VPK version {0}")]
    UnsupportedVpkVersion(u32),

    #[error("truncated VPK file")]
    TruncatedVpk,

    #[error("malformed VPK directory tree")]
    MalformedTree,

    #[error("bad VPK entry terminator {0:#06x}")]
    BadTerminator(u16),

    #[error("unsafe path: {0}")]
    UnsafePath(String),

    #[error("path is not allow-listed: {0}")]
    PathNotAllowed(String),

    #[error("entry not found in VPK: {0}")]
    EntryNotFound(String),

    #[error("entry is too large to read: {0}")]
    EntryTooLarge(String),

    #[error("CRC32 mismatch for {path}: expected {expected:#010x}, got {actual:#010x}")]
    CrcMismatch {
        path: String,
        expected: u32,
        actual: u32,
    },

    #[error("entry data is truncated: {0}")]
    TruncatedEntry(String),

    #[error("truncated Source 2 resource")]
    TruncatedResource,

    #[error("unsupported resource header version {0}")]
    UnsupportedResourceVersion(u16),

    #[error("resource block table is out of bounds")]
    BlockTableOutOfBounds,

    #[error("resource block {0:?} is out of bounds")]
    BlockOutOfBounds(String),

    #[error("resource has no DATA block")]
    MissingDataBlock,

    #[error("texture header is truncated")]
    TextureHeaderTooSmall,

    #[error("unsupported texture version {0}")]
    UnsupportedTextureVersion(u16),

    #[error("unsupported texture format {0} (only BGRA8888 / format 28 is supported)")]
    UnsupportedFormat(u8),

    #[error("texture mip levels are compressed")]
    CompressedMips,

    #[error("unsupported texture depth {0}")]
    UnsupportedDepth(u16),

    #[error("texture has no mip levels")]
    NoMipLevels,

    #[error("texture has an invalid mip count {0}")]
    InvalidMipCount(u8),

    #[error("texture has a zero dimension")]
    ZeroDimensions,

    #[error("texture extra data is out of bounds")]
    ExtraDataOutOfBounds,

    #[error("texture size mismatch: expected {expected} bytes, found {actual}")]
    TextureSizeMismatch { expected: u64, actual: u64 },

    #[error("texture dimensions overflow")]
    DimensionsOverflow,

    #[error("pixel buffer size mismatch: expected {expected} bytes, got {actual}")]
    PixelBufferSize { expected: usize, actual: usize },

    #[error("steam.inf is missing {0}")]
    MissingSteamField(&'static str),

    #[error("steam.inf has an invalid value for {0}")]
    InvalidSteamValue(&'static str),

    #[error("output directory is inside the game directory: {0}")]
    OutputInsideGame(PathBuf),

    #[error("output directory is inside the repository: {0}")]
    OutputInsideRepo(PathBuf),

    #[error("PNG encoding failed: {0}")]
    Png(#[from] png::EncodingError),

    #[error("JSON serialization failed: {0}")]
    Json(#[from] serde_json::Error),

    #[error("PNG decoding failed: {0}")]
    PngDecode(#[from] png::DecodingError),

    #[error("texture data could not be decoded as {0}")]
    TextureDecode(&'static str),

    #[error("compressed mip table does not match the texture's mip count")]
    CompressedMipCount,

    #[error("compressed mip size table is out of bounds")]
    CompressedMipTable,

    #[error("unknown texture mip compression method {0}")]
    UnknownMipCompression(u32),

    #[error("not a binary KV3 block")]
    Kv3BadMagic,

    #[error("unsupported binary KV3 version {0}")]
    UnsupportedKv3Version(u8),

    #[error("unsupported KV3 compression method {0}")]
    UnsupportedKv3Compression(u32),

    #[error("truncated KV3 data")]
    TruncatedKv3,

    #[error("malformed KV3 data")]
    MalformedKv3,

    #[error("invalid KV3 value type {0}")]
    InvalidKv3Type(u8),

    #[error("KV3 nesting exceeds the 64 level limit")]
    Kv3NestingTooDeep,

    #[error("KV3 data exceeds the 64 MiB decompressed limit")]
    Kv3TooLarge,

    #[error("KV3 decompression failed")]
    Kv3Decompress,

    #[error("KV3 trailer is invalid: {0:#010x}")]
    Kv3BadTrailer(u32),

    #[error("KV3 binary blob is out of range")]
    Kv3BlobOutOfRange,

    #[error("KV3 string table is malformed")]
    Kv3StringTable,

    #[error("unexpected end of KV1 text")]
    Kv1UnexpectedEnd,

    #[error("malformed KV1 text")]
    Kv1Malformed,

    #[error("trailing data after KV1 value")]
    Kv1Trailing,

    #[error("hero record {0} has no usable m_HeroID")]
    MissingHeroId(String),

    #[error("entity origin is not a 3-component vector")]
    MalformedOrigin,

    #[error("panorama resource header is malformed")]
    MalformedPanorama,

    #[error("panorama layout has no m_AST/m_pRoot")]
    MalformedLayout,

    #[error("unexpected panorama layout node type {0}")]
    UnknownLayoutNode(String),

    #[error("text is not valid UTF-8")]
    InvalidUtf8,

    /// The `--stat-data` directory (boon-data snapshots) is missing a file, fails its hash, or
    /// doesn't parse.
    #[error("stat data: {0}")]
    StatData(String),
}

pub type Result<T> = std::result::Result<T, Error>;
