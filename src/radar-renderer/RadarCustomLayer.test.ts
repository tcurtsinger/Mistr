import { describe, expect, it, vi } from "vitest";
import {
  assertNoWebGlError,
  hasVerifiedHardwareAcceleration,
  RadarCustomLayer,
  radarShaderSources,
  validateReplacementGeneration,
  validateResidentModels,
} from "./RadarCustomLayer";
import type { RadarPaintReceipt } from "./RadarCustomLayer";
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

describe("WebGL upload error gate", () => {
  it("rejects a texture upload when WebGL records an error", () => {
    expect(() => assertNoWebGlError({
      NO_ERROR: 0,
      getError: () => 0x0502,
    }, "radial-metadata texture upload")).toThrow(
      "radial-metadata texture upload failed with WebGL error 0x502",
    );
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

describe("resident replacement rollback", () => {
  it("restores capped receipt and latency histories without retaining the rejected paint", () => {
    const previousReceipts = Array.from({ length: 64 }, (_, index) => receipt(index));
    const previousLatencies = Array.from({ length: 240 }, (_, index) => index);
    const rejectedReceipt = receipt(999);
    const layer = new RadarCustomLayer(model(0), { onSnapshot: vi.fn() });
    const internals = layer as unknown as Record<string, unknown>;
    const gl = {
      ARRAY_BUFFER: 0x8892,
      ARRAY_BUFFER_BINDING: 0x8894,
      STATIC_DRAW: 0x88e4,
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      deleteTexture: vi.fn(),
      getParameter: vi.fn(() => null),
    } as unknown as WebGL2RenderingContext;

    internals.gl = gl;
    internals.quadBuffer = {} as WebGLBuffer;
    internals.paintReceipt = rejectedReceipt;
    internals.paintReceipts = [...previousReceipts.slice(1), rejectedReceipt];
    internals.switchLatencySamples = [...previousLatencies.slice(1), 999];
    internals.pendingReplacement = {
      previousModels: [model(0)],
      previousFrames: new Map(),
      previousPalette: {} as WebGLTexture,
      previousSelectedObservationId: "observation-0",
      previousSelectionSequence: 1,
      previousSelectedAt: 0,
      previousPaintReceipt: previousReceipts[previousReceipts.length - 1],
      previousPaintReceipts: previousReceipts,
      previousSwitchLatencySamples: previousLatencies,
    };

    layer.rollbackResidentFrameReplacement();

    expect(layer.getPaintReceipts()).toEqual(previousReceipts);
    expect(internals.switchLatencySamples).toEqual(previousLatencies);
    expect(layer.getPaintReceipts()).not.toContainEqual(rejectedReceipt);
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
    maxRangeM: 230_000,
    generation: 1n,
    observedAtUnixMs: 1_700_000_000_000 + index,
  } as RadarSweepCpuModel;
}

function receipt(index: number): RadarPaintReceipt {
  return {
    generation: 1,
    observationId: `receipt-${index}`,
    contextEpoch: 1,
    selectionSequence: index + 1,
    drawSequence: index + 1,
    completedAtUnixMs: 1_700_000_000_000 + index,
    firstPaintLatencyMs: index,
    residentSwitchLatencyMs: index,
    framebufferWidth: 3840,
    framebufferHeight: 2160,
  };
}
