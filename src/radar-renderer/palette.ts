export const PALETTE_WIDTH = 256;

export type Rgba = readonly [number, number, number, number];

interface ReflectivityBand {
  dbz: number;
  color: Rgba;
}

// The classic NWS reflectivity color table: one solid color for each 5-dBZ
// band, starting at the band's lower edge. The RGB values for 5 through 70 dBZ
// are Py-ART's `NWSRef` (cmweather 0.3.2, in the oracle environment), which
// follows the WSR-88D operational table; 75 dBZ and above is white. Below
// 5 dBZ nothing is drawn, as on NWS displays, and every band from 5 dBZ up is
// fully opaque. Presentation never changes the exact dBZ used by
// interrogation or playback truth.
export const REFLECTIVITY_BANDS: readonly ReflectivityBand[] = [
  { dbz: 5, color: [0, 236, 236, 255] },
  { dbz: 10, color: [1, 160, 246, 255] },
  { dbz: 15, color: [0, 0, 246, 255] },
  { dbz: 20, color: [0, 255, 0, 255] },
  { dbz: 25, color: [0, 200, 0, 255] },
  { dbz: 30, color: [0, 144, 0, 255] },
  { dbz: 35, color: [255, 255, 0, 255] },
  { dbz: 40, color: [231, 192, 0, 255] },
  { dbz: 45, color: [255, 144, 0, 255] },
  { dbz: 50, color: [255, 0, 0, 255] },
  { dbz: 55, color: [214, 0, 0, 255] },
  { dbz: 60, color: [192, 0, 0, 255] },
  { dbz: 65, color: [255, 0, 255, 255] },
  { dbz: 70, color: [153, 85, 201, 255] },
  { dbz: 75, color: [255, 255, 255, 255] },
];
export const REFLECTIVITY_BAND_WIDTH_DBZ = 5;
export const REFLECTIVITY_MIN_DISPLAY_DBZ = REFLECTIVITY_BANDS[0].dbz;

// Range folding is categorical and must never read as a reflectivity band;
// the NWS 70 dBZ purple is close to the former range-folded violet.
export const RANGE_FOLDED_COLOR: Rgba = [119, 0, 125, 220];
export const TRANSPARENT_COLOR: Rgba = [0, 0, 0, 0];

// Product 56 uses categorical velocity thresholds, not the Level II linear
// scale/offset equation. Category 8 is near-zero; cool hues are inbound and
// warm hues are outbound. This palette never changes the product label.
const STORM_RELATIVE_VELOCITY_COLORS: readonly Rgba[] = [
  TRANSPARENT_COLOR,
  [23, 48, 138, 230],
  [28, 78, 181, 230],
  [33, 113, 202, 230],
  [51, 147, 214, 230],
  [83, 179, 224, 230],
  [137, 208, 232, 230],
  [204, 232, 239, 220],
  [232, 232, 232, 205],
  [254, 224, 210, 220],
  [252, 187, 161, 230],
  [252, 146, 114, 230],
  [239, 96, 78, 230],
  [211, 51, 55, 230],
  [158, 31, 46, 230],
  RANGE_FOLDED_COLOR,
];

export function buildReflectivityPalette(scale: number, offset: number): Uint8Array {
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(offset)) {
    throw new RangeError("reflectivity palette requires positive scale and finite offset");
  }
  const palette = new Uint8Array(PALETTE_WIDTH * 4);
  for (let rawCode = 2; rawCode < PALETTE_WIDTH; rawCode += 1) {
    const value = (rawCode - offset) / scale;
    const color = colorForReflectivity(value);
    writePremultiplied(palette, rawCode * 4, color);
  }
  return palette;
}

export function buildStormRelativeVelocityPalette(): Uint8Array {
  const palette = new Uint8Array(PALETTE_WIDTH * 4);
  for (let category = 1; category <= 14; category += 1) {
    writePremultiplied(palette, category * 4, STORM_RELATIVE_VELOCITY_COLORS[category]);
  }
  return palette;
}

export function buildRadarPalette(
  product: "reflectivity" | "storm_relative_velocity",
  scale: number,
  offset: number,
): Uint8Array {
  return product === "storm_relative_velocity"
    ? buildStormRelativeVelocityPalette()
    : buildReflectivityPalette(scale, offset);
}

export function paletteColor(
  product: "reflectivity" | "storm_relative_velocity",
  rawCode: number,
  status: number,
  scale: number,
  offset: number,
): Rgba {
  if (status === 1) {
    return TRANSPARENT_COLOR;
  }
  if (status === 2) {
    return RANGE_FOLDED_COLOR;
  }
  if (status !== 0) {
    return TRANSPARENT_COLOR;
  }
  if (product === "storm_relative_velocity") {
    return STORM_RELATIVE_VELOCITY_COLORS[rawCode] ?? TRANSPARENT_COLOR;
  }
  if (rawCode < 2) return TRANSPARENT_COLOR;
  return colorForReflectivity((rawCode - offset) / scale);
}

export function colorForReflectivity(valueDbz: number): Rgba {
  const band = reflectivityBandIndex(valueDbz);
  return band < 0 ? TRANSPARENT_COLOR : REFLECTIVITY_BANDS[band].color;
}

/** The NWS band holding a dBZ value, or -1 below the first band. */
export function reflectivityBandIndex(valueDbz: number): number {
  if (!Number.isFinite(valueDbz)) {
    throw new RangeError("reflectivity color requires a finite dBZ value");
  }
  if (valueDbz < REFLECTIVITY_MIN_DISPLAY_DBZ) return -1;
  return Math.min(
    REFLECTIVITY_BANDS.length - 1,
    Math.floor(valueDbz / REFLECTIVITY_BAND_WIDTH_DBZ) - 1,
  );
}

function writePremultiplied(target: Uint8Array, offset: number, color: Rgba) {
  const alpha = color[3] / 255;
  target[offset] = Math.round(color[0] * alpha);
  target[offset + 1] = Math.round(color[1] * alpha);
  target[offset + 2] = Math.round(color[2] * alpha);
  target[offset + 3] = color[3];
}
