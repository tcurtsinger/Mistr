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
  private pending: (() => void) | null = null;

  getSnapshot(): RadarRendererSnapshot {
    return {
      status: "painted",
      observationId: this.selected,
      selectedObservationId: this.selected,
      lastPaintedObservationId: this.painted,
      generation: 7,
      selectionSequence: this.sequence,
      residentObservationIds: ["frame-a", "frame-b", "frame-c"],
      contextEpoch: 3,
      textureValidationsPassed: 3,
      shaderLog: [],
    };
  }

  waitForPaint(): Promise<RadarPaintReceipt> {
    return Promise.resolve(this.receipt());
  }

  selectAndWait(observationId: string): Promise<RadarPaintReceipt> {
    this.selected = observationId;
    this.sequence += 1;
    return new Promise((resolve) => {
      this.pending = () => {
        this.painted = observationId;
        this.pending = null;
        resolve(this.receipt());
      };
    });
  }

  completePaint() {
    this.pending?.();
  }

  private receipt(): RadarPaintReceipt {
    return {
      generation: 7,
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
