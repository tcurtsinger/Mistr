import { describe, expect, it } from "vitest";
import {
  hasVerifiedHardwareAcceleration,
  radarShaderSources,
  validateReplacementGeneration,
  validateResidentModels,
} from "./RadarCustomLayer";
import type { RadarSweepCpuModel } from "./cpuModel";

describe("Radar custom-layer shader contract", () => {
  it("uses public matrix input and compact texture fetches without per-gate geometry", () => {
    expect(radarShaderSources.vertex).toContain("uniform mat4 u_matrix");
    expect(radarShaderSources.fragment).toContain("usampler2D u_raw_codes");
    expect(radarShaderSources.fragment).toContain("usampler2D u_statuses");
    expect(radarShaderSources.fragment).toContain("usampler2D u_azimuth_lookup");
    expect(radarShaderSources.fragment).toContain("sampler2D u_radial_metadata");
    expect(radarShaderSources.fragment).toContain("texelFetch(u_raw_codes");
    expect(radarShaderSources.fragment).toContain("texelFetch(u_palette");
  });

  it("matches CPU half-gate, missing-radial, and status semantics", () => {
    const fragment = radarShaderSources.fragment;
    expect(fragment).toContain("gateCoordinate < -0.5");
    expect(fragment).toContain("float(u_gate_count) - 0.5");
    expect(fragment).toContain("encodedRadial == uint(0)");
    expect(fragment).toContain("bearingDifference > radialMetadata.g");
    expect(fragment).toContain("float slantRangeM = EFFECTIVE_EARTH_RADIUS_M");
    expect(fragment).toContain("slantRangeM - u_first_gate_center_m");
    expect(fragment).toContain("status == uint(1)");
    expect(fragment).toContain("status == uint(2)");
  });
});

describe("hardware renderer evidence", () => {
  it("requires unmasked evidence and rejects common software renderers", () => {
    expect(hasVerifiedHardwareAcceleration(false, "WebKit WebGL")).toBe(false);
    expect(hasVerifiedHardwareAcceleration(true, "")).toBe(false);
    expect(hasVerifiedHardwareAcceleration(true, "ANGLE (NVIDIA GeForce RTX 4080, D3D11)"))
      .toBe(true);
    expect(hasVerifiedHardwareAcceleration(true, "Google SwiftShader")).toBe(false);
    expect(hasVerifiedHardwareAcceleration(true, "llvmpipe (LLVM 19.1.7)"))
      .toBe(false);
    expect(hasVerifiedHardwareAcceleration(
      true,
      "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)",
    )).toBe(false);
    expect(hasVerifiedHardwareAcceleration(true, "ANGLE (Microsoft WARP Direct3D11)"))
      .toBe(false);
  });
});

describe("resident loop validation", () => {
  it("accepts 20 ordered observations from one render key", () => {
    expect(() => validateResidentModels(
      Array.from({ length: 20 }, (_, index) => model(index)),
    )).not.toThrow();
  });

  it("rejects duplicate identities, mixed generations, and unordered times", () => {
    expect(() => validateResidentModels([model(0), model(0)])).toThrow("duplicate");
    expect(() => validateResidentModels([
      model(0),
      { ...model(1), generation: 2n },
    ])).toThrow("one generation");
    expect(() => validateResidentModels([model(1), model(0)])).toThrow("increasing");
  });

  it("requires every atomic replacement to advance the generation", () => {
    expect(() => validateReplacementGeneration(6, 7)).not.toThrow();
    expect(() => validateReplacementGeneration(6, 6)).toThrow("monotonically");
    expect(() => validateReplacementGeneration(6, 2)).toThrow("monotonically");
  });
});

function model(index: number): RadarSweepCpuModel {
  return {
    observationId: `observation-${index}`,
    siteIcao: "KTLX",
    product: "reflectivity",
    sourceKind: "nexrad_level2_archive_ii",
    scale: 2,
    offset: 66,
    center: { longitude: -97.27776, latitude: 35.333363 },
    generation: 1n,
    observedAtUnixMs: 1_700_000_000_000 + index,
  } as RadarSweepCpuModel;
}
