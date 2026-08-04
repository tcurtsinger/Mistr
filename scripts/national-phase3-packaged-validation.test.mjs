import { describe, expect, it } from "vitest";
import { validateNationalPhase3Acceptance } from "./national-phase3-packaged-validation.mjs";

describe("National Phase 3 packaged acceptance", () => {
  it("accepts complete static National evidence and a Site rollback", () => {
    expect(validateNationalPhase3Acceptance(validReport())).toEqual([]);
  });

  it("rejects partial coverage and identity drift", () => {
    const report = validReport();
    report.overview.renderer.coverageComplete = false;
    report.detail.workingSet.receipt.observationId = "stale";
    expect(validateNationalPhase3Acceptance(report)).toEqual(expect.arrayContaining([
      "overview renderer completion",
      "refinement identity stability",
    ]));
  });
});

function validReport() {
  const hash = "ab".repeat(32);
  const identity = { generation: 4, observationTimeUnixMs: 1_785_775_692_000, contentSha256: hash, observationId: `1785775692000:${hash}` };
  const overviewReceipt = { ...identity, presentationFactor: 4, coverageKind: "complete_domain", coverageVersion: 1, requiredChunkCount: 28, contextEpoch: 1 };
  const detailReceipt = { ...identity, presentationFactor: 1, coverageKind: "viewport", coverageVersion: 2, requiredChunkCount: 8, contextEpoch: 1 };
  return {
    overview: {
      preparation: { ...identity, objectKey: "CONUS/MergedBaseReflectivityQC_00.50/20260803/MRMS_MergedBaseReflectivityQC_00.50_20260803-162812.grib2.gz", compressedSha256: hash, compressedBytes: 1, retainedBackendBytes: 100_000_000, presentationFactors: [1, 2, 4] },
      workingSet: { manifest: { presentationFactor: 4, chunks: Array(28) }, coverage: { kind: "complete_domain" }, chunkCount: 28, receipt: overviewReceipt },
      renderer: { status: "painted", coverageComplete: true, residentChunkCount: 28, gpuResourceBytes: 4_000_000, peakGpuResourceBytes: 8_000_000, maximumUploadSliceMs: 1 },
    },
    peak: { ...identity, status: "valid", rawCode: 10_200, valueDbz: 21 },
    detail: { workingSet: { manifest: { presentationFactor: 1 }, coverage: { kind: "viewport" }, chunkCount: 8, receipt: detailReceipt }, renderer: { residentChunkCount: 36, fallbackPresentationFactor: 4, fallbackChunkCount: 28, coverageComplete: true } },
    modeEvidence: { native: { displayMode: "native", ...identity }, smooth: { displayMode: "smooth", ...identity }, pixels: { changedPixels: 100, changedRatio: 0.01 } },
    contextReset: { before: { contextEpoch: 1 }, receipt: { ...detailReceipt, contextEpoch: 2 }, after: { status: "painted", fallbackPresentationFactor: 4, fallbackChunkCount: 28, residentChunkCount: 36, maximumUploadSliceMs: 1 } },
    sourceUi: { paintedSource: "national", requestedSource: null, accessibleName: "Choose radar source. National CONUS is displayed.", nationalChecked: "true", siteChecked: "false", supportingCopy: "NATIONAL COVERS CONUS", overflow: false, panelWithinViewport: true, reducedMotion: true, forcedColors: true, focusedChoice: "National" },
    transferSnapshot: { creditLimit: 2, heldCredits: 0, inFlightCredits: 0 },
    restoredSite: { sourceState: { painted: { source: { kind: "site", siteIcao: "KTLX" } }, transition: null }, ui: { paintedSource: "site", displayedSite: "KTLX" }, display: { lastComplete: { observationId: "site", site: "KTLX" } } },
  };
}
