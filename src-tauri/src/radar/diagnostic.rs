use super::{DecodeOutput, GateStatus, RadarProduct};
use chrono::{SecondsFormat, TimeZone, Utc};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    pub schema_version: u16,
    pub decoder: String,
    pub source_kind: &'static str,
    pub source_sha256: String,
    pub normalized_sha256: String,
    pub azimuth_sha256: String,
    pub oracle_field_sha256: String,
    pub gate_status_sha256: String,
    pub raw_codes_sha256: String,
    pub site_icao: String,
    pub radar_latitude_degrees: f32,
    pub radar_longitude_degrees: f32,
    pub site_altitude_m: i16,
    pub tower_height_m: u16,
    pub antenna_altitude_m: i32,
    pub product: RadarProduct,
    pub units: &'static str,
    pub volume_started_at_utc: String,
    pub volume_ended_at_utc: String,
    pub sweep_started_at_utc: String,
    pub sweep_ended_at_utc: String,
    pub elevation_number: u8,
    pub elevation_degrees: f32,
    pub vcp: u16,
    pub radial_count: usize,
    pub gate_count: usize,
    pub cell_count: usize,
    pub gate_spacing_m: u32,
    pub first_gate_center_m: u32,
    pub data_word_size_bits: u8,
    pub scale: f32,
    pub offset: f32,
    pub below_threshold_count: usize,
    pub range_folded_count: usize,
    pub valid_count: usize,
    pub compressed_input_bytes: usize,
    pub archive_bytes: usize,
    pub ldm_record_count: usize,
    pub preflight_decompressed_bytes: u64,
    pub samples: Vec<GateSample>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateSample {
    pub radial_index: usize,
    pub gate_index: usize,
    pub source_azimuth_number: u16,
    pub azimuth_degrees: f32,
    pub elevation_degrees: f32,
    pub beam_width_degrees: f32,
    pub collected_at_utc: String,
    pub range_m: u64,
    pub raw_code: u16,
    pub status: GateStatus,
    pub value: Option<f32>,
}

impl DiagnosticReport {
    pub fn from_output(output: &DecodeOutput) -> Self {
        let sweep = &output.sweep;
        let valid_count = sweep
            .statuses
            .iter()
            .filter(|status| **status == GateStatus::Valid)
            .count();
        let below_threshold_count = sweep
            .statuses
            .iter()
            .filter(|status| **status == GateStatus::BelowThreshold)
            .count();
        let range_folded_count = sweep
            .statuses
            .iter()
            .filter(|status| **status == GateStatus::RangeFolded)
            .count();

        let mut samples = Vec::new();
        for radial_index in sample_indices(sweep.radial_count()) {
            for gate_index in sample_indices(sweep.gate_count) {
                let index = radial_index * sweep.gate_count + gate_index;
                let radial = &sweep.radials[radial_index];
                let status = sweep.statuses[index];
                samples.push(GateSample {
                    radial_index,
                    gate_index,
                    source_azimuth_number: radial.source_azimuth_number,
                    azimuth_degrees: radial.azimuth_degrees,
                    elevation_degrees: radial.elevation_degrees,
                    beam_width_degrees: radial.beam_width_degrees,
                    collected_at_utc: timestamp(radial.collected_at_unix_ms),
                    range_m: sweep.first_gate_center_m as u64
                        + gate_index as u64 * sweep.gate_spacing_m as u64,
                    raw_code: sweep.raw_codes[index],
                    status,
                    value: (status == GateStatus::Valid).then_some(sweep.values[index]),
                });
            }
        }

        Self {
            schema_version: sweep.schema_version,
            decoder: output.evidence.decoder.clone(),
            source_kind: sweep.source_kind,
            source_sha256: sweep.source_sha256.clone(),
            normalized_sha256: sweep.normalized_sha256(),
            azimuth_sha256: sweep.azimuth_sha256(),
            oracle_field_sha256: sweep.oracle_field_sha256(),
            gate_status_sha256: sweep.gate_status_sha256(),
            raw_codes_sha256: sweep.raw_codes_sha256(),
            site_icao: sweep.site.icao.clone(),
            radar_latitude_degrees: sweep.site.latitude_degrees,
            radar_longitude_degrees: sweep.site.longitude_degrees,
            site_altitude_m: sweep.site.site_altitude_m,
            tower_height_m: sweep.site.tower_height_m,
            antenna_altitude_m: sweep.site.site_altitude_m as i32
                + sweep.site.tower_height_m as i32,
            product: sweep.product,
            units: sweep.units,
            volume_started_at_utc: timestamp(sweep.volume_started_at_unix_ms),
            volume_ended_at_utc: timestamp(sweep.volume_ended_at_unix_ms),
            sweep_started_at_utc: timestamp(sweep.sweep_started_at_unix_ms),
            sweep_ended_at_utc: timestamp(sweep.sweep_ended_at_unix_ms),
            elevation_number: sweep.elevation_number,
            elevation_degrees: sweep.elevation_degrees,
            vcp: sweep.vcp,
            radial_count: sweep.radial_count(),
            gate_count: sweep.gate_count,
            cell_count: sweep.cell_count(),
            gate_spacing_m: sweep.gate_spacing_m,
            first_gate_center_m: sweep.first_gate_center_m,
            data_word_size_bits: sweep.data_word_size_bits,
            scale: sweep.scale,
            offset: sweep.offset,
            below_threshold_count,
            range_folded_count,
            valid_count,
            compressed_input_bytes: output.evidence.compressed_input_bytes,
            archive_bytes: output.evidence.archive_bytes,
            ldm_record_count: output.evidence.ldm_record_count,
            preflight_decompressed_bytes: output.evidence.preflight_decompressed_bytes,
            samples,
        }
    }

    pub fn to_text(&self) -> String {
        let mut output = format!(
            "Mistr normalized radar diagnostic\n\
             decoder: {}\n\
             source_sha256: {}\n\
             normalized_sha256: {}\n\
             azimuth_sha256: {}\n\
             oracle_field_sha256: {}\n\
             gate_status_sha256: {}\n\
             raw_codes_sha256: {}\n\
             site: {} ({:.5}, {:.5}, site {} m, antenna {} m)\n\
             product: {} [{}]\n\
             volume: {} to {}\n\
             sweep: elevation {} / {:.3} deg / VCP {}\n\
             dimensions: {} radials x {} gates = {} cells\n\
             gate geometry: first center {} m; spacing {} m; {}-bit; scale {}; offset {}\n\
             statuses: {} valid; {} below threshold; {} range folded\n\
             preflight: {} records; {} compressed bytes; {} expanded record bytes\n\n\
             Selected radial/gate values:\n",
            self.decoder,
            self.source_sha256,
            self.normalized_sha256,
            self.azimuth_sha256,
            self.oracle_field_sha256,
            self.gate_status_sha256,
            self.raw_codes_sha256,
            self.site_icao,
            self.radar_latitude_degrees,
            self.radar_longitude_degrees,
            self.site_altitude_m,
            self.antenna_altitude_m,
            self.product.canonical_name(),
            self.units,
            self.volume_started_at_utc,
            self.volume_ended_at_utc,
            self.elevation_number,
            self.elevation_degrees,
            self.vcp,
            self.radial_count,
            self.gate_count,
            self.cell_count,
            self.first_gate_center_m,
            self.gate_spacing_m,
            self.data_word_size_bits,
            self.scale,
            self.offset,
            self.valid_count,
            self.below_threshold_count,
            self.range_folded_count,
            self.ldm_record_count,
            self.compressed_input_bytes,
            self.preflight_decompressed_bytes,
        );
        for sample in &self.samples {
            let value = sample
                .value
                .map(|value| format!("{value:.3}"))
                .unwrap_or_else(|| "n/a".into());
            output.push_str(&format!(
                "  r={:>3} g={:>4} az={:>7.3} elev={:>6.3} range={:>7}m raw={:>4} status={:?} value={}\n",
                sample.radial_index,
                sample.gate_index,
                sample.azimuth_degrees,
                sample.elevation_degrees,
                sample.range_m,
                sample.raw_code,
                sample.status,
                value,
            ));
        }
        output
    }
}

fn sample_indices(length: usize) -> Vec<usize> {
    if length == 0 {
        return Vec::new();
    }
    let mut indices = vec![
        0,
        1.min(length - 1),
        length / 4,
        length / 2,
        length * 3 / 4,
        length - 1,
    ];
    indices.sort_unstable();
    indices.dedup();
    indices
}

fn timestamp(unix_ms: i64) -> String {
    Utc.timestamp_millis_opt(unix_ms)
        .single()
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(|| format!("invalid-unix-ms:{unix_ms}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_indices_are_sorted_unique_and_bounded() {
        for length in 0..100 {
            let values = sample_indices(length);
            assert!(values.windows(2).all(|pair| pair[0] < pair[1]));
            assert!(values.iter().all(|index| *index < length));
        }
    }
}
