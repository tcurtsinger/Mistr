import { describe, expect, it } from "vitest";
import {
  parseAcceptanceWorkload,
  validatePhase4Acceptance,
} from "./phase4-packaged-validation.mjs";

describe("Phase 4 packaged acceptance validation", () => {
  it("refuses environment overrides that weaken the documented workload", () => {
    expect(() => parseAcceptanceWorkload({ MISTR_PHASE4_TRANSITIONS: "999" }))
      .toThrow("requires 1000-10000 transitions");
    expect(() => parseAcceptanceWorkload({ MISTR_PHASE4_STABILITY_RUNS: "1" }))
      .toThrow("requires 2-5 stability runs");
    expect(parseAcceptanceWorkload({
      MISTR_PHASE4_TRANSITIONS: "1500",
      MISTR_PHASE4_STABILITY_RUNS: "3",
    })).toEqual({ transitions: 1_500, stabilityRuns: 3 });
  });

  it.each([
    ["alignment", (report) => { report.alignment.allSelectedCorrectGate = false; }],
    ["layer_coexistence", (report) => {
      report.coexistence.standardLayersBeforeAndAfter = false;
    }],
    ["renderer_status", (report) => { report.renderer.status = "error"; }],
  ])("rejects the report-level %s failure", (expectedFailure, mutate) => {
    const report = passingReport();
    mutate(report);
    expect(validatePhase4Acceptance(report, passingScenarios(), passingBounds(), 1_000, 2))
      .toContain(expectedFailure);
  });

  it("requires both configured runs and their stabilized heap samples", () => {
    const scenarios = passingScenarios().slice(0, 1);
    expect(validatePhase4Acceptance(passingReport(), scenarios, passingBounds(), 1_000, 2))
      .toEqual(expect.arrayContaining(["stability_run_count", "stabilized_heap_unavailable"]));
  });
});

function passingReport() {
  return {
    alignment: { allSelectedCorrectGate: true },
    coexistence: { standardLayersBeforeAndAfter: true },
    renderer: {
      status: "painted",
      paintReceipt: { framebufferWidth: 3_840, framebufferHeight: 2_160 },
      textureValidationsPassed: 20,
      capabilities: { hardwareAcceleration: true },
      metrics: {
        residentFrameCount: 20,
        gpuResourceBytes: 53_099_312,
        peakGpuResourceBytes: 106_197_552,
      },
    },
  };
}

function passingScenarios() {
  return [80_000_000, 81_000_000].map((stabilizedHeapBytes) => ({
    requestedTransitions: 1_000,
    completedTransitions: 1_000,
    receiptTruthPassed: true,
    hotPathActivityZero: true,
    replacementStable: true,
    frameTiming: {
      p95Ms: 6.2,
      longTaskObserverAvailable: true,
      longTaskCount: 0,
    },
    framebufferWidth: 3_840,
    framebufferHeight: 2_160,
    stabilizedHeapBytes,
  }));
}

function passingBounds() {
  return { width: 3_840, height: 2_160 };
}
