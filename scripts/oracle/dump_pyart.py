#!/usr/bin/env python3
"""Emit a deterministic Py-ART reference report for a Level II reflectivity sweep."""

from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import sys
import warnings

import numpy as np

EXPECTED_PYART_VERSION = "2.2.5"

# Py-ART prints a citation banner during import. Keep stdout machine-readable.
with contextlib.redirect_stdout(io.StringIO()), warnings.catch_warnings():
    warnings.simplefilter("ignore")
    import pyart


def sample_indices(length: int) -> list[int]:
    if length == 0:
        return []
    return sorted({0, min(1, length - 1), length // 4, length // 2, length * 3 // 4, length - 1})


def parse_time_origin(units: str) -> datetime:
    prefix = "seconds since "
    if not units.startswith(prefix):
        raise ValueError(f"unsupported Py-ART time units: {units!r}")
    value = units[len(prefix) :].replace("Z", "+00:00")
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def timestamp(origin: datetime, seconds: float) -> str:
    value = origin + timedelta(seconds=float(seconds))
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def status_from_raw(raw_code: int) -> str:
    if raw_code == 0:
        return "below_threshold"
    if raw_code == 1:
        return "range_folded"
    return "valid"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    if pyart.__version__ != EXPECTED_PYART_VERSION:
        raise RuntimeError(
            f"expected arm_pyart {EXPECTED_PYART_VERSION}, found {pyart.__version__}; "
            "install scripts/oracle/requirements.txt in a clean virtual environment"
        )

    with contextlib.redirect_stdout(io.StringIO()), warnings.catch_warnings():
        warnings.simplefilter("ignore")
        radar = pyart.io.read_nexrad_archive(str(args.archive))
        level2 = pyart.io.nexrad_level2.NEXRADLevel2File(str(args.archive))

    field_name = "reflectivity"
    if field_name not in radar.fields:
        raise RuntimeError("Py-ART did not expose a reflectivity field")

    candidate_sweeps = []
    for sweep_index in range(radar.nsweeps):
        start = int(radar.sweep_start_ray_index["data"][sweep_index])
        end = int(radar.sweep_end_ray_index["data"][sweep_index]) + 1
        if end > start:
            candidate_sweeps.append((float(radar.fixed_angle["data"][sweep_index]), sweep_index, start, end))
    if not candidate_sweeps:
        raise RuntimeError("Py-ART decoded no non-empty sweeps")
    _, sweep_index, start, end = min(candidate_sweeps, key=lambda item: (item[0], item[1]))

    source_azimuth = np.asarray(radar.azimuth["data"][start:end], dtype=np.float32)
    order = np.argsort(source_azimuth, kind="stable")
    azimuth = source_azimuth[order]
    elevation = np.asarray(radar.elevation["data"][start:end], dtype=np.float32)[order]
    time_seconds = np.asarray(radar.time["data"][start:end], dtype=np.float64)[order]
    field = np.ma.asarray(radar.fields[field_name]["data"][start:end])[order]
    validity = ~np.ma.getmaskarray(field)
    values = np.asarray(field.filled(0.0), dtype=np.float32)

    low_level_radials = [
        level2.radial_records[index]
        for index in level2.scan_msgs[sweep_index]
        if "REF" in level2.radial_records[index]
    ]
    low_level_radials.sort(
        key=lambda radial: (
            np.float32(radial["msg_header"]["azimuth_angle"]),
            int(radial["msg_header"]["azimuth_number"]),
            int(radial["msg_header"]["collect_ms"]),
        )
    )
    if len(low_level_radials) != values.shape[0]:
        raise RuntimeError("Py-ART high- and low-level radial counts disagree")
    moment_metadata = {
        (
            int(radial["REF"]["ngates"]),
            int(radial["REF"]["first_gate"]),
            int(radial["REF"]["gate_spacing"]),
            int(radial["REF"]["word_size"]),
            float(radial["REF"]["scale"]),
            float(radial["REF"]["offset"]),
        )
        for radial in low_level_radials
    }
    if len(moment_metadata) != 1:
        raise RuntimeError(f"Py-ART found inconsistent reflectivity geometry: {moment_metadata}")
    low_gate_count, low_first_gate, low_gate_spacing, word_size, scale, offset = moment_metadata.pop()
    if (low_gate_count, low_first_gate, low_gate_spacing) != (
        values.shape[1],
        int(round(float(radar.range["data"][0]))),
        int(round(float(radar.range["meters_between_gates"]))),
    ):
        raise RuntimeError("Py-ART high- and low-level gate geometry disagree")
    raw_codes = np.stack(
        [np.asarray(radial["REF"]["data"], dtype=np.uint16) for radial in low_level_radials]
    )
    detailed_statuses = np.where(raw_codes == 0, 1, np.where(raw_codes == 1, 2, 0)).astype(np.uint8)
    raw_validity = detailed_statuses == 0
    if not np.array_equal(validity, raw_validity):
        raise RuntimeError("Py-ART high-level validity and raw-code status semantics disagree")

    azimuth_le = np.asarray(azimuth, dtype="<f4")
    packed_field = np.empty(values.shape, dtype=np.dtype([("valid", "u1"), ("value", "<f4")]))
    packed_field["valid"] = validity.astype(np.uint8)
    packed_field["value"] = np.where(validity, values, np.float32(0.0))

    origin = parse_time_origin(str(radar.time["units"]))
    all_times = np.asarray(radar.time["data"], dtype=np.float64)
    gate_count = int(values.shape[1])
    first_gate_m = int(round(float(radar.range["data"][0])))
    gate_spacing_m = int(round(float(radar.range["meters_between_gates"])))
    samples = []
    for radial_index in sample_indices(len(azimuth)):
        for gate_index in sample_indices(gate_count):
            raw_code = int(raw_codes[radial_index, gate_index])
            status = status_from_raw(raw_code)
            valid = status == "valid"
            samples.append(
                {
                    "radialIndex": radial_index,
                    "gateIndex": gate_index,
                    "azimuthDegrees": float(azimuth[radial_index]),
                    "elevationDegrees": float(elevation[radial_index]),
                    "collectedAtUtc": timestamp(origin, time_seconds[radial_index]),
                    "rangeM": first_gate_m + gate_index * gate_spacing_m,
                    "rawCode": raw_code,
                    "status": status,
                    "value": float(values[radial_index, gate_index]) if valid else None,
                }
            )

    report = {
        "oracle": f"arm_pyart={pyart.__version__}",
        "sourceSha256": sha256_file(args.archive),
        "siteIcao": str(radar.metadata.get("instrument_name", "")),
        "radarLatitudeDegrees": float(radar.latitude["data"][0]),
        "radarLongitudeDegrees": float(radar.longitude["data"][0]),
        "antennaAltitudeM": int(round(float(radar.altitude["data"][0]))),
        "product": field_name,
        "units": str(radar.fields[field_name]["units"]),
        "volumeStartedAtUtc": timestamp(origin, float(all_times.min())),
        "volumeEndedAtUtc": timestamp(origin, float(all_times.max())),
        "sweepStartedAtUtc": timestamp(origin, float(time_seconds.min())),
        "sweepEndedAtUtc": timestamp(origin, float(time_seconds.max())),
        "sweepIndex": sweep_index,
        "elevationDegrees": float(np.median(elevation)),
        "vcp": int(radar.metadata["vcp_pattern"]),
        "radialCount": int(values.shape[0]),
        "gateCount": gate_count,
        "cellCount": int(values.size),
        "gateSpacingM": gate_spacing_m,
        "firstGateCenterM": first_gate_m,
        "dataWordSizeBits": word_size,
        "scale": scale,
        "offset": offset,
        "validCount": int(validity.sum()),
        "belowThresholdCount": int((detailed_statuses == 1).sum()),
        "rangeFoldedCount": int((detailed_statuses == 2).sum()),
        "maskedCount": int(validity.size - validity.sum()),
        "azimuthSha256": hashlib.sha256(azimuth_le.tobytes(order="C")).hexdigest(),
        "oracleFieldSha256": hashlib.sha256(packed_field.tobytes(order="C")).hexdigest(),
        "gateStatusSha256": hashlib.sha256(detailed_statuses.tobytes(order="C")).hexdigest(),
        "rawCodesSha256": hashlib.sha256(
            np.asarray(raw_codes, dtype="<u2").tobytes(order="C")
        ).hexdigest(),
        "samples": samples,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"dump_pyart: {error}", file=sys.stderr)
        raise
