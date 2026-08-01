use super::{
    DecodeEvidence, DecodeOutput, GateStatus, NORMALIZED_SWEEP_SCHEMA_VERSION, NormalizedSweep,
    RadarProduct, RadarSite, RadialMetadata,
};
use bzip2::read::BzDecoder;
use chrono::{DateTime, Utc};
use flate2::read::MultiGzDecoder;
use nexrad_data::volume::{File as VolumeFile, Header};
use nexrad_model::data::{DataMoment, MomentData, MomentValue, RadialStatus, Scan, Sweep};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io::{self, Read};
use std::panic::{AssertUnwindSafe, catch_unwind};
use thiserror::Error;

/// Hard cap applied before Archive II bytes enter the decoder.
pub const MAX_LEVEL2_INPUT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DecodeLimits {
    pub max_input_bytes: usize,
    pub max_archive_bytes: usize,
    pub max_record_count: usize,
    pub max_record_bytes: usize,
    pub max_decompressed_record_bytes: u64,
    pub max_total_decompressed_record_bytes: u64,
    pub max_radials: usize,
    pub max_gates_per_radial: usize,
    pub max_cells: usize,
}

impl Default for DecodeLimits {
    fn default() -> Self {
        Self {
            max_input_bytes: MAX_LEVEL2_INPUT_BYTES,
            max_archive_bytes: 256 * 1024 * 1024,
            max_record_count: 8_192,
            max_record_bytes: 16 * 1024 * 1024,
            max_decompressed_record_bytes: 16 * 1024 * 1024,
            max_total_decompressed_record_bytes: 512 * 1024 * 1024,
            max_radials: 2_048,
            max_gates_per_radial: 4_096,
            max_cells: 4_194_304,
        }
    }
}

#[derive(Debug, Error, PartialEq)]
pub enum DecodeError {
    #[error("input is empty")]
    EmptyInput,
    #[error("input is {actual} bytes; limit is {limit} bytes")]
    InputTooLarge { actual: usize, limit: usize },
    #[error("archive is {actual} bytes after outer decompression; limit is {limit} bytes")]
    ArchiveTooLarge { actual: usize, limit: usize },
    #[error("Archive II header is truncated: need at least {required} bytes, got {actual}")]
    TruncatedHeader { required: usize, actual: usize },
    #[error("outer gzip decompression failed: {0}")]
    Gzip(String),
    #[error("unsupported Archive II variant: {0}")]
    UnsupportedArchiveVariant(&'static str),
    #[error("malformed LDM record framing at byte {offset}: {reason}")]
    MalformedRecordFraming { offset: usize, reason: String },
    #[error("LDM record count exceeds limit of {limit}")]
    TooManyRecords { limit: usize },
    #[error("LDM record {index} is {actual} bytes; limit is {limit} bytes")]
    RecordTooLarge {
        index: usize,
        actual: usize,
        limit: usize,
    },
    #[error("LDM record {index} expands beyond {limit} bytes")]
    RecordExpansionTooLarge { index: usize, limit: u64 },
    #[error("all LDM records expand beyond the total {limit}-byte limit")]
    TotalExpansionTooLarge { limit: u64 },
    #[error("bzip2 preflight failed for LDM record {index}: {reason}")]
    Bzip2 { index: usize, reason: String },
    #[error("third-party decoder failed: {0}")]
    ThirdParty(String),
    #[error("third-party decoder panicked; the panic was contained: {0}")]
    ThirdPartyPanic(String),
    #[error("decoded scan contains no {product} sweep")]
    MissingProduct { product: &'static str },
    #[error("decoded scan contains no radar-site metadata")]
    MissingSite,
    #[error("selected sweep contains no radials")]
    EmptySweep,
    #[error("lowest sweep is not safe to publish: {0}")]
    IncompleteSweep(String),
    #[error("selected sweep has invalid numeric metadata: {0}")]
    InvalidMetadata(String),
    #[error(
        "radial {radial} has inconsistent gate geometry: {field} is {actual}, expected {expected}"
    )]
    InconsistentGeometry {
        radial: usize,
        field: &'static str,
        actual: String,
        expected: String,
    },
    #[error("radial count {actual} exceeds limit {limit}")]
    TooManyRadials { actual: usize, limit: usize },
    #[error("gate count {actual} exceeds limit {limit}")]
    TooManyGates { actual: usize, limit: usize },
    #[error("cell count {actual} exceeds limit {limit}")]
    TooManyCells { actual: usize, limit: usize },
    #[error("radial {radial} declares {declared} gates but exposes {actual} raw values")]
    RawGateCountMismatch {
        radial: usize,
        declared: usize,
        actual: usize,
    },
}

/// Decode a bounded Archive II byte slice and normalize its lowest available
/// elevation for `product`.
pub fn decode_level2(input: &[u8], product: RadarProduct) -> Result<DecodeOutput, DecodeError> {
    decode_level2_internal(
        input,
        product,
        DecodeLimits::default(),
        "nexrad_level2_archive_ii",
        false,
    )
}

/// Decode progressively assembled real-time chunks only after the selected
/// lowest sweep contains explicit start and end radial boundaries.
pub fn decode_safe_lowest_sweep(
    input: &[u8],
    product: RadarProduct,
) -> Result<DecodeOutput, DecodeError> {
    decode_level2_internal(
        input,
        product,
        DecodeLimits::default(),
        "nexrad_level2_chunks",
        true,
    )
}

#[cfg(test)]
fn decode_level2_with_limits(
    input: &[u8],
    product: RadarProduct,
    limits: DecodeLimits,
) -> Result<DecodeOutput, DecodeError> {
    decode_level2_internal(input, product, limits, "nexrad_level2_archive_ii", false)
}

fn decode_level2_internal(
    input: &[u8],
    product: RadarProduct,
    limits: DecodeLimits,
    source_kind: &'static str,
    require_complete_lowest_sweep: bool,
) -> Result<DecodeOutput, DecodeError> {
    if input.is_empty() {
        return Err(DecodeError::EmptyInput);
    }
    if input.len() > limits.max_input_bytes {
        return Err(DecodeError::InputTooLarge {
            actual: input.len(),
            limit: limits.max_input_bytes,
        });
    }

    let source_sha256 = format!("{:x}", Sha256::digest(input));
    let archive = decompress_outer_gzip(input, limits.max_archive_bytes)?;
    let header_size = size_of::<Header>();
    if archive.len() < header_size {
        return Err(DecodeError::TruncatedHeader {
            required: header_size,
            actual: archive.len(),
        });
    }

    let preflight = preflight_ldm(&archive[header_size..], limits)?;
    let archive_bytes = archive.len();
    let file = VolumeFile::new(archive);
    let scan_result = catch_unwind(AssertUnwindSafe(|| file.scan()));
    let scan = match scan_result {
        Ok(Ok(scan)) => scan,
        Ok(Err(error)) => return Err(DecodeError::ThirdParty(error.to_string())),
        Err(payload) => return Err(DecodeError::ThirdPartyPanic(panic_message(payload))),
    };

    if require_complete_lowest_sweep {
        validate_lowest_sweep_complete(&scan, product)?;
    }
    let mut sweep = normalize_scan(&scan, product, &source_sha256, limits)?;
    sweep.source_kind = source_kind;
    Ok(DecodeOutput {
        sweep,
        evidence: DecodeEvidence {
            decoder: "nexrad-data=1.0.0-rc.7@4b4e5ed7cbb6c6d7c0997e86fc725c301c8fd40d;nexrad-decode=1.0.0-rc.3@de6e16d1977ca118738d917c130bf13413da7626;nexrad-model=1.0.0-rc.2@3d9ef8d7d1ecaa24795c53300fbdd5825852f1aa".into(),
            compressed_input_bytes: input.len(),
            archive_bytes,
            ldm_record_count: preflight.record_count,
            preflight_decompressed_bytes: preflight.decompressed_bytes,
        },
    })
}

fn decompress_outer_gzip(input: &[u8], max_archive_bytes: usize) -> Result<Vec<u8>, DecodeError> {
    if !input.starts_with(&[0x1f, 0x8b]) {
        if input.len() > max_archive_bytes {
            return Err(DecodeError::ArchiveTooLarge {
                actual: input.len(),
                limit: max_archive_bytes,
            });
        }
        return Ok(input.to_vec());
    }

    let mut decoder = MultiGzDecoder::new(input);
    let mut bounded = decoder
        .by_ref()
        .take((max_archive_bytes as u64).saturating_add(1));
    let mut archive = Vec::new();
    bounded
        .read_to_end(&mut archive)
        .map_err(|error| DecodeError::Gzip(error.to_string()))?;
    if archive.len() > max_archive_bytes {
        return Err(DecodeError::ArchiveTooLarge {
            actual: archive.len(),
            limit: max_archive_bytes,
        });
    }
    Ok(archive)
}

#[derive(Debug, Clone, Copy)]
struct PreflightEvidence {
    record_count: usize,
    decompressed_bytes: u64,
}

fn preflight_ldm(data: &[u8], limits: DecodeLimits) -> Result<PreflightEvidence, DecodeError> {
    if data.len() < 4 {
        return Err(DecodeError::MalformedRecordFraming {
            offset: 0,
            reason: "record section is shorter than its first four-byte size prefix".into(),
        });
    }
    if data[..4] == [0, 0, 0, 0] {
        return Err(DecodeError::UnsupportedArchiveVariant(
            "legacy CTM framing is outside the Phase 1 current-volume scope",
        ));
    }

    let mut offset = 0usize;
    let mut count = 0usize;
    let mut total_decompressed = 0u64;

    while offset < data.len() {
        count = count.checked_add(1).ok_or(DecodeError::TooManyRecords {
            limit: limits.max_record_count,
        })?;
        if count > limits.max_record_count {
            return Err(DecodeError::TooManyRecords {
                limit: limits.max_record_count,
            });
        }
        let prefix_end =
            offset
                .checked_add(4)
                .ok_or_else(|| DecodeError::MalformedRecordFraming {
                    offset,
                    reason: "record offset overflow".into(),
                })?;
        if prefix_end > data.len() {
            return Err(DecodeError::MalformedRecordFraming {
                offset,
                reason: "truncated four-byte size prefix".into(),
            });
        }

        let size = i32::from_be_bytes(data[offset..prefix_end].try_into().expect("four bytes"))
            .unsigned_abs() as usize;
        if size == 0 {
            return Err(DecodeError::MalformedRecordFraming {
                offset,
                reason: "zero-length record".into(),
            });
        }
        if size > limits.max_record_bytes {
            return Err(DecodeError::RecordTooLarge {
                index: count - 1,
                actual: size,
                limit: limits.max_record_bytes,
            });
        }
        let record_end =
            prefix_end
                .checked_add(size)
                .ok_or_else(|| DecodeError::MalformedRecordFraming {
                    offset,
                    reason: "record length overflow".into(),
                })?;
        if record_end > data.len() {
            return Err(DecodeError::MalformedRecordFraming {
                offset,
                reason: format!(
                    "record declares {size} payload bytes but only {} remain",
                    data.len().saturating_sub(prefix_end)
                ),
            });
        }

        let payload = &data[prefix_end..record_end];
        let expanded = if payload.starts_with(b"BZ") {
            bounded_bzip2_size(payload, count - 1, limits.max_decompressed_record_bytes)?
        } else {
            payload.len() as u64
        };
        total_decompressed = total_decompressed.checked_add(expanded).ok_or(
            DecodeError::TotalExpansionTooLarge {
                limit: limits.max_total_decompressed_record_bytes,
            },
        )?;
        if total_decompressed > limits.max_total_decompressed_record_bytes {
            return Err(DecodeError::TotalExpansionTooLarge {
                limit: limits.max_total_decompressed_record_bytes,
            });
        }
        offset = record_end;
    }

    Ok(PreflightEvidence {
        record_count: count,
        decompressed_bytes: total_decompressed,
    })
}

fn bounded_bzip2_size(payload: &[u8], index: usize, limit: u64) -> Result<u64, DecodeError> {
    let mut decoder = BzDecoder::new(payload);
    let mut bounded = decoder.by_ref().take(limit.saturating_add(1));
    let size = io::copy(&mut bounded, &mut io::sink()).map_err(|error| DecodeError::Bzip2 {
        index,
        reason: error.to_string(),
    })?;
    if size > limit {
        return Err(DecodeError::RecordExpansionTooLarge { index, limit });
    }
    Ok(size)
}

fn normalize_scan(
    scan: &Scan,
    product: RadarProduct,
    source_sha256: &str,
    limits: DecodeLimits,
) -> Result<NormalizedSweep, DecodeError> {
    let selected = select_lowest_sweep(scan, product)?;

    normalize_sweep(scan, selected, product, source_sha256, limits)
}

fn select_lowest_sweep(scan: &Scan, product: RadarProduct) -> Result<&Sweep, DecodeError> {
    scan.sweeps()
        .iter()
        .enumerate()
        .filter_map(|(index, sweep)| {
            if sweep
                .radials()
                .iter()
                .any(|radial| moment(radial, product).is_some())
            {
                sweep
                    .elevation_angle_degrees()
                    .filter(|angle| angle.is_finite())
                    .map(|angle| (index, angle, sweep))
            } else {
                None
            }
        })
        .min_by(|left, right| {
            left.1
                .total_cmp(&right.1)
                .then_with(|| left.0.cmp(&right.0))
        })
        .map(|(_, _, sweep)| sweep)
        .ok_or(DecodeError::MissingProduct {
            product: product.canonical_name(),
        })
}

fn validate_lowest_sweep_complete(scan: &Scan, product: RadarProduct) -> Result<(), DecodeError> {
    let sweep = select_lowest_sweep(scan, product)?;
    validate_sweep_boundaries(sweep)
}

fn validate_sweep_boundaries(sweep: &Sweep) -> Result<(), DecodeError> {
    let radials = sweep.radials();
    let first = radials.first().ok_or(DecodeError::EmptySweep)?;
    let last = radials.last().ok_or(DecodeError::EmptySweep)?;
    if !matches!(
        first.radial_status(),
        RadialStatus::ScanStart
            | RadialStatus::ElevationStart
            | RadialStatus::ElevationStartVCPFinal
    ) {
        return Err(DecodeError::IncompleteSweep(
            "first radial does not declare a sweep-start boundary".into(),
        ));
    }
    if !matches!(
        last.radial_status(),
        RadialStatus::ElevationEnd | RadialStatus::ScanEnd
    ) {
        return Err(DecodeError::IncompleteSweep(
            "last radial does not declare a sweep-end boundary".into(),
        ));
    }
    if radials
        .iter()
        .any(|radial| matches!(radial.radial_status(), RadialStatus::Unknown(_)))
    {
        return Err(DecodeError::IncompleteSweep(
            "selected sweep contains an unknown radial status".into(),
        ));
    }
    let unique_azimuths = radials
        .iter()
        .map(|radial| radial.azimuth_number())
        .collect::<BTreeSet<_>>();
    if unique_azimuths.len() != radials.len() {
        return Err(DecodeError::IncompleteSweep(
            "selected sweep contains duplicate source azimuth numbers".into(),
        ));
    }
    Ok(())
}

fn normalize_sweep(
    scan: &Scan,
    sweep: &Sweep,
    product: RadarProduct,
    source_sha256: &str,
    limits: DecodeLimits,
) -> Result<NormalizedSweep, DecodeError> {
    let mut radials: Vec<_> = sweep
        .radials()
        .iter()
        .filter(|radial| moment(radial, product).is_some())
        .collect();
    radials.sort_by(|left, right| {
        left.azimuth_angle_degrees()
            .total_cmp(&right.azimuth_angle_degrees())
            .then_with(|| left.azimuth_number().cmp(&right.azimuth_number()))
            .then_with(|| {
                left.collection_timestamp()
                    .cmp(&right.collection_timestamp())
            })
    });
    if radials.is_empty() {
        return Err(DecodeError::EmptySweep);
    }
    if radials.len() > limits.max_radials {
        return Err(DecodeError::TooManyRadials {
            actual: radials.len(),
            limit: limits.max_radials,
        });
    }

    let first_moment = moment(radials[0], product).expect("filtered radial has moment");
    let geometry = MomentGeometry::from_moment(first_moment)?;
    if geometry.gate_count == 0 {
        return Err(DecodeError::InvalidMetadata(
            "selected moment declares zero gates".into(),
        ));
    }
    if geometry.gate_count > limits.max_gates_per_radial {
        return Err(DecodeError::TooManyGates {
            actual: geometry.gate_count,
            limit: limits.max_gates_per_radial,
        });
    }
    let cell_count =
        radials
            .len()
            .checked_mul(geometry.gate_count)
            .ok_or(DecodeError::TooManyCells {
                actual: usize::MAX,
                limit: limits.max_cells,
            })?;
    if cell_count > limits.max_cells {
        return Err(DecodeError::TooManyCells {
            actual: cell_count,
            limit: limits.max_cells,
        });
    }

    let mut radial_metadata = Vec::with_capacity(radials.len());
    let mut values = Vec::with_capacity(cell_count);
    let mut statuses = Vec::with_capacity(cell_count);
    let mut raw_codes = Vec::with_capacity(cell_count);

    for (radial_index, radial) in radials.iter().enumerate() {
        validate_finite_radial(radial_index, radial)?;
        validate_timestamp(radial_index, radial.collection_timestamp())?;
        let data = moment(radial, product).expect("filtered radial has moment");
        let actual_geometry = MomentGeometry::from_moment(data)?;
        geometry.ensure_matches(radial_index, actual_geometry)?;
        let raw: Vec<u16> = data.raw_gate_values().collect();
        if raw.len() != geometry.gate_count {
            return Err(DecodeError::RawGateCountMismatch {
                radial: radial_index,
                declared: geometry.gate_count,
                actual: raw.len(),
            });
        }

        radial_metadata.push(RadialMetadata {
            source_azimuth_number: radial.azimuth_number(),
            azimuth_degrees: radial.azimuth_angle_degrees(),
            beam_width_degrees: radial.azimuth_spacing_degrees(),
            elevation_degrees: radial.elevation_angle_degrees(),
            collected_at_unix_ms: radial.collection_timestamp(),
        });
        raw_codes.extend(raw);
        append_moment_gates(radial_index, data, &mut values, &mut statuses)?;
    }

    let site = scan.site().ok_or(DecodeError::MissingSite)?;
    let site_id = site.identifier_string();
    if site_id.len() != 4
        || !site_id
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return Err(DecodeError::InvalidMetadata(format!(
            "invalid site identifier {site_id:?}"
        )));
    }
    if !site.latitude().is_finite()
        || !site.longitude().is_finite()
        || !(-90.0..=90.0).contains(&site.latitude())
        || !(-180.0..=180.0).contains(&site.longitude())
    {
        return Err(DecodeError::InvalidMetadata(
            "radar-site coordinates are non-finite or out of range".into(),
        ));
    }

    let sweep_started = radial_metadata
        .iter()
        .map(|radial| radial.collected_at_unix_ms)
        .min()
        .ok_or(DecodeError::EmptySweep)?;
    let sweep_ended = radial_metadata
        .iter()
        .map(|radial| radial.collected_at_unix_ms)
        .max()
        .ok_or(DecodeError::EmptySweep)?;
    let mut volume_started = sweep_started;
    let mut volume_ended = sweep_ended;
    for (radial_index, radial) in scan
        .sweeps()
        .iter()
        .flat_map(|item| item.radials().iter())
        .enumerate()
    {
        let collected_at = radial.collection_timestamp();
        validate_timestamp(radial_index, collected_at)?;
        volume_started = volume_started.min(collected_at);
        volume_ended = volume_ended.max(collected_at);
    }
    let elevation_degrees = median_f32(
        &radial_metadata
            .iter()
            .map(|radial| radial.elevation_degrees)
            .collect::<Vec<_>>(),
    )?;

    Ok(NormalizedSweep {
        schema_version: NORMALIZED_SWEEP_SCHEMA_VERSION,
        source_kind: "nexrad_level2_archive_ii",
        source_sha256: source_sha256.into(),
        site: RadarSite {
            icao: site_id,
            latitude_degrees: site.latitude(),
            longitude_degrees: site.longitude(),
            site_altitude_m: site.height_meters(),
            tower_height_m: site.tower_height_meters(),
        },
        product,
        units: product.units(),
        volume_started_at_unix_ms: volume_started,
        volume_ended_at_unix_ms: volume_ended,
        sweep_started_at_unix_ms: sweep_started,
        sweep_ended_at_unix_ms: sweep_ended,
        elevation_number: sweep.elevation_number(),
        elevation_degrees,
        vcp: scan.coverage_pattern_number().number(),
        gate_count: geometry.gate_count,
        gate_spacing_m: geometry.gate_spacing_m,
        first_gate_center_m: geometry.first_gate_center_m,
        data_word_size_bits: geometry.data_word_size_bits,
        scale: geometry.scale,
        offset: geometry.offset,
        radials: radial_metadata,
        values,
        statuses,
        raw_codes,
    })
}

fn append_moment_gates(
    radial_index: usize,
    data: &MomentData,
    values: &mut Vec<f32>,
    statuses: &mut Vec<GateStatus>,
) -> Result<(), DecodeError> {
    for decoded in data.iter() {
        match decoded {
            MomentValue::Value(value) if value.is_finite() => {
                values.push(value);
                statuses.push(GateStatus::Valid);
            }
            MomentValue::Value(_) => {
                return Err(DecodeError::InvalidMetadata(format!(
                    "radial {radial_index} contains a non-finite decoded gate"
                )));
            }
            MomentValue::BelowThreshold => {
                values.push(0.0);
                statuses.push(GateStatus::BelowThreshold);
            }
            MomentValue::RangeFolded => {
                values.push(0.0);
                statuses.push(GateStatus::RangeFolded);
            }
        }
    }
    Ok(())
}

fn moment(radial: &nexrad_model::data::Radial, product: RadarProduct) -> Option<&MomentData> {
    match product {
        RadarProduct::Reflectivity => radial.reflectivity(),
        RadarProduct::BaseVelocity => radial.velocity(),
    }
}

fn validate_finite_radial(
    radial_index: usize,
    radial: &nexrad_model::data::Radial,
) -> Result<(), DecodeError> {
    let values = [
        ("azimuth", radial.azimuth_angle_degrees()),
        ("beam width", radial.azimuth_spacing_degrees()),
        ("elevation", radial.elevation_angle_degrees()),
    ];
    for (name, value) in values {
        if !value.is_finite() {
            return Err(DecodeError::InvalidMetadata(format!(
                "radial {radial_index} has non-finite {name}"
            )));
        }
    }
    if !(0.0..360.0).contains(&radial.azimuth_angle_degrees()) {
        return Err(DecodeError::InvalidMetadata(format!(
            "radial {radial_index} azimuth is outside [0, 360)"
        )));
    }
    if radial.azimuth_spacing_degrees() <= 0.0 || radial.azimuth_spacing_degrees() > 2.0 {
        return Err(DecodeError::InvalidMetadata(format!(
            "radial {radial_index} beam width is outside (0, 2] degrees"
        )));
    }
    if !(0.0..=90.0).contains(&radial.elevation_angle_degrees()) {
        return Err(DecodeError::InvalidMetadata(format!(
            "radial {radial_index} elevation is outside [0, 90] degrees"
        )));
    }
    Ok(())
}

fn validate_timestamp(radial_index: usize, unix_ms: i64) -> Result<(), DecodeError> {
    if DateTime::<Utc>::from_timestamp_millis(unix_ms).is_none() {
        return Err(DecodeError::InvalidMetadata(format!(
            "radial {radial_index} has an out-of-range collection timestamp"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct MomentGeometry {
    gate_count: usize,
    first_gate_center_m: u32,
    gate_spacing_m: u32,
    data_word_size_bits: u8,
    scale: f32,
    offset: f32,
}

impl MomentGeometry {
    fn from_moment(data: &MomentData) -> Result<Self, DecodeError> {
        let first_gate_center_m =
            exact_nonnegative_meters(data.first_gate_range_km(), "first gate")?;
        let gate_spacing_m = exact_nonnegative_meters(data.gate_interval_km(), "gate spacing")?;
        if gate_spacing_m == 0 {
            return Err(DecodeError::InvalidMetadata(
                "gate spacing must be greater than zero".into(),
            ));
        }
        if !matches!(data.data_word_size(), 8 | 16) {
            return Err(DecodeError::InvalidMetadata(format!(
                "unsupported {}-bit moment words",
                data.data_word_size()
            )));
        }
        if !data.scale().is_finite() || !data.offset().is_finite() || data.scale() < 0.0 {
            return Err(DecodeError::InvalidMetadata(
                "moment scale/offset are non-finite or scale is negative".into(),
            ));
        }
        Ok(Self {
            gate_count: data.gate_count() as usize,
            first_gate_center_m,
            gate_spacing_m,
            data_word_size_bits: data.data_word_size(),
            scale: data.scale(),
            offset: data.offset(),
        })
    }

    fn ensure_matches(self, radial: usize, actual: Self) -> Result<(), DecodeError> {
        macro_rules! same {
            ($field:ident) => {
                if actual.$field != self.$field {
                    return Err(DecodeError::InconsistentGeometry {
                        radial,
                        field: stringify!($field),
                        actual: actual.$field.to_string(),
                        expected: self.$field.to_string(),
                    });
                }
            };
        }
        same!(gate_count);
        same!(first_gate_center_m);
        same!(gate_spacing_m);
        same!(data_word_size_bits);
        same!(scale);
        same!(offset);
        Ok(())
    }
}

fn exact_nonnegative_meters(kilometers: f64, field: &'static str) -> Result<u32, DecodeError> {
    let meters = kilometers * 1_000.0;
    if !meters.is_finite() || meters < 0.0 || meters > u32::MAX as f64 {
        return Err(DecodeError::InvalidMetadata(format!(
            "{field} range is invalid"
        )));
    }
    let rounded = meters.round();
    if (meters - rounded).abs() > 1e-6 {
        return Err(DecodeError::InvalidMetadata(format!(
            "{field} range is not an integral meter value"
        )));
    }
    Ok(rounded as u32)
}

fn median_f32(values: &[f32]) -> Result<f32, DecodeError> {
    if values.is_empty() || values.iter().any(|value| !value.is_finite()) {
        return Err(DecodeError::InvalidMetadata(
            "cannot calculate elevation median".into(),
        ));
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f32::total_cmp);
    let middle = sorted.len() / 2;
    Ok(if sorted.len() % 2 == 0 {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    } else {
        sorted[middle]
    })
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).into()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "non-string panic payload".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};
    use nexrad_model::data::{Radial, RadialStatus};
    use proptest::prelude::*;
    use std::io::Write;

    #[test]
    fn empty_input_is_rejected() {
        assert_eq!(
            decode_level2(&[], RadarProduct::Reflectivity),
            Err(DecodeError::EmptyInput)
        );
    }

    #[test]
    fn short_input_is_rejected_before_third_party_code() {
        let result = decode_level2(b"AR2V0006", RadarProduct::Reflectivity);
        assert!(matches!(result, Err(DecodeError::TruncatedHeader { .. })));
    }

    #[test]
    fn outer_gzip_expansion_is_bounded() {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(&vec![0u8; 4_096]).unwrap();
        let compressed = encoder.finish().unwrap();
        let limits = DecodeLimits {
            max_input_bytes: compressed.len() + 1,
            max_archive_bytes: 128,
            ..DecodeLimits::default()
        };
        assert!(matches!(
            decode_level2_with_limits(&compressed, RadarProduct::Reflectivity, limits),
            Err(DecodeError::ArchiveTooLarge { .. })
        ));
    }

    #[test]
    fn concatenated_outer_gzip_members_are_all_decoded() {
        fn gzip_member(bytes: &[u8]) -> Vec<u8> {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
            encoder.write_all(bytes).unwrap();
            encoder.finish().unwrap()
        }

        let mut input = gzip_member(b"AR2V0006");
        input.extend(gzip_member(b"concatenated payload"));

        assert_eq!(
            decompress_outer_gzip(&input, 1_024).unwrap(),
            b"AR2V0006concatenated payload"
        );
    }

    #[test]
    fn bzip2_expansion_is_bounded() {
        let mut encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
        encoder.write_all(&vec![0u8; 4_096]).unwrap();
        let compressed = encoder.finish().unwrap();
        assert!(matches!(
            bounded_bzip2_size(&compressed, 0, 128),
            Err(DecodeError::RecordExpansionTooLarge { .. })
        ));
    }

    #[test]
    fn excessive_record_count_is_rejected_before_decoder_allocation() {
        let mut data = Vec::new();
        for _ in 0..3 {
            data.extend_from_slice(&1i32.to_be_bytes());
            data.push(0xff);
        }
        let limits = DecodeLimits {
            max_record_count: 2,
            ..DecodeLimits::default()
        };
        assert!(matches!(
            preflight_ldm(&data, limits),
            Err(DecodeError::TooManyRecords { limit: 2 })
        ));
    }

    #[test]
    fn legacy_ctm_is_explicitly_out_of_scope() {
        assert!(matches!(
            preflight_ldm(&[0; 8], DecodeLimits::default()),
            Err(DecodeError::UnsupportedArchiveVariant(_))
        ));
    }

    #[test]
    fn impossible_elevation_is_rejected() {
        let radial = radial_at_elevation(200.0);
        assert!(matches!(
            validate_finite_radial(7, &radial),
            Err(DecodeError::InvalidMetadata(message))
                if message == "radial 7 elevation is outside [0, 90] degrees"
        ));
    }

    #[test]
    fn physical_elevation_boundaries_are_accepted() {
        assert!(validate_finite_radial(0, &radial_at_elevation(0.0)).is_ok());
        assert!(validate_finite_radial(0, &radial_at_elevation(90.0)).is_ok());
    }

    #[test]
    fn scaled_moment_status_codes_remain_distinct() {
        let data = MomentData::from_fixed_point(3, 0, 250, 8, 2.0, 66.0, vec![0, 1, 68]);
        let mut values = Vec::new();
        let mut statuses = Vec::new();

        append_moment_gates(0, &data, &mut values, &mut statuses).unwrap();

        assert_eq!(
            statuses,
            vec![
                GateStatus::BelowThreshold,
                GateStatus::RangeFolded,
                GateStatus::Valid
            ]
        );
        assert_eq!(values, vec![0.0, 0.0, 1.0]);
    }

    fn radial_at_elevation(elevation_degrees: f32) -> Radial {
        Radial::new(
            0,
            1,
            0.5,
            0.5,
            RadialStatus::ScanStart,
            1,
            elevation_degrees,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
    }

    fn boundary_radial(azimuth_number: u16, status: RadialStatus) -> Radial {
        Radial::new(
            1_800_000_000_000 + i64::from(azimuth_number),
            azimuth_number,
            f32::from(azimuth_number),
            1.0,
            status,
            1,
            0.5,
            Some(MomentData::from_fixed_point(
                1,
                0,
                250,
                8,
                2.0,
                66.0,
                vec![68],
            )),
            None,
            None,
            None,
            None,
            None,
            None,
        )
    }

    #[test]
    fn progressive_sweep_requires_explicit_start_and_end_boundaries() {
        let incomplete = Sweep::new(
            1,
            vec![
                boundary_radial(1, RadialStatus::ScanStart),
                boundary_radial(2, RadialStatus::IntermediateRadialData),
            ],
        );
        assert!(matches!(
            validate_sweep_boundaries(&incomplete),
            Err(DecodeError::IncompleteSweep(message))
                if message.contains("sweep-end boundary")
        ));

        let complete = Sweep::new(
            1,
            vec![
                boundary_radial(1, RadialStatus::ScanStart),
                boundary_radial(2, RadialStatus::ElevationEnd),
            ],
        );
        assert_eq!(validate_sweep_boundaries(&complete), Ok(()));
    }

    #[test]
    fn progressive_sweep_rejects_unknown_status_and_duplicate_azimuths() {
        let unknown = Sweep::new(
            1,
            vec![
                boundary_radial(1, RadialStatus::ScanStart),
                boundary_radial(2, RadialStatus::Unknown(99)),
                boundary_radial(3, RadialStatus::ElevationEnd),
            ],
        );
        assert!(matches!(
            validate_sweep_boundaries(&unknown),
            Err(DecodeError::IncompleteSweep(message))
                if message.contains("unknown radial status")
        ));

        let duplicate = Sweep::new(
            1,
            vec![
                boundary_radial(1, RadialStatus::ScanStart),
                boundary_radial(1, RadialStatus::ElevationEnd),
            ],
        );
        assert!(matches!(
            validate_sweep_boundaries(&duplicate),
            Err(DecodeError::IncompleteSweep(message))
                if message.contains("duplicate source azimuth")
        ));
    }

    #[test]
    fn current_ktlx_fixture_matches_phase_1_reference_when_available() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/cache/KTLX20240520_230512_V06");
        if !path.exists() {
            eprintln!(
                "fixture is not downloaded; run `npm run fixture:download` for the Phase 1 integration assertion"
            );
            return;
        }

        let input = std::fs::read(path).expect("read verified public fixture");
        let output =
            decode_level2(&input, RadarProduct::Reflectivity).expect("decode current KTLX fixture");
        let chunk_output = decode_safe_lowest_sweep(&input, RadarProduct::Reflectivity)
            .expect("decode complete KTLX bytes with real-time chunk provenance");
        assert_eq!(chunk_output.sweep.source_kind, "nexrad_level2_chunks");
        assert_eq!(
            output.sweep.source_sha256,
            "99c189c327307da6a26a9f265ee84bf9fc690dc1a7358db941949805afa4a0d3"
        );
        assert_eq!(output.sweep.site.icao, "KTLX");
        assert_eq!(output.sweep.radial_count(), 720);
        assert_eq!(output.sweep.gate_count, 1_832);
        assert_eq!(output.sweep.gate_spacing_m, 250);
        assert_eq!(output.sweep.first_gate_center_m, 2_125);
        assert_eq!(
            output.sweep.normalized_sha256(),
            "f3c4ced03212402d921c9880b485db5bd95e5c28a1c752b2cae86a9e7bf27bf6"
        );
        assert_eq!(
            output.sweep.oracle_field_sha256(),
            "b88ff2738cb8c64d4572a2cb5623486a1603681cdeaf27f71e59bbac015261fd"
        );
        assert_eq!(
            output.sweep.gate_status_sha256(),
            "e79562f06bcf793c41ff1c3820e48e0da7162c989a54c27ed2d7ac39d6b961aa"
        );
        assert_eq!(
            output.sweep.raw_codes_sha256(),
            "dca2af0bc4844389d73b8efa14db8232c6039e7814fbc4fddc8b0f10d8b4a534"
        );
    }

    proptest! {
        #[test]
        fn arbitrary_small_inputs_never_escape_as_panics(input in proptest::collection::vec(any::<u8>(), 0..4096)) {
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                decode_level2(&input, RadarProduct::Reflectivity)
            }));
            prop_assert!(outcome.is_ok());
        }

        #[test]
        fn framed_arbitrary_records_never_escape_as_panics(payload in proptest::collection::vec(any::<u8>(), 1..4096)) {
            let mut archive = vec![0u8; size_of::<Header>()];
            archive.extend_from_slice(&(payload.len() as i32).to_be_bytes());
            archive.extend_from_slice(&payload);
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                decode_level2(&archive, RadarProduct::Reflectivity)
            }));
            prop_assert!(outcome.is_ok());
        }
    }
}
