//! Bounded, keyless acquisition for Mistr's fixed public radar providers.

use crate::chunk_assembly::{
    ChunkAssemblyError, ChunkMetadata, MAX_REALTIME_CHUNK_BYTES, MAX_REALTIME_CHUNKS,
};
use chrono::{DateTime, Datelike, Utc};
use quick_xml::{Reader, events::Event};
use reqwest::{Client, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::future::Future;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use thiserror::Error;

const REALTIME_BASE: &str = "https://unidata-nexrad-level2-chunks.s3.amazonaws.com/";
const ARCHIVE_BASE: &str = "https://unidata-nexrad-level2.s3.amazonaws.com/";
const NOAA_BASE: &str = "https://opengeo.ncep.noaa.gov/";
const IEM_BASE: &str = "https://mesonet.agron.iastate.edu/";
const LIST_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const PROVIDER_RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AcquisitionError {
    #[error("invalid radar site: {0}")]
    InvalidSite(String),
    #[error("invalid fixed provider URL: {0}")]
    InvalidUrl(String),
    #[error("provider request failed: {0}")]
    Request(String),
    #[error("provider returned HTTP {0}")]
    HttpStatus(u16),
    #[error("provider response is {actual} bytes; limit is {limit} bytes")]
    ResponseTooLarge { actual: u64, limit: usize },
    #[error("provider response exceeded {limit} bytes while streaming")]
    ResponseStreamTooLarge { limit: usize },
    #[error("provider response is malformed: {0}")]
    MalformedResponse(String),
    #[error("real-time bucket has no discoverable volume for {0}")]
    NoRealtimeVolume(String),
    #[error("chunk metadata is invalid: {0}")]
    InvalidChunk(String),
}

impl From<ChunkAssemblyError> for AcquisitionError {
    fn from(value: ChunkAssemblyError) -> Self {
        Self::InvalidChunk(value.to_string())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionCounters {
    pub network_requests: u64,
    pub response_bytes: u64,
}

#[derive(Debug, Default)]
struct CounterState {
    network_requests: AtomicU64,
    response_bytes: AtomicU64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3ObjectMetadata {
    pub key: String,
    pub last_modified_unix_ms: i64,
    pub etag: Option<String>,
    pub size_bytes: usize,
}

impl S3ObjectMetadata {
    pub fn as_realtime_chunk(&self, site: &str) -> Result<ChunkMetadata, AcquisitionError> {
        ChunkMetadata::from_s3_object(
            site,
            &self.key,
            self.last_modified_unix_ms,
            self.size_bytes,
            self.etag.clone(),
        )
        .map_err(Into::into)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct S3ListPage {
    objects: Vec<S3ObjectMetadata>,
    is_truncated: bool,
}

#[derive(Debug, Clone)]
pub struct PublicRadarClient {
    http: Client,
    counters: Arc<CounterState>,
}

impl PublicRadarClient {
    pub fn new() -> Result<Self, AcquisitionError> {
        let http = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(HTTP_TIMEOUT)
            .redirect(Policy::none())
            .user_agent("Mistr/0.0.1 (+https://github.com/tcurtsinger/Mistr)")
            .build()
            .map_err(|error| AcquisitionError::Request(error.to_string()))?;
        Ok(Self {
            http,
            counters: Arc::default(),
        })
    }

    pub fn counters(&self) -> AcquisitionCounters {
        AcquisitionCounters {
            network_requests: self.counters.network_requests.load(Ordering::Relaxed),
            response_bytes: self.counters.response_bytes.load(Ordering::Relaxed),
        }
    }

    pub async fn discover_latest_realtime_volume(
        &self,
        site: &str,
    ) -> Result<u16, AcquisitionError> {
        validate_site(site)?;
        let found = rotated_search(999, i64::MAX, |offset| async move {
            let volume_index = u16::try_from(offset + 1)
                .map_err(|_| AcquisitionError::MalformedResponse("volume index overflow".into()))?;
            Ok(self
                .list_realtime_volume_limited(site, volume_index, 1)
                .await?
                .first()
                .map(|object| object.last_modified_unix_ms))
        })
        .await?;
        found
            .and_then(|offset| u16::try_from(offset + 1).ok())
            .ok_or_else(|| AcquisitionError::NoRealtimeVolume(site.into()))
    }

    pub async fn list_realtime_volume(
        &self,
        site: &str,
        volume_index: u16,
    ) -> Result<Vec<S3ObjectMetadata>, AcquisitionError> {
        self.list_realtime_volume_limited(site, volume_index, MAX_REALTIME_CHUNKS as usize)
            .await
    }

    async fn list_realtime_volume_limited(
        &self,
        site: &str,
        volume_index: u16,
        max_keys: usize,
    ) -> Result<Vec<S3ObjectMetadata>, AcquisitionError> {
        validate_site(site)?;
        if !(1..=999).contains(&volume_index) {
            return Err(AcquisitionError::MalformedResponse(
                "real-time volume index must be in 1..=999".into(),
            ));
        }
        if !(1..=MAX_REALTIME_CHUNKS as usize).contains(&max_keys) {
            return Err(AcquisitionError::MalformedResponse(format!(
                "max-keys must be in 1..={MAX_REALTIME_CHUNKS}"
            )));
        }
        let mut url = fixed_url(REALTIME_BASE)?;
        url.query_pairs_mut()
            .append_pair("list-type", "2")
            .append_pair("prefix", &format!("{site}/{volume_index}/"))
            .append_pair("max-keys", &max_keys.to_string());
        let page = parse_s3_list(&self.fetch_bounded(url, LIST_RESPONSE_LIMIT).await?)?;
        if page.is_truncated && max_keys > 1 {
            return Err(AcquisitionError::MalformedResponse(format!(
                "volume {volume_index} contains more than the {max_keys}-object listing bound"
            )));
        }
        let mut objects = page.objects;
        objects.sort_by(|left, right| left.key.cmp(&right.key));
        Ok(objects)
    }

    pub async fn download_realtime_chunk(
        &self,
        metadata: &S3ObjectMetadata,
        site: &str,
    ) -> Result<(ChunkMetadata, Vec<u8>), AcquisitionError> {
        let chunk = metadata.as_realtime_chunk(site)?;
        let url = object_url(REALTIME_BASE, &metadata.key)?;
        let bytes = self.fetch_bounded(url, MAX_REALTIME_CHUNK_BYTES).await?;
        if bytes.len() != metadata.size_bytes {
            return Err(AcquisitionError::InvalidChunk(format!(
                "{} declared {} bytes but returned {}",
                metadata.key,
                metadata.size_bytes,
                bytes.len()
            )));
        }
        Ok((chunk, bytes))
    }

    pub async fn list_archive_observation(
        &self,
        site: &str,
        volume_started_at_unix_ms: i64,
    ) -> Result<Vec<S3ObjectMetadata>, AcquisitionError> {
        validate_site(site)?;
        let timestamp = DateTime::<Utc>::from_timestamp_millis(volume_started_at_unix_ms)
            .ok_or_else(|| {
                AcquisitionError::MalformedResponse("invalid volume timestamp".into())
            })?;
        let prefix = format!(
            "{:04}/{:02}/{:02}/{site}/{site}{}",
            timestamp.year(),
            timestamp.month(),
            timestamp.day(),
            timestamp.format("%Y%m%d_%H%M%S")
        );
        let mut url = fixed_url(ARCHIVE_BASE)?;
        url.query_pairs_mut()
            .append_pair("list-type", "2")
            .append_pair("prefix", &prefix)
            .append_pair("max-keys", "5");
        let page = parse_s3_list(&self.fetch_bounded(url, LIST_RESPONSE_LIMIT).await?)?;
        if page.is_truncated || page.objects.len() > 2 {
            return Err(AcquisitionError::MalformedResponse(
                "archive observation prefix returned an ambiguous object set".into(),
            ));
        }
        Ok(page
            .objects
            .into_iter()
            .filter(|object| !object.key.ends_with("_MDM"))
            .collect())
    }

    pub async fn noaa_reflectivity_times(&self, site: &str) -> Result<Vec<i64>, AcquisitionError> {
        validate_site(site)?;
        let lower = site.to_ascii_lowercase();
        let mut url = fixed_url(NOAA_BASE)?;
        url.set_path(&format!("geoserver/{lower}/ows"));
        url.query_pairs_mut()
            .append_pair("request", "GetCapabilities")
            .append_pair("service", "WMS")
            .append_pair("version", "1.3.0");
        let bytes = self.fetch_bounded(url, PROVIDER_RESPONSE_LIMIT).await?;
        let text = std::str::from_utf8(&bytes).map_err(|error| {
            AcquisitionError::MalformedResponse(format!("NOAA capabilities are not UTF-8: {error}"))
        })?;
        parse_noaa_reflectivity_times(text, &format!("{lower}_sr_bref"))
    }

    pub async fn iem_reflectivity_times(
        &self,
        site: &str,
        start_unix_ms: i64,
        end_unix_ms: i64,
    ) -> Result<Vec<i64>, AcquisitionError> {
        validate_site(site)?;
        if start_unix_ms >= end_unix_ms {
            return Err(AcquisitionError::MalformedResponse(
                "IEM inventory window is reversed".into(),
            ));
        }
        let start = DateTime::<Utc>::from_timestamp_millis(start_unix_ms)
            .ok_or_else(|| AcquisitionError::MalformedResponse("invalid IEM start time".into()))?;
        let end = DateTime::<Utc>::from_timestamp_millis(end_unix_ms)
            .ok_or_else(|| AcquisitionError::MalformedResponse("invalid IEM end time".into()))?;
        let radar = &site[site.len() - 3..];
        let mut url = fixed_url(IEM_BASE)?;
        url.set_path("json/radar");
        url.query_pairs_mut()
            .append_pair("operation", "list")
            .append_pair("radar", radar)
            .append_pair("product", "N0B")
            .append_pair("start", &start.format("%Y-%m-%dT%H:%MZ").to_string())
            .append_pair("end", &end.format("%Y-%m-%dT%H:%MZ").to_string());
        let bytes = self.fetch_bounded(url, LIST_RESPONSE_LIMIT).await?;
        parse_iem_times(&bytes)
    }

    async fn fetch_bounded(&self, url: Url, limit: usize) -> Result<Vec<u8>, AcquisitionError> {
        ensure_allowed_url(&url)?;
        self.counters
            .network_requests
            .fetch_add(1, Ordering::Relaxed);
        let mut response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|error| AcquisitionError::Request(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(AcquisitionError::HttpStatus(status.as_u16()));
        }
        if let Some(length) = response.content_length()
            && length > limit as u64
        {
            return Err(AcquisitionError::ResponseTooLarge {
                actual: length,
                limit,
            });
        }
        let mut bytes = Vec::with_capacity(
            response
                .content_length()
                .and_then(|length| usize::try_from(length).ok())
                .unwrap_or(0)
                .min(limit),
        );
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| AcquisitionError::Request(error.to_string()))?
        {
            let next = bytes
                .len()
                .checked_add(chunk.len())
                .filter(|length| *length <= limit)
                .ok_or(AcquisitionError::ResponseStreamTooLarge { limit })?;
            bytes.reserve(next - bytes.len());
            bytes.extend_from_slice(&chunk);
        }
        self.counters
            .response_bytes
            .fetch_add(bytes.len() as u64, Ordering::Relaxed);
        Ok(bytes)
    }
}

fn fixed_url(base: &str) -> Result<Url, AcquisitionError> {
    Url::parse(base).map_err(|error| AcquisitionError::InvalidUrl(error.to_string()))
}

fn object_url(base: &str, key: &str) -> Result<Url, AcquisitionError> {
    let mut url = fixed_url(base)?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| AcquisitionError::InvalidUrl("provider URL cannot hold a path".into()))?;
        for segment in key.split('/') {
            if segment.is_empty() || matches!(segment, "." | "..") {
                return Err(AcquisitionError::InvalidUrl(
                    "object key contains an invalid path segment".into(),
                ));
            }
            segments.push(segment);
        }
    }
    ensure_allowed_url(&url)?;
    Ok(url)
}

fn ensure_allowed_url(url: &Url) -> Result<(), AcquisitionError> {
    let host = url.host_str().unwrap_or_default();
    let allowed = url.scheme() == "https"
        && url.port().is_none()
        && matches!(
            host,
            "unidata-nexrad-level2-chunks.s3.amazonaws.com"
                | "unidata-nexrad-level2.s3.amazonaws.com"
                | "opengeo.ncep.noaa.gov"
                | "mesonet.agron.iastate.edu"
        );
    allowed.then_some(()).ok_or_else(|| {
        AcquisitionError::InvalidUrl(format!("host {host:?} is not on the radar allowlist"))
    })
}

fn validate_site(site: &str) -> Result<(), AcquisitionError> {
    if site.len() != 4
        || !site
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return Err(AcquisitionError::InvalidSite(
            "site must be exactly four uppercase ASCII letters/digits".into(),
        ));
    }
    Ok(())
}

fn parse_s3_list(bytes: &[u8]) -> Result<S3ListPage, AcquisitionError> {
    #[derive(Default)]
    struct PendingObject {
        key: Option<String>,
        last_modified: Option<String>,
        etag: Option<String>,
        size: Option<String>,
    }

    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);
    let mut objects = Vec::new();
    let mut pending: Option<PendingObject> = None;
    let mut field = Vec::new();
    let mut is_truncated = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let name = element.local_name();
                field.clear();
                field.extend_from_slice(name.as_ref());
                if name.as_ref() == b"Contents" {
                    pending = Some(PendingObject::default());
                }
            }
            Ok(Event::End(element)) if element.local_name().as_ref() == b"Contents" => {
                let item = pending.take().ok_or_else(|| {
                    AcquisitionError::MalformedResponse("S3 Contents close without open".into())
                })?;
                let key = item.key.ok_or_else(|| {
                    AcquisitionError::MalformedResponse("S3 object is missing Key".into())
                })?;
                let timestamp = item.last_modified.ok_or_else(|| {
                    AcquisitionError::MalformedResponse("S3 object is missing LastModified".into())
                })?;
                let last_modified_unix_ms = DateTime::parse_from_rfc3339(&timestamp)
                    .map_err(|error| {
                        AcquisitionError::MalformedResponse(format!(
                            "S3 LastModified is invalid: {error}"
                        ))
                    })?
                    .timestamp_millis();
                let size_bytes = item
                    .size
                    .ok_or_else(|| {
                        AcquisitionError::MalformedResponse("S3 object is missing Size".into())
                    })?
                    .parse::<usize>()
                    .map_err(|_| {
                        AcquisitionError::MalformedResponse("S3 Size is invalid".into())
                    })?;
                objects.push(S3ObjectMetadata {
                    key,
                    last_modified_unix_ms,
                    etag: item
                        .etag
                        .map(|etag| etag.replace("&quot;", "").trim_matches('"').to_string()),
                    size_bytes,
                });
                field.clear();
            }
            Ok(Event::Text(text)) => {
                let value = text.decode().map_err(|error| {
                    AcquisitionError::MalformedResponse(format!("S3 text decode failed: {error}"))
                })?;
                if field.as_slice() == b"IsTruncated" {
                    is_truncated = value.as_ref() == "true";
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
            Err(error) => {
                return Err(AcquisitionError::MalformedResponse(format!(
                    "S3 XML is invalid: {error}"
                )));
            }
        }
    }
    if pending.is_some() {
        return Err(AcquisitionError::MalformedResponse(
            "S3 XML ended inside Contents".into(),
        ));
    }
    Ok(S3ListPage {
        objects,
        is_truncated,
    })
}

fn parse_noaa_reflectivity_times(
    capabilities: &str,
    layer_name: &str,
) -> Result<Vec<i64>, AcquisitionError> {
    let marker = format!("<Name>{layer_name}</Name>");
    let start = capabilities.find(&marker).ok_or_else(|| {
        AcquisitionError::MalformedResponse(format!("NOAA layer {layer_name} is missing"))
    })?;
    let remainder = &capabilities[start..];
    let layer_end = remainder.find("</Layer>").unwrap_or(remainder.len());
    let layer = &remainder[..layer_end];
    let dimension_start = layer
        .find("<Dimension name=\"time\"")
        .or_else(|| layer.find("<Dimension name='time'"))
        .ok_or_else(|| {
            AcquisitionError::MalformedResponse("NOAA time dimension is missing".into())
        })?;
    let dimension = &layer[dimension_start..];
    let values_start = dimension.find('>').ok_or_else(|| {
        AcquisitionError::MalformedResponse("NOAA time dimension is malformed".into())
    })? + 1;
    let values_end = dimension[values_start..]
        .find("</Dimension>")
        .map(|offset| values_start + offset)
        .ok_or_else(|| {
            AcquisitionError::MalformedResponse("NOAA time dimension is unterminated".into())
        })?;
    let mut times = dimension[values_start..values_end]
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            DateTime::parse_from_rfc3339(value)
                .map(|time| time.timestamp_millis())
                .map_err(|error| {
                    AcquisitionError::MalformedResponse(format!(
                        "NOAA time {value:?} is invalid: {error}"
                    ))
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    times.sort_unstable();
    times.dedup();
    if times.is_empty() {
        return Err(AcquisitionError::MalformedResponse(
            "NOAA time dimension is empty".into(),
        ));
    }
    Ok(times)
}

#[derive(Debug, Deserialize)]
struct IemInventory {
    scans: Vec<IemScan>,
}

#[derive(Debug, Deserialize)]
struct IemScan {
    ts: String,
}

fn parse_iem_times(bytes: &[u8]) -> Result<Vec<i64>, AcquisitionError> {
    let inventory: IemInventory = serde_json::from_slice(bytes).map_err(|error| {
        AcquisitionError::MalformedResponse(format!("IEM inventory JSON is invalid: {error}"))
    })?;
    let mut times = inventory
        .scans
        .into_iter()
        .map(|scan| {
            let timestamp = if scan.ts.len() == 17 && scan.ts.ends_with('Z') {
                format!("{}:00Z", &scan.ts[..16])
            } else {
                scan.ts.clone()
            };
            DateTime::parse_from_rfc3339(&timestamp)
                .map(|time| time.timestamp_millis())
                .map_err(|error| {
                    AcquisitionError::MalformedResponse(format!(
                        "IEM scan time {:?} is invalid: {error}",
                        scan.ts
                    ))
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    times.sort_unstable();
    times.dedup();
    if times.is_empty() {
        return Err(AcquisitionError::MalformedResponse(
            "IEM inventory is empty".into(),
        ));
    }
    Ok(times)
}

async fn rotated_search<F, Fut, V>(
    element_count: usize,
    target: V,
    mut probe: F,
) -> Result<Option<usize>, AcquisitionError>
where
    F: FnMut(usize) -> Fut,
    Fut: Future<Output = Result<Option<V>, AcquisitionError>>,
    V: PartialOrd + Clone,
{
    if element_count == 0 {
        return Ok(None);
    }
    let target_ref = Some(&target);
    let mut nearest = None;
    let mut first_value = probe(0).await?;
    let mut first_ref = first_value.as_ref();
    if first_ref == target_ref {
        return Ok(Some(0));
    }
    let mut low = 0usize;
    let mut high = element_count;
    let mut queue = VecDeque::from([(0usize, element_count - 1)]);
    while let Some((start, end)) = queue.pop_front() {
        if start > end {
            continue;
        }
        let mid = start + (end - start) / 2;
        let value = probe(mid).await?;
        let value_ref = value.as_ref();
        if value_ref.is_none() {
            if mid < end {
                queue.push_back((mid + 1, end));
            }
            if mid > start {
                queue.push_back((start, mid - 1));
            }
            continue;
        }
        if value_ref <= target_ref {
            nearest = Some(mid);
        }
        if value_ref == target_ref {
            return Ok(nearest);
        }
        if should_search_right(first_ref, value_ref, target_ref) {
            low = mid + 1;
        } else {
            high = mid;
        }
        break;
    }
    if low >= high {
        return Ok(nearest);
    }
    first_value = probe(low).await?;
    first_ref = first_value.as_ref();
    while low < high {
        let mid = low + (high - low) / 2;
        let value = probe(mid).await?;
        let value_ref = value.as_ref();
        if value_ref.is_some() && value_ref <= target_ref {
            nearest = Some(mid);
        }
        if value_ref == target_ref {
            return Ok(Some(mid));
        }
        if should_search_right(first_ref, value_ref, target_ref) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    Ok(nearest)
}

fn should_search_right<V: PartialOrd>(first: V, value: V, target: V) -> bool {
    let first_wrapped = first > value;
    let target_wrapped = target < first;
    if value < target {
        !first_wrapped || target_wrapped
    } else {
        first_wrapped && !target_wrapped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S3_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>KTLX/337/20260801-041327-001-S</Key>
    <LastModified>2026-08-01T04:13:30.000Z</LastModified>
    <ETag>&quot;abc&quot;</ETag>
    <Size>2430</Size>
  </Contents>
</ListBucketResult>"#;

    #[test]
    fn parses_bounded_s3_inventory() {
        let page = parse_s3_list(S3_XML.as_bytes()).unwrap();
        assert!(!page.is_truncated);
        assert_eq!(page.objects.len(), 1);
        assert_eq!(page.objects[0].key, "KTLX/337/20260801-041327-001-S");
        assert_eq!(page.objects[0].etag.as_deref(), Some("abc"));
        assert_eq!(page.objects[0].size_bytes, 2430);
    }

    #[test]
    fn parses_only_the_named_noaa_reflectivity_layer() {
        let xml = r#"<Layer><Name>ktlx_other</Name><Dimension name="time">2026-08-01T00:00:00.000Z</Dimension></Layer>
<Layer><Name>ktlx_sr_bref</Name><Dimension name="time">2026-08-01T04:13:27.000Z,2026-08-01T04:17:43.000Z</Dimension></Layer>"#;
        assert_eq!(
            parse_noaa_reflectivity_times(xml, "ktlx_sr_bref").unwrap(),
            vec![1_785_557_607_000, 1_785_557_863_000]
        );
    }

    #[test]
    fn parses_iem_minute_inventory() {
        let json = br#"{"scans":[{"ts":"2026-08-01T04:13Z"},{"ts":"2026-08-01T04:17Z"}]}"#;
        assert_eq!(
            parse_iem_times(json).unwrap(),
            vec![1_785_557_580_000, 1_785_557_820_000]
        );
    }

    #[test]
    fn provider_allowlist_rejects_arbitrary_hosts_and_ports() {
        assert!(ensure_allowed_url(&Url::parse(REALTIME_BASE).unwrap()).is_ok());
        assert!(ensure_allowed_url(&Url::parse("https://example.com/").unwrap()).is_err());
        assert!(
            ensure_allowed_url(&Url::parse("https://opengeo.ncep.noaa.gov:444/geoserver").unwrap())
                .is_err()
        );
    }

    #[tokio::test]
    async fn rotated_search_handles_wrap_and_empty_pivot() {
        let values = [
            Some(6),
            Some(7),
            Some(8),
            None,
            None,
            Some(2),
            Some(3),
            Some(4),
            Some(5),
        ];
        let found = rotated_search(
            values.len(),
            i32::MAX,
            |index| async move { Ok(values[index]) },
        )
        .await
        .unwrap();
        assert_eq!(found, Some(2));
    }

    #[test]
    fn non_success_status_is_stable_for_diagnostics() {
        assert_eq!(
            AcquisitionError::HttpStatus(reqwest::StatusCode::SERVICE_UNAVAILABLE.as_u16())
                .to_string(),
            "provider returned HTTP 503"
        );
    }
}
