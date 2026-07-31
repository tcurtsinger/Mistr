//! Versioned binary boundary between Rust normalization and the WebView.
//!
//! The byte-level contract is documented in `docs/14_PACKED_SWEEP_V1.md`.

use crate::radar::{
    GateStatus, NORMALIZED_SWEEP_SCHEMA_VERSION, NormalizedSweep, RadarProduct, RadarSite,
    RadialMetadata,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const PACKED_SWEEP_MAGIC: &[u8; 8] = b"MSTRSWP1";
pub const PACKED_SWEEP_VERSION: u16 = 1;
pub const PACKED_SWEEP_HEADER_BYTES: usize = 320;
pub const PACKED_SWEEP_MAX_BYTES: usize = 32 * 1024 * 1024;
pub const PACKED_SWEEP_TARGET_BYTES: usize = 16 * 1024 * 1024;
pub const PACKED_SWEEP_RADIAL_BYTES: usize = 24;

const ENDIAN_MARKER: u32 = 0x0102_0304;
const FLAG_RAW_U8: u32 = 1;
const FLAG_RAW_U16: u32 = 2;
const STATUS_ENCODING_V1: u8 = 1;
const VALUE_ENCODING_F32: u8 = 1;
const PRODUCT_REFLECTIVITY: u16 = 1;
const PRODUCT_BASE_VELOCITY: u16 = 2;
const SOURCE_LEVEL2_ARCHIVE_II: u16 = 1;
const SOURCE_PHASE2_SYNTHETIC: u16 = 2;

const OFFSET_WIRE_SHA256: usize = 208;
const END_WIRE_SHA256: usize = 240;
const OFFSET_RADIAL_SECTION: usize = 240;
const OFFSET_VALUE_SECTION: usize = 248;
const OFFSET_STATUS_SECTION: usize = 256;
const OFFSET_RAW_SECTION: usize = 264;

const MAX_RADIALS: usize = 2_048;
const MAX_GATES: usize = 4_096;
const MAX_CELLS: usize = 4_194_304;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackedSweepIdentity {
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedSweepSummary {
    pub schema_version: u16,
    pub generation: u64,
    pub observation_id: String,
    pub site_icao: String,
    pub product: &'static str,
    pub source_kind: &'static str,
    pub radial_count: usize,
    pub gate_count: usize,
    pub cell_count: usize,
    pub data_word_size_bits: u8,
    pub total_bytes: usize,
    pub normalized_sha256: String,
    pub wire_sha256: String,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum PackedSweepError {
    #[error("wire input is shorter than the {PACKED_SWEEP_HEADER_BYTES}-byte v1 header")]
    TruncatedHeader,
    #[error("wire payload is {actual} bytes; hard limit is {limit} bytes")]
    PayloadTooLarge { actual: usize, limit: usize },
    #[error("wire magic is invalid")]
    InvalidMagic,
    #[error("wire byte-order marker is invalid")]
    InvalidEndianMarker,
    #[error("wire schema version {0} is unsupported")]
    UnsupportedVersion(u16),
    #[error("wire header length {0} is invalid")]
    InvalidHeaderLength(u16),
    #[error("wire total length declares {declared} bytes but buffer has {actual}")]
    TotalLengthMismatch { declared: usize, actual: usize },
    #[error("wire flags 0x{0:08x} are invalid")]
    InvalidFlags(u32),
    #[error("wire product code {0} is invalid")]
    InvalidProduct(u16),
    #[error("wire source-kind code {0} is invalid")]
    InvalidSourceKind(u16),
    #[error("wire encoding codes are incompatible with word size")]
    InvalidEncoding,
    #[error("wire contains nonzero reserved or padding bytes")]
    NonzeroReserved,
    #[error("wire site ICAO is invalid")]
    InvalidSite,
    #[error("wire dimensions are invalid: {0}")]
    InvalidDimensions(&'static str),
    #[error("wire geometry or timestamps are invalid: {0}")]
    InvalidMetadata(&'static str),
    #[error("wire section {section} is invalid: {reason}")]
    InvalidSection {
        section: &'static str,
        reason: &'static str,
    },
    #[error("wire observation ID does not match normalized SHA-256")]
    ObservationIdMismatch,
    #[error("wire SHA-256 mismatch")]
    HashMismatch,
    #[error("wire radial {index} is invalid: {reason}")]
    InvalidRadial { index: usize, reason: &'static str },
    #[error("wire gate {index} is invalid: {reason}")]
    InvalidGate { index: usize, reason: &'static str },
    #[error("normalized sweep cannot be encoded: {0}")]
    InvalidSweep(&'static str),
    #[error("normalized sweep hash is not a 32-byte lowercase hexadecimal SHA-256")]
    InvalidNormalizedHash,
    #[error("source hash is not a 32-byte lowercase hexadecimal SHA-256")]
    InvalidSourceHash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Section {
    offset: usize,
    length: usize,
}

impl Section {
    fn end(self) -> Result<usize, PackedSweepError> {
        self.offset
            .checked_add(self.length)
            .ok_or(PackedSweepError::InvalidSection {
                section: "unknown",
                reason: "offset overflow",
            })
    }
}

/// Encode one normalized sweep into the strict `PackedSweep v1` layout.
pub fn encode_packed_sweep(
    sweep: &NormalizedSweep,
    identity: PackedSweepIdentity,
) -> Result<Vec<u8>, PackedSweepError> {
    validate_normalized_sweep(sweep)?;

    let radial_count = sweep.radial_count();
    let cell_count = sweep.cell_count();
    let raw_width = match sweep.data_word_size_bits {
        8 => 1usize,
        16 => 2usize,
        _ => return Err(PackedSweepError::InvalidSweep("word size must be 8 or 16")),
    };

    let radial_length = checked_mul(radial_count, PACKED_SWEEP_RADIAL_BYTES)?;
    let value_length = checked_mul(cell_count, size_of::<f32>())?;
    let status_length = cell_count;
    let raw_length = checked_mul(cell_count, raw_width)?;

    let radial = Section {
        offset: PACKED_SWEEP_HEADER_BYTES,
        length: radial_length,
    };
    let values = next_section(radial, value_length)?;
    let statuses = next_section(values, status_length)?;
    let raw = next_section(statuses, raw_length)?;
    let total_length = align8(raw.end()?)?;
    if total_length > PACKED_SWEEP_MAX_BYTES {
        return Err(PackedSweepError::PayloadTooLarge {
            actual: total_length,
            limit: PACKED_SWEEP_MAX_BYTES,
        });
    }

    let source_sha =
        decode_sha256(&sweep.source_sha256).map_err(|_| PackedSweepError::InvalidSourceHash)?;
    let normalized_sha_string = sweep.normalized_sha256();
    let normalized_sha = decode_sha256(&normalized_sha_string)
        .map_err(|_| PackedSweepError::InvalidNormalizedHash)?;

    let product = product_code(sweep.product);
    let source_kind = source_kind_code(sweep.source_kind)?;
    let flags = if raw_width == 1 {
        FLAG_RAW_U8
    } else {
        FLAG_RAW_U16
    };

    let mut bytes = vec![0u8; total_length];
    bytes[0..8].copy_from_slice(PACKED_SWEEP_MAGIC);
    put_u32(&mut bytes, 8, ENDIAN_MARKER);
    put_u16(&mut bytes, 12, PACKED_SWEEP_VERSION);
    put_u16(&mut bytes, 14, PACKED_SWEEP_HEADER_BYTES as u16);
    put_u32(&mut bytes, 16, as_u32(total_length)?);
    put_u32(&mut bytes, 20, flags);
    put_u16(&mut bytes, 24, product);
    put_u16(&mut bytes, 26, source_kind);
    put_u64(&mut bytes, 32, identity.generation);
    bytes[40..56].copy_from_slice(&normalized_sha[..16]);
    bytes[56..60].copy_from_slice(sweep.site.icao.as_bytes());
    bytes[60] = sweep.elevation_number;
    bytes[61] = sweep.data_word_size_bits;
    bytes[62] = STATUS_ENCODING_V1;
    bytes[63] = VALUE_ENCODING_F32;
    put_u16(&mut bytes, 64, sweep.vcp);
    put_u32(&mut bytes, 68, as_u32(radial_count)?);
    put_u32(&mut bytes, 72, as_u32(sweep.gate_count)?);
    put_u32(&mut bytes, 76, as_u32(cell_count)?);
    put_u32(&mut bytes, 80, sweep.gate_spacing_m);
    put_u32(&mut bytes, 84, sweep.first_gate_center_m);
    put_f32(&mut bytes, 88, sweep.site.latitude_degrees);
    put_f32(&mut bytes, 92, sweep.site.longitude_degrees);
    put_i16(&mut bytes, 96, sweep.site.site_altitude_m);
    put_u16(&mut bytes, 98, sweep.site.tower_height_m);
    put_f32(&mut bytes, 100, sweep.elevation_degrees);
    put_f32(&mut bytes, 104, sweep.scale);
    put_f32(&mut bytes, 108, sweep.offset);
    put_i64(&mut bytes, 112, sweep.volume_started_at_unix_ms);
    put_i64(&mut bytes, 120, sweep.volume_ended_at_unix_ms);
    put_i64(&mut bytes, 128, sweep.sweep_started_at_unix_ms);
    put_i64(&mut bytes, 136, sweep.sweep_ended_at_unix_ms);
    bytes[144..176].copy_from_slice(&source_sha);
    bytes[176..208].copy_from_slice(&normalized_sha);
    put_section(&mut bytes, OFFSET_RADIAL_SECTION, radial)?;
    put_section(&mut bytes, OFFSET_VALUE_SECTION, values)?;
    put_section(&mut bytes, OFFSET_STATUS_SECTION, statuses)?;
    put_section(&mut bytes, OFFSET_RAW_SECTION, raw)?;

    for (index, radial_metadata) in sweep.radials.iter().enumerate() {
        let offset = radial.offset + index * PACKED_SWEEP_RADIAL_BYTES;
        put_u16(&mut bytes, offset, radial_metadata.source_azimuth_number);
        put_f32(&mut bytes, offset + 4, radial_metadata.azimuth_degrees);
        put_f32(&mut bytes, offset + 8, radial_metadata.beam_width_degrees);
        put_f32(&mut bytes, offset + 12, radial_metadata.elevation_degrees);
        put_i64(
            &mut bytes,
            offset + 16,
            radial_metadata.collected_at_unix_ms,
        );
    }
    for (index, value) in sweep.values.iter().enumerate() {
        put_f32(&mut bytes, values.offset + index * 4, *value);
    }
    for (index, status) in sweep.statuses.iter().enumerate() {
        bytes[statuses.offset + index] = status_code(*status);
    }
    for (index, raw_code) in sweep.raw_codes.iter().enumerate() {
        if raw_width == 1 {
            bytes[raw.offset + index] = u8::try_from(*raw_code)
                .map_err(|_| PackedSweepError::InvalidSweep("8-bit raw code exceeds 255"))?;
        } else {
            put_u16(&mut bytes, raw.offset + index * 2, *raw_code);
        }
    }

    let wire_sha = calculate_wire_sha256(&bytes);
    bytes[OFFSET_WIRE_SHA256..END_WIRE_SHA256].copy_from_slice(&wire_sha);
    validate_packed_sweep(&bytes)?;
    Ok(bytes)
}

/// Validate a `PackedSweep v1` buffer without allocating gate arrays.
pub fn validate_packed_sweep(bytes: &[u8]) -> Result<PackedSweepSummary, PackedSweepError> {
    if bytes.len() < PACKED_SWEEP_HEADER_BYTES {
        return Err(PackedSweepError::TruncatedHeader);
    }
    if bytes.len() > PACKED_SWEEP_MAX_BYTES {
        return Err(PackedSweepError::PayloadTooLarge {
            actual: bytes.len(),
            limit: PACKED_SWEEP_MAX_BYTES,
        });
    }
    if &bytes[0..8] != PACKED_SWEEP_MAGIC {
        return Err(PackedSweepError::InvalidMagic);
    }
    if get_u32(bytes, 8) != ENDIAN_MARKER {
        return Err(PackedSweepError::InvalidEndianMarker);
    }
    let version = get_u16(bytes, 12);
    if version != PACKED_SWEEP_VERSION {
        return Err(PackedSweepError::UnsupportedVersion(version));
    }
    let header_length = get_u16(bytes, 14);
    if header_length as usize != PACKED_SWEEP_HEADER_BYTES {
        return Err(PackedSweepError::InvalidHeaderLength(header_length));
    }
    let declared_total = get_u32(bytes, 16) as usize;
    if declared_total != bytes.len() {
        return Err(PackedSweepError::TotalLengthMismatch {
            declared: declared_total,
            actual: bytes.len(),
        });
    }

    let flags = get_u32(bytes, 20);
    if !matches!(flags, FLAG_RAW_U8 | FLAG_RAW_U16) {
        return Err(PackedSweepError::InvalidFlags(flags));
    }
    let product = match get_u16(bytes, 24) {
        PRODUCT_REFLECTIVITY => "reflectivity",
        PRODUCT_BASE_VELOCITY => "base_velocity",
        value => return Err(PackedSweepError::InvalidProduct(value)),
    };
    let source_kind = match get_u16(bytes, 26) {
        SOURCE_LEVEL2_ARCHIVE_II => "nexrad_level2_archive_ii",
        SOURCE_PHASE2_SYNTHETIC => "mistr_phase2_synthetic",
        value => return Err(PackedSweepError::InvalidSourceKind(value)),
    };
    if !all_zero(&bytes[28..32])
        || !all_zero(&bytes[66..68])
        || !all_zero(&bytes[272..PACKED_SWEEP_HEADER_BYTES])
    {
        return Err(PackedSweepError::NonzeroReserved);
    }

    let word_size = bytes[61];
    if bytes[62] != STATUS_ENCODING_V1 || bytes[63] != VALUE_ENCODING_F32 {
        return Err(PackedSweepError::InvalidEncoding);
    }
    let raw_width = match (flags, word_size) {
        (FLAG_RAW_U8, 8) => 1usize,
        (FLAG_RAW_U16, 16) => 2usize,
        _ => return Err(PackedSweepError::InvalidEncoding),
    };
    if !bytes[56..60]
        .iter()
        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return Err(PackedSweepError::InvalidSite);
    }

    let radial_count = get_u32(bytes, 68) as usize;
    let gate_count = get_u32(bytes, 72) as usize;
    let cell_count = get_u32(bytes, 76) as usize;
    if radial_count == 0 || radial_count > MAX_RADIALS {
        return Err(PackedSweepError::InvalidDimensions("radial count"));
    }
    if gate_count == 0 || gate_count > MAX_GATES {
        return Err(PackedSweepError::InvalidDimensions("gate count"));
    }
    let expected_cells = radial_count
        .checked_mul(gate_count)
        .ok_or(PackedSweepError::InvalidDimensions("cell count overflow"))?;
    if expected_cells != cell_count || cell_count > MAX_CELLS {
        return Err(PackedSweepError::InvalidDimensions("cell count"));
    }
    if get_u32(bytes, 80) == 0 {
        return Err(PackedSweepError::InvalidMetadata("gate spacing"));
    }

    let latitude = get_f32(bytes, 88);
    let longitude = get_f32(bytes, 92);
    let elevation = get_f32(bytes, 100);
    let scale = get_f32(bytes, 104);
    let offset = get_f32(bytes, 108);
    if !latitude.is_finite() || !(-90.0..=90.0).contains(&latitude) {
        return Err(PackedSweepError::InvalidMetadata("radar latitude"));
    }
    if !longitude.is_finite() || !(-180.0..=180.0).contains(&longitude) {
        return Err(PackedSweepError::InvalidMetadata("radar longitude"));
    }
    if !elevation.is_finite() || !(0.0..=90.0).contains(&elevation) {
        return Err(PackedSweepError::InvalidMetadata("sweep elevation"));
    }
    if !scale.is_finite() || !offset.is_finite() {
        return Err(PackedSweepError::InvalidMetadata("scale or offset"));
    }
    if get_i64(bytes, 120) < get_i64(bytes, 112) {
        return Err(PackedSweepError::InvalidMetadata("volume time ordering"));
    }
    if get_i64(bytes, 136) < get_i64(bytes, 128) {
        return Err(PackedSweepError::InvalidMetadata("sweep time ordering"));
    }
    if bytes[40..56] != bytes[176..192] {
        return Err(PackedSweepError::ObservationIdMismatch);
    }

    let radial = get_section(bytes, OFFSET_RADIAL_SECTION);
    let values = get_section(bytes, OFFSET_VALUE_SECTION);
    let statuses = get_section(bytes, OFFSET_STATUS_SECTION);
    let raw = get_section(bytes, OFFSET_RAW_SECTION);
    let expected_radial_length = checked_mul(radial_count, PACKED_SWEEP_RADIAL_BYTES)?;
    let expected_value_length = checked_mul(cell_count, 4)?;
    let expected_raw_length = checked_mul(cell_count, raw_width)?;
    validate_section(
        "radials",
        radial,
        PACKED_SWEEP_HEADER_BYTES,
        expected_radial_length,
    )?;
    let expected_values_offset = align8(radial.end()?)?;
    validate_section(
        "values",
        values,
        expected_values_offset,
        expected_value_length,
    )?;
    let expected_statuses_offset = align8(values.end()?)?;
    validate_section("statuses", statuses, expected_statuses_offset, cell_count)?;
    let expected_raw_offset = align8(statuses.end()?)?;
    validate_section("raw", raw, expected_raw_offset, expected_raw_length)?;
    let expected_total = align8(raw.end()?)?;
    if expected_total != bytes.len() {
        return Err(PackedSweepError::InvalidSection {
            section: "raw",
            reason: "canonical total length mismatch",
        });
    }
    ensure_padding_zero(bytes, radial.end()?, values.offset)?;
    ensure_padding_zero(bytes, values.end()?, statuses.offset)?;
    ensure_padding_zero(bytes, statuses.end()?, raw.offset)?;
    ensure_padding_zero(bytes, raw.end()?, bytes.len())?;

    let expected_hash = &bytes[OFFSET_WIRE_SHA256..END_WIRE_SHA256];
    if calculate_wire_sha256(bytes).as_slice() != expected_hash {
        return Err(PackedSweepError::HashMismatch);
    }

    for index in 0..radial_count {
        let base = radial.offset + index * PACKED_SWEEP_RADIAL_BYTES;
        if !all_zero(&bytes[base + 2..base + 4]) {
            return Err(PackedSweepError::InvalidRadial {
                index,
                reason: "reserved bytes",
            });
        }
        let azimuth = get_f32(bytes, base + 4);
        let beam_width = get_f32(bytes, base + 8);
        let radial_elevation = get_f32(bytes, base + 12);
        if !azimuth.is_finite() || !(0.0..360.0).contains(&azimuth) {
            return Err(PackedSweepError::InvalidRadial {
                index,
                reason: "azimuth",
            });
        }
        if !(beam_width.is_finite() && beam_width > 0.0 && beam_width <= 360.0) {
            return Err(PackedSweepError::InvalidRadial {
                index,
                reason: "beam width",
            });
        }
        if !radial_elevation.is_finite() || !(0.0..=90.0).contains(&radial_elevation) {
            return Err(PackedSweepError::InvalidRadial {
                index,
                reason: "elevation",
            });
        }
    }

    for index in 0..cell_count {
        let value = get_f32(bytes, values.offset + index * 4);
        let status = bytes[statuses.offset + index];
        let raw_code = if raw_width == 1 {
            bytes[raw.offset + index] as u16
        } else {
            get_u16(bytes, raw.offset + index * 2)
        };
        validate_gate(index, value, status, raw_code, scale, offset)?;
    }

    Ok(PackedSweepSummary {
        schema_version: version,
        generation: get_u64(bytes, 32),
        observation_id: hex_lower(&bytes[40..56]),
        site_icao: String::from_utf8(bytes[56..60].to_vec())
            .expect("validated ASCII site identifier"),
        product,
        source_kind,
        radial_count,
        gate_count,
        cell_count,
        data_word_size_bits: word_size,
        total_bytes: bytes.len(),
        normalized_sha256: hex_lower(&bytes[176..208]),
        wire_sha256: hex_lower(expected_hash),
    })
}

fn validate_gate(
    index: usize,
    value: f32,
    status: u8,
    raw_code: u16,
    scale: f32,
    offset: f32,
) -> Result<(), PackedSweepError> {
    if !value.is_finite() {
        return Err(PackedSweepError::InvalidGate {
            index,
            reason: "non-finite value",
        });
    }
    let (expected_status, expected_value) = if scale == 0.0 {
        (0, raw_code as f32)
    } else {
        match raw_code {
            0 => (1, 0.0),
            1 => (2, 0.0),
            raw => (0, (raw as f32 - offset) / scale),
        }
    };
    if status != expected_status {
        return Err(PackedSweepError::InvalidGate {
            index,
            reason: "raw/status disagreement",
        });
    }
    if value.to_bits() != expected_value.to_bits() {
        return Err(PackedSweepError::InvalidGate {
            index,
            reason: "raw/value disagreement",
        });
    }
    Ok(())
}

fn validate_normalized_sweep(sweep: &NormalizedSweep) -> Result<(), PackedSweepError> {
    if sweep.schema_version != NORMALIZED_SWEEP_SCHEMA_VERSION {
        return Err(PackedSweepError::InvalidSweep(
            "normalized schema version is unsupported",
        ));
    }
    let radial_count = sweep.radial_count();
    if radial_count == 0 || radial_count > MAX_RADIALS {
        return Err(PackedSweepError::InvalidSweep("radial count"));
    }
    if sweep.gate_count == 0 || sweep.gate_count > MAX_GATES {
        return Err(PackedSweepError::InvalidSweep("gate count"));
    }
    let cell_count = radial_count
        .checked_mul(sweep.gate_count)
        .ok_or(PackedSweepError::InvalidSweep("cell count overflow"))?;
    if cell_count > MAX_CELLS
        || sweep.values.len() != cell_count
        || sweep.statuses.len() != cell_count
        || sweep.raw_codes.len() != cell_count
    {
        return Err(PackedSweepError::InvalidSweep("cell arrays"));
    }
    if sweep.site.icao.len() != 4
        || !sweep
            .site
            .icao
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return Err(PackedSweepError::InvalidSweep("site ICAO"));
    }
    if sweep.gate_spacing_m == 0 {
        return Err(PackedSweepError::InvalidSweep("gate spacing"));
    }
    if !sweep.site.latitude_degrees.is_finite()
        || !(-90.0..=90.0).contains(&sweep.site.latitude_degrees)
        || !sweep.site.longitude_degrees.is_finite()
        || !(-180.0..=180.0).contains(&sweep.site.longitude_degrees)
        || !sweep.elevation_degrees.is_finite()
        || !(0.0..=90.0).contains(&sweep.elevation_degrees)
        || !sweep.scale.is_finite()
        || !sweep.offset.is_finite()
    {
        return Err(PackedSweepError::InvalidSweep("numeric metadata"));
    }
    if sweep.volume_ended_at_unix_ms < sweep.volume_started_at_unix_ms
        || sweep.sweep_ended_at_unix_ms < sweep.sweep_started_at_unix_ms
    {
        return Err(PackedSweepError::InvalidSweep("timestamp ordering"));
    }
    for (index, radial) in sweep.radials.iter().enumerate() {
        if !(radial.azimuth_degrees.is_finite()
            && (0.0..360.0).contains(&radial.azimuth_degrees)
            && radial.beam_width_degrees.is_finite()
            && radial.beam_width_degrees > 0.0
            && radial.beam_width_degrees <= 360.0
            && radial.elevation_degrees.is_finite()
            && (0.0..=90.0).contains(&radial.elevation_degrees))
        {
            return Err(PackedSweepError::InvalidRadial {
                index,
                reason: "normalized geometry",
            });
        }
    }
    for index in 0..cell_count {
        validate_gate(
            index,
            sweep.values[index],
            status_code(sweep.statuses[index]),
            sweep.raw_codes[index],
            sweep.scale,
            sweep.offset,
        )?;
        if sweep.data_word_size_bits == 8 && sweep.raw_codes[index] > u8::MAX as u16 {
            return Err(PackedSweepError::InvalidGate {
                index,
                reason: "8-bit raw code exceeds 255",
            });
        }
    }
    Ok(())
}

fn product_code(product: RadarProduct) -> u16 {
    match product {
        RadarProduct::Reflectivity => PRODUCT_REFLECTIVITY,
        RadarProduct::BaseVelocity => PRODUCT_BASE_VELOCITY,
    }
}

fn source_kind_code(source_kind: &str) -> Result<u16, PackedSweepError> {
    match source_kind {
        "nexrad_level2_archive_ii" => Ok(SOURCE_LEVEL2_ARCHIVE_II),
        "mistr_phase2_synthetic" => Ok(SOURCE_PHASE2_SYNTHETIC),
        _ => Err(PackedSweepError::InvalidSweep("source kind")),
    }
}

fn status_code(status: GateStatus) -> u8 {
    match status {
        GateStatus::Valid => 0,
        GateStatus::BelowThreshold => 1,
        GateStatus::RangeFolded => 2,
    }
}

fn next_section(previous: Section, length: usize) -> Result<Section, PackedSweepError> {
    Ok(Section {
        offset: align8(previous.end()?)?,
        length,
    })
}

fn validate_section(
    name: &'static str,
    section: Section,
    expected_offset: usize,
    expected_length: usize,
) -> Result<(), PackedSweepError> {
    if section.offset % 8 != 0 {
        return Err(PackedSweepError::InvalidSection {
            section: name,
            reason: "unaligned offset",
        });
    }
    if section.offset != expected_offset {
        return Err(PackedSweepError::InvalidSection {
            section: name,
            reason: "noncanonical offset",
        });
    }
    if section.length != expected_length {
        return Err(PackedSweepError::InvalidSection {
            section: name,
            reason: "length mismatch",
        });
    }
    Ok(())
}

fn ensure_padding_zero(bytes: &[u8], start: usize, end: usize) -> Result<(), PackedSweepError> {
    if start > end || end > bytes.len() || !all_zero(&bytes[start..end]) {
        return Err(PackedSweepError::NonzeroReserved);
    }
    Ok(())
}

fn calculate_wire_sha256(bytes: &[u8]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(&bytes[..OFFSET_WIRE_SHA256]);
    hash.update(&bytes[END_WIRE_SHA256..]);
    hash.finalize().into()
}

fn decode_sha256(value: &str) -> Result<[u8; 32], ()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(());
    }
    let mut output = [0u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        output[index] = (hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?;
    }
    Ok(output)
}

fn hex_nibble(value: u8) -> Result<u8, ()> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        _ => Err(()),
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn checked_mul(left: usize, right: usize) -> Result<usize, PackedSweepError> {
    left.checked_mul(right)
        .ok_or(PackedSweepError::InvalidDimensions(
            "section length overflow",
        ))
}

fn align8(value: usize) -> Result<usize, PackedSweepError> {
    value
        .checked_add(7)
        .map(|value| value & !7)
        .ok_or(PackedSweepError::InvalidDimensions("alignment overflow"))
}

fn as_u32(value: usize) -> Result<u32, PackedSweepError> {
    u32::try_from(value).map_err(|_| PackedSweepError::InvalidDimensions("u32 overflow"))
}

fn all_zero(bytes: &[u8]) -> bool {
    bytes.iter().all(|byte| *byte == 0)
}

fn put_section(
    bytes: &mut [u8],
    descriptor_offset: usize,
    section: Section,
) -> Result<(), PackedSweepError> {
    put_u32(bytes, descriptor_offset, as_u32(section.offset)?);
    put_u32(bytes, descriptor_offset + 4, as_u32(section.length)?);
    Ok(())
}

fn get_section(bytes: &[u8], offset: usize) -> Section {
    Section {
        offset: get_u32(bytes, offset) as usize,
        length: get_u32(bytes, offset + 4) as usize,
    }
}

fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_i16(bytes: &mut [u8], offset: usize, value: i16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn put_i64(bytes: &mut [u8], offset: usize, value: i64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn put_f32(bytes: &mut [u8], offset: usize, value: f32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_bits().to_le_bytes());
}

fn get_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(
        bytes[offset..offset + 2]
            .try_into()
            .expect("bounded header"),
    )
}

fn get_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("bounded header"),
    )
}

fn get_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(
        bytes[offset..offset + 8]
            .try_into()
            .expect("bounded header"),
    )
}

fn get_i64(bytes: &[u8], offset: usize) -> i64 {
    i64::from_le_bytes(
        bytes[offset..offset + 8]
            .try_into()
            .expect("bounded header"),
    )
}

fn get_f32(bytes: &[u8], offset: usize) -> f32 {
    f32::from_bits(get_u32(bytes, offset))
}

/// Small deterministic sweep used to produce the committed cross-language vector.
pub fn phase2_golden_sweep() -> NormalizedSweep {
    let source_sha256 = hex_lower(&Sha256::digest(b"mistr-packed-sweep-v1-golden"));
    NormalizedSweep {
        schema_version: NORMALIZED_SWEEP_SCHEMA_VERSION,
        source_kind: "mistr_phase2_synthetic",
        source_sha256,
        site: RadarSite {
            icao: "KTLX".into(),
            latitude_degrees: 35.333_36,
            longitude_degrees: -97.277_76,
            site_altitude_m: 370,
            tower_height_m: 19,
        },
        product: RadarProduct::Reflectivity,
        units: "dBZ",
        volume_started_at_unix_ms: 1_716_246_312_891,
        volume_ended_at_unix_ms: 1_716_246_313_391,
        sweep_started_at_unix_ms: 1_716_246_312_891,
        sweep_ended_at_unix_ms: 1_716_246_313_391,
        elevation_number: 1,
        elevation_degrees: 0.5,
        vcp: 35,
        gate_count: 3,
        gate_spacing_m: 250,
        first_gate_center_m: 2_125,
        data_word_size_bits: 8,
        scale: 2.0,
        offset: 66.0,
        radials: vec![
            RadialMetadata {
                source_azimuth_number: 1,
                azimuth_degrees: 0.25,
                beam_width_degrees: 0.5,
                elevation_degrees: 0.5,
                collected_at_unix_ms: 1_716_246_312_891,
            },
            RadialMetadata {
                source_azimuth_number: 2,
                azimuth_degrees: 0.75,
                beam_width_degrees: 0.5,
                elevation_degrees: 0.5,
                collected_at_unix_ms: 1_716_246_313_391,
            },
        ],
        values: vec![0.0, 0.0, 1.0, -32.0, 10.0, 63.5],
        statuses: vec![
            GateStatus::BelowThreshold,
            GateStatus::RangeFolded,
            GateStatus::Valid,
            GateStatus::Valid,
            GateStatus::Valid,
            GateStatus::Valid,
        ],
        raw_codes: vec![0, 1, 68, 2, 86, 193],
    }
}

/// Full-size deterministic sweep used for packaged Phase 2 IPC measurement.
pub fn phase2_benchmark_sweep() -> NormalizedSweep {
    const RADIAL_COUNT: usize = 720;
    const GATE_COUNT: usize = 1_832;
    let source_sha256 = hex_lower(&Sha256::digest(b"mistr-phase2-720x1832-benchmark"));
    let start = 1_716_246_312_891i64;
    let mut radials = Vec::with_capacity(RADIAL_COUNT);
    for index in 0..RADIAL_COUNT {
        radials.push(RadialMetadata {
            source_azimuth_number: (index + 1) as u16,
            azimuth_degrees: index as f32 * 0.5,
            beam_width_degrees: 0.5,
            elevation_degrees: 0.5,
            collected_at_unix_ms: start + index as i64 * 100,
        });
    }

    let cell_count = RADIAL_COUNT * GATE_COUNT;
    let mut values = Vec::with_capacity(cell_count);
    let mut statuses = Vec::with_capacity(cell_count);
    let mut raw_codes = Vec::with_capacity(cell_count);
    for index in 0..cell_count {
        let raw_code = if index % 251 == 0 {
            1u16
        } else if index % 7 == 0 {
            0u16
        } else {
            2 + ((index * 31) % 254) as u16
        };
        raw_codes.push(raw_code);
        match raw_code {
            0 => {
                values.push(0.0);
                statuses.push(GateStatus::BelowThreshold);
            }
            1 => {
                values.push(0.0);
                statuses.push(GateStatus::RangeFolded);
            }
            raw => {
                values.push((raw as f32 - 66.0) / 2.0);
                statuses.push(GateStatus::Valid);
            }
        }
    }

    NormalizedSweep {
        schema_version: NORMALIZED_SWEEP_SCHEMA_VERSION,
        source_kind: "mistr_phase2_synthetic",
        source_sha256,
        site: RadarSite {
            icao: "KTLX".into(),
            latitude_degrees: 35.333_36,
            longitude_degrees: -97.277_76,
            site_altitude_m: 370,
            tower_height_m: 19,
        },
        product: RadarProduct::Reflectivity,
        units: "dBZ",
        volume_started_at_unix_ms: start,
        volume_ended_at_unix_ms: start + 510_647,
        sweep_started_at_unix_ms: start,
        sweep_ended_at_unix_ms: start + (RADIAL_COUNT as i64 - 1) * 100,
        elevation_number: 1,
        elevation_degrees: 0.5,
        vcp: 35,
        gate_count: GATE_COUNT,
        gate_spacing_m: 250,
        first_gate_center_m: 2_125,
        data_word_size_bits: 8,
        scale: 2.0,
        offset: 66.0,
        radials,
        values,
        statuses,
        raw_codes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded_golden() -> Vec<u8> {
        encode_packed_sweep(
            &phase2_golden_sweep(),
            PackedSweepIdentity { generation: 7 },
        )
        .expect("encode golden sweep")
    }

    #[test]
    fn golden_sweep_round_trips_with_expected_shape() {
        let bytes = encoded_golden();
        let committed = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/expected/phase-2/packed-sweep-v1.bin"
        ));
        assert_eq!(bytes.as_slice(), committed);
        let summary = validate_packed_sweep(&bytes).expect("validate golden sweep");
        assert_eq!(bytes.len(), 408);
        assert_eq!(summary.generation, 7);
        assert_eq!(summary.site_icao, "KTLX");
        assert_eq!(summary.radial_count, 2);
        assert_eq!(summary.gate_count, 3);
        assert_eq!(summary.cell_count, 6);
        assert_eq!(summary.data_word_size_bits, 8);
    }

    #[test]
    fn encoding_is_deterministic() {
        assert_eq!(encoded_golden(), encoded_golden());
    }

    #[test]
    fn hostile_section_offset_is_rejected() {
        let mut bytes = encoded_golden();
        put_u32(&mut bytes, OFFSET_VALUE_SECTION, 321);
        assert!(matches!(
            validate_packed_sweep(&bytes),
            Err(PackedSweepError::InvalidSection {
                section: "values",
                ..
            })
        ));
    }

    #[test]
    fn corrupt_payload_hash_is_rejected() {
        let mut bytes = encoded_golden();
        let last = bytes.len() - 1;
        bytes[last] = 1;
        assert_eq!(
            validate_packed_sweep(&bytes),
            Err(PackedSweepError::NonzeroReserved)
        );

        let mut bytes = encoded_golden();
        bytes[PACKED_SWEEP_HEADER_BYTES + 4] ^= 1;
        assert_eq!(
            validate_packed_sweep(&bytes),
            Err(PackedSweepError::HashMismatch)
        );
    }

    #[test]
    fn invalid_status_is_rejected_even_with_recomputed_hash() {
        let mut bytes = encoded_golden();
        let statuses = get_section(&bytes, OFFSET_STATUS_SECTION);
        bytes[statuses.offset] = 2;
        let hash = calculate_wire_sha256(&bytes);
        bytes[OFFSET_WIRE_SHA256..END_WIRE_SHA256].copy_from_slice(&hash);
        assert!(matches!(
            validate_packed_sweep(&bytes),
            Err(PackedSweepError::InvalidGate {
                reason: "raw/status disagreement",
                ..
            })
        ));
    }

    #[test]
    fn oversized_wire_is_rejected_before_header_access() {
        let bytes = vec![0; PACKED_SWEEP_MAX_BYTES + 1];
        assert!(matches!(
            validate_packed_sweep(&bytes),
            Err(PackedSweepError::PayloadTooLarge { .. })
        ));
    }

    #[test]
    fn representative_payload_stays_inside_target_budget() {
        let bytes = encode_packed_sweep(
            &phase2_benchmark_sweep(),
            PackedSweepIdentity { generation: 1 },
        )
        .expect("encode representative sweep");
        assert!(bytes.len() <= PACKED_SWEEP_TARGET_BYTES);
        let summary = validate_packed_sweep(&bytes).expect("validate representative sweep");
        assert_eq!(summary.radial_count, 720);
        assert_eq!(summary.gate_count, 1_832);
        assert_eq!(summary.cell_count, 1_319_040);
    }

    #[test]
    fn current_ktlx_fixture_encodes_to_the_expected_wire_when_available() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/cache/KTLX20240520_230512_V06");
        if !path.exists() {
            eprintln!(
                "fixture is not downloaded; run `npm run fixture:download` for the Phase 2 integration assertion"
            );
            return;
        }

        let input = std::fs::read(path).expect("read verified public fixture");
        let decoded = crate::radar::decode_level2(&input, RadarProduct::Reflectivity)
            .expect("decode current KTLX fixture");
        let bytes = encode_packed_sweep(&decoded.sweep, PackedSweepIdentity { generation: 1 })
            .expect("encode current KTLX sweep");
        let summary = validate_packed_sweep(&bytes).expect("validate current KTLX wire");

        assert_eq!(bytes.len(), 7_931_840);
        assert_eq!(summary.observation_id, "f3c4ced03212402d921c9880b485db5b");
        assert_eq!(
            summary.normalized_sha256,
            "f3c4ced03212402d921c9880b485db5bd95e5c28a1c752b2cae86a9e7bf27bf6"
        );
        assert_eq!(
            summary.wire_sha256,
            "8d9999eeb5d6a34a985c1c94a33707446bf6e9a959657c217d1ad4e7a219fc78"
        );
    }
}
