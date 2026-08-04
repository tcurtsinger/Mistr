import { describe, expect, it, vi } from "vitest";
import {
  isPaintedNationalSource,
  RadarSessionCoordinator,
  siteRadarSource,
  type RadarPaintIdentity,
} from "./RadarSessionCoordinator";
import {
  isRadarSourceSuperseded,
  RadarSourceSupersededError,
  SiteLevel2Session,
} from "./SiteLevel2Session";

function sitePaint(siteIcao: string, generation: number, observationId: string): RadarPaintIdentity {
  return {
    source: siteRadarSource(siteIcao),
    generation,
    observationId,
  };
}

describe("RadarSessionCoordinator", () => {
  it("keeps requested source intent separate from painted-source truth", () => {
    const coordinator = new RadarSessionCoordinator();
    coordinator.establishPaintedSource(sitePaint("KTLX", 1, "painted-ktlx"));

    const transition = coordinator.beginTransition(siteRadarSource("KAMX"), 2);

    expect(coordinator.snapshot()).toMatchObject({
      generation: 2,
      requestedSource: { kind: "site", siteIcao: "KAMX" },
      painted: {
        source: { kind: "site", siteIcao: "KTLX" },
        observationId: "painted-ktlx",
      },
    });

    expect(coordinator.acceptPaint(transition, sitePaint("KAMX", 2, "painted-kamx"))).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      generation: 2,
      painted: {
        source: { kind: "site", siteIcao: "KAMX" },
        observationId: "painted-kamx",
      },
    });
    expect(coordinator.snapshot().requestedSource).toBeUndefined();
  });

  it("represents future CONUS National intent without exposing a National session", () => {
    const coordinator = new RadarSessionCoordinator();
    coordinator.establishPaintedSource(sitePaint("KTLX", 1, "painted-ktlx"));

    coordinator.beginTransition({ kind: "national", domain: "conus" }, 2);

    expect(coordinator.snapshot()).toMatchObject({
      requestedSource: { kind: "national", domain: "conus" },
      painted: { source: { kind: "site", siteIcao: "KTLX" } },
    });
    expect(isPaintedNationalSource(coordinator.snapshot())).toBe(false);
  });

  it("gates Site renderer replacement on accepted National paint, not staging intent", () => {
    const coordinator = new RadarSessionCoordinator();
    coordinator.establishPaintedSource(sitePaint("KTLX", 1, "painted-ktlx"));
    const transition = coordinator.beginTransition({ kind: "national", domain: "conus" }, 2);

    expect(isPaintedNationalSource(coordinator.snapshot())).toBe(false);

    coordinator.acceptPaint(transition, {
      source: { kind: "national", domain: "conus" },
      generation: 2,
      observationId: "painted-national",
    });
    expect(isPaintedNationalSource(coordinator.snapshot())).toBe(true);
  });

  it("supersedes an older transition and rejects its late receipt", () => {
    const coordinator = new RadarSessionCoordinator();
    coordinator.establishPaintedSource(sitePaint("KTLX", 1, "painted-ktlx"));
    const older = coordinator.beginTransition(siteRadarSource("KAMX"), 2);
    const current = coordinator.beginTransition(siteRadarSource("KOKX"), 3);

    expect(coordinator.acceptPaint(older, sitePaint("KAMX", 2, "late-kamx"))).toBe(false);
    expect(coordinator.snapshot().painted?.observationId).toBe("painted-ktlx");
    expect(coordinator.acceptPaint(current, sitePaint("KOKX", 3, "painted-kokx"))).toBe(true);
    expect(coordinator.snapshot().painted?.source).toEqual(siteRadarSource("KOKX"));
  });

  it("rolls failed transitions back to the prior painted source", () => {
    const coordinator = new RadarSessionCoordinator();
    coordinator.establishPaintedSource(sitePaint("KTLX", 1, "painted-ktlx"));
    const transition = coordinator.beginTransition(siteRadarSource("KINX"), 2);

    expect(coordinator.failTransition(transition, new Error("provider unavailable"))).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      painted: {
        source: { kind: "site", siteIcao: "KTLX" },
        observationId: "painted-ktlx",
      },
      lastFailure: "provider unavailable",
    });
    expect(coordinator.snapshot().requestedSource).toBeUndefined();
  });

  it("rejects a receipt with a stale generation even for the requested source", () => {
    const coordinator = new RadarSessionCoordinator();
    const transition = coordinator.beginTransition(siteRadarSource("KTLX"), 4);

    expect(coordinator.acceptPaint(transition, sitePaint("KTLX", 3, "stale"))).toBe(false);
    expect(coordinator.snapshot().painted).toBeUndefined();
    expect(coordinator.snapshot().requestedSource).toEqual(siteRadarSource("KTLX"));
  });

  it("persists only after a matching authoritative paint is accepted", () => {
    const persist = vi.fn();
    const coordinator = new RadarSessionCoordinator({ persistPaintedSource: persist });
    const transition = coordinator.beginTransition(siteRadarSource("KTLX"), 1);

    expect(persist).not.toHaveBeenCalled();
    expect(coordinator.acceptPaint(transition, sitePaint("KTLX", 1, "painted"))).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(siteRadarSource("KTLX"));

    const diagnostic = coordinator.beginTransition(
      siteRadarSource("KAMX"),
      2,
      { persistOnPaint: false },
    );
    expect(coordinator.acceptPaint(diagnostic, sitePaint("KAMX", 2, "diagnostic"))).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
  });
});

describe("SiteLevel2Session", () => {
  it("puts the selected-site engine behind transition and paint acceptance", async () => {
    const coordinator = new RadarSessionCoordinator();
    const acquireAndPaint = vi.fn(async (siteIcao: string, generation: number) => ({
      value: `report-${siteIcao}`,
      paint: sitePaint(siteIcao, generation, `painted-${siteIcao}`),
    }));
    const session = new SiteLevel2Session<string>({
      coordinator,
      nextGeneration: () => 7,
      acquireAndPaint,
    });

    await expect(session.start("KTLX")).resolves.toBe("report-KTLX");
    expect(acquireAndPaint).toHaveBeenCalledWith("KTLX", 7);
    expect(coordinator.snapshot().painted).toEqual(sitePaint("KTLX", 7, "painted-KTLX"));
  });

  it("does not let a superseded selected-site request commit", async () => {
    const coordinator = new RadarSessionCoordinator();
    const failed = vi.fn();
    const completions = new Map<string, (result: {
      value: string;
      paint: RadarPaintIdentity;
    }) => void>();
    let generation = 0;
    const session = new SiteLevel2Session({
      coordinator,
      nextGeneration: () => {
        generation += 1;
        return generation;
      },
      acquireAndPaint: (siteIcao, requestGeneration) => new Promise<{
        value: string;
        paint: RadarPaintIdentity;
      }>((resolve) => {
        completions.set(siteIcao, resolve);
        expect(coordinator.snapshot().requestedSource).toEqual(siteRadarSource(siteIcao));
        expect(coordinator.snapshot().transition?.generation).toBe(requestGeneration);
      }),
      onTransitionFailed: failed,
    });

    const first = session.start("KAMX");
    const second = session.start("KOKX");
    completions.get("KAMX")?.({ value: "old", paint: sitePaint("KAMX", 1, "old") });
    await expect(first).rejects.toBeInstanceOf(RadarSourceSupersededError);
    completions.get("KOKX")?.({ value: "new", paint: sitePaint("KOKX", 2, "new") });
    await expect(second).resolves.toBe("new");
    expect(coordinator.snapshot().painted?.source).toEqual(siteRadarSource("KOKX"));
    expect(failed).not.toHaveBeenCalled();
  });

  it("preserves a provider error code when a rejected request was superseded", async () => {
    const coordinator = new RadarSessionCoordinator();
    let rejectOld: ((error: unknown) => void) | undefined;
    let generation = 0;
    const providerError = { code: "live_sweep_failed", message: "cancelled" };
    const session = new SiteLevel2Session<string>({
      coordinator,
      nextGeneration: () => {
        generation += 1;
        return generation;
      },
      acquireAndPaint: (siteIcao, requestGeneration) => {
        if (siteIcao === "KAMX") {
          return new Promise((_, reject) => {
            rejectOld = reject;
          });
        }
        return Promise.resolve({
          value: "current",
          paint: sitePaint(siteIcao, requestGeneration, "current"),
        });
      },
    });

    const old = session.start("KAMX");
    await expect(session.start("KTLX")).resolves.toBe("current");
    rejectOld?.(providerError);
    const rejected = await old.catch((error: unknown) => error);

    expect(rejected).toBe(providerError);
    expect((rejected as typeof providerError).code).toBe("live_sweep_failed");
    expect(isRadarSourceSuperseded(rejected)).toBe(true);
  });

  it("reports only a current selected-site failure after coordinator rollback", async () => {
    const coordinator = new RadarSessionCoordinator();
    coordinator.establishPaintedSource({
      source: { kind: "national", domain: "conus" },
      generation: 4,
      observationId: "national-current",
    });
    const providerError = new Error("site acquisition failed");
    const failed = vi.fn((error: unknown, generation: number, siteIcao: string) => {
      expect(error).toBe(providerError);
      expect(generation).toBe(5);
      expect(siteIcao).toBe("KTLX");
      expect(coordinator.snapshot()).toMatchObject({
        painted: {
          source: { kind: "national", domain: "conus" },
          generation: 4,
          observationId: "national-current",
        },
        transition: undefined,
        lastFailure: "site acquisition failed",
      });
    });
    const session = new SiteLevel2Session<string>({
      coordinator,
      nextGeneration: () => 5,
      acquireAndPaint: async () => {
        throw providerError;
      },
      onTransitionFailed: failed,
    });

    await expect(session.start("KTLX")).rejects.toBe(providerError);
    expect(failed).toHaveBeenCalledOnce();
  });
});
