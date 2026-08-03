import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertChunkMatchesManifest,
  PackedGridError,
  parsePackedGridChunk,
  parsePackedGridManifest,
} from "./packedGrid";

const MANIFEST_PATH = new URL(
  "../../fixtures/expected/national-phase2/packed-grid-v1-manifest.bin",
  import.meta.url,
);
const CHUNK_PATH = new URL(
  "../../fixtures/expected/national-phase2/packed-grid-v1-chunk-000.bin",
  import.meta.url,
);

function fixture(path: URL) {
  return Uint8Array.from(readFileSync(path));
}

describe("PackedGrid v1 cross-language wire", () => {
  it("parses the Rust-generated manifest and exact first numeric chunk", async () => {
    const manifest = parsePackedGridManifest(fixture(MANIFEST_PATH));
    const chunk = await parsePackedGridChunk(fixture(CHUNK_PATH));
    assertChunkMatchesManifest(manifest, chunk);

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      generation: 7n,
      sourceKind: "national_mrms",
      domain: "conus",
      product: "MergedBaseReflectivityQC_00.50",
      provider: "noaa-mrms-pds.s3.amazonaws.com",
      observationTimeUnixMs: 1_785_774_492_000n,
      contentSha256: "1826ea8b575cc59c24433ab610197f5a1d5a8d91f20c61cf698ec1d6ff697b76",
      width: 1750,
      height: 875,
      firstLatitudeDegrees: 54.995,
      firstLongitudeDegrees: -129.995,
      lastLatitudeDegrees: 20.035,
      lastLongitudeDegrees: -60.035,
      latitudeStepDegrees: 0.04,
      longitudeStepDegrees: 0.04,
      presentationFactor: 4,
      bitDepth: 16,
      referenceValue: -9990,
      missingRaw: 9000,
      noCoverageRaw: 0,
    });
    expect(manifest.chunks).toHaveLength(28);
    expect(chunk.descriptor).toEqual(manifest.chunks[0]);
    expect(chunk.rawCodes).toHaveLength(chunk.descriptor.haloWidth * chunk.descriptor.haloHeight);
    expect([...chunk.rawCodes.subarray(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("rejects corrupt magic, section bounds, and payload hashes", async () => {
    const magic = fixture(MANIFEST_PATH);
    magic[0] ^= 1;
    expect(() => parsePackedGridManifest(magic)).toThrowError(
      expect.objectContaining({ code: "invalid_magic" }),
    );

    const descriptors = fixture(MANIFEST_PATH);
    new DataView(descriptors.buffer).setUint32(152, 0xfffffff0, false);
    expect(() => parsePackedGridManifest(descriptors)).toThrowError(
      expect.objectContaining({ code: "invalid_descriptor_section" }),
    );

    const reserved = fixture(MANIFEST_PATH);
    const reservedView = new DataView(reserved.buffer);
    reserved[reservedView.getUint32(152, false) + 68] = 1;
    expect(() => parsePackedGridManifest(reserved)).toThrowError(
      expect.objectContaining({ code: "invalid_descriptor_section" }),
    );

    const timestamp = fixture(MANIFEST_PATH);
    const timestampView = new DataView(timestamp.buffer);
    timestampView.setBigInt64(24, timestampView.getBigInt64(24, false) + 1_000n, false);
    expect(() => parsePackedGridManifest(timestamp)).toThrowError(
      expect.objectContaining({ code: "invalid_source" }),
    );

    const payload = fixture(CHUNK_PATH);
    payload[payload.length - 1] ^= 1;
    await expect(parsePackedGridChunk(payload)).rejects.toMatchObject({ code: "hash_mismatch" });
  });

  it("rejects a valid chunk paired with the wrong manifest identity", async () => {
    const manifestBytes = fixture(MANIFEST_PATH);
    const view = new DataView(manifestBytes.buffer);
    view.setBigUint64(16, 8n, false);
    const manifest = parsePackedGridManifest(manifestBytes);
    const chunk = await parsePackedGridChunk(fixture(CHUNK_PATH));
    expect(() => assertChunkMatchesManifest(manifest, chunk)).toThrow(PackedGridError);
  });

  it("derives chunk coordinates from each sequential index", async () => {
    const manifestBytes = fixture(MANIFEST_PATH);
    const manifestView = new DataView(manifestBytes.buffer);
    const descriptorOffset = manifestView.getUint32(152, false);
    const descriptorBytes = manifestView.getUint16(156, false);
    manifestBytes.copyWithin(
      descriptorOffset + descriptorBytes,
      descriptorOffset,
      descriptorOffset + descriptorBytes,
    );
    manifestView.setUint32(descriptorOffset + descriptorBytes, 1, false);
    expect(() => parsePackedGridManifest(manifestBytes)).toThrowError(
      expect.objectContaining({ code: "invalid_chunk_bounds" }),
    );

    const chunkBytes = fixture(CHUNK_PATH);
    new DataView(chunkBytes.buffer).setUint32(80, 1, false);
    await expect(parsePackedGridChunk(chunkBytes)).rejects.toMatchObject({
      code: "invalid_chunk_bounds",
    });
  });
});
