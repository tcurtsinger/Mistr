use crate::packed_sweep::{
    PackedSweepIdentity, PackedSweepSummary, encode_packed_sweep, phase2_benchmark_sweep,
    validate_packed_sweep,
};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Response;

pub const TRANSFER_CREDIT_LIMIT: u8 = 2;
const MAX_BENCHMARK_ITERATIONS: u8 = 20;
const MAX_DIAGNOSTIC_HOLD_MS: u64 = 2_000;

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
    pub generation: u64,
    pub active: bool,
    pub available_credits: u8,
    pub held_credits: u8,
    pub credit_limit: u8,
}

#[derive(Debug, Default)]
struct TransferState {
    generation: u64,
    active: bool,
    available_credits: u8,
    held_credits: u8,
}

#[derive(Debug, Clone, Default)]
pub struct TransferBroker {
    inner: Arc<Mutex<TransferState>>,
}

impl TransferBroker {
    fn begin(&self, generation: u64) -> Result<TransferSnapshot, TransferError> {
        if generation == 0 {
            return Err(TransferError::new(
                "invalid_generation",
                "generation must be greater than zero",
            ));
        }
        let mut state = self.lock()?;
        if generation <= state.generation {
            return Err(TransferError::new(
                "stale_generation",
                format!(
                    "generation {generation} is not newer than {}",
                    state.generation
                ),
            ));
        }
        *state = TransferState {
            generation,
            active: true,
            available_credits: TRANSFER_CREDIT_LIMIT,
            held_credits: 0,
        };
        Ok(snapshot(&state))
    }

    fn cancel(&self, generation: u64) -> Result<TransferSnapshot, TransferError> {
        let mut state = self.lock()?;
        ensure_current(&state, generation)?;
        state.active = false;
        state.available_credits = 0;
        state.held_credits = 0;
        Ok(snapshot(&state))
    }

    fn acquire(&self, generation: u64) -> Result<(), TransferError> {
        let mut state = self.lock()?;
        ensure_current(&state, generation)?;
        if !state.active {
            return Err(TransferError::new(
                "generation_cancelled",
                format!("generation {generation} is cancelled"),
            ));
        }
        if state.available_credits == 0 {
            return Err(TransferError::new(
                "credit_exhausted",
                "both renderer transfer credits are already held",
            ));
        }
        state.available_credits -= 1;
        state.held_credits += 1;
        Ok(())
    }

    fn release(&self, generation: u64) -> Result<TransferSnapshot, TransferError> {
        let mut state = self.lock()?;
        ensure_current(&state, generation)?;
        if !state.active {
            return Err(TransferError::new(
                "generation_cancelled",
                format!("generation {generation} is cancelled"),
            ));
        }
        if state.held_credits == 0 {
            return Err(TransferError::new(
                "credit_not_held",
                "no transfer credit is held",
            ));
        }
        state.held_credits -= 1;
        state.available_credits += 1;
        Ok(snapshot(&state))
    }

    fn restore_after_failure(&self, generation: u64) {
        if let Ok(mut state) = self.inner.lock()
            && state.generation == generation
            && state.active
            && state.held_credits > 0
        {
            state.held_credits -= 1;
            state.available_credits += 1;
        }
    }

    fn can_publish(&self, generation: u64) -> Result<(), TransferError> {
        let state = self.lock()?;
        ensure_current(&state, generation)?;
        if !state.active {
            return Err(TransferError::new(
                "generation_cancelled",
                format!("generation {generation} is cancelled"),
            ));
        }
        Ok(())
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

fn ensure_current(state: &TransferState, generation: u64) -> Result<(), TransferError> {
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
    TransferSnapshot {
        generation: state.generation,
        active: state.active,
        available_credits: state.available_credits,
        held_credits: state.held_credits,
        credit_limit: TRANSFER_CREDIT_LIMIT,
    }
}

#[tauri::command]
pub fn begin_phase2_generation(
    state: tauri::State<'_, TransferBroker>,
    generation: u64,
) -> Result<TransferSnapshot, TransferError> {
    state.begin(generation)
}

#[tauri::command]
pub fn cancel_phase2_generation(
    state: tauri::State<'_, TransferBroker>,
    generation: u64,
) -> Result<TransferSnapshot, TransferError> {
    state.cancel(generation)
}

#[tauri::command]
pub fn release_phase2_transfer_credit(
    state: tauri::State<'_, TransferBroker>,
    generation: u64,
) -> Result<TransferSnapshot, TransferError> {
    state.release(generation)
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
    generation: u64,
    hold_ms: Option<u64>,
) -> Result<Response, TransferError> {
    let broker = state.inner().clone();
    broker.acquire(generation)?;
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
            broker.restore_after_failure(generation);
            return Err(TransferError::new("backend_task_failed", error.to_string()));
        }
    };

    let bytes = match encoded {
        Ok(bytes) => bytes,
        Err(error) => {
            broker.restore_after_failure(generation);
            return Err(error);
        }
    };
    if let Err(error) = broker.can_publish(generation) {
        broker.restore_after_failure(generation);
        return Err(error);
    }
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

    #[test]
    fn exactly_two_credits_are_available() {
        let broker = TransferBroker::default();
        assert_eq!(broker.begin(1).unwrap().available_credits, 2);
        broker.acquire(1).unwrap();
        broker.acquire(1).unwrap();
        assert_eq!(broker.snapshot().unwrap().held_credits, 2);
        assert_eq!(broker.acquire(1).unwrap_err().code, "credit_exhausted");
        assert_eq!(broker.release(1).unwrap().available_credits, 1);
        broker.acquire(1).unwrap();
    }

    #[test]
    fn new_generation_invalidates_old_publication_and_credits() {
        let broker = TransferBroker::default();
        broker.begin(8).unwrap();
        broker.acquire(8).unwrap();
        let current = broker.begin(9).unwrap();
        assert_eq!(current.available_credits, 2);
        assert_eq!(current.held_credits, 0);
        assert_eq!(broker.can_publish(8).unwrap_err().code, "stale_generation");
        assert_eq!(broker.release(8).unwrap_err().code, "stale_generation");
    }

    #[test]
    fn cancellation_prevents_publication() {
        let broker = TransferBroker::default();
        broker.begin(3).unwrap();
        broker.acquire(3).unwrap();
        let cancelled = broker.cancel(3).unwrap();
        assert!(!cancelled.active);
        assert_eq!(cancelled.available_credits, 0);
        assert_eq!(cancelled.held_credits, 0);
        assert_eq!(
            broker.can_publish(3).unwrap_err().code,
            "generation_cancelled"
        );
    }

    #[test]
    fn generations_are_monotonic() {
        let broker = TransferBroker::default();
        broker.begin(4).unwrap();
        assert_eq!(broker.begin(4).unwrap_err().code, "stale_generation");
        assert_eq!(broker.begin(2).unwrap_err().code, "stale_generation");
    }
}
