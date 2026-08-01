import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PackedSweepError,
  PACKED_SWEEP_HEADER_BYTES,
  PACKED_SWEEP_MAX_BYTES,
  parsePackedSweep,
} from "./packedSweep";

const GOLDEN_PATH = new URL(
  "../../fixtures/expected/phase-2/packed-sweep-v1.bin",
  import.meta.url,
);
const N0S_PATH = new URL(
  "../../fixtures/expected/phase-6/ktlx-n0s-packed-sweep-v1.bin",
  import.meta.url,
);

function golden(): Uint8Array {
  return Uint8Array.from(readFileSync(GOLDEN_PATH));
}

function expectCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ code });
}

async function rewriteHash(bytes: Uint8Array) {
  const material = new Uint8Array(bytes.length - 32);
  material.set(bytes.subarray(0, 208), 0);
  material.set(bytes.subarray(240), 208);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  bytes.set(digest, 208);
}

describe("parsePackedSweep", () => {
  it("parses the exact Rust golden vector without copying gate sections", async () => {
    const bytes = golden();
    const packed = await parsePackedSweep(bytes);

    expect(packed.metadata).toMatchObject({
      schemaVersion: 1,
      generation: 7n,
      observationId: "a92d9790232a3941f429fb80f192bbea",
      siteIcao: "KTLX",
      product: "reflectivity",
      sourceKind: "mistr_phase2_synthetic",
      radialCount: 2,
      gateCount: 3,
      cellCount: 6,
      totalBytes: 408,
      normalizedSha256: "a92d9790232a3941f429fb80f192bbea152b1ac6282756f6b1cf5e78df93d058",
      wireSha256: "cbf7165bbc718ed590354d2ca299c11d83488bebc706ef37ef294125164787ed",
    });
    expect([...packed.values]).toEqual([0, 0, 1, -32, 10, 63.5]);
    expect([...packed.statuses]).toEqual([1, 2, 0, 0, 0, 0]);
    expect([...packed.rawCodes]).toEqual([0, 1, 68, 2, 86, 193]);
    expect(packed.values.buffer).toBe(bytes.buffer);
    expect(packed.statuses.buffer).toBe(bytes.buffer);
    expect(packed.rawCodes.buffer).toBe(bytes.buffer);
    expect(packed.radial(1)).toEqual({
      sourceAzimuthNumber: 2,
      azimuthDegrees: 0.75,
      beamWidthDegrees: 0.5,
      elevationDegrees: 0.5,
      collectedAtUnixMs: 1_716_246_313_391n,
    });
  });

  it("rejects truncated, oversized, wrong-version, and wrong-endian buffers", async () => {
    await expectCode(parsePackedSweep(new Uint8Array(10)), "truncated_header");
    await expectCode(
      parsePackedSweep(new Uint8Array(PACKED_SWEEP_MAX_BYTES + 1)),
      "payload_too_large",
    );

    const version = golden();
    new DataView(version.buffer).setUint16(12, 2, true);
    await expectCode(parsePackedSweep(version), "unsupported_version");

    const endian = golden();
    new DataView(endian.buffer).setUint32(8, 0x04030201, true);
    await expectCode(parsePackedSweep(endian), "invalid_endian_marker");
  });

  it("rejects unaligned, overlapping, and out-of-bounds section declarations", async () => {
    const unaligned = golden();
    new DataView(unaligned.buffer).setUint32(248, PACKED_SWEEP_HEADER_BYTES + 1, true);
    await expectCode(parsePackedSweep(unaligned), "invalid_section");

    const overlap = golden();
    new DataView(overlap.buffer).setUint32(248, PACKED_SWEEP_HEADER_BYTES, true);
    await expectCode(parsePackedSweep(overlap), "invalid_section");

    const outOfBounds = golden();
    new DataView(outOfBounds.buffer).setUint32(264, 0xfffffff8, true);
    await expectCode(parsePackedSweep(outOfBounds), "invalid_section");
  });

  it("rejects invalid enums and incompatible word-size flags", async () => {
    const product = golden();
    new DataView(product.buffer).setUint16(24, 99, true);
    await expectCode(parsePackedSweep(product), "invalid_product");

    const flags = golden();
    new DataView(flags.buffer).setUint32(20, 2, true);
    await expectCode(parsePackedSweep(flags), "invalid_encoding");
  });

  it("recognizes the Phase 5 real-time chunk source code", async () => {
    const bytes = golden();
    new DataView(bytes.buffer).setUint16(26, 3, true);
    await rewriteHash(bytes);
    const packed = await parsePackedSweep(bytes);
    expect(packed.metadata.sourceKind).toBe("nexrad_level2_chunks");
  });

  it("parses N0S only as storm-relative velocity with knot units", async () => {
    const packed = await parsePackedSweep(Uint8Array.from(readFileSync(N0S_PATH)));
    expect(packed.metadata).toMatchObject({
      product: "storm_relative_velocity",
      units: "kt",
      sourceKind: "nexrad_level3_n0s",
      siteIcao: "KTLX",
      radialCount: 360,
      gateCount: 230,
    });
    expect(packed.rawCodes[0]).toBe(0);
    expect(packed.statuses[0]).toBe(1);
  });

  it("rejects product/source masquerading even with a recomputed hash", async () => {
    const reflectivityAsN0s = golden();
    new DataView(reflectivityAsN0s.buffer).setUint16(26, 4, true);
    await rewriteHash(reflectivityAsN0s);
    await expectCode(parsePackedSweep(reflectivityAsN0s), "invalid_metadata");

    const n0sAsLevel2 = Uint8Array.from(readFileSync(N0S_PATH));
    new DataView(n0sAsLevel2.buffer).setUint16(26, 1, true);
    await rewriteHash(n0sAsLevel2);
    await expectCode(parsePackedSweep(n0sAsLevel2), "invalid_metadata");
  });

  it("rejects inconsistent values for the same N0S category", async () => {
    const bytes = Uint8Array.from(readFileSync(N0S_PATH));
    const view = new DataView(bytes.buffer);
    const valueOffset = view.getUint32(248, true);
    const statusOffset = view.getUint32(256, true);
    const rawOffset = view.getUint32(264, true);
    const firstByCategory = new Map<number, number>();
    let duplicate = -1;
    for (let index = 0; index < view.getUint32(76, true); index += 1) {
      const raw = bytes[rawOffset + index];
      if (bytes[statusOffset + index] !== 0) continue;
      if (firstByCategory.has(raw)) {
        duplicate = index;
        break;
      }
      firstByCategory.set(raw, index);
    }
    expect(duplicate).toBeGreaterThanOrEqual(0);
    view.setFloat32(valueOffset + duplicate * 4, 123.25, true);
    await rewriteHash(bytes);
    await expectCode(parsePackedSweep(bytes), "invalid_gate");
  });

  it("rejects payload corruption by hash", async () => {
    const bytes = golden();
    bytes[PACKED_SWEEP_HEADER_BYTES + 4] ^= 1;
    await expectCode(parsePackedSweep(bytes), "hash_mismatch");
  });

  it("rejects raw/status disagreement even when the wire hash is recomputed", async () => {
    const bytes = golden();
    const view = new DataView(bytes.buffer);
    const statusOffset = view.getUint32(256, true);
    bytes[statusOffset] = 2;
    await rewriteHash(bytes);
    await expectCode(parsePackedSweep(bytes), "invalid_gate");
  });

  it("exposes stable typed errors", () => {
    const error = new PackedSweepError("invalid_magic", "test");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("invalid_magic");
    expect(error.message).toBe("invalid_magic: test");
  });
});
