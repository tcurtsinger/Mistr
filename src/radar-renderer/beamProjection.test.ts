import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EFFECTIVE_EARTH_RADIUS_M,
  groundRangeForSlantRange,
  slantRangeForGroundRange,
} from "./geo";

const REFERENCE_PATH = new URL(
  "../../fixtures/expected/phase-3/pyart-ground-range.json",
  import.meta.url,
);

interface PyArtReference {
  effectiveEarthRadiusM: number;
  points: Array<{
    radialIndex: number;
    gateIndex: number;
    elevationDegrees: number;
    slantRangeM: number;
    groundRangeM: number;
  }>;
}

function reference(): PyArtReference {
  return JSON.parse(readFileSync(REFERENCE_PATH, "utf8")) as PyArtReference;
}

describe("standard-atmosphere beam projection", () => {
  it("matches independent Py-ART 2.2.5 gate ground ranges", () => {
    const oracle = reference();
    expect(EFFECTIVE_EARTH_RADIUS_M).toBe(oracle.effectiveEarthRadiusM);
    for (const point of oracle.points) {
      const groundRangeM = groundRangeForSlantRange(
        point.slantRangeM,
        point.elevationDegrees,
      );
      expect(
        Math.abs(groundRangeM - point.groundRangeM),
        `radial ${point.radialIndex} gate ${point.gateIndex}`,
      ).toBeLessThan(0.1);
      expect(
        Math.abs(
          slantRangeForGroundRange(groundRangeM, point.elevationDegrees)
            - point.slantRangeM,
        ),
      ).toBeLessThan(1e-7);
    }
  });

  it("does not treat the outer KTLX gate's slant range as ground range", () => {
    const outer = reference().points.find(
      (point) => point.radialIndex === 0 && point.gateIndex === 1831,
    );
    expect(outer).toBeDefined();
    expect(outer!.slantRangeM - outer!.groundRangeM).toBeGreaterThan(670);
  });

  it("rejects invalid beam coordinates", () => {
    expect(() => groundRangeForSlantRange(-1, 0.5)).toThrow("nonnegative");
    expect(() => slantRangeForGroundRange(1_000, 91)).toThrow("between 0 and 90");
  });
});
