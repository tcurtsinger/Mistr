import { describe, expect, it } from "vitest";
import { decodeNationalRaw, sampleNationalGrid } from "./sampling";

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

  it("ramps an echo boundary from full opacity to nothing across one cell", () => {
    // Valid top row, no-coverage bottom row. Opacity must fall continuously
    // from the last measured cell center to the first unmeasured one, where
    // the old contract held full opacity and then cut to a hard square.
    const edge = new Uint16Array([10_200, 10_400, 0, 0]);
    const centers = sampleNationalGrid(edge, 2, 2, 0.5, 0, "smooth");
    expect(centers.rawCode).toBeCloseTo(10_300, 8);
    expect(centers.coverage).toBe(1);

    const boundary = sampleNationalGrid(edge, 2, 2, 0.5, 0.5, "smooth");
    expect(boundary.rawCode).toBeCloseTo(10_300, 8);
    expect(boundary.coverage).toBeCloseTo(0.5, 10);

    const beyond = sampleNationalGrid(edge, 2, 2, 0.5, 0.9, "smooth");
    expect(beyond.coverage).toBeCloseTo(0.1, 10);
    // The measured value is still the mean of valid cells only, never a blend
    // toward the sentinel, no matter how faint the fragment becomes.
    expect(beyond.rawCode).toBeCloseTo(10_300, 8);
  });

  it("paints nothing where no valid cell contributes", () => {
    const edge = new Uint16Array([10_200, 10_400, 0, 0]);
    expect(sampleNationalGrid(edge, 2, 2, 0.5, 1, "smooth")).toEqual({
      status: "no_coverage",
      rawCode: 0,
      valueDbz: null,
      coverage: 0,
    });
  });

  it("renders a lone measured cell at full opacity on its own center", () => {
    const isolated = new Uint16Array([0, 0, 9_000, 10_600]);
    const center = sampleNationalGrid(isolated, 2, 2, 1, 1, "smooth");
    expect(center.rawCode).toBe(10_600);
    expect(center.coverage).toBe(1);

    const corner = sampleNationalGrid(isolated, 2, 2, 0.5, 0.5, "smooth");
    expect(corner.rawCode).toBeCloseTo(10_600, 8);
    expect(corner.coverage).toBeCloseTo(0.25, 10);
  });

  it("keeps Native hard-edged with no feather", () => {
    const edge = new Uint16Array([10_200, 10_400, 0, 0]);
    expect(sampleNationalGrid(edge, 2, 2, 0.5, 0.4, "native")).toEqual({
      status: "valid",
      rawCode: 10_400,
      valueDbz: 41,
      coverage: 1,
    });
    expect(sampleNationalGrid(edge, 2, 2, 0.5, 0.6, "native")).toEqual({
      status: "no_coverage",
      rawCode: 0,
      valueDbz: null,
      coverage: 0,
    });
  });
});
