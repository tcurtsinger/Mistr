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

  it("keeps Native on the nearest selected-level cell", () => {
    const raw = new Uint16Array([9_990, 10_000, 10_100, 10_200]);
    expect(sampleNationalGrid(raw, 2, 2, 0.8, 0.2, "native")).toEqual({
      status: "valid",
      rawCode: 10_000,
      valueDbz: 1,
    });
  });

  it("uses spatial-only valid-neighbor smoothing", () => {
    const raw = new Uint16Array([9_990, 10_010, 10_030, 10_050]);
    const sample = sampleNationalGrid(raw, 2, 2, 0.5, 0.5, "smooth");
    expect(sample.status).toBe("valid");
    expect(sample.rawCode).toBe(10_020);
    expect(sample.valueDbz).toBe(3);
  });

  it("never interpolates across missing or no-coverage status", () => {
    const missing = new Uint16Array([9_990, 9_000, 10_030, 10_050]);
    expect(sampleNationalGrid(missing, 2, 2, 0.25, 0.25, "smooth")).toEqual({
      status: "valid",
      rawCode: 9_990,
      valueDbz: 0,
    });
    const uncovered = new Uint16Array([9_990, 0, 10_030, 10_050]);
    expect(sampleNationalGrid(uncovered, 2, 2, 0.25, 0.25, "smooth")).toEqual({
      status: "valid",
      rawCode: 9_990,
      valueDbz: 0,
    });
  });
});
