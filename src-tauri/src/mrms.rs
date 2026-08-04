//! Fixed-product NOAA MRMS acquisition and strict GRIB2/PNG decoding.
//!
//! This is intentionally not a general GRIB decoder. National Phase 2 accepts
//! only the reviewed CONUS MergedBaseReflectivityQC_00.50 contract and fails
//! closed when any structural field changes.

use chrono::{
    DateTime, Duration as ChronoDuration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike,
    Utc,
};
use flate2::bufread::GzDecoder;
use quick_xml::{Reader, events::Event};
use reqwest::{Client, Url, header::CONTENT_TYPE, redirect::Policy};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::io::{Cursor, Read};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use thiserror::Error;

pub const MRMS_HOST: &str = "noaa-mrms-pds.s3.amazonaws.com";
pub const MRMS_BASE: &str = "https://noaa-mrms-pds.s3.amazonaws.com/";
pub const MRMS_DOMAIN: &str = "conus";
pub const MRMS_PRODUCT: &str = "MergedBaseReflectivityQC_00.50";
pub const MRMS_PREFIX_ROOT: &str = "CONUS/MergedBaseReflectivityQC_00.50";
pub const MRMS_WIDTH: u32 = 7_000;
pub const MRMS_HEIGHT: u32 = 3_500;
pub const MRMS_CELL_COUNT: usize = MRMS_WIDTH as usize * MRMS_HEIGHT as usize;
pub const MRMS_COMPRESSED_LIMIT: usize = 16 * 1024 * 1024;
pub const MRMS_GRIB_LIMIT: usize = 16 * 1024 * 1024;
pub const MRMS_PNG_LIMIT: usize = 16 * 1024 * 1024;
pub const MRMS_NORMALIZED_BYTES: usize = MRMS_CELL_COUNT * 2;
pub const MRMS_LIST_LIMIT: usize = 2 * 1024 * 1024;
pub const MRMS_MISSING_RAW: u16 = 9_000;
pub const MRMS_NO_COVERAGE_RAW: u16 = 0;
pub const MRMS_REFERENCE_VALUE: f32 = -9_990.0;
pub const MRMS_BINARY_SCALE: i16 = 0;
pub const MRMS_DECIMAL_SCALE: i16 = 1;
pub const MRMS_BIT_DEPTH: u8 = 16;

const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_LISTED_OBJECTS: usize = 1_000;

#[derive(Debug, Error)]
pub enum MrmsError {
    #[error("MRMS URL is invalid: {0}")]
    InvalidUrl(String),
    #[error("MRMS request failed: {0}")]
    Request(String),
    #[error("MRMS endpoint returned HTTP {0}")]
    HttpStatus(u16),
    #[error("MRMS response declared {actual} bytes; limit is {limit}")]
    ResponseTooLarge { actual: u64, limit: usize },
    #[error("MRMS response exceeded the {limit}-byte streaming limit")]
    ResponseStreamTooLarge { limit: usize },
    #[error("MRMS inventory is invalid: {0}")]
    InvalidInventory(String),
    #[error("MRMS object key is invalid: {0}")]
    InvalidObjectKey(String),
    #[error("MRMS object body is invalid: {0}")]
    InvalidBody(String),
    #[error("MRMS gzip stream is invalid: {0}")]
    InvalidGzip(String),
    #[error("MRMS GRIB2 structure is unsupported: {0}")]
    UnsupportedGrib(String),
    #[error("MRMS PNG payload is unsupported: {0}")]
    UnsupportedPng(String),
    #[error("MRMS observation is not strictly newer than the retained observation")]
    NotStrictlyNewer,
}

impl MrmsError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidUrl(_) => "mrms_invalid_url",
            Self::Request(_) => "mrms_request_failed",
            Self::HttpStatus(_) => "mrms_http_status",
            Self::ResponseTooLarge { .. } | Self::ResponseStreamTooLarge { .. } => {
                "mrms_response_too_large"
            }
            Self::InvalidInventory(_) => "mrms_invalid_inventory",
            Self::InvalidObjectKey(_) => "mrms_invalid_object_key",
            Self::InvalidBody(_) => "mrms_invalid_body",
            Self::InvalidGzip(_) => "mrms_invalid_gzip",
            Self::UnsupportedGrib(_) => "mrms_unsupported_grib",
            Self::UnsupportedPng(_) => "mrms_unsupported_png",
            Self::NotStrictlyNewer => "mrms_not_strictly_newer",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrmsAcquisitionCounters {
    pub network_requests: u64,
    pub response_bytes: u64,
}

#[derive(Debug, Default)]
struct CounterState {
    network_requests: AtomicU64,
    response_bytes: AtomicU64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrmsObject {
    pub key: String,
    pub observation_time_unix_ms: i64,
    pub last_modified_unix_ms: i64,
    pub size_bytes: usize,
    pub etag: Option<String>,
}

impl MrmsObject {
    pub fn parse_key(key: &str) -> Result<i64, MrmsError> {
        parse_object_key(key).map(|time| time.timestamp_millis())
    }
}

#[derive(Debug, Clone)]
pub struct DownloadedMrmsObject {
    pub object: MrmsObject,
    pub compressed_bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MrmsRowOrientation {
    NorthToSouth,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrmsGridDefinition {
    pub width: u32,
    pub height: u32,
    pub first_latitude_degrees: f64,
    pub first_longitude_degrees: f64,
    pub last_latitude_degrees: f64,
    pub last_longitude_degrees: f64,
    pub longitude_step_degrees: f64,
    pub latitude_step_degrees: f64,
    pub row_orientation: MrmsRowOrientation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrmsValueEncoding {
    pub bit_depth: u8,
    pub reference_value_bits: u32,
    pub binary_scale: i16,
    pub decimal_scale: i16,
    pub missing_raw: u16,
    pub no_coverage_raw: u16,
}

impl MrmsValueEncoding {
    pub fn reference_value(self) -> f32 {
        f32::from_bits(self.reference_value_bits)
    }

    pub fn decode_raw(self, raw: u16) -> MrmsCellValue {
        if raw == self.missing_raw {
            return MrmsCellValue::Missing;
        }
        if raw == self.no_coverage_raw {
            return MrmsCellValue::NoCoverage;
        }
        let numerator = self.reference_value() as f64
            + f64::from(raw) * 2_f64.powi(i32::from(self.binary_scale));
        let value = numerator / 10_f64.powi(i32::from(self.decimal_scale));
        MrmsCellValue::Valid(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MrmsCellValue {
    Valid(f64),
    Missing,
    NoCoverage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrmsDecodeEvidence {
    pub provider: &'static str,
    pub object_key: String,
    pub observation_time_unix_ms: i64,
    pub compressed_bytes: usize,
    pub grib_bytes: usize,
    pub png_bytes: usize,
    pub normalized_bytes: usize,
    pub compressed_sha256: String,
    pub grib_sha256: String,
    pub normalized_sha256: String,
}

#[derive(Debug, Clone)]
pub struct DecodedMrmsGrid {
    pub object: MrmsObject,
    pub grid: MrmsGridDefinition,
    pub encoding: MrmsValueEncoding,
    pub raw_codes: Vec<u16>,
    pub evidence: MrmsDecodeEvidence,
}

#[derive(Debug, Clone)]
pub struct MrmsClient {
    http: Client,
    counters: Arc<CounterState>,
}

impl MrmsClient {
    pub fn new() -> Result<Self, MrmsError> {
        let http = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(HTTP_TIMEOUT)
            .redirect(Policy::none())
            .user_agent("Mistr/0.0.1 (+https://github.com/tcurtsinger/Mistr)")
            .build()
            .map_err(|error| MrmsError::Request(error.to_string()))?;
        Ok(Self {
            http,
            counters: Arc::default(),
        })
    }

    pub fn counters(&self) -> MrmsAcquisitionCounters {
        MrmsAcquisitionCounters {
            network_requests: self.counters.network_requests.load(Ordering::Relaxed),
            response_bytes: self.counters.response_bytes.load(Ordering::Relaxed),
        }
    }

    pub async fn discover_newest(
        &self,
        now: DateTime<Utc>,
        newer_than_unix_ms: Option<i64>,
    ) -> Result<MrmsObject, MrmsError> {
        let mut newest = self.discover_latest_count(now, 1).await?;
        let newest = newest.pop().expect("one requested MRMS object");
        ensure_strictly_newer(newest, newer_than_unix_ms)
    }

    pub async fn discover_latest_count(
        &self,
        now: DateTime<Utc>,
        count: usize,
    ) -> Result<Vec<MrmsObject>, MrmsError> {
        if !(1..=30).contains(&count) {
            return Err(MrmsError::InvalidInventory(
                "requested history count must be in 1..=30".into(),
            ));
        }
        let mut candidates = self.discover_latest_up_to(now, count).await?;
        if candidates.len() < count {
            return Err(MrmsError::InvalidInventory(format!(
                "current and previous UTC prefixes contain {} valid objects; {count} required",
                candidates.len()
            )));
        }
        Ok(candidates.split_off(candidates.len() - count))
    }

    /// Returns as many as `count` current observations as are safely available,
    /// while still requiring at least one exact object. Product startup uses
    /// this bounded form so a temporarily short prior-day inventory can paint
    /// the newest observation and report partial history truthfully.
    pub async fn discover_latest_up_to(
        &self,
        now: DateTime<Utc>,
        count: usize,
    ) -> Result<Vec<MrmsObject>, MrmsError> {
        if !(1..=30).contains(&count) {
            return Err(MrmsError::InvalidInventory(
                "requested history count must be in 1..=30".into(),
            ));
        }
        let current_date = now.date_naive();
        let mut candidates = self.list_day(current_date).await?;
        reject_future_objects(&mut candidates, now);
        if candidates.len() < count || now.hour() == 0 {
            let previous = current_date
                .checked_sub_signed(ChronoDuration::days(1))
                .ok_or_else(|| MrmsError::InvalidInventory("UTC date underflow".into()))?;
            let mut previous_candidates = self.list_day(previous).await?;
            reject_future_objects(&mut previous_candidates, now);
            candidates.extend(previous_candidates);
        }
        candidates.sort_by_key(|object| (object.observation_time_unix_ms, object.key.clone()));
        candidates.dedup_by(|left, right| left.key == right.key);
        if candidates.is_empty() {
            return Err(MrmsError::InvalidInventory(
                "current and previous UTC prefixes contain no valid objects".into(),
            ));
        }
        if candidates.len() > count {
            candidates = candidates.split_off(candidates.len() - count);
        }
        Ok(candidates)
    }

    pub async fn list_day(&self, date: NaiveDate) -> Result<Vec<MrmsObject>, MrmsError> {
        let prefix = format!("{MRMS_PREFIX_ROOT}/{}/", date.format("%Y%m%d"));
        let mut url = fixed_mrms_url()?;
        url.query_pairs_mut()
            .append_pair("list-type", "2")
            .append_pair("prefix", &prefix)
            .append_pair("max-keys", &MAX_LISTED_OBJECTS.to_string());
        let bytes = self
            .fetch_bounded(url, MRMS_LIST_LIMIT, ExpectedBody::Xml)
            .await?;
        parse_inventory(&bytes, &prefix)
    }

    pub async fn download(&self, object: &MrmsObject) -> Result<DownloadedMrmsObject, MrmsError> {
        let parsed_time = MrmsObject::parse_key(&object.key)?;
        if parsed_time != object.observation_time_unix_ms {
            return Err(MrmsError::InvalidObjectKey(
                "inventory observation time does not match its exact key".into(),
            ));
        }
        if object.size_bytes == 0 || object.size_bytes > MRMS_COMPRESSED_LIMIT {
            return Err(MrmsError::ResponseTooLarge {
                actual: object.size_bytes as u64,
                limit: MRMS_COMPRESSED_LIMIT,
            });
        }
        let url = mrms_object_url(&object.key)?;
        let bytes = self
            .fetch_bounded(url, MRMS_COMPRESSED_LIMIT, ExpectedBody::Binary)
            .await?;
        if bytes.len() != object.size_bytes {
            return Err(MrmsError::InvalidBody(format!(
                "{} declared {} bytes but returned {}",
                object.key,
                object.size_bytes,
                bytes.len()
            )));
        }
        if !bytes.starts_with(&[0x1f, 0x8b]) {
            return Err(MrmsError::InvalidBody(
                "HTTP 200 body is not a gzip stream".into(),
            ));
        }
        Ok(DownloadedMrmsObject {
            object: object.clone(),
            compressed_bytes: bytes,
        })
    }

    async fn fetch_bounded(
        &self,
        url: Url,
        limit: usize,
        expected: ExpectedBody,
    ) -> Result<Vec<u8>, MrmsError> {
        ensure_fixed_mrms_url(&url)?;
        self.counters
            .network_requests
            .fetch_add(1, Ordering::Relaxed);
        let mut response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|error| MrmsError::Request(error.to_string()))?;
        if !response.status().is_success() {
            return Err(MrmsError::HttpStatus(response.status().as_u16()));
        }
        if let Some(length) = response.content_length()
            && length > limit as u64
        {
            return Err(MrmsError::ResponseTooLarge {
                actual: length,
                limit,
            });
        }
        validate_content_type(response.headers().get(CONTENT_TYPE), expected)?;
        let mut bytes = Vec::with_capacity(
            response
                .content_length()
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(0)
                .min(limit),
        );
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| MrmsError::Request(error.to_string()))?
        {
            let next = bytes
                .len()
                .checked_add(chunk.len())
                .filter(|length| *length <= limit)
                .ok_or(MrmsError::ResponseStreamTooLarge { limit })?;
            bytes.reserve(next - bytes.len());
            bytes.extend_from_slice(&chunk);
        }
        if expected == ExpectedBody::Xml && !looks_like_s3_xml(&bytes) {
            return Err(MrmsError::InvalidInventory(
                "HTTP 200 inventory body is not S3 XML".into(),
            ));
        }
        if expected == ExpectedBody::Binary && looks_like_markup(&bytes) {
            return Err(MrmsError::InvalidBody(
                "HTTP 200 object body is HTML or XML rather than GRIB gzip data".into(),
            ));
        }
        self.counters
            .response_bytes
            .fetch_add(bytes.len() as u64, Ordering::Relaxed);
        Ok(bytes)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExpectedBody {
    Xml,
    Binary,
}

fn validate_content_type(
    value: Option<&reqwest::header::HeaderValue>,
    expected: ExpectedBody,
) -> Result<(), MrmsError> {
    let Some(value) = value else {
        return Ok(());
    };
    let content_type = value
        .to_str()
        .map_err(|_| MrmsError::InvalidBody("Content-Type is not ASCII".into()))?
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let allowed = match expected {
        ExpectedBody::Xml => matches!(content_type.as_str(), "application/xml" | "text/xml"),
        ExpectedBody::Binary => matches!(
            content_type.as_str(),
            "application/octet-stream"
                | "binary/octet-stream"
                | "application/gzip"
                | "application/x-gzip"
        ),
    };
    allowed
        .then_some(())
        .ok_or_else(|| MrmsError::InvalidBody(format!("unexpected Content-Type {content_type:?}")))
}

pub fn decode_download(download: DownloadedMrmsObject) -> Result<DecodedMrmsGrid, MrmsError> {
    decode_mrms_gzip(&download.compressed_bytes, download.object)
}

pub fn decode_mrms_gzip(
    compressed: &[u8],
    object: MrmsObject,
) -> Result<DecodedMrmsGrid, MrmsError> {
    if compressed.is_empty() || compressed.len() > MRMS_COMPRESSED_LIMIT {
        return Err(MrmsError::ResponseTooLarge {
            actual: compressed.len() as u64,
            limit: MRMS_COMPRESSED_LIMIT,
        });
    }
    if !compressed.starts_with(&[0x1f, 0x8b]) {
        return Err(MrmsError::InvalidGzip("missing gzip signature".into()));
    }
    let compressed_sha256 = sha256_hex(compressed);
    let mut decoder = GzDecoder::new(compressed);
    let mut grib = Vec::new();
    decoder
        .by_ref()
        .take((MRMS_GRIB_LIMIT + 1) as u64)
        .read_to_end(&mut grib)
        .map_err(|error| MrmsError::InvalidGzip(error.to_string()))?;
    if grib.len() > MRMS_GRIB_LIMIT {
        return Err(MrmsError::ResponseStreamTooLarge {
            limit: MRMS_GRIB_LIMIT,
        });
    }
    if !decoder.get_ref().is_empty() {
        return Err(MrmsError::InvalidGzip(
            "gzip body contains a trailing member or bytes".into(),
        ));
    }
    if !grib.starts_with(b"GRIB") {
        return Err(MrmsError::InvalidBody(
            "expanded HTTP 200 body is not GRIB2".into(),
        ));
    }
    let grib_sha256 = sha256_hex(&grib);
    let parsed = parse_strict_grib(&grib, &object)?;
    let raw_codes = decode_png_codes(parsed.png_bytes)?;
    let normalized_sha256 = sha256_u16_be(&raw_codes);
    Ok(DecodedMrmsGrid {
        object: object.clone(),
        grid: parsed.grid,
        encoding: parsed.encoding,
        evidence: MrmsDecodeEvidence {
            provider: MRMS_HOST,
            object_key: object.key,
            observation_time_unix_ms: object.observation_time_unix_ms,
            compressed_bytes: compressed.len(),
            grib_bytes: grib.len(),
            png_bytes: parsed.png_bytes.len(),
            normalized_bytes: raw_codes.len() * 2,
            compressed_sha256,
            grib_sha256,
            normalized_sha256,
        },
        raw_codes,
    })
}

struct ParsedGrib<'a> {
    grid: MrmsGridDefinition,
    encoding: MrmsValueEncoding,
    png_bytes: &'a [u8],
}

fn parse_strict_grib<'a>(
    bytes: &'a [u8],
    object: &MrmsObject,
) -> Result<ParsedGrib<'a>, MrmsError> {
    if bytes.len() < 20 || &bytes[..4] != b"GRIB" {
        return Err(unsupported("missing GRIB indicator"));
    }
    if bytes[4..6] != [0, 0] || bytes[6] != 209 || bytes[7] != 2 {
        return Err(unsupported(
            "indicator must be reserved=0, discipline=209, edition=2",
        ));
    }
    let declared = read_u64(bytes, 8)?;
    if declared != bytes.len() as u64 {
        return Err(unsupported(
            "declared GRIB message length does not match complete body",
        ));
    }
    if &bytes[bytes.len() - 4..] != b"7777" {
        return Err(unsupported("message trailer is missing"));
    }

    let mut offset = 16usize;
    let mut sections = Vec::with_capacity(7);
    while offset < bytes.len() - 4 {
        let length = usize::try_from(read_u32(bytes, offset)?)
            .map_err(|_| unsupported("section length cannot fit memory"))?;
        if length < 5 {
            return Err(unsupported("section length is smaller than its header"));
        }
        let end = offset
            .checked_add(length)
            .filter(|end| *end <= bytes.len() - 4)
            .ok_or_else(|| unsupported("section length crosses the message trailer"))?;
        sections.push((bytes[offset + 4], &bytes[offset..end]));
        offset = end;
    }
    if offset != bytes.len() - 4 {
        return Err(unsupported(
            "message contains trailing bytes before its trailer",
        ));
    }
    let actual: Vec<u8> = sections.iter().map(|(number, _)| *number).collect();
    if actual != [1, 3, 4, 5, 6, 7] {
        return Err(unsupported(format!(
            "section order {actual:?} is not [1, 3, 4, 5, 6, 7]"
        )));
    }

    let observation_time = validate_section1(sections[0].1)?;
    let key_time = parse_object_key(&object.key)?;
    if observation_time != key_time
        || observation_time.timestamp_millis() != object.observation_time_unix_ms
    {
        return Err(unsupported(
            "filename, inventory, and GRIB observation times disagree",
        ));
    }
    let grid = validate_section3(sections[1].1)?;
    validate_section4(sections[2].1)?;
    let encoding = validate_section5(sections[3].1)?;
    validate_section6(sections[4].1)?;
    let section7 = sections[5].1;
    if section7.len() <= 5 || section7.len() - 5 > MRMS_PNG_LIMIT {
        return Err(unsupported(
            "PNG section is empty or exceeds its byte bound",
        ));
    }
    Ok(ParsedGrib {
        grid,
        encoding,
        png_bytes: &section7[5..],
    })
}

fn validate_section1(section: &[u8]) -> Result<DateTime<Utc>, MrmsError> {
    if section.len() != 21 {
        return Err(unsupported("identification section length changed"));
    }
    if read_u16(section, 5)? != 161
        || read_u16(section, 7)? != 0
        || section[9] != 255
        || section[10] != 1
        || section[11] != 3
        || section[19] != 2
        || section[20] != 7
    {
        return Err(unsupported(
            "identification centre/table/status/type contract changed",
        ));
    }
    let year = i32::from(read_u16(section, 12)?);
    Utc.with_ymd_and_hms(
        year,
        u32::from(section[14]),
        u32::from(section[15]),
        u32::from(section[16]),
        u32::from(section[17]),
        u32::from(section[18]),
    )
    .single()
    .ok_or_else(|| unsupported("identification time is not valid UTC"))
}

fn validate_section3(section: &[u8]) -> Result<MrmsGridDefinition, MrmsError> {
    if section.len() != 72 {
        return Err(unsupported("grid definition section length changed"));
    }
    let exact = section[5] == 0
        && read_u32(section, 6)? == MRMS_CELL_COUNT as u32
        && section[10] == 0
        && section[11] == 0
        && read_u16(section, 12)? == 0
        && section[14] == 2
        && section[15] == 1
        && read_u32(section, 16)? == 6_367_470
        && section[20] == 1
        && read_u32(section, 21)? == 6_378_160
        && section[25] == 1
        && read_u32(section, 26)? == 6_356_775
        && read_u32(section, 30)? == MRMS_WIDTH
        && read_u32(section, 34)? == MRMS_HEIGHT
        && read_u32(section, 38)? == 1
        && read_u32(section, 42)? == 1_000_000
        && read_u32(section, 46)? == 54_995_000
        && read_u32(section, 50)? == 230_005_000
        && section[54] == 48
        && read_u32(section, 55)? == 20_005_001
        && read_u32(section, 59)? == 299_994_998
        && read_u32(section, 63)? == 10_000
        && read_u32(section, 67)? == 10_000
        && section[71] == 0;
    if !exact {
        return Err(unsupported(
            "regular latitude/longitude CONUS grid contract changed",
        ));
    }
    Ok(MrmsGridDefinition {
        width: MRMS_WIDTH,
        height: MRMS_HEIGHT,
        first_latitude_degrees: 54.995,
        first_longitude_degrees: -129.995,
        last_latitude_degrees: 20.005001,
        last_longitude_degrees: -60.005002,
        longitude_step_degrees: 0.01,
        latitude_step_degrees: 0.01,
        row_orientation: MrmsRowOrientation::NorthToSouth,
    })
}

fn validate_section4(section: &[u8]) -> Result<(), MrmsError> {
    if section.len() != 34 {
        return Err(unsupported("product definition section length changed"));
    }
    let exact = read_u16(section, 5)? == 0
        && read_u16(section, 7)? == 0
        && section[9] == 11
        && section[10] == 0
        && section[11] == 8
        && section[12] == 0
        && section[13] == 97
        && read_u16(section, 14)? == 0
        && section[16] == 0
        && section[17] == 0
        && read_u32(section, 18)? == 0
        && section[22] == 102
        && section[23] == 0
        && read_u32(section, 24)? == 500
        && section[28] == 255
        && section[29] == 1
        && read_u32(section, 30)? == 0;
    exact
        .then_some(())
        .ok_or_else(|| unsupported("MergedBaseReflectivityQC_00.50 product definition changed"))
}

fn validate_section5(section: &[u8]) -> Result<MrmsValueEncoding, MrmsError> {
    if section.len() != 21 {
        return Err(unsupported("data representation section length changed"));
    }
    let reference_bits = read_u32(section, 11)?;
    let exact = read_u32(section, 5)? == MRMS_CELL_COUNT as u32
        && read_u16(section, 9)? == 41
        && f32::from_bits(reference_bits) == MRMS_REFERENCE_VALUE
        && read_i16(section, 15)? == MRMS_BINARY_SCALE
        && read_i16(section, 17)? == MRMS_DECIMAL_SCALE
        && section[19] == MRMS_BIT_DEPTH
        && section[20] == 0;
    if !exact {
        return Err(unsupported(
            "PNG packing/scaling/bit-depth contract changed",
        ));
    }
    Ok(MrmsValueEncoding {
        bit_depth: MRMS_BIT_DEPTH,
        reference_value_bits: reference_bits,
        binary_scale: MRMS_BINARY_SCALE,
        decimal_scale: MRMS_DECIMAL_SCALE,
        missing_raw: MRMS_MISSING_RAW,
        no_coverage_raw: MRMS_NO_COVERAGE_RAW,
    })
}

fn validate_section6(section: &[u8]) -> Result<(), MrmsError> {
    if section == [0, 0, 0, 6, 6, 255] {
        Ok(())
    } else {
        Err(unsupported("bitmap section must declare no bitmap"))
    }
}

fn decode_png_codes(png_bytes: &[u8]) -> Result<Vec<u16>, MrmsError> {
    if png_bytes.len() > MRMS_PNG_LIMIT || !png_bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(MrmsError::UnsupportedPng(
            "section 7 does not contain a bounded PNG signature".into(),
        ));
    }
    let mut decoder = png::Decoder::new(Cursor::new(png_bytes));
    decoder.set_transformations(png::Transformations::IDENTITY);
    decoder.set_limits(png::Limits {
        bytes: MRMS_NORMALIZED_BYTES + 8 * 1024 * 1024,
    });
    let mut reader = decoder
        .read_info()
        .map_err(|error| MrmsError::UnsupportedPng(error.to_string()))?;
    let info = reader.info();
    if info.width != MRMS_WIDTH
        || info.height != MRMS_HEIGHT
        || info.color_type != png::ColorType::Grayscale
        || info.bit_depth != png::BitDepth::Sixteen
        || info.interlaced
        || info.animation_control.is_some()
    {
        return Err(MrmsError::UnsupportedPng(
            "PNG must be non-interlaced 7000x3500 16-bit grayscale with one frame".into(),
        ));
    }
    let output_size = reader
        .output_buffer_size()
        .ok_or_else(|| MrmsError::UnsupportedPng("PNG output size exceeds bounds".into()))?;
    if output_size != MRMS_NORMALIZED_BYTES {
        return Err(MrmsError::UnsupportedPng(format!(
            "PNG output is {output_size} bytes; expected {MRMS_NORMALIZED_BYTES}"
        )));
    }
    let mut output = vec![0u8; output_size];
    let frame = reader
        .next_frame(&mut output)
        .map_err(|error| MrmsError::UnsupportedPng(error.to_string()))?;
    if frame.buffer_size() != output_size {
        return Err(MrmsError::UnsupportedPng(
            "PNG frame did not completely fill the normalized grid".into(),
        ));
    }
    reader
        .finish()
        .map_err(|error| MrmsError::UnsupportedPng(error.to_string()))?;
    let mut raw_codes = Vec::with_capacity(MRMS_CELL_COUNT);
    for pair in output.chunks_exact(2) {
        raw_codes.push(u16::from_be_bytes([pair[0], pair[1]]));
    }
    if raw_codes.len() != MRMS_CELL_COUNT {
        return Err(MrmsError::UnsupportedPng(
            "decoded PNG cell count changed".into(),
        ));
    }
    Ok(raw_codes)
}

pub fn reduce_strongest_valid(
    source: &[u16],
    source_width: usize,
    source_height: usize,
    encoding: MrmsValueEncoding,
) -> Result<(Vec<u16>, usize, usize), MrmsError> {
    if source_width == 0
        || source_height == 0
        || source_width.checked_mul(source_height) != Some(source.len())
    {
        return Err(unsupported(
            "overview source dimensions do not match its cells",
        ));
    }
    let target_width = source_width.div_ceil(2);
    let target_height = source_height.div_ceil(2);
    let mut target = Vec::with_capacity(target_width * target_height);
    for target_y in 0..target_height {
        for target_x in 0..target_width {
            let mut strongest: Option<u16> = None;
            let mut saw_missing = false;
            for dy in 0..2 {
                let y = target_y * 2 + dy;
                if y >= source_height {
                    continue;
                }
                for dx in 0..2 {
                    let x = target_x * 2 + dx;
                    if x >= source_width {
                        continue;
                    }
                    let raw = source[y * source_width + x];
                    if raw == encoding.missing_raw {
                        saw_missing = true;
                    } else if raw != encoding.no_coverage_raw {
                        strongest = Some(strongest.map_or(raw, |current| current.max(raw)));
                    }
                }
            }
            target.push(strongest.unwrap_or(if saw_missing {
                encoding.missing_raw
            } else {
                encoding.no_coverage_raw
            }));
        }
    }
    Ok((target, target_width, target_height))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrmsPollDelay {
    pub attempt: u32,
    pub backoff_ms: u64,
    pub jitter_ms: u64,
    pub total_ms: u64,
}

pub fn bounded_poll_delay(attempt: u32, jitter_seed: u64) -> MrmsPollDelay {
    let exponent = attempt.min(3);
    let backoff_ms = 15_000u64.saturating_mul(1u64 << exponent).min(120_000);
    let jitter_ms = mix64(jitter_seed ^ u64::from(attempt)) % 5_001;
    MrmsPollDelay {
        attempt,
        backoff_ms,
        jitter_ms,
        total_ms: backoff_ms + jitter_ms,
    }
}

fn mix64(mut value: u64) -> u64 {
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn parse_object_key(key: &str) -> Result<DateTime<Utc>, MrmsError> {
    if !key.is_ascii() || key.len() > 180 {
        return Err(MrmsError::InvalidObjectKey(
            "key must be bounded ASCII".into(),
        ));
    }
    let rest = key
        .strip_prefix(&format!("{MRMS_PREFIX_ROOT}/"))
        .ok_or_else(|| MrmsError::InvalidObjectKey("prefix is not approved".into()))?;
    let (date_part, file) = rest
        .split_once('/')
        .ok_or_else(|| MrmsError::InvalidObjectKey("UTC date directory is missing".into()))?;
    if file.contains('/') {
        return Err(MrmsError::InvalidObjectKey(
            "key contains an unexpected nested path".into(),
        ));
    }
    let stamp = file
        .strip_prefix("MRMS_MergedBaseReflectivityQC_00.50_")
        .and_then(|value| value.strip_suffix(".grib2.gz"))
        .ok_or_else(|| MrmsError::InvalidObjectKey("filename pattern is not approved".into()))?;
    if stamp.len() != 15 || stamp.as_bytes()[8] != b'-' {
        return Err(MrmsError::InvalidObjectKey(
            "filename timestamp must be YYYYMMDD-HHMMSS".into(),
        ));
    }
    let date = NaiveDate::parse_from_str(&stamp[..8], "%Y%m%d")
        .map_err(|error| MrmsError::InvalidObjectKey(error.to_string()))?;
    if date.format("%Y%m%d").to_string() != date_part {
        return Err(MrmsError::InvalidObjectKey(
            "date directory and filename timestamp disagree".into(),
        ));
    }
    let time = NaiveTime::parse_from_str(&stamp[9..], "%H%M%S")
        .map_err(|error| MrmsError::InvalidObjectKey(error.to_string()))?;
    Ok(DateTime::from_naive_utc_and_offset(
        NaiveDateTime::new(date, time),
        Utc,
    ))
}

fn reject_future_objects(objects: &mut Vec<MrmsObject>, now: DateTime<Utc>) {
    objects.retain(|object| object.observation_time_unix_ms <= now.timestamp_millis());
}

fn ensure_strictly_newer(
    object: MrmsObject,
    retained_observation_time_unix_ms: Option<i64>,
) -> Result<MrmsObject, MrmsError> {
    if retained_observation_time_unix_ms
        .is_some_and(|retained| object.observation_time_unix_ms <= retained)
    {
        return Err(MrmsError::NotStrictlyNewer);
    }
    Ok(object)
}

fn parse_inventory(bytes: &[u8], expected_prefix: &str) -> Result<Vec<MrmsObject>, MrmsError> {
    #[derive(Default)]
    struct Pending {
        key: Option<String>,
        last_modified: Option<String>,
        etag: Option<String>,
        size: Option<String>,
    }
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);
    let mut root_started = false;
    let mut root_closed = false;
    let mut pending: Option<Pending> = None;
    let mut field = Vec::new();
    let mut is_truncated = None;
    let mut objects = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                field.clear();
                field.extend_from_slice(element.local_name().as_ref());
                if field == b"ListBucketResult" {
                    if root_started || root_closed {
                        return Err(inventory("inventory contains multiple roots"));
                    }
                    root_started = true;
                } else if field == b"Contents" {
                    if pending.is_some() {
                        return Err(inventory("inventory nests Contents elements"));
                    }
                    pending = Some(Pending::default());
                }
            }
            Ok(Event::End(element)) if element.local_name().as_ref() == b"Contents" => {
                let item = pending
                    .take()
                    .ok_or_else(|| inventory("Contents closed without opening"))?;
                let key = item.key.ok_or_else(|| inventory("object is missing Key"))?;
                if !key.starts_with(expected_prefix) {
                    return Err(inventory("object escaped the requested prefix"));
                }
                let observation_time_unix_ms = MrmsObject::parse_key(&key)?;
                let modified = item
                    .last_modified
                    .ok_or_else(|| inventory("object is missing LastModified"))?;
                let last_modified_unix_ms = DateTime::parse_from_rfc3339(&modified)
                    .map_err(|error| inventory(format!("LastModified is invalid: {error}")))?
                    .timestamp_millis();
                let size_bytes = item
                    .size
                    .ok_or_else(|| inventory("object is missing Size"))?
                    .parse::<usize>()
                    .map_err(|_| inventory("object Size is invalid"))?;
                if size_bytes == 0 || size_bytes > MRMS_COMPRESSED_LIMIT {
                    return Err(inventory(format!(
                        "object {key} size {size_bytes} is outside the compressed bound"
                    )));
                }
                objects.push(MrmsObject {
                    key,
                    observation_time_unix_ms,
                    last_modified_unix_ms,
                    size_bytes,
                    etag: item
                        .etag
                        .map(|etag| etag.replace("&quot;", "").trim_matches('"').to_string()),
                });
                if objects.len() > MAX_LISTED_OBJECTS {
                    return Err(inventory("inventory exceeded its object-count bound"));
                }
                field.clear();
            }
            Ok(Event::End(element)) if element.local_name().as_ref() == b"ListBucketResult" => {
                if !root_started || root_closed {
                    return Err(inventory("inventory root closed unexpectedly"));
                }
                root_closed = true;
                field.clear();
            }
            Ok(Event::Text(text)) => {
                let value = text
                    .decode()
                    .map_err(|error| inventory(format!("inventory text is invalid: {error}")))?;
                if field == b"IsTruncated" {
                    is_truncated = Some(match value.as_ref() {
                        "true" => true,
                        "false" => false,
                        _ => return Err(inventory("IsTruncated must be true or false")),
                    });
                } else if let Some(item) = pending.as_mut() {
                    match field.as_slice() {
                        b"Key" => item.key = Some(value.into_owned()),
                        b"LastModified" => item.last_modified = Some(value.into_owned()),
                        b"ETag" => item.etag = Some(value.into_owned()),
                        b"Size" => item.size = Some(value.into_owned()),
                        _ => {}
                    }
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(inventory(format!("inventory XML is invalid: {error}"))),
        }
    }
    if pending.is_some() || !root_started || !root_closed {
        return Err(inventory(
            "inventory ended before its root and objects closed",
        ));
    }
    if is_truncated.ok_or_else(|| inventory("inventory is missing IsTruncated"))? {
        return Err(inventory("daily prefix exceeded the 1000-object bound"));
    }
    objects.sort_by_key(|object| (object.observation_time_unix_ms, object.key.clone()));
    Ok(objects)
}

fn fixed_mrms_url() -> Result<Url, MrmsError> {
    Url::parse(MRMS_BASE).map_err(|error| MrmsError::InvalidUrl(error.to_string()))
}

fn mrms_object_url(key: &str) -> Result<Url, MrmsError> {
    MrmsObject::parse_key(key)?;
    let mut url = fixed_mrms_url()?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| MrmsError::InvalidUrl("MRMS base cannot hold a path".into()))?;
        for segment in key.split('/') {
            if segment.is_empty() || matches!(segment, "." | "..") {
                return Err(MrmsError::InvalidUrl(
                    "MRMS key contains an invalid path segment".into(),
                ));
            }
            segments.push(segment);
        }
    }
    ensure_fixed_mrms_url(&url)?;
    Ok(url)
}

fn ensure_fixed_mrms_url(url: &Url) -> Result<(), MrmsError> {
    let accepted = url.scheme() == "https"
        && url.host_str() == Some(MRMS_HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    accepted.then_some(()).ok_or_else(|| {
        MrmsError::InvalidUrl("only the approved anonymous NOAA MRMS HTTPS host is allowed".into())
    })
}

fn looks_like_s3_xml(bytes: &[u8]) -> bool {
    let trimmed = trim_ascii_start(bytes);
    trimmed.starts_with(b"<?xml") || trimmed.starts_with(b"<ListBucketResult")
}

fn looks_like_markup(bytes: &[u8]) -> bool {
    let trimmed = trim_ascii_start(bytes);
    trimmed.starts_with(b"<")
        || trimmed[..trimmed.len().min(32)].eq_ignore_ascii_case(b"<!doctype html")
}

fn trim_ascii_start(mut bytes: &[u8]) -> &[u8] {
    while bytes.first().is_some_and(u8::is_ascii_whitespace) {
        bytes = &bytes[1..];
    }
    bytes
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, MrmsError> {
    let slice = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| unsupported("field crosses section bounds"))?;
    Ok(u16::from_be_bytes([slice[0], slice[1]]))
}

fn read_i16(bytes: &[u8], offset: usize) -> Result<i16, MrmsError> {
    Ok(read_u16(bytes, offset)? as i16)
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, MrmsError> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| unsupported("field crosses section bounds"))?;
    Ok(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, MrmsError> {
    let slice = bytes
        .get(offset..offset + 8)
        .ok_or_else(|| unsupported("field crosses section bounds"))?;
    Ok(u64::from_be_bytes(
        slice.try_into().expect("bounded eight-byte slice"),
    ))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut value = String::with_capacity(64);
    for byte in digest {
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    value
}

fn sha256_u16_be(values: &[u16]) -> String {
    let mut digest = Sha256::new();
    for value in values {
        digest.update(value.to_be_bytes());
    }
    let result = digest.finalize();
    let mut value = String::with_capacity(64);
    for byte in result {
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    value
}

fn unsupported(message: impl Into<String>) -> MrmsError {
    MrmsError::UnsupportedGrib(message.into())
}

fn inventory(message: impl Into<String>) -> MrmsError {
    MrmsError::InvalidInventory(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};
    use std::io::Write as _;

    const REVIEW_KEY: &str = "CONUS/MergedBaseReflectivityQC_00.50/20260803/MRMS_MergedBaseReflectivityQC_00.50_20260803-162812.grib2.gz";

    fn object(key: &str, size_bytes: usize) -> MrmsObject {
        MrmsObject {
            key: key.into(),
            observation_time_unix_ms: MrmsObject::parse_key(key).unwrap(),
            last_modified_unix_ms: 0,
            size_bytes,
            etag: None,
        }
    }

    fn hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    fn valid_grib_shell() -> Vec<u8> {
        let mut body = Vec::new();
        body.extend(hex("000000150100a10000ff010307ea0803101c0c0207"));
        body.extend(hex("0000004803000175d720000000000201006128ee01006152b0010060ff2700001b5800000dac00000001000f4240034728380db59908300131408911e18f76000027100000271000"));
        body.extend(hex(
            "0000002204000000000b0008006100000000000000006600000001f4ff0100000000",
        ));
        body.extend(hex("00000015050175d7200029c61c1800000000011000"));
        body.extend(hex("0000000606ff"));
        body.extend(hex("0000000d0789504e470d0a1a0a"));
        let total = 16 + body.len() + 4;
        let mut grib = Vec::with_capacity(total);
        grib.extend_from_slice(b"GRIB\0\0\xd1\x02");
        grib.extend_from_slice(&(total as u64).to_be_bytes());
        grib.extend(body);
        grib.extend_from_slice(b"7777");
        grib
    }

    #[test]
    fn exact_object_pattern_and_date_directory_are_enforced() {
        let key = REVIEW_KEY;
        assert_eq!(
            MrmsObject::parse_key(key).unwrap(),
            Utc.with_ymd_and_hms(2026, 8, 3, 16, 28, 12)
                .unwrap()
                .timestamp_millis()
        );
        assert!(MrmsObject::parse_key(&key.replace("20260803/", "20260802/")).is_err());
        assert!(
            MrmsObject::parse_key(&key.replace("MergedBaseReflectivityQC", "SeamlessHSR")).is_err()
        );
        assert!(MrmsObject::parse_key(&format!("{key}/extra")).is_err());
    }

    #[test]
    fn inventory_sorts_by_measured_time_not_response_order() {
        let prefix = "CONUS/MergedBaseReflectivityQC_00.50/20260803/";
        let older = format!("{prefix}MRMS_MergedBaseReflectivityQC_00.50_20260803-000012.grib2.gz");
        let newer = format!("{prefix}MRMS_MergedBaseReflectivityQC_00.50_20260803-000212.grib2.gz");
        let xml = format!(
            r#"<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>{newer}</Key><LastModified>2026-08-03T00:03:00.000Z</LastModified><ETag>&quot;b&quot;</ETag><Size>100</Size></Contents><Contents><Key>{older}</Key><LastModified>2026-08-03T00:01:00.000Z</LastModified><ETag>&quot;a&quot;</ETag><Size>90</Size></Contents></ListBucketResult>"#
        );
        let parsed = parse_inventory(xml.as_bytes(), prefix).unwrap();
        assert_eq!(parsed[0].key, older);
        assert_eq!(parsed[1].key, newer);
    }

    #[test]
    fn future_inventory_time_is_never_eligible_for_current_truth() {
        let now = Utc.with_ymd_and_hms(2026, 8, 3, 0, 1, 0).unwrap();
        let eligible = object(
            "CONUS/MergedBaseReflectivityQC_00.50/20260803/MRMS_MergedBaseReflectivityQC_00.50_20260803-000012.grib2.gz",
            100,
        );
        let future = object(
            "CONUS/MergedBaseReflectivityQC_00.50/20260803/MRMS_MergedBaseReflectivityQC_00.50_20260803-000212.grib2.gz",
            100,
        );
        let mut candidates = vec![eligible.clone(), future];
        reject_future_objects(&mut candidates, now);
        assert_eq!(candidates, vec![eligible]);
    }

    #[test]
    fn polling_accepts_only_strictly_newer_measured_observations() {
        let candidate = object(REVIEW_KEY, 100);
        let measured = candidate.observation_time_unix_ms;
        assert!(ensure_strictly_newer(candidate.clone(), None).is_ok());
        assert!(ensure_strictly_newer(candidate.clone(), Some(measured - 1)).is_ok());
        assert!(matches!(
            ensure_strictly_newer(candidate.clone(), Some(measured)),
            Err(MrmsError::NotStrictlyNewer)
        ));
        assert!(matches!(
            ensure_strictly_newer(candidate, Some(measured + 1)),
            Err(MrmsError::NotStrictlyNewer)
        ));
    }

    #[test]
    fn truncated_or_foreign_inventory_fails_closed() {
        let prefix = "CONUS/MergedBaseReflectivityQC_00.50/20260803/";
        let truncated = b"<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>";
        assert!(parse_inventory(truncated, prefix).is_err());
        let missing_flag = b"<ListBucketResult></ListBucketResult>";
        assert!(parse_inventory(missing_flag, prefix).is_err());
        let invalid_flag = b"<ListBucketResult><IsTruncated>maybe</IsTruncated></ListBucketResult>";
        assert!(parse_inventory(invalid_flag, prefix).is_err());
        let foreign = b"<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>CONUS/Other/file</Key><LastModified>2026-08-03T00:00:00Z</LastModified><Size>1</Size></Contents></ListBucketResult>";
        assert!(parse_inventory(foreign, prefix).is_err());
    }

    #[test]
    fn raw_formula_accepts_never_observed_structural_values() {
        let encoding = MrmsValueEncoding {
            bit_depth: 16,
            reference_value_bits: MRMS_REFERENCE_VALUE.to_bits(),
            binary_scale: 0,
            decimal_scale: 1,
            missing_raw: MRMS_MISSING_RAW,
            no_coverage_raw: MRMS_NO_COVERAGE_RAW,
        };
        assert_eq!(encoding.decode_raw(1), MrmsCellValue::Valid(-998.9));
        assert_eq!(encoding.decode_raw(65_535), MrmsCellValue::Valid(5_554.5));
        assert_eq!(
            encoding.decode_raw(MRMS_MISSING_RAW),
            MrmsCellValue::Missing
        );
        assert_eq!(
            encoding.decode_raw(MRMS_NO_COVERAGE_RAW),
            MrmsCellValue::NoCoverage
        );
    }

    #[test]
    fn overview_reduction_preserves_strongest_valid_then_status_priority() {
        let encoding = MrmsValueEncoding {
            bit_depth: 16,
            reference_value_bits: MRMS_REFERENCE_VALUE.to_bits(),
            binary_scale: 0,
            decimal_scale: 1,
            missing_raw: MRMS_MISSING_RAW,
            no_coverage_raw: MRMS_NO_COVERAGE_RAW,
        };
        let source = vec![0, 9_000, 10_000, 10_100, 10_000, 0, 9_000, 0];
        let (reduced, width, height) = reduce_strongest_valid(&source, 4, 2, encoding).unwrap();
        assert_eq!((width, height), (2, 1));
        assert_eq!(reduced, vec![10_000, 10_100]);
        let statuses = vec![0, 9_000, 0, 0];
        assert_eq!(
            reduce_strongest_valid(&statuses, 2, 2, encoding).unwrap().0,
            vec![9_000]
        );
        assert_eq!(
            reduce_strongest_valid(&[0, 0, 0, 0], 2, 2, encoding)
                .unwrap()
                .0,
            vec![0]
        );
    }

    #[test]
    fn polling_backoff_and_jitter_are_bounded() {
        for attempt in 0..20 {
            let delay = bounded_poll_delay(attempt, 0x1234_5678);
            assert!((15_000..=120_000).contains(&delay.backoff_ms));
            assert!(delay.jitter_ms <= 5_000);
            assert_eq!(delay.total_ms, delay.backoff_ms + delay.jitter_ms);
        }
    }

    #[test]
    fn markup_cannot_be_accepted_as_a_binary_object() {
        assert!(looks_like_markup(b"  <Error>denied</Error>"));
        assert!(looks_like_markup(b"<!doctype html><title>error</title>"));
        assert!(!looks_like_markup(&[0x1f, 0x8b, 0x08]));
    }

    #[test]
    fn gzip_and_grib_signatures_are_independently_required() {
        let key = REVIEW_KEY;
        let invalid = decode_mrms_gzip(b"not gzip", object(key, 8)).unwrap_err();
        assert_eq!(invalid.code(), "mrms_invalid_gzip");
    }

    #[test]
    fn gzip_trailing_bytes_or_members_fail_closed() {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&valid_grib_shell()).unwrap();
        let compressed = encoder.finish().unwrap();
        let mut trailing_bytes = compressed.clone();
        trailing_bytes.extend_from_slice(b"unexpected");
        assert_eq!(
            decode_mrms_gzip(&trailing_bytes, object(REVIEW_KEY, trailing_bytes.len()))
                .unwrap_err()
                .code(),
            "mrms_invalid_gzip"
        );
        let mut trailing_member = compressed.clone();
        trailing_member.extend_from_slice(&compressed);
        assert_eq!(
            decode_mrms_gzip(&trailing_member, object(REVIEW_KEY, trailing_member.len()))
                .unwrap_err()
                .code(),
            "mrms_invalid_gzip"
        );
    }

    #[test]
    fn reviewed_live_sample_decodes_exactly_when_available() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/cache/MRMS_MergedBaseReflectivityQC_00.50_20260803-162812.grib2.gz");
        if !path.exists() {
            return;
        }
        let compressed = std::fs::read(&path).unwrap();
        let decoded = decode_mrms_gzip(&compressed, object(REVIEW_KEY, compressed.len())).unwrap();
        assert_eq!(decoded.raw_codes.len(), MRMS_CELL_COUNT);
        assert_eq!(
            decoded.evidence.compressed_sha256,
            "1826ea8b575cc59c24433ab610197f5a1d5a8d91f20c61cf698ec1d6ff697b76"
        );
        assert_eq!(decoded.encoding.reference_value(), -9_990.0);
        eprintln!("{}", serde_json::to_string(&decoded.evidence).unwrap());
    }

    #[test]
    fn multi_season_oracle_confirms_formula_and_downloads_when_available() {
        let oracle: serde_json::Value = serde_json::from_str(include_str!(
            "../../fixtures/expected/national-phase2/mrms-oracle.json"
        ))
        .unwrap();
        let samples = oracle["samples"].as_array().unwrap();
        assert_eq!(samples.len(), 4);
        let encoding = MrmsValueEncoding {
            bit_depth: 16,
            reference_value_bits: MRMS_REFERENCE_VALUE.to_bits(),
            binary_scale: 0,
            decimal_scale: 1,
            missing_raw: MRMS_MISSING_RAW,
            no_coverage_raw: MRMS_NO_COVERAGE_RAW,
        };
        for sample in samples {
            assert_eq!(sample["formulaMismatchCount"].as_u64(), Some(0));
            for cell in sample["sampleCells"].as_array().unwrap() {
                let raw = cell["rawCode"].as_u64().unwrap() as u16;
                let oracle_value = cell["ecCodesDbz"].as_f64().unwrap();
                match encoding.decode_raw(raw) {
                    MrmsCellValue::Valid(value) => assert!((value - oracle_value).abs() < 1e-9),
                    MrmsCellValue::Missing => assert_eq!(oracle_value, -99.0),
                    MrmsCellValue::NoCoverage => assert_eq!(oracle_value, -999.0),
                }
            }

            let key = sample["objectKey"].as_str().unwrap();
            let filename = key.rsplit('/').next().unwrap();
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../fixtures/cache/mrms-oracle")
                .join(filename);
            if !path.exists() {
                continue;
            }
            let compressed = std::fs::read(path).unwrap();
            let decoded = decode_mrms_gzip(&compressed, object(key, compressed.len())).unwrap();
            assert_eq!(
                decoded.evidence.normalized_sha256,
                sample["normalizedRawBigEndianSha256"].as_str().unwrap()
            );
            for cell in sample["sampleCells"].as_array().unwrap() {
                let index = cell["index"].as_u64().unwrap() as usize;
                assert_eq!(
                    decoded.raw_codes[index],
                    cell["rawCode"].as_u64().unwrap() as u16
                );
            }
        }
    }

    #[test]
    fn strict_grib_contract_rejects_each_reviewed_structure_change() {
        let valid = valid_grib_shell();
        assert!(parse_strict_grib(&valid, &object(REVIEW_KEY, 1)).is_ok());

        for (offset, name) in [
            (6usize, "discipline"),
            (7, "edition"),
            (16 + 4, "section order"),
            (16 + 21 + 30, "grid width"),
            (16 + 21 + 72 + 9, "product"),
            (16 + 21 + 72 + 34 + 9, "packing template"),
            (16 + 21 + 72 + 34 + 19, "bit depth"),
            (16 + 21 + 72 + 34 + 21 + 5, "bitmap"),
        ] {
            let mut malformed = valid.clone();
            malformed[offset] ^= 1;
            assert!(
                parse_strict_grib(&malformed, &object(REVIEW_KEY, 1)).is_err(),
                "{name} mutation was accepted"
            );
        }
        let mut bad_trailer = valid.clone();
        *bad_trailer.last_mut().unwrap() = b'8';
        assert!(parse_strict_grib(&bad_trailer, &object(REVIEW_KEY, 1)).is_err());
        let wrong_time = REVIEW_KEY.replace("162812", "162813");
        assert!(parse_strict_grib(&valid, &object(&wrong_time, 1)).is_err());
    }
}
