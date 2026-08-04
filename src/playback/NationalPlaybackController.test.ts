import { afterEach, describe, expect, it, vi } from "vitest";
import type { NationalHistoryObservation } from "../packed-sweep/transferClient";
import type {
  NationalGridRendererSnapshot,
  NationalPaintReceipt,
} from "../national-radar/NationalGridLayer";
import { observationId } from "../national-radar/NationalHistoryWorkingSetController";
import { NationalPlaybackController } from "./NationalPlaybackController";

class FakeNationalLayer {
  selected: string;
  presentationFactor = 4;
  qualityLock: number | undefined;
  completeFactor: 1 | 2 | 4 = 4;
  selectFactors: number[] = [];
  commonResidencyReady = true;

  constructor(private readonly observations: readonly NationalHistoryObservation[]) {
    this.selected = observationId(observations.at(-1)!);
  }

  getSnapshot(): NationalGridRendererSnapshot {
    const selected = this.observations.find((item) => observationId(item) === this.selected)!;
    const ids = this.observations.map(observationId);
    return {
      status: "painted",
      displayMode: "smooth",
      presentationEnabled: true,
      contextEpoch: 3,
      generation: selected.generation,
      observationId: this.selected,
      observationTimeUnixMs: selected.observationTimeUnixMs,
      presentationFactor: this.presentationFactor,
      fallbackChunkCount: 0,
      coverageComplete: true,
      residentChunkCount: ids.length,
      residentObservationIds: ids,
      commonResidentObservationIds: this.commonResidencyReady ? ids : ids.slice(0, 1),
      detailedObservationIds: [],
      selectedObservationId: this.selected,
      playbackQualityFactor: this.qualityLock,
      mutationAwaitingCommit: false,
      stagedChunkCount: 0,
      gpuResourceBytes: ids.length * 1_000,
      peakGpuResourceBytes: ids.length * 1_000,
      uploadCount: ids.length,
      uploadBytes: ids.length * 1_000,
      maximumUploadSliceMs: 0.5,
      paintReceipt: this.receipt(),
    };
  }

  async selectResidentAndWait(id: string, factor: number): Promise<NationalPaintReceipt> {
    if (!this.observations.some((item) => observationId(item) === id)) {
      throw new Error("not resident");
    }
    this.selected = id;
    this.presentationFactor = factor;
    this.selectFactors.push(factor);
    return this.receipt();
  }

  setPlaybackQualityLock(factor: number | undefined) {
    this.qualityLock = factor;
  }

  finestCompletePlaybackFactor() {
    return this.completeFactor;
  }

  waitForCommonResidency() {
    return Promise.resolve();
  }

  receipt(): NationalPaintReceipt {
    const selected = this.observations.find((item) => observationId(item) === this.selected)!;
    return {
      generation: selected.generation,
      observationId: this.selected,
      observationTimeUnixMs: selected.observationTimeUnixMs,
      contentSha256: selected.contentSha256,
      presentationFactor: this.presentationFactor,
      coverageVersion: 1,
      coverageKind: this.presentationFactor === 4 ? "complete_domain" : "viewport",
      requiredChunkCount: 1,
      contextEpoch: 3,
      drawSequence: this.selectFactors.length + 1,
      completedAtUnixMs: Date.now(),
      stagingDurationMs: 0,
      maximumUploadSliceMs: 0,
      uploadedBytes: 0,
      framebufferWidth: 3840,
      framebufferHeight: 2160,
    };
  }
}

describe("NationalPlaybackController", () => {
  afterEach(() => vi.useRealTimers());

  it("uses the complete all-frame factor-4 fallback when no finer viewport is ready", async () => {
    vi.useFakeTimers();
    const observations = frames(3);
    const layer = new FakeNationalLayer(observations);
    const controller = new NationalPlaybackController(layer, observations, {
      dwellMs: 100,
      latestDwellMs: 100,
    });
    controller.establishInitialPaint(layer.receipt());

    await controller.play();
    expect(layer.qualityLock).toBe(4);
    expect(layer.getSnapshot().presentationFactor).toBe(4);
    controller.pause();

    await controller.scrub(0);
    expect(layer.selectFactors.at(-1)).toBe(4);
    expect(controller.snapshot().selectedObservationId).toBe(observationId(observations[0]));
  });

  it("starts motion immediately and upgrades quality in the background", async () => {
    vi.useFakeTimers();
    const observations = frames(3);
    const layer = new FakeNationalLayer(observations);
    let finishPreparation!: () => void;
    const preparation = new Promise<void>((resolve) => { finishPreparation = resolve; });
    const controller = new NationalPlaybackController(layer, observations, {
      dwellMs: 100,
      latestDwellMs: 100,
      async preparePlaybackQuality(isCurrent) {
        await preparation;
        expect(isCurrent()).toBe(true);
        layer.completeFactor = 1;
        return 1;
      },
    });
    controller.establishInitialPaint(layer.receipt());

    await controller.play();
    // Motion is running at the complete common level while sharp detail
    // prepares; the loop is never held.
    expect(controller.snapshot()).toMatchObject({
      playing: true,
      preparingQuality: true,
    });
    expect(controller.snapshot().holdReason).toBeUndefined();
    expect(layer.qualityLock).toBe(4);
    await vi.advanceTimersByTimeAsync(100);
    expect(layer.selectFactors.every((factor) => factor === 4)).toBe(true);

    finishPreparation();
    await vi.advanceTimersByTimeAsync(0);
    expect(layer.qualityLock).toBe(1);
    expect(controller.snapshot()).toMatchObject({ playing: true, preparingQuality: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(layer.selectFactors.at(-1)).toBe(1);
    controller.pause();
  });

  it("treats a pause during quality preparation as a clean stop at the common level", async () => {
    vi.useFakeTimers();
    const observations = frames(3);
    const layer = new FakeNationalLayer(observations);
    let finishPreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const refined: string[] = [];
    const controller = new NationalPlaybackController(layer, observations, {
      refinementSettleMs: 50,
      async preparePlaybackQuality(isCurrent) {
        await preparation;
        if (!isCurrent()) throw new Error("superseded preparation");
        return 1;
      },
      onRefinementRequested(observation) {
        refined.push(observationId(observation));
      },
    });
    controller.establishInitialPaint(layer.receipt());

    const play = controller.play();
    expect(controller.snapshot().preparingQuality).toBe(true);
    await play;
    controller.pause();
    finishPreparation();
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.snapshot()).toMatchObject({
      playing: false,
      preparingQuality: false,
    });
    expect(layer.qualityLock).toBeUndefined();
    await vi.advanceTimersByTimeAsync(49);
    expect(refined).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(refined).toEqual([observationId(observations.at(-1)!)]);
  });

  it("holds a direct scrub until context recovery restores every common resident", async () => {
    const observations = frames(3);
    const layer = new FakeNationalLayer(observations);
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });
    const waitForCommonResidency = vi
      .spyOn(layer, "waitForCommonResidency")
      .mockImplementation(() => recovery);
    const controller = new NationalPlaybackController(layer, observations);
    controller.establishInitialPaint(layer.receipt());
    layer.commonResidencyReady = false;

    const scrub = controller.scrub(0);
    await vi.waitFor(() => expect(waitForCommonResidency).toHaveBeenCalledOnce());
    expect(layer.selectFactors).toEqual([]);
    expect(controller.snapshot().holdReason).toBe("GPU_RECOVERY_REHYDRATING");

    layer.commonResidencyReady = true;
    finishRecovery();
    const receipt = await scrub;

    expect(receipt.observationId).toBe(observationId(observations[0]));
    expect(layer.selectFactors).toEqual([4]);
    controller.dispose();
  });

  it("waits for an in-flight selection before a source transition can remove the layer", async () => {
    const observations = frames(3);
    const layer = new FakeNationalLayer(observations);
    let finishPaint!: (receipt: NationalPaintReceipt) => void;
    const pendingPaint = new Promise<NationalPaintReceipt>((resolve) => {
      finishPaint = resolve;
    });
    vi.spyOn(layer, "selectResidentAndWait").mockImplementation(async (id, factor) => {
      layer.selected = id;
      layer.presentationFactor = factor;
      layer.selectFactors.push(factor);
      return pendingPaint;
    });
    const controller = new NationalPlaybackController(layer, observations);
    controller.establishInitialPaint(layer.receipt());

    const scrub = controller.scrub(0);
    await vi.waitFor(() => expect(layer.selectFactors).toEqual([4]));
    let settled = false;
    const transitionBarrier = controller.pauseAndWait(false).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishPaint(layer.receipt());
    await scrub;
    await transitionBarrier;
    expect(settled).toBe(true);
    controller.dispose();
  });

  it("requests fine detail only after playback is paused and selection settles", async () => {
    vi.useFakeTimers();
    const observations = frames(2);
    const layer = new FakeNationalLayer(observations);
    const refined: string[] = [];
    const controller = new NationalPlaybackController(layer, observations, {
      refinementSettleMs: 180,
      onRefinementRequested: (observation) => refined.push(observationId(observation)),
    });
    controller.establishInitialPaint(layer.receipt());

    controller.play();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(refined).toEqual([]);

    controller.pause();
    await vi.advanceTimersByTimeAsync(179);
    expect(refined).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(refined).toEqual([layer.selected]);
  });

  it("honors suppressed refinement across a selection that settles after the pause", async () => {
    vi.useFakeTimers();
    const observations = frames(3);
    const layer = new FakeNationalLayer(observations);
    let finishPaint!: (receipt: NationalPaintReceipt) => void;
    const pendingPaint = new Promise<NationalPaintReceipt>((resolve) => {
      finishPaint = resolve;
    });
    vi.spyOn(layer, "selectResidentAndWait").mockImplementation(async (id, factor) => {
      layer.selected = id;
      layer.presentationFactor = factor;
      layer.selectFactors.push(factor);
      return pendingPaint;
    });
    const refined: string[] = [];
    const controller = new NationalPlaybackController(layer, observations, {
      dwellMs: 100,
      latestDwellMs: 100,
      refinementSettleMs: 50,
      onRefinementRequested: (observation) => refined.push(observationId(observation)),
    });
    controller.establishInitialPaint(layer.receipt());

    const play = controller.play();
    await vi.waitFor(() => expect(layer.selectFactors.length).toBeGreaterThan(0));
    // A transition-style pause suppresses refinement while the paint settles:
    // the history/source mutation that asked for it owns the working set next.
    const settled = controller.pauseAndWait(false);
    finishPaint(layer.receipt());
    await play.catch(() => {});
    await settled;
    await vi.advanceTimersByTimeAsync(500);
    expect(refined).toEqual([]);
  });

  it("schedules refinement when a plain pause lands during a pending paint", async () => {
    vi.useFakeTimers();
    const observations = frames(3);
    const layer = new FakeNationalLayer(observations);
    let finishPaint!: (receipt: NationalPaintReceipt) => void;
    const pendingPaint = new Promise<NationalPaintReceipt>((resolve) => {
      finishPaint = resolve;
    });
    vi.spyOn(layer, "selectResidentAndWait").mockImplementation(async (id, factor) => {
      layer.selected = id;
      layer.presentationFactor = factor;
      layer.selectFactors.push(factor);
      return pendingPaint;
    });
    const refined: string[] = [];
    const controller = new NationalPlaybackController(layer, observations, {
      dwellMs: 100,
      latestDwellMs: 100,
      refinementSettleMs: 50,
      onRefinementRequested: (observation) => refined.push(observationId(observation)),
    });
    controller.establishInitialPaint(layer.receipt());

    const play = controller.play();
    await vi.waitFor(() => expect(layer.selectFactors.length).toBeGreaterThan(0));
    controller.pause();
    expect(refined).toEqual([]);
    finishPaint(layer.receipt());
    await play.catch(() => {});
    await vi.advanceTimersByTimeAsync(50);
    expect(refined).toEqual([observationId(observations.at(-1)!)]);
  });

  it("restarts cleanly when play is clicked while a paused selection still awaits paint", async () => {
    vi.useFakeTimers();
    const observations = frames(3);
    const layer = new FakeNationalLayer(observations);
    let finishPaint!: (receipt: NationalPaintReceipt) => void;
    let pendingPaint = new Promise<NationalPaintReceipt>((resolve) => {
      finishPaint = resolve;
    });
    let holdNextPaint = true;
    vi.spyOn(layer, "selectResidentAndWait").mockImplementation(async (id, factor) => {
      layer.selected = id;
      layer.presentationFactor = factor;
      layer.selectFactors.push(factor);
      if (holdNextPaint) {
        holdNextPaint = false;
        return pendingPaint;
      }
      return layer.receipt();
    });
    const controller = new NationalPlaybackController(layer, observations, {
      dwellMs: 100,
      latestDwellMs: 100,
    });
    controller.establishInitialPaint(layer.receipt());

    const firstPlay = controller.play();
    await vi.waitFor(() => expect(layer.selectFactors.length).toBe(1));
    controller.pause();
    // The pause left the first selection awaiting its paint; a second click
    // must join that settling paint rather than reject against it.
    const secondPlay = controller.play();
    finishPaint(layer.receipt());
    await firstPlay.catch(() => {});
    await expect(secondPlay).resolves.toBeUndefined();
    expect(controller.snapshot().playing).toBe(true);
    expect(layer.selectFactors.length).toBeGreaterThan(1);
    controller.pause();
  });

  it("uses the same timeline model for a non-shipping 30-frame diagnostic", () => {
    const observations = frames(30);
    const layer = new FakeNationalLayer(observations);
    const controller = new NationalPlaybackController(layer, observations, { historyLimit: 30 });

    expect(controller.snapshot()).toMatchObject({
      residentCount: 30,
      selectedObservationId: observationId(observations[29]),
    });
  });

  it("treats a paused camera change as a no-op for the camera-independent presentation", async () => {
    vi.useFakeTimers();
    const observations = frames(2);
    const layer = new FakeNationalLayer(observations);
    const refined: string[] = [];
    const controller = new NationalPlaybackController(layer, observations, {
      refinementSettleMs: 50,
      onRefinementRequested: (observation) => refined.push(observationId(observation)),
    });

    controller.notifyCameraChanged();
    await vi.advanceTimersByTimeAsync(500);

    // No forced common selection, no refinement scheduling: the paused
    // presentation needs nothing from the camera.
    expect(layer.selectFactors).toEqual([]);
    expect(refined).toEqual([]);
  });

  it("keeps motion running through a camera change and re-prepares in the background", async () => {
    vi.useFakeTimers();
    const observations = frames(3);
    const layer = new FakeNationalLayer(observations);
    let preparations = 0;
    const playingSeen: boolean[] = [];
    const controller = new NationalPlaybackController(layer, observations, {
      dwellMs: 100,
      latestDwellMs: 100,
      onState: (snapshot) => playingSeen.push(snapshot.playing),
      async preparePlaybackQuality(isCurrent) {
        expect(isCurrent()).toBe(true);
        preparations += 1;
        layer.completeFactor = preparations === 1 ? 1 : 2;
        return layer.completeFactor;
      },
    });
    controller.establishInitialPaint(layer.receipt());

    await controller.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot()).toMatchObject({ playing: true, qualityLockFactor: 1 });
    const statesBeforeCamera = playingSeen.length;

    controller.notifyCameraChanged();
    // The sharp lock drops to the complete common level without stopping motion.
    expect(controller.snapshot().playing).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(preparations).toBe(2);
    expect(controller.snapshot()).toMatchObject({ playing: true, qualityLockFactor: 2 });
    expect(playingSeen.slice(statesBeforeCamera).every((playing) => playing)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(layer.selectFactors.at(-1)).toBe(2);
    controller.pause();
  });

  it("supersedes stale quality preparation so only the newest camera locks", async () => {
    const observations = frames(3);
    const layer = new FakeNationalLayer(observations);
    let finishFirstPreparation!: () => void;
    const firstPreparation = new Promise<void>((resolve) => {
      finishFirstPreparation = resolve;
    });
    let preparations = 0;
    const controller = new NationalPlaybackController(layer, observations, {
      async preparePlaybackQuality(isCurrent) {
        preparations += 1;
        if (preparations === 1) {
          await firstPreparation;
          expect(isCurrent()).toBe(false);
          throw new Error("superseded preparation");
        }
        layer.completeFactor = 1;
        return 1;
      },
    });
    controller.establishInitialPaint(layer.receipt());

    await controller.play();
    expect(controller.snapshot().preparingQuality).toBe(true);
    controller.notifyCameraChanged();
    finishFirstPreparation();
    await vi.waitFor(() => {
      expect(controller.snapshot()).toMatchObject({ playing: true, qualityLockFactor: 1 });
    });

    expect(preparations).toBe(2);
    controller.pause();
  });
});

function frames(count: number): NationalHistoryObservation[] {
  return Array.from({ length: count }, (_, index) => ({
    generation: 9,
    objectKey: `object-${index}`,
    observationTimeUnixMs: 1_000 + index * 120_000,
    contentSha256: (index + 1).toString(16).padStart(64, "0"),
    compressedBytes: 1_000,
    overviewChunkCount: 28,
    overviewGpuBytes: 3_100_000,
  }));
}
