import { describe, expect, it } from "vitest";
import { isRadarSignalPixel } from "./radar-pixel-evidence.mjs";

describe("packaged radar pixel evidence", () => {
  it.each([
    [5, 5, 6],
    [8, 8, 9],
    [12, 12, 12],
  ])("does not classify a lifted nonzero night background (%i, %i, %i) as radar", (red, green, blue) => {
    expect(isRadarSignalPixel(red, green, blue)).toBe(false);
  });

  it.each([
    [9, 11, 14],
    [10, 17, 11],
    [25, 25, 25],
  ])("retains weak chromatic and bright neutral radar pixels (%i, %i, %i)", (red, green, blue) => {
    expect(isRadarSignalPixel(red, green, blue)).toBe(true);
  });
});
