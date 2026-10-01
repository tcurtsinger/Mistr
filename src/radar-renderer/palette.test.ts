import { describe, expect, it } from "vitest";
import {
  buildReflectivityPalette,
  buildStormRelativeVelocityPalette,
  colorForReflectivity,
  paletteColor,
  RANGE_FOLDED_COLOR,
  REFLECTIVITY_BANDS,
  reflectivityBandIndex,
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

  it("pins the classic NWS table: one solid color per 5-dBZ band", () => {
    // Py-ART NWSRef (WSR-88D operational table) from 5 to 70 dBZ; white above.
    expect(REFLECTIVITY_BANDS.map((band) => [band.dbz, ...band.color.slice(0, 3)])).toEqual([
      [5, 0, 236, 236],
      [10, 1, 160, 246],
      [15, 0, 0, 246],
      [20, 0, 255, 0],
      [25, 0, 200, 0],
      [30, 0, 144, 0],
      [35, 255, 255, 0],
      [40, 231, 192, 0],
      [45, 255, 144, 0],
      [50, 255, 0, 0],
      [55, 214, 0, 0],
      [60, 192, 0, 0],
      [65, 255, 0, 255],
      [70, 153, 85, 201],
      [75, 255, 255, 255],
    ]);
    // A band starts at its lower edge and holds one color to the next edge.
    expect(colorForReflectivity(50)).toEqual([255, 0, 0, 255]);
    expect(colorForReflectivity(54.5)).toEqual([255, 0, 0, 255]);
    expect(colorForReflectivity(55)).toEqual([214, 0, 0, 255]);
    expect(colorForReflectivity(74.5)).toEqual([153, 85, 201, 255]);
    expect(colorForReflectivity(95)).toEqual([255, 255, 255, 255]);
    expect(reflectivityBandIndex(9.5)).toBe(0);
    expect(reflectivityBandIndex(10)).toBe(1);
  });

  it("draws nothing below 5 dBZ and every band from 5 dBZ at full strength", () => {
    expect(colorForReflectivity(-32)).toEqual(TRANSPARENT_COLOR);
    expect(colorForReflectivity(0)).toEqual(TRANSPARENT_COLOR);
    expect(colorForReflectivity(4.5)).toEqual(TRANSPARENT_COLOR);
    expect(colorForReflectivity(5)).toEqual([0, 236, 236, 255]);
    for (let dbz = 5; dbz <= 95; dbz += 0.5) {
      expect(colorForReflectivity(dbz)[3]).toBe(255);
    }
    const palette = buildReflectivityPalette(2, 66);
    for (let rawCode = 2; rawCode < 256; rawCode += 1) {
      const dbz = (rawCode - 66) / 2;
      expect(palette[rawCode * 4 + 3]).toBe(dbz < 5 ? 0 : 255);
    }
  });

  it("maps the exact unrounded code-to-dBZ value to its band", () => {
    const scale = 4;
    const offset = 62;
    // 9.75 and 10.0 dBZ sit either side of the 10 dBZ band edge.
    expect(paletteColor("reflectivity", 101, 0, scale, offset)).toEqual([0, 236, 236, 255]);
    expect(paletteColor("reflectivity", 102, 0, scale, offset)).toEqual([1, 160, 246, 255]);
  });

  it("keeps range folding distinct from every reflectivity band", () => {
    for (const band of REFLECTIVITY_BANDS) {
      const distance = Math.hypot(
        band.color[0] - RANGE_FOLDED_COLOR[0],
        band.color[1] - RANGE_FOLDED_COLOR[1],
        band.color[2] - RANGE_FOLDED_COLOR[2],
      );
      expect(distance).toBeGreaterThan(80);
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
    expect(() => reflectivityBandIndex(Number.POSITIVE_INFINITY)).toThrow("finite dBZ");
  });
});
