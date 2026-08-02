import { describe, expect, it } from "vitest";
import {
  beginLiveDisplay,
  beginLiveRefresh,
  failLiveDisplay,
  initialLiveDisplay,
  publishLiveDisplay,
  retainPaintedFallback,
  type PaintedFrameTruth,
} from "./liveDisplayState";

const archiveFrame: PaintedFrameTruth = {
  observationId: "a".repeat(32),
  site: "KTLX",
  source: "nexrad_level2_archive_ii",
  observedAtUnixMs: 1,
  paintedAtUnixMs: 2,
};

const liveFrame: PaintedFrameTruth = {
  observationId: "b".repeat(32),
  site: "KTLX",
  source: "nexrad_level2_chunks",
  observedAtUnixMs: 3,
  paintedAtUnixMs: 4,
};

describe("live display truth", () => {
  it("retains the last complete archive frame through a real-time gap", () => {
    const acquiring = beginLiveDisplay(initialLiveDisplay(archiveFrame), 2, "KTLX", true);
    const degraded = failLiveDisplay(acquiring, 2, "sequence gap");
    expect(degraded.kind).toBe("degraded");
    expect(degraded.lastComplete).toEqual(archiveFrame);
    expect(degraded.fallback).toEqual({
      retainLastComplete: true,
      retainedSource: "nexrad_level2_archive_ii",
      nextFallback: "nexrad_level2_archive",
      terminalFallback: "provider_tiles",
    });
  });

  it("tracks the archive frame that actually paints while live acquisition is pending", () => {
    const acquiring = beginLiveDisplay(initialLiveDisplay(archiveFrame), 2, "KTLX", true);
    const currentArchiveFrame = {
      ...archiveFrame,
      observationId: "c".repeat(32),
      observedAtUnixMs: 5,
      paintedAtUnixMs: 6,
    };
    const synchronized = retainPaintedFallback(acquiring, currentArchiveFrame);
    const degraded = failLiveDisplay(synchronized, 2, "provider timeout");

    expect(degraded.kind).toBe("degraded");
    expect(degraded.lastComplete).toEqual(currentArchiveFrame);
    expect(degraded.lastComplete).not.toEqual(archiveFrame);
  });

  it("ignores late publication and failure from a superseded site generation", () => {
    const oldSite = beginLiveDisplay(initialLiveDisplay(archiveFrame), 2, "KAMX", true);
    const current = beginLiveDisplay(oldSite, 3, "KTLX", true);
    expect(publishLiveDisplay(current, 2, { ...liveFrame, site: "KAMX" })).toBe(current);
    expect(failLiveDisplay(current, 2, "late cancellation")).toBe(current);
  });

  it("labels only a matching safe live frame as painted truth", () => {
    const acquiring = beginLiveDisplay(initialLiveDisplay(archiveFrame), 2, "KTLX", false);
    const painted = publishLiveDisplay(acquiring, 2, liveFrame);
    expect(painted.kind).toBe("painted");
    expect(painted.lastComplete).toEqual(liveFrame);
    expect(() => publishLiveDisplay(acquiring, 2, { ...liveFrame, site: "KOUN" }))
      .toThrow("active site/source");
    const afterDiagnosticFailure = failLiveDisplay(painted, 2, "post-paint diagnostic failed");
    expect(afterDiagnosticFailure).toBe(painted);
    expect(afterDiagnosticFailure).toMatchObject({
      kind: "painted",
      lastComplete: liveFrame,
    });
  });

  it("keeps painted live truth interactive while the next observation is pending", () => {
    const painted = publishLiveDisplay(
      beginLiveDisplay(initialLiveDisplay(archiveFrame), 2, "KTLX", false),
      2,
      liveFrame,
    );
    const refreshing = beginLiveRefresh(painted, 3, "KTLX");

    expect(refreshing).toMatchObject({
      kind: "refreshing",
      generation: 3,
      live: liveFrame,
      lastComplete: liveFrame,
    });
    expect(() => beginLiveRefresh(painted, 3, "KOUN")).toThrow("painted live truth");
  });

  it("synchronizes displayed live truth when playback paints another resident scan", () => {
    const painted = publishLiveDisplay(
      beginLiveDisplay(initialLiveDisplay(archiveFrame), 2, "KTLX", false),
      2,
      liveFrame,
    );
    const olderLiveFrame = {
      ...liveFrame,
      observationId: "d".repeat(32),
      observedAtUnixMs: 2,
      paintedAtUnixMs: 5,
    };

    expect(retainPaintedFallback(painted, olderLiveFrame)).toMatchObject({
      kind: "painted",
      live: olderLiveFrame,
      lastComplete: olderLiveFrame,
    });
  });
});
