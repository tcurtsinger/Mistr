import { createHash } from "node:crypto";
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

/** The fixture chunk with `codes` filling its payload, rehashed. */
function chunkWithPayload(codes: (index: number) => number, flags: number) {
  const bytes = fixture(CHUNK_PATH);
  const view = new DataView(bytes.buffer);
  const payloadOffset = view.getUint32(128, false);
  for (let index = 0; payloadOffset + index * 2 < bytes.length; index += 1) {
    view.setUint16(payloadOffset + index * 2, codes(index), false);
  }
  bytes.set(createHash("sha256").update(bytes.subarray(payloadOffset)).digest(), 136);
  bytes[113] = flags;
  return bytes;
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
      firstLatitudeDegrees: 54.98,
      firstLongitudeDegrees: -129.98,
      lastLatitudeDegrees: 20.02,
      lastLongitudeDegrees: -60.02,
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

    for (const [offset, value] of [[68, 2], [69, 1]]) {
      const reserved = fixture(MANIFEST_PATH);
      const reservedView = new DataView(reserved.buffer);
      reserved[reservedView.getUint32(152, false) + offset] = value;
      expect(() => parsePackedGridManifest(reserved)).toThrowError(
        expect.objectContaining({ code: "invalid_descriptor_section" }),
      );
    }

    const timestamp = fixture(MANIFEST_PATH);
    const timestampView = new DataView(timestamp.buffer);
    timestampView.setBigInt64(24, timestampView.getBigInt64(24, false) + 1_000n, false);
    expect(() => parsePackedGridManifest(timestamp)).toThrowError(
      expect.objectContaining({ code: "invalid_source" }),
    );

    const uncenteredOverview = fixture(MANIFEST_PATH);
    const uncenteredView = new DataView(uncenteredOverview.buffer);
    uncenteredView.setInt32(40, 54_995_000, false);
    uncenteredView.setInt32(44, -129_995_000, false);
    expect(() => parsePackedGridManifest(uncenteredOverview)).toThrowError(
      expect.objectContaining({ code: "invalid_grid" }),
    );

    const payload = fixture(CHUNK_PATH);
    payload[payload.length - 1] ^= 1;
    await expect(parsePackedGridChunk(payload)).rejects.toMatchObject({ code: "hash_mismatch" });
  });

  it("reads the draws-nothing mark only when the payload backs it", async () => {
    const manifestBytes = fixture(MANIFEST_PATH);
    const descriptorOffset = new DataView(manifestBytes.buffer).getUint32(152, false);
    manifestBytes[descriptorOffset + 72 + 68] = 1;
    const manifest = parsePackedGridManifest(manifestBytes);
    expect(manifest.chunks.map((chunk) => chunk.drawsNothing).slice(0, 3)).toEqual([false, true, false]);

    const empty = await parsePackedGridChunk(chunkWithPayload((index) => (index % 2 ? 9000 : 0), 1));
    expect(empty.descriptor.drawsNothing).toBe(true);
    // Unmarked promises nothing: an empty chunk may still be sent.
    const unmarked = await parsePackedGridChunk(chunkWithPayload(() => 0, 0));
    expect(unmarked.descriptor.drawsNothing).toBe(false);
    await expect(parsePackedGridChunk(chunkWithPayload((index) => (index === 500 ? 10_000 : 0), 1)))
      .rejects.toMatchObject({ code: "invalid_encoding" });
    await expect(parsePackedGridChunk(chunkWithPayload(() => 0, 2)))
      .rejects.toMatchObject({ code: "invalid_record_kind" });
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
