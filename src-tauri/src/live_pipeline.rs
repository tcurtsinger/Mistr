//! Cancellable live Level II polling built on the bounded acquisition and
//! chunk-assembly boundaries.

use crate::acquisition::{AcquisitionCounters, AcquisitionError, PublicRadarClient};
use crate::chunk_assembly::{ChunkAssembler, ChunkAssemblyError, ChunkIngestOutcome};
use crate::radar::{DecodeError, DecodeOutput, RadarProduct, decode_safe_lowest_sweep};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use thiserror::Error;
use tokio::time::{Instant, sleep};

const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Default)]
pub struct GenerationClock {
    current: Arc<AtomicU64>,
}

impl GenerationClock {
    pub fn begin(&self, generation: u64) -> Result<GenerationToken, LivePipelineError> {
        if generation == 0 {
            return Err(LivePipelineError::InvalidGeneration);
        }
        let previous = self.current.swap(generation, Ordering::SeqCst);
        if generation <= previous {
            self.current.store(previous, Ordering::SeqCst);
            return Err(LivePipelineError::StaleGeneration {
                actual: generation,
                expected: previous.saturating_add(1),
            });
        }
        Ok(GenerationToken {
            generation,
            current: self.current.clone(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct GenerationToken {
    generation: u64,
    current: Arc<AtomicU64>,
}

impl GenerationToken {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn is_current(&self) -> bool {
        self.current.load(Ordering::SeqCst) == self.generation
    }

    pub fn cancel(&self) {
        let _ = self.current.compare_exchange(
            self.generation,
            self.generation.saturating_add(1),
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    }

    pub(crate) fn ensure_current(&self) -> Result<(), LivePipelineError> {
        let current = self.current.load(Ordering::SeqCst);
        if current != self.generation {
            return Err(LivePipelineError::StaleGeneration {
                actual: self.generation,
                expected: current,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum LivePipelineError {
    #[error("generation must be greater than zero")]
    InvalidGeneration,
    #[error("generation {actual} is stale; active generation is {expected}")]
    StaleGeneration { actual: u64, expected: u64 },
    #[error("live acquisition timed out at stage {stage}")]
    Timeout { stage: &'static str },
    #[error("live acquisition failed: {0}")]
    Acquisition(String),
    #[error("live chunk assembly failed: {0}")]
    Assembly(String),
    #[error("live Level II decode failed: {0}")]
    Decode(String),
    #[error("blocking decoder task failed: {0}")]
    DecodeTask(String),
    #[error("latest real-time volume listing contains no valid chunks")]
    EmptyLatestVolume,
    #[error("live history cursor requires a volume index from 1 to 999 and a positive start time")]
    InvalidHistoryCursor,
}

impl From<AcquisitionError> for LivePipelineError {
    fn from(value: AcquisitionError) -> Self {
        Self::Acquisition(value.to_string())
    }
}

impl From<ChunkAssemblyError> for LivePipelineError {
    fn from(value: ChunkAssemblyError) -> Self {
        Self::Assembly(value.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeSweepEvidence {
    pub generation: u64,
    pub site: String,
    pub volume_index: u16,
    pub volume_started_at_unix_ms: i64,
    pub safe_sequence: u16,
    pub safe_chunk_last_modified_unix_ms: i64,
    pub discovered_at_unix_ms: i64,
    pub decode_started_at_unix_ms: i64,
    pub decode_completed_at_unix_ms: i64,
    pub decoder_attempts: u32,
    pub gap_observations: u32,
    pub duplicate_observations: u32,
    pub acquisition_delta: AcquisitionCounters,
}

#[derive(Debug, Clone)]
pub struct SafeSweepCandidate {
    pub output: DecodeOutput,
    pub evidence: SafeSweepEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteVolumeEvidence {
    pub volume_index: u16,
    pub terminal_sequence: u16,
    pub completed_chunk_last_modified_unix_ms: i64,
    pub discovered_at_unix_ms: i64,
    pub decode_completed_at_unix_ms: i64,
    pub safe_matches_complete: bool,
    pub raw_codes_match: bool,
    pub gate_statuses_match: bool,
    pub azimuths_match: bool,
}

#[derive(Debug, Clone)]
pub struct CompleteVolumeCandidate {
    pub output: DecodeOutput,
    pub evidence: CompleteVolumeEvidence,
}

#[derive(Debug)]
pub struct LiveSweepSession {
    client: PublicRadarClient,
    token: GenerationToken,
    site: String,
    target_volume_index: u16,
    volume_time_constraint: VolumeTimeConstraint,
    selected_started_at: Option<i64>,
    assembler: ChunkAssembler,
    downloaded_keys: BTreeSet<String>,
    poll_interval: Duration,
    decoder_attempts: u32,
    gap_observations: u32,
    duplicate_observations: u32,
    counters_at_start: AcquisitionCounters,
    safe_fingerprint: Option<SweepFingerprint>,
}

impl LiveSweepSession {
    pub async fn start(
        client: PublicRadarClient,
        token: GenerationToken,
        site: &str,
        fresh_only: bool,
    ) -> Result<Self, LivePipelineError> {
        token.ensure_current()?;
        let counters_at_start = client.counters();
        let latest_index = client.discover_latest_realtime_volume(site).await?;
        token.ensure_current()?;
        let latest_objects = client.list_realtime_volume(site, latest_index).await?;
        token.ensure_current()?;
        let latest_started = latest_objects
            .iter()
            .filter_map(|object| object.as_realtime_chunk(site).ok())
            .map(|chunk| chunk.volume_started_at_unix_ms)
            .max()
            .ok_or(LivePipelineError::EmptyLatestVolume)?;
        let target_volume_index = if fresh_only {
            next_volume_index(latest_index)
        } else {
            latest_index
        };
        Self::from_target(
            client,
            token,
            site,
            target_volume_index,
            if fresh_only {
                VolumeTimeConstraint::StrictlyAfter(latest_started)
            } else {
                VolumeTimeConstraint::Exact(latest_started)
            },
            (!fresh_only).then_some(latest_started),
            counters_at_start,
        )
    }

    pub async fn start_after(
        client: PublicRadarClient,
        token: GenerationToken,
        site: &str,
        volume_index: u16,
        volume_started_at_unix_ms: i64,
    ) -> Result<Self, LivePipelineError> {
        token.ensure_current()?;
        if !(1..=999).contains(&volume_index) || volume_started_at_unix_ms <= 0 {
            return Err(LivePipelineError::InvalidHistoryCursor);
        }
        let counters_at_start = client.counters();
        Self::from_target(
            client,
            token,
            site,
            next_volume_index(volume_index),
            VolumeTimeConstraint::StrictlyAfter(volume_started_at_unix_ms),
            None,
            counters_at_start,
        )
    }

    pub async fn start_before(
        client: PublicRadarClient,
        token: GenerationToken,
        site: &str,
        volume_index: u16,
        volume_started_at_unix_ms: i64,
    ) -> Result<Self, LivePipelineError> {
        token.ensure_current()?;
        if !(1..=999).contains(&volume_index) || volume_started_at_unix_ms <= 0 {
            return Err(LivePipelineError::InvalidHistoryCursor);
        }
        let counters_at_start = client.counters();
        Self::from_target(
            client,
            token,
            site,
            previous_volume_index(volume_index),
            VolumeTimeConstraint::StrictlyBefore(volume_started_at_unix_ms),
            None,
            counters_at_start,
        )
    }

    fn from_target(
        client: PublicRadarClient,
        token: GenerationToken,
        site: &str,
        target_volume_index: u16,
        volume_time_constraint: VolumeTimeConstraint,
        selected_started_at: Option<i64>,
        counters_at_start: AcquisitionCounters,
    ) -> Result<Self, LivePipelineError> {
        Ok(Self {
            client,
            token: token.clone(),
            site: site.into(),
            target_volume_index,
            volume_time_constraint,
            selected_started_at,
            assembler: ChunkAssembler::new(token.generation(), site)?,
            downloaded_keys: BTreeSet::new(),
            poll_interval: DEFAULT_POLL_INTERVAL,
            decoder_attempts: 0,
            gap_observations: 0,
            duplicate_observations: 0,
            counters_at_start,
            safe_fingerprint: None,
        })
    }

    #[cfg(test)]
    fn with_poll_interval(mut self, interval: Duration) -> Self {
        self.poll_interval = interval;
        self
    }

    pub fn site(&self) -> &str {
        &self.site
    }

    pub fn target_volume_index(&self) -> u16 {
        self.target_volume_index
    }

    pub async fn wait_for_safe_sweep(
        &mut self,
        timeout: Duration,
    ) -> Result<SafeSweepCandidate, LivePipelineError> {
        let deadline = Instant::now() + timeout;
        loop {
            self.token.ensure_current()?;
            if Instant::now() >= deadline {
                return Err(LivePipelineError::Timeout {
                    stage: "safe_lowest_sweep",
                });
            }
            if let Some(candidate) = self.poll_chunks_once(true).await? {
                return Ok(candidate);
            }
            sleep(
                self.poll_interval
                    .min(deadline.saturating_duration_since(Instant::now())),
            )
            .await;
        }
    }

    pub async fn wait_for_complete_volume(
        &mut self,
        timeout: Duration,
    ) -> Result<CompleteVolumeCandidate, LivePipelineError> {
        let deadline = Instant::now() + timeout;
        loop {
            self.token.ensure_current()?;
            if Instant::now() >= deadline {
                return Err(LivePipelineError::Timeout {
                    stage: "complete_volume",
                });
            }
            self.poll_chunks_once(false).await?;
            if self.assembler.is_complete() {
                let discovered_at_unix_ms = Utc::now().timestamp_millis();
                let bytes = self.assembler.assembled_complete()?;
                let terminal_sequence = self.assembler.contiguous_through();
                let completed_chunk_last_modified_unix_ms = self
                    .assembler
                    .latest_contiguous_last_modified_unix_ms()
                    .ok_or_else(|| {
                        LivePipelineError::Assembly(
                            "complete volume has no terminal last-modified timestamp".into(),
                        )
                    })?;
                let output = run_native_work("mistr-level2-complete-decode", move || {
                    decode_safe_lowest_sweep(&bytes, RadarProduct::Reflectivity)
                })
                .await?
                .map_err(|error| LivePipelineError::Decode(error.to_string()))?;
                if output.sweep.source_kind != "nexrad_level2_chunks" {
                    return Err(LivePipelineError::Decode(
                        "completed real-time volume lost chunk provenance".into(),
                    ));
                }
                self.token.ensure_current()?;
                let complete = SweepFingerprint::from_output(&output);
                let safe = self.safe_fingerprint.as_ref().ok_or_else(|| {
                    LivePipelineError::Assembly(
                        "complete-volume comparison requires a safe publication first".into(),
                    )
                })?;
                return Ok(CompleteVolumeCandidate {
                    evidence: CompleteVolumeEvidence {
                        volume_index: self.target_volume_index,
                        terminal_sequence,
                        completed_chunk_last_modified_unix_ms,
                        discovered_at_unix_ms,
                        decode_completed_at_unix_ms: Utc::now().timestamp_millis(),
                        safe_matches_complete: safe == &complete,
                        raw_codes_match: safe.raw_codes == complete.raw_codes,
                        gate_statuses_match: safe.gate_statuses == complete.gate_statuses,
                        azimuths_match: safe.azimuths == complete.azimuths,
                    },
                    output,
                });
            }
            sleep(
                self.poll_interval
                    .min(deadline.saturating_duration_since(Instant::now())),
            )
            .await;
        }
    }

    async fn poll_chunks_once(
        &mut self,
        attempt_safe_decode: bool,
    ) -> Result<Option<SafeSweepCandidate>, LivePipelineError> {
        self.token.ensure_current()?;
        let objects = self
            .client
            .list_realtime_volume(&self.site, self.target_volume_index)
            .await?;
        self.token.ensure_current()?;
        let mut candidates = objects
            .into_iter()
            .filter_map(|object| {
                let chunk = object.as_realtime_chunk(&self.site).ok()?;
                if !self
                    .volume_time_constraint
                    .accepts(chunk.volume_started_at_unix_ms)
                {
                    return None;
                }
                if let Some(selected) = self.selected_started_at
                    && chunk.volume_started_at_unix_ms != selected
                {
                    return None;
                }
                Some((chunk.sequence, object, chunk.volume_started_at_unix_ms))
            })
            .collect::<Vec<_>>();
        if self.selected_started_at.is_none()
            && let Some(started) = select_volume_start(
                self.volume_time_constraint,
                candidates.iter().map(|(_, _, started)| *started),
            )
        {
            self.selected_started_at = Some(started);
            candidates.retain(|(_, _, candidate)| *candidate == started);
        }
        candidates.sort_by_key(|(sequence, _, _)| *sequence);
        for (_, object, _) in candidates {
            if self.downloaded_keys.contains(&object.key) {
                continue;
            }
            let (metadata, bytes) = self
                .client
                .download_realtime_chunk(&object, &self.site)
                .await?;
            self.token.ensure_current()?;
            let previous_contiguous = self.assembler.contiguous_through();
            let outcome = self
                .assembler
                .ingest(self.token.generation(), metadata, bytes)?;
            self.downloaded_keys.insert(object.key);
            let contiguous_advanced = contiguous_prefix_advanced(previous_contiguous, &outcome);
            match outcome {
                ChunkIngestOutcome::Accepted {
                    waiting_for_sequence,
                    ..
                } => {
                    if waiting_for_sequence.is_some() {
                        self.gap_observations = self.gap_observations.saturating_add(1);
                    }
                }
                ChunkIngestOutcome::Duplicate { .. } => {
                    self.duplicate_observations = self.duplicate_observations.saturating_add(1);
                }
                ChunkIngestOutcome::Late { .. } => {}
                ChunkIngestOutcome::Rollover { .. } => {}
            }
            if attempt_safe_decode
                && contiguous_advanced
                && let Some(candidate) = self.try_safe_sweep().await?
            {
                // Do not download a later listed chunk after the earliest safe
                // contiguous boundary has produced publishable radar truth.
                return Ok(Some(candidate));
            }
        }
        if self.assembler.waiting_for_sequence().is_some() {
            self.gap_observations = self.gap_observations.saturating_add(1);
        }
        Ok(None)
    }

    async fn try_safe_sweep(&mut self) -> Result<Option<SafeSweepCandidate>, LivePipelineError> {
        if self.assembler.contiguous_through() == 0 {
            return Ok(None);
        }
        let bytes = self.assembler.assembled_contiguous()?;
        let decode_started_at_unix_ms = Utc::now().timestamp_millis();
        self.decoder_attempts = self.decoder_attempts.saturating_add(1);
        let decoded = run_native_work("mistr-level2-safe-decode", move || {
            decode_safe_lowest_sweep(&bytes, RadarProduct::Reflectivity)
        })
        .await?;
        let decode_completed_at_unix_ms = Utc::now().timestamp_millis();
        match decoded {
            Ok(output) => {
                self.token.ensure_current()?;
                let volume = self.assembler.active_volume().cloned().ok_or_else(|| {
                    LivePipelineError::Assembly(
                        "safe decode completed without an active volume".into(),
                    )
                })?;
                self.assembler.mark_safe_sweep_published()?;
                let fingerprint = SweepFingerprint::from_output(&output);
                self.safe_fingerprint = Some(fingerprint);
                Ok(Some(SafeSweepCandidate {
                    evidence: SafeSweepEvidence {
                        generation: self.token.generation(),
                        site: self.site.clone(),
                        volume_index: volume.volume_index,
                        volume_started_at_unix_ms: volume.started_at_unix_ms,
                        safe_sequence: self.assembler.contiguous_through(),
                        safe_chunk_last_modified_unix_ms: self
                            .assembler
                            .latest_contiguous_last_modified_unix_ms()
                            .ok_or_else(|| {
                                LivePipelineError::Assembly(
                                    "safe sequence has no last-modified timestamp".into(),
                                )
                            })?,
                        discovered_at_unix_ms: decode_started_at_unix_ms,
                        decode_started_at_unix_ms,
                        decode_completed_at_unix_ms,
                        decoder_attempts: self.decoder_attempts,
                        gap_observations: self.gap_observations,
                        duplicate_observations: self.duplicate_observations,
                        acquisition_delta: subtract_counters(
                            self.client.counters(),
                            self.counters_at_start,
                        ),
                    },
                    output,
                }))
            }
            Err(DecodeError::MissingProduct { .. }) | Err(DecodeError::IncompleteSweep(_)) => {
                Ok(None)
            }
            Err(error) => Err(LivePipelineError::Decode(error.to_string())),
        }
    }
}

fn contiguous_prefix_advanced(previous: u16, outcome: &ChunkIngestOutcome) -> bool {
    match outcome {
        ChunkIngestOutcome::Accepted {
            contiguous_through, ..
        } => *contiguous_through > previous,
        ChunkIngestOutcome::Rollover { .. } => true,
        ChunkIngestOutcome::Duplicate { .. } | ChunkIngestOutcome::Late { .. } => false,
    }
}

async fn run_native_work<T, F>(thread_name: &str, work: F) -> Result<T, LivePipelineError>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(move || {
            let _ = sender.send(work());
        })
        .map_err(|error| LivePipelineError::DecodeTask(error.to_string()))?;
    receiver.await.map_err(|_| {
        LivePipelineError::DecodeTask("native decoder stopped before returning a result".into())
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SweepFingerprint {
    raw_codes: String,
    gate_statuses: String,
    azimuths: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VolumeTimeConstraint {
    Exact(i64),
    StrictlyAfter(i64),
    StrictlyBefore(i64),
}

impl VolumeTimeConstraint {
    fn accepts(self, started_at_unix_ms: i64) -> bool {
        match self {
            Self::Exact(expected) => started_at_unix_ms == expected,
            Self::StrictlyAfter(boundary) => started_at_unix_ms > boundary,
            Self::StrictlyBefore(boundary) => started_at_unix_ms < boundary,
        }
    }
}

fn select_volume_start(
    constraint: VolumeTimeConstraint,
    candidates: impl IntoIterator<Item = i64>,
) -> Option<i64> {
    // A ring prefix should normally contain one measured volume. If provider
    // rollover briefly leaves more than one, choose the newest eligible start:
    // the current exact volume, the newest newer replacement for forward
    // compatibility, or the closest older predecessor for backfill.
    candidates
        .into_iter()
        .filter(|started| constraint.accepts(*started))
        .max()
}

impl SweepFingerprint {
    fn from_output(output: &DecodeOutput) -> Self {
        Self {
            raw_codes: output.sweep.raw_codes_sha256(),
            gate_statuses: output.sweep.gate_status_sha256(),
            azimuths: output.sweep.azimuth_sha256(),
        }
    }
}

fn next_volume_index(index: u16) -> u16 {
    if index == 999 { 1 } else { index + 1 }
}

fn previous_volume_index(index: u16) -> u16 {
    if index == 1 { 999 } else { index - 1 }
}

fn subtract_counters(
    after: AcquisitionCounters,
    before: AcquisitionCounters,
) -> AcquisitionCounters {
    AcquisitionCounters {
        network_requests: after
            .network_requests
            .saturating_sub(before.network_requests),
        response_bytes: after.response_bytes.saturating_sub(before.response_bytes),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_switch_invalidates_old_generation_before_publication() {
        let clock = GenerationClock::default();
        let old = clock.begin(1).unwrap();
        let current = clock.begin(2).unwrap();
        assert!(!old.is_current());
        assert!(current.is_current());
        assert!(matches!(
            old.ensure_current(),
            Err(LivePipelineError::StaleGeneration {
                actual: 1,
                expected: 2
            })
        ));
    }

    #[test]
    fn cancelled_token_cannot_become_current_again() {
        let clock = GenerationClock::default();
        let token = clock.begin(9).unwrap();
        token.cancel();
        assert!(!token.is_current());
        assert!(matches!(
            token.ensure_current(),
            Err(LivePipelineError::StaleGeneration { actual: 9, .. })
        ));
    }

    #[test]
    fn volume_index_wrap_is_explicit() {
        assert_eq!(next_volume_index(998), 999);
        assert_eq!(next_volume_index(999), 1);
        assert_eq!(previous_volume_index(2), 1);
        assert_eq!(previous_volume_index(1), 999);
    }

    #[tokio::test]
    async fn history_cursor_targets_the_exact_next_volume_without_latest_discovery() {
        let clock = GenerationClock::default();
        let token = clock.begin(7).unwrap();
        let session = LiveSweepSession::start_after(
            PublicRadarClient::new().unwrap(),
            token.clone(),
            "KTLX",
            999,
            1_800_000_000_000,
        )
        .await
        .unwrap();

        assert_eq!(session.target_volume_index, 1);
        assert_eq!(
            session.volume_time_constraint,
            VolumeTimeConstraint::StrictlyAfter(1_800_000_000_000)
        );
        assert!(session.selected_started_at.is_none());
        assert_eq!(
            LiveSweepSession::start_after(
                PublicRadarClient::new().unwrap(),
                token,
                "KTLX",
                0,
                1_800_000_000_000,
            )
            .await
            .unwrap_err(),
            LivePipelineError::InvalidHistoryCursor,
        );
    }

    #[tokio::test]
    async fn history_cursor_targets_the_exact_previous_volume_with_wrap() {
        let clock = GenerationClock::default();
        let token = clock.begin(11).unwrap();
        let session = LiveSweepSession::start_before(
            PublicRadarClient::new().unwrap(),
            token.clone(),
            "KEWX",
            1,
            1_800_000_000_000,
        )
        .await
        .unwrap();

        assert_eq!(session.target_volume_index, 999);
        assert_eq!(
            session.volume_time_constraint,
            VolumeTimeConstraint::StrictlyBefore(1_800_000_000_000)
        );
        assert!(session.selected_started_at.is_none());
        assert_eq!(
            LiveSweepSession::start_before(
                PublicRadarClient::new().unwrap(),
                token,
                "KEWX",
                1000,
                1_800_000_000_000,
            )
            .await
            .unwrap_err(),
            LivePipelineError::InvalidHistoryCursor,
        );
    }

    #[test]
    fn predecessor_selection_is_strictly_older_and_chooses_closest_start() {
        let boundary = 1_800_000_000_000;
        assert_eq!(
            select_volume_start(
                VolumeTimeConstraint::StrictlyBefore(boundary),
                [boundary - 10_000, boundary, boundary + 10_000, boundary - 1],
            ),
            Some(boundary - 1)
        );
        assert_eq!(
            select_volume_start(
                VolumeTimeConstraint::StrictlyBefore(boundary),
                [boundary, boundary + 1],
            ),
            None
        );
    }

    #[test]
    fn forward_and_exact_selection_retain_existing_time_semantics() {
        let boundary = 1_800_000_000_000;
        assert_eq!(
            select_volume_start(
                VolumeTimeConstraint::StrictlyAfter(boundary),
                [boundary - 1, boundary, boundary + 1, boundary + 2],
            ),
            Some(boundary + 2)
        );
        assert_eq!(
            select_volume_start(
                VolumeTimeConstraint::Exact(boundary),
                [boundary - 1, boundary, boundary + 1],
            ),
            Some(boundary)
        );
    }

    #[test]
    fn counter_delta_saturates_instead_of_underflowing() {
        assert_eq!(
            subtract_counters(
                AcquisitionCounters {
                    network_requests: 1,
                    response_bytes: 2,
                },
                AcquisitionCounters {
                    network_requests: 4,
                    response_bytes: 8,
                },
            ),
            AcquisitionCounters::default()
        );
    }

    #[test]
    fn safe_decode_trigger_tracks_each_contiguous_prefix_advance() {
        let volume = crate::chunk_assembly::VolumeIdentity {
            site: "KTLX".into(),
            volume_index: 7,
            started_at_unix_ms: 1_800_000_000_000,
        };
        let contiguous = ChunkIngestOutcome::Accepted {
            volume: volume.clone(),
            contiguous_through: 7,
            waiting_for_sequence: None,
            volume_complete: false,
        };
        let gap = ChunkIngestOutcome::Accepted {
            volume: volume.clone(),
            contiguous_through: 7,
            waiting_for_sequence: Some(8),
            volume_complete: false,
        };
        let duplicate = ChunkIngestOutcome::Duplicate {
            volume,
            sequence: 7,
        };
        assert!(contiguous_prefix_advanced(6, &contiguous));
        assert!(!contiguous_prefix_advanced(7, &gap));
        assert!(!contiguous_prefix_advanced(7, &duplicate));
    }

    #[tokio::test]
    async fn native_decode_wait_can_be_cancelled_without_owning_the_worker_thread() {
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let task = tokio::spawn(run_native_work("mistr-test-native-work", move || {
            let _ = started_sender.send(());
            let _ = release_receiver.recv();
        }));
        started_receiver.await.expect("native worker started");
        task.abort();
        let join_error = tokio::time::timeout(Duration::from_millis(50), task)
            .await
            .expect("cancelled waiter returns without waiting for native work")
            .expect_err("waiter is cancelled");
        assert!(join_error.is_cancelled());
        release_sender.send(()).expect("release native worker");
    }

    // Compile-time coverage for the test-only poll override without using the
    // public network in deterministic CI.
    #[test]
    fn poll_override_is_bounded_to_tests() {
        let clock = GenerationClock::default();
        let token = clock.begin(1).unwrap();
        let session = LiveSweepSession {
            client: PublicRadarClient::new().unwrap(),
            token,
            site: "KTLX".into(),
            target_volume_index: 1,
            volume_time_constraint: VolumeTimeConstraint::StrictlyAfter(0),
            selected_started_at: None,
            assembler: ChunkAssembler::new(1, "KTLX").unwrap(),
            downloaded_keys: BTreeSet::new(),
            poll_interval: DEFAULT_POLL_INTERVAL,
            decoder_attempts: 0,
            gap_observations: 0,
            duplicate_observations: 0,
            counters_at_start: AcquisitionCounters::default(),
            safe_fingerprint: None,
        }
        .with_poll_interval(Duration::from_millis(1));
        assert_eq!(session.poll_interval, Duration::from_millis(1));
    }
}
