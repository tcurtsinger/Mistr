import { describe, expect, it } from "vitest";
import { validateAlphaLiveSoak } from "./alpha-live-soak-validation.mjs";

function validReport(targetFrames = 4) {
  // Acquisition builds newest-to-oldest; resident playback is oldest-to-newest.
  const buildIds = Array.from(
    { length: targetFrames },
    (_value, index) => `observation-${index + 1}`,
  );
  const ids = [...buildIds].reverse();
  const observedAtUnixMs = ids.map(
    (_observationId, index) => 1_800_000_000_000 + index * 300_000,
  );
  return {
    startup: {
      firstPaintMs: 1_200,
      preparedArchiveFrameCount: 1,
      diskReads: 1,
      bodyText: "LOADING RECENT",
    },
    siteSwitch: {
      pendingTopSite: "KTLX",
      pendingFreshness: "UPDATING KINX",
      finalTopSite: "KTLX",
    },
    historyEvents: buildIds.map((observationId, index) => ({
      residentCount: index + 1,
      site: "KTLX",
      observationId,
      volumeIndex: ((1 - index + 999 * 2) % 999) + 1,
      volumeStartedAtUnixMs: 1_800_000_000_000 - index * 300_000,
    })),
    preRecoveryFrameUploadDelta: targetFrames,
    final: {
      evidence: { observationId: ids.at(-1) },
      receipt: { observationId: ids.at(-1) },
      publicationRenderer: {
        selectedObservationId: ids.at(-1),
        lastPaintedObservationId: ids.at(-1),
      },
      history: {
        residentCount: targetFrames,
        capacity: 20,
        partial: targetFrames < 20,
        observationIds: ids,
        observedAtUnixMs,
      },
      renderer: {
        residentObservationIds: ids,
        metrics: { residentFrameCount: targetFrames, gpuResourceBytes: 10_000_000 },
      },
      timelineText: targetFrames < 20
        ? `${targetFrames} / ${targetFrames} · RECENT ${targetFrames}/20`
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
  it("accepts four current-plus-predecessor resident observations", () => {
    expect(validateAlphaLiveSoak(validReport(), 4)).toEqual([]);
  });

  it("allows context recovery to reorder GPU residency without changing members", () => {
    const report = validReport();
    report.recovery.after.residentObservationIds = [
      "observation-1",
      "observation-4",
      "observation-3",
      "observation-2",
    ];
    expect(validateAlphaLiveSoak(report, 4)).toEqual([]);
  });

  it("accepts full capacity only after the partial-history suffix is removed", () => {
    expect(validateAlphaLiveSoak(validReport(20), 20)).toEqual([]);
    const mislabeled = validReport(20);
    mislabeled.final.timelineText = "20 / 20 · RECENT 20/20";
    expect(validateAlphaLiveSoak(mislabeled, 20))
      .toContain("full live history still has a partial-history suffix");
  });

  it.each([
    ["site claim", (report) => { report.siteSwitch.pendingTopSite = "KINX"; }],
    ["startup", (report) => { report.startup.preparedArchiveFrameCount = 20; }],
    ["history gap", (report) => { report.historyEvents[2].volumeIndex = 7; }],
    ["duplicate", (report) => { report.historyEvents[3].observationId = "observation-3"; }],
    ["chronology", (report) => { report.final.history.observedAtUnixMs[2] = 1; }],
    ["publication pair", (report) => { report.final.receipt.observationId = "wrong-frame"; }],
    ["upload", (report) => { report.preRecoveryFrameUploadDelta = 5; }],
    ["scrub", (report) => { report.scrub.oldestObservationId = "observation-1"; }],
    ["recovery", (report) => { report.recovery.after.residentObservationIds = ["observation-1"]; }],
    ["UI truth", (report) => { report.final.timelineText = "4 / 4"; }],
  ])("rejects %s regression", (_name, mutate) => {
    const report = validReport();
    mutate(report);
    expect(validateAlphaLiveSoak(report, 4)).not.toEqual([]);
  });
});
