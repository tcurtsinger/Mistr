import { describe, expect, it, vi } from "vitest";
import {
  NationalMrmsSession,
  type NationalMrmsPaintResult,
} from "./NationalMrmsSession";
import { RadarSessionCoordinator, siteRadarSource } from "./RadarSessionCoordinator";

describe("NationalMrmsSession", () => {
  it("commits National source truth only after a matching paint", async () => {
    const persisted = vi.fn();
    const accepted = vi.fn();
    const coordinator = new RadarSessionCoordinator({ persistPaintedSource: persisted });
    coordinator.establishPaintedSource({
      source: siteRadarSource("KTLX"),
      generation: 1,
      observationId: "site-old",
    });
    const session = new NationalMrmsSession({
      coordinator,
      nextGeneration: () => 2,
      async acquireAndPaint(generation) {
        expect(coordinator.snapshot().painted?.observationId).toBe("site-old");
        return {
          value: "national-ready",
          paint: {
            source: { kind: "national", domain: "conus" },
            generation,
            observationId: "national-current",
          },
        };
      },
      onPaintAccepted: accepted,
    });
    await expect(session.start()).resolves.toBe("national-ready");
    expect(coordinator.snapshot().painted).toEqual({
      source: { kind: "national", domain: "conus" },
      generation: 2,
      observationId: "national-current",
    });
    expect(persisted).toHaveBeenCalledWith({ kind: "national", domain: "conus" });
    expect(accepted).toHaveBeenCalledOnce();
  });

  it("preserves the prior painted Site when National staging fails", async () => {
    const coordinator = new RadarSessionCoordinator();
    const failed = vi.fn(() => {
      expect(coordinator.snapshot().transition).toBeUndefined();
    });
    coordinator.establishPaintedSource({
      source: siteRadarSource("KTLX"),
      generation: 4,
      observationId: "site-old",
    });
    const session = new NationalMrmsSession({
      coordinator,
      nextGeneration: () => 5,
      async acquireAndPaint() {
        throw new Error("chunk upload failed");
      },
      onTransitionFailed: failed,
    });
    await expect(session.start()).rejects.toThrow("chunk upload failed");
    expect(coordinator.snapshot().painted?.observationId).toBe("site-old");
    expect(coordinator.snapshot().requestedSource).toBeUndefined();
    expect(failed).toHaveBeenCalledWith(expect.any(Error), 5);
  });

  it("rejects a stale National receipt after a newer Site request supersedes it", async () => {
    const coordinator = new RadarSessionCoordinator();
    const failed = vi.fn();
    let finish: ((value: {
      value: string;
      paint: {
        source: { kind: "national"; domain: "conus" };
        generation: number;
        observationId: string;
      };
    }) => void) | undefined;
    const session = new NationalMrmsSession({
      coordinator,
      nextGeneration: () => 2,
      acquireAndPaint: () => new Promise<NationalMrmsPaintResult<string>>((resolve) => {
        finish = resolve;
      }),
      onTransitionFailed: failed,
    });
    const pending = session.start();
    coordinator.beginTransition(siteRadarSource("KEWX"), 3);
    finish?.({
      value: "stale",
      paint: {
        source: { kind: "national", domain: "conus" },
        generation: 2,
        observationId: "national-stale",
      },
    });
    await expect(pending).rejects.toThrow(/superseded/);
    expect(coordinator.snapshot().painted).toBeUndefined();
    expect(failed).not.toHaveBeenCalled();
  });

  it("reveals a resident National history under its original generation", async () => {
    const coordinator = new RadarSessionCoordinator();
    coordinator.establishPaintedSource({
      source: { kind: "national", domain: "conus" },
      generation: 3,
      observationId: "national-newest",
    });
    coordinator.establishPaintedSource({
      source: siteRadarSource("KTLX"),
      generation: 9,
      observationId: "site-current",
    });
    const modes: string[] = [];
    const session = new NationalMrmsSession({
      coordinator,
      nextGeneration: () => 10,
      residentGeneration: () => 3,
      async acquireAndPaint(generation, mode) {
        modes.push(`${mode}:${generation}`);
        return {
          value: "revealed",
          paint: { source: { kind: "national", domain: "conus" }, generation, observationId: "national-newest" },
        };
      },
    });
    await expect(session.start()).resolves.toBe("revealed");
    expect(modes).toEqual(["reveal:3"]);
    expect(coordinator.snapshot().painted).toMatchObject({ generation: 3, source: { kind: "national" } });
    // Later playback paints from the same history keep synchronizing.
    expect(coordinator.synchronizePaint({
      source: { kind: "national", domain: "conus" },
      generation: 3,
      observationId: "national-older",
    })).toBe(true);
    // A new Site request still gets a fresh, strictly newer generation.
    expect(coordinator.beginTransition(siteRadarSource("KTLX"), 1).generation).toBe(10);
  });

  it("acquires normally when no National history is resident", async () => {
    const coordinator = new RadarSessionCoordinator();
    const modes: string[] = [];
    const session = new NationalMrmsSession({
      coordinator,
      nextGeneration: () => 4,
      residentGeneration: () => undefined,
      async acquireAndPaint(generation, mode) {
        modes.push(`${mode}:${generation}`);
        return {
          value: "acquired",
          paint: { source: { kind: "national", domain: "conus" }, generation, observationId: "n" },
        };
      },
    });
    await session.start();
    expect(modes).toEqual(["acquire:4"]);
  });
});
