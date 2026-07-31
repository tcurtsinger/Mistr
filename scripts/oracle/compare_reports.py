#!/usr/bin/env python3
"""Compare Mistr and Py-ART reports and write deterministic Phase 1 evidence."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("rust_report", type=Path)
    parser.add_argument("oracle_report", type=Path)
    parser.add_argument("--json", type=Path, required=True)
    parser.add_argument("--markdown", type=Path, required=True)
    args = parser.parse_args()

    rust = json.loads(args.rust_report.read_text(encoding="utf-8"))
    oracle = json.loads(args.oracle_report.read_text(encoding="utf-8"))
    checks: list[dict[str, Any]] = []

    def exact(name: str, actual: Any, expected: Any) -> None:
        checks.append({"name": name, "passed": actual == expected, "mistr": actual, "oracle": expected})

    def close(name: str, actual: float, expected: float, tolerance: float) -> None:
        passed = math.isfinite(actual) and math.isfinite(expected) and abs(actual - expected) <= tolerance
        checks.append(
            {
                "name": name,
                "passed": passed,
                "mistr": actual,
                "oracle": expected,
                "absoluteTolerance": tolerance,
            }
        )

    for key in (
        "sourceSha256",
        "siteIcao",
        "product",
        "units",
        "volumeStartedAtUtc",
        "volumeEndedAtUtc",
        "sweepStartedAtUtc",
        "sweepEndedAtUtc",
        "vcp",
        "radialCount",
        "gateCount",
        "cellCount",
        "gateSpacingM",
        "firstGateCenterM",
        "dataWordSizeBits",
        "scale",
        "offset",
        "validCount",
        "azimuthSha256",
        "oracleFieldSha256",
        "rawCodesSha256",
        "antennaAltitudeM",
    ):
        exact(key, rust[key], oracle[key])
    exact(
        "maskedCount",
        rust["belowThresholdCount"] + rust["rangeFoldedCount"],
        oracle["maskedCount"],
    )
    close("radarLatitudeDegrees", rust["radarLatitudeDegrees"], oracle["radarLatitudeDegrees"], 1e-5)
    close("radarLongitudeDegrees", rust["radarLongitudeDegrees"], oracle["radarLongitudeDegrees"], 1e-5)
    close("elevationDegrees", rust["elevationDegrees"], oracle["elevationDegrees"], 1e-5)

    rust_samples = {(item["radialIndex"], item["gateIndex"]): item for item in rust["samples"]}
    oracle_samples = {(item["radialIndex"], item["gateIndex"]): item for item in oracle["samples"]}
    exact("sampleCoordinates", sorted(rust_samples), sorted(oracle_samples))
    for coordinate in sorted(set(rust_samples) & set(oracle_samples)):
        rust_sample = rust_samples[coordinate]
        oracle_sample = oracle_samples[coordinate]
        prefix = f"sample[{coordinate[0]},{coordinate[1]}]"
        close(f"{prefix}.azimuthDegrees", rust_sample["azimuthDegrees"], oracle_sample["azimuthDegrees"], 1e-5)
        close(f"{prefix}.elevationDegrees", rust_sample["elevationDegrees"], oracle_sample["elevationDegrees"], 1e-5)
        exact(f"{prefix}.collectedAtUtc", rust_sample["collectedAtUtc"], oracle_sample["collectedAtUtc"])
        exact(f"{prefix}.rangeM", rust_sample["rangeM"], oracle_sample["rangeM"])
        exact(f"{prefix}.rawCode", rust_sample["rawCode"], oracle_sample["rawCode"])
        exact(f"{prefix}.valid", rust_sample["status"] == "valid", oracle_sample["status"] == "valid")
        if rust_sample["status"] == "valid" and oracle_sample["status"] == "valid":
            close(f"{prefix}.value", rust_sample["value"], oracle_sample["value"], 1e-6)
            decoded_from_raw = (rust_sample["rawCode"] - rust["offset"]) / rust["scale"]
            close(f"{prefix}.rawScaleOffset", rust_sample["value"], decoded_from_raw, 1e-6)

    passed = all(check["passed"] for check in checks)
    result = {
        "status": "PASS" if passed else "FAIL",
        "mistrDecoder": rust["decoder"],
        "oracle": oracle["oracle"],
        "sourceSha256": rust["sourceSha256"],
        "normalizedSha256": rust["normalizedSha256"],
        "checkCount": len(checks),
        "passedCount": sum(1 for check in checks if check["passed"]),
        "failedCount": sum(1 for check in checks if not check["passed"]),
        "checks": checks,
    }
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    failed = [check for check in checks if not check["passed"]]
    lines = [
        "# Mistr Phase 1 numeric comparison",
        "",
        f"**Result:** {result['status']}",
        f"**Candidate:** `{result['mistrDecoder']}`",
        f"**Oracle:** `{result['oracle']}`",
        f"**Fixture SHA-256:** `{result['sourceSha256']}`",
        f"**Normalized SHA-256:** `{result['normalizedSha256']}`",
        f"**Checks:** {result['passedCount']} passed / {result['failedCount']} failed / {result['checkCount']} total",
        "",
        "The comparison covers source identity, site and antenna location, product and units, volume and sweep times, VCP, dimensions, gate geometry and encoding, all sorted azimuths, every raw gate code, every gate's validity and decoded value, and representative radial/gate values.",
    ]
    if failed:
        lines.extend(["", "## Failures", ""])
        for check in failed:
            lines.append(f"- `{check['name']}`: Mistr `{check['mistr']}`; oracle `{check['oracle']}`")
    args.markdown.write_text("\n".join(lines) + "\n", encoding="utf-8")

    if not passed:
        print(f"comparison failed: {len(failed)} checks disagreed", file=sys.stderr)
        return 1
    print(f"comparison passed: {len(checks)} checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
