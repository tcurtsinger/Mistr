import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPriorWebGlErrors,
  completePlaybackDetailFactor,
  commonResidencyReadyForInteraction,
  commonResidencyReadyForSelection,
  presentationUsesCommonFallback,
  sameNationalPresentationReceipt,
  UploadFrameBudget,
  UPLOAD_FRAMES_IN_FLIGHT,
  type NationalPaintReceipt,
} from "./NationalGridLayer";

describe("National upload frame budget", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubAnimationFrames(): { count: () => number } {
    let frames = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames += 1;
      callback(frames);
      return frames;
    });
    return { count: () => frames };
  }

  it("yields to an animation frame before the first slice", async () => {
    const frames = stubAnimationFrames();
    const budget = new UploadFrameBudget(4);

    await budget.yieldIfSpent();

    expect(frames.count()).toBe(1);
  });

  it("packs consecutive fast slices into one animation frame", async () => {
    const frames = stubAnimationFrames();
    const budget = new UploadFrameBudget(4);
    await budget.yieldIfSpent();

    budget.recordSlice(32, 0.2);
    await budget.yieldIfSpent();
    budget.recordSlice(32, 0.2);
    await budget.yieldIfSpent();

    expect(frames.count()).toBe(1);
  });

  it("grows the row band from measured throughput and shrinks it after slow slices", async () => {
    stubAnimationFrames();
    const budget = new UploadFrameBudget(4);
    await budget.yieldIfSpent();

    expect(budget.rowsForSlice(10_000)).toBe(32);
    budget.recordSlice(32, 0.1);
    const grown = budget.rowsForSlice(10_000);
    expect(grown).toBeGreaterThan(32);

    budget.recordSlice(grown, 400);
    await budget.yieldIfSpent();
    expect(budget.rowsForSlice(10_000)).toBe(32);
  });

  it("yields once the measured budget is spent", async () => {
    const frames = stubAnimationFrames();
    const budget = new UploadFrameBudget(4);
    await budget.yieldIfSpent();

    budget.recordSlice(32, 3.9);
    await budget.yieldIfSpent();

    expect(frames.count()).toBe(2);
  });

  it("never sizes a slice past the remaining tail rows", async () => {
    stubAnimationFrames();
    const budget = new UploadFrameBudget(4);
    await budget.yieldIfSpent();

    // A 258-row halo chunk ends in a tail band shorter than the minimum.
    expect(budget.rowsForSlice(2)).toBe(2);
    expect(budget.rowsForSlice(31)).toBe(31);
    budget.recordSlice(32, 0.1);
    expect(budget.rowsForSlice(2)).toBe(2);
  });

  function fenceGl() {
    const fences: { signaled: boolean; deleted: boolean }[] = [];
    const gl = {
      SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
      TIMEOUT_EXPIRED: 0x911b,
      ALREADY_SIGNALED: 0x911a,
      fenceSync: () => {
        const fence = { signaled: false, deleted: false };
        fences.push(fence);
        return fence as unknown as WebGLSync;
      },
      clientWaitSync: (sync: WebGLSync) => (
        (sync as unknown as { signaled: boolean }).signaled ? 0x911a : 0x911b
      ),
      deleteSync: (sync: WebGLSync) => {
        (sync as unknown as { deleted: boolean }).deleted = true;
      },
      isContextLost: () => false,
    };
    return { gl: gl as unknown as WebGL2RenderingContext, fences };
  }

  async function spendFrame(budget: UploadFrameBudget, gl: WebGL2RenderingContext) {
    budget.recordSlice(32, 3.9);
    await budget.yieldIfSpent(gl);
  }

  it("fences each frame of uploads and waits while the GPU is behind", async () => {
    const frames = stubAnimationFrames();
    const { gl, fences } = fenceGl();
    const budget = new UploadFrameBudget(4);
    await budget.yieldIfSpent(gl);
    // The forced first yield issued no upload work, so it fences nothing.
    expect(fences).toHaveLength(0);

    for (let frame = 0; frame < UPLOAD_FRAMES_IN_FLIGHT; frame += 1) await spendFrame(budget, gl);
    expect(fences).toHaveLength(UPLOAD_FRAMES_IN_FLIGHT);
    const framesBeforeBacklog = frames.count();

    // One more unfinished frame of uploads waits a frame at a time until the
    // oldest fence signals; it never blocks on the GPU.
    let released = false;
    const third = spendFrame(budget, gl).then(() => { released = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(released).toBe(false);
    fences[0].signaled = true;
    await third;
    expect(released).toBe(true);
    expect(fences[0].deleted).toBe(true);
    expect(frames.count()).toBeGreaterThan(framesBeforeBacklog + 1);
  });

  it("forgets fences from a lost context instead of touching them", async () => {
    stubAnimationFrames();
    const { gl, fences } = fenceGl();
    const budget = new UploadFrameBudget(4);
    await budget.yieldIfSpent(gl);
    for (let frame = 0; frame < UPLOAD_FRAMES_IN_FLIGHT; frame += 1) await spendFrame(budget, gl);
    budget.discardFences();
    const polled: WebGLSync[] = [];
    const restored = {
      ...gl,
      clientWaitSync: (sync: WebGLSync) => { polled.push(sync); return 0x911b; },
      deleteSync: (sync: WebGLSync) => { polled.push(sync); },
    } as unknown as WebGL2RenderingContext;
    await spendFrame(budget, restored);
    expect(polled.some((sync) => fences.slice(0, UPLOAD_FRAMES_IN_FLIGHT).includes(sync as never))).toBe(false);
  });

  it("gives up on a fence the driver never signals", async () => {
    const frames = stubAnimationFrames();
    const { gl } = fenceGl();
    const budget = new UploadFrameBudget(4);
    await budget.yieldIfSpent(gl);
    for (let frame = 0; frame <= UPLOAD_FRAMES_IN_FLIGHT; frame += 1) await spendFrame(budget, gl);
    // Patience is bounded; uploads carry on rather than stall.
    expect(frames.count()).toBeLessThan(200);
  });

  it("rejects a non-positive budget", () => {
    expect(() => new UploadFrameBudget(0)).toThrow(
      "National upload frame budget must be positive",
    );
  });
});

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

  it("keeps the common-residency barrier closed until recovery paint completes", () => {
    const completeResidents = {
      mutationAwaitingCommit: false,
      paintReceipt: receipt({ contextEpoch: 2 }),
      residentObservationIds: ["older", "newer"],
      commonResidentObservationIds: ["older", "newer"],
    } as const;

    expect(commonResidencyReadyForSelection({
      ...completeResidents,
      status: "recovering",
    })).toBe(false);
    expect(commonResidencyReadyForSelection({
      ...completeResidents,
      status: "painted",
    })).toBe(true);
    expect(commonResidencyReadyForSelection({
      ...completeResidents,
      status: "painted",
      paintReceipt: undefined,
    })).toBe(false);
  });

  it("keeps completed playback residents interactive while another frame stages", () => {
    const completedTimeline = {
      mutationAwaitingCommit: false,
      paintReceipt: receipt({ contextEpoch: 2 }),
      commonResidentObservationIds: ["older", "newer"],
    } as const;

    expect(commonResidencyReadyForInteraction({
      ...completedTimeline,
      status: "staging",
    }, 2)).toBe(true);
    expect(commonResidencyReadyForInteraction({
      ...completedTimeline,
      status: "painted",
    }, 2)).toBe(true);
    expect(commonResidencyReadyForInteraction({
      ...completedTimeline,
      status: "recovering",
    }, 2)).toBe(false);
    expect(commonResidencyReadyForInteraction({
      ...completedTimeline,
      status: "staging",
      mutationAwaitingCommit: true,
    }, 2)).toBe(false);
    expect(commonResidencyReadyForInteraction({
      ...completedTimeline,
      status: "staging",
    }, 3)).toBe(false);
  });

  it("accepts fine playback only when every observation owns the same viewport chunks", () => {
    const coverage = {
      version: 1,
      kind: "viewport" as const,
      west: -102,
      south: 35,
      east: -94,
      north: 42,
      requiredChunkIndices: [10, 11, 38, 39],
    };
    const details = ["older", "newer"].map((observationId, index) => ({
      observationId,
      presentationFactor: 1,
      coverage: { ...coverage, version: index + 1 },
      complete: true,
    }));

    expect(completePlaybackDetailFactor(["older", "newer"], details)).toBe(1);
    expect(completePlaybackDetailFactor(["older", "newer"], [
      details[0],
      {
        ...details[1],
        coverage: { ...details[1].coverage, requiredChunkIndices: [10, 11] },
      },
    ])).toBeUndefined();
    expect(completePlaybackDetailFactor(["older", "newer"], [details[0]])).toBeUndefined();
  });

  it("draws the complete overview behind either viewport-detail factor", () => {
    expect(presentationUsesCommonFallback(1)).toBe(true);
    expect(presentationUsesCommonFallback(2)).toBe(true);
    expect(presentationUsesCommonFallback(4)).toBe(false);
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
    presented: true,
    ...overrides,
  };
}
