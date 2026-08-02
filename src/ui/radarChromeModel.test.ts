import { describe, expect, it } from "vitest";
import {
  formatAge,
  freshnessPresentation,
  normalizeRadarSite,
  paintedFrameIndex,
  playbackPresentation,
  radarProductLabel,
  rendererFailureMessage,
} from "./radarChromeModel";

describe("radar chrome model", () => {
  it("restores only strict four-character US NEXRAD site identifiers", () => {
    expect(normalizeRadarSite(" ktlx ")).toBe("KTLX");
    expect(normalizeRadarSite("K1N2")).toBe("K1N2");
    expect(normalizeRadarSite("TLX")).toBe("KTLX");
    expect(normalizeRadarSite("../../secret")).toBe("KTLX");
  });

  it("follows the last painted observation rather than the requested selection", () => {
    const frames = [
      { observationId: "old", observedAtUnixMs: 1 },
      { observationId: "painted", observedAtUnixMs: 2 },
      { observationId: "requested", observedAtUnixMs: 3 },
    ];
    expect(paintedFrameIndex(frames, {
      playing: false,
      selectedObservationId: "requested",
      lastPaintedObservationId: "painted",
    })).toBe(1);
  });

  it("labels the product that actually painted", () => {
    expect(radarProductLabel("reflectivity")).toBe("REFLECTIVITY");
    expect(radarProductLabel("storm_relative_velocity")).toBe("STORM-RELATIVE VELOCITY");
  });

  it("surfaces only an active renderer failure", () => {
    expect(rendererFailureMessage(undefined)).toBeNull();
    expect(rendererFailureMessage({ status: "painted", error: "old failure" })).toBeNull();
    expect(rendererFailureMessage({ status: "error", error: "GPU completion fence failed" }))
      .toBe("GPU completion fence failed");
    expect(rendererFailureMessage({ status: "error" })).toBe("Radar renderer failed");
  });

  it("labels newest paused state from the painted frame position", () => {
    expect(playbackPresentation({ playing: false }, 19, 20)).toBe("PAUSED · NEWEST");
    expect(playbackPresentation({ playing: false }, 4, 20)).toBe("PAUSED");
    expect(playbackPresentation({ playing: true }, 4, 20)).toBe("PLAYING");
  });

  it("keeps archive, acquisition, failure, and live freshness explicit", () => {
    expect(freshnessPresentation("archive", 0, 100_000).label).toBe("ARCHIVE LOOP");
    expect(freshnessPresentation("updating", undefined, 100_000).label).toBe("UPDATING LIVE");
    expect(freshnessPresentation("error", undefined, 100_000).label).toBe("RADAR ERROR");
    expect(freshnessPresentation("live", 60_000, 100_000)).toEqual({
      kind: "fresh",
      label: "FRESH · 00:40",
    });
  });

  it("formats longer ages without pretending they are minute-second values", () => {
    expect(formatAge(59)).toBe("00:59");
    expect(formatAge(3_661)).toBe("1h 01m");
    expect(formatAge(172_800)).toBe("2d");
  });
});
