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
  private readonly dwellMs: number;
  private readonly latestDwellMs: number;

  constructor(
    private readonly layer: Pick<
      RadarCustomLayer,
      "getSnapshot" | "replaceResidentFrames" | "selectAndWait" | "waitForPaint"
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
    const operation = this.layer.waitForPaint(snapshot.selectionSequence);
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

  async replaceResidentFrames(
    frames: readonly RadarSweepCpuModel[],
  ): Promise<RadarPaintReceipt> {
    this.assertActive();
    if (frames.length < 1) throw new Error("playback requires at least one resident frame");
    await this.pauseAndWait();

    // The renderer swap and controller-frame update are synchronous so no
    // playback operation can observe IDs from different resident loops.
    this.layer.replaceResidentFrames(frames);
    this.frames = [...frames];
    this.lastReceipt = undefined;
    return this.establishInitialPaint();
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
    await this.pauseAndWait();
    return this.advanceOnce();
  }

  async scrub(index: number): Promise<RadarPaintReceipt> {
    this.assertActive();
    if (!Number.isInteger(index) || index < 0 || index >= this.frames.length) {
      throw new RangeError(`frame index ${index} is not resident`);
    }
    await this.pauseAndWait();
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
    await this.pauseAndWait();
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
      holdReason: this.operation ? "AWAITING_GPU_PAINT" : undefined,
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
    const priorSelectionSequence = this.layer.getSnapshot().selectionSequence;
    const operation = this.layer.selectAndWait(observationId);
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
}
