import type { PackedSweep } from "../packed-sweep/packedSweep";
import {
  AZIMUTH_LOOKUP_SIZE,
  angularDistanceDegrees,
  buildAzimuthLookup,
  destinationPoint,
  gateIndexForRange,
  groundRangeForSlantRange,
  radialFromLookup,
  rangeBearing,
  slantRangeForGroundRange,
  type LngLatPoint,
} from "./geo";
import { PALETTE_WIDTH, paletteColor, type Rgba } from "./palette";

export type GateStatusName = "valid" | "below_threshold" | "range_folded";

export interface RadarSweepCpuModel {
  observationId: string;
  siteIcao: string;
  product: "reflectivity";
  units: "dBZ";
  sourceKind: "nexrad_level2_archive_ii" | "mistr_phase2_synthetic";
  generation: bigint;
  center: LngLatPoint;
  radialCount: number;
  gateCount: number;
  gateSpacingM: number;
  firstGateCenterM: number;
  maxRangeM: number;
  scale: number;
  offset: number;
  rawCodes: Uint8Array;
  statuses: Uint8Array;
  azimuths: Float32Array;
  beamWidths: Float32Array;
  elevations: Float32Array;
  azimuthLookup: Uint16Array;
  maxSlantRangeM: number;
  cpuBytes: number;
  estimatedGpuBytes: number;
}

export interface GateInterrogation {
  radialIndex: number;
  gateIndex: number;
  sourceAzimuthDegrees: number;
  slantRangeM: number;
  groundRangeM: number;
  rawCode: number;
  status: GateStatusName;
  value: number | null;
  units: "dBZ";
  color: Rgba;
}

export interface GateAnchor {
  id: string;
  radialIndex: number;
  gateIndex: number;
  longitude: number;
  latitude: number;
  expectedSlantRangeM: number;
  expectedGroundRangeM: number;
  recoveredRangeErrorM: number;
  recoveredBearingErrorDegrees: number;
  selectedCorrectGate: boolean;
}

export interface AlignmentReport {
  anchors: GateAnchor[];
  maximumRangeErrorM: number;
  maximumBearingErrorDegrees: number;
  allSelectedCorrectGate: boolean;
}

export function createRadarSweepCpuModel(sweep: PackedSweep): RadarSweepCpuModel {
  const metadata = sweep.metadata;
  if (metadata.product !== "reflectivity" || metadata.units !== "dBZ") {
    throw new RadarModelError("unsupported_product", "Phase 3 accepts reflectivity only");
  }
  if (metadata.dataWordSizeBits !== 8 || !(sweep.rawCodes instanceof Uint8Array)) {
    throw new RadarModelError(
      "unsupported_encoding",
      "Phase 3 reflectivity requires its lossless native 8-bit raw encoding",
    );
  }
  if (metadata.scale <= 0) {
    throw new RadarModelError("unsupported_encoding", "reflectivity scale must be positive");
  }
  const radials = Array.from(
    { length: metadata.radialCount },
    (_, index) => sweep.radial(index),
  );
  const azimuths = Float32Array.from(radials, (radial) => radial.azimuthDegrees);
  const beamWidths = Float32Array.from(radials, (radial) => radial.beamWidthDegrees);
  const elevations = Float32Array.from(radials, (radial) => radial.elevationDegrees);
  const rawCodes = sweep.rawCodes.slice();
  const statuses = sweep.statuses.slice();
  const azimuthLookup = buildAzimuthLookup(radials, AZIMUTH_LOOKUP_SIZE);
  const maxSlantRangeM = metadata.firstGateCenterM
    + (metadata.gateCount - 0.5) * metadata.gateSpacingM;
  let maxRangeM = 0;
  for (const elevation of elevations) {
    maxRangeM = Math.max(
      maxRangeM,
      groundRangeForSlantRange(maxSlantRangeM, elevation),
    );
  }
  const cpuBytes = rawCodes.byteLength + statuses.byteLength + azimuths.byteLength
    + beamWidths.byteLength + elevations.byteLength + azimuthLookup.byteLength;
  const estimatedGpuBytes = rawCodes.byteLength + statuses.byteLength
    + azimuthLookup.byteLength + elevations.byteLength
    + PALETTE_WIDTH * 4 + 6 * 2 * 4;
  return {
    observationId: metadata.observationId,
    siteIcao: metadata.siteIcao,
    product: "reflectivity",
    units: "dBZ",
    sourceKind: metadata.sourceKind,
    generation: metadata.generation,
    center: {
      longitude: metadata.radarLongitudeDegrees,
      latitude: metadata.radarLatitudeDegrees,
    },
    radialCount: metadata.radialCount,
    gateCount: metadata.gateCount,
    gateSpacingM: metadata.gateSpacingM,
    firstGateCenterM: metadata.firstGateCenterM,
    maxRangeM,
    scale: metadata.scale,
    offset: metadata.offset,
    rawCodes,
    statuses,
    azimuths,
    beamWidths,
    elevations,
    azimuthLookup,
    maxSlantRangeM,
    cpuBytes,
    estimatedGpuBytes,
  };
}

export function interrogateLngLat(
  model: RadarSweepCpuModel,
  point: LngLatPoint,
): GateInterrogation | null {
  const measured = rangeBearing(model.center, point);
  const radialIndex = radialFromLookup(model.azimuthLookup, measured.bearingDegrees);
  if (radialIndex === null) {
    return null;
  }
  const slantRangeM = slantRangeForGroundRange(
    measured.rangeM,
    model.elevations[radialIndex],
  );
  const gateIndex = gateIndexForRange(
    slantRangeM,
    model.firstGateCenterM,
    model.gateSpacingM,
    model.gateCount,
  );
  if (gateIndex === null) {
    return null;
  }
  return interrogateGate(
    model,
    radialIndex,
    gateIndex,
    slantRangeM,
    measured.rangeM,
  );
}

export function interrogateGate(
  model: RadarSweepCpuModel,
  radialIndex: number,
  gateIndex: number,
  slantRangeM = model.firstGateCenterM + gateIndex * model.gateSpacingM,
  groundRangeM = groundRangeForSlantRange(
    slantRangeM,
    model.elevations[radialIndex],
  ),
): GateInterrogation {
  if (
    !Number.isInteger(radialIndex) || radialIndex < 0 || radialIndex >= model.radialCount
    || !Number.isInteger(gateIndex) || gateIndex < 0 || gateIndex >= model.gateCount
  ) {
    throw new RangeError("radial or gate index is out of bounds");
  }
  const cell = radialIndex * model.gateCount + gateIndex;
  const rawCode = model.rawCodes[cell];
  const statusCode = model.statuses[cell];
  const status = gateStatusName(statusCode);
  return {
    radialIndex,
    gateIndex,
    sourceAzimuthDegrees: model.azimuths[radialIndex],
    slantRangeM,
    groundRangeM,
    rawCode,
    status,
    value: status === "valid" ? Math.fround((rawCode - model.offset) / model.scale) : null,
    units: "dBZ",
    color: paletteColor(rawCode, statusCode, model.scale, model.offset),
  };
}

export function createAlignmentReport(model: RadarSweepCpuModel): AlignmentReport {
  const radialIndices = uniqueSorted([
    0,
    Math.floor(model.radialCount / 4),
    Math.floor(model.radialCount / 2),
    Math.floor(model.radialCount * 3 / 4),
    model.radialCount - 1,
  ]);
  const gateIndices = uniqueSorted([
    0,
    Math.min(model.gateCount - 1, Math.floor(115_000 / model.gateSpacingM)),
  ]);
  const anchors: GateAnchor[] = [];
  for (const radialIndex of radialIndices) {
    for (const gateIndex of gateIndices) {
      const expectedSlantRangeM = model.firstGateCenterM
        + gateIndex * model.gateSpacingM;
      const expectedGroundRangeM = groundRangeForSlantRange(
        expectedSlantRangeM,
        model.elevations[radialIndex],
      );
      const point = destinationPoint(
        model.center,
        model.azimuths[radialIndex],
        expectedGroundRangeM,
      );
      const recovered = rangeBearing(model.center, point);
      const selected = interrogateLngLat(model, point);
      anchors.push({
        id: `r${radialIndex}-g${gateIndex}`,
        radialIndex,
        gateIndex,
        longitude: point.longitude,
        latitude: point.latitude,
        expectedSlantRangeM,
        expectedGroundRangeM,
        recoveredRangeErrorM: Math.abs(recovered.rangeM - expectedGroundRangeM),
        recoveredBearingErrorDegrees: angularDistanceDegrees(
          recovered.bearingDegrees,
          model.azimuths[radialIndex],
        ),
        selectedCorrectGate: selected?.radialIndex === radialIndex
          && selected.gateIndex === gateIndex,
      });
    }
  }
  return {
    anchors,
    maximumRangeErrorM: Math.max(...anchors.map((anchor) => anchor.recoveredRangeErrorM)),
    maximumBearingErrorDegrees: Math.max(
      ...anchors.map((anchor) => anchor.recoveredBearingErrorDegrees),
    ),
    allSelectedCorrectGate: anchors.every((anchor) => anchor.selectedCorrectGate),
  };
}

export class RadarModelError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RadarModelError";
  }
}

function gateStatusName(code: number): GateStatusName {
  if (code === 0) return "valid";
  if (code === 1) return "below_threshold";
  if (code === 2) return "range_folded";
  throw new RadarModelError("invalid_status", `unsupported gate status ${code}`);
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}
