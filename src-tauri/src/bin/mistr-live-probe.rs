use chrono::{DateTime, Utc};
use mistr_lib::acquisition::PublicRadarClient;
use mistr_lib::live_pipeline::{GenerationClock, LiveSweepSession};
use serde::Serialize;
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::sync::Mutex;

const PROVIDER_POLL_INTERVAL: Duration = Duration::from_secs(5);
const ARCHIVE_WAIT: Duration = Duration::from_secs(60);

#[derive(Debug)]
struct Args {
    site: String,
    fresh_only: bool,
    safe_only: bool,
    timeout: Duration,
    output: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeReport {
    schema_version: u8,
    captured_at_utc: String,
    site: String,
    fresh_only: bool,
    safe: mistr_lib::live_pipeline::SafeSweepEvidence,
    sweep: SweepReport,
    complete: Option<mistr_lib::live_pipeline::CompleteVolumeEvidence>,
    provider: ProviderReport,
    acquisition_totals: mistr_lib::acquisition::AcquisitionCounters,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SweepReport {
    vcp: u16,
    elevation_number: u8,
    elevation_degrees: f32,
    radial_count: usize,
    gate_count: usize,
    valid_gate_count: usize,
    below_threshold_gate_count: usize,
    sweep_started_at_utc: String,
    sweep_ended_at_utc: String,
    normalized_sha256: String,
    raw_codes_sha256: String,
    gate_status_sha256: String,
    azimuth_sha256: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderReport {
    noaa_first_seen_at_utc: Option<String>,
    iem_first_seen_at_utc: Option<String>,
    archive_last_modified_at_utc: Option<String>,
    archive_first_seen_at_utc: Option<String>,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("mistr-live-probe: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let args = parse_args(env::args().skip(1))?;
    let client = PublicRadarClient::new().map_err(|error| error.to_string())?;
    let comparator_client = PublicRadarClient::new().map_err(|error| error.to_string())?;
    let clock = GenerationClock::default();
    let token = clock.begin(1).map_err(|error| error.to_string())?;

    let provider_stop = Arc::new(AtomicBool::new(false));
    let noaa_seen = Arc::new(Mutex::new(BTreeMap::<i64, i64>::new()));
    let iem_seen = Arc::new(Mutex::new(BTreeMap::<i64, i64>::new()));
    let noaa_task = tokio::spawn(watch_noaa(
        comparator_client.clone(),
        args.site.clone(),
        provider_stop.clone(),
        noaa_seen.clone(),
    ));
    let iem_task = tokio::spawn(watch_iem(
        comparator_client.clone(),
        args.site.clone(),
        provider_stop.clone(),
        iem_seen.clone(),
    ));

    let mut session = LiveSweepSession::start(client.clone(), token, &args.site, args.fresh_only)
        .await
        .map_err(|error| error.to_string())?;
    eprintln!(
        "waiting for {} volume {} safe lowest sweep",
        session.site(),
        session.target_volume_index()
    );
    let safe = session
        .wait_for_safe_sweep(args.timeout)
        .await
        .map_err(|error| error.to_string())?;
    eprintln!(
        "safe sweep: volume {} sequence {} VCP {} {} radials",
        safe.evidence.volume_index,
        safe.evidence.safe_sequence,
        safe.output.sweep.vcp,
        safe.output.sweep.radial_count()
    );

    let complete = if args.safe_only {
        None
    } else {
        Some(
            session
                .wait_for_complete_volume(args.timeout)
                .await
                .map_err(|error| error.to_string())?,
        )
    };

    let (archive, archive_first_seen) = if complete.is_some() {
        wait_for_archive(
            &comparator_client,
            &args.site,
            safe.evidence.volume_started_at_unix_ms,
            ARCHIVE_WAIT,
        )
        .await?
    } else {
        (Vec::new(), None)
    };
    provider_stop.store(true, Ordering::SeqCst);
    let _ = tokio::time::timeout(Duration::from_secs(5), noaa_task).await;
    let _ = tokio::time::timeout(Duration::from_secs(5), iem_task).await;

    let measurement_second = safe.evidence.volume_started_at_unix_ms;
    let measurement_minute = measurement_second - measurement_second.rem_euclid(60_000);
    let provider = ProviderReport {
        noaa_first_seen_at_utc: noaa_seen
            .lock()
            .await
            .get(&measurement_second)
            .copied()
            .map(timestamp),
        iem_first_seen_at_utc: iem_seen
            .lock()
            .await
            .get(&measurement_minute)
            .copied()
            .map(timestamp),
        archive_last_modified_at_utc: archive
            .iter()
            .map(|object| object.last_modified_unix_ms)
            .min()
            .map(timestamp),
        archive_first_seen_at_utc: archive_first_seen.map(timestamp),
    };

    let sweep = &safe.output.sweep;
    let report = ProbeReport {
        schema_version: 1,
        captured_at_utc: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        site: args.site,
        fresh_only: args.fresh_only,
        safe: safe.evidence,
        sweep: SweepReport {
            vcp: sweep.vcp,
            elevation_number: sweep.elevation_number,
            elevation_degrees: sweep.elevation_degrees,
            radial_count: sweep.radial_count(),
            gate_count: sweep.gate_count,
            valid_gate_count: sweep
                .statuses
                .iter()
                .filter(|status| matches!(status, mistr_lib::radar::GateStatus::Valid))
                .count(),
            below_threshold_gate_count: sweep
                .statuses
                .iter()
                .filter(|status| matches!(status, mistr_lib::radar::GateStatus::BelowThreshold))
                .count(),
            sweep_started_at_utc: timestamp(sweep.sweep_started_at_unix_ms),
            sweep_ended_at_utc: timestamp(sweep.sweep_ended_at_unix_ms),
            normalized_sha256: sweep.normalized_sha256(),
            raw_codes_sha256: sweep.raw_codes_sha256(),
            gate_status_sha256: sweep.gate_status_sha256(),
            azimuth_sha256: sweep.azimuth_sha256(),
        },
        complete: complete.map(|candidate| candidate.evidence),
        provider,
        acquisition_totals: client.counters(),
    };
    let json = serde_json::to_string_pretty(&report)
        .map_err(|error| format!("cannot serialize probe report: {error}"))?
        + "\n";
    if let Some(path) = args.output {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
        }
        fs::write(&path, &json)
            .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
        eprintln!("wrote {}", path.display());
    }
    print!("{json}");
    Ok(())
}

async fn watch_noaa(
    client: PublicRadarClient,
    site: String,
    stop: Arc<AtomicBool>,
    seen: Arc<Mutex<BTreeMap<i64, i64>>>,
) {
    while !stop.load(Ordering::SeqCst) {
        if let Ok(times) = client.noaa_reflectivity_times(&site).await {
            let observed = Utc::now().timestamp_millis();
            let mut map = seen.lock().await;
            for time in times {
                map.entry(time).or_insert(observed);
            }
        }
        tokio::time::sleep(PROVIDER_POLL_INTERVAL).await;
    }
}

async fn watch_iem(
    client: PublicRadarClient,
    site: String,
    stop: Arc<AtomicBool>,
    seen: Arc<Mutex<BTreeMap<i64, i64>>>,
) {
    while !stop.load(Ordering::SeqCst) {
        let now = Utc::now().timestamp_millis();
        if let Ok(times) = client
            .iem_reflectivity_times(&site, now - 3_600_000, now + 60_000)
            .await
        {
            let observed = Utc::now().timestamp_millis();
            let mut map = seen.lock().await;
            for time in times {
                map.entry(time).or_insert(observed);
            }
        }
        tokio::time::sleep(PROVIDER_POLL_INTERVAL).await;
    }
}

async fn wait_for_archive(
    client: &PublicRadarClient,
    site: &str,
    volume_started_at_unix_ms: i64,
    timeout: Duration,
) -> Result<(Vec<mistr_lib::acquisition::S3ObjectMetadata>, Option<i64>), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let objects = client
            .list_archive_observation(site, volume_started_at_unix_ms)
            .await
            .map_err(|error| error.to_string())?;
        if !objects.is_empty() {
            return Ok((objects, Some(Utc::now().timestamp_millis())));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok((Vec::new(), None));
        }
        tokio::time::sleep(PROVIDER_POLL_INTERVAL).await;
    }
}

fn timestamp(unix_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(unix_ms)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| format!("invalid:{unix_ms}"))
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut parsed = Args {
        site: "KTLX".into(),
        fresh_only: false,
        safe_only: false,
        timeout: Duration::from_secs(900),
        output: None,
    };
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--site" => parsed.site = required_value(&mut args, "--site")?,
            "--fresh" => parsed.fresh_only = true,
            "--safe-only" => parsed.safe_only = true,
            "--timeout-seconds" => {
                let value = required_value(&mut args, "--timeout-seconds")?
                    .parse::<u64>()
                    .map_err(|_| "--timeout-seconds must be an integer".to_string())?;
                if !(10..=3_600).contains(&value) {
                    return Err("--timeout-seconds must be in 10..=3600".into());
                }
                parsed.timeout = Duration::from_secs(value);
            }
            "--output" => parsed.output = Some(required_value(&mut args, "--output")?.into()),
            "--help" | "-h" => {
                return Err(
                    "usage: mistr-live-probe [--site KTLX] [--fresh] [--safe-only] [--timeout-seconds 900] [--output report.json]"
                        .into(),
                );
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    if parsed.site.len() != 4
        || !parsed
            .site
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return Err("--site must be exactly four uppercase ASCII letters/digits".into());
    }
    Ok(parsed)
}

fn required_value(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("{name} requires a value"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(values: &[&str]) -> Result<Args, String> {
        parse_args(values.iter().map(|value| (*value).to_string()))
    }

    #[test]
    fn arguments_are_bounded_and_site_is_canonical() {
        let parsed = parse(&["--site", "KTLX", "--fresh", "--timeout-seconds", "60"])
            .expect("valid arguments");
        assert_eq!(parsed.site, "KTLX");
        assert!(parsed.fresh_only);
        assert_eq!(parsed.timeout, Duration::from_secs(60));
        assert!(parse(&["--site", "ktlx"]).is_err());
        assert!(parse(&["--timeout-seconds", "9"]).is_err());
        assert!(parse(&["--timeout-seconds", "3601"]).is_err());
    }

    #[test]
    fn unknown_arguments_and_missing_values_fail_closed() {
        assert!(parse(&["--output"]).is_err());
        assert!(parse(&["--unknown"]).is_err());
    }
}
