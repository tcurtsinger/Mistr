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

export function paletteColor(
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
  if (status !== 0 || rawCode < 2) {
    return TRANSPARENT_COLOR;
  }
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
