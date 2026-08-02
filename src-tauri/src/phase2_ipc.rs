use crate::acquisition::PublicRadarClient;
use crate::live_pipeline::{GenerationClock, GenerationToken, LiveSweepSession, SafeSweepEvidence};
use crate::packed_sweep::{
    PackedSweepIdentity, PackedSweepSummary, encode_packed_sweep, phase2_benchmark_sweep,
    validate_packed_sweep,
};
use crate::radar::{MAX_LEVEL2_INPUT_BYTES, RadarProduct, decode_level2, decode_level3_n0s};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Response;

pub const TRANSFER_CREDIT_LIMIT: u8 = 2;
const MAX_BENCHMARK_ITERATIONS: u8 = 20;
const MAX_DIAGNOSTIC_HOLD_MS: u64 = 2_000;
const PHASE3_FIXTURE_NAME: &str = "KTLX20240520_230512_V06";
const PHASE3_FIXTURE_ID: &str = "ktlx-2024-05-20-230512-v06";
const PHASE4_FRAME_COUNT: usize = 20;
const PHASE4_FIXTURE_SET: &str = "phase4KtlxReflectivityLoop";
const PHASE6_N0S_FIXTURE_SET: &str = "phase6N0sCorpus";
const FIXTURE_MANIFEST_JSON: &str = include_str!("../../fixtures/manifest.json");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferError {
    pub code: &'static str,
    pub message: String,
}

impl TransferError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSnapshot {
    pub session: u64,
    pub generation: u64,
    pub active: bool,
    pub available_credits: u8,
    pub held_credits: u8,
    pub in_flight_credits: u8,
    pub credit_limit: u8,
}

#[derive(Debug, Default)]
struct TransferState {
    document_epoch: u64,
    session: u64,
    session_document_epoch: u64,
    generation: u64,
    active: bool,
    held_credits_by_owner: BTreeMap<(u64, u64), u8>,
    // Retain every acknowledgement for the lifetime of its frontend session.
    // A control response can be lost for arbitrarily long, so evicting an ID
    // would let its eventual retry release a newer credit from the same owner.
    acknowledged_release_ids: BTreeSet<String>,
    in_flight_credits_by_session: BTreeMap<u64, u8>,
    phase4_activity: Phase4ActivitySnapshot,
    live_generation_token: Option<GenerationToken>,
    phase5_evidence_by_observation: BTreeMap<String, Phase5LiveTransferEvidence>,
}

#[derive(Debug)]
struct InFlightCreditGuard {
    broker: TransferBroker,
    session: u64,
    armed: bool,
}

impl InFlightCreditGuard {
    fn new(broker: TransferBroker, session: u64) -> Self {
        Self {
            broker,
            session,
            armed: true,
        }
    }

    fn complete_phase5_for_publish(
        mut self,
        generation: u64,
        evidence: Phase5LiveTransferEvidence,
    ) -> Result<(), TransferError> {
        let broker = self.broker.clone();
        let mut state = broker.lock()?;
        let credits_before = in_flight_credit_count_for_session(&state, self.session);
        let completion = complete_for_publish_locked(&mut state, self.session, generation);
        let credits_after = in_flight_credit_count_for_session(&state, self.session);
        if credits_after < credits_before {
            self.armed = false;
        }
        completion?;
        state
            .phase5_evidence_by_observation
            .insert(evidence.observation_id.clone(), evidence);
        Ok(())
    }
}

impl Drop for InFlightCreditGuard {
    fn drop(&mut self) {
        if self.armed {
            self.broker.finish_without_publish(self.session);
        }
    }
}

#[derive(Debug)]
struct ChargedPhase5Work {
    bytes: Vec<u8>,
    evidence: Phase5LiveTransferEvidence,
    credit: InFlightCreditGuard,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Phase4ActivitySnapshot {
    pub network_requests: u64,
    pub disk_reads: u64,
    pub decoder_runs: u64,
    pub normalization_runs: u64,
    pub bulk_ipc_transfers: u64,
    pub bulk_ipc_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Phase5LiveTransferEvidence {
    pub observation_id: String,
    pub source_kind: &'static str,
    pub packed_bytes: usize,
    pub published_at_unix_ms: i64,
    pub safe: SafeSweepEvidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveHistoryCursorArgs {
    pub volume_index: u16,
    pub volume_started_at_unix_ms: i64,
    pub direction: LiveHistoryDirectionArgs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LiveHistoryDirectionArgs {
    After,
    Before,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ValidatedLiveHistoryRequest {
    After {
        volume_index: u16,
        volume_started_at_unix_ms: i64,
    },
    Before {
        volume_index: u16,
        volume_started_at_unix_ms: i64,
    },
}

#[derive(Debug, Clone)]
pub struct RuntimeResources {
    root: PathBuf,
}

impl RuntimeResources {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TransferBroker {
    inner: Arc<Mutex<TransferState>>,
}

impl TransferBroker {
    fn open_session(&self) -> Result<TransferSnapshot, TransferError> {
        let mut state = self.lock()?;
        if state.document_epoch == 0 {
            // Unit tests and non-WebView callers do not pass through Tauri's
            // page-load hook. The packaged app establishes this epoch first.
            state.document_epoch = 1;
        }
        if state.session_document_epoch == state.document_epoch
            && (held_credit_count_for_session(&state, state.session) > 0
                || in_flight_credit_count_for_session(&state, state.session) > 0)
        {
            return Err(TransferError::new(
                "session_still_owned",
                "the current document still owns transfer credits; only a native page-load epoch can reclaim them",
            ));
        }
        if let Some(token) = state.live_generation_token.take() {
            token.cancel();
        }
        state.phase5_evidence_by_observation.clear();
        state.session = state.session.checked_add(1).ok_or_else(|| {
            TransferError::new("session_exhausted", "frontend session counter exhausted")
        })?;
        state.session_document_epoch = state.document_epoch;
        state.generation = 0;
        state.active = false;
        state.acknowledged_release_ids.clear();
        Ok(snapshot(&state))
    }

    pub(crate) fn document_started(&self) -> Result<(), TransferError> {
        let mut state = self.lock()?;
        state.document_epoch = state.document_epoch.checked_add(1).ok_or_else(|| {
            TransferError::new(
                "document_epoch_exhausted",
                "WebView document epoch exhausted",
            )
        })?;
        state.session_document_epoch = 0;
        state.active = false;
        if let Some(token) = state.live_generation_token.take() {
            token.cancel();
        }
        state.phase5_evidence_by_observation.clear();
        // Tauri's native page-load start proves the previous JavaScript
        // document is being replaced. Its delivered buffers are now orphaned;
        // native work remains charged to its exact session until completion.
        state.held_credits_by_owner.clear();
        state.acknowledged_release_ids.clear();
        Ok(())
    }

    fn begin(&self, session: u64, generation: u64) -> Result<TransferSnapshot, TransferError> {
        if generation == 0 {
            return Err(TransferError::new(
                "invalid_generation",
                "generation must be greater than zero",
            ));
        }
        let mut state = self.lock()?;
        ensure_session(&state, session)?;
        if generation <= state.generation {
            return Err(TransferError::new(
                "stale_generation",
                format!(
                    "generation {generation} is not newer than {}",
                    state.generation
                ),
            ));
        }
        if let Some(token) = state.live_generation_token.take() {
            token.cancel();
        }
        let token = GenerationClock::default()
            .begin(generation)
            .map_err(|error| TransferError::new("generation_token_failed", error.to_string()))?;
        state.generation = generation;
        state.active = true;
        state.live_generation_token = Some(token);
        state.phase5_evidence_by_observation.clear();
        Ok(snapshot(&state))
    }

    fn cancel(&self, session: u64, generation: u64) -> Result<TransferSnapshot, TransferError> {
        let mut state = self.lock()?;
        ensure_current(&state, session, generation)?;
        state.active = false;
        if let Some(token) = state.live_generation_token.take() {
            token.cancel();
        }
        Ok(snapshot(&state))
    }

    fn acquire(&self, session: u64, generation: u64) -> Result<(), TransferError> {
        let mut state = self.lock()?;
        ensure_current(&state, session, generation)?;
        if !state.active {
            return Err(TransferError::new(
                "generation_cancelled",
                format!("generation {generation} is cancelled"),
            ));
        }
        if credits_in_use(&state) >= TRANSFER_CREDIT_LIMIT {
            return Err(TransferError::new(
                "credit_exhausted",
                "both renderer transfer credits are already in use",
            ));
        }
        *state
            .in_flight_credits_by_session
            .entry(session)
            .or_default() += 1;
        Ok(())
    }

    fn release(
        &self,
        session: u64,
        generation: u64,
        release_id: &str,
    ) -> Result<TransferSnapshot, TransferError> {
        let mut state = self.lock()?;
        validate_release_id(release_id)?;
        if state.acknowledged_release_ids.contains(release_id) {
            return Ok(snapshot(&state));
        }
        let owner = (session, generation);
        let Some(held) = state.held_credits_by_owner.get_mut(&owner) else {
            return Err(TransferError::new(
                "credit_not_held",
                format!("session {session} generation {generation} holds no delivered credit"),
            ));
        };
        *held -= 1;
        if *held == 0 {
            state.held_credits_by_owner.remove(&owner);
        }
        state
            .acknowledged_release_ids
            .insert(release_id.to_string());
        Ok(snapshot(&state))
    }

    fn finish_without_publish(&self, session: u64) {
        if let Ok(mut state) = self.inner.lock() {
            take_in_flight_credit(&mut state, session);
        }
    }

    fn complete_for_publish(&self, session: u64, generation: u64) -> Result<(), TransferError> {
        let mut state = self.lock()?;
        complete_for_publish_locked(&mut state, session, generation)
    }

    fn live_generation_token(
        &self,
        session: u64,
        generation: u64,
    ) -> Result<GenerationToken, TransferError> {
        let state = self.lock()?;
        ensure_current(&state, session, generation)?;
        if !state.active {
            return Err(TransferError::new(
                "generation_cancelled",
                format!("generation {generation} is cancelled"),
            ));
        }
        state.live_generation_token.clone().ok_or_else(|| {
            TransferError::new(
                "generation_token_missing",
                "active generation has no live acquisition token",
            )
        })
    }

    fn phase5_live_evidence(
        &self,
        session: u64,
        generation: u64,
        observation_id: &str,
    ) -> Result<Phase5LiveTransferEvidence, TransferError> {
        let state = self.lock()?;
        ensure_current(&state, session, generation)?;
        state
            .phase5_evidence_by_observation
            .get(observation_id)
            .cloned()
            .ok_or_else(|| {
                TransferError::new(
                    "phase5_evidence_not_found",
                    format!("no live evidence exists for observation {observation_id}"),
                )
            })
    }

    fn snapshot(&self) -> Result<TransferSnapshot, TransferError> {
        let state = self.lock()?;
        Ok(snapshot(&state))
    }

    fn phase4_activity_snapshot(&self) -> Result<Phase4ActivitySnapshot, TransferError> {
        let state = self.lock()?;
        Ok(state.phase4_activity)
    }

    fn record_phase4_disk_read(&self) -> Result<(), TransferError> {
        let mut state = self.lock()?;
        state.phase4_activity.disk_reads = state.phase4_activity.disk_reads.saturating_add(1);
        Ok(())
    }

    fn record_phase4_decode_and_normalize(&self) -> Result<(), TransferError> {
        let mut state = self.lock()?;
        state.phase4_activity.decoder_runs = state.phase4_activity.decoder_runs.saturating_add(1);
        state.phase4_activity.normalization_runs =
            state.phase4_activity.normalization_runs.saturating_add(1);
        Ok(())
    }

    fn record_phase4_bulk_ipc(&self, byte_length: usize) -> Result<(), TransferError> {
        let mut state = self.lock()?;
        state.phase4_activity.bulk_ipc_transfers =
            state.phase4_activity.bulk_ipc_transfers.saturating_add(1);
        state.phase4_activity.bulk_ipc_bytes = state
            .phase4_activity
            .bulk_ipc_bytes
            .saturating_add(byte_length as u64);
        Ok(())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, TransferState>, TransferError> {
        self.inner.lock().map_err(|_| {
            TransferError::new(
                "transfer_state_poisoned",
                "transfer state is unavailable after an internal panic",
            )
        })
    }
}

fn complete_for_publish_locked(
    state: &mut TransferState,
    session: u64,
    generation: u64,
) -> Result<(), TransferError> {
    let publication_error = if session != state.session {
        Some(TransferError::new(
            "stale_session",
            format!(
                "session {session} is stale; current session is {}",
                state.session
            ),
        ))
    } else if generation != state.generation {
        Some(TransferError::new(
            "stale_generation",
            format!(
                "generation {generation} is stale; current generation is {}",
                state.generation
            ),
        ))
    } else if !state.active {
        Some(TransferError::new(
            "generation_cancelled",
            format!("generation {generation} is cancelled"),
        ))
    } else {
        None
    };
    if !take_in_flight_credit(state, session) {
        return Err(TransferError::new(
            "transfer_state_invalid",
            format!("session {session} completed work without an in-flight credit"),
        ));
    }
    if let Some(error) = publication_error {
        Err(error)
    } else {
        *state
            .held_credits_by_owner
            .entry((session, generation))
            .or_default() += 1;
        Ok(())
    }
}

fn ensure_session(state: &TransferState, session: u64) -> Result<(), TransferError> {
    if session == 0
        || session != state.session
        || state.session_document_epoch != state.document_epoch
    {
        return Err(TransferError::new(
            "stale_session",
            format!(
                "session {session} is stale; current session is {}",
                state.session
            ),
        ));
    }
    Ok(())
}

fn ensure_current(
    state: &TransferState,
    session: u64,
    generation: u64,
) -> Result<(), TransferError> {
    ensure_session(state, session)?;
    if generation != state.generation {
        return Err(TransferError::new(
            "stale_generation",
            format!(
                "generation {generation} is stale; current generation is {}",
                state.generation
            ),
        ));
    }
    Ok(())
}

fn snapshot(state: &TransferState) -> TransferSnapshot {
    let available_credits = if state.active {
        TRANSFER_CREDIT_LIMIT.saturating_sub(credits_in_use(state))
    } else {
        0
    };
    TransferSnapshot {
        session: state.session,
        generation: state.generation,
        active: state.active,
        available_credits,
        held_credits: held_credit_count(state),
        in_flight_credits: in_flight_credit_count(state),
        credit_limit: TRANSFER_CREDIT_LIMIT,
    }
}

fn credits_in_use(state: &TransferState) -> u8 {
    held_credit_count(state).saturating_add(in_flight_credit_count(state))
}

fn held_credit_count(state: &TransferState) -> u8 {
    state
        .held_credits_by_owner
        .values()
        .copied()
        .fold(0, u8::saturating_add)
}

fn held_credit_count_for_session(state: &TransferState, session: u64) -> u8 {
    state
        .held_credits_by_owner
        .iter()
        .filter(|((owner_session, _), _)| *owner_session == session)
        .map(|(_, held)| *held)
        .fold(0, u8::saturating_add)
}

fn in_flight_credit_count(state: &TransferState) -> u8 {
    state
        .in_flight_credits_by_session
        .values()
        .copied()
        .fold(0, u8::saturating_add)
}

fn in_flight_credit_count_for_session(state: &TransferState, session: u64) -> u8 {
    state
        .in_flight_credits_by_session
        .get(&session)
        .copied()
        .unwrap_or(0)
}

fn take_in_flight_credit(state: &mut TransferState, session: u64) -> bool {
    let Some(held) = state.in_flight_credits_by_session.get_mut(&session) else {
        return false;
    };
    *held -= 1;
    if *held == 0 {
        state.in_flight_credits_by_session.remove(&session);
    }
    true
}

fn validate_release_id(release_id: &str) -> Result<(), TransferError> {
    if !(16..=64).contains(&release_id.len())
        || !release_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(TransferError::new(
            "invalid_release_id",
            "release ID must be 16-64 ASCII letters, digits, hyphens, or underscores",
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn open_phase2_transfer_session(
    state: tauri::State<'_, TransferBroker>,
) -> Result<TransferSnapshot, TransferError> {
    state.open_session()
}

#[tauri::command]
pub fn begin_phase2_generation(
    state: tauri::State<'_, TransferBroker>,
    session: u64,
    generation: u64,
) -> Result<TransferSnapshot, TransferError> {
    state.begin(session, generation)
}

#[tauri::command]
pub fn cancel_phase2_generation(
    state: tauri::State<'_, TransferBroker>,
    session: u64,
    generation: u64,
) -> Result<TransferSnapshot, TransferError> {
    state.cancel(session, generation)
}

#[tauri::command]
pub fn release_phase2_transfer_credit(
    state: tauri::State<'_, TransferBroker>,
    session: u64,
    generation: u64,
    release_id: String,
) -> Result<TransferSnapshot, TransferError> {
    state.release(session, generation, &release_id)
}

#[tauri::command]
pub fn phase2_transfer_snapshot(
    state: tauri::State<'_, TransferBroker>,
) -> Result<TransferSnapshot, TransferError> {
    state.snapshot()
}

#[tauri::command]
pub fn phase4_activity_snapshot(
    state: tauri::State<'_, TransferBroker>,
) -> Result<Phase4ActivitySnapshot, TransferError> {
    state.phase4_activity_snapshot()
}

#[tauri::command]
pub fn phase5_live_evidence(
    state: tauri::State<'_, TransferBroker>,
    session: u64,
    generation: u64,
    observation_id: String,
) -> Result<Phase5LiveTransferEvidence, TransferError> {
    state.phase5_live_evidence(session, generation, &observation_id)
}

#[tauri::command]
pub async fn request_phase2_benchmark_sweep(
    state: tauri::State<'_, TransferBroker>,
    session: u64,
    generation: u64,
    hold_ms: Option<u64>,
) -> Result<Response, TransferError> {
    let broker = state.inner().clone();
    broker.acquire(session, generation)?;
    let hold_ms = hold_ms.unwrap_or(0).min(MAX_DIAGNOSTIC_HOLD_MS);
    let task = tauri::async_runtime::spawn_blocking(move || {
        let sweep = phase2_benchmark_sweep();
        let bytes = encode_packed_sweep(&sweep, PackedSweepIdentity { generation })
            .map_err(|error| TransferError::new("wire_encode_failed", error.to_string()))?;
        if hold_ms > 0 {
            std::thread::sleep(Duration::from_millis(hold_ms));
        }
        Ok::<_, TransferError>(bytes)
    })
    .await;

    let encoded = match task {
        Ok(encoded) => encoded,
        Err(error) => {
            broker.finish_without_publish(session);
            return Err(TransferError::new("backend_task_failed", error.to_string()));
        }
    };

    let bytes = match encoded {
        Ok(bytes) => bytes,
        Err(error) => {
            broker.finish_without_publish(session);
            return Err(error);
        }
    };
    broker.complete_for_publish(session, generation)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn request_phase3_fixture_sweep(
    state: tauri::State<'_, TransferBroker>,
    session: u64,
    generation: u64,
) -> Result<Response, TransferError> {
    let broker = state.inner().clone();
    broker.acquire(session, generation)?;
    let task = tauri::async_runtime::spawn_blocking(move || {
        let path = phase3_fixture_path()?;
        let input = read_phase3_archive(&path)?;
        verify_phase3_archive_hash(&input)?;
        let decoded = decode_level2(&input, RadarProduct::Reflectivity)
            .map_err(|error| TransferError::new("fixture_decode_failed", error.to_string()))?;
        encode_packed_sweep(&decoded.sweep, PackedSweepIdentity { generation })
            .map_err(|error| TransferError::new("wire_encode_failed", error.to_string()))
    })
    .await;

    let encoded = match task {
        Ok(encoded) => encoded,
        Err(error) => {
            broker.finish_without_publish(session);
            return Err(TransferError::new("backend_task_failed", error.to_string()));
        }
    };
    let bytes = match encoded {
        Ok(bytes) => bytes,
        Err(error) => {
            broker.finish_without_publish(session);
            return Err(error);
        }
    };
    broker.complete_for_publish(session, generation)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn request_phase4_fixture_sweep(
    state: tauri::State<'_, TransferBroker>,
    resources: tauri::State<'_, RuntimeResources>,
    session: u64,
    generation: u64,
    fixture_id: String,
) -> Result<Response, TransferError> {
    let broker = state.inner().clone();
    let resource_root = resources.root.clone();
    broker.acquire(session, generation)?;
    let worker_broker = broker.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        let fixture = phase4_fixture_expectation(&fixture_id)?;
        let path = phase4_fixture_path(&fixture, &resource_root)?;
        let input = read_fixture_archive(&path, &fixture)?;
        worker_broker.record_phase4_disk_read()?;
        verify_fixture_archive_hash(&input, &fixture, "Phase 4")?;
        worker_broker.record_phase4_decode_and_normalize()?;
        let decoded = decode_level2(&input, RadarProduct::Reflectivity)
            .map_err(|error| TransferError::new("fixture_decode_failed", error.to_string()))?;
        encode_packed_sweep(&decoded.sweep, PackedSweepIdentity { generation })
            .map_err(|error| TransferError::new("wire_encode_failed", error.to_string()))
    })
    .await;

    let encoded = match task {
        Ok(encoded) => encoded,
        Err(error) => {
            broker.finish_without_publish(session);
            return Err(TransferError::new("backend_task_failed", error.to_string()));
        }
    };
    let bytes = match encoded {
        Ok(bytes) => bytes,
        Err(error) => {
            broker.finish_without_publish(session);
            return Err(error);
        }
    };
    broker.complete_for_publish(session, generation)?;
    // Publication already converted the in-flight credit into a delivered
    // credit. It remains releasable by the client if this diagnostic update fails.
    broker.record_phase4_bulk_ipc(bytes.len())?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn request_phase6_n0s_fixture_sweep(
    state: tauri::State<'_, TransferBroker>,
    session: u64,
    generation: u64,
    fixture_id: String,
) -> Result<Response, TransferError> {
    let broker = state.inner().clone();
    broker.acquire(session, generation)?;
    let task = tauri::async_runtime::spawn_blocking(move || {
        let fixture = phase6_n0s_fixture_expectation(&fixture_id)?;
        let path = phase6_fixture_path(&fixture)?;
        let input = read_fixture_archive(&path, &fixture)?;
        verify_fixture_archive_hash(&input, &fixture, "Phase 6")?;
        let decoded = decode_level3_n0s(&input, &fixture.station)
            .map_err(|error| TransferError::new("fixture_decode_failed", error.to_string()))?;
        encode_packed_sweep(&decoded.sweep, PackedSweepIdentity { generation })
            .map_err(|error| TransferError::new("wire_encode_failed", error.to_string()))
    })
    .await;

    let encoded = match task {
        Ok(encoded) => encoded,
        Err(error) => {
            broker.finish_without_publish(session);
            return Err(TransferError::new("backend_task_failed", error.to_string()));
        }
    };
    let bytes = match encoded {
        Ok(bytes) => bytes,
        Err(error) => {
            broker.finish_without_publish(session);
            return Err(error);
        }
    };
    broker.complete_for_publish(session, generation)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn request_phase5_live_sweep(
    state: tauri::State<'_, TransferBroker>,
    session: u64,
    generation: u64,
    site: String,
    fresh_only: bool,
    timeout_seconds: u64,
    history_cursor: Option<LiveHistoryCursorArgs>,
) -> Result<Response, TransferError> {
    if !(10..=900).contains(&timeout_seconds) {
        return Err(TransferError::new(
            "invalid_live_timeout",
            "live timeout must be between 10 and 900 seconds",
        ));
    }
    let history_request = validate_live_history_request(fresh_only, history_cursor)?;
    let broker = state.inner().clone();
    broker.acquire(session, generation)?;

    let timeout = Duration::from_secs(timeout_seconds);
    let credit = InFlightCreditGuard::new(broker.clone(), session);
    let worker_broker = broker.clone();
    let worker = tauri::async_runtime::spawn(async move {
        let token = worker_broker.live_generation_token(session, generation)?;
        let client = PublicRadarClient::new()
            .map_err(|error| TransferError::new("live_client_failed", error.to_string()))?;
        let mut live = match history_request {
            Some(ValidatedLiveHistoryRequest::After {
                volume_index,
                volume_started_at_unix_ms,
            }) => {
                LiveSweepSession::start_after(
                    client,
                    token,
                    &site,
                    volume_index,
                    volume_started_at_unix_ms,
                )
                .await
            }
            Some(ValidatedLiveHistoryRequest::Before {
                volume_index,
                volume_started_at_unix_ms,
            }) => {
                LiveSweepSession::start_before(
                    client,
                    token,
                    &site,
                    volume_index,
                    volume_started_at_unix_ms,
                )
                .await
            }
            None => LiveSweepSession::start(client, token, &site, fresh_only).await,
        }
        .map_err(|error| TransferError::new("live_start_failed", error.to_string()))?;
        let safe = live
            .wait_for_safe_sweep(timeout)
            .await
            .map_err(|error| TransferError::new("live_sweep_failed", error.to_string()))?;
        let safe_evidence = safe.evidence;
        let bytes = tauri::async_runtime::spawn_blocking(move || {
            encode_packed_sweep(&safe.output.sweep, PackedSweepIdentity { generation })
                .map_err(|error| TransferError::new("wire_encode_failed", error.to_string()))
        })
        .await
        .map_err(|error| TransferError::new("backend_task_failed", error.to_string()))??;
        let summary = validate_packed_sweep(&bytes)
            .map_err(|error| TransferError::new("wire_validation_failed", error.to_string()))?;
        if summary.source_kind != "nexrad_level2_chunks" {
            return Err(TransferError::new(
                "live_source_invalid",
                format!(
                    "live sweep encoded unexpected source {}",
                    summary.source_kind
                ),
            ));
        }
        let evidence = Phase5LiveTransferEvidence {
            observation_id: summary.observation_id,
            source_kind: summary.source_kind,
            packed_bytes: bytes.len(),
            published_at_unix_ms: chrono::Utc::now().timestamp_millis(),
            safe: safe_evidence,
        };
        Ok::<_, TransferError>(ChargedPhase5Work {
            bytes,
            evidence,
            credit,
        })
    });
    let joined = enforce_live_request_timeout(timeout, async move {
        worker
            .await
            .map_err(|error| TransferError::new("backend_task_failed", error.to_string()))
    })
    .await?;
    let charged = joined?;
    charged
        .credit
        .complete_phase5_for_publish(generation, charged.evidence)?;
    Ok(Response::new(charged.bytes))
}

fn validate_live_history_request(
    fresh_only: bool,
    history_cursor: Option<LiveHistoryCursorArgs>,
) -> Result<Option<ValidatedLiveHistoryRequest>, TransferError> {
    let validated = match history_cursor {
        None => None,
        Some(cursor)
            if fresh_only
                && (1..=999).contains(&cursor.volume_index)
                && cursor.volume_started_at_unix_ms > 0 =>
        {
            Some(match cursor.direction {
                LiveHistoryDirectionArgs::After => ValidatedLiveHistoryRequest::After {
                    volume_index: cursor.volume_index,
                    volume_started_at_unix_ms: cursor.volume_started_at_unix_ms,
                },
                LiveHistoryDirectionArgs::Before => ValidatedLiveHistoryRequest::Before {
                    volume_index: cursor.volume_index,
                    volume_started_at_unix_ms: cursor.volume_started_at_unix_ms,
                },
            })
        }
        _ => {
            return Err(TransferError::new(
                "invalid_live_cursor",
                "live history requires fresh-only mode, a cursor with a volume index from 1 to 999 and positive start time, and an explicit after/before direction",
            ));
        }
    };
    Ok(validated)
}

async fn enforce_live_request_timeout<F, T>(
    timeout: Duration,
    operation: F,
) -> Result<T, TransferError>
where
    F: Future<Output = Result<T, TransferError>>,
{
    tokio::time::timeout(timeout, operation)
        .await
        .map_err(|_| {
            TransferError::new(
                "live_sweep_failed",
                "live acquisition exceeded the complete request timeout",
            )
        })?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureManifest {
    schema_version: u8,
    fixture_sets: BTreeMap<String, Vec<String>>,
    fixtures: Vec<FixtureManifestEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureManifestEntry {
    id: String,
    dataset_kind: String,
    station: String,
    size_bytes: u64,
    sha256: String,
    local_path: String,
}

fn fixture_manifest() -> Result<FixtureManifest, TransferError> {
    let manifest: FixtureManifest =
        serde_json::from_str(FIXTURE_MANIFEST_JSON).map_err(|error| {
            TransferError::new(
                "fixture_manifest_invalid",
                format!("embedded fixture manifest is invalid: {error}"),
            )
        })?;
    if manifest.schema_version != 2 {
        return Err(TransferError::new(
            "fixture_manifest_invalid",
            format!(
                "embedded fixture manifest schema {} is unsupported",
                manifest.schema_version
            ),
        ));
    }
    Ok(manifest)
}

fn phase3_fixture_expectation() -> Result<FixtureManifestEntry, TransferError> {
    fixture_manifest()?
        .fixtures
        .into_iter()
        .find(|fixture| fixture.id == PHASE3_FIXTURE_ID)
        .ok_or_else(|| {
            TransferError::new(
                "fixture_manifest_invalid",
                format!("embedded fixture manifest is missing {PHASE3_FIXTURE_ID}"),
            )
        })
}

fn phase4_fixture_expectation(fixture_id: &str) -> Result<FixtureManifestEntry, TransferError> {
    let manifest = fixture_manifest()?;
    phase4_fixture_expectation_in(&manifest, fixture_id)
}

fn phase6_n0s_fixture_expectation(fixture_id: &str) -> Result<FixtureManifestEntry, TransferError> {
    let manifest = fixture_manifest()?;
    let fixture_ids = manifest
        .fixture_sets
        .get(PHASE6_N0S_FIXTURE_SET)
        .ok_or_else(|| {
            TransferError::new(
                "fixture_manifest_invalid",
                format!("embedded fixture manifest is missing set {PHASE6_N0S_FIXTURE_SET}"),
            )
        })?;
    if !fixture_ids.iter().any(|candidate| candidate == fixture_id) {
        return Err(TransferError::new(
            "fixture_not_pinned",
            format!("fixture ID {fixture_id:?} is not in set {PHASE6_N0S_FIXTURE_SET}"),
        ));
    }
    let fixture = manifest
        .fixtures
        .into_iter()
        .find(|fixture| fixture.id == fixture_id)
        .ok_or_else(|| {
            TransferError::new(
                "fixture_manifest_invalid",
                format!("set {PHASE6_N0S_FIXTURE_SET} references missing fixture {fixture_id:?}"),
            )
        })?;
    if fixture.dataset_kind != "level3_n0s" {
        return Err(TransferError::new(
            "fixture_manifest_invalid",
            format!("fixture {fixture_id:?} is not Level III N0S"),
        ));
    }
    Ok(fixture)
}

fn phase4_fixture_expectation_in(
    manifest: &FixtureManifest,
    fixture_id: &str,
) -> Result<FixtureManifestEntry, TransferError> {
    let fixture_ids = manifest
        .fixture_sets
        .get(PHASE4_FIXTURE_SET)
        .ok_or_else(|| {
            TransferError::new(
                "fixture_manifest_invalid",
                format!("embedded fixture manifest is missing set {PHASE4_FIXTURE_SET}"),
            )
        })?;
    let distinct_ids = fixture_ids.iter().collect::<BTreeSet<_>>();
    if fixture_ids.len() != PHASE4_FRAME_COUNT || distinct_ids.len() != PHASE4_FRAME_COUNT {
        return Err(TransferError::new(
            "fixture_manifest_invalid",
            format!(
                "fixture set {PHASE4_FIXTURE_SET} must contain exactly {PHASE4_FRAME_COUNT} distinct observations"
            ),
        ));
    }
    if !fixture_ids.iter().any(|candidate| candidate == fixture_id) {
        return Err(TransferError::new(
            "fixture_not_pinned",
            format!("fixture ID {fixture_id:?} is not in set {PHASE4_FIXTURE_SET}"),
        ));
    }
    manifest
        .fixtures
        .iter()
        .find(|fixture| fixture.id == fixture_id)
        .cloned()
        .ok_or_else(|| {
            TransferError::new(
                "fixture_manifest_invalid",
                format!(
                    "fixture set {PHASE4_FIXTURE_SET} references missing fixture ID {fixture_id:?}"
                ),
            )
        })
}

fn verify_phase3_archive_hash(input: &[u8]) -> Result<(), TransferError> {
    let expected = phase3_fixture_expectation()?;
    verify_fixture_archive_hash(input, &expected, "Phase 3")
}

fn verify_fixture_archive_hash(
    input: &[u8],
    expected: &FixtureManifestEntry,
    phase: &str,
) -> Result<(), TransferError> {
    let actual_sha256 = format!("{:x}", Sha256::digest(input));
    if input.len() as u64 != expected.size_bytes || actual_sha256 != expected.sha256 {
        return Err(TransferError::new(
            "fixture_hash_mismatch",
            format!(
                "{phase} fixture does not match manifest entry {}: expected {} bytes / {}, got {} bytes / {actual_sha256}",
                expected.id,
                expected.size_bytes,
                expected.sha256,
                input.len()
            ),
        ));
    }
    Ok(())
}

fn read_fixture_archive(
    path: &std::path::Path,
    fixture: &FixtureManifestEntry,
) -> Result<Vec<u8>, TransferError> {
    let input = read_phase3_archive(path)?;
    if input.len() as u64 != fixture.size_bytes {
        return Err(TransferError::new(
            "fixture_hash_mismatch",
            format!(
                "fixture {} expected {} bytes, got {} bytes",
                fixture.id,
                fixture.size_bytes,
                input.len()
            ),
        ));
    }
    Ok(input)
}

fn read_phase3_archive(path: &std::path::Path) -> Result<Vec<u8>, TransferError> {
    let file = std::fs::File::open(path).map_err(|error| {
        TransferError::new(
            "fixture_unavailable",
            format!("Phase 3 fixture {} is unavailable: {error}", path.display()),
        )
    })?;
    let metadata = file.metadata().map_err(|error| {
        TransferError::new(
            "fixture_unavailable",
            format!(
                "failed to inspect Phase 3 fixture {}: {error}",
                path.display()
            ),
        )
    })?;
    if metadata.len() > MAX_LEVEL2_INPUT_BYTES as u64 {
        return Err(TransferError::new(
            "fixture_too_large",
            format!(
                "Phase 3 fixture is {} bytes; limit is {MAX_LEVEL2_INPUT_BYTES}",
                metadata.len()
            ),
        ));
    }
    read_bounded(file, MAX_LEVEL2_INPUT_BYTES).map_err(|error| {
        TransferError::new(
            "fixture_read_failed",
            format!("failed to read Phase 3 fixture {}: {error}", path.display()),
        )
    })
}

fn read_bounded(reader: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut input = Vec::new();
    reader
        .take((limit as u64).saturating_add(1))
        .read_to_end(&mut input)
        .map_err(|error| error.to_string())?;
    if input.len() > limit {
        return Err(format!(
            "input grew beyond the {limit}-byte limit while it was being read"
        ));
    }
    Ok(input)
}

fn phase3_fixture_path() -> Result<PathBuf, TransferError> {
    if let Some(path) = std::env::var_os("MISTR_PHASE3_FIXTURE_PATH") {
        return Ok(PathBuf::from(path));
    }
    let current = std::env::current_dir().map_err(|error| {
        TransferError::new(
            "fixture_path_failed",
            format!("failed to resolve current directory: {error}"),
        )
    })?;
    Ok(current
        .join("fixtures")
        .join("cache")
        .join(PHASE3_FIXTURE_NAME))
}

fn phase4_fixture_path(
    fixture: &FixtureManifestEntry,
    resource_root: &std::path::Path,
) -> Result<PathBuf, TransferError> {
    let relative = std::path::Path::new(&fixture.local_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        || relative.parent() != Some(std::path::Path::new("cache"))
    {
        return Err(TransferError::new(
            "fixture_manifest_invalid",
            format!("fixture {} has an unsafe localPath", fixture.id),
        ));
    }
    if let Some(cache_dir) = std::env::var_os("MISTR_PHASE4_FIXTURE_CACHE_DIR") {
        let file_name = relative.file_name().ok_or_else(|| {
            TransferError::new(
                "fixture_manifest_invalid",
                format!("fixture {} has no local filename", fixture.id),
            )
        })?;
        return Ok(PathBuf::from(cache_dir).join(file_name));
    }
    let current = std::env::current_dir().map_err(|error| {
        TransferError::new(
            "fixture_path_failed",
            format!("failed to resolve current directory: {error}"),
        )
    })?;
    let development_path = current.join("fixtures").join(relative);
    if development_path.is_file() {
        return Ok(development_path);
    }
    Ok(resource_root.join("fixtures").join(relative))
}

fn phase6_fixture_path(fixture: &FixtureManifestEntry) -> Result<PathBuf, TransferError> {
    let relative = std::path::Path::new(&fixture.local_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        || relative.parent() != Some(std::path::Path::new("cache"))
    {
        return Err(TransferError::new(
            "fixture_manifest_invalid",
            format!("fixture {} has an unsafe localPath", fixture.id),
        ));
    }
    if let Some(cache_dir) = std::env::var_os("MISTR_PHASE6_FIXTURE_CACHE_DIR") {
        let file_name = relative.file_name().ok_or_else(|| {
            TransferError::new(
                "fixture_manifest_invalid",
                format!("fixture {} has no local filename", fixture.id),
            )
        })?;
        return Ok(PathBuf::from(cache_dir).join(file_name));
    }
    let current = std::env::current_dir().map_err(|error| {
        TransferError::new(
            "fixture_path_failed",
            format!("failed to resolve current directory: {error}"),
        )
    })?;
    Ok(current.join("fixtures").join(relative))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderBenchmarkReport {
    pub mode: &'static str,
    pub build_profile: &'static str,
    pub iterations: u8,
    pub payload: PackedSweepSummary,
    pub encode_ms: TimingDistribution,
    pub validate_ms: TimingDistribution,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimingDistribution {
    pub min: f64,
    pub p50: f64,
    pub p95: f64,
    pub max: f64,
}

#[derive(Debug, Default)]
struct EncoderBenchmarkCache {
    reports: Mutex<BTreeMap<u8, EncoderBenchmarkReport>>,
}

impl EncoderBenchmarkCache {
    fn get_or_compute(
        &self,
        iterations: u8,
        compute: impl FnOnce() -> Result<EncoderBenchmarkReport, TransferError>,
    ) -> Result<EncoderBenchmarkReport, TransferError> {
        // Intentionally hold the mutex through the first computation. Reloaded
        // documents may enqueue another small blocking task, but only one task
        // can allocate and encode the representative multi-megabyte sweep.
        let mut reports = self.reports.lock().map_err(|_| {
            TransferError::new(
                "benchmark_cache_poisoned",
                "encoder benchmark cache is unavailable after an internal panic",
            )
        })?;
        if let Some(report) = reports.get(&iterations) {
            return Ok(report.clone());
        }
        let report = compute()?;
        reports.insert(iterations, report.clone());
        Ok(report)
    }
}

static ENCODER_BENCHMARK_CACHE: LazyLock<EncoderBenchmarkCache> =
    LazyLock::new(EncoderBenchmarkCache::default);

#[tauri::command]
pub async fn benchmark_phase2_encoder(
    iterations: u8,
) -> Result<EncoderBenchmarkReport, TransferError> {
    if iterations == 0 || iterations > MAX_BENCHMARK_ITERATIONS {
        return Err(TransferError::new(
            "invalid_benchmark_iterations",
            format!("iterations must be between 1 and {MAX_BENCHMARK_ITERATIONS}"),
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        ENCODER_BENCHMARK_CACHE.get_or_compute(iterations, || run_encoder_benchmark(iterations))
    })
    .await
    .map_err(|error| TransferError::new("backend_task_failed", error.to_string()))?
}

fn run_encoder_benchmark(iterations: u8) -> Result<EncoderBenchmarkReport, TransferError> {
    let sweep = phase2_benchmark_sweep();
    let mut encode_ms = Vec::with_capacity(iterations as usize);
    let mut validate_ms = Vec::with_capacity(iterations as usize);
    let mut payload = None;
    for generation in 1..=iterations {
        let started = Instant::now();
        let bytes = encode_packed_sweep(
            &sweep,
            PackedSweepIdentity {
                generation: generation as u64,
            },
        )
        .map_err(|error| TransferError::new("wire_encode_failed", error.to_string()))?;
        encode_ms.push(started.elapsed().as_secs_f64() * 1_000.0);

        let started = Instant::now();
        payload =
            Some(validate_packed_sweep(&bytes).map_err(|error| {
                TransferError::new("wire_validation_failed", error.to_string())
            })?);
        validate_ms.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    Ok(EncoderBenchmarkReport {
        mode: "phase2_synthetic_720x1832",
        build_profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        iterations,
        payload: payload.expect("positive iteration count"),
        encode_ms: distribution(&encode_ms),
        validate_ms: distribution(&validate_ms),
    })
}

fn distribution(samples: &[f64]) -> TimingDistribution {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    TimingDistribution {
        min: sorted[0],
        p50: percentile(&sorted, 0.50),
        p95: percentile(&sorted, 0.95),
        max: sorted[sorted.len() - 1],
    }
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let rank = (fraction * sorted.len() as f64).ceil() as usize;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Barrier,
        atomic::{AtomicUsize, Ordering},
    };

    fn opened(broker: &TransferBroker) -> u64 {
        broker.open_session().expect("open session").session
    }

    fn release_id(index: u8) -> String {
        format!("phase2-release-{index:02}")
    }

    fn phase5_evidence(generation: u64, observation_id: &str) -> Phase5LiveTransferEvidence {
        Phase5LiveTransferEvidence {
            observation_id: observation_id.into(),
            source_kind: "nexrad_level2_chunks",
            packed_bytes: 123,
            published_at_unix_ms: 9,
            safe: SafeSweepEvidence {
                generation,
                site: "KTLX".into(),
                volume_index: 7,
                volume_started_at_unix_ms: 1,
                safe_sequence: 8,
                safe_chunk_last_modified_unix_ms: 2,
                discovered_at_unix_ms: 3,
                decode_started_at_unix_ms: 4,
                decode_completed_at_unix_ms: 5,
                decoder_attempts: 1,
                gap_observations: 0,
                duplicate_observations: 0,
                acquisition_delta: crate::acquisition::AcquisitionCounters {
                    network_requests: 3,
                    response_bytes: 456,
                },
            },
        }
    }

    #[test]
    fn live_history_request_is_bounded_and_requires_an_explicit_direction() {
        let cursor = LiveHistoryCursorArgs {
            volume_index: 999,
            volume_started_at_unix_ms: 1_800_000_000_000,
            direction: LiveHistoryDirectionArgs::After,
        };
        assert_eq!(
            validate_live_history_request(true, Some(cursor)).unwrap(),
            Some(ValidatedLiveHistoryRequest::After {
                volume_index: 999,
                volume_started_at_unix_ms: 1_800_000_000_000,
            }),
        );
        let cursor = LiveHistoryCursorArgs {
            direction: LiveHistoryDirectionArgs::Before,
            ..cursor
        };
        assert_eq!(
            validate_live_history_request(true, Some(cursor)).unwrap(),
            Some(ValidatedLiveHistoryRequest::Before {
                volume_index: 999,
                volume_started_at_unix_ms: 1_800_000_000_000,
            }),
        );
        assert_eq!(
            validate_live_history_request(false, Some(cursor))
                .unwrap_err()
                .code,
            "invalid_live_cursor",
        );
        assert_eq!(
            validate_live_history_request(
                true,
                Some(LiveHistoryCursorArgs {
                    volume_index: 0,
                    volume_started_at_unix_ms: 1,
                    direction: LiveHistoryDirectionArgs::Before,
                }),
            )
            .unwrap_err()
            .code,
            "invalid_live_cursor",
        );
        assert_eq!(validate_live_history_request(false, None).unwrap(), None,);
    }

    #[test]
    fn live_history_cursor_schema_rejects_missing_or_unknown_directions() {
        let missing = serde_json::json!({
            "volumeIndex": 7,
            "volumeStartedAtUnixMs": 1_800_000_000_000_i64,
        });
        assert!(serde_json::from_value::<LiveHistoryCursorArgs>(missing).is_err());

        let unknown = serde_json::json!({
            "volumeIndex": 7,
            "volumeStartedAtUnixMs": 1_800_000_000_000_i64,
            "direction": "sideways",
        });
        assert!(serde_json::from_value::<LiveHistoryCursorArgs>(unknown).is_err());
    }

    #[test]
    fn phase5_generation_control_cancels_superseded_and_explicitly_cancelled_tokens() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, 4).unwrap();
        let old = broker.live_generation_token(session, 4).unwrap();
        broker.begin(session, 8).unwrap();
        assert!(!old.is_current());
        let current = broker.live_generation_token(session, 8).unwrap();
        assert!(current.is_current());
        broker.cancel(session, 8).unwrap();
        assert!(!current.is_current());
        assert_eq!(
            broker.live_generation_token(session, 8).unwrap_err().code,
            "generation_cancelled"
        );
    }

    #[test]
    fn phase5_evidence_is_published_atomically_only_for_the_current_generation() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, 1).unwrap();
        broker.acquire(session, 1).unwrap();
        InFlightCreditGuard::new(broker.clone(), session)
            .complete_phase5_for_publish(1, phase5_evidence(1, &"a".repeat(32)))
            .unwrap();
        assert_eq!(
            broker
                .phase5_live_evidence(session, 1, &"a".repeat(32))
                .unwrap()
                .safe
                .generation,
            1
        );

        broker.release(session, 1, &release_id(1)).unwrap();
        broker.acquire(session, 1).unwrap();
        let stale = InFlightCreditGuard::new(broker.clone(), session);
        broker.begin(session, 2).unwrap();
        assert_eq!(
            stale
                .complete_phase5_for_publish(1, phase5_evidence(1, &"b".repeat(32)))
                .unwrap_err()
                .code,
            "stale_generation"
        );
        assert_eq!(
            broker
                .phase5_live_evidence(session, 2, &"b".repeat(32))
                .unwrap_err()
                .code,
            "phase5_evidence_not_found"
        );
    }

    #[test]
    fn successful_guarded_publication_preserves_the_other_in_flight_credit() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, 1).unwrap();
        broker.acquire(session, 1).unwrap();
        let first = InFlightCreditGuard::new(broker.clone(), session);
        broker.acquire(session, 1).unwrap();
        let second = InFlightCreditGuard::new(broker.clone(), session);

        first
            .complete_phase5_for_publish(1, phase5_evidence(1, &"a".repeat(32)))
            .unwrap();
        let after_first = broker.snapshot().unwrap();
        assert_eq!(after_first.held_credits, 1);
        assert_eq!(after_first.in_flight_credits, 1);
        assert_eq!(after_first.available_credits, 0);

        drop(second);
        let after_second = broker.snapshot().unwrap();
        assert_eq!(after_second.held_credits, 1);
        assert_eq!(after_second.in_flight_credits, 0);
        assert_eq!(after_second.available_credits, 1);
    }

    #[tokio::test]
    async fn phase5_timeout_bounds_the_complete_live_operation() {
        let error = enforce_live_request_timeout(Duration::from_millis(5), async {
            std::future::pending::<()>().await;
            Ok::<(), TransferError>(())
        })
        .await
        .unwrap_err();
        assert_eq!(error.code, "live_sweep_failed");
        assert_eq!(
            error.message,
            "live acquisition exceeded the complete request timeout"
        );
    }

    #[tokio::test]
    async fn timed_out_blocking_work_retains_credit_until_native_completion() {
        let broker = TransferBroker::default();
        let session = broker.open_session().unwrap().session;
        broker.begin(session, 1).unwrap();
        broker.acquire(session, 1).unwrap();
        let credit = InFlightCreditGuard::new(broker.clone(), session);
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let worker = tokio::spawn(async move {
            let _credit = credit;
            tokio::task::spawn_blocking(move || {
                let _ = started_sender.send(());
                let _ = release_receiver.recv();
            })
            .await
            .map_err(|error| TransferError::new("backend_task_failed", error.to_string()))?;
            Ok::<(), TransferError>(())
        });
        started_receiver.await.expect("blocking worker started");

        let error = enforce_live_request_timeout(Duration::from_millis(5), async move {
            worker
                .await
                .map_err(|error| TransferError::new("backend_task_failed", error.to_string()))?
        })
        .await
        .unwrap_err();
        assert_eq!(error.code, "live_sweep_failed");
        let timed_out = broker.snapshot().unwrap();
        assert_eq!(timed_out.in_flight_credits, 1);
        assert_eq!(timed_out.available_credits, 1);

        release_sender.send(()).expect("release blocking worker");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if broker.snapshot().unwrap().in_flight_credits == 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("credit released after blocking work exits");
        assert_eq!(broker.snapshot().unwrap().available_credits, 2);
    }

    #[test]
    fn phase3_fixture_reader_enforces_the_limit_even_if_the_file_grows() {
        let error = read_bounded(std::io::repeat(7), 128).unwrap_err();
        assert_eq!(
            error,
            "input grew beyond the 128-byte limit while it was being read"
        );
        assert_eq!(read_bounded(&[7_u8; 128][..], 128).unwrap().len(), 128);
    }

    #[test]
    fn phase3_fixture_hash_is_pinned_to_the_embedded_manifest() {
        let expected = phase3_fixture_expectation().unwrap();
        assert_eq!(expected.id, PHASE3_FIXTURE_ID);
        assert_eq!(expected.size_bytes, 7_936_679);
        assert_eq!(
            expected.sha256,
            "99c189c327307da6a26a9f265ee84bf9fc690dc1a7358db941949805afa4a0d3"
        );
        let error = verify_phase3_archive_hash(b"another valid archive could decode").unwrap_err();
        assert_eq!(error.code, "fixture_hash_mismatch");
    }

    #[test]
    fn phase4_manifest_pins_exactly_twenty_distinct_observations() {
        let mut manifest = fixture_manifest().unwrap();
        let fixture_ids = manifest
            .fixture_sets
            .get(PHASE4_FIXTURE_SET)
            .unwrap()
            .clone();
        let ids = fixture_ids
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        assert_eq!(ids.len(), PHASE4_FRAME_COUNT);
        for fixture_id in &fixture_ids {
            let fixture = phase4_fixture_expectation_in(&manifest, fixture_id).unwrap();
            assert_eq!(fixture.sha256.len(), 64);
            assert!(fixture.local_path.starts_with("cache/KTLX20240520_"));
        }
        let original_fixture_count = manifest.fixtures.len();
        let mut future_fixture = manifest.fixtures[0].clone();
        future_fixture.id = "future-phase-fixture".to_string();
        manifest.fixtures.push(future_fixture);
        assert_eq!(manifest.fixtures.len(), original_fixture_count + 1);
        assert!(phase4_fixture_expectation_in(&manifest, fixture_ids[0].as_str()).is_ok());
        assert_eq!(
            phase4_fixture_expectation_in(&manifest, "future-phase-fixture")
                .unwrap_err()
                .code,
            "fixture_not_pinned"
        );
    }

    #[test]
    fn phase6_manifest_pins_only_explicit_n0s_products() {
        let manifest = fixture_manifest().unwrap();
        let fixture_ids = manifest.fixture_sets.get(PHASE6_N0S_FIXTURE_SET).unwrap();
        assert_eq!(fixture_ids.len(), 4);
        for fixture_id in fixture_ids {
            let fixture = phase6_n0s_fixture_expectation(fixture_id).unwrap();
            assert_eq!(fixture.dataset_kind, "level3_n0s");
            assert_eq!(fixture.station.len(), 4);
            assert_eq!(fixture.sha256.len(), 64);
        }
        assert_eq!(
            phase6_n0s_fixture_expectation("ktlx-2024-05-20-230512-v06")
                .unwrap_err()
                .code,
            "fixture_not_pinned"
        );
    }

    #[test]
    fn phase4_activity_ledger_is_monotonic_and_stage_specific() {
        let broker = TransferBroker::default();
        broker.record_phase4_disk_read().unwrap();
        broker.record_phase4_decode_and_normalize().unwrap();
        broker.record_phase4_bulk_ipc(123).unwrap();
        assert_eq!(
            broker.phase4_activity_snapshot().unwrap(),
            Phase4ActivitySnapshot {
                network_requests: 0,
                disk_reads: 1,
                decoder_runs: 1,
                normalization_runs: 1,
                bulk_ipc_transfers: 1,
                bulk_ipc_bytes: 123,
            }
        );
    }

    #[test]
    fn overlapping_encoder_probes_share_one_heavy_computation() {
        let cache = Arc::new(EncoderBenchmarkCache::default());
        let barrier = Arc::new(Barrier::new(3));
        let computations = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();

        for _ in 0..2 {
            let cache = Arc::clone(&cache);
            let barrier = Arc::clone(&barrier);
            let computations = Arc::clone(&computations);
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                cache
                    .get_or_compute(1, || {
                        computations.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(25));
                        run_encoder_benchmark(1)
                    })
                    .expect("benchmark report")
            }));
        }

        barrier.wait();
        let reports: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().expect("benchmark worker"))
            .collect();
        assert_eq!(computations.load(Ordering::SeqCst), 1);
        assert_eq!(reports[0].payload, reports[1].payload);
        assert_eq!(reports[0].iterations, 1);
    }

    #[test]
    fn exactly_two_credits_are_available() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        assert_eq!(broker.begin(session, 1).unwrap().available_credits, 2);
        broker.acquire(session, 1).unwrap();
        broker.acquire(session, 1).unwrap();
        assert_eq!(broker.snapshot().unwrap().in_flight_credits, 2);
        assert_eq!(
            broker.acquire(session, 1).unwrap_err().code,
            "credit_exhausted"
        );
        broker.complete_for_publish(session, 1).unwrap();
        assert_eq!(
            broker
                .release(session, 1, &release_id(1))
                .unwrap()
                .available_credits,
            1
        );
        broker.acquire(session, 1).unwrap();
    }

    #[test]
    fn new_generation_keeps_old_work_globally_charged_until_completion() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, 8).unwrap();
        broker.acquire(session, 8).unwrap();
        broker.acquire(session, 8).unwrap();
        let current = broker.begin(session, 9).unwrap();
        assert_eq!(current.available_credits, 0);
        assert_eq!(current.held_credits, 0);
        assert_eq!(current.in_flight_credits, 2);
        assert_eq!(
            broker.acquire(session, 9).unwrap_err().code,
            "credit_exhausted"
        );
        assert_eq!(
            broker.complete_for_publish(session, 8).unwrap_err().code,
            "stale_generation"
        );
        assert_eq!(broker.snapshot().unwrap().available_credits, 1);
        broker.finish_without_publish(session);
        assert_eq!(broker.snapshot().unwrap().available_credits, 2);
    }

    #[test]
    fn delivered_old_generation_stays_charged_until_frontend_acknowledges_it() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, 8).unwrap();
        broker.acquire(session, 8).unwrap();
        broker.complete_for_publish(session, 8).unwrap();

        let current = broker.begin(session, 9).unwrap();
        assert_eq!(current.held_credits, 1);
        assert_eq!(current.available_credits, 1);
        broker.acquire(session, 9).unwrap();
        assert_eq!(
            broker.acquire(session, 9).unwrap_err().code,
            "credit_exhausted"
        );

        let after_old_ack = broker.release(session, 8, &release_id(1)).unwrap();
        assert_eq!(after_old_ack.held_credits, 0);
        assert_eq!(after_old_ack.in_flight_credits, 1);
        assert_eq!(after_old_ack.available_credits, 1);
        broker.complete_for_publish(session, 9).unwrap();
        assert_eq!(
            broker
                .release(session, 9, &release_id(2))
                .unwrap()
                .available_credits,
            2
        );
    }

    #[test]
    fn new_session_reclaims_orphaned_delivery_but_not_native_work() {
        let broker = TransferBroker::default();
        let first = opened(&broker);
        broker.begin(first, 1).unwrap();
        broker.acquire(first, 1).unwrap();
        broker.complete_for_publish(first, 1).unwrap();
        broker.acquire(first, 1).unwrap();

        broker.document_started().unwrap();
        let second = opened(&broker);
        let opened = broker.snapshot().unwrap();
        assert_eq!(second, first + 1);
        assert_eq!(opened.held_credits, 0);
        assert_eq!(opened.in_flight_credits, 1);
        assert!(!opened.active);
        broker.begin(second, 1).unwrap();
        assert_eq!(broker.snapshot().unwrap().available_credits, 1);
        assert_eq!(
            broker.complete_for_publish(first, 1).unwrap_err().code,
            "stale_session"
        );
        assert_eq!(broker.snapshot().unwrap().available_credits, 2);
    }

    #[test]
    fn second_client_in_same_document_cannot_reclaim_live_credit() {
        let broker = TransferBroker::default();
        let first = opened(&broker);
        broker.begin(first, 1).unwrap();
        broker.acquire(first, 1).unwrap();
        broker.complete_for_publish(first, 1).unwrap();

        assert_eq!(
            broker.open_session().unwrap_err().code,
            "session_still_owned"
        );
        assert_eq!(broker.snapshot().unwrap().held_credits, 1);
        broker.release(first, 1, &release_id(1)).unwrap();

        let second = opened(&broker);
        assert_eq!(second, first + 1);
        assert_eq!(broker.snapshot().unwrap().held_credits, 0);
    }

    #[test]
    fn release_acknowledgement_is_idempotent() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, 1).unwrap();
        broker.acquire(session, 1).unwrap();
        broker.complete_for_publish(session, 1).unwrap();
        let id = release_id(1);
        assert_eq!(
            broker.release(session, 1, &id).unwrap().available_credits,
            2
        );
        assert_eq!(
            broker.release(session, 1, &id).unwrap().available_credits,
            2
        );
    }

    #[test]
    fn old_release_retry_cannot_release_a_newer_credit() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, 1).unwrap();

        for index in 1..=66 {
            broker.acquire(session, 1).unwrap();
            broker.complete_for_publish(session, 1).unwrap();
            broker.release(session, 1, &release_id(index)).unwrap();
        }

        broker.acquire(session, 1).unwrap();
        broker.complete_for_publish(session, 1).unwrap();
        assert_eq!(broker.snapshot().unwrap().held_credits, 1);
        assert_eq!(
            broker
                .release(session, 1, &release_id(1))
                .unwrap()
                .held_credits,
            1
        );
        assert_eq!(
            broker
                .release(session, 1, &release_id(67))
                .unwrap()
                .held_credits,
            0
        );
    }

    #[test]
    fn cancellation_prevents_publication() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, 3).unwrap();
        broker.acquire(session, 3).unwrap();
        let cancelled = broker.cancel(session, 3).unwrap();
        assert!(!cancelled.active);
        assert_eq!(cancelled.available_credits, 0);
        assert_eq!(cancelled.held_credits, 0);
        assert_eq!(
            broker.complete_for_publish(session, 3).unwrap_err().code,
            "generation_cancelled"
        );
        assert_eq!(broker.snapshot().unwrap().in_flight_credits, 0);
    }

    #[test]
    fn generations_are_monotonic() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, 4).unwrap();
        assert_eq!(
            broker.begin(session, 4).unwrap_err().code,
            "stale_generation"
        );
        assert_eq!(
            broker.begin(session, 2).unwrap_err().code,
            "stale_generation"
        );
    }
}
