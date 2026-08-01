import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RadarPaintReceipt,
  RadarRendererSnapshot,
} from "../radar-renderer/RadarCustomLayer";
import type { RadarSweepCpuModel } from "../radar-renderer/cpuModel";
import { ResidentPlaybackController } from "./ResidentPlaybackController";

class FakeLayer {
  private selected = "frame-a";
  private painted: string | undefined = "frame-a";
  private sequence = 1;
  private paintedSequence = 1;
  private generation = 7;
  private paintedGeneration = 7;
  private residentObservationIds = ["frame-a", "frame-b", "frame-c"];
  private pending: { complete(): void; fail(error: Error): void } | null = null;
  private replacement: {
    selected: string;
    painted: string | undefined;
    sequence: number;
    paintedSequence: number;
    generation: number;
    paintedGeneration: number;
    residentObservationIds: string[];
  } | null = null;

  getSnapshot(): RadarRendererSnapshot {
    return {
      status: "painted",
      observationId: this.selected,
      selectedObservationId: this.selected,
      lastPaintedObservationId: this.painted,
      generation: this.generation,
      selectionSequence: this.sequence,
      residentObservationIds: this.residentObservationIds,
      contextEpoch: 3,
      textureValidationsPassed: 3,
      shaderLog: [],
    };
  }

  waitForPaint(): Promise<RadarPaintReceipt> {
    if (this.selected === this.painted && this.generation === this.paintedGeneration) {
      return Promise.resolve(this.receipt());
    }
    return this.beginPendingPaint();
  }

  selectAndWait(observationId: string): Promise<RadarPaintReceipt> {
    if (observationId === this.selected) return Promise.resolve(this.receipt());
    this.selected = observationId;
    this.sequence += 1;
    return this.beginPendingPaint();
  }

  private beginPendingPaint(): Promise<RadarPaintReceipt> {
    return new Promise((resolve, reject) => {
      this.pending = {
        complete: () => {
          this.painted = this.selected;
          this.paintedSequence = this.sequence;
          this.paintedGeneration = this.generation;
          this.pending = null;
          resolve(this.receipt());
        },
        fail: (error) => {
          this.pending = null;
          reject(error);
        },
      };
    });
  }

  replaceResidentFrames(models: readonly RadarSweepCpuModel[]): void {
    this.replacement = {
      selected: this.selected,
      painted: this.painted,
      sequence: this.sequence,
      paintedSequence: this.paintedSequence,
      generation: this.generation,
      paintedGeneration: this.paintedGeneration,
      residentObservationIds: this.residentObservationIds,
    };
    this.generation += 1;
    this.residentObservationIds = models.map((model) => model.observationId);
    this.selected = this.residentObservationIds[0];
    this.sequence += 1;
  }

  commitResidentFrameReplacement(selectionSequence: number): void {
    if (!this.replacement || selectionSequence !== this.sequence) {
      throw new Error("replacement is not ready to commit");
    }
    this.replacement = null;
  }

  rollbackResidentFrameReplacement(): Promise<RadarPaintReceipt> {
    if (!this.replacement) throw new Error("replacement is not pending");
    this.selected = this.replacement.selected;
    this.sequence = this.replacement.sequence;
    this.generation = this.replacement.generation;
    this.residentObservationIds = this.replacement.residentObservationIds;
    this.painted = undefined;
    this.paintedSequence = 0;
    this.paintedGeneration = 0;
    this.replacement = null;
    return this.beginPendingPaint();
  }

  completePaint() {
    this.pending?.complete();
  }

  failPaint(error = new Error("paint failed")) {
    this.pending?.fail(error);
  }

  private receipt(): RadarPaintReceipt {
    if (!this.painted) throw new Error("there is no completed fake paint");
    return {
      generation: this.paintedGeneration,
      observationId: this.painted,
      contextEpoch: 3,
      selectionSequence: this.paintedSequence,
      drawSequence: this.paintedSequence * 2,
      completedAtUnixMs: 1_720_000_000_000,
      firstPaintLatencyMs: 2,
      residentSwitchLatencyMs: 1,
      framebufferWidth: 3840,
      framebufferHeight: 2160,
    };
  }
}

describe("resident playback truth", () => {
  afterEach(() => vi.useRealTimers());
  it("does not advance the playhead until the selected frame produces a paint receipt", async () => {
    const layer = new FakeLayer();
    const controller = new ResidentPlaybackController(layer, frames());
    await controller.establishInitialPaint();

    const pending = controller.scrub(1);
    await Promise.resolve();
    expect(controller.snapshot()).toMatchObject({
      selectedObservationId: "frame-b",
      lastPaintedObservationId: "frame-a",
      playheadObservedAtUnixMs: 100,
      holdReason: "AWAITING_GPU_PAINT",
    });

    layer.completePaint();
    await pending;
    expect(controller.snapshot()).toMatchObject({
      selectedObservationId: "frame-b",
      lastPaintedObservationId: "frame-b",
      playheadObservedAtUnixMs: 200,
      transitionCount: 1,
    });
  });

  it("rejects a scrub target that is not resident", async () => {
    const controller = new ResidentPlaybackController(new FakeLayer(), frames());
    await expect(controller.scrub(3)).rejects.toThrow("not resident");
  });

  it("advances through replacement observation IDs instead of the constructor-time loop", async () => {
    const layer = new FakeLayer();
    const controller = new ResidentPlaybackController(layer, frames());
    const replacements = [frame("replacement-a", 400), frame("replacement-b", 500)];

    const replacement = controller.replaceResidentFrames(replacements);
    await Promise.resolve();
    layer.completePaint();
    await replacement;
    const pending = controller.step();
    await Promise.resolve();

    expect(controller.snapshot()).toMatchObject({
      generation: 8,
      residentCount: 2,
      selectedObservationId: "replacement-b",
      lastPaintedObservationId: "replacement-a",
      playheadObservedAtUnixMs: 400,
    });

    layer.completePaint();
    await expect(pending).resolves.toMatchObject({ observationId: "replacement-b" });
    expect(controller.snapshot()).toMatchObject({
      selectedObservationId: "replacement-b",
      lastPaintedObservationId: "replacement-b",
      playheadObservedAtUnixMs: 500,
    });
  });

  it("rechecks publication ownership after waiting for an in-progress paint", async () => {
    const layer = new FakeLayer();
    const controller = new ResidentPlaybackController(layer, frames());
    const inProgress = controller.scrub(1);
    await Promise.resolve();
    let ownsGeneration = true;
    const replacement = controller.replaceResidentFrames(
      [frame("replacement-a", 400)],
      () => {
        if (!ownsGeneration) throw new Error("generation was superseded");
      },
    );

    ownsGeneration = false;
    layer.completePaint();
    await inProgress;
    await expect(replacement).rejects.toThrow("generation was superseded");
    expect(controller.snapshot()).toMatchObject({
      generation: 7,
      residentCount: 3,
      selectedObservationId: "frame-b",
      lastPaintedObservationId: "frame-b",
    });
  });

  it("rolls back the resident loop when the replacement paint fails", async () => {
    const layer = new FakeLayer();
    const controller = new ResidentPlaybackController(layer, frames());
    await controller.establishInitialPaint();

    const replacement = controller.replaceResidentFrames([frame("replacement-a", 400)]);
    await Promise.resolve();
    expect(controller.snapshot()).toMatchObject({
      generation: 8,
      residentCount: 1,
      selectedObservationId: "replacement-a",
      lastPaintedObservationId: "frame-a",
    });
    layer.failPaint();

    await vi.waitFor(() => {
      expect(controller.snapshot()).toMatchObject({
        generation: 7,
        residentCount: 3,
        selectedObservationId: "frame-a",
        lastPaintedObservationId: undefined,
        holdReason: "AWAITING_GPU_PAINT",
      });
    });
    layer.completePaint();
    await expect(replacement).rejects.toThrow("paint failed");
    expect(controller.snapshot()).toMatchObject({
      generation: 7,
      residentCount: 3,
      selectedObservationId: "frame-a",
      lastPaintedObservationId: "frame-a",
      playheadObservedAtUnixMs: 100,
    });
  });

  it("rolls back a replacement superseded while its GPU paint is pending", async () => {
    const layer = new FakeLayer();
    const controller = new ResidentPlaybackController(layer, frames());
    await controller.establishInitialPaint();
    let ownsGeneration = true;

    const replacement = controller.replaceResidentFrames(
      [frame("replacement-a", 400)],
      () => {
        if (!ownsGeneration) throw new Error("generation was superseded");
      },
    );
    await Promise.resolve();
    ownsGeneration = false;
    layer.completePaint();

    await vi.waitFor(() => {
      expect(controller.snapshot()).toMatchObject({
        generation: 7,
        residentCount: 3,
        selectedObservationId: "frame-a",
        lastPaintedObservationId: undefined,
        holdReason: "AWAITING_GPU_PAINT",
      });
    });
    layer.completePaint();
    await expect(replacement).rejects.toThrow("generation was superseded");
    expect(controller.snapshot()).toMatchObject({
      generation: 7,
      residentCount: 3,
      selectedObservationId: "frame-a",
      lastPaintedObservationId: "frame-a",
      playheadObservedAtUnixMs: 100,
    });
  });

  it("counts a completed cycle only after the wraparound frame paints", async () => {
    const layer = new FakeLayer();
    const controller = new ResidentPlaybackController(layer, frames());

    const selectLast = controller.scrub(2);
    await Promise.resolve();
    layer.completePaint();
    await selectLast;

    const failedWrap = controller.step();
    await Promise.resolve();
    layer.failPaint();
    await expect(failedWrap).rejects.toThrow("paint failed");
    expect(controller.snapshot()).toMatchObject({
      transitionCount: 1,
      completedCycles: 0,
      lastPaintedObservationId: "frame-c",
    });
  });

  it("does not count scrubbing to the already-selected frame as a transition", async () => {
    const layer = new FakeLayer();
    const controller = new ResidentPlaybackController(layer, frames());
    await controller.establishInitialPaint();

    await controller.scrub(0);

    expect(controller.snapshot()).toMatchObject({
      transitionCount: 0,
      completedCycles: 0,
      selectedObservationId: "frame-a",
      lastPaintedObservationId: "frame-a",
    });
  });

  it("does not invent transitions or cycles for a one-frame loop", async () => {
    const layer = new FakeLayer();
    const controller = new ResidentPlaybackController(layer, [frame("frame-a", 100)]);
    await controller.establishInitialPaint();

    await controller.step();

    expect(controller.snapshot()).toMatchObject({
      transitionCount: 0,
      completedCycles: 0,
      selectedObservationId: "frame-a",
      lastPaintedObservationId: "frame-a",
    });
  });

  it("starts playback after a pending manual selection paints", async () => {
    vi.useFakeTimers();
    const layer = new FakeLayer();
    const controller = new ResidentPlaybackController(layer, frames(), {
      dwellMs: 1,
      latestDwellMs: 1,
    });
    const scrub = controller.scrub(1);
    await Promise.resolve();

    controller.play();
    vi.advanceTimersByTime(5);
    expect(controller.snapshot()).toMatchObject({
      playing: true,
      selectedObservationId: "frame-b",
      holdReason: "AWAITING_GPU_PAINT",
    });

    layer.completePaint();
    await scrub;
    await Promise.resolve();
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(controller.snapshot()).toMatchObject({
      playing: true,
      selectedObservationId: "frame-c",
      holdReason: "AWAITING_GPU_PAINT",
    });

    controller.pause();
    layer.completePaint();
    await controller.pauseAndWait();
  });
});

function frames(): RadarSweepCpuModel[] {
  return [
    frame("frame-a", 100),
    frame("frame-b", 200),
    frame("frame-c", 300),
  ];
}

function frame(observationId: string, observedAtUnixMs: number): RadarSweepCpuModel {
  return {
    observationId,
    observedAtUnixMs,
    volumeEndedAtUnixMs: observedAtUnixMs + 1,
  } as RadarSweepCpuModel;
}
