import { describe, expect, it } from "vitest";
import type { RadarSweepCpuModel } from "../radar-renderer/cpuModel";
import {
  appendLiveHistory,
  beginLiveHistory,
  MAX_LIVE_HISTORY_FRAMES,
} from "./liveHistory";

describe("bounded live history", () => {
  it("normalizes one site session to a stable renderer generation", () => {
    const history = beginLiveHistory(model(1, 11n), 42);
    const update = appendLiveHistory(history, model(2, 12n));

    expect(update.appended).toBe(true);
    expect(update.frames.map((frame) => frame.generation)).toEqual([42n, 42n]);
    expect(update.frames.map((frame) => frame.observationId)).toEqual([
      observationId(1),
      observationId(2),
    ]);
  });

  it("deduplicates the same measured observation without mutating history", () => {
    const history = beginLiveHistory(model(1), 7);
    const update = appendLiveHistory(history, model(1, 99n));

    expect(update).toEqual({
      frames: history,
      appended: false,
      evictedObservationIds: [],
    });
  });

  it("evicts only the oldest observation at the twenty-frame bound", () => {
    let history = beginLiveHistory(model(1), 7);
    for (let index = 2; index <= MAX_LIVE_HISTORY_FRAMES; index += 1) {
      history = appendLiveHistory(history, model(index)).frames;
    }
    const update = appendLiveHistory(history, model(MAX_LIVE_HISTORY_FRAMES + 1));

    expect(update.frames).toHaveLength(MAX_LIVE_HISTORY_FRAMES);
    expect(update.evictedObservationIds).toEqual([observationId(1)]);
    expect(update.frames[0].observationId).toBe(observationId(2));
    expect(update.frames.at(-1)?.observationId).toBe(observationId(21));
  });

  it("rejects out-of-order and cross-site observations", () => {
    const history = beginLiveHistory(model(2), 7);
    expect(() => appendLiveHistory(history, model(1))).toThrow("not newer");
    expect(() => appendLiveHistory(history, { ...model(3), siteIcao: "KOUN" }))
      .toThrow("render key");
    expect(() => beginLiveHistory({
      ...model(1),
      sourceKind: "nexrad_level2_archive_ii",
    }, 7)).toThrow("reflectivity only");
  });
});

function model(index: number, generation = 1n): RadarSweepCpuModel {
  return {
    observationId: observationId(index),
    siteIcao: "KTLX",
    product: "reflectivity",
    units: "dBZ",
    sourceKind: "nexrad_level2_chunks",
    generation,
    observedAtUnixMs: 1_700_000_000_000 + index * 60_000,
    volumeEndedAtUnixMs: 1_700_000_030_000 + index * 60_000,
    center: { longitude: -97.27776, latitude: 35.333363 },
    scale: 2,
    offset: 66,
  } as RadarSweepCpuModel;
}

function observationId(index: number): string {
  return index.toString(16).padStart(32, "0");
}
