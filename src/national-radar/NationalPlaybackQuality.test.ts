import { describe, expect, it } from "vitest";
import type { NationalHistoryObservation } from "../packed-sweep/transferClient";
import {
  nationalPlaybackDetailCandidates,
  prepareNationalPlaybackQuality,
} from "./NationalPlaybackQuality";
import { observationId } from "./NationalHistoryWorkingSetController";

describe("National playback quality preparation", () => {
  it("leaves existing residency untouched below the sharp threshold", async () => {
    const fixture = qualityFixture();
    const result = await prepareNationalPlaybackQuality({
      ...fixture.options,
      zoom: 5.9,
    });

    expect(result).toEqual({ factor: 4, projectedGpuBytes: 0, detailedObservationCount: 0 });
    // No selection, no staging, no pruning: a complete-domain refined
    // presentation survives a home-view playback session intact.
    expect(fixture.events).toEqual([]);
  });

  it("prefetches exact viewport detail for every retained observation without painting", async () => {
    const fixture = qualityFixture({ 1: 120_000_000 });
    const result = await prepareNationalPlaybackQuality({
      ...fixture.options,
      zoom: 7,
    });

    expect(result).toEqual({
      factor: 1,
      projectedGpuBytes: 120_000_000,
      detailedObservationCount: 3,
    });
    expect(fixture.events).toEqual([
      "prefetch:3:1",
      "prune:3",
      "prefetch:1:1",
      "prefetch:2:1",
    ]);
  });

  it("falls back atomically to factor 2 when exact all-frame detail exceeds the target", async () => {
    const fixture = qualityFixture({ 1: 230_000_000, 2: 130_000_000 });
    const result = await prepareNationalPlaybackQuality({
      ...fixture.options,
      zoom: 7,
    });

    expect(result.factor).toBe(2);
    expect(result.projectedGpuBytes).toBe(130_000_000);
    expect(fixture.events).toEqual([
      "prefetch:3:1",
      "prune:3",
      "prune:",
      "prefetch:3:2",
      "prune:3",
      "prefetch:1:2",
      "prefetch:2:2",
    ]);
  });

  it("returns the common factor without selecting when no fine all-frame level fits", async () => {
    const fixture = qualityFixture({ 1: 230_000_000, 2: 210_000_000 });
    const result = await prepareNationalPlaybackQuality({
      ...fixture.options,
      zoom: 7,
    });

    expect(result.factor).toBe(4);
    expect(fixture.events.at(-1)).toBe("prune:");
    expect(fixture.events.some((event) => event.startsWith("select"))).toBe(false);
  });

  it("cleans partial detail when ownership is superseded", async () => {
    const fixture = qualityFixture({ 1: 120_000_000 });
    let checks = 0;

    await expect(prepareNationalPlaybackQuality({
      ...fixture.options,
      zoom: 7,
      ownershipCheck() {
        checks += 1;
        if (checks >= 3) throw new Error("superseded");
      },
    })).rejects.toThrow("superseded");

    expect(fixture.events.at(-1)).toBe("prune:");
  });

  it("requests exact then half-resolution detail only above the regional threshold", () => {
    expect(nationalPlaybackDetailCandidates(5.99)).toEqual([]);
    expect(nationalPlaybackDetailCandidates(6)).toEqual([1, 2]);
  });
});

function qualityFixture(projected: Partial<Record<1 | 2, number>> = {}) {
  const observations = frames(3);
  const selectedObservationId = observationId(observations[2]);
  const events: string[] = [];
  let preparedFactor: 1 | 2 | 4 = 4;
  let detailed = 0;
  return {
    events,
    options: {
      zoom: 7,
      observations,
      selectedObservationId,
      bounds: { west: -102, south: 35, east: -94, north: 42 },
      ownershipCheck() {},
      workingSet: {
        async prefetchDetail(
          observation: NationalHistoryObservation,
          _bounds: unknown,
          _timeline: readonly string[],
          _ownership: () => void,
          factor: 1 | 2 = 1,
        ) {
          if (observationId(observation) === selectedObservationId) {
            preparedFactor = factor;
            detailed = 1;
          } else {
            detailed += 1;
          }
          events.push(`prefetch:${observationId(observation).split(":")[0]}:${factor}`);
          return {} as never;
        },
      },
      layer: {
        finestCompletePlaybackFactor() {
          return detailed === observations.length ? preparedFactor : 4;
        },
        projectedUniformDetailGpuBytes(_id: string, factor: 1 | 2) {
          return projected[factor] ?? 120_000_000;
        },
        pruneDetailResidency(ids: readonly string[]) {
          if (ids.length === 0) {
            preparedFactor = 4;
            detailed = 0;
          }
          events.push(`prune:${ids.map((id) => id.split(":")[0]).join(",")}`);
        },
      },
    },
  };
}

function frames(count: number): NationalHistoryObservation[] {
  return Array.from({ length: count }, (_, index) => ({
    generation: 9,
    objectKey: `object-${index}`,
    observationTimeUnixMs: index + 1,
    contentSha256: (index + 1).toString(16).padStart(64, "0"),
    compressedBytes: 1_000,
    overviewChunkCount: 28,
    overviewGpuBytes: 3_100_000,
  }));
}
