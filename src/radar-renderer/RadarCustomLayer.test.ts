import { describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  assertNoWebGlError,
  hasVerifiedHardwareAcceleration,
  RadarCustomLayer,
  radarShaderSources,
  shouldSmoothRadarDisplay,
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

  it("smooths only valid reflectivity neighbors without bridging masks or radial gaps", () => {
    const fragment = radarShaderSources.fragment;
    expect(fragment).toContain("uniform int u_smooth_display");
    expect(fragment).toContain("vec4 validGateColor");
    expect(fragment).toContain("status != uint(0)");
    expect(fragment).toContain("centerSeparation <= coverage * 1.5 + 0.000001");
    expect(fragment).toContain("if (!safelyAdjacent && bearingDifference > radialMetadata.g) discard");
    expect(fragment).toContain("float totalWeight = weight00 + weight01 + weight10 + weight11");
    expect(fragment.indexOf("if (u_smooth_display == 0 && bearingDifference"))
      .toBeLessThan(fragment.indexOf("if (status == uint(1)) discard"));
    expect(fragment.indexOf("if (status == uint(2))"))
      .toBeLessThan(fragment.indexOf("if (u_smooth_display == 1)"));
  });
});

describe("radar display modes", () => {
  it("defaults to Smooth and accepts an explicit Native constructor mode", () => {
    const smooth = new RadarCustomLayer(model(0), { onSnapshot: vi.fn() });
    const native = new RadarCustomLayer(model(0), {
      displayMode: "native",
      onSnapshot: vi.fn(),
    });

    expect(smooth.getDisplayMode()).toBe("smooth");
    expect(smooth.getSnapshot().displayMode).toBe("smooth");
    expect(native.getDisplayMode()).toBe("native");
    expect(native.getSnapshot().displayMode).toBe("native");
  });

  it("changes presentation without replacing resident data or disturbing selection truth", () => {
    const onSnapshot = vi.fn();
    const layer = new RadarCustomLayer([model(0), model(1)], { onSnapshot });
    const before = layer.getSnapshot();

    layer.setDisplayMode("native");
    const after = layer.getSnapshot();

    expect(after).toMatchObject({
      displayMode: "native",
      selectedObservationId: before.selectedObservationId,
      residentObservationIds: before.residentObservationIds,
      selectionSequence: before.selectionSequence,
      lastPaintedObservationId: before.lastPaintedObservationId,
    });
    expect(layer.getDisplayMode()).toBe("native");
    expect(onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      displayMode: "native",
      status: "initializing",
    }));

    layer.setDisplayMode("native");
    expect(layer.getSnapshot().selectionSequence).toBe(after.selectionSequence);
    expect(() => layer.setDisplayMode("blurred" as never)).toThrow("Smooth or Native");
  });

  it("retains the selected display mode through context-loss state", () => {
    const layer = new RadarCustomLayer(model(0), {
      displayMode: "native",
      onSnapshot: vi.fn(),
    });
    const internals = layer as unknown as { beginContextRecovery(): void };

    internals.beginContextRecovery();

    expect(layer.getSnapshot()).toMatchObject({
      displayMode: "native",
      recovery: { phase: "context_lost" },
    });
    expect(() => layer.setDisplayMode("smooth")).not.toThrow();
    expect(layer.getSnapshot()).toMatchObject({
      displayMode: "smooth",
      recovery: { phase: "context_lost" },
    });
  });

  it("keeps categorical velocity native even when Smooth is selected", () => {
    expect(shouldSmoothRadarDisplay("smooth", "reflectivity")).toBe(true);
    expect(shouldSmoothRadarDisplay("native", "reflectivity")).toBe(false);
    expect(shouldSmoothRadarDisplay("smooth", "storm_relative_velocity")).toBe(false);
  });

  it("offers only a recoverable Smooth draw failure for a controller-owned Native retry", () => {
    const onSnapshot = vi.fn();
    const layer = new RadarCustomLayer(model(0), { onSnapshot });
    const internals = layer as unknown as {
      gl: { isContextLost(): boolean };
      program: object;
      vao: object;
      uniforms: object;
      runtimeError: string | undefined;
      runtimeErrorRecoverableByNative: boolean;
    };
    internals.gl = { isContextLost: () => false };
    internals.program = {};
    internals.vao = {};
    internals.uniforms = {};
    internals.runtimeError = "Smooth draw failed";
    internals.runtimeErrorRecoverableByNative = true;

    const retry = layer.retryFailedSmoothDrawInNative();

    expect(retry).toMatchObject({
      observationId: layer.getSnapshot().selectedObservationId,
      selectionSequence: layer.getSnapshot().selectionSequence,
    });
    expect(layer.getSnapshot()).toMatchObject({
      displayMode: "native",
      status: "ready",
      error: undefined,
    });
    expect(onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      displayMode: "native",
      status: "ready",
      error: undefined,
    }));
  });

  it("does not offer a resource-wide renderer failure for a Native retry", () => {
    const layer = new RadarCustomLayer(model(0), { onSnapshot: vi.fn() });
    const internals = layer as unknown as {
      runtimeError: string | undefined;
      runtimeErrorRecoverableByNative: boolean;
    };
    internals.runtimeError = "GPU completion fence failed";
    internals.runtimeErrorRecoverableByNative = false;

    const retry = layer.retryFailedSmoothDrawInNative();

    expect(retry).toBeNull();
    expect(layer.getSnapshot()).toMatchObject({
      displayMode: "smooth",
      status: "error",
      error: "GPU completion fence failed",
    });
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
  it("commits an incremental mutation by deleting only the evicted GPU frame", () => {
    const onSnapshot = vi.fn();
    const layer = new RadarCustomLayer(model(0), { onSnapshot });
    const deleteTexture = vi.fn();
    const retained = frameResources(model(1));
    const evicted = frameResources(model(0));
    const added = frameResources(model(2));
    const internals = layer as unknown as Record<string, unknown>;
    internals.gl = { deleteTexture } as unknown as WebGL2RenderingContext;
    internals.models = [model(1), model(2)];
    internals.frameResources = new Map([
      ["observation-1", retained],
      ["observation-2", added],
    ]);
    internals.selectedObservationId = "observation-1";
    internals.selectionSequence = 1;
    internals.paintReceipt = receiptFor("observation-1", 1);
    internals.pendingReplacement = {
      previousModels: [model(0), model(1)],
      previousFrames: new Map([
        ["observation-0", evicted],
        ["observation-1", retained],
      ]),
      previousPalette: {} as WebGLTexture,
      previousSelectedObservationId: "observation-1",
      previousSelectionSequence: 1,
      previousTextureValidation: undefined,
      previousPaintReceipts: [],
      previousSwitchLatencySamples: [],
      deleteOnCommit: [evicted],
      deleteOnRollback: [added],
    };

    layer.commitResidentFrameReplacement(1);

    expect(deleteTexture).toHaveBeenCalledTimes(4);
    expect(deleteTexture).not.toHaveBeenCalledWith(retained.rawTexture);
    expect(deleteTexture).not.toHaveBeenCalledWith(added.rawTexture);
    expect(layer.hasPendingResidentFrameReplacement()).toBe(false);
  });

  it("restores capped histories but withholds prior paint truth until restoration completes", async () => {
    const previousReceipts = Array.from({ length: 64 }, (_, index) => receipt(index));
    const previousLatencies = Array.from({ length: 240 }, (_, index) => index);
    const rejectedReceipt = receipt(999);
    const onSnapshot = vi.fn();
    const layer = new RadarCustomLayer(model(0), { onSnapshot });
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
      previousPaintReceipts: previousReceipts,
      previousSwitchLatencySamples: previousLatencies,
      deleteOnCommit: [],
      deleteOnRollback: [],
    };

    const rollback = layer.rollbackResidentFrameReplacement(10);
    const rollbackFailure = expect(rollback).rejects.toThrow("did not paint");

    expect(layer.getPaintReceipts()).toEqual(previousReceipts);
    expect(internals.switchLatencySamples).toEqual(previousLatencies);
    expect(layer.getPaintReceipts()).not.toContainEqual(rejectedReceipt);
    expect(layer.getSnapshot()).toMatchObject({
      lastPaintedObservationId: undefined,
    });
    expect(onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ready" }));
    await rollbackFailure;
  });
});

describe("context recovery truth", () => {
  it("re-adds radar before its diagnostic successor instead of above map labels", () => {
    const addLayer = vi.fn();
    const map = {
      addLayer,
      getLayer: vi.fn((id: string) => id === "mistr-anchor" ? { id } : undefined),
      getStyle: vi.fn(() => ({ layers: [{ id: "place-label", type: "symbol" }] })),
    } as unknown as MapLibreMap;
    const layer = new RadarCustomLayer(model(0), {
      recoveryBeforeLayerId: "mistr-anchor",
      onSnapshot: vi.fn(),
    });
    const internals = layer as unknown as {
      map: MapLibreMap;
      recoveryPhase: string;
      tryReaddAfterContextRestore(): void;
    };
    internals.map = map;
    internals.recoveryPhase = "waiting_for_style";

    internals.tryReaddAfterContextRestore();

    expect(addLayer).toHaveBeenCalledWith(layer, "mistr-anchor");
  });

  it("invalidates old paint truth, advances the context epoch, and retains CPU observations", () => {
    const models = [model(0), model(1), model(2)];
    const layer = new RadarCustomLayer(models, { onSnapshot: vi.fn() });
    const internals = layer as unknown as {
      beginContextRecovery(): void;
      paintReceipt: RadarPaintReceipt | undefined;
      frameResources: Map<string, unknown>;
    };
    internals.paintReceipt = receipt(0);
    internals.frameResources = new Map(models.map((entry) => [entry.observationId, {
      textureValidation: { allPassed: true },
    }]));

    internals.beginContextRecovery();

    expect(layer.getSnapshot()).toMatchObject({
      status: "recovering",
      contextEpoch: 2,
      lastPaintedObservationId: undefined,
      recovery: {
        phase: "context_lost",
        targetResidentCount: 3,
        visibleObservationId: "observation-0",
        visibleFramePainted: false,
      },
    });
    expect(() => layer.selectFrame("observation-1")).toThrow("renderer is recovering");
  });

  it("rejects paint and recovery waiters when recovery fails", async () => {
    const layer = new RadarCustomLayer([model(0)], { onSnapshot: vi.fn() });
    const internals = layer as unknown as {
      beginContextRecovery(): void;
      failRenderer(error: unknown): void;
    };
    const paintFailure = expect(layer.waitForPaint(1, 1_000)).rejects.toThrow(
      "recovery upload failed",
    );
    internals.beginContextRecovery();
    const recoveryFailure = expect(layer.waitForRecovery(1_000)).rejects.toThrow(
      "recovery upload failed",
    );

    internals.failRenderer(new Error("recovery upload failed"));

    await Promise.all([paintFailure, recoveryFailure]);
    expect(layer.getSnapshot()).toMatchObject({
      status: "error",
      error: "recovery upload failed",
    });
  });

  it("restarts per-context truth for a second loss during recovery", () => {
    const layer = new RadarCustomLayer([model(0), model(1)], { onSnapshot: vi.fn() });
    const internals = layer as unknown as {
      beginContextRecovery(): void;
      contextLossActive: boolean;
      recoveryPhase: string;
      recoverySync: WebGLSync | null;
      paintReceipt: RadarPaintReceipt | undefined;
    };

    internals.beginContextRecovery();
    internals.beginContextRecovery();
    expect(layer.getSnapshot().contextEpoch).toBe(2);

    internals.contextLossActive = false;
    internals.recoveryPhase = "rehydrating_loop";
    internals.recoverySync = {} as WebGLSync;
    internals.paintReceipt = receipt(0);
    internals.beginContextRecovery();

    expect(layer.getSnapshot()).toMatchObject({
      status: "recovering",
      contextEpoch: 3,
      lastPaintedObservationId: undefined,
      recovery: { phase: "context_lost", visibleFramePainted: false },
    });
    expect(internals.recoverySync).toBeNull();
  });

  it("rejects the abandoned replacement sequence before restoring prior CPU truth", async () => {
    const prior = model(0);
    const replacement = { ...model(1), generation: 2n };
    const layer = new RadarCustomLayer(replacement, { onSnapshot: vi.fn() });
    const internals = layer as unknown as {
      beginContextRecovery(): void;
      pendingReplacement: Record<string, unknown> | null;
      selectionSequence: number;
    };
    internals.selectionSequence = 2;
    internals.pendingReplacement = {
      previousModels: [prior],
      previousFrames: new Map(),
      previousPalette: {} as WebGLTexture,
      previousSelectedObservationId: prior.observationId,
      previousSelectionSequence: 1,
      previousTextureValidation: undefined,
      previousPaintReceipts: [],
      previousSwitchLatencySamples: [],
      deleteOnCommit: [],
      deleteOnRollback: [],
    };
    const abandoned = expect(layer.waitForPaint(2, 1_000)).rejects.toThrow(
      "abandoned by WebGL context loss",
    );

    internals.beginContextRecovery();

    await abandoned;
    expect(layer.getSnapshot()).toMatchObject({
      selectedObservationId: prior.observationId,
      selectionSequence: 1,
      recovery: { phase: "context_lost" },
    });
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

function receiptFor(observationId: string, selectionSequence: number): RadarPaintReceipt {
  return {
    ...receipt(selectionSequence - 1),
    observationId,
    selectionSequence,
  };
}

function frameResources(modelValue: RadarSweepCpuModel) {
  return {
    model: modelValue,
    rawTexture: { kind: `${modelValue.observationId}-raw` } as unknown as WebGLTexture,
    statusTexture: { kind: `${modelValue.observationId}-status` } as unknown as WebGLTexture,
    lookupTexture: { kind: `${modelValue.observationId}-lookup` } as unknown as WebGLTexture,
    radialMetadataTexture: {
      kind: `${modelValue.observationId}-metadata`,
    } as unknown as WebGLTexture,
    textureValidation: { allPassed: true },
    gpuBytes: 4,
  };
}
