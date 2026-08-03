import { describe, expect, it } from "vitest";
import {
  buildReflectivityPalette,
  buildStormRelativeVelocityPalette,
  colorForReflectivity,
  paletteColor,
  reflectivityDisplayAlpha,
  RANGE_FOLDED_COLOR,
  TRANSPARENT_COLOR,
} from "./palette";

describe("reflectivity palette", () => {
  it("keeps below-threshold transparent and range-folded explicit", () => {
    expect(paletteColor("reflectivity", 0, 1, 2, 66)).toEqual(TRANSPARENT_COLOR);
    expect(paletteColor("reflectivity", 1, 2, 2, 66)).toEqual(RANGE_FOLDED_COLOR);
    expect(paletteColor("reflectivity", 99, 7, 2, 66)).toEqual(TRANSPARENT_COLOR);
  });

  it("uploads premultiplied RGBA values for valid raw codes", () => {
    const palette = buildReflectivityPalette(2, 66);
    const rawCode = 166; // 50 dBZ
    const source = paletteColor("reflectivity", rawCode, 0, 2, 66);
    const uploaded = [...palette.slice(rawCode * 4, rawCode * 4 + 4)];
    const alpha = source[3] / 255;
    expect(uploaded).toEqual([
      Math.round(source[0] * alpha),
      Math.round(source[1] * alpha),
      Math.round(source[2] * alpha),
      source[3],
    ]);
  });

  it("validates every 256-entry palette byte against its exact physical dBZ", () => {
    const scale = 2;
    const offset = 66;
    const palette = buildReflectivityPalette(scale, offset);

    for (let rawCode = 0; rawCode < 256; rawCode += 1) {
      const uploaded = [...palette.slice(rawCode * 4, rawCode * 4 + 4)];
      if (rawCode < 2) {
        expect(uploaded).toEqual([0, 0, 0, 0]);
        continue;
      }

      const exactDbz = (rawCode - offset) / scale;
      const source = colorForReflectivity(exactDbz);
      const alpha = source[3] / 255;
      expect(uploaded).toEqual([
        Math.round(source[0] * alpha),
        Math.round(source[1] * alpha),
        Math.round(source[2] * alpha),
        source[3],
      ]);
    }
  });

  it("applies a monotonic weak-return visibility curve and preserves full operational opacity", () => {
    const palette = buildReflectivityPalette(2, 66);

    expect(reflectivityDisplayAlpha(-25)).toBe(0);
    expect(reflectivityDisplayAlpha(0)).toBe(0);
    expect(reflectivityDisplayAlpha(2.5)).toBe(48);
    expect(reflectivityDisplayAlpha(5)).toBe(96);
    expect(reflectivityDisplayAlpha(7.5)).toBe(131);
    expect(reflectivityDisplayAlpha(10)).toBe(166);
    expect(reflectivityDisplayAlpha(12.5)).toBe(192);
    expect(reflectivityDisplayAlpha(15)).toBe(217);
    expect(reflectivityDisplayAlpha(17.5)).toBe(236);
    expect(reflectivityDisplayAlpha(20)).toBe(255);
    expect(reflectivityDisplayAlpha(70)).toBe(255);

    let previous = -1;
    for (let dbz = -32; dbz <= 95; dbz += 0.1) {
      const alpha = reflectivityDisplayAlpha(dbz);
      expect(Number.isInteger(alpha)).toBe(true);
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThanOrEqual(255);
      expect(alpha).toBeGreaterThanOrEqual(previous);
      if (dbz <= 0) expect(alpha).toBe(0);
      if (dbz >= 20) expect(alpha).toBe(255);
      previous = alpha;
    }

    for (let rawCode = 106; rawCode < 256; rawCode += 1) {
      expect(palette[rawCode * 4 + 3]).toBe(255); // scale 2, offset 66: >= 20 dBZ
    }
  });

  it("maps the exact unrounded code-to-dBZ value before color interpolation", () => {
    const scale = 4;
    const offset = 62;
    const rawCode = 72; // 2.5 dBZ, deliberately between palette anchors.
    const exactDbz = (rawCode - offset) / scale;

    expect(paletteColor("reflectivity", rawCode, 0, scale, offset))
      .toEqual(colorForReflectivity(exactDbz));
    expect(paletteColor("reflectivity", rawCode, 0, scale, offset)[3]).toBe(48);
    expect(colorForReflectivity(exactDbz)).not.toEqual(colorForReflectivity(2));
    expect(colorForReflectivity(exactDbz)).not.toEqual(colorForReflectivity(3));
  });

  it("pins the NOAA operational SR_BREF anchor colors and interpolates between them", () => {
    expect(colorForReflectivity(-32)).toEqual([145, 137, 105, 0]);
    expect(colorForReflectivity(0)).toEqual([123, 136, 174, 0]);
    expect(colorForReflectivity(5)).toEqual([83, 106, 163, 96]);
    expect(colorForReflectivity(10)).toEqual([80, 133, 183, 166]);
    expect(colorForReflectivity(15)).toEqual([88, 193, 184, 217]);
    expect(colorForReflectivity(20)).toEqual([48, 214, 91, 255]);
    expect(colorForReflectivity(30)).toEqual([10, 115, 12, 255]);
    expect(colorForReflectivity(40)).toEqual([244, 202, 23, 255]);
    expect(colorForReflectivity(50)).toEqual([208, 8, 8, 255]);
    expect(colorForReflectivity(60)).toEqual([241, 185, 253, 255]);
    expect(colorForReflectivity(70)).toEqual([130, 0, 231, 255]);
    expect(colorForReflectivity(80)).toEqual([130, 0, 231, 255]);
    expect(colorForReflectivity(2.5)).toEqual([103, 121, 169, 48]);
  });

  it("premultiplies progressive weak-return colors without changing their RGB lookup", () => {
    const palette = buildReflectivityPalette(2, 66);
    const cases = [
      { rawCode: 66, source: [123, 136, 174, 0], uploaded: [0, 0, 0, 0] },
      { rawCode: 76, source: [83, 106, 163, 96], uploaded: [31, 40, 61, 96] },
      { rawCode: 86, source: [80, 133, 183, 166], uploaded: [52, 87, 119, 166] },
      { rawCode: 96, source: [88, 193, 184, 217], uploaded: [75, 164, 157, 217] },
      { rawCode: 106, source: [48, 214, 91, 255], uploaded: [48, 214, 91, 255] },
    ];

    for (const testCase of cases) {
      expect(paletteColor("reflectivity", testCase.rawCode, 0, 2, 66))
        .toEqual(testCase.source);
      expect([...palette.slice(testCase.rawCode * 4, testCase.rawCode * 4 + 4)])
        .toEqual(testCase.uploaded);
    }
  });

  it("keeps N0S categories separate from reflectivity scaling", () => {
    const palette = buildStormRelativeVelocityPalette();
    expect(paletteColor("storm_relative_velocity", 0, 1, 1, 0)).toEqual(TRANSPARENT_COLOR);
    expect(paletteColor("storm_relative_velocity", 15, 2, 1, 0)).toEqual(RANGE_FOLDED_COLOR);
    expect(paletteColor("storm_relative_velocity", 3, 0, 1, 0))
      .not.toEqual(paletteColor("storm_relative_velocity", 12, 0, 1, 0));
    expect([...palette.slice(3 * 4, 3 * 4 + 4)]).not.toEqual([0, 0, 0, 0]);
  });

  it("rejects invalid scale metadata", () => {
    expect(() => buildReflectivityPalette(0, 66)).toThrow("positive scale");
    expect(() => colorForReflectivity(Number.NaN)).toThrow("finite dBZ");
    expect(() => reflectivityDisplayAlpha(Number.POSITIVE_INFINITY)).toThrow("finite dBZ");
  });
});
