//! PackedGrid v1 binary manifests and chunks for exact National numeric grids.

use crate::mrms::{
    DecodedMrmsGrid, MRMS_BINARY_SCALE, MRMS_BIT_DEPTH, MRMS_DECIMAL_SCALE, MRMS_DOMAIN,
    MRMS_HEIGHT, MRMS_HOST, MRMS_MISSING_RAW, MRMS_NO_COVERAGE_RAW, MRMS_PRODUCT,
    MRMS_REFERENCE_VALUE, MRMS_WIDTH, MrmsError, MrmsGridDefinition, MrmsObject,
    MrmsRowOrientation, MrmsValueEncoding, reduce_strongest_valid,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use thiserror::Error;

pub const PACKED_GRID_VERSION: u16 = 1;
pub const PACKED_GRID_HEADER_BYTES: usize = 176;
pub const PACKED_GRID_DESCRIPTOR_BYTES: usize = 72;
pub const PACKED_GRID_CHUNK_INTERIOR: usize = 256;
pub const PACKED_GRID_CHUNK_HALO: usize = 1;
pub const PACKED_GRID_MANIFEST_LIMIT: usize = 1024 * 1024;
pub const PACKED_GRID_CHUNK_LIMIT: usize = 512 * 1024;
pub const PACKED_GRID_MAGIC: &[u8; 4] = b"MGRD";
pub const PACKED_GRID_CHUNK_MAGIC: &[u8; 4] = b"MGCK";

const RECORD_MANIFEST: u16 = 1;
const RECORD_CHUNK: u16 = 2;
const SOURCE_NATIONAL_MRMS: u8 = 1;
const DOMAIN_CONUS: u8 = 1;
const PRODUCT_MERGED_BASE_REFLECTIVITY_QC: u8 = 1;
const ORIENTATION_NORTH_TO_SOUTH: u8 = 1;
const MRMS_FIRST_LATITUDE_E6: i32 = 54_995_000;
const MRMS_FIRST_LONGITUDE_E6: i32 = -129_995_000;
const MRMS_BASE_STEP_E6: u32 = 10_000;

#[derive(Debug, Error)]
pub enum PackedGridError {
    #[error("numeric level is invalid: {0}")]
    InvalidLevel(String),
    #[error("PackedGrid value exceeds a wire bound: {0}")]
    Bounds(String),
    #[error("PackedGrid v1 manifest is invalid: {0}")]
    InvalidManifest(String),
    #[error("PackedGrid v1 chunk is invalid: {0}")]
    InvalidChunk(String),
    #[error("MRMS overview generation failed: {0}")]
    Overview(String),
}

#[derive(Debug, Clone)]
pub struct NumericGridLevel {
    pub factor: u16,
    pub width: usize,
    pub height: usize,
    pub raw_codes: Vec<u16>,
}

impl NumericGridLevel {
    pub fn bytes(&self) -> usize {
        self.raw_codes.len() * 2
    }
}

#[derive(Debug, Clone)]
pub struct MrmsNumericPyramid {
    pub object_key: String,
    pub observation_time_unix_ms: i64,
    pub content_sha256: [u8; 32],
    pub grid: MrmsGridDefinition,
    pub encoding: MrmsValueEncoding,
    pub levels: BTreeMap<u16, NumericGridLevel>,
}

impl MrmsNumericPyramid {
    pub fn from_decoded(
        decoded: DecodedMrmsGrid,
        max_factor: u16,
    ) -> Result<Self, PackedGridError> {
        if max_factor == 0 || !max_factor.is_power_of_two() {
            return Err(PackedGridError::InvalidLevel(
                "maximum factor must be a non-zero power of two".into(),
            ));
        }
        let content_sha256 = parse_sha256(&decoded.evidence.compressed_sha256)?;
        let mut levels = BTreeMap::new();
        let mut factor = 1u16;
        let mut width = decoded.grid.width as usize;
        let mut height = decoded.grid.height as usize;
        let mut raw_codes = decoded.raw_codes;
        loop {
            levels.insert(
                factor,
                NumericGridLevel {
                    factor,
                    width,
                    height,
                    raw_codes: raw_codes.clone(),
                },
            );
            if factor == max_factor {
                break;
            }
            let (next, next_width, next_height) =
                reduce_strongest_valid(&raw_codes, width, height, decoded.encoding)
                    .map_err(|error| PackedGridError::Overview(error.to_string()))?;
            factor = factor.checked_mul(2).ok_or_else(|| {
                PackedGridError::InvalidLevel("presentation factor overflowed".into())
            })?;
            raw_codes = next;
            width = next_width;
            height = next_height;
        }
        Ok(Self {
            object_key: decoded.object.key,
            observation_time_unix_ms: decoded.object.observation_time_unix_ms,
            content_sha256,
            grid: decoded.grid,
            encoding: decoded.encoding,
            levels,
        })
    }

    pub fn retained_bytes(&self) -> usize {
        self.levels.values().map(NumericGridLevel::bytes).sum()
    }
}

#[derive(Debug, Clone)]
pub struct NumericGridChunk {
    pub index: u32,
    pub chunk_x: u16,
    pub chunk_y: u16,
    pub interior_x: u32,
    pub interior_y: u32,
    pub interior_width: u16,
    pub interior_height: u16,
    pub halo_x: u32,
    pub halo_y: u32,
    pub halo_width: u16,
    pub halo_height: u16,
    pub raw_codes: Vec<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedGridChunkDescriptor {
    pub index: u32,
    pub chunk_x: u16,
    pub chunk_y: u16,
    pub interior_x: u32,
    pub interior_y: u32,
    pub interior_width: u16,
    pub interior_height: u16,
    pub halo_x: u32,
    pub halo_y: u32,
    pub halo_width: u16,
    pub halo_height: u16,
    pub encoded_length: u32,
    pub payload_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedGridManifestSummary {
    pub version: u16,
    pub generation: u64,
    pub source_kind: String,
    pub domain: String,
    pub product: String,
    pub provider: String,
    pub object_key: String,
    pub observation_time_unix_ms: i64,
    pub content_sha256: String,
    pub width: u32,
    pub height: u32,
    pub first_latitude_degrees: f64,
    pub first_longitude_degrees: f64,
    pub last_latitude_degrees: f64,
    pub last_longitude_degrees: f64,
    pub longitude_step_degrees: f64,
    pub latitude_step_degrees: f64,
    pub row_orientation: String,
    pub bit_depth: u8,
    pub reference_value: f32,
    pub binary_scale: i16,
    pub decimal_scale: i16,
    pub missing_raw: u16,
    pub no_coverage_raw: u16,
    pub presentation_factor: u16,
    pub chunk_interior_size: u16,
    pub chunks: Vec<PackedGridChunkDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedGridChunkSummary {
    pub version: u16,
    pub generation: u64,
    pub observation_time_unix_ms: i64,
    pub content_sha256: String,
    pub presentation_factor: u16,
    pub level_width: u32,
    pub level_height: u32,
    pub chunk: PackedGridChunkDescriptor,
    pub bit_depth: u8,
    pub reference_value_bits: u32,
    pub binary_scale: i16,
    pub decimal_scale: i16,
    pub missing_raw: u16,
    pub no_coverage_raw: u16,
}

#[derive(Debug, Clone)]
pub struct PackedGridFrame {
    pub manifest: Vec<u8>,
    pub chunks: Vec<Vec<u8>>,
    pub summary: PackedGridManifestSummary,
}

impl PackedGridFrame {
    pub fn encode(
        generation: u64,
        pyramid: &MrmsNumericPyramid,
        presentation_factor: u16,
    ) -> Result<Self, PackedGridError> {
        if generation == 0 {
            return Err(PackedGridError::Bounds(
                "generation must be greater than zero".into(),
            ));
        }
        let level = pyramid.levels.get(&presentation_factor).ok_or_else(|| {
            PackedGridError::InvalidLevel(format!(
                "presentation factor {presentation_factor} was not generated"
            ))
        })?;
        let chunks = chunk_level(level)?;
        let mut encoded_chunks = Vec::with_capacity(chunks.len());
        let mut descriptors = Vec::with_capacity(chunks.len());
        for chunk in &chunks {
            let (bytes, descriptor) = encode_chunk(generation, pyramid, level, chunk)?;
            encoded_chunks.push(bytes);
            descriptors.push(descriptor);
        }
        let manifest = encode_manifest(generation, pyramid, level, &descriptors)?;
        let summary = validate_packed_grid_manifest(&manifest)?;
        for (encoded, expected) in encoded_chunks.iter().zip(&summary.chunks) {
            let decoded = validate_packed_grid_chunk(encoded)?;
            if decoded.generation != summary.generation
                || decoded.observation_time_unix_ms != summary.observation_time_unix_ms
                || decoded.content_sha256 != summary.content_sha256
                || decoded.presentation_factor != summary.presentation_factor
                || decoded.chunk != *expected
            {
                return Err(PackedGridError::InvalidChunk(
                    "chunk identity does not match its frame manifest".into(),
                ));
            }
        }
        Ok(Self {
            manifest,
            chunks: encoded_chunks,
            summary,
        })
    }

    pub fn transfer_bytes(&self) -> usize {
        self.manifest.len() + self.chunks.iter().map(Vec::len).sum::<usize>()
    }
}

pub fn chunk_level(level: &NumericGridLevel) -> Result<Vec<NumericGridChunk>, PackedGridError> {
    if level.width == 0
        || level.height == 0
        || level.width.checked_mul(level.height) != Some(level.raw_codes.len())
    {
        return Err(PackedGridError::InvalidLevel(
            "dimensions do not match the raw-code count".into(),
        ));
    }
    let count_x = level.width.div_ceil(PACKED_GRID_CHUNK_INTERIOR);
    let count_y = level.height.div_ceil(PACKED_GRID_CHUNK_INTERIOR);
    if count_x > u16::MAX as usize || count_y > u16::MAX as usize {
        return Err(PackedGridError::Bounds(
            "chunk coordinate exceeds u16".into(),
        ));
    }
    let mut chunks = Vec::with_capacity(count_x * count_y);
    for chunk_y in 0..count_y {
        for chunk_x in 0..count_x {
            let interior_x = chunk_x * PACKED_GRID_CHUNK_INTERIOR;
            let interior_y = chunk_y * PACKED_GRID_CHUNK_INTERIOR;
            let interior_width = PACKED_GRID_CHUNK_INTERIOR.min(level.width - interior_x);
            let interior_height = PACKED_GRID_CHUNK_INTERIOR.min(level.height - interior_y);
            let halo_x = interior_x.saturating_sub(PACKED_GRID_CHUNK_HALO);
            let halo_y = interior_y.saturating_sub(PACKED_GRID_CHUNK_HALO);
            let halo_end_x =
                (interior_x + interior_width + PACKED_GRID_CHUNK_HALO).min(level.width);
            let halo_end_y =
                (interior_y + interior_height + PACKED_GRID_CHUNK_HALO).min(level.height);
            let halo_width = halo_end_x - halo_x;
            let halo_height = halo_end_y - halo_y;
            let mut raw_codes = Vec::with_capacity(halo_width * halo_height);
            for y in halo_y..halo_end_y {
                let row = &level.raw_codes[y * level.width + halo_x..y * level.width + halo_end_x];
                raw_codes.extend_from_slice(row);
            }
            chunks.push(NumericGridChunk {
                index: u32::try_from(chunks.len())
                    .map_err(|_| PackedGridError::Bounds("chunk index exceeds u32".into()))?,
                chunk_x: chunk_x as u16,
                chunk_y: chunk_y as u16,
                interior_x: interior_x as u32,
                interior_y: interior_y as u32,
                interior_width: interior_width as u16,
                interior_height: interior_height as u16,
                halo_x: halo_x as u32,
                halo_y: halo_y as u32,
                halo_width: halo_width as u16,
                halo_height: halo_height as u16,
                raw_codes,
            });
        }
    }
    Ok(chunks)
}

fn encode_manifest(
    generation: u64,
    pyramid: &MrmsNumericPyramid,
    level: &NumericGridLevel,
    chunks: &[PackedGridChunkDescriptor],
) -> Result<Vec<u8>, PackedGridError> {
    let source = b"national_mrms".as_slice();
    let domain = MRMS_DOMAIN.as_bytes();
    let product = MRMS_PRODUCT.as_bytes();
    let provider = MRMS_HOST.as_bytes();
    let object = pyramid.object_key.as_bytes();
    let strings_length =
        source.len() + domain.len() + product.len() + provider.len() + object.len();
    let descriptors_length = chunks
        .len()
        .checked_mul(PACKED_GRID_DESCRIPTOR_BYTES)
        .ok_or_else(|| PackedGridError::Bounds("descriptor bytes overflowed".into()))?;
    let total_length = PACKED_GRID_HEADER_BYTES
        .checked_add(strings_length)
        .and_then(|value| value.checked_add(descriptors_length))
        .ok_or_else(|| PackedGridError::Bounds("manifest length overflowed".into()))?;
    if total_length > PACKED_GRID_MANIFEST_LIMIT {
        return Err(PackedGridError::Bounds(format!(
            "manifest is {total_length} bytes; limit is {PACKED_GRID_MANIFEST_LIMIT}"
        )));
    }
    let width = u32::try_from(level.width)
        .map_err(|_| PackedGridError::Bounds("level width exceeds u32".into()))?;
    let height = u32::try_from(level.height)
        .map_err(|_| PackedGridError::Bounds("level height exceeds u32".into()))?;
    let base_first_latitude_e6 = degrees_e6(pyramid.grid.first_latitude_degrees)?;
    let base_first_longitude_e6 = degrees_e6(pyramid.grid.first_longitude_degrees)?;
    let base_longitude_step_e6 = degrees_u32_e6(pyramid.grid.longitude_step_degrees)?;
    let base_latitude_step_e6 = degrees_u32_e6(pyramid.grid.latitude_step_degrees)?;
    let first_latitude_e6 = presentation_first_e6(
        base_first_latitude_e6,
        base_latitude_step_e6,
        level.factor,
        false,
    )
    .ok_or_else(|| PackedGridError::Bounds("level latitude origin overflowed".into()))?;
    let first_longitude_e6 = presentation_first_e6(
        base_first_longitude_e6,
        base_longitude_step_e6,
        level.factor,
        true,
    )
    .ok_or_else(|| PackedGridError::Bounds("level longitude origin overflowed".into()))?;
    let longitude_step_e6 = base_longitude_step_e6
        .checked_mul(u32::from(level.factor))
        .ok_or_else(|| PackedGridError::Bounds("level longitude step overflowed".into()))?;
    let latitude_step_e6 = base_latitude_step_e6
        .checked_mul(u32::from(level.factor))
        .ok_or_else(|| PackedGridError::Bounds("level latitude step overflowed".into()))?;
    let last_latitude_e6 = regular_grid_last_e6(first_latitude_e6, latitude_step_e6, height, false)
        .ok_or_else(|| PackedGridError::Bounds("level latitude transform overflowed".into()))?;
    let last_longitude_e6 =
        regular_grid_last_e6(first_longitude_e6, longitude_step_e6, width, true).ok_or_else(
            || PackedGridError::Bounds("level longitude transform overflowed".into()),
        )?;
    let mut bytes = vec![0u8; total_length];
    bytes[..4].copy_from_slice(PACKED_GRID_MAGIC);
    put_u16(&mut bytes, 4, PACKED_GRID_VERSION);
    put_u16(&mut bytes, 6, RECORD_MANIFEST);
    put_u32(&mut bytes, 8, PACKED_GRID_HEADER_BYTES as u32);
    put_u32(&mut bytes, 12, total_length as u32);
    put_u64(&mut bytes, 16, generation);
    put_i64(&mut bytes, 24, pyramid.observation_time_unix_ms);
    put_u32(&mut bytes, 32, width);
    put_u32(&mut bytes, 36, height);
    put_i32(&mut bytes, 40, first_latitude_e6);
    put_i32(&mut bytes, 44, first_longitude_e6);
    put_i32(&mut bytes, 48, last_latitude_e6);
    put_i32(&mut bytes, 52, last_longitude_e6);
    put_u32(&mut bytes, 56, longitude_step_e6);
    put_u32(&mut bytes, 60, latitude_step_e6);
    bytes[64] = orientation_code(pyramid.grid.row_orientation);
    bytes[65] = pyramid.encoding.bit_depth;
    put_u32(&mut bytes, 68, pyramid.encoding.reference_value_bits);
    put_i16(&mut bytes, 72, pyramid.encoding.binary_scale);
    put_i16(&mut bytes, 74, pyramid.encoding.decimal_scale);
    put_u16(&mut bytes, 76, pyramid.encoding.missing_raw);
    put_u16(&mut bytes, 78, pyramid.encoding.no_coverage_raw);
    put_u16(&mut bytes, 80, level.factor);
    put_u16(&mut bytes, 82, PACKED_GRID_CHUNK_INTERIOR as u16);
    put_u32(&mut bytes, 84, chunks.len() as u32);

    let mut cursor = PACKED_GRID_HEADER_BYTES;
    let source_offset = append(&mut bytes, &mut cursor, source)?;
    let domain_offset = append(&mut bytes, &mut cursor, domain)?;
    let product_offset = append(&mut bytes, &mut cursor, product)?;
    let provider_offset = append(&mut bytes, &mut cursor, provider)?;
    let object_offset = append(&mut bytes, &mut cursor, object)?;
    put_range(&mut bytes, 88, source_offset, source.len())?;
    put_range(&mut bytes, 96, domain_offset, domain.len())?;
    put_range(&mut bytes, 104, product_offset, product.len())?;
    put_range(&mut bytes, 112, provider_offset, provider.len())?;
    bytes[120..152].copy_from_slice(&pyramid.content_sha256);
    put_u32(&mut bytes, 152, cursor as u32);
    put_u16(&mut bytes, 156, PACKED_GRID_DESCRIPTOR_BYTES as u16);
    put_u32(&mut bytes, 160, object_offset as u32);
    put_u32(&mut bytes, 164, object.len() as u32);

    for (index, descriptor) in chunks.iter().enumerate() {
        let base = cursor + index * PACKED_GRID_DESCRIPTOR_BYTES;
        put_u32(&mut bytes, base, descriptor.index);
        put_u16(&mut bytes, base + 4, descriptor.chunk_x);
        put_u16(&mut bytes, base + 6, descriptor.chunk_y);
        put_u32(&mut bytes, base + 8, descriptor.interior_x);
        put_u32(&mut bytes, base + 12, descriptor.interior_y);
        put_u16(&mut bytes, base + 16, descriptor.interior_width);
        put_u16(&mut bytes, base + 18, descriptor.interior_height);
        put_u32(&mut bytes, base + 20, descriptor.halo_x);
        put_u32(&mut bytes, base + 24, descriptor.halo_y);
        put_u16(&mut bytes, base + 28, descriptor.halo_width);
        put_u16(&mut bytes, base + 30, descriptor.halo_height);
        put_u32(&mut bytes, base + 32, descriptor.encoded_length);
        let hash = parse_sha256(&descriptor.payload_sha256)?;
        bytes[base + 36..base + 68].copy_from_slice(&hash);
    }
    if cursor + descriptors_length != bytes.len() {
        return Err(PackedGridError::Bounds(
            "manifest assembly did not consume its exact allocation".into(),
        ));
    }
    Ok(bytes)
}

fn encode_chunk(
    generation: u64,
    pyramid: &MrmsNumericPyramid,
    level: &NumericGridLevel,
    chunk: &NumericGridChunk,
) -> Result<(Vec<u8>, PackedGridChunkDescriptor), PackedGridError> {
    let payload_length = chunk
        .raw_codes
        .len()
        .checked_mul(2)
        .ok_or_else(|| PackedGridError::Bounds("chunk payload length overflowed".into()))?;
    let total_length = PACKED_GRID_HEADER_BYTES
        .checked_add(payload_length)
        .ok_or_else(|| PackedGridError::Bounds("chunk length overflowed".into()))?;
    if total_length > PACKED_GRID_CHUNK_LIMIT {
        return Err(PackedGridError::Bounds(format!(
            "chunk is {total_length} bytes; limit is {PACKED_GRID_CHUNK_LIMIT}"
        )));
    }
    let mut bytes = vec![0u8; total_length];
    bytes[..4].copy_from_slice(PACKED_GRID_CHUNK_MAGIC);
    put_u16(&mut bytes, 4, PACKED_GRID_VERSION);
    put_u16(&mut bytes, 6, RECORD_CHUNK);
    put_u32(&mut bytes, 8, PACKED_GRID_HEADER_BYTES as u32);
    put_u32(&mut bytes, 12, total_length as u32);
    put_u64(&mut bytes, 16, generation);
    put_i64(&mut bytes, 24, pyramid.observation_time_unix_ms);
    bytes[32..64].copy_from_slice(&pyramid.content_sha256);
    bytes[64] = SOURCE_NATIONAL_MRMS;
    bytes[65] = DOMAIN_CONUS;
    bytes[66] = PRODUCT_MERGED_BASE_REFLECTIVITY_QC;
    bytes[67] = orientation_code(pyramid.grid.row_orientation);
    put_u32(&mut bytes, 68, level.width as u32);
    put_u32(&mut bytes, 72, level.height as u32);
    put_u16(&mut bytes, 76, level.factor);
    put_u16(&mut bytes, 78, PACKED_GRID_CHUNK_INTERIOR as u16);
    put_u32(&mut bytes, 80, chunk.index);
    put_u16(&mut bytes, 84, chunk.chunk_x);
    put_u16(&mut bytes, 86, chunk.chunk_y);
    put_u32(&mut bytes, 88, chunk.interior_x);
    put_u32(&mut bytes, 92, chunk.interior_y);
    put_u16(&mut bytes, 96, chunk.interior_width);
    put_u16(&mut bytes, 98, chunk.interior_height);
    put_u32(&mut bytes, 100, chunk.halo_x);
    put_u32(&mut bytes, 104, chunk.halo_y);
    put_u16(&mut bytes, 108, chunk.halo_width);
    put_u16(&mut bytes, 110, chunk.halo_height);
    bytes[112] = pyramid.encoding.bit_depth;
    put_u32(&mut bytes, 116, pyramid.encoding.reference_value_bits);
    put_i16(&mut bytes, 120, pyramid.encoding.binary_scale);
    put_i16(&mut bytes, 122, pyramid.encoding.decimal_scale);
    put_u16(&mut bytes, 124, pyramid.encoding.missing_raw);
    put_u16(&mut bytes, 126, pyramid.encoding.no_coverage_raw);
    put_u32(&mut bytes, 128, PACKED_GRID_HEADER_BYTES as u32);
    put_u32(&mut bytes, 132, payload_length as u32);
    let mut payload_hasher = Sha256::new();
    let mut cursor = PACKED_GRID_HEADER_BYTES;
    for raw in &chunk.raw_codes {
        let pair = raw.to_be_bytes();
        bytes[cursor..cursor + 2].copy_from_slice(&pair);
        payload_hasher.update(pair);
        cursor += 2;
    }
    let payload_hash: [u8; 32] = payload_hasher.finalize().into();
    bytes[136..168].copy_from_slice(&payload_hash);
    let payload_sha256 = hex_sha256(&payload_hash);
    let descriptor = PackedGridChunkDescriptor {
        index: chunk.index,
        chunk_x: chunk.chunk_x,
        chunk_y: chunk.chunk_y,
        interior_x: chunk.interior_x,
        interior_y: chunk.interior_y,
        interior_width: chunk.interior_width,
        interior_height: chunk.interior_height,
        halo_x: chunk.halo_x,
        halo_y: chunk.halo_y,
        halo_width: chunk.halo_width,
        halo_height: chunk.halo_height,
        encoded_length: total_length as u32,
        payload_sha256,
    };
    Ok((bytes, descriptor))
}

pub fn validate_packed_grid_manifest(
    bytes: &[u8],
) -> Result<PackedGridManifestSummary, PackedGridError> {
    if bytes.len() < PACKED_GRID_HEADER_BYTES || bytes.len() > PACKED_GRID_MANIFEST_LIMIT {
        return Err(invalid_manifest("length is outside the manifest bound"));
    }
    if &bytes[..4] != PACKED_GRID_MAGIC
        || get_u16(bytes, 4)? != PACKED_GRID_VERSION
        || get_u16(bytes, 6)? != RECORD_MANIFEST
        || get_u32(bytes, 8)? as usize != PACKED_GRID_HEADER_BYTES
        || get_u32(bytes, 12)? as usize != bytes.len()
    {
        return Err(invalid_manifest(
            "magic, version, kind, or length is invalid",
        ));
    }
    let generation = get_u64(bytes, 16)?;
    let observation_time_unix_ms = get_i64(bytes, 24)?;
    let width = get_u32(bytes, 32)?;
    let height = get_u32(bytes, 36)?;
    let presentation_factor = get_u16(bytes, 80)?;
    if generation == 0 || observation_time_unix_ms <= 0 {
        return Err(invalid_manifest(
            "generation or observation time is invalid",
        ));
    }
    if presentation_factor == 0
        || presentation_factor > 16
        || !presentation_factor.is_power_of_two()
        || width != MRMS_WIDTH.div_ceil(u32::from(presentation_factor))
        || height != MRMS_HEIGHT.div_ceil(u32::from(presentation_factor))
    {
        return Err(invalid_manifest(
            "grid transform or presentation level changed",
        ));
    }
    let level_step_e6 = MRMS_BASE_STEP_E6
        .checked_mul(u32::from(presentation_factor))
        .ok_or_else(|| invalid_manifest("presentation step overflowed"))?;
    let expected_first_latitude_e6 = presentation_first_e6(
        MRMS_FIRST_LATITUDE_E6,
        MRMS_BASE_STEP_E6,
        presentation_factor,
        false,
    )
    .ok_or_else(|| invalid_manifest("latitude origin overflowed"))?;
    let expected_first_longitude_e6 = presentation_first_e6(
        MRMS_FIRST_LONGITUDE_E6,
        MRMS_BASE_STEP_E6,
        presentation_factor,
        true,
    )
    .ok_or_else(|| invalid_manifest("longitude origin overflowed"))?;
    let expected_last_latitude_e6 =
        regular_grid_last_e6(expected_first_latitude_e6, level_step_e6, height, false)
            .ok_or_else(|| invalid_manifest("latitude transform overflowed"))?;
    let expected_last_longitude_e6 =
        regular_grid_last_e6(expected_first_longitude_e6, level_step_e6, width, true)
            .ok_or_else(|| invalid_manifest("longitude transform overflowed"))?;
    if get_i32(bytes, 40)? != expected_first_latitude_e6
        || get_i32(bytes, 44)? != expected_first_longitude_e6
        || get_i32(bytes, 48)? != expected_last_latitude_e6
        || get_i32(bytes, 52)? != expected_last_longitude_e6
        || get_u32(bytes, 56)? != level_step_e6
        || get_u32(bytes, 60)? != level_step_e6
    {
        return Err(invalid_manifest(
            "grid transform or presentation level changed",
        ));
    }
    if bytes[64] != ORIENTATION_NORTH_TO_SOUTH
        || bytes[65] != MRMS_BIT_DEPTH
        || get_u32(bytes, 68)? != MRMS_REFERENCE_VALUE.to_bits()
        || get_i16(bytes, 72)? != MRMS_BINARY_SCALE
        || get_i16(bytes, 74)? != MRMS_DECIMAL_SCALE
        || get_u16(bytes, 76)? != MRMS_MISSING_RAW
        || get_u16(bytes, 78)? != MRMS_NO_COVERAGE_RAW
        || get_u16(bytes, 82)? != PACKED_GRID_CHUNK_INTERIOR as u16
    {
        return Err(invalid_manifest("orientation or value encoding changed"));
    }
    let descriptor_offset = get_u32(bytes, 152)? as usize;
    let descriptor_size = get_u16(bytes, 156)? as usize;
    let count = get_u32(bytes, 84)? as usize;
    let expected_count = (width as usize).div_ceil(PACKED_GRID_CHUNK_INTERIOR)
        * (height as usize).div_ceil(PACKED_GRID_CHUNK_INTERIOR);
    if descriptor_size != PACKED_GRID_DESCRIPTOR_BYTES
        || count != expected_count
        || descriptor_offset < PACKED_GRID_HEADER_BYTES
        || descriptor_offset.checked_add(
            count
                .checked_mul(descriptor_size)
                .ok_or_else(|| invalid_manifest("descriptor length overflowed"))?,
        ) != Some(bytes.len())
    {
        return Err(invalid_manifest("descriptor bounds are invalid"));
    }
    if bytes[66..68].iter().any(|byte| *byte != 0)
        || bytes[158..160].iter().any(|byte| *byte != 0)
        || bytes[168..PACKED_GRID_HEADER_BYTES]
            .iter()
            .any(|byte| *byte != 0)
    {
        return Err(invalid_manifest("reserved header bytes are non-zero"));
    }
    let ranges = [88, 96, 104, 112, 160]
        .map(|offset| read_utf8_range(bytes, offset, descriptor_offset))
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    let source_kind = ranges[0].0.clone();
    let domain = ranges[1].0.clone();
    let product = ranges[2].0.clone();
    let provider = ranges[3].0.clone();
    let object_key = ranges[4].0.clone();
    if source_kind != "national_mrms"
        || domain != MRMS_DOMAIN
        || product != MRMS_PRODUCT
        || provider != MRMS_HOST
        || MrmsObject::parse_key(&object_key).ok() != Some(observation_time_unix_ms)
    {
        return Err(invalid_manifest("source identity is unsupported"));
    }
    let mut sorted_ranges: Vec<(usize, usize)> = ranges
        .iter()
        .map(|(_, start, end)| (*start, *end))
        .collect();
    sorted_ranges.sort_unstable();
    let mut string_cursor = PACKED_GRID_HEADER_BYTES;
    for (start, end) in sorted_ranges {
        if start != string_cursor {
            return Err(invalid_manifest("string ranges overlap or contain gaps"));
        }
        string_cursor = end;
    }
    if string_cursor != descriptor_offset {
        return Err(invalid_manifest(
            "string section does not end at descriptors",
        ));
    }
    let mut chunks = Vec::with_capacity(count);
    for index in 0..count {
        let base = descriptor_offset + index * descriptor_size;
        let descriptor = PackedGridChunkDescriptor {
            index: get_u32(bytes, base)?,
            chunk_x: get_u16(bytes, base + 4)?,
            chunk_y: get_u16(bytes, base + 6)?,
            interior_x: get_u32(bytes, base + 8)?,
            interior_y: get_u32(bytes, base + 12)?,
            interior_width: get_u16(bytes, base + 16)?,
            interior_height: get_u16(bytes, base + 18)?,
            halo_x: get_u32(bytes, base + 20)?,
            halo_y: get_u32(bytes, base + 24)?,
            halo_width: get_u16(bytes, base + 28)?,
            halo_height: get_u16(bytes, base + 30)?,
            encoded_length: get_u32(bytes, base + 32)?,
            payload_sha256: hex_sha256(
                bytes[base + 36..base + 68]
                    .try_into()
                    .expect("bounded descriptor hash"),
            ),
        };
        if bytes[base + 68..base + PACKED_GRID_DESCRIPTOR_BYTES]
            .iter()
            .any(|byte| *byte != 0)
        {
            return Err(invalid_manifest(
                "chunk descriptor reserved bytes are non-zero",
            ));
        }
        validate_chunk_descriptor(&descriptor, index, width, height).map_err(invalid_manifest)?;
        chunks.push(descriptor);
    }
    let content_sha256 = hex_sha256(bytes[120..152].try_into().expect("bounded content hash"));
    let orientation = match bytes[64] {
        ORIENTATION_NORTH_TO_SOUTH => "north_to_south",
        _ => return Err(invalid_manifest("unknown row orientation")),
    };
    Ok(PackedGridManifestSummary {
        version: PACKED_GRID_VERSION,
        generation,
        source_kind,
        domain,
        product,
        provider,
        object_key,
        observation_time_unix_ms,
        content_sha256,
        width,
        height,
        first_latitude_degrees: f64::from(get_i32(bytes, 40)?) / 1_000_000.0,
        first_longitude_degrees: f64::from(get_i32(bytes, 44)?) / 1_000_000.0,
        last_latitude_degrees: f64::from(get_i32(bytes, 48)?) / 1_000_000.0,
        last_longitude_degrees: f64::from(get_i32(bytes, 52)?) / 1_000_000.0,
        longitude_step_degrees: f64::from(get_u32(bytes, 56)?) / 1_000_000.0,
        latitude_step_degrees: f64::from(get_u32(bytes, 60)?) / 1_000_000.0,
        row_orientation: orientation.into(),
        bit_depth: bytes[65],
        reference_value: f32::from_bits(get_u32(bytes, 68)?),
        binary_scale: get_i16(bytes, 72)?,
        decimal_scale: get_i16(bytes, 74)?,
        missing_raw: get_u16(bytes, 76)?,
        no_coverage_raw: get_u16(bytes, 78)?,
        presentation_factor,
        chunk_interior_size: get_u16(bytes, 82)?,
        chunks,
    })
}

pub fn validate_packed_grid_chunk(bytes: &[u8]) -> Result<PackedGridChunkSummary, PackedGridError> {
    if bytes.len() < PACKED_GRID_HEADER_BYTES || bytes.len() > PACKED_GRID_CHUNK_LIMIT {
        return Err(invalid_chunk("length is outside the chunk bound"));
    }
    let generation = get_u64(bytes, 16)?;
    let observation_time_unix_ms = get_i64(bytes, 24)?;
    let width = get_u32(bytes, 68)?;
    let height = get_u32(bytes, 72)?;
    let presentation_factor = get_u16(bytes, 76)?;
    if &bytes[..4] != PACKED_GRID_CHUNK_MAGIC
        || get_u16(bytes, 4)? != PACKED_GRID_VERSION
        || get_u16(bytes, 6)? != RECORD_CHUNK
        || get_u32(bytes, 8)? as usize != PACKED_GRID_HEADER_BYTES
        || get_u32(bytes, 12)? as usize != bytes.len()
        || bytes[64] != SOURCE_NATIONAL_MRMS
        || bytes[65] != DOMAIN_CONUS
        || bytes[66] != PRODUCT_MERGED_BASE_REFLECTIVITY_QC
        || bytes[67] != ORIENTATION_NORTH_TO_SOUTH
    {
        return Err(invalid_chunk("identity header is invalid"));
    }
    if generation == 0
        || observation_time_unix_ms <= 0
        || presentation_factor == 0
        || presentation_factor > 16
        || !presentation_factor.is_power_of_two()
        || width != MRMS_WIDTH.div_ceil(u32::from(presentation_factor))
        || height != MRMS_HEIGHT.div_ceil(u32::from(presentation_factor))
        || get_u16(bytes, 78)? != PACKED_GRID_CHUNK_INTERIOR as u16
    {
        return Err(invalid_chunk("grid identity is invalid"));
    }
    if bytes[112] != MRMS_BIT_DEPTH
        || get_u32(bytes, 116)? != MRMS_REFERENCE_VALUE.to_bits()
        || get_i16(bytes, 120)? != MRMS_BINARY_SCALE
        || get_i16(bytes, 122)? != MRMS_DECIMAL_SCALE
        || get_u16(bytes, 124)? != MRMS_MISSING_RAW
        || get_u16(bytes, 126)? != MRMS_NO_COVERAGE_RAW
        || bytes[113..116].iter().any(|byte| *byte != 0)
        || bytes[168..PACKED_GRID_HEADER_BYTES]
            .iter()
            .any(|byte| *byte != 0)
    {
        return Err(invalid_chunk("value encoding or reserved bytes changed"));
    }
    let payload_offset = get_u32(bytes, 128)? as usize;
    let payload_length = get_u32(bytes, 132)? as usize;
    if payload_offset != PACKED_GRID_HEADER_BYTES
        || payload_offset.checked_add(payload_length) != Some(bytes.len())
        || payload_length % 2 != 0
    {
        return Err(invalid_chunk("payload bounds are invalid"));
    }
    let halo_width = get_u16(bytes, 108)?;
    let halo_height = get_u16(bytes, 110)?;
    if usize::from(halo_width)
        .checked_mul(usize::from(halo_height))
        .and_then(|count| count.checked_mul(2))
        != Some(payload_length)
    {
        return Err(invalid_chunk(
            "payload length does not match halo dimensions",
        ));
    }
    let payload_hash: [u8; 32] = Sha256::digest(&bytes[payload_offset..]).into();
    if bytes[136..168] != payload_hash {
        return Err(invalid_chunk("payload SHA-256 does not match"));
    }
    let descriptor = PackedGridChunkDescriptor {
        index: get_u32(bytes, 80)?,
        chunk_x: get_u16(bytes, 84)?,
        chunk_y: get_u16(bytes, 86)?,
        interior_x: get_u32(bytes, 88)?,
        interior_y: get_u32(bytes, 92)?,
        interior_width: get_u16(bytes, 96)?,
        interior_height: get_u16(bytes, 98)?,
        halo_x: get_u32(bytes, 100)?,
        halo_y: get_u32(bytes, 104)?,
        halo_width,
        halo_height,
        encoded_length: bytes.len() as u32,
        payload_sha256: hex_sha256(&payload_hash),
    };
    validate_chunk_descriptor(&descriptor, descriptor.index as usize, width, height)
        .map_err(invalid_chunk)?;
    Ok(PackedGridChunkSummary {
        version: PACKED_GRID_VERSION,
        generation,
        observation_time_unix_ms,
        content_sha256: hex_sha256(bytes[32..64].try_into().expect("bounded content hash")),
        presentation_factor,
        level_width: width,
        level_height: height,
        chunk: descriptor,
        bit_depth: bytes[112],
        reference_value_bits: get_u32(bytes, 116)?,
        binary_scale: get_i16(bytes, 120)?,
        decimal_scale: get_i16(bytes, 122)?,
        missing_raw: get_u16(bytes, 124)?,
        no_coverage_raw: get_u16(bytes, 126)?,
    })
}

fn orientation_code(orientation: MrmsRowOrientation) -> u8 {
    match orientation {
        MrmsRowOrientation::NorthToSouth => ORIENTATION_NORTH_TO_SOUTH,
    }
}

fn degrees_e6(value: f64) -> Result<i32, PackedGridError> {
    let scaled = (value * 1_000_000.0).round();
    if scaled < f64::from(i32::MIN) || scaled > f64::from(i32::MAX) {
        return Err(PackedGridError::Bounds(
            "coordinate exceeds i32 microdegrees".into(),
        ));
    }
    Ok(scaled as i32)
}

fn degrees_u32_e6(value: f64) -> Result<u32, PackedGridError> {
    let scaled = (value * 1_000_000.0).round();
    if scaled < 0.0 || scaled > f64::from(u32::MAX) {
        return Err(PackedGridError::Bounds(
            "spacing exceeds u32 microdegrees".into(),
        ));
    }
    Ok(scaled as u32)
}

fn regular_grid_last_e6(first: i32, step: u32, samples: u32, increasing: bool) -> Option<i32> {
    let intervals = samples.checked_sub(1)?;
    let delta = i64::from(step).checked_mul(i64::from(intervals))?;
    let last = if increasing {
        i64::from(first).checked_add(delta)?
    } else {
        i64::from(first).checked_sub(delta)?
    };
    i32::try_from(last).ok()
}

fn presentation_first_e6(
    base_first: i32,
    base_step: u32,
    factor: u16,
    increasing: bool,
) -> Option<i32> {
    let footprint_intervals = u32::from(factor).checked_sub(1)?;
    let footprint_span = base_step.checked_mul(footprint_intervals)?;
    if footprint_span % 2 != 0 {
        return None;
    }
    let offset = i32::try_from(footprint_span / 2).ok()?;
    if increasing {
        base_first.checked_add(offset)
    } else {
        base_first.checked_sub(offset)
    }
}

fn append(bytes: &mut [u8], cursor: &mut usize, value: &[u8]) -> Result<usize, PackedGridError> {
    let start = *cursor;
    let end = start
        .checked_add(value.len())
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| PackedGridError::Bounds("manifest string crossed allocation".into()))?;
    bytes[start..end].copy_from_slice(value);
    *cursor = end;
    Ok(start)
}

fn put_range(
    bytes: &mut [u8],
    offset: usize,
    start: usize,
    length: usize,
) -> Result<(), PackedGridError> {
    put_u32(
        bytes,
        offset,
        u32::try_from(start)
            .map_err(|_| PackedGridError::Bounds("range offset exceeds u32".into()))?,
    );
    put_u32(
        bytes,
        offset + 4,
        u32::try_from(length)
            .map_err(|_| PackedGridError::Bounds("range length exceeds u32".into()))?,
    );
    Ok(())
}

fn validate_chunk_descriptor(
    descriptor: &PackedGridChunkDescriptor,
    expected_index: usize,
    width: u32,
    height: u32,
) -> Result<(), &'static str> {
    let chunks_x = (width as usize).div_ceil(PACKED_GRID_CHUNK_INTERIOR);
    let chunk_x = expected_index % chunks_x;
    let chunk_y = expected_index / chunks_x;
    let interior_x = chunk_x * PACKED_GRID_CHUNK_INTERIOR;
    let interior_y = chunk_y * PACKED_GRID_CHUNK_INTERIOR;
    if interior_x >= width as usize || interior_y >= height as usize {
        return Err("chunk index is outside the presentation grid");
    }
    let interior_width = PACKED_GRID_CHUNK_INTERIOR.min(width as usize - interior_x);
    let interior_height = PACKED_GRID_CHUNK_INTERIOR.min(height as usize - interior_y);
    let halo_x = interior_x.saturating_sub(PACKED_GRID_CHUNK_HALO);
    let halo_y = interior_y.saturating_sub(PACKED_GRID_CHUNK_HALO);
    let halo_width =
        (interior_x + interior_width + PACKED_GRID_CHUNK_HALO).min(width as usize) - halo_x;
    let halo_height =
        (interior_y + interior_height + PACKED_GRID_CHUNK_HALO).min(height as usize) - halo_y;
    let encoded_length = PACKED_GRID_HEADER_BYTES + halo_width * halo_height * 2;
    if descriptor.index as usize != expected_index
        || descriptor.chunk_x as usize != chunk_x
        || descriptor.chunk_y as usize != chunk_y
        || descriptor.interior_x as usize != interior_x
        || descriptor.interior_y as usize != interior_y
        || descriptor.interior_width as usize != interior_width
        || descriptor.interior_height as usize != interior_height
        || descriptor.halo_x as usize != halo_x
        || descriptor.halo_y as usize != halo_y
        || descriptor.halo_width as usize != halo_width
        || descriptor.halo_height as usize != halo_height
        || descriptor.encoded_length as usize != encoded_length
        || encoded_length > PACKED_GRID_CHUNK_LIMIT
    {
        return Err("chunk descriptor geometry is invalid");
    }
    Ok(())
}

fn read_utf8_range(
    bytes: &[u8],
    offset: usize,
    limit: usize,
) -> Result<(String, usize, usize), PackedGridError> {
    let start = get_u32(bytes, offset)? as usize;
    let length = get_u32(bytes, offset + 4)? as usize;
    if length == 0 || length > 256 || start < PACKED_GRID_HEADER_BYTES {
        return Err(invalid_manifest("string range is outside its bound"));
    }
    let end = start
        .checked_add(length)
        .filter(|end| *end <= limit)
        .ok_or_else(|| invalid_manifest("string range crosses manifest"))?;
    let value = std::str::from_utf8(&bytes[start..end])
        .map(str::to_owned)
        .map_err(|_| invalid_manifest("manifest string is not UTF-8"))?;
    Ok((value, start, end))
}

fn parse_sha256(value: &str) -> Result<[u8; 32], PackedGridError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(PackedGridError::Bounds(
            "SHA-256 must be 64 hexadecimal digits".into(),
        ));
    }
    let mut output = [0u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        output[index] = (hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?;
    }
    Ok(output)
}

fn hex_nibble(value: u8) -> Result<u8, PackedGridError> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err(PackedGridError::Bounds("invalid hexadecimal digit".into())),
    }
}

fn hex_sha256(value: &[u8; 32]) -> String {
    let mut output = String::with_capacity(64);
    for byte in value {
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
}

fn put_i16(bytes: &mut [u8], offset: usize, value: i16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
}

fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

fn put_i32(bytes: &mut [u8], offset: usize, value: i32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_be_bytes());
}

fn put_i64(bytes: &mut [u8], offset: usize, value: i64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_be_bytes());
}

fn get_u16(bytes: &[u8], offset: usize) -> Result<u16, PackedGridError> {
    let value = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| PackedGridError::Bounds("u16 crosses wire bounds".into()))?;
    Ok(u16::from_be_bytes([value[0], value[1]]))
}

fn get_i16(bytes: &[u8], offset: usize) -> Result<i16, PackedGridError> {
    Ok(get_u16(bytes, offset)? as i16)
}

fn get_u32(bytes: &[u8], offset: usize) -> Result<u32, PackedGridError> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| PackedGridError::Bounds("u32 crosses wire bounds".into()))?;
    Ok(u32::from_be_bytes([value[0], value[1], value[2], value[3]]))
}

fn get_i32(bytes: &[u8], offset: usize) -> Result<i32, PackedGridError> {
    Ok(get_u32(bytes, offset)? as i32)
}

fn get_u64(bytes: &[u8], offset: usize) -> Result<u64, PackedGridError> {
    let value = bytes
        .get(offset..offset + 8)
        .ok_or_else(|| PackedGridError::Bounds("u64 crosses wire bounds".into()))?;
    Ok(u64::from_be_bytes(value.try_into().expect("bounded u64")))
}

fn get_i64(bytes: &[u8], offset: usize) -> Result<i64, PackedGridError> {
    Ok(get_u64(bytes, offset)? as i64)
}

fn invalid_manifest(message: impl Into<String>) -> PackedGridError {
    PackedGridError::InvalidManifest(message.into())
}

fn invalid_chunk(message: impl Into<String>) -> PackedGridError {
    PackedGridError::InvalidChunk(message.into())
}

impl From<MrmsError> for PackedGridError {
    fn from(error: MrmsError) -> Self {
        Self::Overview(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_pyramid() -> MrmsNumericPyramid {
        let object_key = "CONUS/MergedBaseReflectivityQC_00.50/20260803/MRMS_MergedBaseReflectivityQC_00.50_20260803-162812.grib2.gz".to_string();
        let mut raw_codes = vec![0; 1_750 * 875];
        raw_codes[..6].copy_from_slice(&[0, 9_000, 9_991, 10_000, 10_100, 65_535]);
        let level = NumericGridLevel {
            factor: 4,
            width: 1_750,
            height: 875,
            raw_codes,
        };
        MrmsNumericPyramid {
            observation_time_unix_ms: MrmsObject::parse_key(&object_key).unwrap(),
            object_key,
            content_sha256: [0x18; 32],
            grid: MrmsGridDefinition {
                width: 7_000,
                height: 3_500,
                first_latitude_degrees: 54.995,
                first_longitude_degrees: -129.995,
                last_latitude_degrees: 20.005001,
                last_longitude_degrees: -60.005002,
                longitude_step_degrees: 0.01,
                latitude_step_degrees: 0.01,
                row_orientation: MrmsRowOrientation::NorthToSouth,
            },
            encoding: MrmsValueEncoding {
                bit_depth: 16,
                reference_value_bits: (-9_990.0f32).to_bits(),
                binary_scale: 0,
                decimal_scale: 1,
                missing_raw: 9_000,
                no_coverage_raw: 0,
            },
            levels: BTreeMap::from([(4, level)]),
        }
    }

    #[test]
    fn packed_grid_v1_round_trips_manifest_and_chunk_identity() {
        let frame = PackedGridFrame::encode(7, &test_pyramid(), 4).unwrap();
        assert_eq!(frame.summary.version, 1);
        assert_eq!(frame.summary.source_kind, "national_mrms");
        assert_eq!(frame.summary.chunks.len(), 28);
        assert_eq!(frame.summary.first_latitude_degrees, 54.98);
        assert_eq!(frame.summary.first_longitude_degrees, -129.98);
        assert_eq!(frame.summary.last_latitude_degrees, 20.02);
        assert_eq!(frame.summary.last_longitude_degrees, -60.02);
        assert_eq!(frame.summary.latitude_step_degrees, 0.04);
        assert_eq!(frame.summary.longitude_step_degrees, 0.04);
        let chunk = validate_packed_grid_chunk(&frame.chunks[0]).unwrap();
        assert_eq!(chunk.generation, 7);
        assert_eq!(chunk.chunk, frame.summary.chunks[0]);
    }

    #[test]
    fn chunk_payload_corruption_fails_integrity_validation() {
        let mut frame = PackedGridFrame::encode(7, &test_pyramid(), 4).unwrap();
        let chunk = &mut frame.chunks[0];
        let last = chunk.len() - 1;
        chunk[last] ^= 1;
        assert!(matches!(
            validate_packed_grid_chunk(chunk),
            Err(PackedGridError::InvalidChunk(_))
        ));
    }

    #[test]
    fn manifest_length_and_descriptor_bounds_fail_closed() {
        let mut frame = PackedGridFrame::encode(7, &test_pyramid(), 4).unwrap();
        frame.manifest[12..16].copy_from_slice(&1u32.to_be_bytes());
        assert!(validate_packed_grid_manifest(&frame.manifest).is_err());
    }

    #[test]
    fn manifest_and_chunk_reject_encoding_geometry_and_reserved_drift() {
        let frame = PackedGridFrame::encode(7, &test_pyramid(), 4).unwrap();
        for offset in [32usize, 65, 82, 168] {
            let mut malformed = frame.manifest.clone();
            malformed[offset] ^= 1;
            assert!(
                validate_packed_grid_manifest(&malformed).is_err(),
                "manifest mutation at {offset} was accepted"
            );
        }
        let descriptor_offset = get_u32(&frame.manifest, 152).unwrap() as usize;
        let mut bad_geometry = frame.manifest.clone();
        bad_geometry[descriptor_offset + 8] ^= 1;
        assert!(validate_packed_grid_manifest(&bad_geometry).is_err());

        let mut duplicate_geometry = frame.manifest.clone();
        duplicate_geometry.copy_within(
            descriptor_offset..descriptor_offset + PACKED_GRID_DESCRIPTOR_BYTES,
            descriptor_offset + PACKED_GRID_DESCRIPTOR_BYTES,
        );
        put_u32(
            &mut duplicate_geometry,
            descriptor_offset + PACKED_GRID_DESCRIPTOR_BYTES,
            1,
        );
        assert!(validate_packed_grid_manifest(&duplicate_geometry).is_err());

        for offset in [68usize, 78, 112, 168] {
            let mut malformed = frame.chunks[0].clone();
            malformed[offset] ^= 1;
            assert!(
                validate_packed_grid_chunk(&malformed).is_err(),
                "chunk mutation at {offset} was accepted"
            );
        }
    }

    #[test]
    fn chunk_halos_overlap_without_changing_interiors() {
        let level = NumericGridLevel {
            factor: 1,
            width: 300,
            height: 2,
            raw_codes: (0..600).map(|value| value as u16).collect(),
        };
        let chunks = chunk_level(&level).unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!((chunks[0].interior_x, chunks[0].interior_width), (0, 256));
        assert_eq!((chunks[1].interior_x, chunks[1].interior_width), (256, 44));
        assert_eq!((chunks[0].halo_x, chunks[0].halo_width), (0, 257));
        assert_eq!((chunks[1].halo_x, chunks[1].halo_width), (255, 45));
    }
}
