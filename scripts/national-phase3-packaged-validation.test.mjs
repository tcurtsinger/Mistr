import { describe, expect, it } from "vitest";
import { validateNationalPhase3Acceptance } from "./national-phase3-packaged-validation.mjs";

describe("National Phase 3 packaged acceptance", () => {
  it("accepts complete native-residency National evidence and a Site rollback", () => {
    expect(validateNationalPhase3Acceptance(validReport())).toEqual([]);
  });

  it("rejects partial coverage and identity drift", () => {
    const report = validReport();
    report.overview.renderer.coverageComplete = false;
    report.detail.workingSet.receipt.observationId = "stale";
    expect(validateNationalPhase3Acceptance(report)).toEqual(expect.arrayContaining([
      "native renderer completion",
      "refinement identity stability",
    ]));
  });

  it("rejects a coarse presentation or a resident fallback level", () => {
    const report = validReport();
    report.overview.workingSet.manifest.presentationFactor = 4;
    report.detail.renderer.fallbackChunkCount = 28;
    expect(validateNationalPhase3Acceptance(report)).toEqual(expect.arrayContaining([
      "complete native manifest",
      "single native presentation without fallback",
    ]));
  });

  it("rejects a long-task upload slice while tolerating cold-start pacing overshoot", () => {
    const report = validReport();
    report.overview.renderer.maximumUploadSliceMs = 12.6;
    expect(validateNationalPhase3Acceptance(report)).toEqual([]);
    report.overview.renderer.maximumUploadSliceMs = 51;
    expect(validateNationalPhase3Acceptance(report)).toEqual(expect.arrayContaining([
      "upload slice long-task ceiling",
    ]));
  });
});

function validReport() {
  const hash = "ab".repeat(32);
  const identity = { generation: 4, observationTimeUnixMs: 1_785_775_692_000, contentSha256: hash, observationId: `1785775692000:${hash}` };
  const nativeReceipt = { ...identity, presentationFactor: 1, coverageKind: "complete_domain", coverageVersion: 1, requiredChunkCount: 392, contextEpoch: 1 };
  return {
    overview: {
      preparation: { ...identity, objectKey: "CONUS/MergedBaseReflectivityQC_00.50/20260803/MRMS_MergedBaseReflectivityQC_00.50_20260803-162812.grib2.gz", compressedSha256: hash, compressedBytes: 1, retainedBackendBytes: 100_000_000, presentationFactors: [1, 2, 4] },
      workingSet: { manifest: { presentationFactor: 1, chunks: Array(392) }, coverage: { kind: "complete_domain" }, chunkCount: 392, receipt: nativeReceipt },
      renderer: { status: "painted", coverageComplete: true, residentChunkCount: 392, gpuResourceBytes: 49_748_952, peakGpuResourceBytes: 52_000_000, maximumUploadSliceMs: 1 },
    },
    peak: { ...identity, status: "valid", rawCode: 10_200, valueDbz: 21 },
    detail: { workingSet: { manifest: { presentationFactor: 1 }, coverage: { kind: "complete_domain" }, chunkCount: 392, receipt: { ...nativeReceipt } }, renderer: { residentChunkCount: 392, fallbackChunkCount: 0, coverageComplete: true } },
    modeEvidence: { native: { displayMode: "native", ...identity }, smooth: { displayMode: "smooth", ...identity }, pixels: { changedPixels: 100, changedRatio: 0.01 } },
    contextReset: { before: { contextEpoch: 1 }, receipt: { ...nativeReceipt, contextEpoch: 2 }, after: { status: "painted", fallbackChunkCount: 0, residentChunkCount: 392, maximumUploadSliceMs: 1 } },
    sourceUi: { paintedSource: "national", requestedSource: null, accessibleName: "Choose radar source. National CONUS is displayed.", nationalChecked: "true", siteChecked: "false", supportingCopy: "NATIONAL COVERS CONUS", overflow: false, panelWithinViewport: true, reducedMotion: true, forcedColors: true, focusedChoice: "National" },
    transferSnapshot: { creditLimit: 2, heldCredits: 0, inFlightCredits: 0 },
    restoredSite: { sourceState: { painted: { source: { kind: "site", siteIcao: "KTLX" } }, transition: null }, ui: { paintedSource: "site", displayedSite: "KTLX" }, display: { lastComplete: { observationId: "site", site: "KTLX" } } },
  };
}
