import { describe, expect, it } from "vitest";
import { decodeNationalRaw, nationalEdgeAlphaScale, sampleNationalGrid } from "./sampling";

describe("National numeric sampling", () => {
  it("decodes the complete structural u16 domain by the GRIB formula", () => {
    expect(decodeNationalRaw(1)).toEqual({ status: "valid", rawCode: 1, valueDbz: -998.9 });
    expect(decodeNationalRaw(65_535)).toEqual({
      status: "valid",
      rawCode: 65_535,
      valueDbz: 5_554.5,
    });
    expect(decodeNationalRaw(9_000).status).toBe("missing");
    expect(decodeNationalRaw(0).status).toBe("no_coverage");
  });

  it("keeps Native on the nearest selected-level cell at full opacity", () => {
    const raw = new Uint16Array([9_990, 10_000, 10_100, 10_200]);
    expect(sampleNationalGrid(raw, 2, 2, 0.8, 0.2, "native")).toEqual({
      status: "valid",
      rawCode: 10_000,
      valueDbz: 1,
      coverage: 1,
    });
  });

  it("uses spatial-only valid-neighbor smoothing", () => {
    const raw = new Uint16Array([9_990, 10_010, 10_030, 10_050]);
    const sample = sampleNationalGrid(raw, 2, 2, 0.5, 0.5, "smooth");
    expect(sample.status).toBe("valid");
    expect(sample.rawCode).toBe(10_020);
    expect(sample.valueDbz).toBe(3);
    expect(sample.coverage).toBe(1);
  });

  it("never mixes a missing or no-coverage value into the smoothed result", () => {
    // Weights at (0.25, 0.25) are 0.5625 / 0.1875 / 0.1875 / 0.0625. The
    // invalid neighbor drops out and the remaining three renormalize, so the
    // sentinel's own code can never influence the displayed value.
    const missing = new Uint16Array([9_990, 9_000, 10_030, 10_050]);
    const smoothed = sampleNationalGrid(missing, 2, 2, 0.25, 0.25, "smooth");
    const expectedCoverage = 0.5625 + 0.1875 + 0.0625;
    const expectedRaw = (9_990 * 0.5625 + 10_030 * 0.1875 + 10_050 * 0.0625) / expectedCoverage;
    expect(smoothed.status).toBe("valid");
    expect(smoothed.coverage).toBeCloseTo(expectedCoverage, 10);
    expect(smoothed.rawCode).toBeCloseTo(expectedRaw, 8);

    // A no-coverage sentinel at the same position must produce the identical
    // result: only validity matters, never the sentinel's numeric code.
    const uncovered = new Uint16Array([9_990, 0, 10_030, 10_050]);
    expect(sampleNationalGrid(uncovered, 2, 2, 0.25, 0.25, "smooth")).toEqual(smoothed);
  });

  it("softens an echo edge instead of collapsing it to a nearest-cell block", () => {
    // Two valid cells above two no-coverage cells. Sampling just inside the
    // measured row still blends both valid neighbors and reports partial
    // coverage, where the old contract snapped to one flat nearest square.
    const edge = new Uint16Array([10_200, 10_400, 0, 0]);
    const sample = sampleNationalGrid(edge, 2, 2, 0.5, 0.25, "smooth");
    expect(sample.rawCode).toBeCloseTo(10_300, 8);
    expect(sample.coverage).toBeCloseTo(0.75, 10);
    expect(nationalEdgeAlphaScale(sample.coverage)).toBeCloseTo(Math.sqrt(0.75), 10);
  });

  it("keeps a lone measured corner visible at half palette opacity", () => {
    const isolated = new Uint16Array([0, 0, 9_000, 10_600]);
    const sample = sampleNationalGrid(isolated, 2, 2, 0.5, 0.5, "smooth");
    expect(sample.rawCode).toBeCloseTo(10_600, 8);
    expect(sample.coverage).toBeCloseTo(0.25, 10);
    expect(nationalEdgeAlphaScale(sample.coverage)).toBeCloseTo(0.5, 10);
  });

  it("bounds the display-only edge fade", () => {
    expect(nationalEdgeAlphaScale(1)).toBe(1);
    expect(nationalEdgeAlphaScale(0)).toBe(0);
    expect(() => nationalEdgeAlphaScale(1.5)).toThrow("between 0 and 1");
  });
});
