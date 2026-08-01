import { afterEach, describe, expect, it, vi } from "vitest";
import { FramePerformanceMonitor, summarizeFramePerformance } from "./performanceMonitor";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("frame performance summary", () => {
  it("uses nearest-rank percentiles and counts only 50 ms long tasks", () => {
    const summary = summarizeFramePerformance([10, 12, 14, 16, 20], [49.9, 50, 75]);
    expect(summary).toEqual({
      sampleCount: 5,
      p50Ms: 14,
      p95Ms: 20,
      p99Ms: 20,
      maximumMs: 20,
      longTaskCount: 2,
      longestTaskMs: 75,
      longTaskObserverAvailable: true,
    });
  });

  it("drains buffered long-task records before disconnecting the observer", () => {
    class BufferedPerformanceObserver {
      static supportedEntryTypes = ["longtask"];
      observe() {}
      takeRecords(): PerformanceEntryList {
        return [{ duration: 75 } as PerformanceEntry];
      }
      disconnect() {}
    }
    vi.stubGlobal("PerformanceObserver", BufferedPerformanceObserver);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);

    const monitor = new FramePerformanceMonitor();
    monitor.start();
    expect(monitor.stop()).toMatchObject({
      longTaskObserverAvailable: true,
      longTaskCount: 1,
      longestTaskMs: 75,
    });
  });
});
