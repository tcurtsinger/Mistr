import { describe, expect, it } from "vitest";
import {
  validateNationalPhase4Acceptance,
  validateResidentHandoff,
} from "./national-phase4-packaged-validation.mjs";

function nationalActivity() {
  return {
    networkRequests: 40,
    responseBytes: 90_000_000,
    decoderRuns: 20,
    bulkIpcTransfers: 500,
    bulkIpcBytes: 980_000_000,
    pointLookupDecodes: 0,
  };
}

describe("National Phase 4 packaged acceptance", () => {
  it("accepts bounded resident history, quality locking, recovery, and Site return", () => {
    expect(validateNationalPhase4Acceptance(validReport())).toEqual([]);
  });

  it("rejects background activity, quality drift, and long-task upload slices", () => {
    const report = validReport();
    report.transitions.activityDelta.networkRequests = 1;
    report.activePlayback.renderer.playbackQualityFactor = 2;
    report.activePlayback.activityAfter.networkRequests = 1;
    report.activePlayback.inspectionQueue.maxConcurrentCount = 2;
    report.history.renderer.maximumUploadSliceMs = 50.1;
    expect(validateNationalPhase4Acceptance(report)).toEqual(expect.arrayContaining([
      "zero hot-path backend activity",
      "high-zoom native playback",
      "zero sharp-playback transfer and upload work",
      "latest-only inspection lookup queue",
      "upload slice long-task ceiling",
    ]));
  });

  it("tolerates cold-start upload pacing overshoot below the long-task ceiling", () => {
    const report = validReport();
    report.history.renderer.maximumUploadSliceMs = 12.6;
    expect(validateNationalPhase4Acceptance(report)).toEqual([]);
  });

  it("requires a failed Site transition to keep the same active National generation", () => {
    const report = validReport();
    report.failedSiteRecovery.after.painted.generation = 10;
    expect(validateNationalPhase4Acceptance(report)).toContain(
      "failed Site transition keeps the active National session",
    );

    const restarted = validReport();
    restarted.failedSiteRecovery.backfillStartCountAfter += 1;
    expect(validateNationalPhase4Acceptance(restarted)).toContain(
      "failed Site transition keeps the active National session",
    );

    delete report.failedSiteRecovery;
    expect(validateNationalPhase4Acceptance(report)).toContain(
      "failed Site transition keeps the active National session",
    );
  });

  it("requires National to stay resident behind a Site and reveal without reacquiring", () => {
    expect(validateResidentHandoff(validReport().residentHandoff)).toEqual([]);

    const torn = validReport().residentHandoff;
    torn.whileSite.renderer.visibility = "visible";
    expect(validateResidentHandoff(torn)).toContain("National stays resident while the Site is displayed");

    const reacquired = validReport().residentHandoff;
    reacquired.after.painted.generation = 12;
    expect(validateResidentHandoff(reacquired)).toContain(
      "resident National reveals under its original generation",
    );

    const noisy = validReport().residentHandoff;
    noisy.reveal.activityAfter.networkRequests += 1;
    expect(validateResidentHandoff(noisy)).toContain(
      "National reveal performs no acquisition, decode, or bulk transfer",
    );

    const slow = validReport().residentHandoff;
    slow.reveal.revealMs = 400;
    expect(validateResidentHandoff(slow)).toContain("National reveal completes within 250 ms");

    const report = validReport();
    delete report.residentHandoff;
    expect(validateNationalPhase4Acceptance(report)).toContain(
      "National stays resident while the Site is displayed",
    );
  });

  it("permits bounded exact point refresh while sharp playback stays transfer-free", () => {
    const report = validReport();
    report.activePlayback.activityAfter.pointLookupDecodes = 8;
    expect(validateNationalPhase4Acceptance(report)).toEqual([]);
  });

  it("requires usable playback controls while another National frame stages", () => {
    const report = validReport();
    report.partialHistoryControls.enabledStableStagingSampleCount = 0;
    report.partialHistoryControls.enabledStableStagingRetainedCounts = [];
    expect(validateNationalPhase4Acceptance(report)).toContain(
      "partial-history playback control availability",
    );
  });

  it("rejects playback-time telemetry shifts or false coverage placeholders", () => {
    const report = validReport();
    report.partialPlaybackChrome.timelineMaxRectDelta = 18;
    report.partialPlaybackChrome.falseOutsideCoverageSampleCount = 4;
    report.partialPlaybackChrome.distinctAnnouncements.push("11.5 dBZ.");
    expect(validateNationalPhase4Acceptance(report)).toContain(
      "stable partial-history playback chrome",
    );
  });

  it("rejects unstable compact playback chrome when viewport evidence is present", () => {
    const report = validReport();
    report.partialPlaybackChrome.compactViewports = [
      { ...report.partialPlaybackChrome, innerWidth: 878, innerHeight: 640 },
      { ...report.partialPlaybackChrome, innerWidth: 720, innerHeight: 540 },
    ];
    report.partialPlaybackChrome.compactViewports[1].sampleReadoutMaxRectDelta = 4;
    expect(validateNationalPhase4Acceptance(report)).toContain(
      "stable compact partial-history playback chrome",
    );
  });

  it("fails closed on malformed compact viewport evidence", () => {
    const report = validReport();
    report.partialPlaybackChrome.compactViewports = null;
    expect(validateNationalPhase4Acceptance(report)).toContain(
      "stable compact partial-history playback chrome",
    );
  });
});

function validReport() {
  const retained = Array.from({ length: 60 }, (_, index) => ({
    generation: 8,
    objectKey: `object-${index}`,
    observationTimeUnixMs: 1_785_000_000_000 + index * 120_000,
    contentSha256: (index + 1).toString(16).padStart(64, "0"),
    compressedBytes: 1_000,
    overviewChunkCount: 28,
    overviewGpuBytes: 3_100_000,
  }));
  const ids = retained.map((item) => `${item.observationTimeUnixMs}:${item.contentSha256}`);
  const renderer = {
    status: "painted",
    mutationAwaitingCommit: false,
    commonResidentObservationIds: ids,
    detailedObservationIds: [],
    selectedObservationId: ids.at(-1),
    presentationFactor: 1,
    residentChunkCount: 23_520,
    gpuResourceBytes: 2_987_000_000,
    peakGpuResourceBytes: 3_040_000_000,
    uploadCount: 23_520,
    uploadBytes: 2_987_000_000,
    maximumUploadSliceMs: 1.3,
    contextEpoch: 1,
  };
  const activity = {
    networkRequests: 0,
    responseBytes: 0,
    decoderRuns: 0,
    bulkIpcTransfers: 0,
    bulkIpcBytes: 0,
    pointLookupDecodes: 0,
  };
  const receipt = (id = ids.at(-1), factor = 1) => {
    const [time, hash] = id.split(":");
    return {
      generation: 8,
      observationId: id,
      observationTimeUnixMs: Number(time),
      contentSha256: hash,
      presentationFactor: factor,
      contextEpoch: 1,
    };
  };
  return {
    partialPlaybackChrome: {
      innerWidth: 3_840,
      innerHeight: 2_160,
      sampleCount: 90,
      playingSampleCount: 90,
      partialHistorySampleCount: 90,
      loadingNoticeSampleCount: 90,
      buttonDisabledSampleCount: 0,
      falseOutsideCoverageSampleCount: 0,
      pendingSampleCount: 12,
      pendingPresentationMismatchCount: 0,
      playbackBarMaxRectDelta: 0,
      timelineMaxRectDelta: 0,
      telemetryMaxRectDelta: 0,
      sampleReadoutMaxRectDelta: 0,
      distinctSampleTexts: ["--.- dBZ", "11.5 dBZ"],
      distinctAnnouncements: ["PLAYING"],
    },
    partialHistoryControls: {
      partialSampleCount: 240,
      buttonFoundSampleCount: 240,
      stableStagingSampleCount: 180,
      enabledStableStagingSampleCount: 180,
      partialRetainedCounts: Array.from({ length: 18 }, (_, index) => index + 2),
      stableStagingRetainedCounts: Array.from({ length: 18 }, (_, index) => index + 2),
      enabledStableStagingRetainedCounts: Array.from({ length: 18 }, (_, index) => index + 2),
      firstDisabledStableStaging: null,
    },
    history: {
      history: {
        historyLimit: 60,
        retained,
        staged: null,
        mutationReversible: false,
        reversibleCommitBytes: 0,
        totalBackendBytes: 100_000_000,
        backendTargetBytes: 180_000_000,
      },
      renderer,
      playback: { residentCount: 60, selectedObservationId: ids.at(-1) },
    },
    transitions: {
      requestedTransitions: 1_000,
      completedTransitions: 1_000,
      activityDelta: activity,
      rendererBefore: renderer,
      rendererAfter: renderer,
      receipts: Array.from({ length: 1_000 }, (_, index) => receipt(ids[index % 60])),
    },
    scrub: {
      oldest: { receipt: receipt(ids[0]), activityDelta: activity },
      newest: { receipt: receipt(ids.at(-1)), activityDelta: activity },
    },
    detail: {
      renderer: {
        ...renderer,
        presentationFactor: 1,
        fallbackChunkCount: 0,
        detailedObservationIds: [],
      },
    },
    activePlayback: {
      playback: { playing: true, qualityLockFactor: 4 },
      renderer: {
        ...renderer,
        presentationFactor: 1,
        playbackQualityFactor: 4,
        detailedObservationIds: [],
        gpuResourceBytes: 2_987_000_000,
        peakGpuResourceBytes: 3_040_000_000,
      },
      activityBefore: { ...activity },
      activityAfter: { ...activity },
      rendererBefore: renderer,
      rendererAfter: renderer,
      inspectionQueue: {
        running: true,
        pending: true,
        startedCount: 4,
        completedCount: 3,
        failedCount: 0,
        replacedPendingCount: 6,
        maxConcurrentCount: 1,
      },
      inspectionQueueAfterPlayback: {
        running: false,
        pending: false,
        startedCount: 5,
        completedCount: 5,
        failedCount: 0,
        replacedPendingCount: 6,
        maxConcurrentCount: 1,
      },
    },
    contextReset: {
      before: renderer,
      receipt: { ...receipt(), contextEpoch: 2 },
      after: { ...renderer, contextEpoch: 2 },
      activityDelta: activity,
    },
    peak: {
      status: "valid",
      valueDbz: 60,
      observationTimeUnixMs: retained.at(-1).observationTimeUnixMs,
      contentSha256: retained.at(-1).contentSha256,
    },
    inspectionRefresh: {
      initial: {
        observationTimeUnixMs: retained.at(-1).observationTimeUnixMs,
        contentSha256: retained.at(-1).contentSha256,
        inspectionId: "inspection-newest-1",
        longitude: -97,
        latitude: 35,
      },
      oldest: {
        observationTimeUnixMs: retained[0].observationTimeUnixMs,
        contentSha256: retained[0].contentSha256,
        inspectionId: "inspection-oldest",
        longitude: -97,
        latitude: 35,
      },
      restoredNewest: {
        observationTimeUnixMs: retained.at(-1).observationTimeUnixMs,
        contentSha256: retained.at(-1).contentSha256,
        inspectionId: "inspection-newest-2",
        longitude: -97,
        latitude: 35,
      },
    },
    transferSnapshot: { creditLimit: 2, heldCredits: 0, inFlightCredits: 0 },
    failedSiteRecovery: {
      failureMessage: "diagnostic Site transition failure after the Site lane began",
      before: { painted: { source: { kind: "national", domain: "conus" }, generation: 8 } },
      after: { painted: { source: { kind: "national", domain: "conus" }, generation: 8 } },
      history: { retained: [{ generation: 8 }] },
      renderer: {
        status: "painted",
        generation: 8,
        contextEpoch: 2,
        paintReceipt: { generation: 8, contextEpoch: 2 },
      },
      transfer: { lanes: { national: { generation: 8, active: true } } },
      backfillStartCountBefore: 1,
      backfillStartCountAfter: 1,
      playbackBeforeFailure: { playing: true },
      playbackAfterRestoration: { playing: true },
      rendererBeforeFailure: { contextEpoch: 2 },
    },
    residentHandoff: {
      before: { painted: { source: { kind: "national", domain: "conus" }, generation: 8 } },
      nationalGenerationBefore: 8,
      backfillStartCountBefore: 1,
      retainedBefore: 2,
      whileSite: {
        sourceState: { painted: { source: { kind: "site", siteIcao: "KTLX" }, generation: 9 } },
        renderer: { visibility: "resident", status: "resident" },
        transfer: { lanes: { national: { generation: 8, active: true } } },
        resident: true,
      },
      reveal: {
        activityBefore: nationalActivity(),
        activityAfter: nationalActivity(),
        revealMs: 34,
      },
      after: { painted: { source: { kind: "national", domain: "conus" }, generation: 8 } },
      renderer: {
        status: "painted",
        visibility: "visible",
        paintReceipt: { generation: 8, presented: true },
      },
      history: { retained: [{ generation: 8 }, { generation: 8 }] },
      backfillStartCountAfter: 1,
      siteLayerRemoved: true,
    },
    restoredSite: {
      sourceState: { painted: { source: { kind: "site", siteIcao: "KTLX" } }, transition: null },
      display: { lastComplete: { site: "KTLX" } },
    },
  };
}
