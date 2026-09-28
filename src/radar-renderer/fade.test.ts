import { describe, expect, it } from "vitest";
import { fadeOpacity } from "./fade";

function clock(stepMs: number) {
  let time = 0;
  return {
    now: () => time,
    nextFrame: async () => { time += stepMs; },
  };
}

describe("fadeOpacity", () => {
  it("eases monotonically from start to target and ends exactly on target", async () => {
    const applied: number[] = [];
    const done = await fadeOpacity((value) => applied.push(value), 0, 1, { durationMs: 300, ...clock(16) });
    expect(done).toBe(true);
    expect(applied[0]).toBe(0);
    expect(applied.at(-1)).toBe(1);
    expect(applied.every((value, index) => index === 0 || value >= applied[index - 1])).toBe(true);
    expect(applied.length).toBeGreaterThan(10);
  });

  it("fades out as well as in", async () => {
    const applied: number[] = [];
    await fadeOpacity((value) => applied.push(value), 1, 0, { durationMs: 100, ...clock(25) });
    expect(applied[0]).toBe(1);
    expect(applied.at(-1)).toBe(0);
  });

  it("jumps straight to the target for a zero duration", async () => {
    const applied: number[] = [];
    await fadeOpacity((value) => applied.push(value), 0, 1, { durationMs: 0, ...clock(16) });
    expect(applied).toEqual([0, 1]);
  });

  it("stops without reaching the target once superseded", async () => {
    const applied: number[] = [];
    let frames = 0;
    const done = await fadeOpacity((value) => applied.push(value), 0, 1, {
      durationMs: 300,
      ...clock(16),
      isCurrent: () => (frames += 1) < 4,
    });
    expect(done).toBe(false);
    expect(applied.at(-1)).toBeLessThan(1);
  });
});
