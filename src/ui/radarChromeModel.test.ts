import { describe, expect, it } from "vitest";
import {
  formatAge,
  freshnessPresentation,
  liveFailureLabel,
  userFacingRadarError,
  normalizeRadarSite,
  paintedFrameIndex,
  playbackErrorAfterRendererStatus,
  playbackPresentation,
  radarInitializationLabel,
  rendererFailureMessage,
  timelinePosition,
} from "./radarChromeModel";

describe("radar chrome model", () => {
  it("restores only sites in the provider-qualified operational catalog", () => {
    expect(normalizeRadarSite(" ktlx ")).toBe("KTLX");
    expect(normalizeRadarSite(" pgua ")).toBe("PGUA");
    expect(normalizeRadarSite("KOUN")).toBe("KTLX");
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

  it("surfaces only an active renderer failure", () => {
    expect(rendererFailureMessage(undefined)).toBeNull();
    expect(rendererFailureMessage({ status: "painted", error: "old failure" })).toBeNull();
    expect(rendererFailureMessage({ status: "error", error: "GPU completion fence failed" }))
      .toBe("GPU completion fence failed");
    expect(rendererFailureMessage({ status: "error" })).toBe("Radar renderer failed");
  });

  it("clears a playback failure only after a later authoritative paint", () => {
    expect(playbackErrorAfterRendererStatus("scrub timed out", "recovering"))
      .toBe("scrub timed out");
    expect(playbackErrorAfterRendererStatus("scrub timed out", "error"))
      .toBe("scrub timed out");
    expect(playbackErrorAfterRendererStatus("scrub timed out", "painted")).toBeNull();
  });

  it("labels newest paused state from the painted frame position", () => {
    expect(playbackPresentation({ playing: false }, 19, 20)).toBe("PAUSED · NEWEST");
    expect(playbackPresentation({ playing: false }, 4, 20)).toBe("PAUSED");
    expect(playbackPresentation({ playing: true }, 4, 20)).toBe("PLAYING");
  });

  it("keeps active playback stable through routine GPU paint waits", () => {
    expect(playbackPresentation({
      playing: true,
      holdReason: "AWAITING_GPU_PAINT",
    }, 4, 20)).toBe("PLAYING");
    expect(playbackPresentation({
      playing: false,
      holdReason: "AWAITING_GPU_PAINT",
    }, 4, 20)).toBe("LOADING SCAN");
    expect(playbackPresentation({
      playing: true,
      holdReason: "GPU_RECOVERY_VISIBLE_FIRST",
    }, 4, 20)).toBe("RECOVERING");
  });

  it("turns internal startup stages into visible product-language progress", () => {
    expect(radarInitializationLabel("OPENING RESIDENT LOOP")).toBe("OPENING RADAR HISTORY");
    expect(radarInitializationLabel("DECODING OBSERVATION 12/20"))
      .toBe("LOADING HISTORY 12/20");
    expect(radarInitializationLabel(undefined)).toBe("READYING DISPLAY");
  });

  it("keeps archive, acquisition, failure, and live freshness explicit", () => {
    expect(freshnessPresentation("archive", 0, 100_000).label).toBe("ARCHIVE LOOP");
    expect(freshnessPresentation("archive_frame", 0, 100_000).label).toBe("ARCHIVE FRAME");
    expect(freshnessPresentation("updating", undefined, 100_000).label).toBe("UPDATING LIVE");
    expect(freshnessPresentation("error", undefined, 100_000).label).toBe("RADAR ERROR");
    expect(freshnessPresentation("live", 60_000, 100_000)).toEqual({
      kind: "fresh",
      label: "FRESH · 00:40",
    });
  });

  it("distinguishes a retrying live refresh from an unavailable first acquisition", () => {
    expect(liveFailureLabel("KTLX", true)).toBe("RETRYING KTLX");
    expect(liveFailureLabel("KINX", false)).toBe("KINX UNAVAILABLE");
    expect(() => liveFailureLabel("KOUN", false)).toThrow("supported NEXRAD site");
    expect(() => liveFailureLabel("bad", true)).toThrow("supported NEXRAD site");
  });

  it("keeps product failure copy actionable and free of diagnostic detail", () => {
    expect(userFacingRadarError("initialization")).toContain("Restart Mistr");
    expect(userFacingRadarError("map")).toContain("Check your connection");
    expect(userFacingRadarError("playback")).toContain("last completed scan");
    expect(userFacingRadarError("live_retrying", "KTLX")).toContain("while Mistr retries");
    expect(userFacingRadarError("live_unavailable", "KINX")).toContain("choose the site again");
    expect(() => userFacingRadarError("live_unavailable", "bad")).toThrow("supported NEXRAD site");
  });

  it("makes a partial rolling live loop explicit without hiding playback position", () => {
    expect(timelinePosition(0, 1, 20)).toBe("1 / 1 · BUILDING 1/20");
    expect(timelinePosition(4, 20, 20)).toBe("5 / 20");
    expect(timelinePosition(4, 20)).toBe("5 / 20");
  });

  it("formats longer ages without pretending they are minute-second values", () => {
    expect(formatAge(59)).toBe("00:59");
    expect(formatAge(3_661)).toBe("1h 01m");
    expect(formatAge(172_800)).toBe("2d");
  });
});
