import { describe, expect, it } from "vitest";
import { validatePhase5Acceptance } from "./phase5-packaged-validation.mjs";

function passingReport() {
  return {
    display: { kind: "painted", live: { source: "nexrad_level2_chunks" } },
    evidence: {
      observationId: "a".repeat(32),
      sourceKind: "nexrad_level2_chunks",
      safe: {
        site: "KTLX",
        safeSequence: 8,
        gapObservations: 0,
        decodeStartedAtUnixMs: 10,
        decodeCompletedAtUnixMs: 12,
      },
    },
    receipt: {
      observationId: "a".repeat(32),
      completedAtUnixMs: 13,
      framebufferWidth: 3_840,
      framebufferHeight: 2_160,
    },
    renderer: {
      selectedObservationId: "a".repeat(32),
      lastPaintedObservationId: "a".repeat(32),
      capabilities: { hardwareAcceleration: true },
    },
  };
}

describe("Phase 5 packaged acceptance", () => {
  it("accepts matching safe decode, cancellation, and 4K paint truth", () => {
    const report = passingReport();
    expect(validatePhase5Acceptance(report, {
      oldRejected: true,
      oldCode: "live_sweep_failed",
      currentObservationId: report.evidence.observationId,
    }, { width: 3_840, height: 2_160 }, "SAFE + PAINTED")).toEqual([]);
  });

  it("accepts supersession while discovery is still starting", () => {
    const report = passingReport();
    expect(validatePhase5Acceptance(report, {
      oldRejected: true,
      oldCode: "live_start_failed",
      currentObservationId: report.evidence.observationId,
    }, { width: 3_840, height: 2_160 }, "SAFE + PAINTED")).toEqual([]);
  });

  it("rejects a false paint, missing cancellation, and incomplete label", () => {
    const report = passingReport();
    report.renderer.lastPaintedObservationId = "b".repeat(32);
    const failures = validatePhase5Acceptance(report, {
      oldRejected: false,
      currentObservationId: report.evidence.observationId,
    }, { width: 3_840, height: 2_160 }, "INCOMPLETE CURRENT");
    expect(failures).toContain("renderer last paint is not the live observation");
    expect(failures).toContain("superseded site request was not rejected");
    expect(failures).toContain("UI labels an incomplete frame");
  });
});
