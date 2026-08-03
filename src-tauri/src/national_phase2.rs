//! Diagnostic-only National Phase 2 acquisition and PackedGrid transfer wiring.
//!
//! No product control calls this module. The commands exist so release WebView2
//! diagnostics can prove fixed-host acquisition, strict decode, bounded working
//! set generation, and use of the existing global two-credit broker.

use crate::mrms::{DownloadedMrmsObject, MrmsClient, MrmsDecodeEvidence, decode_mrms_gzip};
use crate::packed_grid::{
    MrmsNumericPyramid, PACKED_GRID_VERSION, PackedGridFrame, PackedGridManifestSummary,
    validate_packed_grid_chunk, validate_packed_grid_manifest,
};
use crate::phase2_ipc::{TransferBroker, TransferError};
use chrono::Utc;
use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::ipc::Response;

const PREPARED_CACHE_MAX_OBSERVATIONS: usize = 2;
const PREPARED_CACHE_MAX_BYTES: usize = 180 * 1024 * 1024;
const OVERVIEW_FACTOR: u16 = 4;
const RETAINED_FRAME_COUNT: usize = 20;
const EXTENSION_FRAME_COUNT: usize = 30;
const GPU_TARGET_BYTES: usize = 200 * 1024 * 1024;
const GPU_HARD_CEILING_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Clone)]
struct PreparedNationalFrame {
    generation: u64,
    pyramid: Arc<MrmsNumericPyramid>,
    frame: PackedGridFrame,
}

impl PreparedNationalFrame {
    fn total_bytes(&self) -> usize {
        self.pyramid.retained_bytes() + self.frame.transfer_bytes()
    }
}

#[derive(Debug)]
struct PreparedCache {
    by_object: BTreeMap<String, Arc<PreparedNationalFrame>>,
    order: VecDeque<String>,
    total_bytes: usize,
    max_observations: usize,
    max_bytes: usize,
    active_generation: Option<u64>,
    active_object: Option<String>,
}

impl Default for PreparedCache {
    fn default() -> Self {
        Self {
            by_object: BTreeMap::new(),
            order: VecDeque::new(),
            total_bytes: 0,
            max_observations: PREPARED_CACHE_MAX_OBSERVATIONS,
            max_bytes: PREPARED_CACHE_MAX_BYTES,
            active_generation: None,
            active_object: None,
        }
    }
}

impl PreparedCache {
    fn insert(
        &mut self,
        object_key: String,
        prepared: Arc<PreparedNationalFrame>,
    ) -> Result<Vec<Arc<PreparedNationalFrame>>, TransferError> {
        if self.max_observations == 0 || prepared.total_bytes() > self.max_bytes {
            return Err(TransferError::new(
                "national_prepared_cache_bound",
                format!(
                    "prepared National frame requires {} bytes; cache limit is {}",
                    prepared.total_bytes(),
                    self.max_bytes
                ),
            ));
        }
        let mut retired = Vec::new();
        if let Some(previous) = self.by_object.remove(&object_key) {
            self.total_bytes = self.total_bytes.saturating_sub(previous.total_bytes());
            self.order.retain(|key| key != &object_key);
            retired.push(previous);
        }
        self.total_bytes = self.total_bytes.saturating_add(prepared.total_bytes());
        self.order.push_back(object_key.clone());
        self.by_object.insert(object_key.clone(), prepared.clone());
        self.active_generation = Some(prepared.generation);
        self.active_object = Some(object_key);
        while self.by_object.len() > self.max_observations || self.total_bytes > self.max_bytes {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if self.active_object.as_deref() == Some(oldest.as_str()) && self.by_object.len() == 1 {
                break;
            }
            if let Some(removed) = self.by_object.remove(&oldest) {
                self.total_bytes = self.total_bytes.saturating_sub(removed.total_bytes());
                retired.push(removed);
            }
        }
        Ok(retired)
    }

    fn active(&self, generation: u64) -> Result<Arc<PreparedNationalFrame>, TransferError> {
        if self.active_generation != Some(generation) {
            return Err(TransferError::new(
                "national_prepared_generation_stale",
                format!("generation {generation} has no prepared National frame"),
            ));
        }
        let key = self.active_object.as_ref().ok_or_else(|| {
            TransferError::new(
                "national_not_prepared",
                "no National Phase 2 frame has been prepared",
            )
        })?;
        self.by_object.get(key).cloned().ok_or_else(|| {
            TransferError::new(
                "national_cache_inconsistent",
                "active National frame is absent from the direct index",
            )
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct NationalPhase2State {
    inner: Arc<Mutex<PreparedCache>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NationalRetentionDiagnostic {
    pub diagnostic_only: bool,
    pub schema_version: u16,
    pub renderer_model: &'static str,
    pub presentation_factor: u16,
    pub normal_retained_observations: usize,
    pub extension_retained_observations: usize,
    pub measured_observation_count: usize,
    pub distinct_observation_count: usize,
    pub measured_timeline_span_minutes: f64,
    pub measured_total_chunk_count: usize,
    pub all_frames_wire_validated: bool,
    pub exact_source_objects_retained: bool,
    pub retained_compressed_bytes: usize,
    pub diagnostic_ms: f64,
    pub per_frame_gpu_bytes: usize,
    pub twenty_plus_staging_gpu_bytes: usize,
    pub thirty_plus_staging_gpu_bytes: usize,
    pub target_bytes: usize,
    pub hard_ceiling_bytes: usize,
    pub extension_within_target: bool,
    pub schema_change_required: bool,
    pub renderer_model_change_required: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NationalPhase2PrepareReport {
    pub diagnostic_only: bool,
    pub generation: u64,
    pub object_key: String,
    pub observation_time_unix_ms: i64,
    pub acquisition_network_requests: u64,
    pub acquisition_response_bytes: u64,
    pub compressed_bytes: usize,
    pub compressed_sha256: String,
    pub grib_sha256: String,
    pub normalized_sha256: String,
    pub normalized_bytes: usize,
    pub retained_backend_bytes: usize,
    pub manifest_bytes: usize,
    pub chunk_count: usize,
    pub chunk_transfer_bytes: usize,
    pub discovery_ms: f64,
    pub download_ms: f64,
    pub decode_and_level_ms: f64,
    pub packed_grid: PackedGridManifestSummary,
    pub retention_extension: NationalRetentionDiagnostic,
}

#[tauri::command]
pub async fn prepare_national_phase2_diagnostic(
    broker: tauri::State<'_, TransferBroker>,
    state: tauri::State<'_, NationalPhase2State>,
    session: u64,
    generation: u64,
) -> Result<NationalPhase2PrepareReport, TransferError> {
    let broker = broker.inner().clone();
    let token = broker.live_generation_token(session, generation)?;
    let client =
        MrmsClient::new().map_err(|error| TransferError::new(error.code(), error.to_string()))?;

    let discovery_started = Instant::now();
    let objects = client
        .discover_latest_count(Utc::now(), EXTENSION_FRAME_COUNT)
        .await
        .map_err(|error| TransferError::new(error.code(), error.to_string()))?;
    token
        .ensure_current()
        .map_err(|error| TransferError::new("national_generation_stale", error.to_string()))?;
    let discovery_ms = discovery_started.elapsed().as_secs_f64() * 1_000.0;

    let object = objects
        .last()
        .cloned()
        .expect("30-object discovery returns a newest object");
    let download_started = Instant::now();
    let download = Arc::new(
        client
            .download(&object)
            .await
            .map_err(|error| TransferError::new(error.code(), error.to_string()))?,
    );
    token
        .ensure_current()
        .map_err(|error| TransferError::new("national_generation_stale", error.to_string()))?;
    let download_ms = download_started.elapsed().as_secs_f64() * 1_000.0;

    let decode_started = Instant::now();
    let (evidence, pyramid, frame) = build_frame(download.clone(), generation).await?;
    token
        .ensure_current()
        .map_err(|error| TransferError::new("national_generation_stale", error.to_string()))?;
    let decode_and_level_ms = decode_started.elapsed().as_secs_f64() * 1_000.0;
    let retained_backend_bytes = pyramid.retained_bytes();

    let retention_started = Instant::now();
    let mut extension_frames = Vec::with_capacity(EXTENSION_FRAME_COUNT);
    let mut retained_downloads = Vec::with_capacity(EXTENSION_FRAME_COUNT);
    retained_downloads.push(download);
    for candidate in &objects {
        if candidate.key == evidence.object_key {
            extension_frames.push(frame.clone());
            continue;
        }
        let download = Arc::new(
            client
                .download(candidate)
                .await
                .map_err(|error| TransferError::new(error.code(), error.to_string()))?,
        );
        token
            .ensure_current()
            .map_err(|error| TransferError::new("national_generation_stale", error.to_string()))?;
        let (_, historical_pyramid, historical_frame) =
            build_frame(download.clone(), generation).await?;
        drop(historical_pyramid);
        retained_downloads.push(download);
        extension_frames.push(historical_frame);
    }
    token
        .ensure_current()
        .map_err(|error| TransferError::new("national_generation_stale", error.to_string()))?;
    extension_frames.sort_by_key(|candidate| candidate.summary.observation_time_unix_ms);
    let retention_extension = retention_diagnostic(
        &extension_frames,
        retained_downloads.len(),
        retained_downloads
            .iter()
            .map(|download| download.compressed_bytes.len())
            .sum(),
        retention_started.elapsed().as_secs_f64() * 1_000.0,
    )?;
    let report = NationalPhase2PrepareReport {
        diagnostic_only: true,
        generation,
        object_key: evidence.object_key.clone(),
        observation_time_unix_ms: evidence.observation_time_unix_ms,
        acquisition_network_requests: client.counters().network_requests,
        acquisition_response_bytes: client.counters().response_bytes,
        compressed_bytes: evidence.compressed_bytes,
        compressed_sha256: evidence.compressed_sha256,
        grib_sha256: evidence.grib_sha256,
        normalized_sha256: evidence.normalized_sha256,
        normalized_bytes: evidence.normalized_bytes,
        retained_backend_bytes,
        manifest_bytes: frame.manifest.len(),
        chunk_count: frame.chunks.len(),
        chunk_transfer_bytes: frame.chunks.iter().map(Vec::len).sum(),
        discovery_ms,
        download_ms,
        decode_and_level_ms,
        packed_grid: frame.summary.clone(),
        retention_extension,
    };
    let prepared = Arc::new(PreparedNationalFrame {
        generation,
        pyramid: Arc::new(pyramid),
        frame,
    });
    let mut cache = state.inner.lock().map_err(|_| {
        TransferError::new(
            "national_cache_poisoned",
            "National Phase 2 cache is unavailable after an internal panic",
        )
    })?;
    let retired = cache.insert(evidence.object_key, prepared)?;
    drop(cache);
    drop(retired);
    Ok(report)
}

async fn build_frame(
    download: Arc<DownloadedMrmsObject>,
    generation: u64,
) -> Result<(MrmsDecodeEvidence, MrmsNumericPyramid, PackedGridFrame), TransferError> {
    tauri::async_runtime::spawn_blocking(move || {
        let decoded = decode_mrms_gzip(&download.compressed_bytes, download.object.clone())
            .map_err(|error| TransferError::new(error.code(), error.to_string()))?;
        let evidence = decoded.evidence.clone();
        let pyramid =
            MrmsNumericPyramid::from_decoded(decoded, OVERVIEW_FACTOR).map_err(|error| {
                TransferError::new("national_level_generation_failed", error.to_string())
            })?;
        let frame =
            PackedGridFrame::encode(generation, &pyramid, OVERVIEW_FACTOR).map_err(|error| {
                TransferError::new("national_packed_grid_failed", error.to_string())
            })?;
        Ok::<_, TransferError>((evidence, pyramid, frame))
    })
    .await
    .map_err(|error| TransferError::new("national_backend_task_failed", error.to_string()))?
}

#[tauri::command]
pub async fn request_national_packed_grid_manifest(
    broker: tauri::State<'_, TransferBroker>,
    state: tauri::State<'_, NationalPhase2State>,
    session: u64,
    generation: u64,
) -> Result<Response, TransferError> {
    let broker = broker.inner().clone();
    broker.acquire(session, generation)?;
    let result = prepared_bytes(&state, generation, |prepared| {
        prepared.frame.manifest.clone()
    });
    publish_bytes(broker, session, generation, result)
}

#[tauri::command]
pub async fn request_national_packed_grid_chunk(
    broker: tauri::State<'_, TransferBroker>,
    state: tauri::State<'_, NationalPhase2State>,
    session: u64,
    generation: u64,
    chunk_index: u32,
) -> Result<Response, TransferError> {
    let broker = broker.inner().clone();
    broker.acquire(session, generation)?;
    let result = prepared_bytes(&state, generation, |prepared| {
        prepared
            .frame
            .chunks
            .get(chunk_index as usize)
            .cloned()
            .ok_or_else(|| {
                TransferError::new(
                    "national_chunk_not_found",
                    format!("chunk {chunk_index} is outside the prepared manifest"),
                )
            })
    })
    .and_then(|result| result);
    publish_bytes(broker, session, generation, result)
}

fn prepared_bytes<T>(
    state: &NationalPhase2State,
    generation: u64,
    read: impl FnOnce(&PreparedNationalFrame) -> T,
) -> Result<T, TransferError> {
    let prepared = {
        let cache = state.inner.lock().map_err(|_| {
            TransferError::new(
                "national_cache_poisoned",
                "National Phase 2 cache is unavailable after an internal panic",
            )
        })?;
        cache.active(generation)?
    };
    Ok(read(&prepared))
}

fn publish_bytes(
    broker: TransferBroker,
    session: u64,
    generation: u64,
    bytes: Result<Vec<u8>, TransferError>,
) -> Result<Response, TransferError> {
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(error) => {
            broker.finish_without_publish(session);
            return Err(error);
        }
    };
    broker.complete_for_publish(session, generation)?;
    Ok(Response::new(bytes))
}

fn retention_diagnostic(
    frames: &[PackedGridFrame],
    retained_observation_count: usize,
    retained_compressed_bytes: usize,
    diagnostic_ms: f64,
) -> Result<NationalRetentionDiagnostic, TransferError> {
    if frames.len() != EXTENSION_FRAME_COUNT
        || retained_observation_count != EXTENSION_FRAME_COUNT
        || retained_compressed_bytes == 0
    {
        return Err(TransferError::new(
            "national_retention_diagnostic_failed",
            format!(
                "30-observation diagnostic received {} frames, {retained_observation_count} exact objects, and {retained_compressed_bytes} compressed bytes",
                frames.len()
            ),
        ));
    }
    let mut observation_ids = std::collections::BTreeSet::new();
    let mut per_frame_bytes = Vec::with_capacity(frames.len());
    let mut measured_total_chunk_count = 0usize;
    for frame in frames {
        let manifest = validate_packed_grid_manifest(&frame.manifest).map_err(|error| {
            TransferError::new("national_retention_diagnostic_failed", error.to_string())
        })?;
        if manifest.version != PACKED_GRID_VERSION
            || manifest.presentation_factor != OVERVIEW_FACTOR
            || manifest.chunks.len() != frame.chunks.len()
        {
            return Err(TransferError::new(
                "national_retention_diagnostic_failed",
                "one retained frame changed the PackedGrid schema or working-set level",
            ));
        }
        observation_ids.insert((
            manifest.observation_time_unix_ms,
            manifest.content_sha256.clone(),
        ));
        measured_total_chunk_count += frame.chunks.len();
        let bytes = frame
            .chunks
            .iter()
            .zip(&manifest.chunks)
            .map(|(chunk, expected)| {
                let summary = validate_packed_grid_chunk(chunk).map_err(|error| {
                    TransferError::new("national_retention_diagnostic_failed", error.to_string())
                })?;
                if summary.generation != manifest.generation
                    || summary.observation_time_unix_ms != manifest.observation_time_unix_ms
                    || summary.content_sha256 != manifest.content_sha256
                    || summary.presentation_factor != manifest.presentation_factor
                    || summary.level_width != manifest.width
                    || summary.level_height != manifest.height
                    || summary.chunk != *expected
                {
                    return Err(TransferError::new(
                        "national_retention_diagnostic_failed",
                        "one retained chunk does not match its frame manifest",
                    ));
                }
                Ok(usize::from(summary.chunk.halo_width)
                    * usize::from(summary.chunk.halo_height)
                    * 2)
            })
            .sum::<Result<usize, _>>()?;
        per_frame_bytes.push(bytes);
    }
    if observation_ids.len() != EXTENSION_FRAME_COUNT {
        return Err(TransferError::new(
            "national_retention_diagnostic_failed",
            "30-observation diagnostic contains duplicate identities",
        ));
    }
    let per_frame_gpu_bytes = *per_frame_bytes.iter().max().expect("30 measured frames");
    let staging_bytes = per_frame_gpu_bytes;
    let twenty_plus_staging_gpu_bytes = per_frame_bytes
        [per_frame_bytes.len() - RETAINED_FRAME_COUNT..]
        .iter()
        .sum::<usize>()
        + staging_bytes;
    let thirty_plus_staging_gpu_bytes = per_frame_bytes.iter().sum::<usize>() + staging_bytes;
    let first_time = frames.first().unwrap().summary.observation_time_unix_ms;
    let last_time = frames.last().unwrap().summary.observation_time_unix_ms;
    Ok(NationalRetentionDiagnostic {
        diagnostic_only: true,
        schema_version: PACKED_GRID_VERSION,
        renderer_model: "numeric_chunk_working_set_v1",
        presentation_factor: frames[0].summary.presentation_factor,
        normal_retained_observations: RETAINED_FRAME_COUNT,
        extension_retained_observations: EXTENSION_FRAME_COUNT,
        measured_observation_count: frames.len(),
        distinct_observation_count: observation_ids.len(),
        measured_timeline_span_minutes: (last_time - first_time) as f64 / 60_000.0,
        measured_total_chunk_count,
        all_frames_wire_validated: true,
        exact_source_objects_retained: true,
        retained_compressed_bytes,
        diagnostic_ms,
        per_frame_gpu_bytes,
        twenty_plus_staging_gpu_bytes,
        thirty_plus_staging_gpu_bytes,
        target_bytes: GPU_TARGET_BYTES,
        hard_ceiling_bytes: GPU_HARD_CEILING_BYTES,
        extension_within_target: thirty_plus_staging_gpu_bytes < GPU_TARGET_BYTES,
        schema_change_required: false,
        renderer_model_change_required: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mrms::{MrmsGridDefinition, MrmsRowOrientation, MrmsValueEncoding};
    use crate::packed_grid::NumericGridLevel;

    fn frame(generation: u64, key_suffix: &str) -> PackedGridFrame {
        let object_key = format!(
            "CONUS/MergedBaseReflectivityQC_00.50/20260803/MRMS_MergedBaseReflectivityQC_00.50_20260803-{key_suffix}.grib2.gz"
        );
        let identity = (key_suffix.parse::<u32>().unwrap() / 100 + 1) as u8;
        let level = NumericGridLevel {
            factor: 4,
            width: 1_750,
            height: 875,
            raw_codes: vec![identity as u16; 1_750 * 875],
        };
        let pyramid = MrmsNumericPyramid {
            observation_time_unix_ms: crate::mrms::MrmsObject::parse_key(&object_key).unwrap(),
            object_key,
            content_sha256: [identity; 32],
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
        };
        PackedGridFrame::encode(generation, &pyramid, 4).unwrap()
    }

    fn frames30() -> Vec<PackedGridFrame> {
        (0..30)
            .map(|index| frame(7, &format!("00{:02}00", index * 2)))
            .collect()
    }

    #[test]
    fn prepared_cache_is_directly_indexed_and_bounded() {
        let mut cache = PreparedCache {
            max_observations: 2,
            max_bytes: usize::MAX,
            ..PreparedCache::default()
        };
        for (generation, suffix) in [(1, "000001"), (2, "000002"), (3, "000003")] {
            let frame = frame(generation, suffix);
            let key = frame.summary.object_key.clone();
            drop(
                cache
                    .insert(
                        key,
                        Arc::new(PreparedNationalFrame {
                            generation,
                            pyramid: Arc::new(MrmsNumericPyramid {
                                object_key: "cache-test".into(),
                                observation_time_unix_ms: generation as i64,
                                content_sha256: [0; 32],
                                grid: MrmsGridDefinition {
                                    width: 1,
                                    height: 1,
                                    first_latitude_degrees: 0.0,
                                    first_longitude_degrees: 0.0,
                                    last_latitude_degrees: 0.0,
                                    last_longitude_degrees: 0.0,
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
                                levels: BTreeMap::new(),
                            }),
                            frame,
                        }),
                    )
                    .unwrap(),
            );
        }
        assert_eq!(cache.by_object.len(), 2);
        assert!(cache.active(3).is_ok());
        assert!(cache.active(2).is_err());
    }

    #[test]
    fn prepared_cache_rejects_one_frame_larger_than_its_byte_bound() {
        let frame = frame(1, "000001");
        let mut cache = PreparedCache {
            max_observations: 2,
            max_bytes: 1,
            ..PreparedCache::default()
        };
        let result = cache.insert(
            frame.summary.object_key.clone(),
            Arc::new(PreparedNationalFrame {
                generation: 1,
                pyramid: Arc::new(MrmsNumericPyramid {
                    object_key: "cache-test".into(),
                    observation_time_unix_ms: 1,
                    content_sha256: [0; 32],
                    grid: MrmsGridDefinition {
                        width: 1,
                        height: 1,
                        first_latitude_degrees: 0.0,
                        first_longitude_degrees: 0.0,
                        last_latitude_degrees: 0.0,
                        last_longitude_degrees: 0.0,
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
                    levels: BTreeMap::new(),
                }),
                frame,
            }),
        );
        assert!(result.is_err());
        assert!(cache.by_object.is_empty());
        assert_eq!(cache.total_bytes, 0);
    }

    #[test]
    fn thirty_frame_diagnostic_reuses_schema_and_stays_bounded() {
        let report = retention_diagnostic(&frames30(), 30, 42_000_000, 12.5).unwrap();
        assert_eq!(report.schema_version, 1);
        assert_eq!(report.extension_retained_observations, 30);
        assert_eq!(report.measured_observation_count, 30);
        assert_eq!(report.distinct_observation_count, 30);
        assert!(report.all_frames_wire_validated);
        assert!(report.exact_source_objects_retained);
        assert_eq!(report.retained_compressed_bytes, 42_000_000);
        assert!(report.extension_within_target);
        assert!(!report.schema_change_required);
        assert!(!report.renderer_model_change_required);
    }

    #[test]
    fn manifest_validation_remains_required_before_retention_math() {
        let mut invalid = frames30();
        invalid[0].chunks[0][crate::packed_grid::PACKED_GRID_HEADER_BYTES] ^= 1;
        assert!(retention_diagnostic(&invalid, 30, 1, 1.0).is_err());
        assert!(crate::packed_grid::validate_packed_grid_manifest(&invalid[0].manifest).is_ok());
    }
}
