#!/usr/bin/env python3
"""Spatially compare raw N0S categories with an IEM RIDGE indexed PNG."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import struct

from PIL import Image

EARTH_RADIUS_M = 6_371_008.8
EFFECTIVE_EARTH_RADIUS_M = 8_494_666.666666666


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("n0s", type=Path)
    parser.add_argument("ridge_png", type=Path)
    parser.add_argument("world_file", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    radar = decode_n0s(args.n0s.read_bytes())
    world = [float(value) for value in args.world_file.read_text().split()]
    if len(world) != 6 or world[1] != 0 or world[2] != 0:
        raise ValueError("comparison requires a north-up six-line world file")
    pixel_x, _, _, pixel_y, upper_left_x, upper_left_y = world
    image = Image.open(args.ridge_png)
    if image.mode != "P" or image.info.get("transparency") != 0:
        raise ValueError("RIDGE reference must be an indexed PNG with index 0 transparent")

    exact = adjacent = compared = outside = nontransparent = 0
    confusion: dict[tuple[int, int], int] = {}
    pixels = image.load()
    for row in range(image.height):
        latitude = pixel_y * row + upper_left_y
        for column in range(image.width):
            actual = int(pixels[column, row])
            if actual == 0:
                continue
            nontransparent += 1
            predicted = category_at(
                radar,
                pixel_x * column + upper_left_x,
                latitude,
            )
            if predicted is None:
                outside += 1
                continue
            compared += 1
            exact += int(predicted == actual)
            adjacent += int(abs(predicted - actual) <= 1)
            confusion[(actual, predicted)] = confusion.get((actual, predicted), 0) + 1

    exact_fraction = exact / compared if compared else 0
    adjacent_fraction = adjacent / compared if compared else 0
    coverage_fraction = compared / nontransparent if nontransparent else 0
    checks = {
        "sameProductCategories": all(1 <= actual <= 15 for actual, _ in confusion),
        "referenceCoverageAtLeast98Percent": coverage_fraction >= 0.98,
        "exactCategoryAgreementAtLeast90Percent": exact_fraction >= 0.90,
        "AdjacentCategoryAgreementAtLeast97Percent": adjacent_fraction >= 0.97,
    }
    output = {
        "schemaVersion": 1,
        "reference": "Iowa Environmental Mesonet RIDGE N0S indexed PNG",
        "method": (
            "Independent AF1F RLE parse; world-file pixel centers are mapped to "
            "the nearest source radial and 4/3-earth slant-range gate"
        ),
        "site": {
            "latitudeDegrees": radar["latitude"],
            "longitudeDegrees": radar["longitude"],
            "elevationDegrees": radar["elevation"],
        },
        "image": {"width": image.width, "height": image.height},
        "nontransparentReferencePixels": nontransparent,
        "comparedPixels": compared,
        "outsideSourceSweepPixels": outside,
        "coverageFraction": coverage_fraction,
        "exactCategoryMatches": exact,
        "exactCategoryFraction": exact_fraction,
        "sameOrAdjacentCategoryMatches": adjacent,
        "sameOrAdjacentCategoryFraction": adjacent_fraction,
        "largestConfusionPairs": [
            {"iemCategory": pair[0], "rawCategory": pair[1], "pixels": count}
            for pair, count in sorted(confusion.items(), key=lambda item: -item[1])[:30]
        ],
        "checks": checks,
        "passed": all(checks.values()),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    return 0 if output["passed"] else 1


def decode_n0s(data: bytes) -> dict:
    if data[:4] != b"SDUS" or data[21:24] != b"N0S":
        raise ValueError("input is not an SDUS N0S product")
    description = 48
    if u16(data, 30) != 56 or u16(data, description + 12) != 56:
        raise ValueError("input is not Level III product 56")
    latitude = i32(data, description + 2) / 1000
    longitude = i32(data, description + 6) / 1000
    elevation = i16(data, description + 40) / 10
    symbology = 30 + u32(data, description + 90) * 2
    if i16(data, symbology) != -1 or u16(data, symbology + 2) != 1:
        raise ValueError("invalid symbology block")
    packet = symbology + 16
    if u16(data, packet) != 0xAF1F:
        raise ValueError("N0S does not contain an AF1F radial packet")
    gate_count = u16(data, packet + 4)
    spacing_m = u16(data, packet + 10)
    radial_count = u16(data, packet + 12)
    cursor = packet + 14
    radials = []
    for _ in range(radial_count):
        encoded_bytes = u16(data, cursor) * 2
        start = u16(data, cursor + 2) / 10
        width = u16(data, cursor + 4) / 10
        bins: list[int] = []
        for byte in data[cursor + 6:cursor + 6 + encoded_bytes]:
            bins.extend([byte & 0x0F] * (byte >> 4))
        if len(bins) != gate_count:
            raise ValueError("RLE does not match declared gate count")
        radials.append({"center": (start + width / 2) % 360, "width": width, "bins": bins})
        cursor += 6 + encoded_bytes
    return {
        "latitude": latitude,
        "longitude": longitude,
        "elevation": elevation,
        "spacing": spacing_m,
        "firstCenter": math.ceil(spacing_m / 2),
        "radials": radials,
    }


def category_at(radar: dict, longitude: float, latitude: float) -> int | None:
    ground_range, bearing = range_bearing(
        radar["longitude"], radar["latitude"], longitude, latitude
    )
    radial = min(
        radar["radials"],
        key=lambda candidate: angular_distance(bearing, candidate["center"]),
    )
    if angular_distance(bearing, radial["center"]) > radial["width"] / 2:
        return None
    ground_angle = ground_range / EFFECTIVE_EARTH_RADIUS_M
    denominator = math.cos(math.radians(radar["elevation"]) + ground_angle)
    if denominator <= 0:
        return None
    slant_range = EFFECTIVE_EARTH_RADIUS_M * math.sin(ground_angle) / denominator
    gate = math.floor(
        (slant_range - radar["firstCenter"]) / radar["spacing"] + 0.5
    )
    return radial["bins"][gate] if 0 <= gate < len(radial["bins"]) else None


def range_bearing(lon1: float, lat1: float, lon2: float, lat2: float) -> tuple[float, float]:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = phi2 - phi1
    delta_lon = math.radians(lon2 - lon1)
    haversine = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lon / 2) ** 2
    )
    distance = 2 * EARTH_RADIUS_M * math.asin(min(1, math.sqrt(haversine)))
    y = math.sin(delta_lon) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(delta_lon)
    return distance, (math.degrees(math.atan2(y, x)) + 360) % 360


def angular_distance(left: float, right: float) -> float:
    return abs((left - right + 180) % 360 - 180)


def u16(data: bytes, offset: int) -> int:
    return struct.unpack_from(">H", data, offset)[0]


def i16(data: bytes, offset: int) -> int:
    return struct.unpack_from(">h", data, offset)[0]


def u32(data: bytes, offset: int) -> int:
    return struct.unpack_from(">I", data, offset)[0]


def i32(data: bytes, offset: int) -> int:
    return struct.unpack_from(">i", data, offset)[0]


if __name__ == "__main__":
    raise SystemExit(main())
