import { describe, expect, it } from "vitest";
import type {
  RadarPaintReceipt,
  RadarRendererSnapshot,
} from "../radar-renderer/RadarCustomLayer";
import type { RadarSweepCpuModel } from "../radar-renderer/cpuModel";
import { ResidentPlaybackController } from "./ResidentPlaybackController";

class FakeLayer {
  private selected = "frame-a";
  private painted = "frame-a";
  private sequence = 1;
  private generation = 7;
  private residentObservationIds = ["frame-a", "frame-b", "frame-c"];
  private pending: { complete(): void; fail(error: Error): void } | null = null;

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
    return Promise.resolve(this.receipt());
  }

  selectAndWait(observationId: string): Promise<RadarPaintReceipt> {
    if (observationId === this.selected) return Promise.resolve(this.receipt());
    this.selected = observationId;
    this.sequence += 1;
    return new Promise((resolve, reject) => {
      this.pending = {
        complete: () => {
          this.painted = observationId;
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
    this.generation += 1;
    this.residentObservationIds = models.map((model) => model.observationId);
    this.selected = this.residentObservationIds[0];
    this.painted = this.selected;
    this.sequence += 1;
  }

  completePaint() {
    this.pending?.complete();
  }

  failPaint(error = new Error("paint failed")) {
    this.pending?.fail(error);
  }

  private receipt(): RadarPaintReceipt {
    return {
      generation: this.generation,
      observationId: this.painted,
      contextEpoch: 3,
      selectionSequence: this.sequence,
      drawSequence: this.sequence * 2,
      completedAtUnixMs: 1_720_000_000_000,
      firstPaintLatencyMs: 2,
      residentSwitchLatencyMs: 1,
      framebufferWidth: 3840,
      framebufferHeight: 2160,
    };
  }
}

describe("resident playback truth", () => {
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

    await controller.replaceResidentFrames(replacements);
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
