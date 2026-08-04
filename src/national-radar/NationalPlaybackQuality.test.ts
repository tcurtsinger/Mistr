import { describe, expect, it } from "vitest";
import type { NationalHistoryObservation } from "../packed-sweep/transferClient";
import {
  nationalPlaybackDetailCandidates,
  prepareNationalPlaybackQuality,
} from "./NationalPlaybackQuality";
import { observationId } from "./NationalHistoryWorkingSetController";

describe("National playback quality preparation", () => {
  it("returns to the complete overview and releases old regional detail", async () => {
    const fixture = qualityFixture();
    const result = await prepareNationalPlaybackQuality({
      ...fixture.options,
      zoom: 5.9,
    });

    expect(result).toEqual({ factor: 4, projectedGpuBytes: 0, detailedObservationCount: 0 });
    expect(fixture.events).toEqual(["select:3:4", "prune:"]);
  });

  it("prepares exact viewport detail for every retained observation before playback", async () => {
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
      "stage:3:1",
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
      "stage:3:1",
      "prune:3",
      "select:3:4",
      "prune:",
      "stage:3:2",
      "prune:3",
      "prefetch:1:2",
      "prefetch:2:2",
    ]);
  });

  it("restores the complete overview when no fine all-frame level fits", async () => {
    const fixture = qualityFixture({ 1: 230_000_000, 2: 210_000_000 });
    const result = await prepareNationalPlaybackQuality({
      ...fixture.options,
      zoom: 7,
    });

    expect(result.factor).toBe(4);
    expect(fixture.events.slice(-2)).toEqual(["select:3:4", "prune:"]);
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

    expect(fixture.events.slice(-2)).toEqual(["select:3:4", "prune:"]);
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
        async stageSelectedDetail(
          observation: NationalHistoryObservation,
          _bounds: unknown,
          _timeline: readonly string[],
          _ownership: () => void,
          _beforeCommit: undefined,
          factor: 1 | 2 = 1,
        ) {
          preparedFactor = factor;
          detailed = 1;
          events.push(`stage:${observationId(observation).split(":")[0]}:${factor}`);
          return {} as never;
        },
        async prefetchDetail(
          observation: NationalHistoryObservation,
          _bounds: unknown,
          _timeline: readonly string[],
          _ownership: () => void,
          factor: 1 | 2 = 1,
        ) {
          detailed += 1;
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
        async selectResidentAndWait(id: string, factor: number) {
          preparedFactor = factor as 1 | 2 | 4;
          events.push(`select:${id.split(":")[0]}:${factor}`);
          return {} as never;
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
