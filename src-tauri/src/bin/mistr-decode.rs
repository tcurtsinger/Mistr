use mistr_lib::radar::{DiagnosticReport, MAX_LEVEL2_INPUT_BYTES, RadarProduct, decode_level2};
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("mistr-decode: {error}");
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
    let input = read_input(&options.input)?;
    let decoded = decode_level2(&input, options.product)
        .map_err(|error| format!("decode failed: {error}"))?;
    let report = DiagnosticReport::from_output(&decoded);
    let json = serde_json::to_string_pretty(&report)
        .map_err(|error| format!("could not serialize diagnostic JSON: {error}"))?
        + "\n";

    if let Some(path) = &options.json_output {
        write_output(path, &json)?;
    } else {
        print!("{json}");
    }
    if let Some(path) = &options.text_output {
        write_output(path, &report.to_text())?;
    }
    Ok(())
}

fn read_input(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("could not open {}: {error}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("could not inspect {}: {error}", path.display()))?;
    if metadata.len() > MAX_LEVEL2_INPUT_BYTES as u64 {
        return Err(format!(
            "input {} is {} bytes; limit is {} bytes",
            path.display(),
            metadata.len(),
            MAX_LEVEL2_INPUT_BYTES
        ));
    }
    read_bounded(file, MAX_LEVEL2_INPUT_BYTES)
        .map_err(|error| format!("could not read {}: {error}", path.display()))
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

fn write_output(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    }
    fs::write(path, content).map_err(|error| format!("could not write {}: {error}", path.display()))
}

#[derive(Debug)]
struct Options {
    input: PathBuf,
    product: RadarProduct,
    json_output: Option<PathBuf>,
    text_output: Option<PathBuf>,
}

impl Options {
    fn parse(mut args: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut input = None;
        let mut product = RadarProduct::Reflectivity;
        let mut json_output = None;
        let mut text_output = None;

        while let Some(argument) = args.next() {
            match argument.as_str() {
                "--product" => {
                    product = args
                        .next()
                        .ok_or_else(|| "--product requires a value".to_string())?
                        .parse()?;
                }
                "--json" => {
                    json_output = Some(PathBuf::from(
                        args.next()
                            .ok_or_else(|| "--json requires a path".to_string())?,
                    ));
                }
                "--text" => {
                    text_output = Some(PathBuf::from(
                        args.next()
                            .ok_or_else(|| "--text requires a path".to_string())?,
                    ));
                }
                option if option.starts_with('-') => {
                    return Err(format!("unknown option {option}\n{}", usage()));
                }
                value if input.is_none() => input = Some(PathBuf::from(value)),
                value => {
                    return Err(format!(
                        "unexpected positional argument {value}\n{}",
                        usage()
                    ));
                }
            }
        }

        Ok(Self {
            input: input.ok_or_else(|| usage().to_string())?,
            product,
            json_output,
            text_output,
        })
    }
}

fn usage() -> &'static str {
    "usage: cargo run --bin mistr-decode -- <archive> [--product reflectivity|base_velocity] [--json <path>] [--text <path>]"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_reader_stops_after_limit_plus_one_byte() {
        let result = read_bounded(std::io::repeat(0), 128);
        assert_eq!(
            result,
            Err("input grew beyond the 128-byte limit while it was being read".into())
        );
    }

    #[test]
    fn bounded_reader_accepts_input_at_limit() {
        let result = read_bounded(&[7u8; 128][..], 128).expect("read bounded bytes");
        assert_eq!(result, vec![7u8; 128]);
    }
}
