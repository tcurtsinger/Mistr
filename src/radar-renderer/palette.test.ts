import { describe, expect, it } from "vitest";
import {
  buildReflectivityPalette,
  buildStormRelativeVelocityPalette,
  colorForReflectivity,
  paletteColor,
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

  it("keeps every valid reflectivity code visible without a low-return cutoff", () => {
    const palette = buildReflectivityPalette(2, 66);
    const alphas: number[] = [];

    for (let rawCode = 2; rawCode < 256; rawCode += 1) {
      const alpha = palette[rawCode * 4 + 3];
      expect(alpha).toBeGreaterThan(0);
      alphas.push(alpha);
    }

    for (let index = 1; index < alphas.length; index += 1) {
      expect(alphas[index]).toBeGreaterThanOrEqual(alphas[index - 1]);
      expect(alphas[index] - alphas[index - 1]).toBeLessThanOrEqual(4);
    }

    expect(alphas[0]).toBeLessThan(32);
  });

  it("maps the exact unrounded code-to-dBZ value before color interpolation", () => {
    const scale = 4;
    const offset = 62;
    const rawCode = 72; // 2.5 dBZ, deliberately between palette anchors.
    const exactDbz = (rawCode - offset) / scale;

    expect(paletteColor("reflectivity", rawCode, 0, scale, offset))
      .toEqual(colorForReflectivity(exactDbz));
    expect(colorForReflectivity(exactDbz)).not.toEqual(colorForReflectivity(2));
    expect(colorForReflectivity(exactDbz)).not.toEqual(colorForReflectivity(3));
  });

  it("preserves exact anchor colors while interpolating between them", () => {
    expect(colorForReflectivity(-32)).toEqual([57, 80, 110, 18]);
    expect(colorForReflectivity(20)).toEqual([39, 163, 57, 156]);
    expect(colorForReflectivity(50)).toEqual([211, 46, 50, 244]);
    expect(colorForReflectivity(2.5)).toEqual([40, 167, 153, 56]);
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
  });
});
