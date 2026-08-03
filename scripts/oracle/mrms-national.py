"""Regenerate the small, committed MRMS numeric oracle manifest.

Large NOAA observations are downloaded only into ignored fixtures/cache. The
committed output contains identities, hashes, point samples, and tiny raw-code
windows. ecCodes is the independent decoder; Pillow reads the PNG transport so
the script can prove the GRIB scaling formula against every source cell.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import time
import urllib.parse
import urllib.request

import eccodes
import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "fixtures" / "cache" / "mrms-oracle"
OUTPUT = ROOT / "fixtures" / "expected" / "national-phase2" / "mrms-oracle.json"
BASE = "https://noaa-mrms-pds.s3.amazonaws.com/"
MAX_COMPRESSED_BYTES = 16 * 1024 * 1024
CASES = [
    (
        "fall",
        "CONUS/MergedBaseReflectivityQC_00.50/20251015/"
        "MRMS_MergedBaseReflectivityQC_00.50_20251015-180213.grib2.gz",
        "afd2ddafaa72d8da563fa63ce18c2e09eca4bb18a823c5c328f3064d9313f1e4",
    ),
    (
        "winter",
        "CONUS/MergedBaseReflectivityQC_00.50/20260115/"
        "MRMS_MergedBaseReflectivityQC_00.50_20260115-180017.grib2.gz",
        "012bd4e6beeb83de4617dd8988c2eb656982a95255435def80e0c76db3c62cac",
    ),
    (
        "spring",
        "CONUS/MergedBaseReflectivityQC_00.50/20260415/"
        "MRMS_MergedBaseReflectivityQC_00.50_20260415-180021.grib2.gz",
        "8ad5f15f31df7f5e3a2576af000602bab645d92193b7f2bb71a4a24773b8e4b9",
    ),
    (
        "summer",
        "CONUS/MergedBaseReflectivityQC_00.50/20260715/"
        "MRMS_MergedBaseReflectivityQC_00.50_20260715-180008.grib2.gz",
        "41dad0a40d686c24f6aa581a2cb3e13aa1f42d3243a8dc3e834cd1245953ae55",
    ),
]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def download(key: str, expected_hash: str) -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / Path(key).name
    if not path.exists():
        url = BASE + urllib.parse.quote(key, safe="/")
        opener = urllib.request.build_opener(NoRedirect)
        with opener.open(url, timeout=30) as response:
            if urllib.parse.urlparse(response.geturl()).netloc != urllib.parse.urlparse(BASE).netloc:
                raise RuntimeError(f"{key}: response escaped the approved NOAA host")
            downloaded = response.read(MAX_COMPRESSED_BYTES + 1)
        if len(downloaded) > MAX_COMPRESSED_BYTES:
            raise RuntimeError(f"{key}: compressed body exceeds {MAX_COMPRESSED_BYTES} bytes")
        if sha256(downloaded) != expected_hash:
            raise RuntimeError(f"{key}: downloaded bytes do not match the pinned SHA-256")
        path.write_bytes(downloaded)
    if path.stat().st_size > MAX_COMPRESSED_BYTES:
        raise RuntimeError(f"{key}: cached body exceeds {MAX_COMPRESSED_BYTES} bytes")
    data = path.read_bytes()
    actual = sha256(data)
    if actual != expected_hash:
        raise RuntimeError(f"{key}: compressed SHA-256 {actual} != {expected_hash}")
    return data


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def section7_png(grib: bytes) -> bytes:
    if grib[:4] != b"GRIB" or grib[-4:] != b"7777":
        raise RuntimeError("not a complete GRIB message")
    offset = 16
    seen: list[int] = []
    while offset < len(grib) - 4:
        length = struct.unpack_from(">I", grib, offset)[0]
        number = grib[offset + 4]
        seen.append(number)
        if number == 7:
            return grib[offset + 5 : offset + length]
        offset += length
    raise RuntimeError(f"GRIB has no section 7; sections={seen}")


def eccodes_values(grib: bytes) -> tuple[np.ndarray, dict[str, object]]:
    temp = tempfile.NamedTemporaryFile(delete=False, suffix=".grib2")
    try:
        temp.write(grib)
        temp.close()
        with open(temp.name, "rb") as handle:
            message = eccodes.codes_grib_new_from_file(handle)
            if message is None:
                raise RuntimeError("ecCodes did not return a GRIB message")
            try:
                metadata = {
                    key: eccodes.codes_get(message, key)
                    for key in [
                        "edition",
                        "discipline",
                        "parameterCategory",
                        "parameterNumber",
                        "gridType",
                        "Ni",
                        "Nj",
                        "latitudeOfFirstGridPointInDegrees",
                        "longitudeOfFirstGridPointInDegrees",
                        "latitudeOfLastGridPointInDegrees",
                        "longitudeOfLastGridPointInDegrees",
                        "iDirectionIncrementInDegrees",
                        "jDirectionIncrementInDegrees",
                        "scanningMode",
                        "packingType",
                        "bitsPerValue",
                        "referenceValue",
                        "binaryScaleFactor",
                        "decimalScaleFactor",
                    ]
                }
                values = np.asarray(eccodes.codes_get_values(message), dtype=np.float64)
            finally:
                eccodes.codes_release(message)
        return values, metadata
    finally:
        for _ in range(10):
            try:
                os.unlink(temp.name)
                break
            except PermissionError:
                time.sleep(0.05)


def canonical_i32_sha(values_tenths: np.ndarray) -> str:
    return sha256(np.asarray(values_tenths, dtype=">i4").tobytes())


def raw_u16_sha(raw: np.ndarray) -> str:
    return sha256(np.asarray(raw, dtype=">u2").tobytes())


def cell(raw: np.ndarray, values: np.ndarray, index: int) -> dict[str, object]:
    row, column = divmod(index, 7000)
    return {
        "index": index,
        "row": row,
        "column": column,
        "latitudeDegrees": round(54.995 - row * 0.01, 6),
        "longitudeDegrees": round(-129.995 + column * 0.01, 6),
        "rawCode": int(raw[index]),
        "ecCodesDbz": float(values[index]),
    }


def build_case(season: str, key: str, expected_hash: str) -> dict[str, object]:
    compressed = download(key, expected_hash)
    grib = gzip.decompress(compressed)
    png = section7_png(grib)
    with Image.open(__import__("io").BytesIO(png)) as image:
        if image.size != (7000, 3500) or image.mode not in ("I;16B", "I;16"):
            raise RuntimeError(f"unexpected PNG shape/mode: {image.size} {image.mode}")
        raw = np.asarray(image, dtype=np.uint16).reshape(-1)
    values, metadata = eccodes_values(grib)
    if raw.size != 24_500_000 or values.size != raw.size:
        raise RuntimeError("decoder cell counts differ")
    formula_tenths = raw.astype(np.int32) - 9990
    oracle_tenths = np.rint(values * 10).astype(np.int32)
    mismatch_count = int(np.count_nonzero(formula_tenths != oracle_tenths))
    if mismatch_count:
        raise RuntimeError(f"ecCodes and PNG/scaling formula differ at {mismatch_count} cells")

    valid_mask = (raw != 0) & (raw != 9000)
    valid_indices = np.flatnonzero(valid_mask)
    missing_index = int(np.flatnonzero(raw == 9000)[0])
    no_coverage_index = int(np.flatnonzero(raw == 0)[0])
    min_valid_index = int(valid_indices[np.argmin(raw[valid_indices])])
    max_valid_index = int(valid_indices[np.argmax(raw[valid_indices])])
    center_valid_index = int(valid_indices[len(valid_indices) // 2])
    window_row, window_column = divmod(max_valid_index, 7000)
    window_row = min(max(window_row - 2, 0), 3500 - 4)
    window_column = min(max(window_column - 2, 0), 7000 - 4)
    window = raw.reshape(3500, 7000)[
        window_row : window_row + 4, window_column : window_column + 4
    ]
    return {
        "season": season,
        "objectKey": key,
        "observationTimeUtc": key.rsplit("_", 1)[1].removesuffix(".grib2.gz"),
        "compressedBytes": len(compressed),
        "compressedSha256": sha256(compressed),
        "gribBytes": len(grib),
        "gribSha256": sha256(grib),
        "pngBytes": len(png),
        "normalizedRawBigEndianSha256": raw_u16_sha(raw),
        "ecCodesTenthsBigEndianSha256": canonical_i32_sha(oracle_tenths),
        "formulaMismatchCount": mismatch_count,
        "counts": {
            "valid": int(np.count_nonzero(valid_mask)),
            "missing": int(np.count_nonzero(raw == 9000)),
            "noCoverage": int(np.count_nonzero(raw == 0)),
        },
        "validRange": {
            "minimumDbz": float(values[min_valid_index]),
            "maximumDbz": float(values[max_valid_index]),
        },
        "sampleCells": [
            cell(raw, values, no_coverage_index),
            cell(raw, values, missing_index),
            cell(raw, values, min_valid_index),
            cell(raw, values, center_valid_index),
            cell(raw, values, max_valid_index),
        ],
        "goldenWindow": {
            "row": window_row,
            "column": window_column,
            "width": 4,
            "height": 4,
            "rawCodes": [int(value) for value in window.reshape(-1)],
        },
        "ecCodesMetadata": metadata,
    }


def main() -> None:
    output = {
        "schemaVersion": 1,
        "independentDecoder": f"ecCodes={eccodes.codes_get_api_version()}",
        "transportDecoder": f"Pillow={__import__('PIL').__version__}",
        "contract": {
            "formula": "(R + X * 2^E) / 10^D",
            "referenceValue": -9990.0,
            "binaryScaleFactor": 0,
            "decimalScaleFactor": 1,
            "bitDepth": 16,
            "missingRaw": 9000,
            "noCoverageRaw": 0,
            "structuralRawMinimum": 0,
            "structuralRawMaximum": 65535,
        },
        "syntheticNeverObserved": [
            {"rawCode": 1, "expectedDbz": -998.9},
            {"rawCode": 65535, "expectedDbz": 5554.5},
        ],
        "malformedCases": [
            "wrong_host",
            "wrong_object_key",
            "html_200_body",
            "gzip_expansion_over_limit",
            "wrong_grib_edition_or_discipline",
            "section_reorder_or_trailing_bytes",
            "wrong_product_or_grid",
            "unsupported_packing_scaling_or_status",
            "png_wrong_dimensions_bit_depth_or_interlace",
            "filename_message_time_mismatch",
        ],
        "samples": [build_case(*case) for case in CASES],
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(OUTPUT)


if __name__ == "__main__":
    main()
