import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGridChunkBatch } from "./chunkBatch";

const chunk = Uint8Array.from(readFileSync(new URL("../../fixtures/expected/national-phase2/packed-grid-v1-chunk-000.bin", import.meta.url)));
function envelope(chunks: Uint8Array[] = [chunk]): ArrayBuffer {
  const result = new ArrayBuffer(8 + chunks.reduce((sum, item) => sum + 4 + item.length, 0));
  const view = new DataView(result);
  view.setUint32(0, 0x4d474231);
  view.setUint32(4, chunks.length);
  let offset = 8;
  for (const item of chunks) {
    view.setUint32(offset, item.length);
    new Uint8Array(result, offset + 4, item.length).set(item);
    offset += 4 + item.length;
  }
  return result;
}

describe("bounded national batch envelope", () => {
  it("preserves the Rust-generated chunk and generation", async () => {
    const result = await parseGridChunkBatch(envelope(), [0]);
    expect(result.generation).toBe(7n);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].descriptor.index).toBe(0);
  });
  it("validates every payload hash, not only the first", async () => {
    const corrupt = chunk.slice();
    corrupt[corrupt.length - 1] ^= 1;
    await expect(parseGridChunkBatch(envelope([chunk, corrupt]), [0, 0])).rejects.toThrow();
  });
  it("rejects mismatched order and count", async () => {
    await expect(parseGridChunkBatch(envelope(), [1])).rejects.toThrow("identity/order");
    await expect(parseGridChunkBatch(envelope(), [0, 1])).rejects.toThrow("count");
    await expect(parseGridChunkBatch(envelope([]), [])).rejects.toThrow("count");
    await expect(parseGridChunkBatch(envelope(Array(17).fill(chunk)), Array(17).fill(0))).rejects.toThrow("count");
  });
  it("rejects truncated, oversized, trailing and foreign envelopes", async () => {
    for (const length of [0, 4, 8, 10, 20]) {
      await expect(parseGridChunkBatch(envelope().slice(0, length), [0])).rejects.toThrow();
    }
    const oversized = envelope();
    new DataView(oversized).setUint32(8, 0xffffffff);
    await expect(parseGridChunkBatch(oversized, [0])).rejects.toThrow("length");
    const trailing = new Uint8Array(envelope().byteLength + 1);
    trailing.set(new Uint8Array(envelope()));
    await expect(parseGridChunkBatch(trailing.buffer, [0])).rejects.toThrow("trailing");
    const foreign = envelope();
    new DataView(foreign).setUint32(0, 0);
    await expect(parseGridChunkBatch(foreign, [0])).rejects.toThrow("header");
  });
});
