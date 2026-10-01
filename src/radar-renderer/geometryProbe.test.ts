import { describe, expect, it } from "vitest";
import { evaluateRadarGeometry, radarGeometryProbePoints } from "./geometryProbe";

describe("radar geometry probe", () => {
  const points = radarGeometryProbePoints();
  const exactSite = points.site.flatMap((point) => [point.groundRangeM, point.bearingRadians]);
  const exactNational = points.national.map((point) => point.latitudeDegrees);

  it("samples every probe radar from the first gates to the edge of Level II range", () => {
    expect(points.site).toHaveLength(5 * 8 * 12);
    const ranges = points.site.map((point) => point.groundRangeM);
    // Float32 Mercator input moves a point by at most a few metres.
    expect(Math.min(...ranges)).toBeGreaterThan(1_990);
    expect(Math.max(...ranges)).toBeLessThan(460_010);
    const latitudes = [20, 25, 30, 35, 37.5, 40, 42.5, 45, 50, 55];
    points.national.forEach((point, index) => {
      expect(Math.abs(point.latitudeDegrees - latitudes[index])).toBeLessThan(1e-4);
    });
  });

  it("reports zero error for exact results", () => {
    const report = evaluateRadarGeometry(points, exactSite, exactNational, "exact");
    expect(report).toMatchObject({
      renderer: "exact",
      siteSamples: 480,
      maxSiteRangeErrorM: 0,
      maxSiteBearingErrorDegrees: 0,
      maxSiteCrossRangeErrorM: 0,
      nationalSamples: 10,
      maxNationalLatitudeErrorM: 0,
    });
  });

  it("sees a constant arcsine bias as a range error", () => {
    // The ANGLE/D3D11 asin bias: +6.77e-5 rad, twice over the Earth's radius.
    const biased = exactSite.map((value, index) => (index % 2 === 0 ? value + 2 * 6_371_008.8 * 6.77e-5 : value));
    expect(evaluateRadarGeometry(points, biased, exactNational).maxSiteRangeErrorM).toBeCloseTo(862.6, 0);
  });

  it("measures bearing error across north", () => {
    const wrapped = exactSite.map((value, index) => (index % 2 === 1 ? (value + 2 * Math.PI + 0.001) % (2 * Math.PI) : value));
    const report = evaluateRadarGeometry(points, wrapped, exactNational);
    expect(report.maxSiteBearingErrorDegrees).toBeCloseTo(0.0573, 3);
    // 0.001 rad at 460 km moves a point 460 m.
    expect(report.maxSiteCrossRangeErrorM).toBeCloseTo(460, -1);
  });

  it("treats a non-finite result as the worst error", () => {
    const broken = [...exactNational];
    broken[3] = Number.NaN;
    expect(evaluateRadarGeometry(points, exactSite, broken).maxNationalLatitudeErrorM).toBe(Infinity);
  });
});
