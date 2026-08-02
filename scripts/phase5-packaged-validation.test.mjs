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
      metrics: { frameUploadCount: 2 },
      residentObservationIds: ["0".repeat(32), "a".repeat(32)],
    },
    history: {
      residentCount: 2,
      capacity: 20,
      partial: true,
      oldestObservationId: "0".repeat(32),
      newestObservationId: "a".repeat(32),
    },
  };
}

function passingCancellation() {
  return {
    oldRejected: true,
    oldCode: "live_sweep_failed",
    currentObservationId: "0".repeat(32),
    currentVolumeIndex: 7,
    currentVolumeStartedAtUnixMs: 100,
    currentFrameUploadCount: 1,
    displayMode: "native",
  };
}

function passingRolling() {
  return {
    nextObservationId: "a".repeat(32),
    nextVolumeIndex: 8,
    nextVolumeStartedAtUnixMs: 200,
    history: passingReport().history,
    renderer: passingReport().renderer,
    oldestScrubObservationId: "0".repeat(32),
    newestScrubObservationId: "a".repeat(32),
    displayMode: "smooth",
  };
}

describe("Phase 5 packaged acceptance", () => {
  it("accepts matching safe decode, cancellation, and 4K paint truth", () => {
    const report = passingReport();
    expect(validatePhase5Acceptance(
      report,
      passingCancellation(),
      passingRolling(),
      { width: 3_840, height: 2_160 },
      "SAFE + PAINTED",
    )).toEqual([]);
  });

  it("accepts supersession while discovery is still starting", () => {
    const report = passingReport();
    const cancellation = passingCancellation();
    cancellation.oldCode = "live_start_failed";
    expect(validatePhase5Acceptance(
      report,
      cancellation,
      passingRolling(),
      { width: 3_840, height: 2_160 },
      "SAFE + PAINTED",
    )).toEqual([]);
  });

  it("rejects a false paint, missing cancellation, and incomplete label", () => {
    const report = passingReport();
    report.renderer.lastPaintedObservationId = "b".repeat(32);
    const cancellation = passingCancellation();
    cancellation.oldRejected = false;
    const failures = validatePhase5Acceptance(
      report,
      cancellation,
      passingRolling(),
      { width: 3_840, height: 2_160 },
      "INCOMPLETE CURRENT",
    );
    expect(failures).toContain("renderer last paint is not the live observation");
    expect(failures).toContain("superseded site request was not rejected");
    expect(failures).toContain("UI labels an incomplete frame");
  });

  it("rejects a rolling response that skips the exact next volume slot", () => {
    const rolling = passingRolling();
    rolling.nextVolumeIndex = 9;

    expect(validatePhase5Acceptance(
      passingReport(),
      passingCancellation(),
      rolling,
      { width: 3_840, height: 2_160 },
      "SAFE + PAINTED",
    )).toContain("rolling history skipped the exact next volume index");
  });
});
