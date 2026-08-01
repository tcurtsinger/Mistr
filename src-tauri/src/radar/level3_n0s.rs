use super::{
    DecodeEvidence, DecodeOutput, GateStatus, NORMALIZED_SWEEP_SCHEMA_VERSION, NormalizedSweep,
    RadarProduct, RadarSite, RadialMetadata,
};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const MAX_LEVEL3_N0S_INPUT_BYTES: usize = 4 * 1024 * 1024;
const TEXT_HEADER_BYTES: usize = 30;
const MESSAGE_HEADER_BYTES: usize = 18;
const PRODUCT_DESCRIPTION_BYTES: usize = 102;
const PRODUCT_CODE_N0S: u16 = 56;
const RADIAL_PACKET_16_LEVEL: u16 = 0xaf1f;
const MAX_RADIALS: usize = 720;
const MAX_BINS: usize = 2_304;
const MAX_CELLS: usize = 1_000_000;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum Level3N0sError {
    #[error("input is empty")]
    EmptyInput,
    #[error("input is {actual} bytes; limit is {limit} bytes")]
    InputTooLarge { actual: usize, limit: usize },
    #[error("expected site must be a four-character uppercase ICAO identifier")]
    InvalidExpectedSite,
    #[error("Level III input is truncated at byte {offset}: need {needed} bytes, have {available}")]
    Truncated {
        offset: usize,
        needed: usize,
        available: usize,
    },
    #[error("Level III text header is invalid: {0}")]
    InvalidTextHeader(&'static str),
    #[error("Level III site {actual} does not match expected site {expected}")]
    SiteMismatch { actual: String, expected: String },
    #[error("unsupported Level III product code {0}; only N0S product 56 is accepted")]
    UnsupportedProduct(u16),
    #[error("invalid Level III product metadata: {0}")]
    InvalidMetadata(&'static str),
    #[error("unsupported N0S threshold word 0x{word:04x} at category {category}")]
    UnsupportedThreshold { category: usize, word: u16 },
    #[error("invalid symbology block: {0}")]
    InvalidSymbology(&'static str),
    #[error("N0S radial {radial} is invalid: {reason}")]
    InvalidRadial { radial: usize, reason: &'static str },
    #[error("N0S dimensions exceed the bounded decoder contract")]
    DimensionsTooLarge,
}

/// Decode the first-elevation storm-relative velocity Level III product (N0S).
///
/// This parser intentionally owns only product 56 plus the 16-level radial
/// packet used by the pinned corpus. It rejects every other product or packet
/// rather than guessing. `expected_site` is required because the product text
/// header carries a three-character radar ID and that ID is not always formed
/// by adding `K` (for example, PABC in Alaska).
pub fn decode_level3_n0s(
    input: &[u8],
    expected_site: &str,
) -> Result<DecodeOutput, Level3N0sError> {
    if input.is_empty() {
        return Err(Level3N0sError::EmptyInput);
    }
    if input.len() > MAX_LEVEL3_N0S_INPUT_BYTES {
        return Err(Level3N0sError::InputTooLarge {
            actual: input.len(),
            limit: MAX_LEVEL3_N0S_INPUT_BYTES,
        });
    }
    if expected_site.len() != 4
        || !expected_site
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return Err(Level3N0sError::InvalidExpectedSite);
    }

    let minimum = TEXT_HEADER_BYTES + MESSAGE_HEADER_BYTES + PRODUCT_DESCRIPTION_BYTES;
    need(input, 0, minimum)?;
    if &input[0..4] != b"SDUS" {
        return Err(Level3N0sError::InvalidTextHeader("file type is not SDUS"));
    }
    if &input[21..24] != b"N0S" {
        return Err(Level3N0sError::InvalidTextHeader(
            "product mnemonic is not N0S",
        ));
    }
    let id3 = ascii(input, 24, 3)?;
    if &expected_site[1..] != id3 {
        return Err(Level3N0sError::SiteMismatch {
            actual: id3.to_string(),
            expected: expected_site.to_string(),
        });
    }

    let message = TEXT_HEADER_BYTES;
    let message_code = be_u16(input, message)?;
    if message_code != PRODUCT_CODE_N0S {
        return Err(Level3N0sError::UnsupportedProduct(message_code));
    }
    let message_length = be_u32(input, message + 8)? as usize;
    if message_length != input.len() - TEXT_HEADER_BYTES {
        return Err(Level3N0sError::InvalidMetadata("message length"));
    }

    let description = message + MESSAGE_HEADER_BYTES;
    if be_i16(input, description)? != -1 {
        return Err(Level3N0sError::InvalidMetadata(
            "product-description divider",
        ));
    }
    let product_code = be_u16(input, description + 12)?;
    if product_code != PRODUCT_CODE_N0S {
        return Err(Level3N0sError::UnsupportedProduct(product_code));
    }

    let latitude_degrees = be_i32(input, description + 2)? as f32 / 1_000.0;
    let longitude_degrees = be_i32(input, description + 6)? as f32 / 1_000.0;
    if !(-90.0..=90.0).contains(&latitude_degrees) || !(-180.0..=180.0).contains(&longitude_degrees)
    {
        return Err(Level3N0sError::InvalidMetadata("radar coordinates"));
    }
    let height_ft = be_i16(input, description + 10)?;
    let vcp = be_u16(input, description + 16)?;
    let volume_date = be_u16(input, description + 22)?;
    let volume_seconds = be_u32(input, description + 24)?;
    let product_date = be_u16(input, description + 28)?;
    let product_seconds = be_u32(input, description + 30)?;
    let elevation_number = u8::try_from(be_u16(input, description + 38)?)
        .map_err(|_| Level3N0sError::InvalidMetadata("elevation number"))?;
    let elevation_degrees = be_i16(input, description + 40)? as f32 / 10.0;
    if !(0.0..=90.0).contains(&elevation_degrees) {
        return Err(Level3N0sError::InvalidMetadata("elevation angle"));
    }

    let mut thresholds = [0.0f32; 16];
    for (category, threshold) in thresholds.iter_mut().enumerate() {
        let word = be_u16(input, description + 42 + category * 2)?;
        *threshold = decode_threshold(category, word)?;
    }
    let volume_started_at_unix_ms = level3_time(volume_date, volume_seconds)?;
    let product_at_unix_ms = level3_time(product_date, product_seconds)?;
    if product_at_unix_ms < volume_started_at_unix_ms {
        return Err(Level3N0sError::InvalidMetadata("product time ordering"));
    }

    let symbology_halfwords = be_u32(input, description + 90)? as usize;
    let symbology = TEXT_HEADER_BYTES
        .checked_add(
            symbology_halfwords
                .checked_mul(2)
                .ok_or(Level3N0sError::InvalidSymbology("offset overflow"))?,
        )
        .ok_or(Level3N0sError::InvalidSymbology("offset overflow"))?;
    need(input, symbology, 16)?;
    if be_i16(input, symbology)? != -1 || be_u16(input, symbology + 2)? != 1 {
        return Err(Level3N0sError::InvalidSymbology("block header"));
    }
    let block_length = be_u32(input, symbology + 4)? as usize;
    let block_end = symbology
        .checked_add(block_length)
        .ok_or(Level3N0sError::InvalidSymbology("block length overflow"))?;
    if block_length < 16 || block_end > input.len() {
        return Err(Level3N0sError::InvalidSymbology("block length"));
    }
    if be_u16(input, symbology + 8)? != 1 {
        return Err(Level3N0sError::InvalidSymbology(
            "expected exactly one layer",
        ));
    }
    let layer = symbology + 10;
    if be_i16(input, layer)? != -1 {
        return Err(Level3N0sError::InvalidSymbology("layer divider"));
    }
    let layer_length = be_u32(input, layer + 2)? as usize;
    let packet = layer + 6;
    let layer_end = packet
        .checked_add(layer_length)
        .ok_or(Level3N0sError::InvalidSymbology("layer length overflow"))?;
    if layer_end != block_end {
        return Err(Level3N0sError::InvalidSymbology("layer length"));
    }
    need(input, packet, 14)?;
    if be_u16(input, packet)? != RADIAL_PACKET_16_LEVEL {
        return Err(Level3N0sError::InvalidSymbology(
            "packet is not 16-level radial data",
        ));
    }

    let first_bin = be_i16(input, packet + 2)?;
    let gate_count = usize::from(be_u16(input, packet + 4)?);
    let range_scale_m = u32::from(be_u16(input, packet + 10)?);
    let radial_count = usize::from(be_u16(input, packet + 12)?);
    let cell_count = radial_count
        .checked_mul(gate_count)
        .ok_or(Level3N0sError::DimensionsTooLarge)?;
    if first_bin < 0
        || gate_count == 0
        || gate_count > MAX_BINS
        || radial_count == 0
        || radial_count > MAX_RADIALS
        || cell_count > MAX_CELLS
        || range_scale_m == 0
    {
        return Err(Level3N0sError::DimensionsTooLarge);
    }

    let mut cursor = packet + 14;
    let mut radials = Vec::with_capacity(radial_count);
    let mut values = Vec::with_capacity(cell_count);
    let mut statuses = Vec::with_capacity(cell_count);
    let mut raw_codes = Vec::with_capacity(cell_count);
    for radial_index in 0..radial_count {
        need(input, cursor, 6)?;
        let encoded_bytes = usize::from(be_u16(input, cursor)?).checked_mul(2).ok_or(
            Level3N0sError::InvalidRadial {
                radial: radial_index,
                reason: "RLE length overflow",
            },
        )?;
        let start_degrees = f32::from(be_u16(input, cursor + 2)?) / 10.0;
        let beam_width_degrees = f32::from(be_u16(input, cursor + 4)?) / 10.0;
        cursor += 6;
        if start_degrees >= 360.0 || !(beam_width_degrees > 0.0 && beam_width_degrees <= 10.0) {
            return Err(Level3N0sError::InvalidRadial {
                radial: radial_index,
                reason: "angle metadata",
            });
        }
        need(input, cursor, encoded_bytes)?;
        let before = raw_codes.len();
        for (encoded_index, byte) in input[cursor..cursor + encoded_bytes].iter().enumerate() {
            let run = usize::from(byte >> 4);
            let category = usize::from(byte & 0x0f);
            if run == 0 {
                if *byte == 0
                    && encoded_index + 1 == encoded_bytes
                    && raw_codes.len() - before == gate_count
                {
                    continue;
                }
                return Err(Level3N0sError::InvalidRadial {
                    radial: radial_index,
                    reason: "invalid RLE padding",
                });
            }
            if raw_codes.len() - before + run > gate_count {
                return Err(Level3N0sError::InvalidRadial {
                    radial: radial_index,
                    reason: "RLE does not match declared bin count",
                });
            }
            for _ in 0..run {
                raw_codes.push(category as u16);
                match category {
                    0 => {
                        values.push(0.0);
                        statuses.push(GateStatus::BelowThreshold);
                    }
                    15 => {
                        values.push(0.0);
                        statuses.push(GateStatus::RangeFolded);
                    }
                    _ => {
                        values.push(thresholds[category]);
                        statuses.push(GateStatus::Valid);
                    }
                }
            }
        }
        if raw_codes.len() - before != gate_count {
            return Err(Level3N0sError::InvalidRadial {
                radial: radial_index,
                reason: "RLE does not match declared bin count",
            });
        }
        cursor += encoded_bytes;
        radials.push(RadialMetadata {
            source_azimuth_number: u16::try_from(radial_index + 1)
                .expect("bounded radial count fits u16"),
            azimuth_degrees: (start_degrees + beam_width_degrees / 2.0) % 360.0,
            beam_width_degrees,
            elevation_degrees,
            collected_at_unix_ms: product_at_unix_ms,
        });
    }
    if cursor != layer_end {
        return Err(Level3N0sError::InvalidSymbology(
            "radial packet does not consume its layer",
        ));
    }

    // AF1F packets may begin at any azimuth. The renderer contract is sorted
    // clockwise, so rotate/reorder whole radial rows without changing the
    // source azimuth number or any gate category.
    let mut order: Vec<usize> = (0..radial_count).collect();
    order.sort_by(|left, right| {
        radials[*left]
            .azimuth_degrees
            .total_cmp(&radials[*right].azimuth_degrees)
    });
    for pair in order.windows(2) {
        if radials[pair[0]].azimuth_degrees == radials[pair[1]].azimuth_degrees {
            return Err(Level3N0sError::InvalidMetadata("duplicate radial azimuth"));
        }
    }
    let sorted_radials = order
        .iter()
        .map(|index| radials[*index].clone())
        .collect::<Vec<_>>();
    let mut sorted_values = Vec::with_capacity(cell_count);
    let mut sorted_statuses = Vec::with_capacity(cell_count);
    let mut sorted_raw_codes = Vec::with_capacity(cell_count);
    for radial_index in order {
        let start = radial_index * gate_count;
        let end = start + gate_count;
        sorted_values.extend_from_slice(&values[start..end]);
        sorted_statuses.extend_from_slice(&statuses[start..end]);
        sorted_raw_codes.extend_from_slice(&raw_codes[start..end]);
    }
    radials = sorted_radials;
    values = sorted_values;
    statuses = sorted_statuses;
    raw_codes = sorted_raw_codes;

    let source_sha256 = format!("{:x}", Sha256::digest(input));
    let site_altitude_m = (f32::from(height_ft) * 0.3048).round();
    if !site_altitude_m.is_finite()
        || site_altitude_m < f32::from(i16::MIN)
        || site_altitude_m > f32::from(i16::MAX)
    {
        return Err(Level3N0sError::InvalidMetadata("site height"));
    }
    let first_gate_center_m = u32::try_from(first_bin)
        .expect("nonnegative first bin")
        .checked_mul(1_000)
        .and_then(|start| start.checked_add(range_scale_m.div_ceil(2)))
        .ok_or(Level3N0sError::InvalidMetadata("first gate range"))?;
    Ok(DecodeOutput {
        sweep: NormalizedSweep {
            schema_version: NORMALIZED_SWEEP_SCHEMA_VERSION,
            source_kind: "nexrad_level3_n0s",
            source_sha256,
            site: RadarSite {
                icao: expected_site.to_string(),
                latitude_degrees,
                longitude_degrees,
                site_altitude_m: site_altitude_m as i16,
                tower_height_m: 0,
            },
            product: RadarProduct::StormRelativeVelocity,
            units: RadarProduct::StormRelativeVelocity.units(),
            volume_started_at_unix_ms,
            volume_ended_at_unix_ms: product_at_unix_ms,
            sweep_started_at_unix_ms: volume_started_at_unix_ms,
            sweep_ended_at_unix_ms: product_at_unix_ms,
            elevation_number,
            elevation_degrees,
            vcp,
            gate_count,
            gate_spacing_m: range_scale_m,
            first_gate_center_m,
            data_word_size_bits: 8,
            scale: 1.0,
            offset: 0.0,
            radials,
            values,
            statuses,
            raw_codes,
        },
        evidence: DecodeEvidence {
            decoder: "mistr-level3-n0s=1;oracle=nexrad-level-3-data@0.6.1".into(),
            compressed_input_bytes: input.len(),
            archive_bytes: input.len(),
            ldm_record_count: 0,
            preflight_decompressed_bytes: input.len() as u64,
        },
    })
}

fn decode_threshold(category: usize, word: u16) -> Result<f32, Level3N0sError> {
    match (word >> 8, word & 0xff) {
        (0x80, 0x02 | 0x03) => Ok(0.0),
        (0x00, magnitude) => Ok(magnitude as f32),
        (0x01, magnitude) => Ok(-(magnitude as f32)),
        (0x02, magnitude) => Ok(magnitude as f32),
        _ => Err(Level3N0sError::UnsupportedThreshold { category, word }),
    }
}

fn level3_time(date: u16, seconds: u32) -> Result<i64, Level3N0sError> {
    if date == 0 || seconds >= 86_400 {
        return Err(Level3N0sError::InvalidMetadata("Julian date/time"));
    }
    let unix_seconds = i64::from(date - 1)
        .checked_mul(86_400)
        .and_then(|value| value.checked_add(i64::from(seconds)))
        .ok_or(Level3N0sError::InvalidMetadata("Julian date/time overflow"))?;
    DateTime::<Utc>::from_timestamp(unix_seconds, 0)
        .map(|value| value.timestamp_millis())
        .ok_or(Level3N0sError::InvalidMetadata("Julian date/time range"))
}

fn need(input: &[u8], offset: usize, length: usize) -> Result<(), Level3N0sError> {
    let end = offset
        .checked_add(length)
        .ok_or(Level3N0sError::Truncated {
            offset,
            needed: length,
            available: input.len().saturating_sub(offset),
        })?;
    if end > input.len() {
        return Err(Level3N0sError::Truncated {
            offset,
            needed: length,
            available: input.len().saturating_sub(offset),
        });
    }
    Ok(())
}

fn ascii(input: &[u8], offset: usize, length: usize) -> Result<&str, Level3N0sError> {
    need(input, offset, length)?;
    std::str::from_utf8(&input[offset..offset + length])
        .map_err(|_| Level3N0sError::InvalidTextHeader("non-ASCII identifier"))
}

fn be_u16(input: &[u8], offset: usize) -> Result<u16, Level3N0sError> {
    need(input, offset, 2)?;
    Ok(u16::from_be_bytes([input[offset], input[offset + 1]]))
}

fn be_i16(input: &[u8], offset: usize) -> Result<i16, Level3N0sError> {
    Ok(be_u16(input, offset)? as i16)
}

fn be_u32(input: &[u8], offset: usize) -> Result<u32, Level3N0sError> {
    need(input, offset, 4)?;
    Ok(u32::from_be_bytes(
        input[offset..offset + 4]
            .try_into()
            .expect("slice length checked"),
    ))
}

fn be_i32(input: &[u8], offset: usize) -> Result<i32, Level3N0sError> {
    Ok(be_u32(input, offset)? as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_bounded_product_56_radial_packet() {
        let bytes = example_n0s();
        let decoded = decode_level3_n0s(&bytes, "KTLX").expect("decode fixture");
        let sweep = decoded.sweep;
        assert_eq!(sweep.product, RadarProduct::StormRelativeVelocity);
        assert_eq!(sweep.units, "kt");
        assert_eq!(sweep.site.icao, "KTLX");
        assert_eq!(sweep.radial_count(), 2);
        assert_eq!(sweep.gate_count, 4);
        assert_eq!(sweep.gate_spacing_m, 1_000);
        assert_eq!(sweep.first_gate_center_m, 500);
        assert_eq!(sweep.raw_codes, vec![0, 1, 8, 15, 2, 7, 9, 14]);
        assert_eq!(
            sweep.values,
            vec![0.0, -64.0, 0.0, 0.0, -50.0, -1.0, 10.0, 64.0]
        );
        assert_eq!(
            sweep.statuses,
            vec![
                GateStatus::BelowThreshold,
                GateStatus::Valid,
                GateStatus::Valid,
                GateStatus::RangeFolded,
                GateStatus::Valid,
                GateStatus::Valid,
                GateStatus::Valid,
                GateStatus::Valid,
            ]
        );
        assert_eq!(sweep.volume_started_at_unix_ms, 1_716_246_312_000);
    }

    #[test]
    fn rejects_wrong_site_wrong_product_truncation_and_bad_rle() {
        let bytes = example_n0s();
        assert!(matches!(
            decode_level3_n0s(&bytes, "KOUN"),
            Err(Level3N0sError::SiteMismatch { .. })
        ));
        let mut wrong_product = bytes.clone();
        wrong_product[30..32].copy_from_slice(&57u16.to_be_bytes());
        assert_eq!(
            decode_level3_n0s(&wrong_product, "KTLX"),
            Err(Level3N0sError::UnsupportedProduct(57))
        );
        assert!(matches!(
            decode_level3_n0s(&bytes[..100], "KTLX"),
            Err(Level3N0sError::Truncated { .. })
        ));
        let mut bad_rle = bytes;
        bad_rle[186] = 0x51;
        assert!(matches!(
            decode_level3_n0s(&bad_rle, "KTLX"),
            Err(Level3N0sError::InvalidRadial { .. })
        ));

        let mut wrong_length = example_n0s();
        put_u32(&mut wrong_length, TEXT_HEADER_BYTES + 8, 1);
        assert_eq!(
            decode_level3_n0s(&wrong_length, "KTLX"),
            Err(Level3N0sError::InvalidMetadata("message length"))
        );
    }

    fn example_n0s() -> Vec<u8> {
        let description = TEXT_HEADER_BYTES + MESSAGE_HEADER_BYTES;
        let symbology = description + PRODUCT_DESCRIPTION_BYTES;
        let packet = symbology + 16;
        let mut bytes = vec![0u8; packet + 14 + 8 + 8];
        bytes[0..30].copy_from_slice(b"SDUS54 KOUN 202305\r\r\nN0STLX\r\r\n");
        put_u16(&mut bytes, 30, PRODUCT_CODE_N0S);
        put_i16(&mut bytes, description, -1);
        put_i32(&mut bytes, description + 2, 35_333);
        put_i32(&mut bytes, description + 6, -97_278);
        put_i16(&mut bytes, description + 10, 1_277);
        put_u16(&mut bytes, description + 12, PRODUCT_CODE_N0S);
        put_u16(&mut bytes, description + 16, 35);
        put_u16(&mut bytes, description + 22, 19_864);
        put_u32(&mut bytes, description + 24, 83_112);
        put_u16(&mut bytes, description + 28, 19_864);
        put_u32(&mut bytes, description + 30, 83_214);
        put_u16(&mut bytes, description + 38, 1);
        put_i16(&mut bytes, description + 40, 5);
        let words = [
            0x8002, 0x0140, 0x0132, 0x0124, 0x011a, 0x0114, 0x010a, 0x0101, 0x0000, 0x020a, 0x0214,
            0x021a, 0x0224, 0x0232, 0x0240, 0x8003,
        ];
        for (index, word) in words.into_iter().enumerate() {
            put_u16(&mut bytes, description + 42 + index * 2, word);
        }
        put_u32(
            &mut bytes,
            description + 90,
            ((symbology - TEXT_HEADER_BYTES) / 2) as u32,
        );
        put_i16(&mut bytes, symbology, -1);
        put_u16(&mut bytes, symbology + 2, 1);
        let block_length = (bytes.len() - symbology) as u32;
        put_u32(&mut bytes, symbology + 4, block_length);
        put_u16(&mut bytes, symbology + 8, 1);
        put_i16(&mut bytes, symbology + 10, -1);
        let layer_length = (bytes.len() - packet) as u32;
        put_u32(&mut bytes, symbology + 12, layer_length);
        put_u16(&mut bytes, packet, RADIAL_PACKET_16_LEVEL);
        put_u16(&mut bytes, packet + 4, 4);
        put_u16(&mut bytes, packet + 10, 1_000);
        put_u16(&mut bytes, packet + 12, 2);
        let first = packet + 14;
        put_u16(&mut bytes, first, 1);
        put_u16(&mut bytes, first + 2, 0);
        put_u16(&mut bytes, first + 4, 10);
        bytes[first + 6] = 0x10;
        bytes[first + 7] = 0x11;
        // Each RLE byte expands to one bin; packet lengths are even bytes.
        bytes[first + 6] = 0x20;
        bytes[first + 7] = 0x18;
        let second = first + 8;
        put_u16(&mut bytes, second, 1);
        put_u16(&mut bytes, second + 2, 10);
        put_u16(&mut bytes, second + 4, 10);
        bytes[second + 6] = 0x12;
        bytes[second + 7] = 0x17;
        // Rewrite the two compact streams to four one-bin categories each.
        // Two halfwords (four bytes) are required per radial.
        bytes.resize(packet + 14 + 10 + 10, 0);
        let first = packet + 14;
        put_u16(&mut bytes, first, 2);
        put_u16(&mut bytes, first + 2, 0);
        put_u16(&mut bytes, first + 4, 10);
        bytes[first + 6..first + 10].copy_from_slice(&[0x10, 0x11, 0x18, 0x1f]);
        let second = first + 10;
        put_u16(&mut bytes, second, 2);
        put_u16(&mut bytes, second + 2, 10);
        put_u16(&mut bytes, second + 4, 10);
        bytes[second + 6..second + 10].copy_from_slice(&[0x12, 0x17, 0x19, 0x1e]);
        let block_length = (bytes.len() - symbology) as u32;
        let layer_length = (bytes.len() - packet) as u32;
        put_u32(&mut bytes, symbology + 4, block_length);
        put_u32(&mut bytes, symbology + 12, layer_length);
        let message_length = (bytes.len() - TEXT_HEADER_BYTES) as u32;
        put_u32(&mut bytes, TEXT_HEADER_BYTES + 8, message_length);
        bytes
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
}
