import { describe, expect, it } from "vitest";
import type { PackedGridChunk, PackedGridManifest } from "../packed-grid/packedGrid";
import type { NationalHistoryObservation } from "../packed-sweep/transferClient";
import type { NationalPaintReceipt } from "./NationalGridLayer";
import {
  NationalHistoryWorkingSetController,
  observationId,
} from "./NationalHistoryWorkingSetController";

describe("NationalHistoryWorkingSetController", () => {
  it("keeps an initial GPU paint provisional until the backend history commits", async () => {
    const fixture = historyFixture();
    const events: string[] = [];
    const controller = new NationalHistoryWorkingSetController(fixture.client(events), {
      async waitForPaintQuiescence() {},
      beginStaging() { events.push("begin"); },
      async uploadStagedChunk() { events.push("upload"); },
      async commitInitialHistoryStaging() {
        events.push("paint-provisional");
        return fixture.receipt;
      },
      async commitHistoryStaging() { throw new Error("not used"); },
      commitPrefetchedStaging() { throw new Error("not used"); },
      async rollbackHistoryMutation() { events.push("rollback-provisional"); },
      rollbackStaging() { events.push("rollback-staging"); },
    });

    const result = await controller.stageInitialOverview(fixture.observation, () => {});

    expect(result.receipt).toEqual(fixture.receipt);
    expect(result.projectedGpuBytes).toBe(2);
    expect(events).toEqual([
      "release-manifest",
      "begin",
      "upload",
      "release-chunk",
      "paint-provisional",
    ]);
  });

  it("stages a factor-2 viewport as a bounded playback-quality level", async () => {
    const fixture = historyFixture();
    const events: string[] = [];
    const controller = new NationalHistoryWorkingSetController(fixture.client(events), {
      async waitForPaintQuiescence() {},
      beginStaging() { events.push("begin"); },
      async uploadStagedChunk() { events.push("upload"); },
      async commitInitialHistoryStaging() { throw new Error("not used"); },
      async commitHistoryStaging(_timeline, _selected, presentationFactor) {
        expect(presentationFactor).toBe(2);
        return {
          ...fixture.receipt,
          presentationFactor: 2,
          coverageKind: "viewport",
        };
      },
      commitPrefetchedStaging() { throw new Error("not used"); },
      async rollbackHistoryMutation() { throw new Error("not used"); },
      rollbackStaging() { events.push("rollback-staging"); },
    });

    const result = await controller.stageSelectedDetail(
      fixture.observation,
      { west: -130, south: 54, east: -129, north: 55 },
      [observationId(fixture.observation)],
      () => {},
      undefined,
      2,
    );

    expect(result.manifest.presentationFactor).toBe(2);
    expect(result.coverage.kind).toBe("viewport");
    expect(result.projectedGpuBytes).toBe(2);
    expect(events).toContain("upload");
  });

  it("stages camera-independent complete-domain factor-1 detail when bounds are null", async () => {
    const fixture = historyFixture();
    const events: string[] = [];
    const controller = new NationalHistoryWorkingSetController(fixture.client(events), {
      async waitForPaintQuiescence() {},
      beginStaging() { events.push("begin"); },
      async uploadStagedChunk() { events.push("upload"); },
      async commitInitialHistoryStaging() { throw new Error("not used"); },
      async commitHistoryStaging(_timeline, _selected, presentationFactor) {
        expect(presentationFactor).toBe(1);
        return {
          ...fixture.receipt,
          presentationFactor: 1,
          coverageKind: "complete_domain",
        };
      },
      commitPrefetchedStaging() { throw new Error("not used"); },
      async rollbackHistoryMutation() { throw new Error("not used"); },
      rollbackStaging() { events.push("rollback-staging"); },
    });

    const result = await controller.stageSelectedDetail(
      fixture.observation,
      null,
      [observationId(fixture.observation)],
      () => {},
      undefined,
      1,
    );

    expect(result.manifest.presentationFactor).toBe(1);
    expect(result.coverage.kind).toBe("complete_domain");
    expect(result.coverage.requiredChunkIndices).toEqual([0]);
    expect(events).toContain("upload");
  });

  it("stages native factor-1 history and commits it to the common slot", async () => {
    const fixture = historyFixture();
    const events: string[] = [];
    const committedFactors: number[] = [];
    const controller = new NationalHistoryWorkingSetController(fixture.client(events), {
      async waitForPaintQuiescence() {},
      beginStaging() {},
      async uploadStagedChunk() {},
      async commitInitialHistoryStaging() { throw new Error("not used"); },
      async commitHistoryStaging(_timeline, _selected, presentationFactor, deferExternalCommit) {
        committedFactors.push(presentationFactor ?? 4);
        expect(deferExternalCommit).toBe(true);
        return fixture.receipt;
      },
      commitPrefetchedStaging() { throw new Error("not used"); },
      async rollbackHistoryMutation() { throw new Error("not used"); },
      rollbackStaging() {},
    });

    const result = await controller.stageHistoryOverview(
      fixture.observation,
      [observationId(fixture.observation)],
      observationId(fixture.observation),
      () => {},
    );

    // The staged manifest is the exact native grid; the commit selector
    // targets the common slot.
    expect(result.manifest.presentationFactor).toBe(1);
    expect(committedFactors).toEqual([4]);
  });

  it("waits for paint quiescence before beginning any staging", async () => {
    const fixture = historyFixture();
    const events: string[] = [];
    const controller = new NationalHistoryWorkingSetController(fixture.client(events), {
      async waitForPaintQuiescence() { events.push("quiesce"); },
      beginStaging() { events.push("begin"); },
      async uploadStagedChunk() { events.push("upload"); },
      async commitInitialHistoryStaging() { return fixture.receipt; },
      async commitHistoryStaging() { throw new Error("not used"); },
      commitPrefetchedStaging() { throw new Error("not used"); },
      async rollbackHistoryMutation() { throw new Error("not used"); },
      rollbackStaging() {},
    });

    await controller.stageInitialOverview(fixture.observation, () => {});

    expect(events.indexOf("quiesce")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("quiesce")).toBeLessThan(events.indexOf("begin"));
  });

  it("rolls a provisional GPU paint back when ownership is superseded after the fence", async () => {
    const fixture = historyFixture();
    const events: string[] = [];
    let checks = 0;
    const controller = new NationalHistoryWorkingSetController(fixture.client(events), {
      async waitForPaintQuiescence() {},
      beginStaging() {},
      async uploadStagedChunk() {},
      async commitInitialHistoryStaging() { return fixture.receipt; },
      async commitHistoryStaging() { throw new Error("not used"); },
      commitPrefetchedStaging() { throw new Error("not used"); },
      async rollbackHistoryMutation(receipt) {
        expect(receipt).toEqual(fixture.receipt);
        events.push("rollback-provisional");
      },
      rollbackStaging() { events.push("rollback-staging"); },
    });

    await expect(controller.stageInitialOverview(fixture.observation, () => {
      checks += 1;
      if (checks >= 9) throw new Error("superseded");
    })).rejects.toThrow("superseded");

    expect(events).toContain("rollback-provisional");
    expect(events).not.toContain("rollback-staging");
  });
});

function historyFixture() {
  const observation: NationalHistoryObservation = {
    generation: 9,
    objectKey: "CONUS/MergedBaseReflectivityQC_00.50/20260803/MRMS_MergedBaseReflectivityQC_00.50_20260803-162812.grib2.gz",
    observationTimeUnixMs: 1_785_775_692_000,
    contentSha256: "ab".repeat(32),
    compressedBytes: 1_000,
    overviewChunkCount: 1,
    overviewGpuBytes: 2,
  };
  const descriptor = {
    index: 0,
    chunkX: 0,
    chunkY: 0,
    interiorX: 0,
    interiorY: 0,
    interiorWidth: 1,
    interiorHeight: 1,
    haloX: 0,
    haloY: 0,
    haloWidth: 1,
    haloHeight: 1,
    encodedLength: 178,
    payloadSha256: "cd".repeat(32),
  };
  const manifest: PackedGridManifest = {
    schemaVersion: 1,
    generation: 9n,
    sourceKind: "national_mrms",
    domain: "conus",
    product: "MergedBaseReflectivityQC_00.50",
    provider: "noaa-mrms-pds.s3.amazonaws.com",
    objectKey: observation.objectKey,
    observationTimeUnixMs: BigInt(observation.observationTimeUnixMs),
    contentSha256: observation.contentSha256,
    width: 1,
    height: 1,
    firstLatitudeDegrees: 54.98,
    firstLongitudeDegrees: -129.98,
    lastLatitudeDegrees: 54.98,
    lastLongitudeDegrees: -129.98,
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
    chunks: [descriptor],
  };
  const chunk: PackedGridChunk = {
    schemaVersion: 1,
    generation: 9n,
    observationTimeUnixMs: BigInt(observation.observationTimeUnixMs),
    contentSha256: observation.contentSha256,
    width: 1,
    height: 1,
    presentationFactor: 4,
    descriptor,
    bitDepth: 16,
    referenceValue: -9990,
    binaryScale: 0,
    decimalScale: 1,
    missingRaw: 9000,
    noCoverageRaw: 0,
    rawCodes: new Uint16Array([10_000]),
  };
  const receipt: NationalPaintReceipt = {
    generation: 9,
    observationId: observationId(observation),
    observationTimeUnixMs: observation.observationTimeUnixMs,
    contentSha256: observation.contentSha256,
    presentationFactor: 1,
    coverageVersion: 1,
    coverageKind: "complete_domain",
    requiredChunkCount: 1,
    contextEpoch: 1,
    drawSequence: 1,
    completedAtUnixMs: Date.now(),
    stagingDurationMs: 1,
    maximumUploadSliceMs: 0.1,
    uploadedBytes: 2,
    framebufferWidth: 3840,
    framebufferHeight: 2160,
  };
  return {
    observation,
    receipt,
    client(events: string[]) {
      return {
        async prepareNationalHistoryPresentation() { return {} as never; },
        async requestNationalHistoryManifest(
          _observation: NationalHistoryObservation,
          presentationFactor = 4,
        ) {
          return {
            packed: { ...manifest, presentationFactor },
            wireBytes: 1,
            timing: { invokeMs: 0, parseMs: 0, totalMs: 0 },
            async release() { events.push("release-manifest"); },
          };
        },
        async requestNationalHistoryChunk(
          _observation: NationalHistoryObservation,
          _chunkIndex: number,
          presentationFactor = 4,
        ) {
          return {
            packed: { ...chunk, presentationFactor },
            wireBytes: 2,
            timing: { invokeMs: 0, parseMs: 0, totalMs: 0 },
            async release() { events.push("release-chunk"); },
          };
        },
      };
    },
  };
}
