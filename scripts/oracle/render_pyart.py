#!/usr/bin/env python3
"""Render the Phase 3 reflectivity fixture with the independent Py-ART oracle."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.colors import BoundaryNorm, ListedColormap  # noqa: E402
import pyart  # noqa: E402
import numpy as np  # noqa: E402


BOUNDS = [-32, -10, 0, 5, 20, 30, 40, 50, 60, 70, 100]
COLORS = [
    "#2061ab",
    "#1f95d6",
    "#39c7d6",
    "#30cc55",
    "#168a37",
    "#efdd33",
    "#f68b22",
    "#e3322d",
    "#d02fa6",
    "#eeeef4",
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reference-json", type=Path)
    arguments = parser.parse_args()

    radar = pyart.io.read_nexrad_archive(str(arguments.archive))
    field = radar.get_field(0, "reflectivity")
    x, y, _ = radar.get_gate_x_y_z(0)
    colormap = ListedColormap(COLORS)
    normalization = BoundaryNorm(BOUNDS, colormap.N)

    figure, axis = plt.subplots(figsize=(9, 9), dpi=160)
    figure.patch.set_facecolor("#05090b")
    axis.set_facecolor("#05090b")
    axis.pcolormesh(
        x / 1_000,
        y / 1_000,
        field,
        cmap=colormap,
        norm=normalization,
        shading="auto",
        rasterized=True,
    )
    axis.scatter([0], [0], s=18, c="#d8fbff", edgecolors="#071014", linewidths=0.5)
    axis.set_aspect("equal", adjustable="box")
    axis.set_xlim(-470, 470)
    axis.set_ylim(-470, 470)
    axis.set_xlabel("east-west range (km)", color="#a7b9be")
    axis.set_ylabel("north-south range (km)", color="#a7b9be")
    axis.set_title(
        "Py-ART 2.2.5 independent KTLX sweep 0 / 2024-05-20 23:05Z",
        color="#dce9ed",
    )
    axis.tick_params(colors="#83979d")
    for spine in axis.spines.values():
        spine.set_color("#24434a")
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(arguments.output, bbox_inches="tight", facecolor=figure.get_facecolor())
    plt.close(figure)

    if arguments.reference_json:
        write_ground_range_reference(radar, arguments.reference_json)


def write_ground_range_reference(radar, output: Path) -> None:
    sweep_slice = radar.get_slice(0)
    azimuths = radar.azimuth["data"][sweep_slice]
    elevations = radar.elevation["data"][sweep_slice]
    x, y, z = radar.get_gate_x_y_z(0)
    sorted_rays = np.argsort(azimuths, kind="stable")
    gate_indices = [0, 460, len(radar.range["data"]) - 1]
    radial_indices = [0, 180, 360, 540, len(sorted_rays) - 1]
    points = []
    for radial_index in radial_indices:
        sweep_ray_index = int(sorted_rays[radial_index])
        for gate_index in gate_indices:
            x_m = float(x[sweep_ray_index, gate_index])
            y_m = float(y[sweep_ray_index, gate_index])
            points.append(
                {
                    "radialIndex": radial_index,
                    "gateIndex": gate_index,
                    "azimuthDegrees": float(azimuths[sweep_ray_index]),
                    "elevationDegrees": float(elevations[sweep_ray_index]),
                    "slantRangeM": float(radar.range["data"][gate_index]),
                    "groundRangeM": float(np.hypot(x_m, y_m)),
                    "xM": x_m,
                    "yM": y_m,
                    "heightAboveRadarM": float(z[sweep_ray_index, gate_index]),
                }
            )
    payload = {
        "oracle": "arm_pyart 2.2.5 antenna_to_cartesian",
        "model": "Doviak-Zrnic standard atmosphere, 4/3 Earth radius",
        "effectiveEarthRadiusM": 4.0 / 3.0 * 6_371_000.0,
        "points": points,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
