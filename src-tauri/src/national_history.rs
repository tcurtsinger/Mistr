//! Phase 4 bounded rolling MRMS history.
//!
//! Exact immutable gzip objects are the durable retained observations. Every
//! retained frame also owns its complete factor-4 `PackedGrid` overview so the
//! frontend can keep the whole loop GPU resident. Fine presentations are a
//! bounded one-at-a-time preparation cache: the frontend retains the uploaded
//! viewport chunks it needs, while exact interrogation can always re-decode
//! the retained immutable object under a single-operation gate.

use crate::mrms::{
    DownloadedMrmsObject, MrmsCellValue, MrmsClient, MrmsDecodeEvidence, MrmsObject,
    bounded_poll_delay, decode_mrms_gzip,
};
use crate::packed_grid::{MrmsNumericPyramid, PackedGridFrame};
use crate::phase2_ipc::{TransferBroker, TransferError};
use chrono::Utc;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::ipc::Response;
use tokio::sync::Semaphore;

const HISTORY_LIMIT: usize = 20;
// Native-residency owner decision (2026-08-04): every retained observation is
// served at the exact full-resolution grid. The presentation named "overview"
// throughout this store is therefore factor 1 — there is exactly one version
// of the data, and no coarser level ever reaches the operator.
const OVERVIEW_FACTOR: u16 = 1;
// Twenty retained native-resolution encodings (~49 MB each) plus one staged
// mutation and the compressed downloads. Sized for the supported desktop
// floor (tens of GB of system memory), not a minimal device.
const HISTORY_BACKEND_TARGET_BYTES: usize = 2048 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NationalHistoryMutationKind {
    Current,
    Predecessor,
    Newer,
}

#[derive(Debug, Clone)]
struct RetainedNationalFrame {
    generation: u64,
    download: Arc<DownloadedMrmsObject>,
    evidence: MrmsDecodeEvidence,
    overview: Arc<PackedGridFrame>,
    exact_pyramid: Arc<Mutex<Option<Arc<MrmsNumericPyramid>>>>,
}

impl RetainedNationalFrame {
    fn identity(&self) -> NationalHistoryObservation {
        NationalHistoryObservation {
            generation: self.generation,
            object_key: self.evidence.object_key.clone(),
            observation_time_unix_ms: self.evidence.observation_time_unix_ms,
            content_sha256: self.evidence.compressed_sha256.clone(),
            compressed_bytes: self.evidence.compressed_bytes,
            overview_chunk_count: self.overview.chunks.len(),
            overview_gpu_bytes: self
                .overview
                .summary
                .chunks
                .iter()
                .map(|chunk| usize::from(chunk.halo_width) * usize::from(chunk.halo_height) * 2)
                .sum(),
        }
    }

    fn retained_bytes(&self) -> usize {
        self.download.compressed_bytes.len()
            + self.overview.transfer_bytes()
            + self
                .exact_pyramid
                .lock()
                .ok()
                .and_then(|exact| exact.as_ref().map(|pyramid| pyramid.retained_bytes()))
                .unwrap_or(0)
    }

    fn matches(
        &self,
        generation: u64,
        observation_time_unix_ms: i64,
        content_sha256: &str,
    ) -> bool {
        self.generation == generation
            && self.evidence.observation_time_unix_ms == observation_time_unix_ms
            && self.evidence.compressed_sha256 == content_sha256
    }
}

#[derive(Debug, Clone)]
struct StagedNationalFrame {
    kind: NationalHistoryMutationKind,
    frame: Arc<RetainedNationalFrame>,
}

#[derive(Debug, Clone)]
struct DetailedPresentation {
    generation: u64,
    observation_time_unix_ms: i64,
    content_sha256: String,
    frame: Arc<PackedGridFrame>,
}

#[derive(Debug, Clone)]
struct ReversibleNationalCommit {
    observation: NationalHistoryObservation,
    retained: VecDeque<Arc<RetainedNationalFrame>>,
    backfill_candidates: VecDeque<MrmsObject>,
    detail: Option<DetailedPresentation>,
}

impl ReversibleNationalCommit {
    fn matches(
        &self,
        generation: u64,
        observation_time_unix_ms: i64,
        content_sha256: &str,
    ) -> bool {
        self.observation.generation == generation
            && self.observation.observation_time_unix_ms == observation_time_unix_ms
            && self.observation.content_sha256 == content_sha256
    }
}

fn history_observation_matches(
    observation: &NationalHistoryObservation,
    generation: u64,
    observation_time_unix_ms: i64,
    content_sha256: &str,
) -> bool {
    observation.generation == generation
        && observation.observation_time_unix_ms == observation_time_unix_ms
        && observation.content_sha256 == content_sha256
}

impl DetailedPresentation {
    fn matches(
        &self,
        generation: u64,
        observation_time_unix_ms: i64,
        content_sha256: &str,
    ) -> bool {
        self.generation == generation
            && self.observation_time_unix_ms == observation_time_unix_ms
            && self.content_sha256 == content_sha256
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NationalHistoryActivitySnapshot {
    pub network_requests: u64,
    pub response_bytes: u64,
    pub decoder_runs: u64,
    pub bulk_ipc_transfers: u64,
    pub bulk_ipc_bytes: u64,
    pub point_lookup_decodes: u64,
}

#[derive(Debug)]
struct NationalHistoryStore {
    retained_limit: usize,
    generation: Option<u64>,
    retained: VecDeque<Arc<RetainedNationalFrame>>,
    staged: Option<StagedNationalFrame>,
    backfill_candidates: VecDeque<MrmsObject>,
    detail: Option<DetailedPresentation>,
    reversible_commit: Option<ReversibleNationalCommit>,
    last_finalized_commit: Option<NationalHistoryObservation>,
    activity: NationalHistoryActivitySnapshot,
}

impl Default for NationalHistoryStore {
    fn default() -> Self {
        Self {
            retained_limit: HISTORY_LIMIT,
            generation: None,
            retained: VecDeque::new(),
            staged: None,
            backfill_candidates: VecDeque::new(),
            detail: None,
            reversible_commit: None,
            last_finalized_commit: None,
            activity: NationalHistoryActivitySnapshot::default(),
        }
    }
}

impl NationalHistoryStore {
    fn reset(&mut self, generation: u64, backfill_candidates: VecDeque<MrmsObject>) {
        self.generation = Some(generation);
        self.retained.clear();
        self.staged = None;
        self.backfill_candidates = backfill_candidates;
        self.detail = None;
        self.reversible_commit = None;
        self.last_finalized_commit = None;
    }

    fn ensure_generation(&self, generation: u64) -> Result<(), TransferError> {
        if self.generation != Some(generation) {
            return Err(TransferError::new(
                "national_history_generation_stale",
                format!("generation {generation} does not own National history"),
            ));
        }
        Ok(())
    }

    fn ensure_no_stage(&self) -> Result<(), TransferError> {
        if self.staged.is_some() {
            return Err(TransferError::new(
                "national_history_stage_busy",
                "a National history mutation is already staged",
            ));
        }
        if self.reversible_commit.is_some() {
            return Err(TransferError::new(
                "national_history_commit_unfinalized",
                "the prior National history commit is still reversible",
            ));
        }
        Ok(())
    }

    fn retryable_staged_preparation(
        &self,
        generation: u64,
        kind: NationalHistoryMutationKind,
    ) -> Result<Option<Arc<RetainedNationalFrame>>, TransferError> {
        self.ensure_generation(generation)?;
        if self.reversible_commit.is_some() {
            return Err(TransferError::new(
                "national_history_commit_unfinalized",
                "the prior National history commit is still reversible",
            ));
        }
        match &self.staged {
            None => Ok(None),
            Some(staged) if staged.kind == kind => Ok(Some(staged.frame.clone())),
            Some(_) => Err(TransferError::new(
                "national_history_stage_busy",
                "a different National history mutation is already staged",
            )),
        }
    }

    fn find(
        &self,
        generation: u64,
        observation_time_unix_ms: i64,
        content_sha256: &str,
        include_staged: bool,
    ) -> Result<Arc<RetainedNationalFrame>, TransferError> {
        self.ensure_generation(generation)?;
        if include_staged
            && let Some(staged) = &self.staged
            && staged
                .frame
                .matches(generation, observation_time_unix_ms, content_sha256)
        {
            return Ok(staged.frame.clone());
        }
        self.retained
            .iter()
            .find(|frame| frame.matches(generation, observation_time_unix_ms, content_sha256))
            .cloned()
            .ok_or_else(|| {
                TransferError::new(
                    "national_history_identity_stale",
                    "National observation identity is not retained",
                )
            })
    }

    fn retained_bytes(&self) -> usize {
        self.retained
            .iter()
            .map(|frame| frame.retained_bytes())
            .sum()
    }

    fn staged_bytes(&self) -> usize {
        self.staged
            .as_ref()
            .map(|staged| staged.frame.retained_bytes())
            .unwrap_or(0)
    }

    fn detail_bytes(&self) -> usize {
        self.detail
            .as_ref()
            .map(|detail| detail.frame.transfer_bytes())
            .unwrap_or(0)
    }

    fn matching_detail(
        &self,
        generation: u64,
        observation_time_unix_ms: i64,
        content_sha256: &str,
        presentation_factor: u16,
    ) -> Option<Arc<PackedGridFrame>> {
        self.detail
            .as_ref()
            .filter(|detail| {
                detail.matches(generation, observation_time_unix_ms, content_sha256)
                    && detail.frame.summary.presentation_factor == presentation_factor
            })
            .map(|detail| detail.frame.clone())
    }

    fn total_bytes(&self) -> usize {
        self.retained_bytes()
            + self.staged_bytes()
            + self.detail_bytes()
            + self.reversible_commit_bytes()
    }

    fn reversible_commit_bytes(&self) -> usize {
        self.reversible_commit
            .as_ref()
            .map(|commit| {
                let retained_bytes = commit
                    .retained
                    .iter()
                    .filter(|prior| {
                        !self
                            .retained
                            .iter()
                            .any(|current| Arc::ptr_eq(current, prior))
                    })
                    .map(|frame| frame.retained_bytes())
                    .sum::<usize>();
                let detail_bytes = commit
                    .detail
                    .as_ref()
                    .filter(|prior| {
                        !self
                            .detail
                            .as_ref()
                            .is_some_and(|current| Arc::ptr_eq(&current.frame, &prior.frame))
                    })
                    .map(|detail| detail.frame.transfer_bytes())
                    .unwrap_or(0);
                retained_bytes.saturating_add(detail_bytes)
            })
            .unwrap_or(0)
    }

    fn stage(
        &mut self,
        kind: NationalHistoryMutationKind,
        frame: Arc<RetainedNationalFrame>,
    ) -> Result<(), TransferError> {
        self.ensure_generation(frame.generation)?;
        self.ensure_no_stage()?;
        let projected = self.total_bytes().saturating_add(frame.retained_bytes());
        if projected > HISTORY_BACKEND_TARGET_BYTES {
            return Err(TransferError::new(
                "national_history_backend_budget",
                format!(
                    "staged National history requires {projected} bytes; target is {HISTORY_BACKEND_TARGET_BYTES}"
                ),
            ));
        }
        self.staged = Some(StagedNationalFrame { kind, frame });
        Ok(())
    }

    fn commit_staged(
        &mut self,
        generation: u64,
        observation_time_unix_ms: i64,
        content_sha256: &str,
    ) -> Result<Option<NationalHistoryObservation>, TransferError> {
        self.ensure_generation(generation)?;
        if self.reversible_commit.is_some() {
            return Err(TransferError::new(
                "national_history_commit_unfinalized",
                "the prior National history commit is still reversible",
            ));
        }
        let staged = self.staged.as_ref().cloned().ok_or_else(|| {
            TransferError::new(
                "national_history_stage_missing",
                "no National history mutation is staged",
            )
        })?;
        if !staged
            .frame
            .matches(generation, observation_time_unix_ms, content_sha256)
        {
            return Err(TransferError::new(
                "national_history_commit_stale",
                "commit identity does not match the staged National observation",
            ));
        }
        if self.retained.iter().any(|frame| {
            frame.evidence.object_key == staged.frame.evidence.object_key
                || frame.evidence.compressed_sha256 == staged.frame.evidence.compressed_sha256
        }) {
            return Err(TransferError::new(
                "national_history_duplicate",
                "staged National observation is already retained",
            ));
        }
        let reversible_commit = ReversibleNationalCommit {
            observation: staged.frame.identity(),
            retained: self.retained.clone(),
            backfill_candidates: self.backfill_candidates.clone(),
            detail: self.detail.clone(),
        };
        match staged.kind {
            NationalHistoryMutationKind::Current => {
                if !self.retained.is_empty() {
                    return Err(TransferError::new(
                        "national_history_current_conflict",
                        "current observation can only commit into an empty generation",
                    ));
                }
                self.retained.push_back(staged.frame.clone());
            }
            NationalHistoryMutationKind::Predecessor => {
                if self.retained.front().is_some_and(|oldest| {
                    staged.frame.evidence.observation_time_unix_ms
                        >= oldest.evidence.observation_time_unix_ms
                }) {
                    return Err(TransferError::new(
                        "national_history_not_older",
                        "predecessor is not strictly older than retained history",
                    ));
                }
                self.retained.push_front(staged.frame.clone());
                if self
                    .backfill_candidates
                    .front()
                    .is_some_and(|candidate| candidate.key == staged.frame.evidence.object_key)
                {
                    self.backfill_candidates.pop_front();
                }
            }
            NationalHistoryMutationKind::Newer => {
                if self.retained.back().is_some_and(|newest| {
                    staged.frame.evidence.observation_time_unix_ms
                        <= newest.evidence.observation_time_unix_ms
                }) {
                    return Err(TransferError::new(
                        "national_history_not_newer",
                        "polled observation is not strictly newer than retained history",
                    ));
                }
                self.retained.push_back(staged.frame.clone());
            }
        }
        self.staged = None;
        let evicted = if self.retained.len() > self.retained_limit {
            self.retained.pop_front().map(|frame| frame.identity())
        } else {
            None
        };
        self.reversible_commit = Some(reversible_commit);
        self.last_finalized_commit = None;
        debug_assert!(self.total_bytes() <= HISTORY_BACKEND_TARGET_BYTES);
        Ok(evicted)
    }

    fn finalize_commit(
        &mut self,
        generation: u64,
        observation_time_unix_ms: i64,
        content_sha256: &str,
    ) -> Result<(), TransferError> {
        self.ensure_generation(generation)?;
        if let Some(reversible) = self.reversible_commit.as_ref() {
            if !reversible.matches(generation, observation_time_unix_ms, content_sha256) {
                return Err(TransferError::new(
                    "national_history_commit_stale",
                    "finalization identity does not match the reversible National commit",
                ));
            }
        } else if self
            .last_finalized_commit
            .as_ref()
            .is_some_and(|observation| {
                history_observation_matches(
                    observation,
                    generation,
                    observation_time_unix_ms,
                    content_sha256,
                )
            })
        {
            return Ok(());
        } else {
            return Err(TransferError::new(
                "national_history_commit_missing",
                "no reversible National history commit is awaiting finalization",
            ));
        }
        let Some(finalized) = self.reversible_commit.take() else {
            return Err(TransferError::new(
                "national_history_commit_missing",
                "matching reversible National history commit disappeared",
            ));
        };
        let appended_newest = self.retained.len() > 1
            && self.retained.back().is_some_and(|frame| {
                frame.matches(
                    finalized.observation.generation,
                    finalized.observation.observation_time_unix_ms,
                    &finalized.observation.content_sha256,
                )
            });
        self.last_finalized_commit = Some(finalized.observation);
        if appended_newest {
            for frame in &self.retained {
                let mut exact = frame
                    .exact_pyramid
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                *exact = None;
                frame.exact_pyramid.clear_poison();
            }
        }
        Ok(())
    }

    fn rollback_mutation(
        &mut self,
        generation: u64,
        observation_time_unix_ms: i64,
        content_sha256: &str,
    ) -> Result<(), TransferError> {
        self.ensure_generation(generation)?;
        if let Some(staged) = &self.staged {
            if !staged
                .frame
                .matches(generation, observation_time_unix_ms, content_sha256)
            {
                return Err(TransferError::new(
                    "national_history_rollback_stale",
                    "rollback identity does not match the staged National observation",
                ));
            }
            self.staged = None;
            return Ok(());
        }
        let reversible = self.reversible_commit.take().ok_or_else(|| {
            TransferError::new(
                "national_history_rollback_missing",
                "no matching National history mutation can be rolled back",
            )
        })?;
        if !reversible.matches(generation, observation_time_unix_ms, content_sha256) {
            self.reversible_commit = Some(reversible);
            return Err(TransferError::new(
                "national_history_rollback_stale",
                "rollback identity does not match the reversible National commit",
            ));
        }
        self.retained = reversible.retained;
        self.backfill_candidates = reversible.backfill_candidates;
        self.detail = reversible.detail;
        Ok(())
    }

    fn snapshot(&self) -> NationalHistorySnapshot {
        NationalHistorySnapshot {
            generation: self.generation.unwrap_or(0),
            history_limit: self.retained_limit,
            retained: self.retained.iter().map(|frame| frame.identity()).collect(),
            staged: self.staged.as_ref().map(|staged| staged.frame.identity()),
            mutation_reversible: self.reversible_commit.is_some(),
            pending_backfill_count: self.backfill_candidates.len(),
            retained_backend_bytes: self.retained_bytes(),
            staged_backend_bytes: self.staged_bytes(),
            detailed_cache_bytes: self.detail_bytes(),
            reversible_commit_bytes: self.reversible_commit_bytes(),
            total_backend_bytes: self.total_bytes(),
            backend_target_bytes: HISTORY_BACKEND_TARGET_BYTES,
        }
    }
}

#[derive(Debug, Clone)]
pub struct NationalHistoryState {
    inner: Arc<Mutex<NationalHistoryStore>>,
    point_lookup_gate: Arc<Semaphore>,
}

impl Default for NationalHistoryState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(NationalHistoryStore::default())),
            point_lookup_gate: Arc::new(Semaphore::new(1)),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NationalHistoryObservation {
    pub generation: u64,
    pub object_key: String,
    pub observation_time_unix_ms: i64,
    pub content_sha256: String,
    pub compressed_bytes: usize,
    pub overview_chunk_count: usize,
    pub overview_gpu_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NationalHistorySnapshot {
    pub generation: u64,
    pub history_limit: usize,
    pub retained: Vec<NationalHistoryObservation>,
    pub staged: Option<NationalHistoryObservation>,
    pub mutation_reversible: bool,
    pub pending_backfill_count: usize,
    pub retained_backend_bytes: usize,
    pub staged_backend_bytes: usize,
    pub detailed_cache_bytes: usize,
    pub reversible_commit_bytes: usize,
    pub total_backend_bytes: usize,
    pub backend_target_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NationalHistoryPrepareReport {
    pub kind: NationalHistoryMutationKind,
    pub observation: NationalHistoryObservation,
    pub reused: bool,
    pub discovery_ms: f64,
    pub download_ms: f64,
    pub decode_and_level_ms: f64,
    pub acquisition_network_requests: u64,
    pub acquisition_response_bytes: u64,
    pub history: NationalHistorySnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NationalHistoryCommitReport {
    pub history: NationalHistorySnapshot,
    pub evicted: Option<NationalHistoryObservation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NationalHistoryPresentationReport {
    pub observation: NationalHistoryObservation,
    pub presentation_factor: u16,
    pub chunk_count: usize,
    pub transfer_bytes: usize,
    pub projected_gpu_bytes: usize,
    pub decode_and_level_ms: f64,
    pub history: NationalHistorySnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NationalHistoryPointLookup {
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
pub async fn prepare_national_history_current(
    broker: tauri::State<'_, TransferBroker>,
    state: tauri::State<'_, NationalHistoryState>,
    session: u64,
    generation: u64,
) -> Result<NationalHistoryPrepareReport, TransferError> {
    let token = broker.live_generation_token(session, generation)?;
    let client = MrmsClient::new().map_err(mrms_error)?;
    let discovery_started = Instant::now();
    let retained_limit = lock_store(&state)?.retained_limit;
    let mut objects = client
        .discover_latest_up_to(Utc::now(), retained_limit)
        .await
        .map_err(mrms_error)?;
    token.ensure_current().map_err(stale_error)?;
    let discovery_ms = elapsed_ms(discovery_started);
    let current = objects.pop().ok_or_else(|| {
        TransferError::new("national_inventory_empty", "no current MRMS observation")
    })?;
    let backfill_candidates = objects.into_iter().rev().collect::<VecDeque<_>>();
    let (frame, download_ms, decode_and_level_ms) =
        acquire_overview(&client, current, generation, &token, true).await?;
    {
        let mut store = lock_store(&state)?;
        store.reset(generation, backfill_candidates);
        add_acquisition_activity(&mut store, &client, 1);
        store.stage(NationalHistoryMutationKind::Current, frame.clone())?;
    }
    prepare_report(
        &state,
        NationalHistoryMutationKind::Current,
        frame,
        discovery_ms,
        download_ms,
        decode_and_level_ms,
        &client,
    )
}

#[tauri::command]
pub async fn prepare_national_history_predecessor(
    broker: tauri::State<'_, TransferBroker>,
    state: tauri::State<'_, NationalHistoryState>,
    session: u64,
    generation: u64,
) -> Result<Option<NationalHistoryPrepareReport>, TransferError> {
    let token = broker.live_generation_token(session, generation)?;
    let candidate = {
        let store = lock_store(&state)?;
        if let Some(frame) = store
            .retryable_staged_preparation(generation, NationalHistoryMutationKind::Predecessor)?
        {
            let matches_pending_candidate = store
                .backfill_candidates
                .front()
                .is_some_and(|candidate| candidate.key == frame.evidence.object_key);
            if !matches_pending_candidate {
                return Err(TransferError::new(
                    "national_history_stage_stale",
                    "staged predecessor no longer matches the pending backfill candidate",
                ));
            }
            drop(store);
            return retry_prepare_report(&state, NationalHistoryMutationKind::Predecessor, frame)
                .map(Some);
        }
        let oldest = store.retained.front().ok_or_else(|| {
            TransferError::new(
                "national_history_empty",
                "current National observation must commit before backfill",
            )
        })?;
        let candidate = match store.backfill_candidates.front() {
            Some(candidate) => candidate.clone(),
            None => return Ok(None),
        };
        if candidate.observation_time_unix_ms >= oldest.evidence.observation_time_unix_ms {
            return Err(TransferError::new(
                "national_history_not_older",
                "backfill candidate is not strictly older than retained history",
            ));
        }
        candidate
    };
    let client = MrmsClient::new().map_err(mrms_error)?;
    let (frame, download_ms, decode_and_level_ms) =
        acquire_overview(&client, candidate, generation, &token, false).await?;
    {
        let mut store = lock_store(&state)?;
        store.ensure_generation(generation)?;
        add_acquisition_activity(&mut store, &client, 1);
        store.stage(NationalHistoryMutationKind::Predecessor, frame.clone())?;
    }
    prepare_report(
        &state,
        NationalHistoryMutationKind::Predecessor,
        frame,
        0.0,
        download_ms,
        decode_and_level_ms,
        &client,
    )
    .map(Some)
}

#[tauri::command]
pub async fn prepare_national_history_newer(
    broker: tauri::State<'_, TransferBroker>,
    state: tauri::State<'_, NationalHistoryState>,
    session: u64,
    generation: u64,
) -> Result<NationalHistoryPrepareReport, TransferError> {
    let token = broker.live_generation_token(session, generation)?;
    let newest_time = {
        let store = lock_store(&state)?;
        if let Some(frame) =
            store.retryable_staged_preparation(generation, NationalHistoryMutationKind::Newer)?
        {
            drop(store);
            return retry_prepare_report(&state, NationalHistoryMutationKind::Newer, frame);
        }
        store
            .retained
            .back()
            .map(|frame| frame.evidence.observation_time_unix_ms)
            .ok_or_else(|| {
                TransferError::new(
                    "national_history_empty",
                    "current National observation must commit before polling",
                )
            })?
    };
    let client = MrmsClient::new().map_err(mrms_error)?;
    let discovery_started = Instant::now();
    let candidate = client
        .discover_newest(Utc::now(), Some(newest_time))
        .await
        .map_err(mrms_error)?;
    token.ensure_current().map_err(stale_error)?;
    let discovery_ms = elapsed_ms(discovery_started);
    let (frame, download_ms, decode_and_level_ms) =
        acquire_overview(&client, candidate, generation, &token, false).await?;
    {
        let mut store = lock_store(&state)?;
        store.ensure_generation(generation)?;
        add_acquisition_activity(&mut store, &client, 1);
        store.stage(NationalHistoryMutationKind::Newer, frame.clone())?;
    }
    prepare_report(
        &state,
        NationalHistoryMutationKind::Newer,
        frame,
        discovery_ms,
        download_ms,
        decode_and_level_ms,
        &client,
    )
}

#[tauri::command]
pub fn commit_national_history_frame(
    broker: tauri::State<'_, TransferBroker>,
    state: tauri::State<'_, NationalHistoryState>,
    session: u64,
    generation: u64,
    observation_time_unix_ms: i64,
    content_sha256: String,
) -> Result<NationalHistoryCommitReport, TransferError> {
    broker
        .live_generation_token(session, generation)?
        .ensure_current()
        .map_err(stale_error)?;
    let mut store = lock_store(&state)?;
    let evicted = store.commit_staged(generation, observation_time_unix_ms, &content_sha256)?;
    Ok(NationalHistoryCommitReport {
        history: store.snapshot(),
        evicted,
    })
}

#[tauri::command]
pub fn rollback_national_history_frame(
    state: tauri::State<'_, NationalHistoryState>,
    generation: u64,
    observation_time_unix_ms: i64,
    content_sha256: String,
) -> Result<NationalHistorySnapshot, TransferError> {
    let mut store = lock_store(&state)?;
    store.rollback_mutation(generation, observation_time_unix_ms, &content_sha256)?;
    Ok(store.snapshot())
}

#[tauri::command]
pub fn finalize_national_history_frame(
    state: tauri::State<'_, NationalHistoryState>,
    generation: u64,
    observation_time_unix_ms: i64,
    content_sha256: String,
) -> Result<NationalHistorySnapshot, TransferError> {
    let mut store = lock_store(&state)?;
    store.finalize_commit(generation, observation_time_unix_ms, &content_sha256)?;
    Ok(store.snapshot())
}

#[tauri::command]
pub async fn prepare_national_history_presentation(
    broker: tauri::State<'_, TransferBroker>,
    state: tauri::State<'_, NationalHistoryState>,
    session: u64,
    generation: u64,
    observation_time_unix_ms: i64,
    content_sha256: String,
    presentation_factor: u16,
) -> Result<NationalHistoryPresentationReport, TransferError> {
    if presentation_factor != 1 && presentation_factor != 2 {
        return Err(TransferError::new(
            "national_presentation_level_invalid",
            "fine presentation factor must be 1 or 2",
        ));
    }
    let token = broker.live_generation_token(session, generation)?;
    let started = Instant::now();
    let (retained, cached_detail) = {
        let store = lock_store(&state)?;
        let retained = store.find(generation, observation_time_unix_ms, &content_sha256, true)?;
        let cached = store.matching_detail(
            generation,
            observation_time_unix_ms,
            &content_sha256,
            presentation_factor,
        );
        (retained, cached)
    };
    if let Some(packed) = cached_detail {
        token.ensure_current().map_err(stale_error)?;
        let projected_gpu_bytes = packed
            .summary
            .chunks
            .iter()
            .map(|chunk| usize::from(chunk.halo_width) * usize::from(chunk.halo_height) * 2)
            .sum();
        let history = lock_store(&state)?.snapshot();
        return Ok(NationalHistoryPresentationReport {
            observation: retained.identity(),
            presentation_factor,
            chunk_count: packed.chunks.len(),
            transfer_bytes: packed.transfer_bytes(),
            projected_gpu_bytes,
            decode_and_level_ms: elapsed_ms(started),
            history,
        });
    }
    let download = retained.download.clone();
    let exact_pyramid = retained
        .exact_pyramid
        .lock()
        .map_err(|_| {
            TransferError::new(
                "national_history_poisoned",
                "exact grid cache is unavailable",
            )
        })?
        .clone();
    let packed = tauri::async_runtime::spawn_blocking(move || {
        let pyramid = match exact_pyramid {
            Some(pyramid) => pyramid,
            None => {
                let decoded = decode_mrms_gzip(&download.compressed_bytes, download.object.clone())
                    .map_err(mrms_error)?;
                Arc::new(
                    MrmsNumericPyramid::from_decoded(decoded, OVERVIEW_FACTOR).map_err(
                        |error| {
                            TransferError::new(
                                "national_level_generation_failed",
                                error.to_string(),
                            )
                        },
                    )?,
                )
            }
        };
        PackedGridFrame::encode(generation, &pyramid, presentation_factor)
            .map_err(|error| TransferError::new("national_packed_grid_failed", error.to_string()))
    })
    .await
    .map_err(|error| TransferError::new("national_backend_task_failed", error.to_string()))??;
    token.ensure_current().map_err(stale_error)?;
    let packed = Arc::new(packed);
    let observation = retained.identity();
    let projected_gpu_bytes = packed
        .summary
        .chunks
        .iter()
        .map(|chunk| usize::from(chunk.halo_width) * usize::from(chunk.halo_height) * 2)
        .sum();
    {
        let mut store = lock_store(&state)?;
        store.find(generation, observation_time_unix_ms, &content_sha256, true)?;
        store.activity.decoder_runs = store.activity.decoder_runs.saturating_add(1);
        store.detail = Some(DetailedPresentation {
            generation,
            observation_time_unix_ms,
            content_sha256,
            frame: packed.clone(),
        });
        if let Ok(mut exact) = retained.exact_pyramid.lock() {
            *exact = None;
        }
        let total_bytes = store.total_bytes();
        if total_bytes > HISTORY_BACKEND_TARGET_BYTES {
            let retained_bytes = store.retained_bytes();
            let staged_bytes = store.staged_bytes();
            let detail_bytes = store.detail_bytes();
            let reversible_bytes = store.reversible_commit_bytes();
            store.detail = None;
            return Err(TransferError::new(
                "national_history_backend_budget",
                format!(
                    "fine presentation requires {total_bytes} backend bytes; target is {HISTORY_BACKEND_TARGET_BYTES} (retained {retained_bytes}, staged {staged_bytes}, detail {detail_bytes}, reversible {reversible_bytes})"
                ),
            ));
        }
    }
    let history = lock_store(&state)?.snapshot();
    Ok(NationalHistoryPresentationReport {
        observation,
        presentation_factor,
        chunk_count: packed.chunks.len(),
        transfer_bytes: packed.transfer_bytes(),
        projected_gpu_bytes,
        decode_and_level_ms: elapsed_ms(started),
        history,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn request_national_history_manifest(
    broker: tauri::State<'_, TransferBroker>,
    state: tauri::State<'_, NationalHistoryState>,
    session: u64,
    generation: u64,
    observation_time_unix_ms: i64,
    content_sha256: String,
    presentation_factor: u16,
) -> Result<Response, TransferError> {
    broker.acquire(session, generation)?;
    let result = history_frame_bytes(
        &state,
        generation,
        observation_time_unix_ms,
        &content_sha256,
        presentation_factor,
        |frame| frame.manifest.clone(),
    );
    publish_history_bytes(&broker, &state, session, generation, result)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn request_national_history_chunk(
    broker: tauri::State<'_, TransferBroker>,
    state: tauri::State<'_, NationalHistoryState>,
    session: u64,
    generation: u64,
    observation_time_unix_ms: i64,
    content_sha256: String,
    presentation_factor: u16,
    chunk_index: u32,
) -> Result<Response, TransferError> {
    broker.acquire(session, generation)?;
    let result = history_frame_bytes(
        &state,
        generation,
        observation_time_unix_ms,
        &content_sha256,
        presentation_factor,
        |frame| {
            frame
                .chunks
                .get(chunk_index as usize)
                .cloned()
                .ok_or_else(|| {
                    TransferError::new(
                        "national_chunk_not_found",
                        format!("chunk {chunk_index} is outside the prepared presentation"),
                    )
                })
        },
    )
    .and_then(|bytes| bytes);
    publish_history_bytes(&broker, &state, session, generation, result)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lookup_national_history_point(
    state: tauri::State<'_, NationalHistoryState>,
    generation: u64,
    observation_time_unix_ms: i64,
    content_sha256: String,
    inspection_id: String,
    longitude: f64,
    latitude: f64,
) -> Result<NationalHistoryPointLookup, TransferError> {
    validate_point_request(&inspection_id, longitude, latitude)?;
    let retained = {
        let store = lock_store(&state)?;
        store.find(generation, observation_time_unix_ms, &content_sha256, false)?
    };
    let _permit = state
        .point_lookup_gate
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| {
            TransferError::new("national_point_unavailable", "point lookup gate closed")
        })?;
    let download = retained.download.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let decoded = decode_mrms_gzip(&download.compressed_bytes, download.object.clone())
            .map_err(mrms_error)?;
        lookup_decoded_point(
            decoded,
            generation,
            observation_time_unix_ms,
            content_sha256,
            inspection_id,
            longitude,
            latitude,
        )
    })
    .await
    .map_err(|error| TransferError::new("national_backend_task_failed", error.to_string()))??;
    let mut store = lock_store(&state)?;
    store.find(
        generation,
        observation_time_unix_ms,
        &result.content_sha256,
        false,
    )?;
    store.activity.point_lookup_decodes = store.activity.point_lookup_decodes.saturating_add(1);
    Ok(result)
}

#[tauri::command]
pub async fn find_national_history_peak_point(
    state: tauri::State<'_, NationalHistoryState>,
    generation: u64,
    observation_time_unix_ms: i64,
    content_sha256: String,
    inspection_id: String,
) -> Result<NationalHistoryPointLookup, TransferError> {
    if inspection_id.is_empty() || inspection_id.len() > 128 {
        return Err(TransferError::new(
            "national_point_invalid",
            "inspection identity must be bounded",
        ));
    }
    let retained = {
        let store = lock_store(&state)?;
        store.find(generation, observation_time_unix_ms, &content_sha256, false)?
    };
    let _permit = state
        .point_lookup_gate
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| {
            TransferError::new("national_point_unavailable", "point lookup gate closed")
        })?;
    let download = retained.download.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let decoded = decode_mrms_gzip(&download.compressed_bytes, download.object.clone())
            .map_err(mrms_error)?;
        let (index, _) = decoded
            .raw_codes
            .iter()
            .enumerate()
            .filter(|(_, raw)| {
                matches!(decoded.encoding.decode_raw(**raw), MrmsCellValue::Valid(_))
            })
            .max_by_key(|(_, raw)| **raw)
            .ok_or_else(|| {
                TransferError::new(
                    "national_valid_point_missing",
                    "retained National observation contains no valid cells",
                )
            })?;
        let row = index / decoded.grid.width as usize;
        let column = index % decoded.grid.width as usize;
        let longitude = decoded.grid.first_longitude_degrees
            + column as f64 * decoded.grid.longitude_step_degrees;
        let latitude =
            decoded.grid.first_latitude_degrees - row as f64 * decoded.grid.latitude_step_degrees;
        lookup_decoded_point(
            decoded,
            generation,
            observation_time_unix_ms,
            content_sha256,
            inspection_id,
            longitude,
            latitude,
        )
    })
    .await
    .map_err(|error| TransferError::new("national_backend_task_failed", error.to_string()))??;
    let mut store = lock_store(&state)?;
    store.find(
        generation,
        observation_time_unix_ms,
        &result.content_sha256,
        false,
    )?;
    store.activity.point_lookup_decodes = store.activity.point_lookup_decodes.saturating_add(1);
    Ok(result)
}

#[tauri::command]
pub fn national_history_snapshot(
    state: tauri::State<'_, NationalHistoryState>,
) -> Result<NationalHistorySnapshot, TransferError> {
    Ok(lock_store(&state)?.snapshot())
}

#[tauri::command]
pub fn national_history_activity_snapshot(
    state: tauri::State<'_, NationalHistoryState>,
) -> Result<NationalHistoryActivitySnapshot, TransferError> {
    Ok(lock_store(&state)?.activity)
}

#[tauri::command]
pub fn national_history_poll_delay(attempt: u32, jitter_seed: u64) -> crate::mrms::MrmsPollDelay {
    bounded_poll_delay(attempt, jitter_seed)
}

async fn acquire_overview(
    client: &MrmsClient,
    object: MrmsObject,
    generation: u64,
    token: &crate::live_pipeline::GenerationToken,
    retain_exact_pyramid: bool,
) -> Result<(Arc<RetainedNationalFrame>, f64, f64), TransferError> {
    let download_started = Instant::now();
    let download = Arc::new(client.download(&object).await.map_err(mrms_error)?);
    token.ensure_current().map_err(stale_error)?;
    let download_ms = elapsed_ms(download_started);
    let decode_started = Instant::now();
    let build_download = download.clone();
    let (evidence, overview, exact_pyramid) = tauri::async_runtime::spawn_blocking(move || {
        let decoded = decode_mrms_gzip(
            &build_download.compressed_bytes,
            build_download.object.clone(),
        )
        .map_err(mrms_error)?;
        let evidence = decoded.evidence.clone();
        let pyramid = Arc::new(
            MrmsNumericPyramid::from_decoded(decoded, OVERVIEW_FACTOR).map_err(|error| {
                TransferError::new("national_level_generation_failed", error.to_string())
            })?,
        );
        let overview =
            PackedGridFrame::encode(generation, &pyramid, OVERVIEW_FACTOR).map_err(|error| {
                TransferError::new("national_packed_grid_failed", error.to_string())
            })?;
        Ok::<_, TransferError>((evidence, overview, retain_exact_pyramid.then_some(pyramid)))
    })
    .await
    .map_err(|error| TransferError::new("national_backend_task_failed", error.to_string()))??;
    token.ensure_current().map_err(stale_error)?;
    Ok((
        Arc::new(RetainedNationalFrame {
            generation,
            download,
            evidence,
            overview: Arc::new(overview),
            exact_pyramid: Arc::new(Mutex::new(exact_pyramid)),
        }),
        download_ms,
        elapsed_ms(decode_started),
    ))
}

fn prepare_report(
    state: &NationalHistoryState,
    kind: NationalHistoryMutationKind,
    frame: Arc<RetainedNationalFrame>,
    discovery_ms: f64,
    download_ms: f64,
    decode_and_level_ms: f64,
    client: &MrmsClient,
) -> Result<NationalHistoryPrepareReport, TransferError> {
    let history = lock_store(state)?.snapshot();
    let counters = client.counters();
    Ok(NationalHistoryPrepareReport {
        kind,
        observation: frame.identity(),
        reused: false,
        discovery_ms,
        download_ms,
        decode_and_level_ms,
        acquisition_network_requests: counters.network_requests,
        acquisition_response_bytes: counters.response_bytes,
        history,
    })
}

fn retry_prepare_report(
    state: &NationalHistoryState,
    kind: NationalHistoryMutationKind,
    frame: Arc<RetainedNationalFrame>,
) -> Result<NationalHistoryPrepareReport, TransferError> {
    Ok(NationalHistoryPrepareReport {
        kind,
        observation: frame.identity(),
        reused: true,
        discovery_ms: 0.0,
        download_ms: 0.0,
        decode_and_level_ms: 0.0,
        acquisition_network_requests: 0,
        acquisition_response_bytes: 0,
        history: lock_store(state)?.snapshot(),
    })
}

fn history_frame_bytes<T>(
    state: &NationalHistoryState,
    generation: u64,
    observation_time_unix_ms: i64,
    content_sha256: &str,
    presentation_factor: u16,
    read: impl FnOnce(&PackedGridFrame) -> T,
) -> Result<T, TransferError> {
    let store = lock_store(state)?;
    let retained = store.find(generation, observation_time_unix_ms, content_sha256, true)?;
    if presentation_factor == OVERVIEW_FACTOR {
        return Ok(read(&retained.overview));
    }
    let detail = store.detail.as_ref().ok_or_else(|| {
        TransferError::new(
            "national_presentation_level_unavailable",
            "fine National presentation has not been prepared",
        )
    })?;
    if !detail.matches(generation, observation_time_unix_ms, content_sha256)
        || detail.frame.summary.presentation_factor != presentation_factor
    {
        return Err(TransferError::new(
            "national_presentation_level_unavailable",
            "fine National presentation identity is no longer prepared",
        ));
    }
    Ok(read(&detail.frame))
}

fn publish_history_bytes(
    broker: &TransferBroker,
    state: &NationalHistoryState,
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
    if let Ok(mut store) = state.inner.lock() {
        store.activity.bulk_ipc_transfers = store.activity.bulk_ipc_transfers.saturating_add(1);
        store.activity.bulk_ipc_bytes = store
            .activity
            .bulk_ipc_bytes
            .saturating_add(bytes.len() as u64);
    }
    Ok(Response::new(bytes))
}

fn lookup_decoded_point(
    decoded: crate::mrms::DecodedMrmsGrid,
    generation: u64,
    observation_time_unix_ms: i64,
    content_sha256: String,
    inspection_id: String,
    longitude: f64,
    latitude: f64,
) -> Result<NationalHistoryPointLookup, TransferError> {
    let grid = decoded.grid;
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
    let index = usize::try_from(row)
        .ok()
        .and_then(|row| row.checked_mul(grid.width as usize))
        .and_then(|offset| {
            usize::try_from(column)
                .ok()
                .and_then(|column| offset.checked_add(column))
        })
        .ok_or_else(|| TransferError::new("national_point_invalid", "grid index overflowed"))?;
    let raw_code = *decoded.raw_codes.get(index).ok_or_else(|| {
        TransferError::new(
            "national_point_invalid",
            "grid index is outside retained data",
        )
    })?;
    let (status, value_dbz) = match decoded.encoding.decode_raw(raw_code) {
        MrmsCellValue::Valid(value) => ("valid", Some(value)),
        MrmsCellValue::Missing => ("missing", None),
        MrmsCellValue::NoCoverage => ("no_coverage", None),
    };
    Ok(NationalHistoryPointLookup {
        inspection_id,
        generation,
        observation_time_unix_ms,
        content_sha256,
        object_key: decoded.object.key,
        longitude,
        latitude,
        row,
        column,
        raw_code,
        status,
        value_dbz,
    })
}

fn validate_point_request(
    inspection_id: &str,
    longitude: f64,
    latitude: f64,
) -> Result<(), TransferError> {
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
    Ok(())
}

fn add_acquisition_activity(
    store: &mut NationalHistoryStore,
    client: &MrmsClient,
    decoder_runs: u64,
) {
    let counters = client.counters();
    store.activity.network_requests = store
        .activity
        .network_requests
        .saturating_add(counters.network_requests);
    store.activity.response_bytes = store
        .activity
        .response_bytes
        .saturating_add(counters.response_bytes);
    store.activity.decoder_runs = store.activity.decoder_runs.saturating_add(decoder_runs);
}

fn lock_store(
    state: &NationalHistoryState,
) -> Result<std::sync::MutexGuard<'_, NationalHistoryStore>, TransferError> {
    state.inner.lock().map_err(|_| {
        TransferError::new(
            "national_history_poisoned",
            "National history is unavailable after an internal panic",
        )
    })
}

fn mrms_error(error: crate::mrms::MrmsError) -> TransferError {
    TransferError::new(error.code(), error.to_string())
}

fn stale_error(error: crate::live_pipeline::LivePipelineError) -> TransferError {
    TransferError::new("national_generation_stale", error.to_string())
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mrms::{MRMS_HOST, MrmsGridDefinition, MrmsRowOrientation, MrmsValueEncoding};
    use crate::packed_grid::{NumericGridLevel, PackedGridManifestSummary};
    use std::collections::BTreeMap;

    #[test]
    fn commits_current_and_strictly_older_predecessors_chronologically() {
        let mut store = test_store(20);
        store.reset(7, VecDeque::new());
        commit(&mut store, NationalHistoryMutationKind::Current, 2_000).unwrap();
        commit(&mut store, NationalHistoryMutationKind::Predecessor, 1_000).unwrap();

        assert_eq!(retained_times(&store), vec![1_000, 2_000]);
        assert!(store.staged.is_none());
    }

    #[test]
    fn rejected_commit_preserves_the_staged_transaction_for_explicit_rollback() {
        let mut store = test_store(20);
        store.reset(7, VecDeque::new());
        commit(&mut store, NationalHistoryMutationKind::Current, 2_000).unwrap();
        store
            .stage(
                NationalHistoryMutationKind::Predecessor,
                retained_frame(7, 3_000),
            )
            .unwrap();

        let staged = store.staged.as_ref().unwrap().frame.identity();
        let error = store
            .commit_staged(
                staged.generation,
                staged.observation_time_unix_ms,
                &staged.content_sha256,
            )
            .unwrap_err();
        assert_eq!(error.code, "national_history_not_older");
        assert_eq!(retained_times(&store), vec![2_000]);
        assert!(store.staged.is_some());

        store
            .rollback_mutation(
                staged.generation,
                staged.observation_time_unix_ms,
                &staged.content_sha256,
            )
            .unwrap();
        assert!(store.staged.is_none());
    }

    #[test]
    fn predecessor_and_newer_preparation_retries_reuse_the_exact_staged_frame() {
        for kind in [
            NationalHistoryMutationKind::Predecessor,
            NationalHistoryMutationKind::Newer,
        ] {
            let mut store = test_store(20);
            store.reset(7, VecDeque::new());
            commit(&mut store, NationalHistoryMutationKind::Current, 2_000).unwrap();
            let frame = retained_frame(
                7,
                if kind == NationalHistoryMutationKind::Predecessor {
                    1_000
                } else {
                    3_000
                },
            );
            store.stage(kind, frame.clone()).unwrap();

            let retried = store
                .retryable_staged_preparation(7, kind)
                .unwrap()
                .unwrap();

            assert!(Arc::ptr_eq(&retried, &frame));
            assert_eq!(store.activity.network_requests, 0);
            assert_eq!(store.activity.decoder_runs, 0);
            let state = NationalHistoryState {
                inner: Arc::new(Mutex::new(store)),
                point_lookup_gate: Arc::new(Semaphore::new(1)),
            };
            let report = retry_prepare_report(&state, kind, retried).unwrap();
            assert_eq!(report.kind, kind);
            assert_eq!(report.observation.object_key, frame.evidence.object_key);
            assert!(report.reused);
            assert_eq!(report.discovery_ms, 0.0);
            assert_eq!(report.download_ms, 0.0);
            assert_eq!(report.decode_and_level_ms, 0.0);
            assert_eq!(report.acquisition_network_requests, 0);
            assert_eq!(report.acquisition_response_bytes, 0);
        }
    }

    #[test]
    fn preparation_retry_rejects_a_different_staged_mutation_kind() {
        let mut store = test_store(20);
        store.reset(7, VecDeque::new());
        commit(&mut store, NationalHistoryMutationKind::Current, 2_000).unwrap();
        store
            .stage(
                NationalHistoryMutationKind::Predecessor,
                retained_frame(7, 1_000),
            )
            .unwrap();

        let error = store
            .retryable_staged_preparation(7, NationalHistoryMutationKind::Newer)
            .unwrap_err();

        assert_eq!(error.code, "national_history_stage_busy");
    }

    #[test]
    fn reversible_commit_restores_the_evicted_frame_until_renderer_finalization() {
        let mut store = test_store(20);
        store.reset(7, VecDeque::new());
        commit(&mut store, NationalHistoryMutationKind::Current, 1_000).unwrap();
        for time in (2..=20).map(|value| value * 1_000) {
            commit(&mut store, NationalHistoryMutationKind::Newer, time).unwrap();
        }

        let frame = retained_frame(7, 21_000);
        let identity = frame.identity();
        store
            .stage(NationalHistoryMutationKind::Newer, frame)
            .unwrap();
        let evicted = store
            .commit_staged(
                identity.generation,
                identity.observation_time_unix_ms,
                &identity.content_sha256,
            )
            .unwrap();
        assert_eq!(evicted.unwrap().observation_time_unix_ms, 1_000);
        assert!(store.snapshot().reversible_commit_bytes > 0);

        store
            .rollback_mutation(
                identity.generation,
                identity.observation_time_unix_ms,
                &identity.content_sha256,
            )
            .unwrap();
        assert_eq!(
            retained_times(&store),
            (1..=20).map(|value| value * 1_000).collect::<Vec<_>>()
        );
        assert_eq!(store.snapshot().reversible_commit_bytes, 0);
    }

    #[test]
    fn reversible_commit_accounts_for_replaced_detail_until_finalization() {
        let mut store = test_store(20);
        store.reset(7, VecDeque::new());
        commit(&mut store, NationalHistoryMutationKind::Current, 1_000).unwrap();

        let current = store.retained.back().unwrap().clone();
        let current_identity = current.identity();
        let mut prior_detail_frame = (*current.overview).clone();
        prior_detail_frame.summary.presentation_factor = 1;
        prior_detail_frame.manifest = vec![1; 7];
        let prior_detail_frame = Arc::new(prior_detail_frame);
        store.detail = Some(DetailedPresentation {
            generation: current_identity.generation,
            observation_time_unix_ms: current_identity.observation_time_unix_ms,
            content_sha256: current_identity.content_sha256,
            frame: prior_detail_frame.clone(),
        });

        let newer = retained_frame(7, 2_000);
        let newer_identity = newer.identity();
        store
            .stage(NationalHistoryMutationKind::Newer, newer.clone())
            .unwrap();
        store
            .commit_staged(
                newer_identity.generation,
                newer_identity.observation_time_unix_ms,
                &newer_identity.content_sha256,
            )
            .unwrap();
        assert_eq!(store.snapshot().reversible_commit_bytes, 0);

        let mut replacement_detail_frame = (*newer.overview).clone();
        replacement_detail_frame.summary.presentation_factor = 1;
        replacement_detail_frame.manifest = vec![2; 11];
        let replacement_detail_frame = Arc::new(replacement_detail_frame);
        store.detail = Some(DetailedPresentation {
            generation: newer_identity.generation,
            observation_time_unix_ms: newer_identity.observation_time_unix_ms,
            content_sha256: newer_identity.content_sha256.clone(),
            frame: replacement_detail_frame.clone(),
        });

        let snapshot = store.snapshot();
        assert_eq!(
            snapshot.detailed_cache_bytes,
            replacement_detail_frame.transfer_bytes()
        );
        assert_eq!(
            snapshot.reversible_commit_bytes,
            prior_detail_frame.transfer_bytes()
        );
        assert_eq!(
            snapshot.total_backend_bytes,
            snapshot.retained_backend_bytes
                + snapshot.staged_backend_bytes
                + replacement_detail_frame.transfer_bytes()
                + prior_detail_frame.transfer_bytes()
        );

        store
            .finalize_commit(
                newer_identity.generation,
                newer_identity.observation_time_unix_ms,
                &newer_identity.content_sha256,
            )
            .unwrap();
        let finalized = store.snapshot();
        assert_eq!(finalized.reversible_commit_bytes, 0);
        assert_eq!(
            finalized.total_backend_bytes,
            finalized.retained_backend_bytes + replacement_detail_frame.transfer_bytes()
        );
    }

    #[test]
    fn newer_append_evicts_exactly_one_oldest_frame_at_the_shipping_limit() {
        let mut store = test_store(20);
        store.reset(7, VecDeque::new());
        commit(&mut store, NationalHistoryMutationKind::Current, 1_000).unwrap();
        let mut evicted = None;
        for time in (2..=21).map(|value| value * 1_000) {
            evicted = commit(&mut store, NationalHistoryMutationKind::Newer, time).unwrap();
        }

        assert_eq!(store.retained.len(), 20);
        assert_eq!(
            retained_times(&store),
            (2..=21).map(|value| value * 1_000).collect::<Vec<_>>()
        );
        assert_eq!(evicted.unwrap().observation_time_unix_ms, 1_000);
    }

    #[test]
    fn duplicate_finalization_is_idempotent_for_the_last_committed_identity() {
        let mut store = test_store(20);
        store.reset(7, VecDeque::new());
        let frame = retained_frame(7, 1_000);
        let identity = frame.identity();
        store
            .stage(NationalHistoryMutationKind::Current, frame)
            .unwrap();
        store
            .commit_staged(
                identity.generation,
                identity.observation_time_unix_ms,
                &identity.content_sha256,
            )
            .unwrap();
        store
            .finalize_commit(
                identity.generation,
                identity.observation_time_unix_ms,
                &identity.content_sha256,
            )
            .unwrap();
        let finalized_times = retained_times(&store);

        store
            .finalize_commit(
                identity.generation,
                identity.observation_time_unix_ms,
                &identity.content_sha256,
            )
            .unwrap();

        assert_eq!(retained_times(&store), finalized_times);
        assert!(!store.snapshot().mutation_reversible);
    }

    #[test]
    fn the_same_store_and_wire_model_support_a_non_shipping_thirty_frame_limit() {
        let mut store = test_store(30);
        store.reset(11, VecDeque::new());
        commit(&mut store, NationalHistoryMutationKind::Current, 1_000).unwrap();
        for time in (2..=30).map(|value| value * 1_000) {
            assert!(
                commit(&mut store, NationalHistoryMutationKind::Newer, time)
                    .unwrap()
                    .is_none()
            );
        }

        let snapshot = store.snapshot();
        assert_eq!(snapshot.history_limit, 30);
        assert_eq!(snapshot.retained.len(), 30);
        assert_eq!(snapshot.retained[0].generation, 11);
        assert_eq!(snapshot.retained[29].observation_time_unix_ms, 30_000);
    }

    #[test]
    fn matching_detail_reuses_the_prepared_frame_without_redecode() {
        let mut store = test_store(20);
        store.reset(7, VecDeque::new());
        commit(&mut store, NationalHistoryMutationKind::Current, 1_000).unwrap();
        let retained = store.retained.front().unwrap();
        let identity = retained.identity();
        let mut detail_frame = (*retained.overview).clone();
        detail_frame.summary.presentation_factor = 1;
        let detail_frame = Arc::new(detail_frame);
        store.detail = Some(DetailedPresentation {
            generation: identity.generation,
            observation_time_unix_ms: identity.observation_time_unix_ms,
            content_sha256: identity.content_sha256.clone(),
            frame: detail_frame.clone(),
        });

        let cached = store
            .matching_detail(
                identity.generation,
                identity.observation_time_unix_ms,
                &identity.content_sha256,
                1,
            )
            .unwrap();

        assert!(Arc::ptr_eq(&cached, &detail_frame));
        assert!(
            store
                .matching_detail(
                    identity.generation,
                    identity.observation_time_unix_ms,
                    &identity.content_sha256,
                    2,
                )
                .is_none()
        );
        assert_eq!(store.activity.decoder_runs, 0);
    }

    #[test]
    fn finalizing_a_newer_observation_drops_the_superseded_exact_pyramid_cache() {
        let mut store = test_store(20);
        store.reset(7, VecDeque::new());
        commit(&mut store, NationalHistoryMutationKind::Current, 1_000).unwrap();
        let prior_current = store.retained.back().unwrap().clone();
        *prior_current.exact_pyramid.lock().unwrap() = Some(test_exact_pyramid(1_000));
        assert!(prior_current.exact_pyramid.lock().unwrap().is_some());

        commit(&mut store, NationalHistoryMutationKind::Newer, 2_000).unwrap();

        assert!(prior_current.exact_pyramid.lock().unwrap().is_none());
    }

    fn test_store(retained_limit: usize) -> NationalHistoryStore {
        NationalHistoryStore {
            retained_limit,
            ..NationalHistoryStore::default()
        }
    }

    fn retained_times(store: &NationalHistoryStore) -> Vec<i64> {
        store
            .retained
            .iter()
            .map(|frame| frame.evidence.observation_time_unix_ms)
            .collect()
    }

    fn commit(
        store: &mut NationalHistoryStore,
        kind: NationalHistoryMutationKind,
        observation_time_unix_ms: i64,
    ) -> Result<Option<NationalHistoryObservation>, TransferError> {
        let frame = retained_frame(store.generation.unwrap(), observation_time_unix_ms);
        let identity = frame.identity();
        store.stage(kind, frame)?;
        let evicted = store.commit_staged(
            identity.generation,
            identity.observation_time_unix_ms,
            &identity.content_sha256,
        )?;
        store.finalize_commit(
            identity.generation,
            identity.observation_time_unix_ms,
            &identity.content_sha256,
        )?;
        Ok(evicted)
    }

    fn retained_frame(
        generation: u64,
        observation_time_unix_ms: i64,
    ) -> Arc<RetainedNationalFrame> {
        let hash = format!("{observation_time_unix_ms:064x}");
        let object_key = format!("test/{observation_time_unix_ms}.grib2.gz");
        let object = MrmsObject {
            key: object_key.clone(),
            observation_time_unix_ms,
            last_modified_unix_ms: observation_time_unix_ms,
            size_bytes: 1,
            etag: None,
        };
        let summary = PackedGridManifestSummary {
            version: 1,
            generation,
            source_kind: "national_mrms".into(),
            domain: "conus".into(),
            product: "MergedBaseReflectivityQC_00.50".into(),
            provider: MRMS_HOST.into(),
            object_key: object_key.clone(),
            observation_time_unix_ms,
            content_sha256: hash.clone(),
            width: 1_750,
            height: 875,
            first_latitude_degrees: 54.98,
            first_longitude_degrees: -129.98,
            last_latitude_degrees: 20.02,
            last_longitude_degrees: -60.02,
            longitude_step_degrees: 0.04,
            latitude_step_degrees: 0.04,
            row_orientation: "north_to_south".into(),
            bit_depth: 16,
            reference_value: -9_990.0,
            binary_scale: 0,
            decimal_scale: 1,
            missing_raw: 9_000,
            no_coverage_raw: 0,
            presentation_factor: 4,
            chunk_interior_size: 256,
            chunks: Vec::new(),
        };
        Arc::new(RetainedNationalFrame {
            generation,
            download: Arc::new(DownloadedMrmsObject {
                object,
                compressed_bytes: vec![1],
            }),
            evidence: MrmsDecodeEvidence {
                provider: MRMS_HOST,
                object_key,
                observation_time_unix_ms,
                compressed_bytes: 1,
                grib_bytes: 1,
                png_bytes: 1,
                normalized_bytes: 2,
                compressed_sha256: hash,
                grib_sha256: "aa".repeat(32),
                normalized_sha256: "bb".repeat(32),
            },
            overview: Arc::new(PackedGridFrame {
                manifest: vec![1],
                chunks: Vec::new(),
                summary,
            }),
            exact_pyramid: Arc::new(Mutex::new(None)),
        })
    }

    fn test_exact_pyramid(observation_time_unix_ms: i64) -> Arc<MrmsNumericPyramid> {
        Arc::new(MrmsNumericPyramid {
            object_key: format!("test/{observation_time_unix_ms}.grib2.gz"),
            observation_time_unix_ms,
            content_sha256: [1; 32],
            grid: MrmsGridDefinition {
                width: 1,
                height: 1,
                first_latitude_degrees: 1.0,
                first_longitude_degrees: 1.0,
                last_latitude_degrees: 1.0,
                last_longitude_degrees: 1.0,
                longitude_step_degrees: 1.0,
                latitude_step_degrees: 1.0,
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
                    width: 1,
                    height: 1,
                    raw_codes: vec![10_000],
                },
            )]),
        })
    }
}
