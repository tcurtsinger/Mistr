import type {
  RadarCustomLayer,
  RadarPaintReceipt,
} from "../radar-renderer/RadarCustomLayer";
import type { RadarSweepCpuModel } from "../radar-renderer/cpuModel";

export interface PlaybackStateSnapshot {
  generation: number;
  playing: boolean;
  residentCount: number;
  selectedObservationId: string;
  lastPaintedObservationId?: string;
  playheadObservedAtUnixMs?: number;
  transitionCount: number;
  completedCycles: number;
  residentReplacementPending: boolean;
  holdReason?: string;
}

export interface PlaybackControllerOptions {
  dwellMs?: number;
  latestDwellMs?: number;
  onState?(snapshot: PlaybackStateSnapshot): void;
}

export class ResidentPlaybackController {
  private playing = false;
  private disposed = false;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private transitionCount = 0;
  private completedCycles = 0;
  private lastReceipt: RadarPaintReceipt | undefined;
  private operation: Promise<RadarPaintReceipt> | null = null;
  private replacementTail: Promise<void> = Promise.resolve();
  private residentReplacementCount = 0;
  private readonly dwellMs: number;
  private readonly latestDwellMs: number;

  constructor(
    private readonly layer: Pick<
      RadarCustomLayer,
      | "commitResidentFrameReplacement"
      | "getSnapshot"
      | "hasPendingResidentFrameReplacement"
      | "replaceResidentFrames"
      | "retryFailedSmoothDrawInNative"
      | "rollbackResidentFrameReplacement"
      | "selectAndWait"
      | "updateResidentHistory"
      | "waitForRecovery"
      | "waitForPaint"
    >,
    private frames: readonly RadarSweepCpuModel[],
    private readonly options: PlaybackControllerOptions = {},
  ) {
    if (frames.length < 1) throw new Error("playback requires at least one resident frame");
    this.dwellMs = options.dwellMs ?? 120;
    this.latestDwellMs = options.latestDwellMs ?? 600;
    if (this.dwellMs < 0 || this.latestDwellMs < this.dwellMs) {
      throw new RangeError("playback dwell values are invalid");
    }
  }

  async establishInitialPaint(): Promise<RadarPaintReceipt> {
    this.assertActive();
    if (this.operation) throw new Error("a frame selection is already awaiting paint");
    const snapshot = this.layer.getSnapshot();
    const operation = this.withNativeFallback(
      this.layer.waitForPaint(snapshot.selectionSequence),
    );
    this.operation = operation;
    this.emit();
    try {
      const receipt = await operation;
      this.assertReceipt(receipt);
      this.lastReceipt = receipt;
      return receipt;
    } finally {
      this.operation = null;
      this.emit();
    }
  }

  replaceResidentFrames(
    frames: readonly RadarSweepCpuModel[],
    beforeCommit?: () => void,
  ): Promise<RadarPaintReceipt> {
    this.assertActive();
    if (frames.length < 1) throw new Error("playback requires at least one resident frame");
    this.residentReplacementCount += 1;
    this.emit();
    const priorReplacement = this.replacementTail;
    let releaseTurn = () => {};
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    this.replacementTail = priorReplacement.then(() => turn, () => turn);
    return (async () => {
      await priorReplacement.catch(() => {});
      try {
        return await this.replaceResidentFramesNow(frames, beforeCommit);
      } finally {
        releaseTurn();
        this.residentReplacementCount -= 1;
        this.emit();
      }
    })();
  }

  updateResidentHistory(
    frames: readonly RadarSweepCpuModel[],
    beforeCommit?: () => void,
  ): Promise<RadarPaintReceipt> {
    this.assertActive();
    if (frames.length < 1) throw new Error("playback requires at least one resident frame");
    this.residentReplacementCount += 1;
    this.emit();
    const priorReplacement = this.replacementTail;
    let releaseTurn = () => {};
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    this.replacementTail = priorReplacement.then(() => turn, () => turn);
    return (async () => {
      await priorReplacement.catch(() => {});
      try {
        return await this.updateResidentHistoryNow(frames, beforeCommit);
      } finally {
        releaseTurn();
        this.residentReplacementCount -= 1;
        this.emit();
      }
    })();
  }

  private async updateResidentHistoryNow(
    frames: readonly RadarSweepCpuModel[],
    beforeCommit?: () => void,
  ): Promise<RadarPaintReceipt> {
    this.assertActive();
    const resumePlayback = this.playing;
    const previousFrames = this.frames;
    const previousSelected = this.layer.getSnapshot().selectedObservationId;
    const wasPausedAtNewest = !resumePlayback
      && previousSelected === previousFrames[previousFrames.length - 1].observationId;
    await this.pauseAndWait();
    if (this.layer.getSnapshot().recovery.phase !== "ready") {
      await this.layer.waitForRecovery();
    }
    const selectedObservationId = wasPausedAtNewest
      ? frames[frames.length - 1].observationId
      : frames.some((frame) => frame.observationId === previousSelected)
        ? previousSelected
        : frames[0].observationId;
    beforeCommit?.();

    this.layer.updateResidentHistory(frames, selectedObservationId);
    this.frames = [...frames];
    let receipt: RadarPaintReceipt;
    try {
      receipt = await this.establishInitialPaint();
      beforeCommit?.();
      this.layer.commitResidentFrameReplacement(receipt.selectionSequence);
    } catch (error) {
      this.frames = previousFrames;
      this.lastReceipt = undefined;
      const restoration = this.layer.hasPendingResidentFrameReplacement()
        ? this.layer.rollbackResidentFrameReplacement()
        : this.waitForRecoveredAuthoritativePaint();
      this.operation = restoration;
      this.emit();
      try {
        const restoredReceipt = await restoration;
        this.assertReceipt(restoredReceipt);
        this.lastReceipt = restoredReceipt;
      } catch (rollbackError) {
        throw new Error(
          `resident history update failed (${errorMessage(error)}) and rollback GPU paint failed (${errorMessage(rollbackError)})`,
        );
      } finally {
        this.operation = null;
        this.emit();
        if (resumePlayback && !this.disposed) this.play();
      }
      throw error;
    }
    if (resumePlayback && !this.disposed) this.play();
    return receipt;
  }

  private async replaceResidentFramesNow(
    frames: readonly RadarSweepCpuModel[],
    beforeCommit?: () => void,
  ): Promise<RadarPaintReceipt> {
    this.assertActive();
    await this.pauseAndWait();
    if (this.layer.getSnapshot().recovery.phase !== "ready") {
      await this.layer.waitForRecovery();
    }
    beforeCommit?.();

    // The renderer swap and controller-frame update are synchronous so no
    // playback operation can observe IDs from different resident loops.
    const previousFrames = this.frames;
    this.layer.replaceResidentFrames(frames);
    this.frames = [...frames];
    this.lastReceipt = undefined;
    let receipt: RadarPaintReceipt;
    try {
      receipt = await this.establishInitialPaint();
      beforeCommit?.();
      this.layer.commitResidentFrameReplacement(receipt.selectionSequence);
    } catch (error) {
      this.frames = previousFrames;
      this.lastReceipt = undefined;
      const restoration = this.layer.hasPendingResidentFrameReplacement()
        ? this.layer.rollbackResidentFrameReplacement()
        : this.waitForRecoveredAuthoritativePaint();
      this.operation = restoration;
      this.emit();
      try {
        const restoredReceipt = await restoration;
        this.assertReceipt(restoredReceipt);
        this.lastReceipt = restoredReceipt;
      } catch (rollbackError) {
        throw new Error(
          `resident replacement failed (${errorMessage(error)}) and rollback GPU paint failed (${errorMessage(rollbackError)})`,
        );
      } finally {
        this.operation = null;
        this.emit();
      }
      throw error;
    }
    return receipt;
  }

  private async waitForRecoveredAuthoritativePaint(): Promise<RadarPaintReceipt> {
    let snapshot = this.layer.getSnapshot();
    if (snapshot.recovery.phase !== "ready") {
      await this.layer.waitForRecovery();
      snapshot = this.layer.getSnapshot();
    }
    if (!snapshot.paintReceipt) {
      throw new Error("abandoned replacement recovery completed without a paint receipt");
    }
    return snapshot.paintReceipt;
  }

  play(): void {
    this.assertActive();
    if (this.playing) return;
    this.playing = true;
    this.emit();
    const pending = this.operation;
    if (!pending) {
      this.scheduleNext(this.dwellForCurrent());
      return;
    }
    void pending.then(
      () => {
        globalThis.queueMicrotask(() => {
          if (this.playing && !this.operation) this.scheduleNext(this.dwellForCurrent());
        });
      },
      () => {
        this.playing = false;
        this.emit();
      },
    );
  }

  pause(): void {
    if (this.disposed) return;
    this.playing = false;
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    this.timer = null;
    this.emit();
  }

  async pauseAndWait(): Promise<void> {
    this.pause();
    if (this.operation) await this.operation;
  }

  async step(): Promise<RadarPaintReceipt> {
    this.assertActive();
    this.assertResidentInteractionReady();
    await this.pauseAndWait();
    this.assertResidentInteractionReady();
    return this.advanceOnce();
  }

  async scrub(index: number): Promise<RadarPaintReceipt> {
    this.assertActive();
    this.assertResidentInteractionReady();
    await this.pauseAndWait();
    this.assertResidentInteractionReady();
    if (!Number.isInteger(index) || index < 0 || index >= this.frames.length) {
      throw new RangeError(`frame index ${index} is not resident`);
    }
    return this.select(this.frames[index].observationId);
  }

  async runTransitions(
    count: number,
    afterEach?: (transition: number, receipt: RadarPaintReceipt) => void | Promise<void>,
  ): Promise<RadarPaintReceipt[]> {
    this.assertActive();
    if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) {
      throw new RangeError("transition count must be between 1 and 10000");
    }
    this.assertResidentInteractionReady();
    await this.pauseAndWait();
    this.assertResidentInteractionReady();
    const receipts: RadarPaintReceipt[] = [];
    for (let transition = 1; transition <= count; transition += 1) {
      const receipt = await this.advanceOnce();
      receipts.push(receipt);
      await afterEach?.(transition, receipt);
    }
    return receipts;
  }

  snapshot(): PlaybackStateSnapshot {
    const renderer = this.layer.getSnapshot();
    const painted = this.lastReceipt?.observationId ?? renderer.lastPaintedObservationId;
    const frame = painted
      ? this.frames.find((candidate) => candidate.observationId === painted)
      : undefined;
    return {
      generation: renderer.generation,
      playing: this.playing,
      residentCount: renderer.residentObservationIds.length,
      selectedObservationId: renderer.selectedObservationId,
      lastPaintedObservationId: painted,
      playheadObservedAtUnixMs: frame?.observedAtUnixMs,
      transitionCount: this.transitionCount,
      completedCycles: this.completedCycles,
      residentReplacementPending: this.residentReplacementCount > 0,
      holdReason: this.operation ? "AWAITING_GPU_PAINT" : undefined,
      ...(renderer.recovery.phase !== "ready"
        ? { holdReason: `GPU_RECOVERY_${renderer.recovery.phase.toUpperCase()}` }
        : {}),
    };
  }

  dispose(): void {
    this.pause();
    this.disposed = true;
  }

  private scheduleNext(delayMs: number) {
    if (!this.playing || this.disposed || this.timer !== null) return;
    this.timer = globalThis.setTimeout(() => {
      this.timer = null;
      void this.advanceOnce()
        .then(() => {
          if (this.playing) this.scheduleNext(this.dwellForCurrent());
        })
        .catch(() => {
          this.playing = false;
          this.emit();
        });
    }, delayMs);
  }

  private async advanceOnce(): Promise<RadarPaintReceipt> {
    const selected = this.layer.getSnapshot().selectedObservationId;
    const currentIndex = this.frames.findIndex((frame) => frame.observationId === selected);
    if (currentIndex < 0) throw new Error("renderer selected a frame outside the resident loop");
    const nextIndex = (currentIndex + 1) % this.frames.length;
    return this.select(this.frames[nextIndex].observationId, nextIndex === 0);
  }

  private async select(
    observationId: string,
    completesCycle = false,
  ): Promise<RadarPaintReceipt> {
    if (this.operation) throw new Error("a frame selection is already awaiting paint");
    if (this.layer.getSnapshot().recovery.phase !== "ready") {
      await this.layer.waitForRecovery();
      this.assertActive();
    }
    const priorSelectionSequence = this.layer.getSnapshot().selectionSequence;
    const operation = this.withNativeFallback(this.layer.selectAndWait(observationId));
    this.operation = operation;
    this.emit();
    try {
      const receipt = await operation;
      const producedNewPaint = receipt.selectionSequence > priorSelectionSequence;
      if (producedNewPaint && receipt.selectionSequence !== priorSelectionSequence + 1) {
        throw new Error("paint receipt skipped a selection sequence");
      }
      this.acceptReceipt(receipt, completesCycle, producedNewPaint);
      return receipt;
    } finally {
      this.operation = null;
      this.emit();
    }
  }

  private acceptReceipt(
    receipt: RadarPaintReceipt,
    completesCycle: boolean,
    producedNewPaint: boolean,
  ) {
    this.assertReceipt(receipt);
    this.lastReceipt = receipt;
    if (producedNewPaint) {
      this.transitionCount += 1;
      if (completesCycle) this.completedCycles += 1;
    }
    this.emit();
  }

  private async withNativeFallback(
    smoothPaint: Promise<RadarPaintReceipt>,
  ): Promise<RadarPaintReceipt> {
    try {
      return await smoothPaint;
    } catch (smoothError) {
      const retry = this.layer.retryFailedSmoothDrawInNative();
      if (!retry) throw smoothError;
      try {
        return await this.layer.waitForPaint(retry.selectionSequence);
      } catch (nativeError) {
        throw new Error(
          `Smooth GPU paint failed (${errorMessage(smoothError)}) and Native retry failed (${errorMessage(nativeError)})`,
        );
      }
    }
  }

  private assertReceipt(receipt: RadarPaintReceipt) {
    const renderer = this.layer.getSnapshot();
    if (
      receipt.generation !== renderer.generation
      || receipt.contextEpoch !== renderer.contextEpoch
      || receipt.observationId !== renderer.selectedObservationId
      || receipt.selectionSequence !== renderer.selectionSequence
    ) {
      throw new Error("paint receipt does not match the authoritative renderer selection");
    }
  }

  private dwellForCurrent(): number {
    const selected = this.layer.getSnapshot().selectedObservationId;
    return selected === this.frames[this.frames.length - 1].observationId
      ? this.latestDwellMs
      : this.dwellMs;
  }

  private emit() {
    this.options.onState?.(this.snapshot());
  }

  private assertActive() {
    if (this.disposed) throw new Error("playback controller is disposed");
  }

  private assertResidentInteractionReady() {
    if (this.residentReplacementCount > 0) {
      throw new Error("resident radar history is being replaced");
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
