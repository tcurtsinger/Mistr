import { describe, expect, it } from "vitest";
import { validateAlphaLiveSoak } from "./alpha-live-soak-validation.mjs";

function validReport() {
  const ids = ["a", "b", "c", "d"];
  return {
    siteSwitch: { pendingTopSite: "KTLX", pendingFreshness: "UPDATING KOUN", finalTopSite: "KTLX" },
    historyEvents: ids.map((observationId, index) => ({
      residentCount: index + 1,
      site: "KTLX",
      observationId,
      volumeIndex: 998 + index > 999 ? index - 1 : 998 + index,
      volumeStartedAtUnixMs: 1_800_000_000_000 + index * 300_000,
    })),
    preRecoveryFrameUploadDelta: 4,
    final: {
      history: { residentCount: 4, capacity: 20, partial: true },
      renderer: {
        residentObservationIds: ids,
        metrics: { residentFrameCount: 4, gpuResourceBytes: 10_000_000 },
      },
      timelineText: "4 / 4 · BUILDING 4/20",
      bodyText: "LIVE RADAR",
    },
    scrub: { oldestObservationId: "a", newestObservationId: "d" },
    recovery: {
      before: { residentObservationIds: ids },
      recovery: { phase: "ready" },
      after: { residentObservationIds: ids, lastPaintedObservationId: "d" },
    },
    fatalErrors: [],
  };
}

describe("Alpha live soak validation", () => {
  it("accepts four exact-next resident observations", () => {
    expect(validateAlphaLiveSoak(validReport(), 4)).toEqual([]);
  });

  it("uses chronological history for scrub truth after context recovery reorders GPU residency", () => {
    const report = validReport();
    report.final.renderer.residentObservationIds = ["d", "a", "b", "c"];
    report.recovery.after.residentObservationIds = ["d", "a", "b", "c"];
    expect(validateAlphaLiveSoak(report, 4)).toEqual([]);
  });

  it.each([
    ["site claim", (report) => { report.siteSwitch.pendingTopSite = "KOUN"; }],
    ["history gap", (report) => { report.historyEvents[2].volumeIndex = 7; }],
    ["duplicate", (report) => { report.historyEvents[3].observationId = "c"; }],
    ["upload", (report) => { report.preRecoveryFrameUploadDelta = 5; }],
    ["scrub", (report) => { report.scrub.oldestObservationId = "b"; }],
    ["recovery", (report) => { report.recovery.after.residentObservationIds = ["a"]; }],
    ["UI truth", (report) => { report.final.timelineText = "4 / 4"; }],
  ])("rejects %s regression", (_name, mutate) => {
    const report = validReport();
    mutate(report);
    expect(validateAlphaLiveSoak(report, 4)).not.toEqual([]);
  });
});
