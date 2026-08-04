import type { NationalHistoryObservation } from "../packed-sweep/transferClient";
import type {
  NationalGridLayer,
  NationalPaintReceipt,
} from "../national-radar/NationalGridLayer";
import { observationId } from "../national-radar/NationalHistoryWorkingSetController";

export interface NationalPlaybackSnapshot {
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
  qualityLockFactor?: number;
  refining: boolean;
  preparingQuality: boolean;
}

export type NationalPlaybackQualityFactor = 1 | 2 | 4;

export interface NationalPlaybackControllerOptions {
  dwellMs?: number;
  latestDwellMs?: number;
  refinementSettleMs?: number;
  historyLimit?: 20 | 30;
  onState?(snapshot: NationalPlaybackSnapshot): void;
  onPaint?(receipt: NationalPaintReceipt): void;
  onRefinementRequested?(observation: NationalHistoryObservation): void;
  acquireResidentOnlyActivity?(): Promise<() => void>;
  preparePlaybackQuality?(
    isCurrent: () => boolean,
  ): Promise<NationalPlaybackQualityFactor>;
}

type PlaybackLayer = Pick<
  NationalGridLayer,
  | "getSnapshot"
  | "selectResidentAndWait"
  | "setPlaybackQualityLock"
  | "finestCompletePlaybackFactor"
  | "waitForCommonResidency"
>;

export class NationalPlaybackController {
  private playing = false;
  private disposed = false;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private refinementTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private operation: Promise<NationalPaintReceipt> | null = null;
  private replacementPending = false;
  private lastReceipt: NationalPaintReceipt | undefined;
  private transitionCount = 0;
  private completedCycles = 0;
  private playRequest = 0;
  private qualityRequest = 0;
  private preparingQuality = false;
  private refinementAfterQualityPreparation = false;
  private suppressSettledRefinement = false;
  private readonly dwellMs: number;
  private readonly latestDwellMs: number;
  private readonly refinementSettleMs: number;
  private readonly historyLimit: 20 | 30;

  constructor(
    private readonly layer: PlaybackLayer,
    private observations: readonly NationalHistoryObservation[],
    private readonly options: NationalPlaybackControllerOptions = {},
  ) {
    this.historyLimit = options.historyLimit ?? 20;
    assertObservationTimeline(observations, this.historyLimit);
    this.dwellMs = options.dwellMs ?? 120;
    this.latestDwellMs = options.latestDwellMs ?? 600;
    this.refinementSettleMs = options.refinementSettleMs ?? 180;
    if (
      this.dwellMs < 0
      || this.latestDwellMs < this.dwellMs
      || this.refinementSettleMs < 0
      || this.refinementSettleMs > 2_000
    ) {
      throw new RangeError("National playback timing is invalid");
    }
  }

  establishInitialPaint(receipt: NationalPaintReceipt): void {
    this.assertReceipt(receipt);
    this.lastReceipt = receipt;
    this.options.onPaint?.(receipt);
    this.emit();
    this.scheduleRefinement();
  }

  acceptHistory(
    observations: readonly NationalHistoryObservation[],
    receipt: NationalPaintReceipt,
  ): void {
    this.assertActive();
    assertObservationTimeline(observations, this.historyLimit);
    this.observations = [...observations];
    this.assertReceipt(receipt);
    this.lastReceipt = receipt;
    this.options.onPaint?.(receipt);
    this.replacementPending = false;
    this.emit();
    if (!this.playing) this.scheduleRefinement();
  }

  acceptRefinement(receipt: NationalPaintReceipt): void {
    this.assertActive();
    if (this.playing) throw new Error("National refinement cannot commit during playback");
    this.assertReceipt(receipt);
    this.lastReceipt = receipt;
    this.options.onPaint?.(receipt);
    this.emit();
  }

  markReplacementPending(pending: boolean): void {
    this.replacementPending = pending;
    this.emit();
  }

  /**
   * Motion-first playback: motion begins immediately at the always-resident
   * complete common level, and sharp quality upgrades in the background. The
   * loop is never held for preparation, and a camera change never stops it.
   */
  play(): Promise<void> {
    this.assertActive();
    if (this.playing || this.observations.length < 2) {
      return Promise.resolve();
    }
    const request = this.playRequest + 1;
    this.playRequest = request;
    this.clearRefinementTimer();
    this.playing = true;
    this.layer.setPlaybackQualityLock(4);
    this.emit();
    this.beginQualityUpgrade();
    return (async () => {
      // A pause can land while a selection is still awaiting its paint
      // receipt, leaving that operation in flight with the play control
      // already re-enabled. That settling selection is part of this start:
      // await it instead of rejecting the user's click against it.
      const pending = this.operation;
      if (pending) await pending.catch(() => {});
      if (this.disposed || !this.playing || this.playRequest !== request) return;
      try {
        await this.ensureCommonSelection(4);
      } catch (error) {
        if (this.playRequest === request) this.stopPlayback();
        throw error;
      }
      if (this.playing && this.playRequest === request && !this.operation) {
        this.scheduleNext(this.dwellForCurrent());
      }
    })();
  }

  /**
   * Prepare sharp playback beside the running loop. The prepared factor is
   * applied through the quality lock and takes effect on the next frame
   * selection; failure or supersession leaves motion at the common level.
   */
  private beginQualityUpgrade(): void {
    const prepare = this.options.preparePlaybackQuality;
    if (!prepare) return;
    const request = this.qualityRequest + 1;
    this.qualityRequest = request;
    const isCurrent = () => !this.disposed
      && this.playing
      && this.qualityRequest === request;
    this.preparingQuality = true;
    this.emit();
    void (async () => {
      try {
        const factor = await prepare(isCurrent);
        if (isCurrent() && (factor === 1 || factor === 2)) {
          this.layer.setPlaybackQualityLock(factor);
        }
      } catch {
        // Superseded, busy, or unavailable sharp detail: motion continues at
        // the complete common level rather than pausing or surfacing an error.
      } finally {
        if (this.qualityRequest === request) {
          this.preparingQuality = false;
          this.emit();
          const deferred = this.refinementAfterQualityPreparation;
          this.refinementAfterQualityPreparation = false;
          if (deferred && !this.playing) this.scheduleRefinement();
        }
      }
    })();
  }

  pause(): void {
    if (this.disposed) return;
    this.playRequest += 1;
    this.qualityRequest += 1;
    this.preparingQuality = false;
    this.playing = false;
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    this.timer = null;
    this.layer.setPlaybackQualityLock(undefined);
    this.emit();
    if (!this.operation) this.scheduleRefinement();
  }

  async pauseAndWait(scheduleRefinement = true): Promise<boolean> {
    const wasPlaying = this.playing;
    this.pause();
    if (!scheduleRefinement) {
      // Callers settling resident paint for a transition or history mutation
      // must not have refinement armed behind their back when the pending
      // selection completes. The settled-selection hook below honors this.
      this.clearRefinementTimer();
      this.suppressSettledRefinement = true;
    }
    try {
      if (this.operation) await this.operation;
    } finally {
      if (!scheduleRefinement) this.suppressSettledRefinement = false;
    }
    return wasPlaying;
  }

  resumeAfterMutation(wasPlaying: boolean): void {
    if (wasPlaying && !this.disposed) void this.play();
  }

  async scrub(index: number): Promise<NationalPaintReceipt> {
    this.assertActive();
    if (!Number.isInteger(index) || index < 0 || index >= this.observations.length) {
      throw new RangeError(`National frame index ${index} is not retained`);
    }
    await this.pauseAndWait(false);
    this.clearRefinementTimer();
    const release = await this.acquireResidentOnlyActivity();
    try {
      await this.layer.waitForCommonResidency();
      this.assertActive();
      const receipt = await this.select(observationId(this.observations[index]), false);
      this.scheduleRefinement();
      return receipt;
    } finally {
      release();
    }
  }

  async runTransitions(count: number): Promise<NationalPaintReceipt[]> {
    this.assertActive();
    if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) {
      throw new RangeError("National transition count must be between 1 and 10000");
    }
    await this.pauseAndWait(false);
    this.clearRefinementTimer();
    const release = await this.acquireResidentOnlyActivity();
    try {
      const receipts: NationalPaintReceipt[] = [];
      for (let transition = 0; transition < count; transition += 1) {
        receipts.push(await this.advanceOnce());
      }
      this.scheduleRefinement();
      return receipts;
    } finally {
      release();
    }
  }

  /**
   * A settled camera never stops motion. The paused presentation is
   * complete-domain and camera-independent, so a paused camera change is a
   * no-op. While playing, the sharp lock was prepared for the previous
   * viewport: motion drops to the always-complete common level between
   * frames and a fresh background preparation upgrades it again.
   */
  notifyCameraChanged(): void {
    if (this.disposed) return;
    if (!this.playing) {
      if (this.preparingQuality) {
        this.qualityRequest += 1;
        this.preparingQuality = false;
        this.emit();
      }
      return;
    }
    this.qualityRequest += 1;
    this.layer.setPlaybackQualityLock(4);
    this.emit();
    this.beginQualityUpgrade();
  }

  snapshot(): NationalPlaybackSnapshot {
    const renderer = this.layer.getSnapshot();
    const commonResidencyComplete = this.observations.length > 0
      && renderer.commonResidentObservationIds.length === this.observations.length;
    const paintedId = this.lastReceipt?.observationId ?? renderer.paintReceipt?.observationId;
    const painted = this.observations.find((observation) => observationId(observation) === paintedId);
    return {
      generation: renderer.generation ?? this.observations[0].generation,
      playing: this.playing,
      residentCount: renderer.commonResidentObservationIds.length,
      selectedObservationId: renderer.selectedObservationId ?? observationId(this.observations.at(-1)!),
      lastPaintedObservationId: paintedId,
      playheadObservedAtUnixMs: painted?.observationTimeUnixMs,
      transitionCount: this.transitionCount,
      completedCycles: this.completedCycles,
      residentReplacementPending: this.replacementPending,
      qualityLockFactor: renderer.playbackQualityFactor,
      refining: this.refinementTimer !== null,
      preparingQuality: this.preparingQuality,
      ...(this.operation ? { holdReason: "AWAITING_GPU_PAINT" } : {}),
      ...(renderer.status === "recovering" || !commonResidencyComplete
        ? { holdReason: "GPU_RECOVERY_REHYDRATING" }
        : {}),
    };
  }

  dispose(): void {
    this.pause();
    this.clearRefinementTimer();
    this.disposed = true;
  }

  private async ensureCommonSelection(
    presentationFactor?: NationalPlaybackQualityFactor,
  ): Promise<NationalPaintReceipt> {
    await this.layer.waitForCommonResidency();
    const selected = this.layer.getSnapshot().selectedObservationId
      ?? observationId(this.observations.at(-1)!);
    return this.select(selected, false, presentationFactor);
  }

  private scheduleNext(delayMs: number) {
    if (!this.playing || this.disposed || this.timer !== null) return;
    this.timer = globalThis.setTimeout(() => {
      this.timer = null;
      void this.advanceOnce().then(
        () => {
          if (this.playing) this.scheduleNext(this.dwellForCurrent());
        },
        () => {
          this.stopPlayback();
        },
      );
    }, delayMs);
  }

  private async advanceOnce(): Promise<NationalPaintReceipt> {
    const selected = this.layer.getSnapshot().selectedObservationId;
    const currentIndex = this.observations.findIndex(
      (observation) => observationId(observation) === selected,
    );
    if (currentIndex < 0) throw new Error("National renderer selected outside retained history");
    const nextIndex = (currentIndex + 1) % this.observations.length;
    return this.select(observationId(this.observations[nextIndex]), nextIndex === 0);
  }

  private async select(
    targetObservationId: string,
    completesCycle: boolean,
    requestedPresentationFactor?: NationalPlaybackQualityFactor,
  ): Promise<NationalPaintReceipt> {
    if (this.operation) throw new Error("a National frame selection is already awaiting paint");
    const presentationFactor = requestedPresentationFactor
      ?? this.layer.getSnapshot().playbackQualityFactor
      ?? this.layer.finestCompletePlaybackFactor();
    const operation = this.layer.selectResidentAndWait(targetObservationId, presentationFactor);
    this.operation = operation;
    this.emit();
    try {
      const receipt = await operation;
      this.assertReceipt(receipt);
      const changed = this.lastReceipt?.observationId !== receipt.observationId;
      this.lastReceipt = receipt;
      if (changed) {
        this.transitionCount += 1;
        if (completesCycle) this.completedCycles += 1;
      }
      this.options.onPaint?.(receipt);
      return receipt;
    } finally {
      this.operation = null;
      this.emit();
      // A pause that landed while this selection was awaiting its paint could
      // not schedule refinement; the settled selection schedules it now unless
      // the pausing caller explicitly suppressed refinement for a transition.
      if (
        !this.playing
        && !this.disposed
        && this.refinementTimer === null
        && !this.suppressSettledRefinement
      ) {
        this.scheduleRefinement();
      }
    }
  }

  private scheduleRefinement() {
    this.clearRefinementTimer();
    if (this.playing || this.disposed) return;
    if (this.preparingQuality) {
      this.refinementAfterQualityPreparation = true;
      return;
    }
    this.refinementTimer = globalThis.setTimeout(() => {
      this.refinementTimer = null;
      const selected = this.layer.getSnapshot().selectedObservationId;
      const observation = this.observations.find(
        (candidate) => observationId(candidate) === selected,
      );
      if (observation && !this.playing && !this.disposed) {
        this.options.onRefinementRequested?.(observation);
      }
      this.emit();
    }, this.refinementSettleMs);
    this.emit();
  }

  private clearRefinementTimer() {
    if (this.refinementTimer !== null) globalThis.clearTimeout(this.refinementTimer);
    this.refinementTimer = null;
    this.refinementAfterQualityPreparation = false;
  }

  private acquireResidentOnlyActivity(): Promise<() => void> {
    return this.options.acquireResidentOnlyActivity?.()
      ?? Promise.resolve(() => {});
  }

  private stopPlayback() {
    this.playRequest += 1;
    this.qualityRequest += 1;
    this.preparingQuality = false;
    this.playing = false;
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    this.timer = null;
    this.layer.setPlaybackQualityLock(undefined);
    this.emit();
  }

  private dwellForCurrent(): number {
    const selected = this.layer.getSnapshot().selectedObservationId;
    return selected === observationId(this.observations.at(-1)!)
      ? this.latestDwellMs
      : this.dwellMs;
  }

  private assertReceipt(receipt: NationalPaintReceipt) {
    const renderer = this.layer.getSnapshot();
    if (
      receipt.generation !== this.observations[0].generation
      || receipt.contextEpoch !== renderer.contextEpoch
      || receipt.observationId !== renderer.selectedObservationId
      || receipt.presentationFactor !== renderer.presentationFactor
      || !this.observations.some((observation) => observationId(observation) === receipt.observationId)
    ) {
      throw new Error("National paint receipt does not match retained playback truth");
    }
  }

  private emit() {
    this.options.onState?.(this.snapshot());
  }

  private assertActive() {
    if (this.disposed) throw new Error("National playback controller is disposed");
  }
}

function assertObservationTimeline(
  observations: readonly NationalHistoryObservation[],
  historyLimit: 20 | 30,
) {
  if (observations.length < 1 || observations.length > historyLimit) {
    throw new Error(`National playback history must contain 1 to ${historyLimit} observations`);
  }
  for (let index = 0; index < observations.length; index += 1) {
    if (
      index > 0
      && observations[index].observationTimeUnixMs <= observations[index - 1].observationTimeUnixMs
    ) {
      throw new Error("National playback history must be strictly chronological");
    }
  }
}
