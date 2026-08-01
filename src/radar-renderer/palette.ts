export const PALETTE_WIDTH = 256;

export type Rgba = readonly [number, number, number, number];

interface PaletteStop {
  minimumDbz: number;
  color: Rgba;
}

// Mistr Phase 3 diagnostic palette. Warm hues remain meteorological data,
// never interface chrome. Colors are intentionally discrete for gate truth.
const REFLECTIVITY_STOPS: readonly PaletteStop[] = [
  { minimumDbz: -32, color: [32, 97, 171, 82] },
  { minimumDbz: -10, color: [31, 149, 214, 112] },
  { minimumDbz: 0, color: [57, 199, 214, 136] },
  { minimumDbz: 5, color: [48, 204, 85, 168] },
  { minimumDbz: 20, color: [22, 138, 55, 190] },
  { minimumDbz: 30, color: [239, 221, 51, 214] },
  { minimumDbz: 40, color: [246, 139, 34, 226] },
  { minimumDbz: 50, color: [227, 50, 45, 238] },
  { minimumDbz: 60, color: [208, 47, 166, 244] },
  { minimumDbz: 70, color: [238, 238, 244, 250] },
];

export const RANGE_FOLDED_COLOR: Rgba = [144, 91, 211, 220];
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
  let selected = REFLECTIVITY_STOPS[0].color;
  for (const stop of REFLECTIVITY_STOPS) {
    if (valueDbz < stop.minimumDbz) {
      break;
    }
    selected = stop.color;
  }
  return selected;
}

function writePremultiplied(target: Uint8Array, offset: number, color: Rgba) {
  const alpha = color[3] / 255;
  target[offset] = Math.round(color[0] * alpha);
  target[offset + 1] = Math.round(color[1] * alpha);
  target[offset + 2] = Math.round(color[2] * alpha);
  target[offset + 3] = color[3];
}
