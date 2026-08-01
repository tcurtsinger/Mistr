import { describe, expect, it } from "vitest";
import { summarizeFramePerformance } from "./performanceMonitor";

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
});
