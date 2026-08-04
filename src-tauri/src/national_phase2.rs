//! National MRMS acquisition, exact retained grids, and PackedGrid transfer wiring.
//!
//! Phase 2 diagnostics and the Phase 3 static product share this fixed-host,
//! bounded backend. Product paint truth remains owned by the frontend session,
//! coverage-aware renderer receipt, and the existing global two-credit broker.

use crate::mrms::{
    DownloadedMrmsObject, MrmsCellValue, MrmsClient, MrmsDecodeEvidence, decode_mrms_gzip,
};
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
    frames: BTreeMap<u16, PackedGridFrame>,
}

impl PreparedNationalFrame {
    fn total_bytes(&self) -> usize {
        self.pyramid.retained_bytes()
            + self
                .frames
                .values()
                .map(PackedGridFrame::transfer_bytes)
                .sum::<usize>()
    }

    fn frame(&self, presentation_factor: u16) -> Result<&PackedGridFrame, TransferError> {
        self.frames.get(&presentation_factor).ok_or_else(|| {
            TransferError::new(
                "national_presentation_level_unavailable",
                format!(
                    "presentation factor {presentation_factor} is unavailable for generation {}",
                    self.generation
                ),
            )
        })
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

    fn matching_identity(
        &self,
        generation: u64,
        observation_time_unix_ms: i64,
        content_sha256: &str,
    ) -> Result<Arc<PreparedNationalFrame>, TransferError> {
        self.by_object
            .values()
            .find(|prepared| {
                prepared.generation == generation
                    && prepared.pyramid.observation_time_unix_ms == observation_time_unix_ms
                    && sha256_hex(&prepared.pyramid.content_sha256) == content_sha256
            })
            .cloned()
            .ok_or_else(|| {
                TransferError::new(
                    "national_point_identity_stale",
                    "point lookup does not match a retained National observation",
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NationalPhase3PrepareReport {
    pub generation: u64,
    pub object_key: String,
    pub observation_time_unix_ms: i64,
    pub compressed_sha256: String,
    pub normalized_sha256: String,
    pub compressed_bytes: usize,
    pub retained_backend_bytes: usize,
    pub presentation_factors: Vec<u16>,
    pub presentation_gpu_bytes: Vec<NationalPresentationBytes>,
    pub discovery_ms: f64,
    pub download_ms: f64,
    pub decode_and_level_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NationalPresentationBytes {
    pub presentation_factor: u16,
    pub chunk_count: usize,
    pub transfer_bytes: usize,
    pub projected_gpu_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NationalPointLookup {
    pub inspection_id: String,
    pub generation: u64,
    pub observation_time_unix_ms: i64,
    pub content_sha256: String,
    pub object_key: String,
    pub longitude: f64,
    pub latitude: f64,
    pub row: u32,
    pub column: u32,
    pub raw_code: u16,
    pub status: &'static str,
    pub value_dbz: Option<f64>,
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
        frames: BTreeMap::from([(OVERVIEW_FACTOR, frame)]),
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

#[tauri::command]
pub async fn prepare_national_phase3_frame(
    broker: tauri::State<'_, TransferBroker>,
    state: tauri::State<'_, NationalPhase2State>,
    session: u64,
    generation: u64,
) -> Result<NationalPhase3PrepareReport, TransferError> {
    let broker = broker.inner().clone();
    let token = broker.live_generation_token(session, generation)?;
    let client =
        MrmsClient::new().map_err(|error| TransferError::new(error.code(), error.to_string()))?;

    let discovery_started = Instant::now();
    let object = client
        .discover_latest_count(Utc::now(), 1)
        .await
        .map_err(|error| TransferError::new(error.code(), error.to_string()))?
        .pop()
        .ok_or_else(|| TransferError::new("national_inventory_empty", "no current MRMS object"))?;
    token
        .ensure_current()
        .map_err(|error| TransferError::new("national_generation_stale", error.to_string()))?;
    let discovery_ms = discovery_started.elapsed().as_secs_f64() * 1_000.0;

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
    let (evidence, pyramid, frames) = build_static_frames(download, generation).await?;
    token
        .ensure_current()
        .map_err(|error| TransferError::new("national_generation_stale", error.to_string()))?;
    let decode_and_level_ms = decode_started.elapsed().as_secs_f64() * 1_000.0;
    let retained_backend_bytes = pyramid.retained_bytes();
    let presentation_gpu_bytes = frames
        .iter()
        .map(|(&presentation_factor, frame)| NationalPresentationBytes {
            presentation_factor,
            chunk_count: frame.chunks.len(),
            transfer_bytes: frame.transfer_bytes(),
            projected_gpu_bytes: frame
                .summary
                .chunks
                .iter()
                .map(|chunk| usize::from(chunk.halo_width) * usize::from(chunk.halo_height) * 2)
                .sum(),
        })
        .collect::<Vec<_>>();
    let presentation_factors = frames.keys().copied().collect::<Vec<_>>();
    let report = NationalPhase3PrepareReport {
        generation,
        object_key: evidence.object_key.clone(),
        observation_time_unix_ms: evidence.observation_time_unix_ms,
        compressed_sha256: evidence.compressed_sha256,
        normalized_sha256: evidence.normalized_sha256,
        compressed_bytes: evidence.compressed_bytes,
        retained_backend_bytes,
        presentation_factors,
        presentation_gpu_bytes,
        discovery_ms,
        download_ms,
        decode_and_level_ms,
    };
    let prepared = Arc::new(PreparedNationalFrame {
        generation,
        pyramid: Arc::new(pyramid),
        frames,
    });
    let mut cache = state.inner.lock().map_err(|_| {
        TransferError::new(
            "national_cache_poisoned",
            "National frame cache is unavailable after an internal panic",
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

async fn build_static_frames(
    download: Arc<DownloadedMrmsObject>,
    generation: u64,
) -> Result<
    (
        MrmsDecodeEvidence,
        MrmsNumericPyramid,
        BTreeMap<u16, PackedGridFrame>,
    ),
    TransferError,
> {
    tauri::async_runtime::spawn_blocking(move || {
        let decoded = decode_mrms_gzip(&download.compressed_bytes, download.object.clone())
            .map_err(|error| TransferError::new(error.code(), error.to_string()))?;
        let evidence = decoded.evidence.clone();
        let pyramid =
            MrmsNumericPyramid::from_decoded(decoded, OVERVIEW_FACTOR).map_err(|error| {
                TransferError::new("national_level_generation_failed", error.to_string())
            })?;
        let mut frames = BTreeMap::new();
        for presentation_factor in [1, 2, OVERVIEW_FACTOR] {
            let frame = PackedGridFrame::encode(generation, &pyramid, presentation_factor)
                .map_err(|error| {
                    TransferError::new("national_packed_grid_failed", error.to_string())
                })?;
            frames.insert(presentation_factor, frame);
        }
        Ok::<_, TransferError>((evidence, pyramid, frames))
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
    presentation_factor: Option<u16>,
) -> Result<Response, TransferError> {
    let broker = broker.inner().clone();
    broker.acquire(session, generation)?;
    let factor = presentation_factor.unwrap_or(OVERVIEW_FACTOR);
    let result = prepared_bytes(&state, generation, |prepared| {
        prepared.frame(factor).map(|frame| frame.manifest.clone())
    })
    .and_then(|result| result);
    publish_bytes(broker, session, generation, result)
}

#[tauri::command]
pub async fn request_national_packed_grid_chunk(
    broker: tauri::State<'_, TransferBroker>,
    state: tauri::State<'_, NationalPhase2State>,
    session: u64,
    generation: u64,
    chunk_index: u32,
    presentation_factor: Option<u16>,
) -> Result<Response, TransferError> {
    let broker = broker.inner().clone();
    broker.acquire(session, generation)?;
    let factor = presentation_factor.unwrap_or(OVERVIEW_FACTOR);
    let result = prepared_bytes(&state, generation, |prepared| {
        prepared
            .frame(factor)?
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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lookup_national_grid_point(
    state: tauri::State<'_, NationalPhase2State>,
    session: u64,
    generation: u64,
    observation_time_unix_ms: i64,
    content_sha256: String,
    inspection_id: String,
    longitude: f64,
    latitude: f64,
) -> Result<NationalPointLookup, TransferError> {
    let _session = session;
    if inspection_id.is_empty()
        || inspection_id.len() > 128
        || !longitude.is_finite()
        || !latitude.is_finite()
    {
        return Err(TransferError::new(
            "national_point_invalid",
            "inspection identity and coordinates must be bounded and finite",
        ));
    }
    let prepared = {
        let cache = state.inner.lock().map_err(|_| {
            TransferError::new(
                "national_cache_poisoned",
                "National frame cache is unavailable after an internal panic",
            )
        })?;
        cache.matching_identity(generation, observation_time_unix_ms, &content_sha256)?
    };
    lookup_prepared_point(
        &prepared,
        generation,
        observation_time_unix_ms,
        content_sha256,
        inspection_id,
        longitude,
        latitude,
    )
}

#[tauri::command]
pub async fn find_national_peak_point(
    state: tauri::State<'_, NationalPhase2State>,
    session: u64,
    generation: u64,
    observation_time_unix_ms: i64,
    content_sha256: String,
    inspection_id: String,
) -> Result<NationalPointLookup, TransferError> {
    let _session = session;
    if inspection_id.is_empty() || inspection_id.len() > 128 {
        return Err(TransferError::new(
            "national_point_invalid",
            "inspection identity must be bounded",
        ));
    }
    let prepared = {
        let cache = state.inner.lock().map_err(|_| {
            TransferError::new(
                "national_cache_poisoned",
                "National frame cache is unavailable after an internal panic",
            )
        })?;
        cache.matching_identity(generation, observation_time_unix_ms, &content_sha256)?
    };
    let peak_prepared = prepared.clone();
    let (longitude, latitude) =
        tauri::async_runtime::spawn_blocking(move || find_peak_coordinates(&peak_prepared))
            .await
            .map_err(|error| {
                TransferError::new("national_backend_task_failed", error.to_string())
            })??;
    lookup_prepared_point(
        &prepared,
        generation,
        observation_time_unix_ms,
        content_sha256,
        inspection_id,
        longitude,
        latitude,
    )
}

fn find_peak_coordinates(prepared: &PreparedNationalFrame) -> Result<(f64, f64), TransferError> {
    let pyramid = &prepared.pyramid;
    let base = pyramid.levels.get(&1).ok_or_else(|| {
        TransferError::new(
            "national_base_level_missing",
            "exact base grid is unavailable",
        )
    })?;
    let (index, _) = base
        .raw_codes
        .iter()
        .enumerate()
        .filter(|(_, raw)| matches!(pyramid.encoding.decode_raw(**raw), MrmsCellValue::Valid(_)))
        .max_by_key(|(_, raw)| **raw)
        .ok_or_else(|| {
            TransferError::new(
                "national_valid_point_missing",
                "retained National observation contains no valid cells",
            )
        })?;
    let row = index / base.width;
    let column = index % base.width;
    Ok((
        pyramid.grid.first_longitude_degrees + column as f64 * pyramid.grid.longitude_step_degrees,
        pyramid.grid.first_latitude_degrees - row as f64 * pyramid.grid.latitude_step_degrees,
    ))
}

#[allow(clippy::too_many_arguments)]
fn lookup_prepared_point(
    prepared: &PreparedNationalFrame,
    generation: u64,
    observation_time_unix_ms: i64,
    content_sha256: String,
    inspection_id: String,
    longitude: f64,
    latitude: f64,
) -> Result<NationalPointLookup, TransferError> {
    let pyramid = &prepared.pyramid;
    let grid = &pyramid.grid;
    let column = ((longitude - grid.first_longitude_degrees) / grid.longitude_step_degrees).round();
    let row = ((grid.first_latitude_degrees - latitude) / grid.latitude_step_degrees).round();
    if column < 0.0 || row < 0.0 || column >= f64::from(grid.width) || row >= f64::from(grid.height)
    {
        return Err(TransferError::new(
            "national_point_outside_coverage",
            "inspection coordinate is outside the MRMS CONUS grid",
        ));
    }
    let column = column as u32;
    let row = row as u32;
    let base = pyramid.levels.get(&1).ok_or_else(|| {
        TransferError::new(
            "national_base_level_missing",
            "exact base grid is unavailable",
        )
    })?;
    let index = usize::try_from(row)
        .ok()
        .and_then(|row| row.checked_mul(base.width))
        .and_then(|offset| {
            usize::try_from(column)
                .ok()
                .and_then(|column| offset.checked_add(column))
        })
        .ok_or_else(|| TransferError::new("national_point_invalid", "grid index overflowed"))?;
    let raw_code = *base.raw_codes.get(index).ok_or_else(|| {
        TransferError::new(
            "national_point_invalid",
            "grid index is outside retained data",
        )
    })?;
    let (status, value_dbz) = match pyramid.encoding.decode_raw(raw_code) {
        MrmsCellValue::Valid(value) => ("valid", Some(value)),
        MrmsCellValue::Missing => ("missing", None),
        MrmsCellValue::NoCoverage => ("no_coverage", None),
    };
    Ok(NationalPointLookup {
        inspection_id,
        generation,
        observation_time_unix_ms,
        content_sha256,
        object_key: pyramid.object_key.clone(),
        longitude,
        latitude,
        row,
        column,
        raw_code,
        status,
        value_dbz,
    })
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

fn sha256_hex(bytes: &[u8; 32]) -> String {
    use std::fmt::Write;
    let mut encoded = String::with_capacity(64);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
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

    fn point_lookup_frame() -> PreparedNationalFrame {
        PreparedNationalFrame {
            generation: 12,
            pyramid: Arc::new(MrmsNumericPyramid {
                object_key: "CONUS/MergedBaseReflectivityQC_00.50/20260803/MRMS_MergedBaseReflectivityQC_00.50_20260803-162812.grib2.gz".into(),
                observation_time_unix_ms: 1_785_775_692_000,
                content_sha256: [0xab; 32],
                grid: MrmsGridDefinition {
                    width: 2,
                    height: 2,
                    first_latitude_degrees: 40.0,
                    first_longitude_degrees: -100.0,
                    last_latitude_degrees: 39.99,
                    last_longitude_degrees: -99.99,
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
                levels: BTreeMap::from([(
                    1,
                    NumericGridLevel {
                        factor: 1,
                        width: 2,
                        height: 2,
                        raw_codes: vec![9_990, 9_000, 0, 65_535],
                    },
                )]),
            }),
            frames: BTreeMap::new(),
        }
    }

    #[test]
    fn exact_point_lookup_uses_retained_base_grid_and_echoes_identity() {
        let prepared = point_lookup_frame();
        let valid = lookup_prepared_point(
            &prepared,
            12,
            1_785_775_692_000,
            "ab".repeat(32),
            "inspect-valid".into(),
            -100.0,
            40.0,
        )
        .unwrap();
        assert_eq!(valid.status, "valid");
        assert_eq!(valid.raw_code, 9_990);
        assert_eq!(valid.value_dbz, Some(0.0));
        assert_eq!(valid.row, 0);
        assert_eq!(valid.column, 0);
        assert_eq!(valid.inspection_id, "inspect-valid");

        let missing = lookup_prepared_point(
            &prepared,
            12,
            1_785_775_692_000,
            "ab".repeat(32),
            "inspect-missing".into(),
            -99.99,
            40.0,
        )
        .unwrap();
        assert_eq!(missing.status, "missing");
        assert_eq!(missing.value_dbz, None);

        let no_coverage = lookup_prepared_point(
            &prepared,
            12,
            1_785_775_692_000,
            "ab".repeat(32),
            "inspect-none".into(),
            -100.0,
            39.99,
        )
        .unwrap();
        assert_eq!(no_coverage.status, "no_coverage");
    }

    #[test]
    fn point_lookup_identity_rejects_stale_generation_time_or_hash() {
        let mut cache = PreparedCache::default();
        let prepared = Arc::new(point_lookup_frame());
        cache
            .insert(prepared.pyramid.object_key.clone(), prepared)
            .unwrap();
        assert!(
            cache
                .matching_identity(12, 1_785_775_692_000, &"ab".repeat(32))
                .is_ok()
        );
        assert!(
            cache
                .matching_identity(11, 1_785_775_692_000, &"ab".repeat(32))
                .is_err()
        );
        assert!(
            cache
                .matching_identity(12, 1_785_775_692_001, &"ab".repeat(32))
                .is_err()
        );
        assert!(
            cache
                .matching_identity(12, 1_785_775_692_000, &"cd".repeat(32))
                .is_err()
        );
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
                            frames: BTreeMap::from([(OVERVIEW_FACTOR, frame)]),
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
                frames: BTreeMap::from([(OVERVIEW_FACTOR, frame)]),
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
