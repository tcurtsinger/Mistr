import { describe, expect, it } from "vitest";
import { validateContextRecovery, validatePhase6Acceptance } from "./phase6-packaged-validation.mjs";

function reset(residents = 20, displayMode = "native") {
  return {
    before: { contextEpoch: 1, selectedObservationId: "a", displayMode },
    recovery: {
      phase: "ready",
      targetResidentCount: residents,
      currentResidentCount: residents,
      visibleFramePainted: true,
    },
    after: {
      status: "painted",
      contextEpoch: 2,
      selectedObservationId: "a",
      displayMode,
      residentObservationIds: Array.from({ length: residents }, (_, index) => String(index)),
      paintReceipt: { contextEpoch: 2, observationId: "a" },
    },
  };
}

describe("Phase 6 packaged acceptance", () => {
  it("requires a new-context visible paint before full policy residency", () => {
    expect(validateContextRecovery(reset(), 20)).toEqual([]);
    const broken = reset();
    broken.after.paintReceipt.contextEpoch = 1;
    broken.recovery.currentResidentCount = 1;
    expect(validateContextRecovery(broken, 20)).toEqual([
      "recovery_resident_count",
      "paint_epoch",
    ]);
  });

  it("keeps base product and N0S labeling separate", () => {
    const report = {
      pass: 1,
      userAgent: "Mozilla Edg/140.0",
      reflectivityDisplayMode: "native",
      initial: { renderer: { displayMode: "native", capabilities: { hardwareAcceleration: true }, recovery: { targetResidentCount: 20 } } },
      reflectivityContextReset: reset(20),
      postRecoveryStep: { contextEpoch: 2 },
      minimizeRestore: { selectedObservationId: "b", receipt: { observationId: "b" } },
      offlineResidentStep: { selectedObservationId: "b", receipt: { observationId: "b" } },
      n0s: { product: "storm_relative_velocity", units: "kt", sourceKind: "nexrad_level3_n0s", sample: { units: "kt" } },
      n0sContextReset: reset(1),
      scaleChanges: [
        { receipt: { framebufferWidth: 1280, framebufferHeight: 720 } },
        { receipt: { framebufferWidth: 2560, framebufferHeight: 1440 } },
      ],
    };
    expect(validatePhase6Acceptance(report)).toEqual([]);
    report.pass = 2;
    report.reflectivityDisplayMode = "smooth";
    report.initial.renderer.displayMode = "smooth";
    report.reflectivityContextReset = reset(20, "smooth");
    expect(validatePhase6Acceptance(report)).toEqual([]);
    report.n0s.product = "base_velocity";
    expect(validatePhase6Acceptance(report)).toContain("n0s_product_truth");
  });
});
