export const PALETTE_WIDTH = 256;

export type Rgba = readonly [number, number, number, number];

interface PaletteAnchor {
  dbz: number;
  color: Rgba;
}

// These anchors pin Mistr to the operational NOAA/NWS SR_BREF
// `radar_reflectivity` WMS legend captured from the KAMX service on 2026-08-02:
// https://opengeo.ncep.noaa.gov/geoserver/kamx/wms
// The legend is a continuous five-dBZ ramp from -25 through 70 dBZ. Its valid
// pixels are fully opaque while no-data pixels are transparent. Presentation
// never changes the exact dBZ used by interrogation or playback truth.
const REFLECTIVITY_ANCHORS: readonly PaletteAnchor[] = [
  { dbz: -25, color: [145, 137, 105, 255] },
  { dbz: -20, color: [164, 161, 107, 255] },
  { dbz: -15, color: [194, 195, 155, 255] },
  { dbz: -10, color: [193, 197, 180, 255] },
  { dbz: -5, color: [162, 168, 180, 255] },
  { dbz: 0, color: [123, 136, 174, 255] },
  { dbz: 5, color: [83, 106, 163, 255] },
  { dbz: 10, color: [80, 133, 183, 255] },
  { dbz: 15, color: [88, 193, 184, 255] },
  { dbz: 20, color: [48, 214, 91, 255] },
  { dbz: 25, color: [12, 175, 17, 255] },
  { dbz: 30, color: [10, 115, 12, 255] },
  { dbz: 35, color: [132, 160, 4, 255] },
  { dbz: 40, color: [244, 202, 23, 255] },
  { dbz: 45, color: [244, 178, 23, 255] },
  { dbz: 50, color: [208, 8, 8, 255] },
  { dbz: 55, color: [169, 8, 8, 255] },
  { dbz: 60, color: [241, 185, 253, 255] },
  { dbz: 65, color: [241, 116, 253, 255] },
  { dbz: 70, color: [130, 0, 231, 255] },
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
