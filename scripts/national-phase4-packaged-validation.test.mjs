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
    expect(validateNationalPhase4Acceptance(report)).toEqual(expect.arrayContaining([
      "zero hot-path backend activity",
      "high-zoom playback quality lock",
    ]));
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
    transferSnapshot: { creditLimit: 2, heldCredits: 0, inFlightCredits: 0 },
    restoredSite: {
      sourceState: { painted: { source: { kind: "site", siteIcao: "KTLX" } }, transition: null },
      display: { lastComplete: { site: "KTLX" } },
    },
  };
}
