import { describe, expect, it } from "vitest";
import { consumePipelinedLeases } from "./transferPipeline";

describe("two-credit radar transfer pipeline", () => {
  it("overlaps requests with upload while retaining at most two credits and upload order", async () => {
    let held = 0;
    let peak = 0;
    const requested: number[] = [];
    const uploaded: number[] = [];
    await consumePipelinedLeases([0, 1, 2, 3], async id => {
      requested.push(id); peak = Math.max(peak, ++held);
      return { id, async release() { held--; } };
    }, async lease => {
      if (lease.id === 0) expect(requested).toEqual([0, 1]);
      uploaded.push(lease.id);
    });
    expect(uploaded).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
    expect(held).toBe(0);
  });

  it("drains speculative leases when upload fails, without starting more work", async () => {
    const released: number[] = [];
    const requested: number[] = [];
    await expect(consumePipelinedLeases([0, 1, 2], async id => {
      requested.push(id);
      return { async release() { released.push(id); } };
    }, async () => { throw new Error("superseded"); })).rejects.toThrow("superseded");
    expect(requested).toEqual([0, 1]);
    expect(released.sort()).toEqual([0, 1]);
  });

  it("handles an early rejected prefetch and releases the current lease", async () => {
    let released = false;
    await expect(consumePipelinedLeases([0, 1], async id => {
      if (id === 1) throw new Error("download failed");
      return { async release() { released = true; } };
    }, async () => {})).rejects.toThrow("download failed");
    expect(released).toBe(true);
  });

  it("does not admit a third request when a release acknowledgment fails", async () => {
    const released: number[] = [];
    const requested: number[] = [];
    await expect(consumePipelinedLeases([0, 1, 2], async id => {
      requested.push(id);
      return { async release() { released.push(id); if (!id) throw new Error("ack failed"); } };
    }, async () => {})).rejects.toThrow("ack failed");
    expect(requested).toEqual([0, 1]);
    expect(released).toEqual([0, 1]);
  });
});
