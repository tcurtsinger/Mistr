use mistr_lib::packed_sweep::{
    PackedSweepIdentity, PackedSweepSummary, encode_packed_sweep, phase2_benchmark_sweep,
    phase2_golden_sweep, validate_packed_sweep,
};
use mistr_lib::radar::{MAX_LEVEL2_INPUT_BYTES, RadarProduct, decode_level2};
use serde::Serialize;
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("mistr-wire: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let arguments: Vec<_> = env::args().skip(1).collect();
    if arguments
        .iter()
        .any(|argument| matches!(argument.as_str(), "--help" | "-h"))
    {
        println!("{}", usage());
        return Ok(());
    }
    let options = Options::parse(arguments.into_iter())?;
    match options.mode {
        Mode::Golden => write_golden(&options),
        Mode::Benchmark => run_benchmark(&options),
        Mode::Archive => encode_archive(&options),
    }
}

fn write_golden(options: &Options) -> Result<(), String> {
    let bytes = encode_packed_sweep(
        &phase2_golden_sweep(),
        PackedSweepIdentity { generation: 7 },
    )
    .map_err(|error| format!("could not encode golden vector: {error}"))?;
    let summary = validate_packed_sweep(&bytes)
        .map_err(|error| format!("golden vector did not validate: {error}"))?;
    let output = options
        .output
        .as_deref()
        .ok_or_else(|| "--golden requires --output <path>".to_string())?;
    write_bytes(output, &bytes)?;
    write_json(options.json.as_deref(), &summary)
}

fn run_benchmark(options: &Options) -> Result<(), String> {
    let sweep = phase2_benchmark_sweep();
    let mut encode_ms = Vec::with_capacity(options.iterations);
    let mut validate_ms = Vec::with_capacity(options.iterations);
    let mut last = Vec::new();
    let mut summary = None;

    for generation in 1..=options.iterations {
        let started = Instant::now();
        let bytes = encode_packed_sweep(
            &sweep,
            PackedSweepIdentity {
                generation: generation as u64,
            },
        )
        .map_err(|error| format!("benchmark encode failed: {error}"))?;
        encode_ms.push(started.elapsed().as_secs_f64() * 1_000.0);

        let started = Instant::now();
        summary = Some(
            validate_packed_sweep(&bytes)
                .map_err(|error| format!("benchmark validation failed: {error}"))?,
        );
        validate_ms.push(started.elapsed().as_secs_f64() * 1_000.0);
        last = bytes;
    }

    if let Some(output) = options.output.as_deref() {
        write_bytes(output, &last)?;
    }
    let report = BenchmarkReport {
        mode: "phase2_synthetic_720x1832",
        build_profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        iterations: options.iterations,
        payload: summary.expect("at least one benchmark iteration"),
        encode_ms: Distribution::from_samples(&encode_ms),
        validate_ms: Distribution::from_samples(&validate_ms),
    };
    write_json(options.json.as_deref(), &report)
}

fn encode_archive(options: &Options) -> Result<(), String> {
    let archive = options
        .archive
        .as_deref()
        .ok_or_else(|| "--archive requires a path".to_string())?;
    let output = options
        .output
        .as_deref()
        .ok_or_else(|| "--archive requires --output <path>".to_string())?;
    let input = read_input(archive)?;

    let started = Instant::now();
    let decoded = decode_level2(&input, options.product)
        .map_err(|error| format!("archive decode failed: {error}"))?;
    let decode_ms = started.elapsed().as_secs_f64() * 1_000.0;

    let started = Instant::now();
    let bytes = encode_packed_sweep(&decoded.sweep, PackedSweepIdentity { generation: 1 })
        .map_err(|error| format!("archive encode failed: {error}"))?;
    let encode_ms = started.elapsed().as_secs_f64() * 1_000.0;

    let started = Instant::now();
    let payload = validate_packed_sweep(&bytes)
        .map_err(|error| format!("archive wire validation failed: {error}"))?;
    let validate_ms = started.elapsed().as_secs_f64() * 1_000.0;

    write_bytes(output, &bytes)?;
    let report = ArchiveReport {
        mode: "phase2_level2_archive",
        build_profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        fixture: archive
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("level2-archive"),
        product: options.product.canonical_name(),
        compressed_input_bytes: input.len(),
        decode_ms,
        encode_ms,
        validate_ms,
        payload,
    };
    write_json(options.json.as_deref(), &report)
}

fn read_input(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("could not open {}: {error}", path.display()))?;
    let length = file
        .metadata()
        .map_err(|error| format!("could not inspect {}: {error}", path.display()))?
        .len();
    if length > MAX_LEVEL2_INPUT_BYTES as u64 {
        return Err(format!(
            "input {} is {length} bytes; limit is {MAX_LEVEL2_INPUT_BYTES} bytes",
            path.display()
        ));
    }
    let mut input = Vec::with_capacity(length as usize);
    file.take((MAX_LEVEL2_INPUT_BYTES as u64).saturating_add(1))
        .read_to_end(&mut input)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    if input.len() > MAX_LEVEL2_INPUT_BYTES {
        return Err(format!(
            "input grew beyond the {MAX_LEVEL2_INPUT_BYTES}-byte limit while it was being read"
        ));
    }
    Ok(input)
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    create_parent(path)?;
    fs::write(path, bytes).map_err(|error| format!("could not write {}: {error}", path.display()))
}

fn write_json(path: Option<&Path>, value: &impl Serialize) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|error| format!("could not serialize JSON: {error}"))?
        + "\n";
    if let Some(path) = path {
        create_parent(path)?;
        fs::write(path, json)
            .map_err(|error| format!("could not write {}: {error}", path.display()))
    } else {
        print!("{json}");
        Ok(())
    }
}

fn create_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum Mode {
    Golden,
    Benchmark,
    Archive,
}

#[derive(Debug)]
struct Options {
    mode: Mode,
    iterations: usize,
    output: Option<PathBuf>,
    json: Option<PathBuf>,
    archive: Option<PathBuf>,
    product: RadarProduct,
}

impl Options {
    fn parse(mut arguments: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut mode = None;
        let mut iterations = 10usize;
        let mut output = None;
        let mut json = None;
        let mut archive = None;
        let mut product = RadarProduct::Reflectivity;
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--golden" => set_mode(&mut mode, Mode::Golden)?,
                "--benchmark" => set_mode(&mut mode, Mode::Benchmark)?,
                "--archive" => {
                    set_mode(&mut mode, Mode::Archive)?;
                    archive = Some(PathBuf::from(
                        arguments
                            .next()
                            .ok_or_else(|| "--archive requires a path".to_string())?,
                    ));
                }
                "--product" => {
                    product = arguments
                        .next()
                        .ok_or_else(|| "--product requires a value".to_string())?
                        .parse()?;
                }
                "--iterations" => {
                    iterations = arguments
                        .next()
                        .ok_or_else(|| "--iterations requires a value".to_string())?
                        .parse()
                        .map_err(|_| "--iterations must be an integer".to_string())?;
                    if !(1..=100).contains(&iterations) {
                        return Err("--iterations must be between 1 and 100".into());
                    }
                }
                "--output" => {
                    output = Some(PathBuf::from(
                        arguments
                            .next()
                            .ok_or_else(|| "--output requires a path".to_string())?,
                    ));
                }
                "--json" => {
                    json = Some(PathBuf::from(
                        arguments
                            .next()
                            .ok_or_else(|| "--json requires a path".to_string())?,
                    ));
                }
                option => return Err(format!("unknown argument {option}\n{}", usage())),
            }
        }
        Ok(Self {
            mode: mode.ok_or_else(|| usage().to_string())?,
            iterations,
            output,
            json,
            archive,
            product,
        })
    }
}

fn set_mode(mode: &mut Option<Mode>, next: Mode) -> Result<(), String> {
    if mode.is_some() {
        return Err("choose exactly one of --golden, --benchmark, or --archive".into());
    }
    *mode = Some(next);
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    mode: &'static str,
    build_profile: &'static str,
    iterations: usize,
    payload: PackedSweepSummary,
    encode_ms: Distribution,
    validate_ms: Distribution,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveReport<'a> {
    mode: &'static str,
    build_profile: &'static str,
    fixture: &'a str,
    product: &'static str,
    compressed_input_bytes: usize,
    decode_ms: f64,
    encode_ms: f64,
    validate_ms: f64,
    payload: PackedSweepSummary,
}

#[derive(Debug, Serialize)]
struct Distribution {
    min: f64,
    p50: f64,
    p95: f64,
    max: f64,
}

impl Distribution {
    fn from_samples(samples: &[f64]) -> Self {
        let mut sorted = samples.to_vec();
        sorted.sort_by(f64::total_cmp);
        Self {
            min: sorted[0],
            p50: percentile(&sorted, 0.50),
            p95: percentile(&sorted, 0.95),
            max: sorted[sorted.len() - 1],
        }
    }
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let rank = (fraction * sorted.len() as f64).ceil() as usize;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

fn usage() -> &'static str {
    "usage:\n  mistr-wire --golden --output <path> [--json <path>]\n  mistr-wire --benchmark [--iterations 10] [--output <path>] [--json <path>]\n  mistr-wire --archive <path> [--product reflectivity|base_velocity] --output <path> [--json <path>]"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_uses_nearest_rank() {
        let samples: Vec<f64> = (1..=20).map(|value| value as f64).collect();
        assert_eq!(percentile(&samples, 0.50), 10.0);
        assert_eq!(percentile(&samples, 0.95), 19.0);
    }

    #[test]
    fn options_require_exactly_one_mode() {
        assert!(Options::parse(Vec::<String>::new().into_iter()).is_err());
        assert!(
            Options::parse(["--golden", "--benchmark"].map(str::to_string).into_iter()).is_err()
        );
    }

    #[test]
    fn archive_mode_accepts_product_and_paths() {
        let options = Options::parse(
            [
                "--archive",
                "fixture",
                "--product",
                "velocity",
                "--output",
                "wire.bin",
            ]
            .map(str::to_string)
            .into_iter(),
        )
        .expect("parse archive mode");
        assert!(matches!(options.mode, Mode::Archive));
        assert_eq!(options.product, RadarProduct::BaseVelocity);
        assert_eq!(options.archive, Some(PathBuf::from("fixture")));
        assert_eq!(options.output, Some(PathBuf::from("wire.bin")));
    }
}
