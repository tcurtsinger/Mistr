import { describe, expect, it } from "vitest";
import { nearestFrameIndex, planPlayheadCarry } from "./playheadCarry";

const minute = 60_000;
// Five scans two minutes apart.
const times = [0, 2, 4, 6, 8].map((value) => value * minute);

describe("nearestFrameIndex", () => {
  it("finds the nearest frame and clamps outside the history", () => {
    expect(nearestFrameIndex([], 0)).toBe(-1);
    expect(nearestFrameIndex(times, -5 * minute)).toBe(0);
    expect(nearestFrameIndex(times, 20 * minute)).toBe(4);
    expect(nearestFrameIndex(times, 4 * minute)).toBe(2);
    expect(nearestFrameIndex(times, 4.9 * minute)).toBe(2);
    expect(nearestFrameIndex(times, 5.1 * minute)).toBe(3);
  });

  it("breaks an exact tie toward the older frame", () => {
    expect(nearestFrameIndex(times, 5 * minute)).toBe(2);
    expect(nearestFrameIndex([10, 20], 15)).toBe(0);
  });
});

describe("planPlayheadCarry", () => {
  const paused = (observedAtUnixMs: number, atNewest = false) => ({
    observedAtUnixMs,
    playing: false,
    atNewest,
  });
  const playing = (observedAtUnixMs: number) => ({ observedAtUnixMs, playing: true, atNewest: false });

  it("leaves a source paused on its newest frame alone", () => {
    expect(planPlayheadCarry(paused(8 * minute, true), times, false)).toEqual({ kind: "done" });
  });

  it("keeps a running loop running from the nearest frame once two frames exist", () => {
    expect(planPlayheadCarry(playing(3.1 * minute), [8 * minute], false)).toEqual({ kind: "wait" });
    expect(planPlayheadCarry(playing(3.1 * minute), [8 * minute], true)).toEqual({ kind: "done" });
    expect(planPlayheadCarry(playing(3.1 * minute), [6 * minute, 8 * minute], false))
      .toEqual({ kind: "apply", index: 0, play: true });
    expect(planPlayheadCarry(playing(3.1 * minute), times, false))
      .toEqual({ kind: "apply", index: 2, play: true });
  });

  it("waits for history to reach a paused older frame, then jumps once", () => {
    const target = paused(3.1 * minute);
    expect(planPlayheadCarry(target, [6 * minute, 8 * minute], false)).toEqual({ kind: "wait" });
    expect(planPlayheadCarry(target, [2 * minute, 4 * minute, 6 * minute, 8 * minute], false))
      .toEqual({ kind: "apply", index: 1, play: false });
  });

  it("settles on the oldest frame when history stops short of the target", () => {
    expect(planPlayheadCarry(paused(-30 * minute), times, true))
      .toEqual({ kind: "apply", index: 0, play: false });
    expect(planPlayheadCarry(paused(-30 * minute), [], true)).toEqual({ kind: "done" });
  });
});
