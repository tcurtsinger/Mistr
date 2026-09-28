import { describe, expect, it } from "vitest";
import { validateAlphaLiveSoak } from "./alpha-live-soak-validation.mjs";
import { LIVE_HISTORY_CAPACITY } from "./live-history-capacity.mjs";

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
      pendingNotice: "Showing KTLX archive radar while KINX live radar loads.",
      finalTopSite: "KTLX",
    },
    historyEvents: buildIds.map((observationId, index) => ({
      residentCount: index + 1,
      site: "KTLX",
      observationId,
      volumeIndex: ((1 - index + 999 * 2) % 999) + 1,
      volumeStartedAtUnixMs: 1_800_000_000_000 - index * 300_000,
      notice: "Current KTLX radar is ready. Loading recent scans.",
    })),
    historyLoadingNotice: "Current KTLX radar is ready. Loading recent scans.",
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
        capacity: LIVE_HISTORY_CAPACITY,
        partial: targetFrames < LIVE_HISTORY_CAPACITY,
        observationIds: ids,
        observedAtUnixMs,
      },
      renderer: {
        residentObservationIds: ids,
        metrics: { residentFrameCount: targetFrames, gpuResourceBytes: 10_000_000 },
      },
      timelineText: `${targetFrames} / ${targetFrames}`,
      sliderMaximum: targetFrames - 1,
      sliderValue: targetFrames - 1,
      sliderValueText: `Frame ${targetFrames} of ${targetFrames}. 2026-08-02 16:41:01 CDT. Latest live scan, observed 1 minute ago.`,
      frameAge: {
        text: "01:40",
        accessibleName: "Latest live scan, observed 1 minute 40 seconds ago.",
        kind: "current",
      },
      frameAgeCapturedAtUnixMs: observedAtUnixMs.at(-1) + 100_000,
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

  it("accepts full capacity with a matching visible and accessible timeline", () => {
    const full = LIVE_HISTORY_CAPACITY;
    expect(validateAlphaLiveSoak(validReport(full), full)).toEqual([]);
    const mislabeled = validReport(full);
    mislabeled.final.sliderValueText = `Frame ${full - 1} of ${full}`;
    expect(validateAlphaLiveSoak(mislabeled, full))
      .toContain("timeline accessible value does not match the painted newest frame");
  });

  it("rejects the retired 20-frame capacity and targets beyond the product capacity", () => {
    const report = validReport(20);
    report.final.history.capacity = 20;
    expect(validateAlphaLiveSoak(report, 20)).toContain(`live history capacity is not ${LIVE_HISTORY_CAPACITY}`);
    expect(validateAlphaLiveSoak(validReport(4), LIVE_HISTORY_CAPACITY + 1)).toContain("invalid soak target");
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
    ["UI truth", (report) => { report.final.timelineText = "3 / 4"; }],
    ["pending notice", (report) => { report.siteSwitch.pendingNotice = "Loading KINX"; }],
    ["loading notice", (report) => { report.historyLoadingNotice = null; }],
    ["age color", (report) => { report.final.frameAge.kind = "historical"; }],
  ])("rejects %s regression", (_name, mutate) => {
    const report = validReport();
    mutate(report);
    expect(validateAlphaLiveSoak(report, 4)).not.toEqual([]);
  });
});
