import { describe, expect, it } from "vitest";
import { validateAlphaLiveSoak } from "./alpha-live-soak-validation.mjs";

function validReport(targetFrames = 4) {
  const ids = Array.from({ length: targetFrames }, (_value, index) => `observation-${index + 1}`);
  return {
    siteSwitch: { pendingTopSite: "KTLX", pendingFreshness: "UPDATING KOUN", finalTopSite: "KTLX" },
    historyEvents: ids.map((observationId, index) => ({
      residentCount: index + 1,
      site: "KTLX",
      observationId,
      volumeIndex: ((997 + index) % 999) + 1,
      volumeStartedAtUnixMs: 1_800_000_000_000 + index * 300_000,
    })),
    preRecoveryFrameUploadDelta: targetFrames,
    final: {
      history: { residentCount: targetFrames, capacity: 20, partial: targetFrames < 20 },
      renderer: {
        residentObservationIds: ids,
        metrics: { residentFrameCount: targetFrames, gpuResourceBytes: 10_000_000 },
      },
      timelineText: targetFrames < 20
        ? `${targetFrames} / ${targetFrames} · BUILDING ${targetFrames}/20`
        : "20 / 20",
      bodyText: "LIVE RADAR",
    },
    scrub: { oldestObservationId: ids[0], newestObservationId: ids.at(-1) },
    recovery: {
      before: { residentObservationIds: ids },
      recovery: { phase: "ready" },
      after: { residentObservationIds: ids, lastPaintedObservationId: ids.at(-1) },
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
    report.final.renderer.residentObservationIds = ["observation-4", "observation-1", "observation-2", "observation-3"];
    report.recovery.after.residentObservationIds = ["observation-4", "observation-1", "observation-2", "observation-3"];
    expect(validateAlphaLiveSoak(report, 4)).toEqual([]);
  });

  it("accepts full capacity only after the BUILDING label is removed", () => {
    expect(validateAlphaLiveSoak(validReport(20), 20)).toEqual([]);
    const mislabeled = validReport(20);
    mislabeled.final.timelineText = "20 / 20 · BUILDING 20/20";
    expect(validateAlphaLiveSoak(mislabeled, 20)).toContain("full live history is still labeled as building");
  });

  it.each([
    ["site claim", (report) => { report.siteSwitch.pendingTopSite = "KOUN"; }],
    ["history gap", (report) => { report.historyEvents[2].volumeIndex = 7; }],
    ["duplicate", (report) => { report.historyEvents[3].observationId = "observation-3"; }],
    ["upload", (report) => { report.preRecoveryFrameUploadDelta = 5; }],
    ["scrub", (report) => { report.scrub.oldestObservationId = "observation-2"; }],
    ["recovery", (report) => { report.recovery.after.residentObservationIds = ["observation-1"]; }],
    ["UI truth", (report) => { report.final.timelineText = "4 / 4"; }],
  ])("rejects %s regression", (_name, mutate) => {
    const report = validReport();
    mutate(report);
    expect(validateAlphaLiveSoak(report, 4)).not.toEqual([]);
  });
});
