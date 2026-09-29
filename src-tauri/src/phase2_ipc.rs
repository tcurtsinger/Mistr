use crate::acquisition::PublicRadarClient;
use crate::live_pipeline::{
    GenerationClock, GenerationToken, LiveSweepSession, SafeSweepCandidate, SafeSweepEvidence,
    next_volume_index, previous_volume_index,
};
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

/// Credits per lane. Site and National each own a pool, so a Site long poll
/// can never starve National's two-request pipeline, or the reverse.
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
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Each radar source owns an independent generation and credit pool, so one
/// source can keep acquiring while the other is displayed or superseded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferLane {
    Site,
    National,
}

impl TransferLane {
    const ALL: [Self; 2] = [Self::Site, Self::National];

    fn index(self) -> usize {
        match self {
            Self::Site => 0,
            Self::National => 1,
        }
    }
}

impl std::fmt::Display for TransferLane {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Site => "Site",
            Self::National => "National",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneSnapshot {
    pub generation: u64,
    pub active: bool,
    pub available_credits: u8,
    pub held_credits: u8,
    pub in_flight_credits: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LaneSnapshots {
    pub site: LaneSnapshot,
    pub national: LaneSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSnapshot {
    pub session: u64,
    /// Totals across both lanes.
    pub held_credits: u8,
    pub in_flight_credits: u8,
    /// Per-lane limit.
    pub credit_limit: u8,
    pub lanes: LaneSnapshots,
}

#[derive(Debug, Default)]
struct LaneState {
    generation: u64,
    active: bool,
    token: Option<GenerationToken>,
}

impl LaneState {
    fn cancel_token(&mut self) {
        if let Some(token) = self.token.take() {
            token.cancel();
        }
    }
}

#[derive(Debug, Default)]
struct TransferState {
    document_epoch: u64,
    session: u64,
    session_document_epoch: u64,
    // Generations stay unique across lanes, so a release can find its lane
    // from (session, generation) alone.
    max_generation: u64,
    lanes: [LaneState; 2],
    held_credits_by_owner: BTreeMap<(u64, TransferLane, u64), u8>,
    // Retain every acknowledgement for the lifetime of its frontend session.
    // A control response can be lost for arbitrarily long, so evicting an ID
    // would let its eventual retry release a newer credit from the same owner.
    acknowledged_release_ids: BTreeSet<String>,
    in_flight_credits_by_owner: BTreeMap<(u64, TransferLane), u8>,
    phase4_activity: Phase4ActivitySnapshot,
    phase5_evidence_by_observation: BTreeMap<String, Phase5LiveTransferEvidence>,
}

impl TransferState {
    fn lane(&self, lane: TransferLane) -> &LaneState {
        &self.lanes[lane.index()]
    }

    fn lane_mut(&mut self, lane: TransferLane) -> &mut LaneState {
        &mut self.lanes[lane.index()]
    }
}

#[derive(Debug)]
struct InFlightCreditGuard {
    broker: TransferBroker,
    session: u64,
    lane: TransferLane,
    armed: bool,
}

impl InFlightCreditGuard {
    fn new(broker: TransferBroker, session: u64, lane: TransferLane) -> Self {
        Self {
            broker,
            session,
            lane,
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
        let credits_before = in_flight_credit_count_for_owner(&state, self.session, self.lane);
        let completion =
            complete_for_publish_locked(&mut state, self.session, self.lane, generation);
        let credits_after = in_flight_credit_count_for_owner(&state, self.session, self.lane);
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
            self.broker.finish_without_publish(self.session, self.lane);
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

// Older Site volumes kept downloading ahead of the backfill requests that ask
// for them one at a time. Each took about 0.75 s, almost all network and
// decode, so four in flight keep backfill well ahead of the page.
const SITE_PREFETCH_DEPTH: usize = 4;

type SitePrefetchTask = tauri::async_runtime::JoinHandle<Result<SafeSweepCandidate, TransferError>>;

#[derive(Debug)]
struct SitePrefetchEntry {
    volume_index: u16,
    task: SitePrefetchTask,
}

/// Predecessor volumes acquired ahead of the backfill requests for them, for
/// one transfer session and site. The page begins a new Site generation for
/// every request, so prefetches run under their own token, cancelled when the
/// session or site changes, and are held decoded: each is encoded for the
/// request that uses it. An entry is used only when its volume satisfies the
/// request's own cursor, so a request never receives a different volume than
/// a fresh acquisition would choose; anything else is acquired fresh.
#[derive(Debug, Clone, Default)]
pub struct SiteHistoryPrefetch {
    state: Arc<Mutex<SitePrefetchState>>,
}

#[derive(Debug, Default)]
struct SitePrefetchState {
    owner: Option<(u64, String)>,
    clock: GenerationClock,
    epoch: u64,
    token: Option<GenerationToken>,
    entries: Vec<SitePrefetchEntry>,
}

impl SitePrefetchState {
    /// The prefetch token for `session` and `site`, cancelling everything
    /// prefetched for any other.
    fn owner_token(&mut self, session: u64, site: &str) -> Option<GenerationToken> {
        let owned = self
            .owner
            .as_ref()
            .is_some_and(|(owner_session, owner_site)| {
                *owner_session == session && owner_site == site
            });
        if !owned {
            retain_site_prefetches(&mut self.entries, |_| false);
            self.epoch += 1;
            self.token = self.clock.begin(self.epoch).ok();
            self.owner = Some((session, site.to_string()));
        }
        self.token.clone()
    }
}

impl SiteHistoryPrefetch {
    /// Removes and returns the prefetch of the volume before `volume_index`.
    fn take(&self, session: u64, site: &str, volume_index: u16) -> Option<SitePrefetchTask> {
        let mut state = self.state.lock().ok()?;
        state.owner_token(session, site)?;
        let target = previous_volume_index(volume_index);
        let position = state
            .entries
            .iter()
            .position(|entry| entry.volume_index == target)?;
        Some(state.entries.remove(position).task)
    }

    /// Starts acquiring the `SITE_PREFETCH_DEPTH` volumes before `newest`,
    /// each strictly older than it, and aborts prefetches outside that window.
    fn schedule(&self, session: u64, site: &str, newest: &SafeSweepEvidence, timeout: Duration) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let Some(token) = state.owner_token(session, site) else {
            return;
        };
        let mut window = Vec::with_capacity(SITE_PREFETCH_DEPTH);
        let mut volume_index = newest.volume_index;
        for _ in 0..SITE_PREFETCH_DEPTH {
            volume_index = previous_volume_index(volume_index);
            window.push(volume_index);
        }
        retain_site_prefetches(&mut state.entries, |entry| {
            window.contains(&entry.volume_index)
        });
        for volume_index in window {
            if state
                .entries
                .iter()
                .any(|entry| entry.volume_index == volume_index)
            {
                continue;
            }
            let token = token.clone();
            let task_site = site.to_string();
            let before_started_at = newest.volume_started_at_unix_ms;
            let task = tauri::async_runtime::spawn(async move {
                let client = PublicRadarClient::new()
                    .map_err(|error| TransferError::new("live_client_failed", error.to_string()))?;
                // start_before targets the slot before the one it is given.
                let live = LiveSweepSession::start_before(
                    client,
                    token,
                    &task_site,
                    next_volume_index(volume_index),
                    before_started_at,
                )
                .await
                .map_err(|error| TransferError::new("live_start_failed", error.to_string()))?;
                acquire_live_sweep(live, timeout, timeout).await
            });
            state.entries.push(SitePrefetchEntry { volume_index, task });
        }
    }
}

fn retain_site_prefetches(
    entries: &mut Vec<SitePrefetchEntry>,
    keep: impl Fn(&SitePrefetchEntry) -> bool,
) {
    entries.retain(|entry| {
        let kept = keep(entry);
        if !kept {
            entry.task.abort();
        }
        kept
    });
}

/// Whether a prefetched volume is the one a request for the volume before
/// `volume_index`, strictly older than `volume_started_at_unix_ms`, receives.
fn prefetch_satisfies(
    acquired: &SafeSweepEvidence,
    site: &str,
    volume_index: u16,
    volume_started_at_unix_ms: i64,
) -> bool {
    acquired.site == site
        && acquired.volume_index == previous_volume_index(volume_index)
        && acquired.volume_started_at_unix_ms < volume_started_at_unix_ms
}

async fn acquire_live_sweep(
    mut live: LiveSweepSession,
    wait: Duration,
    timeout: Duration,
) -> Result<SafeSweepCandidate, TransferError> {
    live.wait_for_safe_sweep_discovered_within(wait, timeout)
        .await
        .map_err(|error| TransferError::new("live_sweep_failed", error.to_string()))
}

/// Encodes an acquired sweep for publication in `generation`.
async fn encode_live_sweep(
    candidate: SafeSweepCandidate,
    generation: u64,
) -> Result<(Vec<u8>, PackedSweepSummary, SafeSweepEvidence), TransferError> {
    let SafeSweepCandidate {
        output,
        mut evidence,
    } = candidate;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        encode_packed_sweep(&output.sweep, PackedSweepIdentity { generation })
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
    // A prefetched sweep was acquired under the prefetch token; it is
    // published in the requesting generation.
    evidence.generation = generation;
    Ok((bytes, summary, evidence))
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
        for lane in &mut state.lanes {
            lane.cancel_token();
            lane.generation = 0;
            lane.active = false;
        }
        state.phase5_evidence_by_observation.clear();
        state.session = state.session.checked_add(1).ok_or_else(|| {
            TransferError::new("session_exhausted", "frontend session counter exhausted")
        })?;
        state.session_document_epoch = state.document_epoch;
        state.max_generation = 0;
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
        for lane in &mut state.lanes {
            lane.active = false;
            lane.cancel_token();
        }
        state.phase5_evidence_by_observation.clear();
        // Tauri's native page-load start proves the previous JavaScript
        // document is being replaced. Its delivered buffers are now orphaned;
        // native work remains charged to its exact session until completion.
        state.held_credits_by_owner.clear();
        state.acknowledged_release_ids.clear();
        Ok(())
    }

    fn begin(
        &self,
        session: u64,
        lane: TransferLane,
        generation: u64,
    ) -> Result<TransferSnapshot, TransferError> {
        if generation == 0 {
            return Err(TransferError::new(
                "invalid_generation",
                "generation must be greater than zero",
            ));
        }
        let mut state = self.lock()?;
        ensure_session(&state, session)?;
        if generation <= state.max_generation {
            return Err(TransferError::new(
                "stale_generation",
                format!(
                    "generation {generation} is not newer than {}",
                    state.max_generation
                ),
            ));
        }
        let token = GenerationClock::default()
            .begin(generation)
            .map_err(|error| TransferError::new("generation_token_failed", error.to_string()))?;
        let lane_state = state.lane_mut(lane);
        lane_state.cancel_token();
        lane_state.generation = generation;
        lane_state.active = true;
        lane_state.token = Some(token);
        state.max_generation = generation;
        if lane == TransferLane::Site {
            state.phase5_evidence_by_observation.clear();
        }
        Ok(snapshot(&state))
    }

    fn cancel(
        &self,
        session: u64,
        lane: TransferLane,
        generation: u64,
    ) -> Result<TransferSnapshot, TransferError> {
        let mut state = self.lock()?;
        ensure_current(&state, session, lane, generation)?;
        let lane_state = state.lane_mut(lane);
        lane_state.active = false;
        lane_state.cancel_token();
        Ok(snapshot(&state))
    }

    pub(crate) fn acquire(
        &self,
        session: u64,
        lane: TransferLane,
        generation: u64,
    ) -> Result<(), TransferError> {
        let mut state = self.lock()?;
        ensure_current(&state, session, lane, generation)?;
        if !state.lane(lane).active {
            return Err(TransferError::new(
                "generation_cancelled",
                format!("generation {generation} is cancelled"),
            ));
        }
        if credits_in_use(&state, lane) >= TRANSFER_CREDIT_LIMIT {
            return Err(TransferError::new(
                "credit_exhausted",
                format!("both {lane} transfer credits are already in use"),
            ));
        }
        *state
            .in_flight_credits_by_owner
            .entry((session, lane))
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
        let owner = TransferLane::ALL
            .into_iter()
            .map(|lane| (session, lane, generation))
            .find(|owner| state.held_credits_by_owner.contains_key(owner));
        let Some((owner, held)) = owner.and_then(|owner| {
            state
                .held_credits_by_owner
                .get_mut(&owner)
                .map(|held| (owner, held))
        }) else {
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

    pub(crate) fn finish_without_publish(&self, session: u64, lane: TransferLane) {
        if let Ok(mut state) = self.inner.lock() {
            take_in_flight_credit(&mut state, session, lane);
        }
    }

    pub(crate) fn complete_for_publish(
        &self,
        session: u64,
        lane: TransferLane,
        generation: u64,
    ) -> Result<(), TransferError> {
        let mut state = self.lock()?;
        complete_for_publish_locked(&mut state, session, lane, generation)
    }

    pub(crate) fn live_generation_token(
        &self,
        session: u64,
        lane: TransferLane,
        generation: u64,
    ) -> Result<GenerationToken, TransferError> {
        let state = self.lock()?;
        ensure_current(&state, session, lane, generation)?;
        if !state.lane(lane).active {
            return Err(TransferError::new(
                "generation_cancelled",
                format!("generation {generation} is cancelled"),
            ));
        }
        state.lane(lane).token.clone().ok_or_else(|| {
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
        ensure_current(&state, session, TransferLane::Site, generation)?;
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
    lane: TransferLane,
    generation: u64,
) -> Result<(), TransferError> {
    let lane_state = state.lane(lane);
    let publication_error = if session != state.session {
        Some(TransferError::new(
            "stale_session",
            format!(
                "session {session} is stale; current session is {}",
                state.session
            ),
        ))
    } else if generation != lane_state.generation {
        Some(TransferError::new(
            "stale_generation",
            format!(
                "generation {generation} is stale; current {lane} generation is {}",
                lane_state.generation
            ),
        ))
    } else if !lane_state.active {
        Some(TransferError::new(
            "generation_cancelled",
            format!("generation {generation} is cancelled"),
        ))
    } else {
        None
    };
    if !take_in_flight_credit(state, session, lane) {
        return Err(TransferError::new(
            "transfer_state_invalid",
            format!("session {session} completed {lane} work without an in-flight credit"),
        ));
    }
    if let Some(error) = publication_error {
        Err(error)
    } else {
        *state
            .held_credits_by_owner
            .entry((session, lane, generation))
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
    lane: TransferLane,
    generation: u64,
) -> Result<(), TransferError> {
    ensure_session(state, session)?;
    let current = state.lane(lane).generation;
    if generation != current {
        return Err(TransferError::new(
            "stale_generation",
            format!("generation {generation} is stale; current {lane} generation is {current}"),
        ));
    }
    Ok(())
}

fn snapshot(state: &TransferState) -> TransferSnapshot {
    let lane_snapshot = |lane: TransferLane| {
        let lane_state = state.lane(lane);
        LaneSnapshot {
            generation: lane_state.generation,
            active: lane_state.active,
            available_credits: if lane_state.active {
                TRANSFER_CREDIT_LIMIT.saturating_sub(credits_in_use(state, lane))
            } else {
                0
            },
            held_credits: held_credit_count_for_lane(state, lane),
            in_flight_credits: in_flight_credit_count_for_lane(state, lane),
        }
    };
    TransferSnapshot {
        session: state.session,
        held_credits: held_credit_count(state),
        in_flight_credits: in_flight_credit_count(state),
        credit_limit: TRANSFER_CREDIT_LIMIT,
        lanes: LaneSnapshots {
            site: lane_snapshot(TransferLane::Site),
            national: lane_snapshot(TransferLane::National),
        },
    }
}

fn credits_in_use(state: &TransferState, lane: TransferLane) -> u8 {
    held_credit_count_for_lane(state, lane)
        .saturating_add(in_flight_credit_count_for_lane(state, lane))
}

fn held_credit_count(state: &TransferState) -> u8 {
    state
        .held_credits_by_owner
        .values()
        .copied()
        .fold(0, u8::saturating_add)
}

fn held_credit_count_for_lane(state: &TransferState, lane: TransferLane) -> u8 {
    state
        .held_credits_by_owner
        .iter()
        .filter(|((_, owner_lane, _), _)| *owner_lane == lane)
        .map(|(_, held)| *held)
        .fold(0, u8::saturating_add)
}

fn held_credit_count_for_session(state: &TransferState, session: u64) -> u8 {
    state
        .held_credits_by_owner
        .iter()
        .filter(|((owner_session, _, _), _)| *owner_session == session)
        .map(|(_, held)| *held)
        .fold(0, u8::saturating_add)
}

fn in_flight_credit_count(state: &TransferState) -> u8 {
    state
        .in_flight_credits_by_owner
        .values()
        .copied()
        .fold(0, u8::saturating_add)
}

fn in_flight_credit_count_for_lane(state: &TransferState, lane: TransferLane) -> u8 {
    state
        .in_flight_credits_by_owner
        .iter()
        .filter(|((_, owner_lane), _)| *owner_lane == lane)
        .map(|(_, held)| *held)
        .fold(0, u8::saturating_add)
}

fn in_flight_credit_count_for_session(state: &TransferState, session: u64) -> u8 {
    state
        .in_flight_credits_by_owner
        .iter()
        .filter(|((owner_session, _), _)| *owner_session == session)
        .map(|(_, held)| *held)
        .fold(0, u8::saturating_add)
}

fn in_flight_credit_count_for_owner(state: &TransferState, session: u64, lane: TransferLane) -> u8 {
    state
        .in_flight_credits_by_owner
        .get(&(session, lane))
        .copied()
        .unwrap_or(0)
}

fn take_in_flight_credit(state: &mut TransferState, session: u64, lane: TransferLane) -> bool {
    let owner = (session, lane);
    let Some(held) = state.in_flight_credits_by_owner.get_mut(&owner) else {
        return false;
    };
    *held -= 1;
    if *held == 0 {
        state.in_flight_credits_by_owner.remove(&owner);
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
    lane: TransferLane,
    generation: u64,
) -> Result<TransferSnapshot, TransferError> {
    state.begin(session, lane, generation)
}

#[tauri::command]
pub fn cancel_phase2_generation(
    state: tauri::State<'_, TransferBroker>,
    session: u64,
    lane: TransferLane,
    generation: u64,
) -> Result<TransferSnapshot, TransferError> {
    state.cancel(session, lane, generation)
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
    broker.acquire(session, TransferLane::Site, generation)?;
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
            broker.finish_without_publish(session, TransferLane::Site);
            return Err(TransferError::new("backend_task_failed", error.to_string()));
        }
    };

    let bytes = match encoded {
        Ok(bytes) => bytes,
        Err(error) => {
            broker.finish_without_publish(session, TransferLane::Site);
            return Err(error);
        }
    };
    broker.complete_for_publish(session, TransferLane::Site, generation)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn request_phase3_fixture_sweep(
    state: tauri::State<'_, TransferBroker>,
    session: u64,
    generation: u64,
) -> Result<Response, TransferError> {
    let broker = state.inner().clone();
    broker.acquire(session, TransferLane::Site, generation)?;
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
            broker.finish_without_publish(session, TransferLane::Site);
            return Err(TransferError::new("backend_task_failed", error.to_string()));
        }
    };
    let bytes = match encoded {
        Ok(bytes) => bytes,
        Err(error) => {
            broker.finish_without_publish(session, TransferLane::Site);
            return Err(error);
        }
    };
    broker.complete_for_publish(session, TransferLane::Site, generation)?;
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
    broker.acquire(session, TransferLane::Site, generation)?;
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
            broker.finish_without_publish(session, TransferLane::Site);
            return Err(TransferError::new("backend_task_failed", error.to_string()));
        }
    };
    let bytes = match encoded {
        Ok(bytes) => bytes,
        Err(error) => {
            broker.finish_without_publish(session, TransferLane::Site);
            return Err(error);
        }
    };
    broker.complete_for_publish(session, TransferLane::Site, generation)?;
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
    broker.acquire(session, TransferLane::Site, generation)?;
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
            broker.finish_without_publish(session, TransferLane::Site);
            return Err(TransferError::new("backend_task_failed", error.to_string()));
        }
    };
    let bytes = match encoded {
        Ok(bytes) => bytes,
        Err(error) => {
            broker.finish_without_publish(session, TransferLane::Site);
            return Err(error);
        }
    };
    broker.complete_for_publish(session, TransferLane::Site, generation)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn request_phase5_live_sweep(
    state: tauri::State<'_, TransferBroker>,
    prefetch: tauri::State<'_, SiteHistoryPrefetch>,
    session: u64,
    generation: u64,
    site: String,
    fresh_only: bool,
    timeout_seconds: u64,
    history_cursor: Option<LiveHistoryCursorArgs>,
    wait_seconds: Option<u64>,
) -> Result<Response, TransferError> {
    if !(10..=900).contains(&timeout_seconds) {
        return Err(TransferError::new(
            "invalid_live_timeout",
            "live timeout must be between 10 and 900 seconds",
        ));
    }
    let wait = live_sweep_wait(timeout_seconds, wait_seconds)?;
    let history_request = validate_live_history_request(fresh_only, history_cursor)?;
    let broker = state.inner().clone();
    broker.acquire(session, TransferLane::Site, generation)?;

    let timeout = Duration::from_secs(timeout_seconds);
    let credit = InFlightCreditGuard::new(broker.clone(), session, TransferLane::Site);
    let worker_broker = broker.clone();
    let prefetch = prefetch.inner().clone();
    let worker = tauri::async_runtime::spawn(async move {
        let token = worker_broker.live_generation_token(session, TransferLane::Site, generation)?;
        let prefetched = match history_request {
            Some(ValidatedLiveHistoryRequest::Before {
                volume_index,
                volume_started_at_unix_ms,
            }) => match prefetch.take(session, &site, volume_index) {
                Some(task) => task.await.ok().and_then(Result::ok).filter(|candidate| {
                    prefetch_satisfies(
                        &candidate.evidence,
                        &site,
                        volume_index,
                        volume_started_at_unix_ms,
                    )
                }),
                None => None,
            },
            _ => None,
        };
        let candidate = match prefetched {
            Some(candidate) => candidate,
            None => {
                acquire_requested_live_sweep(
                    token.clone(),
                    &site,
                    fresh_only,
                    history_request,
                    wait,
                    timeout,
                )
                .await?
            }
        };
        token
            .ensure_current()
            .map_err(|error| TransferError::new("live_sweep_failed", error.to_string()))?;
        // The next backfill request asks for the volume before this one.
        if !matches!(
            history_request,
            Some(ValidatedLiveHistoryRequest::After { .. })
        ) {
            prefetch.schedule(session, &site, &candidate.evidence, timeout);
        }
        let (bytes, summary, safe) = encode_live_sweep(candidate, generation).await?;
        let evidence = Phase5LiveTransferEvidence {
            observation_id: summary.observation_id,
            source_kind: summary.source_kind,
            packed_bytes: bytes.len(),
            published_at_unix_ms: chrono::Utc::now().timestamp_millis(),
            safe,
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

async fn acquire_requested_live_sweep(
    token: GenerationToken,
    site: &str,
    fresh_only: bool,
    history_request: Option<ValidatedLiveHistoryRequest>,
    wait: Duration,
    timeout: Duration,
) -> Result<SafeSweepCandidate, TransferError> {
    let client = PublicRadarClient::new()
        .map_err(|error| TransferError::new("live_client_failed", error.to_string()))?;
    let live = match history_request {
        Some(ValidatedLiveHistoryRequest::After {
            volume_index,
            volume_started_at_unix_ms,
        }) => {
            LiveSweepSession::start_after(
                client,
                token,
                site,
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
                site,
                volume_index,
                volume_started_at_unix_ms,
            )
            .await
        }
        None if !fresh_only => {
            let latest = LiveSweepSession::start(client, token.clone(), site, false)
                .await
                .map_err(|error| TransferError::new("live_start_failed", error.to_string()))?;
            return acquire_newest_complete_sweep(latest, token, site, wait, timeout).await;
        }
        None => LiveSweepSession::start(client, token, site, fresh_only).await,
    }
    .map_err(|error| TransferError::new("live_start_failed", error.to_string()))?;
    acquire_live_sweep(live, wait, timeout).await
}

// How long the fallback to the previous volume looks for it before waiting
// on the newest volume after all.
const PREVIOUS_VOLUME_DISCOVERY: Duration = Duration::from_secs(5);

/// The newest volume's safe sweep if its chunks already hold one; otherwise
/// the previous volume's. A volume's lowest sweep takes the radar tens of
/// seconds to record, so a Site opened just as a volume begins showed
/// nothing until it finished. Polling for newer scans publishes the newest
/// volume as soon as its safe sweep completes.
async fn acquire_newest_complete_sweep(
    mut latest: LiveSweepSession,
    token: GenerationToken,
    site: &str,
    wait: Duration,
    timeout: Duration,
) -> Result<SafeSweepCandidate, TransferError> {
    if let Some(candidate) = latest
        .safe_sweep_from_listed_chunks()
        .await
        .map_err(|error| TransferError::new("live_sweep_failed", error.to_string()))?
    {
        return Ok(candidate);
    }
    let Some(latest_started) = latest.selected_started_at() else {
        return acquire_live_sweep(latest, wait, timeout).await;
    };
    let client = PublicRadarClient::new()
        .map_err(|error| TransferError::new("live_client_failed", error.to_string()))?;
    let previous = LiveSweepSession::start_before(
        client,
        token,
        site,
        latest.target_volume_index(),
        latest_started,
    )
    .await
    .map_err(|error| TransferError::new("live_start_failed", error.to_string()))?;
    match acquire_live_sweep(previous, PREVIOUS_VOLUME_DISCOVERY.min(wait), timeout).await {
        Ok(candidate) => Ok(candidate),
        // No usable previous volume: wait for the newest one after all.
        Err(_) => acquire_live_sweep(latest, wait, timeout).await,
    }
}

/// How long to wait for the target volume to be discovered. A short wait
/// probes for a newer scan without holding up other work; once its chunks
/// are listed, the complete timeout bounds assembly, download, and decode.
fn live_sweep_wait(
    timeout_seconds: u64,
    wait_seconds: Option<u64>,
) -> Result<Duration, TransferError> {
    match wait_seconds {
        None => Ok(Duration::from_secs(timeout_seconds)),
        Some(wait) if (1..=timeout_seconds).contains(&wait) => Ok(Duration::from_secs(wait)),
        Some(_) => Err(TransferError::new(
            "invalid_live_wait",
            "live wait must be between 1 second and the complete timeout",
        )),
    }
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
    let bundled_path = resource_root.join("fixtures").join(relative);
    if !bundled_path.is_file() {
        // Installers carry no archives; the loop is read from a repository
        // checkout.
        return Err(TransferError::new(
            "fixture_not_bundled",
            format!(
                "fixture {} is not bundled; run archive diagnostics from the repository",
                fixture.id
            ),
        ));
    }
    Ok(bundled_path)
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

    fn safe_evidence(site: &str, volume_index: u16, started_at: i64) -> SafeSweepEvidence {
        SafeSweepEvidence {
            generation: 7,
            site: site.into(),
            volume_index,
            volume_started_at_unix_ms: started_at,
            safe_sequence: 7,
            safe_chunk_last_modified_unix_ms: started_at,
            discovered_at_unix_ms: started_at,
            decode_started_at_unix_ms: started_at,
            decode_completed_at_unix_ms: started_at,
            decoder_attempts: 1,
            gap_observations: 0,
            duplicate_observations: 0,
            acquisition_delta: crate::acquisition::AcquisitionCounters::default(),
        }
    }

    #[test]
    fn a_prefetched_site_volume_serves_only_the_request_it_satisfies() {
        let prefetched = safe_evidence("KTLX", 41, 1_000);
        assert!(prefetch_satisfies(&prefetched, "KTLX", 42, 2_000));
        // Another slot, another site, or not strictly older than the cursor.
        assert!(!prefetch_satisfies(&prefetched, "KTLX", 43, 2_000));
        assert!(!prefetch_satisfies(&prefetched, "KFWS", 42, 2_000));
        assert!(!prefetch_satisfies(&prefetched, "KTLX", 42, 1_000));
        // The ring wraps from slot 1 back to 999.
        assert!(prefetch_satisfies(
            &safe_evidence("KTLX", 999, 1_000),
            "KTLX",
            1,
            2_000
        ));
    }

    #[tokio::test]
    async fn site_prefetches_serve_one_session_and_site_and_a_change_cancels_them() {
        let prefetch = SiteHistoryPrefetch::default();
        assert!(prefetch.take(1, "KTLX", 42).is_none());
        let token = {
            let mut state = prefetch.state.lock().unwrap();
            for volume_index in [41, 40] {
                state.entries.push(SitePrefetchEntry {
                    volume_index,
                    task: tauri::async_runtime::spawn(std::future::pending::<
                        Result<SafeSweepCandidate, TransferError>,
                    >()),
                });
            }
            state.token.clone().unwrap()
        };
        assert!(prefetch.take(1, "KTLX", 42).is_some());
        assert!(prefetch.take(1, "KTLX", 42).is_none());
        let remaining = |prefetch: &SiteHistoryPrefetch| {
            prefetch
                .state
                .lock()
                .unwrap()
                .entries
                .iter()
                .map(|entry| entry.volume_index)
                .collect::<Vec<_>>()
        };
        assert_eq!(remaining(&prefetch), [40]);
        assert!(token.is_current());
        // Another site drops the rest and stops their downloads.
        assert!(prefetch.take(1, "KFWS", 41).is_none());
        assert!(remaining(&prefetch).is_empty());
        assert!(!token.is_current());
    }
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
    fn beginning_one_lane_leaves_the_other_lane_token_and_credits_intact() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, TransferLane::National, 1).unwrap();
        let national = broker
            .live_generation_token(session, TransferLane::National, 1)
            .unwrap();
        broker.acquire(session, TransferLane::National, 1).unwrap();

        broker.begin(session, TransferLane::Site, 2).unwrap();
        broker.begin(session, TransferLane::Site, 3).unwrap();
        assert!(national.is_current());
        broker
            .complete_for_publish(session, TransferLane::National, 1)
            .unwrap();
        let snapshot = broker.snapshot().unwrap();
        assert_eq!(snapshot.lanes.national.generation, 1);
        assert_eq!(snapshot.lanes.national.held_credits, 1);
        assert_eq!(snapshot.lanes.site.generation, 3);
        assert_eq!(snapshot.lanes.site.available_credits, 2);

        broker.cancel(session, TransferLane::Site, 3).unwrap();
        assert!(national.is_current());
        assert!(broker.snapshot().unwrap().lanes.national.active);
    }

    #[test]
    fn each_lane_owns_two_credits() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, TransferLane::Site, 1).unwrap();
        broker.begin(session, TransferLane::National, 2).unwrap();
        broker.acquire(session, TransferLane::Site, 1).unwrap();
        broker.acquire(session, TransferLane::Site, 1).unwrap();
        assert_eq!(
            broker
                .acquire(session, TransferLane::Site, 1)
                .unwrap_err()
                .code,
            "credit_exhausted"
        );
        broker.acquire(session, TransferLane::National, 2).unwrap();
        broker.acquire(session, TransferLane::National, 2).unwrap();
        assert_eq!(
            broker
                .acquire(session, TransferLane::National, 2)
                .unwrap_err()
                .code,
            "credit_exhausted"
        );
        let snapshot = broker.snapshot().unwrap();
        assert_eq!(snapshot.in_flight_credits, 4);
        assert_eq!(snapshot.lanes.site.in_flight_credits, 2);
        assert_eq!(snapshot.lanes.national.in_flight_credits, 2);
    }

    #[test]
    fn generations_stay_unique_across_lanes() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, TransferLane::Site, 5).unwrap();
        for generation in [4, 5] {
            assert_eq!(
                broker
                    .begin(session, TransferLane::National, generation)
                    .unwrap_err()
                    .code,
                "stale_generation"
            );
        }
        // A stale-lane generation is rejected even though it was current elsewhere.
        assert_eq!(
            broker
                .acquire(session, TransferLane::National, 5)
                .unwrap_err()
                .code,
            "stale_generation"
        );
    }

    #[test]
    fn release_returns_the_credit_to_the_lane_that_delivered_it() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, TransferLane::Site, 1).unwrap();
        broker.begin(session, TransferLane::National, 2).unwrap();
        for (lane, generation) in [(TransferLane::Site, 1), (TransferLane::National, 2)] {
            broker.acquire(session, lane, generation).unwrap();
            broker
                .complete_for_publish(session, lane, generation)
                .unwrap();
        }
        broker.release(session, 2, &release_id(1)).unwrap();
        let snapshot = broker.snapshot().unwrap();
        assert_eq!(snapshot.lanes.national.held_credits, 0);
        assert_eq!(snapshot.lanes.site.held_credits, 1);
        broker.release(session, 1, &release_id(2)).unwrap();
        assert_eq!(broker.snapshot().unwrap().held_credits, 0);
    }

    #[test]
    fn national_begin_keeps_site_live_evidence() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, TransferLane::Site, 1).unwrap();
        broker.acquire(session, TransferLane::Site, 1).unwrap();
        InFlightCreditGuard::new(broker.clone(), session, TransferLane::Site)
            .complete_phase5_for_publish(1, phase5_evidence(1, &"a".repeat(32)))
            .unwrap();
        broker.begin(session, TransferLane::National, 2).unwrap();
        assert!(
            broker
                .phase5_live_evidence(session, 1, &"a".repeat(32))
                .is_ok()
        );
    }

    #[test]
    fn opening_a_session_resets_both_lanes() {
        let broker = TransferBroker::default();
        let first = opened(&broker);
        broker.begin(first, TransferLane::Site, 1).unwrap();
        broker.begin(first, TransferLane::National, 2).unwrap();
        let national = broker
            .live_generation_token(first, TransferLane::National, 2)
            .unwrap();
        let second = opened(&broker);
        assert!(!national.is_current());
        let snapshot = broker.snapshot().unwrap();
        assert_eq!(snapshot.session, second);
        for lane in [snapshot.lanes.site, snapshot.lanes.national] {
            assert_eq!((lane.generation, lane.active), (0, false));
        }
        broker.begin(second, TransferLane::National, 1).unwrap();
    }

    #[test]
    fn phase5_generation_control_cancels_superseded_and_explicitly_cancelled_tokens() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, TransferLane::Site, 4).unwrap();
        let old = broker
            .live_generation_token(session, TransferLane::Site, 4)
            .unwrap();
        broker.begin(session, TransferLane::Site, 8).unwrap();
        assert!(!old.is_current());
        let current = broker
            .live_generation_token(session, TransferLane::Site, 8)
            .unwrap();
        assert!(current.is_current());
        broker.cancel(session, TransferLane::Site, 8).unwrap();
        assert!(!current.is_current());
        assert_eq!(
            broker
                .live_generation_token(session, TransferLane::Site, 8)
                .unwrap_err()
                .code,
            "generation_cancelled"
        );
    }

    #[test]
    fn phase5_evidence_is_published_atomically_only_for_the_current_generation() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, TransferLane::Site, 1).unwrap();
        broker.acquire(session, TransferLane::Site, 1).unwrap();
        InFlightCreditGuard::new(broker.clone(), session, TransferLane::Site)
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
        broker.acquire(session, TransferLane::Site, 1).unwrap();
        let stale = InFlightCreditGuard::new(broker.clone(), session, TransferLane::Site);
        broker.begin(session, TransferLane::Site, 2).unwrap();
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
        broker.begin(session, TransferLane::Site, 1).unwrap();
        broker.acquire(session, TransferLane::Site, 1).unwrap();
        let first = InFlightCreditGuard::new(broker.clone(), session, TransferLane::Site);
        broker.acquire(session, TransferLane::Site, 1).unwrap();
        let second = InFlightCreditGuard::new(broker.clone(), session, TransferLane::Site);

        first
            .complete_phase5_for_publish(1, phase5_evidence(1, &"a".repeat(32)))
            .unwrap();
        let after_first = broker.snapshot().unwrap();
        assert_eq!(after_first.held_credits, 1);
        assert_eq!(after_first.in_flight_credits, 1);
        assert_eq!(after_first.lanes.site.available_credits, 0);

        drop(second);
        let after_second = broker.snapshot().unwrap();
        assert_eq!(after_second.held_credits, 1);
        assert_eq!(after_second.in_flight_credits, 0);
        assert_eq!(after_second.lanes.site.available_credits, 1);
    }

    #[test]
    fn live_sweep_wait_defaults_to_the_complete_timeout_and_bounds_a_probe() {
        assert_eq!(
            live_sweep_wait(180, None).unwrap(),
            Duration::from_secs(180)
        );
        assert_eq!(
            live_sweep_wait(60, Some(3)).unwrap(),
            Duration::from_secs(3)
        );
        assert_eq!(
            live_sweep_wait(60, Some(0)).unwrap_err().code,
            "invalid_live_wait"
        );
        assert_eq!(
            live_sweep_wait(60, Some(61)).unwrap_err().code,
            "invalid_live_wait"
        );
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
        broker.begin(session, TransferLane::Site, 1).unwrap();
        broker.acquire(session, TransferLane::Site, 1).unwrap();
        let credit = InFlightCreditGuard::new(broker.clone(), session, TransferLane::Site);
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
        assert_eq!(timed_out.lanes.site.available_credits, 1);

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
        assert_eq!(broker.snapshot().unwrap().lanes.site.available_credits, 2);
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
    fn installers_bundle_no_radar_archives() {
        // Startup paints current radar; the archive loop is diagnostics only
        // and is read from a repository checkout.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(config["bundle"].get("resources").is_none());
    }

    #[test]
    fn a_loop_scan_missing_from_an_install_reports_not_bundled() {
        let manifest = fixture_manifest().unwrap();
        let fixture_id = &manifest.fixture_sets.get(PHASE4_FIXTURE_SET).unwrap()[0];
        let fixture = phase4_fixture_expectation_in(&manifest, fixture_id).unwrap();
        let root = std::env::temp_dir().join(format!("mistr-not-bundled-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let error = phase4_fixture_path(&fixture, &root).unwrap_err();
        assert_eq!(error.code, "fixture_not_bundled");
        let bundled = root.join("fixtures").join(&fixture.local_path);
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"scan").unwrap();
        assert_eq!(phase4_fixture_path(&fixture, &root).unwrap(), bundled);
        std::fs::remove_dir_all(&root).unwrap();
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
        assert_eq!(
            broker
                .begin(session, TransferLane::Site, 1)
                .unwrap()
                .lanes
                .site
                .available_credits,
            2
        );
        broker.acquire(session, TransferLane::Site, 1).unwrap();
        broker.acquire(session, TransferLane::Site, 1).unwrap();
        assert_eq!(broker.snapshot().unwrap().in_flight_credits, 2);
        assert_eq!(
            broker
                .acquire(session, TransferLane::Site, 1)
                .unwrap_err()
                .code,
            "credit_exhausted"
        );
        broker
            .complete_for_publish(session, TransferLane::Site, 1)
            .unwrap();
        assert_eq!(
            broker
                .release(session, 1, &release_id(1))
                .unwrap()
                .lanes
                .site
                .available_credits,
            1
        );
        broker.acquire(session, TransferLane::Site, 1).unwrap();
    }

    #[test]
    fn new_generation_keeps_old_work_globally_charged_until_completion() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, TransferLane::Site, 8).unwrap();
        broker.acquire(session, TransferLane::Site, 8).unwrap();
        broker.acquire(session, TransferLane::Site, 8).unwrap();
        let current = broker.begin(session, TransferLane::Site, 9).unwrap();
        assert_eq!(current.lanes.site.available_credits, 0);
        assert_eq!(current.held_credits, 0);
        assert_eq!(current.in_flight_credits, 2);
        assert_eq!(
            broker
                .acquire(session, TransferLane::Site, 9)
                .unwrap_err()
                .code,
            "credit_exhausted"
        );
        assert_eq!(
            broker
                .complete_for_publish(session, TransferLane::Site, 8)
                .unwrap_err()
                .code,
            "stale_generation"
        );
        assert_eq!(broker.snapshot().unwrap().lanes.site.available_credits, 1);
        broker.finish_without_publish(session, TransferLane::Site);
        assert_eq!(broker.snapshot().unwrap().lanes.site.available_credits, 2);
    }

    #[test]
    fn delivered_old_generation_stays_charged_until_frontend_acknowledges_it() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, TransferLane::Site, 8).unwrap();
        broker.acquire(session, TransferLane::Site, 8).unwrap();
        broker
            .complete_for_publish(session, TransferLane::Site, 8)
            .unwrap();

        let current = broker.begin(session, TransferLane::Site, 9).unwrap();
        assert_eq!(current.held_credits, 1);
        assert_eq!(current.lanes.site.available_credits, 1);
        broker.acquire(session, TransferLane::Site, 9).unwrap();
        assert_eq!(
            broker
                .acquire(session, TransferLane::Site, 9)
                .unwrap_err()
                .code,
            "credit_exhausted"
        );

        let after_old_ack = broker.release(session, 8, &release_id(1)).unwrap();
        assert_eq!(after_old_ack.held_credits, 0);
        assert_eq!(after_old_ack.in_flight_credits, 1);
        assert_eq!(after_old_ack.lanes.site.available_credits, 1);
        broker
            .complete_for_publish(session, TransferLane::Site, 9)
            .unwrap();
        assert_eq!(
            broker
                .release(session, 9, &release_id(2))
                .unwrap()
                .lanes
                .site
                .available_credits,
            2
        );
    }

    #[test]
    fn new_session_reclaims_orphaned_delivery_but_not_native_work() {
        let broker = TransferBroker::default();
        let first = opened(&broker);
        broker.begin(first, TransferLane::Site, 1).unwrap();
        broker.acquire(first, TransferLane::Site, 1).unwrap();
        broker
            .complete_for_publish(first, TransferLane::Site, 1)
            .unwrap();
        broker.acquire(first, TransferLane::Site, 1).unwrap();

        broker.document_started().unwrap();
        let second = opened(&broker);
        let opened = broker.snapshot().unwrap();
        assert_eq!(second, first + 1);
        assert_eq!(opened.held_credits, 0);
        assert_eq!(opened.in_flight_credits, 1);
        assert!(!opened.lanes.site.active && !opened.lanes.national.active);
        broker.begin(second, TransferLane::Site, 1).unwrap();
        assert_eq!(broker.snapshot().unwrap().lanes.site.available_credits, 1);
        assert_eq!(
            broker
                .complete_for_publish(first, TransferLane::Site, 1)
                .unwrap_err()
                .code,
            "stale_session"
        );
        assert_eq!(broker.snapshot().unwrap().lanes.site.available_credits, 2);
    }

    #[test]
    fn second_client_in_same_document_cannot_reclaim_live_credit() {
        let broker = TransferBroker::default();
        let first = opened(&broker);
        broker.begin(first, TransferLane::Site, 1).unwrap();
        broker.acquire(first, TransferLane::Site, 1).unwrap();
        broker
            .complete_for_publish(first, TransferLane::Site, 1)
            .unwrap();

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
        broker.begin(session, TransferLane::Site, 1).unwrap();
        broker.acquire(session, TransferLane::Site, 1).unwrap();
        broker
            .complete_for_publish(session, TransferLane::Site, 1)
            .unwrap();
        let id = release_id(1);
        assert_eq!(
            broker
                .release(session, 1, &id)
                .unwrap()
                .lanes
                .site
                .available_credits,
            2
        );
        assert_eq!(
            broker
                .release(session, 1, &id)
                .unwrap()
                .lanes
                .site
                .available_credits,
            2
        );
    }

    #[test]
    fn old_release_retry_cannot_release_a_newer_credit() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, TransferLane::Site, 1).unwrap();

        for index in 1..=66 {
            broker.acquire(session, TransferLane::Site, 1).unwrap();
            broker
                .complete_for_publish(session, TransferLane::Site, 1)
                .unwrap();
            broker.release(session, 1, &release_id(index)).unwrap();
        }

        broker.acquire(session, TransferLane::Site, 1).unwrap();
        broker
            .complete_for_publish(session, TransferLane::Site, 1)
            .unwrap();
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
        broker.begin(session, TransferLane::Site, 3).unwrap();
        broker.acquire(session, TransferLane::Site, 3).unwrap();
        let cancelled = broker.cancel(session, TransferLane::Site, 3).unwrap();
        assert!(!cancelled.lanes.site.active);
        assert_eq!(cancelled.lanes.site.available_credits, 0);
        assert_eq!(cancelled.held_credits, 0);
        assert_eq!(
            broker
                .complete_for_publish(session, TransferLane::Site, 3)
                .unwrap_err()
                .code,
            "generation_cancelled"
        );
        assert_eq!(broker.snapshot().unwrap().in_flight_credits, 0);
    }

    #[test]
    fn generations_are_monotonic() {
        let broker = TransferBroker::default();
        let session = opened(&broker);
        broker.begin(session, TransferLane::Site, 4).unwrap();
        assert_eq!(
            broker
                .begin(session, TransferLane::Site, 4)
                .unwrap_err()
                .code,
            "stale_generation"
        );
        assert_eq!(
            broker
                .begin(session, TransferLane::Site, 2)
                .unwrap_err()
                .code,
            "stale_generation"
        );
    }
}
