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

  it("keeps every valid reflectivity code operationally opaque without a low-return cutoff", () => {
    const palette = buildReflectivityPalette(2, 66);

    for (let rawCode = 2; rawCode < 256; rawCode += 1) {
      expect(palette[rawCode * 4 + 3]).toBe(255);
    }
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

  it("pins the NOAA operational SR_BREF anchor colors and interpolates between them", () => {
    expect(colorForReflectivity(-32)).toEqual([145, 137, 105, 255]);
    expect(colorForReflectivity(0)).toEqual([123, 136, 174, 255]);
    expect(colorForReflectivity(20)).toEqual([48, 214, 91, 255]);
    expect(colorForReflectivity(30)).toEqual([10, 115, 12, 255]);
    expect(colorForReflectivity(40)).toEqual([244, 202, 23, 255]);
    expect(colorForReflectivity(50)).toEqual([208, 8, 8, 255]);
    expect(colorForReflectivity(60)).toEqual([241, 185, 253, 255]);
    expect(colorForReflectivity(70)).toEqual([130, 0, 231, 255]);
    expect(colorForReflectivity(80)).toEqual([130, 0, 231, 255]);
    expect(colorForReflectivity(2.5)).toEqual([103, 121, 169, 255]);
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
