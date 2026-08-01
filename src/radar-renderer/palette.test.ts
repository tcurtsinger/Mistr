import { describe, expect, it } from "vitest";
import {
  buildReflectivityPalette,
  buildStormRelativeVelocityPalette,
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
  });
});
