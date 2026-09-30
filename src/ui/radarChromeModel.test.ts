import { describe, expect, it } from "vitest";
import {
  formatAge,
  formatAccessibleAge,
  frameAgePresentation,
  inspectionReadoutPresentation,
  liveFailureLabel,
  nationalHistoryStatus,
  userFacingRadarError,
  normalizeRadarSite,
  normalizeRadarDisplayMode,
  paintedFrameIndex,
  playbackErrorAfterRendererStatus,
  playbackAnnouncement,
  playbackPresentation,
  radarDisplayModeLabel,
  radarInitializationLabel,
  rendererFailureMessage,
  timelineFill,
} from "./radarChromeModel";

const interrogation = (
  status: "valid" | "below_threshold" | "range_folded" | "missing" | "no_coverage",
  value: number | null = null,
) => ({
  radialIndex: 0,
  gateIndex: 0,
  sourceAzimuthDegrees: 0,
  slantRangeM: 0,
  groundRangeM: 0,
  rawCode: value ?? 0,
  status,
  value,
  units: "dBZ" as const,
  color: [0, 0, 0, 0] as const,
});

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

  it("never presents an exact lookup in progress as outside radar coverage", () => {
    expect(inspectionReadoutPresentation("pending", null)).toEqual({
      accessibleLabel: "Radar sample updating.",
      busy: true,
      kind: "pending",
      label: "--.- dBZ",
    });
    expect(inspectionReadoutPresentation("outside", null)).toMatchObject({
      kind: "status",
      label: "Out of range",
    });
    expect(inspectionReadoutPresentation("unavailable", null)).toMatchObject({
      kind: "status",
      label: "Unavailable",
    });
    expect(inspectionReadoutPresentation("idle", null)).toMatchObject({ kind: "hint", label: "Inspect" });
  });

  it("separates exact values and source-native statuses from UI request state", () => {
    expect(inspectionReadoutPresentation("settled", interrogation("valid", 11.5)))
      .toMatchObject({ kind: "value", label: "11.5 dBZ", valueDbz: 11.5 });
    expect(inspectionReadoutPresentation("settled", interrogation("no_coverage")))
      .toMatchObject({ kind: "status", label: "No coverage" });
    expect(inspectionReadoutPresentation("settled", interrogation("missing")))
      .toMatchObject({ kind: "status", label: "No data" });
    expect(inspectionReadoutPresentation("settled", null))
      .toMatchObject({ kind: "status", label: "Unavailable" });
    expect(inspectionReadoutPresentation("settled", interrogation("no_coverage")).valueDbz).toBeUndefined();
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
      playing: false,
      holdReason: "PREPARING_PLAYBACK_QUALITY",
    }, 4, 20)).toBe("PREPARING PLAYBACK");
    expect(playbackPresentation({
      playing: true,
      holdReason: "GPU_RECOVERY_VISIBLE_FIRST",
    }, 4, 20)).toBe("RECOVERING");
  });

  it("turns internal startup stages into visible product-language progress", () => {
    expect(radarInitializationLabel("OPENING RESIDENT LOOP")).toBe("Opening radar history");
    expect(radarInitializationLabel("LOADING CURRENT RADAR")).toBe("Loading current scan");
    expect(radarInitializationLabel("DECODING OBSERVATION 12/20"))
      .toBe("Loading history 12/20");
    expect(radarInitializationLabel(undefined)).toBe("Preparing the display");
  });

  it("says playback states aloud in sentence case", () => {
    expect(playbackAnnouncement("PLAYING")).toBe("Playing");
    expect(playbackAnnouncement("PAUSED · NEWEST")).toBe("Paused on the newest scan");
    expect(playbackAnnouncement("RECOVERING")).toBe("Restoring the radar display");
    expect(playbackAnnouncement("SOMETHING NEW")).toBe("SOMETHING NEW");
  });

  it("highlights only a recent latest live scan", () => {
    expect(frameAgePresentation(60_000, 100_000, true)).toEqual({
      accessibleLabel: "Latest live scan, observed 40 seconds ago.",
      kind: "current",
      label: "40s ago",
    });
    expect(frameAgePresentation(60_000, 100_000, false)).toEqual({
      accessibleLabel: "Historical scan, observed 40 seconds ago.",
      kind: "historical",
      label: "40s ago",
    });
  });

  it("keeps an old latest scan and archive or scrubbed scans neutral", () => {
    expect(frameAgePresentation(0, 600_000, true).kind).toBe("historical");
    expect(frameAgePresentation(0, 600_000, true).label).toBe("10m 00s ago");
    expect(frameAgePresentation(90_000, 100_000, false).kind).toBe("historical");
    expect(frameAgePresentation(undefined, 100_000, false)).toEqual({
      accessibleLabel: "Displayed scan age unavailable.",
      kind: "historical",
      label: "--",
    });
  });

  it("keeps a three-minute-older National observation truthful and newest for National", () => {
    const now = 1_000_000;
    const site = frameAgePresentation(now - 30_000, now, true);
    const national = frameAgePresentation(
      now - 210_000,
      now,
      true,
      "Newest National observation",
    );
    expect(site).toMatchObject({ kind: "current", label: "30s ago" });
    expect(national).toEqual({
      accessibleLabel: "Newest National observation, observed 3 minutes 30 seconds ago.",
      kind: "current",
      label: "3m 30s ago",
    });
  });

  it("does not expose freshness or playback adjectives in the age label", () => {
    for (const presentation of [
      frameAgePresentation(60_000, 100_000, true),
      frameAgePresentation(60_000, 100_000, false),
      frameAgePresentation(0, 700_000, true),
    ]) {
      expect(presentation.label).not.toMatch(/fresh|stale|paused|newest|playing/i);
    }
  });

  it("distinguishes a retrying live refresh from an unavailable first acquisition", () => {
    expect(liveFailureLabel("KTLX", true)).toBe("Retrying KTLX");
    expect(liveFailureLabel("KINX", false)).toBe("KINX unavailable");
    expect(() => liveFailureLabel("KOUN", false)).toThrow("supported NEXRAD site");
    expect(() => liveFailureLabel("bad", true)).toThrow("supported NEXRAD site");
  });

  it("keeps product failure copy actionable and free of diagnostic detail", () => {
    expect(userFacingRadarError("initialization")).toContain("Restart Mistr");
    expect(userFacingRadarError("map")).toContain("Check your connection");
    expect(userFacingRadarError("playback")).toContain("last completed scan");
    expect(userFacingRadarError("live_retrying", "KTLX")).toContain("while Mistr retries");
    expect(userFacingRadarError("live_unavailable", "KINX")).toContain("choose the site again");
    expect(userFacingRadarError("auto_unavailable", "KGJX"))
      .toBe("KGJX radar is unavailable, so National radar stays displayed.");
    expect(() => userFacingRadarError("live_unavailable", "bad")).toThrow("supported NEXRAD site");
  });

  it("grows a loading history back in time across the whole track", () => {
    expect(timelineFill(12, 60, "loading")).toEqual({
      slots: 60,
      loadedShare: 0.2,
      loadingLabel: "Loading 12/60",
    });
    // A finished or stopped history spans the track with what it has.
    expect(timelineFill(12, 60, "partial")).toEqual({ slots: 12, loadedShare: 1 });
    expect(timelineFill(60, 60, "loading")).toEqual({ slots: 60, loadedShare: 1 });
  });

  it("does not attach live-history language to archive or empty timelines", () => {
    expect(timelineFill(20, undefined, undefined)).toEqual({ slots: 20, loadedShare: 1 });
    expect(timelineFill(1, 60, undefined)).toEqual({ slots: 1, loadedShare: 1 });
    expect(timelineFill(0, 60, "loading")).toEqual({ slots: 1, loadedShare: 1 });
  });

  it("formats longer ages without pretending they are minute-second values", () => {
    expect(formatAge(9)).toBe("9s");
    expect(formatAge(59)).toBe("59s");
    expect(formatAge(61)).toBe("1m 01s");
    expect(formatAge(3_599)).toBe("59m 59s");
    expect(formatAge(3_661)).toBe("1h 01m");
    expect(formatAge(172_800)).toBe("2d");
    expect(formatAccessibleAge(1)).toBe("1 second");
    expect(formatAccessibleAge(61)).toBe("1 minute 1 second");
    expect(formatAccessibleAge(3_661)).toBe("1 hour 1 minute");
    expect(formatAccessibleAge(172_800)).toBe("2 days");
  });

  it("clamps future-clock skew to zero age", () => {
    expect(frameAgePresentation(101_000, 100_000, true).label).toBe("0s ago");
  });

  it("reports National history as loading only while backfill is running", () => {
    expect(nationalHistoryStatus(12, 60, 5, true)).toBe("loading");
    expect(nationalHistoryStatus(12, 60, 5, false)).toBe("partial");
    expect(nationalHistoryStatus(12, 60, 0, true)).toBe("partial");
    expect(nationalHistoryStatus(60, 60, 5, true)).toBe("full");
  });
});
