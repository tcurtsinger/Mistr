use mistr_lib::mrms::{MrmsObject, decode_mrms_gzip};
use mistr_lib::packed_grid::{MrmsNumericPyramid, PackedGridFrame};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema_version: u16,
    source_object_key: String,
    source_compressed_sha256: String,
    generation: u64,
    presentation_factor: u16,
    manifest_file: String,
    manifest_bytes: usize,
    manifest_sha256: String,
    first_chunk_file: String,
    first_chunk_bytes: usize,
    first_chunk_sha256: String,
    total_chunk_count: usize,
}

fn main() -> Result<(), String> {
    let mut arguments = std::env::args().skip(1);
    let input = PathBuf::from(arguments.next().ok_or_else(usage)?);
    let key = arguments.next().ok_or_else(usage)?;
    let output = PathBuf::from(arguments.next().ok_or_else(usage)?);
    if arguments.next().is_some() {
        return Err(usage());
    }
    let compressed =
        fs::read(&input).map_err(|error| format!("failed to read {}: {error}", input.display()))?;
    let object = MrmsObject {
        observation_time_unix_ms: MrmsObject::parse_key(&key).map_err(|error| error.to_string())?,
        key: key.clone(),
        last_modified_unix_ms: 0,
        size_bytes: compressed.len(),
        etag: None,
    };
    let decoded = decode_mrms_gzip(&compressed, object).map_err(|error| error.to_string())?;
    let source_hash = decoded.evidence.compressed_sha256.clone();
    let pyramid =
        MrmsNumericPyramid::from_decoded(decoded, 4).map_err(|error| error.to_string())?;
    let frame = PackedGridFrame::encode(7, &pyramid, 4).map_err(|error| error.to_string())?;
    fs::create_dir_all(&output)
        .map_err(|error| format!("failed to create {}: {error}", output.display()))?;
    let manifest_name = "packed-grid-v1-manifest.bin";
    let chunk_name = "packed-grid-v1-chunk-000.bin";
    fs::write(output.join(manifest_name), &frame.manifest)
        .map_err(|error| format!("failed to write manifest: {error}"))?;
    fs::write(output.join(chunk_name), &frame.chunks[0])
        .map_err(|error| format!("failed to write first chunk: {error}"))?;
    let report = Report {
        schema_version: 1,
        source_object_key: key,
        source_compressed_sha256: source_hash,
        generation: 7,
        presentation_factor: 4,
        manifest_file: manifest_name.into(),
        manifest_bytes: frame.manifest.len(),
        manifest_sha256: sha256_hex(&frame.manifest),
        first_chunk_file: chunk_name.into(),
        first_chunk_bytes: frame.chunks[0].len(),
        first_chunk_sha256: sha256_hex(&frame.chunks[0]),
        total_chunk_count: frame.chunks.len(),
    };
    fs::write(
        output.join("packed-grid-v1.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
        ),
    )
    .map_err(|error| format!("failed to write report: {error}"))?;
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut value = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    value
}

fn usage() -> String {
    "usage: mistr-national-wire <grib2.gz> <exact-object-key> <output-directory>".into()
}
