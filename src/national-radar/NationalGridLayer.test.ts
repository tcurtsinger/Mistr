import { describe, expect, it, vi } from "vitest";
import {
  clearPriorWebGlErrors,
  sameNationalPresentationReceipt,
  type NationalPaintReceipt,
} from "./NationalGridLayer";

describe("National WebGL upload error isolation", () => {
  it("drains sticky errors left by shared-context rendering before an upload", () => {
    const errors = [0x0500, 0x0502, 0];
    const getError = vi.fn(() => errors.shift() ?? 0);

    expect(() => clearPriorWebGlErrors({ NO_ERROR: 0, getError })).not.toThrow();
    expect(getError).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the prior error queue cannot be cleared", () => {
    const getError = vi.fn(() => 0x0502);

    expect(() => clearPriorWebGlErrors({ NO_ERROR: 0, getError })).toThrow(
      "National renderer could not clear the prior WebGL error state",
    );
    expect(getError).toHaveBeenCalledTimes(32);
  });

  it("accepts a recovery receipt only for the same painted presentation", () => {
    const original = receipt({ contextEpoch: 1, drawSequence: 8 });
    const recovered = receipt({ contextEpoch: 2, drawSequence: 9 });

    expect(sameNationalPresentationReceipt(recovered, original)).toBe(true);
    expect(sameNationalPresentationReceipt(
      { ...recovered, observationId: "newer-observation" },
      original,
    )).toBe(false);
    expect(sameNationalPresentationReceipt(
      { ...recovered, coverageVersion: recovered.coverageVersion + 1 },
      original,
    )).toBe(false);
  });
});

function receipt(overrides: Partial<NationalPaintReceipt>): NationalPaintReceipt {
  return {
    generation: 7,
    observationId: "observation",
    observationTimeUnixMs: 1_785_000_000_000,
    contentSha256: "ab".repeat(32),
    presentationFactor: 4,
    coverageVersion: 3,
    coverageKind: "complete_domain",
    requiredChunkCount: 28,
    contextEpoch: 1,
    drawSequence: 1,
    completedAtUnixMs: 1_785_000_001_000,
    stagingDurationMs: 10,
    maximumUploadSliceMs: 1,
    uploadedBytes: 3_000_000,
    framebufferWidth: 3840,
    framebufferHeight: 2160,
    ...overrides,
  };
}
