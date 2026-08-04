import type {
  PackedGridChunkDescriptor,
  PackedGridManifest,
} from "../packed-grid/packedGrid";

export interface GeographicBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface NationalViewportCoverage extends GeographicBounds {
  version: number;
  kind: "complete_domain" | "viewport";
  requiredChunkIndices: readonly number[];
}

export function completeDomainCoverage(
  manifest: PackedGridManifest,
  version: number,
): NationalViewportCoverage {
  assertCoverageVersion(version);
  return {
    version,
    kind: "complete_domain",
    west: manifest.firstLongitudeDegrees - manifest.longitudeStepDegrees / 2,
    south: manifest.lastLatitudeDegrees - manifest.latitudeStepDegrees / 2,
    east: manifest.lastLongitudeDegrees + manifest.longitudeStepDegrees / 2,
    north: manifest.firstLatitudeDegrees + manifest.latitudeStepDegrees / 2,
    requiredChunkIndices: manifest.chunks.map((chunk) => chunk.index),
  };
}

export function viewportCoverage(
  manifest: PackedGridManifest,
  bounds: GeographicBounds,
  version: number,
): NationalViewportCoverage {
  assertCoverageVersion(version);
  assertBounds(bounds);
  const domain = completeDomainCoverage(manifest, version);
  const clipped = {
    west: Math.max(bounds.west, domain.west),
    south: Math.max(bounds.south, domain.south),
    east: Math.min(bounds.east, domain.east),
    north: Math.min(bounds.north, domain.north),
  };
  const requiredChunkIndices = clipped.west > clipped.east || clipped.south > clipped.north
    ? []
    : manifest.chunks
      .filter((chunk) => chunkIntersectsBounds(manifest, chunk, clipped))
      .map((chunk) => chunk.index);
  return {
    version,
    kind: "viewport",
    ...clipped,
    requiredChunkIndices,
  };
}

export function assertCoverageMatchesManifest(
  manifest: PackedGridManifest,
  coverage: NationalViewportCoverage,
): readonly PackedGridChunkDescriptor[] {
  assertCoverageVersion(coverage.version);
  assertBounds(coverage);
  if (coverage.requiredChunkIndices.length < 1) {
    throw new Error("National coverage requires at least one chunk");
  }
  const seen = new Set<number>();
  return coverage.requiredChunkIndices.map((index) => {
    if (!Number.isSafeInteger(index) || index < 0 || seen.has(index)) {
      throw new Error("National coverage chunk indices must be unique non-negative integers");
    }
    seen.add(index);
    const descriptor = manifest.chunks[index];
    if (!descriptor || descriptor.index !== index) {
      throw new Error(`National coverage references unavailable chunk ${index}`);
    }
    return descriptor;
  });
}

function chunkIntersectsBounds(
  manifest: PackedGridManifest,
  chunk: PackedGridChunkDescriptor,
  bounds: GeographicBounds,
): boolean {
  const halfLongitudeStep = manifest.longitudeStepDegrees / 2;
  const halfLatitudeStep = manifest.latitudeStepDegrees / 2;
  const west = manifest.firstLongitudeDegrees
    + chunk.interiorX * manifest.longitudeStepDegrees
    - halfLongitudeStep;
  const east = manifest.firstLongitudeDegrees
    + (chunk.interiorX + chunk.interiorWidth - 1) * manifest.longitudeStepDegrees
    + halfLongitudeStep;
  const north = manifest.firstLatitudeDegrees
    - chunk.interiorY * manifest.latitudeStepDegrees
    + halfLatitudeStep;
  const south = manifest.firstLatitudeDegrees
    - (chunk.interiorY + chunk.interiorHeight - 1) * manifest.latitudeStepDegrees
    - halfLatitudeStep;
  return east >= bounds.west
    && west <= bounds.east
    && north >= bounds.south
    && south <= bounds.north;
}

function assertCoverageVersion(version: number) {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("National coverage version must be a positive safe integer");
  }
}

function assertBounds(bounds: GeographicBounds) {
  if (
    !Number.isFinite(bounds.west)
    || !Number.isFinite(bounds.south)
    || !Number.isFinite(bounds.east)
    || !Number.isFinite(bounds.north)
    || bounds.west < -180
    || bounds.east > 180
    || bounds.south < -90
    || bounds.north > 90
    || bounds.west > bounds.east
    || bounds.south > bounds.north
  ) {
    throw new Error("National coverage bounds are invalid");
  }
}
