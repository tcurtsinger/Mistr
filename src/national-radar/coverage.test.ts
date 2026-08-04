import { describe, expect, it } from "vitest";
import type { PackedGridManifest } from "../packed-grid/packedGrid";
import {
  assertCoverageMatchesManifest,
  completeDomainCoverage,
  viewportCoverage,
} from "./coverage";

function manifest(): PackedGridManifest {
  const width = 1_750;
  const height = 875;
  const chunks = [];
  const chunksX = Math.ceil(width / 256);
  const chunksY = Math.ceil(height / 256);
  for (let y = 0; y < chunksY; y += 1) {
    for (let x = 0; x < chunksX; x += 1) {
      const index = y * chunksX + x;
      const interiorX = x * 256;
      const interiorY = y * 256;
      const interiorWidth = Math.min(256, width - interiorX);
      const interiorHeight = Math.min(256, height - interiorY);
      const haloX = Math.max(0, interiorX - 1);
      const haloY = Math.max(0, interiorY - 1);
      const haloWidth = Math.min(width, interiorX + interiorWidth + 1) - haloX;
      const haloHeight = Math.min(height, interiorY + interiorHeight + 1) - haloY;
      chunks.push({
        index,
        chunkX: x,
        chunkY: y,
        interiorX,
        interiorY,
        interiorWidth,
        interiorHeight,
        haloX,
        haloY,
        haloWidth,
        haloHeight,
        encodedLength: 176 + haloWidth * haloHeight * 2,
        payloadSha256: "00".repeat(32),
      });
    }
  }
  return {
    schemaVersion: 1,
    generation: 7n,
    sourceKind: "national_mrms",
    domain: "conus",
    product: "MergedBaseReflectivityQC_00.50",
    provider: "noaa-mrms-pds.s3.amazonaws.com",
    objectKey: "CONUS/MergedBaseReflectivityQC_00.50/20260803/MRMS_MergedBaseReflectivityQC_00.50_20260803-162812.grib2.gz",
    observationTimeUnixMs: 1_785_775_692_000n,
    contentSha256: "11".repeat(32),
    width,
    height,
    firstLatitudeDegrees: 54.995,
    firstLongitudeDegrees: -129.995,
    lastLatitudeDegrees: 20.035,
    lastLongitudeDegrees: -60.035,
    longitudeStepDegrees: 0.04,
    latitudeStepDegrees: 0.04,
    rowOrientation: "north_to_south",
    bitDepth: 16,
    referenceValue: -9990,
    binaryScale: 0,
    decimalScale: 1,
    missingRaw: 9000,
    noCoverageRaw: 0,
    presentationFactor: 4,
    chunkInteriorSize: 256,
    chunks,
  };
}

describe("National viewport coverage", () => {
  it("declares every chunk for a complete CONUS overview", () => {
    const source = manifest();
    const coverage = completeDomainCoverage(source, 1);
    expect(coverage.kind).toBe("complete_domain");
    expect(coverage.requiredChunkIndices).toHaveLength(28);
    expect(assertCoverageMatchesManifest(source, coverage)).toHaveLength(28);
  });

  it("selects only chunks intersecting a detailed viewport", () => {
    const source = manifest();
    const coverage = viewportCoverage(source, {
      west: -100,
      south: 34,
      east: -96,
      north: 38,
    }, 2);
    expect(coverage.kind).toBe("viewport");
    expect(coverage.requiredChunkIndices.length).toBeGreaterThan(0);
    expect(coverage.requiredChunkIndices.length).toBeLessThan(source.chunks.length);
    expect(assertCoverageMatchesManifest(source, coverage).map((chunk) => chunk.index))
      .toEqual(coverage.requiredChunkIndices);
  });

  it("rejects duplicate or incomplete coverage identities", () => {
    const source = manifest();
    const coverage = completeDomainCoverage(source, 3);
    expect(() => assertCoverageMatchesManifest(source, {
      ...coverage,
      requiredChunkIndices: [0, 0],
    })).toThrow(/unique/);
    expect(() => assertCoverageMatchesManifest(source, {
      ...coverage,
      requiredChunkIndices: [],
    })).toThrow(/at least one/);
  });
});
