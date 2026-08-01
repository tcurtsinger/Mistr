import { describe, expect, it } from "vitest";
import type { PackedRadial } from "../packed-sweep/packedSweep";
import {
  angularDistanceDegrees,
  bearingWithinRadial,
  buildAzimuthLookup,
  buildMercatorBounds,
  destinationPoint,
  gateIndexForRange,
  lngLatToMercator,
  mercatorToLngLat,
  radialFromLookup,
  rangeBearing,
} from "./geo";

const KTLX = { longitude: -97.27776, latitude: 35.333363 };

describe("radar geodesy", () => {
  it("round-trips destination points at multiple bearings and ranges", () => {
    for (const bearing of [0, 45, 179.75, 270, 359.75]) {
      for (const rangeM of [2_125, 115_000, 459_875]) {
        const destination = destinationPoint(KTLX, bearing, rangeM);
        const recovered = rangeBearing(KTLX, destination);
        expect(Math.abs(recovered.rangeM - rangeM)).toBeLessThan(0.000_01);
        expect(angularDistanceDegrees(recovered.bearingDegrees, bearing)).toBeLessThan(1e-9);
      }
    }
  });

  it("round-trips Web Mercator and contains the sampled radar footprint", () => {
    const projected = lngLatToMercator(KTLX);
    const recovered = mercatorToLngLat(projected);
    expect(recovered.longitude).toBeCloseTo(KTLX.longitude, 10);
    expect(recovered.latitude).toBeCloseTo(KTLX.latitude, 10);

    const bounds = buildMercatorBounds(KTLX, 459_875);
    for (const bearing of [0, 90, 180, 270]) {
      const edge = lngLatToMercator(destinationPoint(KTLX, bearing, 459_875));
      expect(edge.x).toBeGreaterThanOrEqual(bounds.west - 1e-12);
      expect(edge.x).toBeLessThanOrEqual(bounds.east + 1e-12);
      expect(edge.y).toBeGreaterThanOrEqual(bounds.north - 1e-12);
      expect(edge.y).toBeLessThanOrEqual(bounds.south + 1e-12);
    }
  });

  it("handles longitude wrap across the antimeridian", () => {
    const origin = { longitude: 179.9, latitude: 10 };
    const target = destinationPoint(origin, 90, 50_000);
    expect(target.longitude).toBeLessThan(-179);
    const recovered = rangeBearing(origin, target);
    expect(recovered.rangeM).toBeCloseTo(50_000, 6);
    expect(recovered.bearingDegrees).toBeCloseTo(90, 8);
  });
});

describe("native polar indexing", () => {
  it("uses inclusive half-gate boundaries and rejects out-of-range samples", () => {
    expect(gateIndexForRange(874.999, 1_000, 250, 3)).toBeNull();
    expect(gateIndexForRange(875, 1_000, 250, 3)).toBe(0);
    expect(gateIndexForRange(1_124.999, 1_000, 250, 3)).toBe(0);
    expect(gateIndexForRange(1_125, 1_000, 250, 3)).toBe(1);
    expect(gateIndexForRange(1_625, 1_000, 250, 3)).toBe(2);
    expect(gateIndexForRange(1_625.001, 1_000, 250, 3)).toBeNull();
  });

  it("preserves irregular radial gaps instead of inventing coverage", () => {
    const radials: PackedRadial[] = [radial(0.25, 0.5), radial(10, 1), radial(359.75, 0.5)];
    const lookup = buildAzimuthLookup(radials);
    expect(radialFromLookup(lookup, 0.25)).toBe(0);
    expect(radialFromLookup(lookup, 10)).toBe(1);
    expect(radialFromLookup(lookup, 359.75)).toBe(2);
    expect(radialFromLookup(lookup, 180)).toBeNull();
    expect(radialFromLookup(lookup, 10.54)).toBe(1);
    expect(bearingWithinRadial(10.5, 10, 1)).toBe(true);
    expect(bearingWithinRadial(10.54, 10, 1)).toBe(false);
  });

  it("rejects unordered or duplicate radial azimuths", () => {
    expect(() => buildAzimuthLookup([radial(1, 1), radial(1, 1)])).toThrow(
      "strictly increasing",
    );
  });
});

function radial(azimuthDegrees: number, beamWidthDegrees: number): PackedRadial {
  return {
    sourceAzimuthNumber: 1,
    azimuthDegrees,
    beamWidthDegrees,
    elevationDegrees: 0.5,
    collectedAtUnixMs: 0n,
  };
}
