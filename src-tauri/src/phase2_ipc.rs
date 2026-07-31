use crate::packed_sweep::{
    PackedSweepIdentity, PackedSweepSummary, encode_packed_sweep, phase2_benchmark_sweep,
    validate_packed_sweep,
};
use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Response;

pub const TRANSFER_CREDIT_LIMIT: u8 = 2;
const MAX_BENCHMARK_ITERATIONS: u8 = 20;
const MAX_DIAGNOSTIC_HOLD_MS: u64 = 2_000;
const MAX_RELEASE_ACKNOWLEDGEMENTS: usize = 64;

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
    session: u64,
    generation: u64,
    active: bool,
    held_credits_by_owner: BTreeMap<(u64, u64), u8>,
    acknowledged_release_ids: VecDeque<String>,
    in_flight_credits: u8,
}

#[derive(Debug, Clone, Default)]
pub struct TransferBroker {
    inner: Arc<Mutex<TransferState>>,
}

impl TransferBroker {
    fn open_session(&self) -> Result<TransferSnapshot, TransferError> {
        let mut state = self.lock()?;
        state.session = state.session.checked_add(1).ok_or_else(|| {
            TransferError::new("session_exhausted", "frontend session counter exhausted")
        })?;
        state.generation = 0;
        state.active = false;
        // A new WebView owner means prior delivered buffers can no longer be
        // acknowledged. In-flight native work remains globally charged.
        state.held_credits_by_owner.clear();
        state.acknowledged_release_ids.clear();
        Ok(snapshot(&state))
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
        state.generation = generation;
        state.active = true;
        Ok(snapshot(&state))
    }

    fn cancel(&self, session: u64, generation: u64) -> Result<TransferSnapshot, TransferError> {
        let mut state = self.lock()?;
        ensure_current(&state, session, generation)?;
        state.active = false;
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
        state.in_flight_credits += 1;
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
        if state
            .acknowledged_release_ids
            .iter()
            .any(|acknowledged| acknowledged == release_id)
        {
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
            .push_back(release_id.to_string());
        if state.acknowledged_release_ids.len() > MAX_RELEASE_ACKNOWLEDGEMENTS {
            state.acknowledged_release_ids.pop_front();
        }
        Ok(snapshot(&state))
    }

    fn finish_without_publish(&self) {
        if let Ok(mut state) = self.inner.lock()
            && state.in_flight_credits > 0
        {
            state.in_flight_credits -= 1;
        }
    }

    fn complete_for_publish(&self, session: u64, generation: u64) -> Result<(), TransferError> {
        let mut state = self.lock()?;
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
        if state.in_flight_credits == 0 {
            return Err(TransferError::new(
                "transfer_state_invalid",
                "completed work did not hold an in-flight credit",
            ));
        }
        state.in_flight_credits -= 1;
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

    fn snapshot(&self) -> Result<TransferSnapshot, TransferError> {
        let state = self.lock()?;
        Ok(snapshot(&state))
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

fn ensure_session(state: &TransferState, session: u64) -> Result<(), TransferError> {
    if session == 0 || session != state.session {
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
        in_flight_credits: state.in_flight_credits,
        credit_limit: TRANSFER_CREDIT_LIMIT,
    }
}

fn credits_in_use(state: &TransferState) -> u8 {
    held_credit_count(state).saturating_add(state.in_flight_credits)
}

fn held_credit_count(state: &TransferState) -> u8 {
    state
        .held_credits_by_owner
        .values()
        .copied()
        .fold(0, u8::saturating_add)
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
            broker.finish_without_publish();
            return Err(TransferError::new("backend_task_failed", error.to_string()));
        }
    };

    let bytes = match encoded {
        Ok(bytes) => bytes,
        Err(error) => {
            broker.finish_without_publish();
            return Err(error);
        }
    };
    broker.complete_for_publish(session, generation)?;
    Ok(Response::new(bytes))
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
            payload = Some(validate_packed_sweep(&bytes).map_err(|error| {
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
    })
    .await
    .map_err(|error| TransferError::new("backend_task_failed", error.to_string()))?
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

    fn opened(broker: &TransferBroker) -> u64 {
        broker.open_session().expect("open session").session
    }

    fn release_id(index: u8) -> String {
        format!("phase2-release-{index:02}")
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
        broker.finish_without_publish();
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
