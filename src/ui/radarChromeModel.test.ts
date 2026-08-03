import { describe, expect, it } from "vitest";
import {
  formatAge,
  freshnessPresentation,
  liveFailureLabel,
  userFacingRadarError,
  normalizeRadarSite,
  normalizeRadarDisplayMode,
  paintedFrameIndex,
  playbackErrorAfterRendererStatus,
  playbackPresentation,
  radarDisplayModeLabel,
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

  it("uses concise product labels for each radar display mode", () => {
    expect(normalizeRadarDisplayMode("native")).toBe("native");
    expect(normalizeRadarDisplayMode("smooth")).toBe("smooth");
    expect(normalizeRadarDisplayMode("invalid")).toBe("smooth");
    expect(normalizeRadarDisplayMode(null)).toBe("smooth");
    expect(radarDisplayModeLabel("smooth")).toBe("Smooth");
    expect(radarDisplayModeLabel("native")).toBe("Native");
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

  it("distinguishes a usable live scan from recent-history loading", () => {
    expect(playbackPresentation({ playing: false }, 0, 1, "loading"))
      .toBe("LOADING RECENT");
    expect(playbackPresentation({ playing: false }, 0, 1, "partial"))
      .toBe("WAITING FOR NEXT SCAN");
    expect(playbackPresentation({ playing: false }, 0, 1, "full"))
      .toBe("WAITING FOR NEXT SCAN");
    expect(playbackPresentation({ playing: false }, 0, 1))
      .toBe("PAUSED · NEWEST");
  });

  it("preserves two-or-more-frame playback labels while live history fills", () => {
    expect(playbackPresentation({ playing: false }, 1, 2, "loading"))
      .toBe("PAUSED · NEWEST");
    expect(playbackPresentation({ playing: false }, 0, 2, "partial")).toBe("PAUSED");
    expect(playbackPresentation({ playing: true }, 0, 2, "loading")).toBe("PLAYING");
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
    expect(radarInitializationLabel("LOADING NEWEST SAFE SCAN")).toBe("LOADING SAFE RADAR");
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

  it("makes live history loading and partial availability explicit", () => {
    expect(timelinePosition(0, 1, 20, "loading"))
      .toBe("1 / 1 · LOADING RECENT 1/20");
    expect(timelinePosition(4, 5, 20, "partial"))
      .toBe("5 / 5 · RECENT 5/20");
    expect(timelinePosition(4, 20, 20, "full")).toBe("5 / 20");
    expect(timelinePosition(4, 20, 20, "loading")).toBe("5 / 20");
  });

  it("does not attach live-history language to archive or empty timelines", () => {
    expect(timelinePosition(0, 1, 20)).toBe("1 / 1");
    expect(timelinePosition(0, 1)).toBe("1 / 1");
    expect(timelinePosition(0, 0, 20, "loading")).toBe("0 / 0");
  });

  it("formats longer ages without pretending they are minute-second values", () => {
    expect(formatAge(59)).toBe("00:59");
    expect(formatAge(3_661)).toBe("1h 01m");
    expect(formatAge(172_800)).toBe("2d");
  });
});
