import { describe, expect, it } from "vitest";
import type { PackedGridChunk, PackedGridManifest } from "../packed-grid/packedGrid";
import type { NationalPaintReceipt } from "./NationalGridLayer";
import { NationalWorkingSetController } from "./NationalWorkingSetController";

function fixture(): { manifest: PackedGridManifest; chunks: PackedGridChunk[] } {
  const width = 1_750;
  const height = 875;
  const descriptors = [];
  const chunks: PackedGridChunk[] = [];
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 7; x += 1) {
      const index = y * 7 + x;
      const interiorX = x * 256;
      const interiorY = y * 256;
      const interiorWidth = Math.min(256, width - interiorX);
      const interiorHeight = Math.min(256, height - interiorY);
      const haloX = Math.max(0, interiorX - 1);
      const haloY = Math.max(0, interiorY - 1);
      const haloWidth = Math.min(width, interiorX + interiorWidth + 1) - haloX;
      const haloHeight = Math.min(height, interiorY + interiorHeight + 1) - haloY;
      const descriptor = {
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
        payloadSha256: index.toString(16).padStart(2, "0").repeat(32),
      };
      descriptors.push(descriptor);
      chunks.push({
        schemaVersion: 1,
        generation: 9n,
        observationTimeUnixMs: 1_785_775_692_000n,
        contentSha256: "ab".repeat(32),
        width,
        height,
        presentationFactor: 4,
        descriptor,
        bitDepth: 16,
        referenceValue: -9990,
        binaryScale: 0,
        decimalScale: 1,
        missingRaw: 9000,
        noCoverageRaw: 0,
        rawCodes: new Uint16Array(haloWidth * haloHeight),
      });
    }
  }
  return {
    manifest: {
      schemaVersion: 1,
      generation: 9n,
      sourceKind: "national_mrms",
      domain: "conus",
      product: "MergedBaseReflectivityQC_00.50",
      provider: "noaa-mrms-pds.s3.amazonaws.com",
      objectKey: "CONUS/MergedBaseReflectivityQC_00.50/20260803/MRMS_MergedBaseReflectivityQC_00.50_20260803-162812.grib2.gz",
      observationTimeUnixMs: 1_785_775_692_000n,
      contentSha256: "ab".repeat(32),
      width,
      height,
      firstLatitudeDegrees: 54.98,
      firstLongitudeDegrees: -129.98,
      lastLatitudeDegrees: 20.02,
      lastLongitudeDegrees: -60.02,
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
      chunks: descriptors,
    },
    chunks,
  };
}

describe("NationalWorkingSetController", () => {
  it("uploads every required chunk before requesting one complete paint receipt", async () => {
    const { manifest, chunks } = fixture();
    const events: string[] = [];
    const released = new Set<number>();
    const client = {
      async requestNationalManifest() {
        return {
          packed: manifest,
          wireBytes: 500,
          timing: { invokeMs: 1, parseMs: 1, totalMs: 2 },
          async release() { events.push("release-manifest"); },
        };
      },
      async requestNationalChunk(index: number) {
        return {
          packed: chunks[index],
          wireBytes: chunks[index].descriptor.encodedLength,
          timing: { invokeMs: 1, parseMs: 1, totalMs: 2 },
          async release() {
            released.add(index);
            events.push(`release-${index}`);
          },
        };
      },
    };
    let staged = 0;
    let commits = 0;
    const receipt: NationalPaintReceipt = {
      generation: 9,
      observationId: `${manifest.observationTimeUnixMs}:${manifest.contentSha256}`,
      observationTimeUnixMs: Number(manifest.observationTimeUnixMs),
      contentSha256: manifest.contentSha256,
      presentationFactor: 4,
      coverageVersion: 1,
      coverageKind: "complete_domain",
      requiredChunkCount: 28,
      contextEpoch: 1,
      drawSequence: 1,
      completedAtUnixMs: Date.now(),
      stagingDurationMs: 20,
      maximumUploadSliceMs: 0.5,
      uploadedBytes: chunks.reduce((total, chunk) => total + chunk.rawCodes.byteLength, 0),
      framebufferWidth: 3840,
      framebufferHeight: 2160,
    };
    const layer = {
      beginStaging() { events.push("begin"); },
      async uploadStagedChunk(chunk: PackedGridChunk) {
        expect(released.has(chunk.descriptor.index)).toBe(false);
        staged += 1;
        events.push(`upload-${chunk.descriptor.index}`);
      },
      async commitStaging() {
        expect(staged).toBe(28);
        commits += 1;
        events.push("commit");
        return receipt;
      },
      rollbackStaging() { events.push("rollback"); },
    };
    const controller = new NationalWorkingSetController(client, layer);
    const result = await controller.stageCompleteOverview(() => {});
    expect(result.chunkCount).toBe(28);
    expect(staged).toBe(28);
    expect(commits).toBe(1);
    expect(released.size).toBe(28);
    expect(events.indexOf("commit")).toBeGreaterThan(events.indexOf("release-27"));
  });

  it("releases the owned lease and rolls back when staging is cancelled", async () => {
    const { manifest, chunks } = fixture();
    let releases = 0;
    let rollbacks = 0;
    const client = {
      async requestNationalManifest() {
        return {
          packed: manifest,
          wireBytes: 500,
          timing: { invokeMs: 1, parseMs: 1, totalMs: 2 },
          async release() { releases += 1; },
        };
      },
      async requestNationalChunk(index: number) {
        return {
          packed: chunks[index],
          wireBytes: chunks[index].descriptor.encodedLength,
          timing: { invokeMs: 1, parseMs: 1, totalMs: 2 },
          async release() { releases += 1; },
        };
      },
    };
    const layer = {
      beginStaging() {},
      async uploadStagedChunk() { throw new Error("cancelled upload"); },
      async commitStaging(): Promise<NationalPaintReceipt> {
        throw new Error("partial staging must never commit");
      },
      rollbackStaging() { rollbacks += 1; },
    };
    const controller = new NationalWorkingSetController(client, layer);
    await expect(controller.stageCompleteOverview(() => {})).rejects.toThrow("cancelled upload");
    expect(releases).toBe(2);
    expect(rollbacks).toBe(1);
  });
});
