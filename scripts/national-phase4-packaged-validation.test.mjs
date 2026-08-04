import { describe, expect, it } from "vitest";
import { validateNationalPhase4Acceptance } from "./national-phase4-packaged-validation.mjs";

describe("National Phase 4 packaged acceptance", () => {
  it("accepts bounded resident history, quality locking, recovery, and Site return", () => {
    expect(validateNationalPhase4Acceptance(validReport())).toEqual([]);
  });

  it("rejects background activity and mixed playback quality", () => {
    const report = validReport();
    report.transitions.activityDelta.networkRequests = 1;
    report.activePlayback.renderer.presentationFactor = 1;
    report.activePlayback.inspectionQueue.maxConcurrentCount = 2;
    report.history.renderer.maximumUploadSliceMs = 4.1;
    expect(validateNationalPhase4Acceptance(report)).toEqual(expect.arrayContaining([
      "zero hot-path backend activity",
      "high-zoom playback quality lock",
      "latest-only inspection lookup queue",
      "4 ms upload slice budget",
    ]));
  });

  it("requires a failed Site transition to restore a new active National generation", () => {
    const report = validReport();
    report.failedSiteRecovery.after.painted.generation = 8;
    expect(validateNationalPhase4Acceptance(report)).toContain(
      "failed Site transition restores active National session",
    );

    delete report.failedSiteRecovery;
    expect(validateNationalPhase4Acceptance(report)).toContain(
      "failed Site transition restores active National session",
    );
  });
});

function validReport() {
  const retained = Array.from({ length: 20 }, (_, index) => ({
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
    presentationFactor: 4,
    residentChunkCount: 560,
    gpuResourceBytes: 64_000_000,
    peakGpuResourceBytes: 70_000_000,
    uploadCount: 560,
    uploadBytes: 64_000_000,
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
  const receipt = (id = ids.at(-1), factor = 4) => {
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
    history: {
      history: {
        historyLimit: 20,
        retained,
        staged: null,
        mutationReversible: false,
        reversibleCommitBytes: 0,
        totalBackendBytes: 100_000_000,
        backendTargetBytes: 180_000_000,
      },
      renderer,
      playback: { residentCount: 20, selectedObservationId: ids.at(-1) },
    },
    transitions: {
      requestedTransitions: 1_000,
      completedTransitions: 1_000,
      activityDelta: activity,
      rendererBefore: renderer,
      rendererAfter: renderer,
      receipts: Array.from({ length: 1_000 }, (_, index) => receipt(ids[index % 20])),
    },
    scrub: {
      oldest: { receipt: receipt(ids[0]), activityDelta: activity },
      newest: { receipt: receipt(ids.at(-1)), activityDelta: activity },
    },
    detail: {
      renderer: {
        ...renderer,
        presentationFactor: 1,
        fallbackPresentationFactor: 4,
        fallbackChunkCount: 28,
        detailedObservationIds: ids.slice(-3),
      },
    },
    activePlayback: {
      playback: { playing: true, qualityLockFactor: 4 },
      renderer: { ...renderer, playbackQualityFactor: 4 },
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
      failureMessage: "diagnostic Site transition failure after National cancellation",
      before: { painted: { source: { kind: "national", domain: "conus" }, generation: 8 } },
      after: { painted: { source: { kind: "national", domain: "conus" }, generation: 10 } },
      history: { retained: [{ generation: 10 }] },
      renderer: {
        status: "painted",
        generation: 10,
        contextEpoch: 3,
        paintReceipt: { generation: 10, contextEpoch: 3 },
      },
      transfer: { generation: 10 },
      backfillStartCountBefore: 1,
      backfillStartCountAfter: 2,
      playbackBeforeFailure: { playing: true },
      playbackAfterRestoration: { playing: false },
      rendererBeforeFailure: { contextEpoch: 2 },
    },
    restoredSite: {
      sourceState: { painted: { source: { kind: "site", siteIcao: "KTLX" } }, transition: null },
      display: { lastComplete: { site: "KTLX" } },
    },
  };
}
