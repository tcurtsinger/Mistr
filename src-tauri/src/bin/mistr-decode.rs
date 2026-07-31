use mistr_lib::radar::{DiagnosticReport, RadarProduct, decode_level2};
use std::env;
use std::fs;
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
    let input = fs::read(&options.input)
        .map_err(|error| format!("could not read {}: {error}", options.input.display()))?;
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
