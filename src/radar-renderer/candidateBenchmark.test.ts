import { describe, expect, it } from "vitest";
import { benchmarkRendererCandidates } from "./candidateBenchmark";

describe("renderer candidate benchmark", () => {
  it("materializes the shared grid and selects a six-vertex polar quad", () => {
    const report = benchmarkRendererCandidates(2, 3);
    expect(report.sharedGeometry).toMatchObject({
      cpuBytes: 240,
      vertices: 12,
      indices: 36,
      triangles: 12,
    });
    expect(report.sharedGeometry.checksum).toBe(12);
    expect(report.polarSampling).toMatchObject({
      geometryBytes: 48,
      vertices: 6,
      triangles: 2,
    });
    expect(report.selected).toBe("polar_sampling_quad");
  });

  it("rejects dimensions outside the bounded native-grid contract", () => {
    expect(() => benchmarkRendererCandidates(0, 3)).toThrow("radialCount");
    expect(() => benchmarkRendererCandidates(2, 4_097)).toThrow("gateCount");
  });
});
