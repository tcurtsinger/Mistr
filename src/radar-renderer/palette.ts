export const PALETTE_WIDTH = 256;

export type Rgba = readonly [number, number, number, number];

interface PaletteAnchor {
  dbz: number;
  color: Rgba;
}

// These anchors define presentation only. Every valid raw code still maps to
// its exact dBZ value before color lookup; interpolation here never changes the
// measured value used by interrogation or playback truth. Very weak valid
// returns remain visible with restrained, gradually increasing opacity instead
// of being discarded by a display threshold.
const REFLECTIVITY_ANCHORS: readonly PaletteAnchor[] = [
  { dbz: -32, color: [57, 80, 110, 18] },
  { dbz: -20, color: [44, 98, 132, 24] },
  { dbz: -10, color: [34, 126, 157, 34] },
  { dbz: 0, color: [35, 159, 168, 48] },
  { dbz: 5, color: [45, 175, 137, 64] },
  { dbz: 10, color: [55, 185, 94, 88] },
  { dbz: 15, color: [62, 189, 67, 116] },
  { dbz: 20, color: [39, 163, 57, 156] },
  { dbz: 25, color: [154, 192, 52, 196] },
  { dbz: 30, color: [234, 214, 50, 222] },
  { dbz: 35, color: [245, 169, 43, 230] },
  { dbz: 40, color: [243, 119, 38, 236] },
  { dbz: 45, color: [232, 67, 41, 240] },
  { dbz: 50, color: [211, 46, 50, 244] },
  { dbz: 55, color: [187, 45, 100, 246] },
  { dbz: 60, color: [190, 52, 162, 248] },
  { dbz: 65, color: [217, 104, 196, 250] },
  { dbz: 70, color: [244, 226, 240, 252] },
  { dbz: 80, color: [250, 250, 252, 255] },
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
  if (!Number.isFinite(valueDbz)) {
    throw new RangeError("reflectivity color requires a finite dBZ value");
  }

  const first = REFLECTIVITY_ANCHORS[0];
  if (valueDbz <= first.dbz) {
    return first.color;
  }

  for (let index = 1; index < REFLECTIVITY_ANCHORS.length; index += 1) {
    const upper = REFLECTIVITY_ANCHORS[index];
    if (valueDbz <= upper.dbz) {
      const lower = REFLECTIVITY_ANCHORS[index - 1];
      const progress = (valueDbz - lower.dbz) / (upper.dbz - lower.dbz);
      return interpolateRgba(lower.color, upper.color, progress);
    }
  }

  return REFLECTIVITY_ANCHORS[REFLECTIVITY_ANCHORS.length - 1].color;
}

function interpolateRgba(lower: Rgba, upper: Rgba, progress: number): Rgba {
  return [
    interpolateChannel(lower[0], upper[0], progress),
    interpolateChannel(lower[1], upper[1], progress),
    interpolateChannel(lower[2], upper[2], progress),
    interpolateChannel(lower[3], upper[3], progress),
  ];
}

function interpolateChannel(lower: number, upper: number, progress: number): number {
  return Math.round(lower + (upper - lower) * progress);
}

function writePremultiplied(target: Uint8Array, offset: number, color: Rgba) {
  const alpha = color[3] / 255;
  target[offset] = Math.round(color[0] * alpha);
  target[offset + 1] = Math.round(color[1] * alpha);
  target[offset + 2] = Math.round(color[2] * alpha);
  target[offset + 3] = color[3];
}
