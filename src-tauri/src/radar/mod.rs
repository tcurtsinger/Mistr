//! Mistr-owned radar model and decoder boundary.
//!
//! Third-party NEXRAD types are deliberately confined to [`decoder`]. Downstream
//! renderer and IPC code consume only the stable structures in this module.

mod decoder;
mod diagnostic;

pub use decoder::{DecodeError, decode_level2};
pub use diagnostic::{DiagnosticReport, GateSample};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::str::FromStr;

pub const NORMALIZED_SWEEP_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RadarProduct {
    Reflectivity,
    BaseVelocity,
}

impl RadarProduct {
    pub fn canonical_name(self) -> &'static str {
        match self {
            Self::Reflectivity => "reflectivity",
            Self::BaseVelocity => "base_velocity",
        }
    }

    pub fn units(self) -> &'static str {
        match self {
            Self::Reflectivity => "dBZ",
            Self::BaseVelocity => "m/s",
        }
    }
}

impl FromStr for RadarProduct {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "reflectivity" | "ref" => Ok(Self::Reflectivity),
            "base_velocity" | "velocity" | "vel" => Ok(Self::BaseVelocity),
            other => Err(format!(
                "unsupported product '{other}'; expected reflectivity or base_velocity"
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateStatus {
    Valid,
    BelowThreshold,
    RangeFolded,
}

impl GateStatus {
    fn code(self) -> u8 {
        match self {
            Self::Valid => 0,
            Self::BelowThreshold => 1,
            Self::RangeFolded => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RadarSite {
    pub icao: String,
    pub latitude_degrees: f32,
    pub longitude_degrees: f32,
    pub site_altitude_m: i16,
    pub tower_height_m: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RadialMetadata {
    pub source_azimuth_number: u16,
    pub azimuth_degrees: f32,
    pub beam_width_degrees: f32,
    pub elevation_degrees: f32,
    pub collected_at_unix_ms: i64,
}

/// Renderer-independent polar sweep normalized from a single Level II moment.
///
/// `values`, `statuses`, and `raw_codes` are radial-major arrays with exactly
/// `radial_count * gate_count` elements. Invalid values are stored as `0.0` and
/// their meaning is carried losslessly by `statuses`.
#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedSweep {
    pub schema_version: u16,
    pub source_kind: &'static str,
    pub source_sha256: String,
    pub site: RadarSite,
    pub product: RadarProduct,
    pub units: &'static str,
    pub volume_started_at_unix_ms: i64,
    pub volume_ended_at_unix_ms: i64,
    pub sweep_started_at_unix_ms: i64,
    pub sweep_ended_at_unix_ms: i64,
    pub elevation_number: u8,
    pub elevation_degrees: f32,
    pub vcp: u16,
    pub gate_count: usize,
    pub gate_spacing_m: u32,
    pub first_gate_center_m: u32,
    pub data_word_size_bits: u8,
    pub scale: f32,
    pub offset: f32,
    pub radials: Vec<RadialMetadata>,
    pub values: Vec<f32>,
    pub statuses: Vec<GateStatus>,
    pub raw_codes: Vec<u16>,
}

impl NormalizedSweep {
    pub fn radial_count(&self) -> usize {
        self.radials.len()
    }

    pub fn cell_count(&self) -> usize {
        self.values.len()
    }

    pub fn normalized_sha256(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(b"mistr-normalized-sweep\0");
        hash.update(self.schema_version.to_le_bytes());
        update_string(&mut hash, self.source_kind);
        update_string(&mut hash, &self.site.icao);
        hash.update(self.site.latitude_degrees.to_bits().to_le_bytes());
        hash.update(self.site.longitude_degrees.to_bits().to_le_bytes());
        hash.update(self.site.site_altitude_m.to_le_bytes());
        hash.update(self.site.tower_height_m.to_le_bytes());
        update_string(&mut hash, self.product.canonical_name());
        update_string(&mut hash, self.units);
        hash.update(self.volume_started_at_unix_ms.to_le_bytes());
        hash.update(self.volume_ended_at_unix_ms.to_le_bytes());
        hash.update(self.sweep_started_at_unix_ms.to_le_bytes());
        hash.update(self.sweep_ended_at_unix_ms.to_le_bytes());
        hash.update([self.elevation_number]);
        hash.update(self.elevation_degrees.to_bits().to_le_bytes());
        hash.update(self.vcp.to_le_bytes());
        hash.update((self.radial_count() as u64).to_le_bytes());
        hash.update((self.gate_count as u64).to_le_bytes());
        hash.update(self.gate_spacing_m.to_le_bytes());
        hash.update(self.first_gate_center_m.to_le_bytes());
        hash.update([self.data_word_size_bits]);
        hash.update(self.scale.to_bits().to_le_bytes());
        hash.update(self.offset.to_bits().to_le_bytes());

        for radial in &self.radials {
            hash.update(radial.source_azimuth_number.to_le_bytes());
            hash.update(radial.azimuth_degrees.to_bits().to_le_bytes());
            hash.update(radial.beam_width_degrees.to_bits().to_le_bytes());
            hash.update(radial.elevation_degrees.to_bits().to_le_bytes());
            hash.update(radial.collected_at_unix_ms.to_le_bytes());
        }
        for value in &self.values {
            hash.update(value.to_bits().to_le_bytes());
        }
        for status in &self.statuses {
            hash.update([status.code()]);
        }
        for raw in &self.raw_codes {
            hash.update(raw.to_le_bytes());
        }

        format!("{:x}", hash.finalize())
    }

    /// Cross-implementation digest of sorted azimuth angles only. This is kept
    /// intentionally simpler than `normalized_sha256` so an independent oracle
    /// can reproduce it without knowing Mistr's internal schema.
    pub fn azimuth_sha256(&self) -> String {
        let mut hash = Sha256::new();
        for radial in &self.radials {
            hash.update(radial.azimuth_degrees.to_bits().to_le_bytes());
        }
        format!("{:x}", hash.finalize())
    }

    /// Cross-implementation digest of field validity and decoded float values.
    /// Each cell contributes one validity byte and one little-endian `f32`; all
    /// invalid cells use `0.0` so Py-ART's single mask can be compared directly.
    pub fn oracle_field_sha256(&self) -> String {
        let mut hash = Sha256::new();
        for (value, status) in self.values.iter().zip(&self.statuses) {
            let valid = *status == GateStatus::Valid;
            hash.update([u8::from(valid)]);
            hash.update(if valid { *value } else { 0.0 }.to_bits().to_le_bytes());
        }
        format!("{:x}", hash.finalize())
    }

    /// Cross-implementation digest of every raw moment code in normalized
    /// radial-major order, encoded as little-endian `u16` values.
    pub fn raw_codes_sha256(&self) -> String {
        let mut hash = Sha256::new();
        for raw in &self.raw_codes {
            hash.update(raw.to_le_bytes());
        }
        format!("{:x}", hash.finalize())
    }
}

fn update_string(hash: &mut Sha256, value: &str) {
    hash.update((value.len() as u64).to_le_bytes());
    hash.update(value.as_bytes());
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodeEvidence {
    pub decoder: String,
    pub compressed_input_bytes: usize,
    pub archive_bytes: usize,
    pub ldm_record_count: usize,
    pub preflight_decompressed_bytes: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodeOutput {
    pub sweep: NormalizedSweep,
    pub evidence: DecodeEvidence,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_hash_changes_with_gate_content() {
        let mut sweep = example_sweep();
        let original = sweep.normalized_sha256();
        sweep.raw_codes[0] += 1;
        assert_ne!(original, sweep.normalized_sha256());
    }

    #[test]
    fn normalized_hash_is_reproducible() {
        let sweep = example_sweep();
        assert_eq!(sweep.normalized_sha256(), sweep.clone().normalized_sha256());
    }

    fn example_sweep() -> NormalizedSweep {
        NormalizedSweep {
            schema_version: NORMALIZED_SWEEP_SCHEMA_VERSION,
            source_kind: "nexrad_level2_archive_ii",
            source_sha256: "00".repeat(32),
            site: RadarSite {
                icao: "KTLX".into(),
                latitude_degrees: 35.333,
                longitude_degrees: -97.277,
                site_altitude_m: 370,
                tower_height_m: 30,
            },
            product: RadarProduct::Reflectivity,
            units: "dBZ",
            volume_started_at_unix_ms: 1,
            volume_ended_at_unix_ms: 2,
            sweep_started_at_unix_ms: 1,
            sweep_ended_at_unix_ms: 2,
            elevation_number: 1,
            elevation_degrees: 0.5,
            vcp: 212,
            gate_count: 2,
            gate_spacing_m: 250,
            first_gate_center_m: 2125,
            data_word_size_bits: 8,
            scale: 2.0,
            offset: 66.0,
            radials: vec![RadialMetadata {
                source_azimuth_number: 1,
                azimuth_degrees: 0.5,
                beam_width_degrees: 0.5,
                elevation_degrees: 0.5,
                collected_at_unix_ms: 1,
            }],
            values: vec![1.0, 0.0],
            statuses: vec![GateStatus::Valid, GateStatus::BelowThreshold],
            raw_codes: vec![68, 0],
        }
    }
}
