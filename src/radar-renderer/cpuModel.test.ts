import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parsePackedSweep, type PackedSweep } from "../packed-sweep/packedSweep";
import {
  createAlignmentReport,
  createRadarSweepCpuModel,
  interrogateGate,
  interrogateLngLat,
  RadarModelError,
} from "./cpuModel";
import { destinationPoint, groundRangeForSlantRange } from "./geo";

const GOLDEN_PATH = new URL(
  "../../fixtures/expected/phase-2/packed-sweep-v1.bin",
  import.meta.url,
);
const N0S_PATH = new URL(
  "../../fixtures/expected/phase-6/ktlx-n0s-packed-sweep-v1.bin",
  import.meta.url,
);

let golden: PackedSweep;

beforeAll(async () => {
  golden = await parsePackedSweep(Uint8Array.from(readFileSync(GOLDEN_PATH)));
});

describe("RadarSweepCpuModel", () => {
  it("retains compact native truth and excludes the packed float-value section", () => {
    const model = createRadarSweepCpuModel(golden);
    expect(model).toMatchObject({
      observationId: "a92d9790232a3941f429fb80f192bbea",
      sourceKind: "mistr_phase2_synthetic",
      radialCount: 2,
      gateCount: 3,
      cpuBytes: 8_228,
      estimatedGpuBytes: 9_300,
    });
    expect([...model.rawCodes]).toEqual([0, 1, 68, 2, 86, 193]);
    expect([...model.statuses]).toEqual([1, 2, 0, 0, 0, 0]);
  });

  it("returns the same source gate, decoded value, status, and palette color", () => {
    const model = createRadarSweepCpuModel(golden);
    expect(interrogateGate(model, 0, 0)).toMatchObject({
      rawCode: 0,
      status: "below_threshold",
      value: null,
      color: [0, 0, 0, 0],
    });
    expect(interrogateGate(model, 0, 1)).toMatchObject({
      rawCode: 1,
      status: "range_folded",
      value: null,
    });
    expect(interrogateGate(model, 1, 2)).toMatchObject({
      rawCode: 193,
      status: "valid",
      value: 63.5,
      units: "dBZ",
    });
  });

  it("recovers exact gates from geodesic map coordinates", () => {
    const model = createRadarSweepCpuModel(golden);
    const point = destinationPoint(
      model.center,
      model.azimuths[1],
      groundRangeForSlantRange(
        model.firstGateCenterM + 2 * model.gateSpacingM,
        model.elevations[1],
      ),
    );
    expect(interrogateLngLat(model, point)).toMatchObject({
      radialIndex: 1,
      gateIndex: 2,
      rawCode: 193,
    });
    const alignment = createAlignmentReport(model);
    expect(alignment.allSelectedCorrectGate).toBe(true);
    expect(alignment.maximumRangeErrorM).toBeLessThan(0.000_01);
    expect(alignment.maximumBearingErrorDegrees).toBeLessThan(1e-9);
  });

  it("returns null outside the sweep range or exact radial beam", () => {
    const model = createRadarSweepCpuModel(golden);
    const distantPoint = destinationPoint(model.center, 45, 15_000_000);
    expect(() => interrogateLngLat(model, distantPoint)).not.toThrow();
    expect(interrogateLngLat(model, distantPoint)).toBeNull();

    model.azimuths[1] = 10;
    model.beamWidths[1] = 1;
    model.azimuthLookup.fill(0);
    const falsePositiveBearing = 10.54;
    const lookupIndex = Math.floor(
      falsePositiveBearing / 360 * model.azimuthLookup.length,
    );
    model.azimuthLookup[lookupIndex] = 2;
    const outsideBeamPoint = destinationPoint(
      model.center,
      falsePositiveBearing,
      groundRangeForSlantRange(model.firstGateCenterM, model.elevations[1]),
    );
    expect(interrogateLngLat(model, outsideBeamPoint)).toBeNull();
  });

  it("rejects unsupported products and invalid statuses", () => {
    const velocity = {
      ...golden,
      metadata: { ...golden.metadata, product: "base_velocity", units: "m/s" },
    } as PackedSweep;
    expect(() => createRadarSweepCpuModel(velocity)).toThrow(RadarModelError);

    const model = createRadarSweepCpuModel(golden);
    model.statuses[5] = 9;
    expect(() => interrogateGate(model, 1, 2)).toThrow("unsupported gate status 9");
  });

  it("retains categorical N0S values and never relabels base velocity as storm-relative", async () => {
    const n0s = await parsePackedSweep(Uint8Array.from(readFileSync(N0S_PATH)));
    const model = createRadarSweepCpuModel(n0s);
    expect(model.product).toBe("storm_relative_velocity");
    expect(model.units).toBe("kt");
    expect(model.sourceKind).toBe("nexrad_level3_n0s");
    expect(model.categoryValues).toBeInstanceOf(Float32Array);
    const validCell = model.statuses.findIndex((status) => status === 0);
    const radialIndex = Math.floor(validCell / model.gateCount);
    const gateIndex = validCell % model.gateCount;
    expect(interrogateGate(model, radialIndex, gateIndex)).toMatchObject({
      rawCode: model.rawCodes[validCell],
      value: model.categoryValues?.[validCell],
      units: "kt",
    });

    const baseVelocity = {
      ...golden,
      metadata: { ...golden.metadata, product: "base_velocity", units: "m/s" },
    } as PackedSweep;
    expect(() => createRadarSweepCpuModel(baseVelocity)).toThrow("reflectivity or explicitly storm-relative");

    const spoofedSource = {
      ...n0s,
      metadata: { ...n0s.metadata, sourceKind: "nexrad_level2_archive_ii" },
    } as PackedSweep;
    expect(() => createRadarSweepCpuModel(spoofedSource)).toThrow(
      "reflectivity or explicitly storm-relative",
    );
  });
});
