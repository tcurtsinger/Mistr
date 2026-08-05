import type { RadarDisplayMode } from "../radar-renderer/RadarCustomLayer";

export type NationalCellStatus = "valid" | "missing" | "no_coverage";

export interface NationalDisplaySample {
  status: NationalCellStatus;
  rawCode: number | null;
  valueDbz: number | null;
}

export interface NationalDisplayFragment extends NationalDisplaySample {
  /**
   * Fraction of the sample footprint backed by valid measured cells: 1 when
   * every contributing neighbor is valid (and always 1 in `Native`), lower
   * near a missing or no-coverage boundary.
   */
  coverage: number;
}

/**
 * Display-only opacity applied to a partially covered `Smooth` fragment. The
 * square root keeps a measured cell clearly visible at its weakest footprint
 * (a lone valid corner renders at half palette opacity) while the outermost
 * half-cell ring fades instead of ending in a hard square. `Native` never
 * applies it, and interrogation is unaffected in either mode.
 */
export function nationalEdgeAlphaScale(coverage: number): number {
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1) {
    throw new RangeError("National coverage must be between 0 and 1");
  }
  return Math.sqrt(coverage);
}

export function decodeNationalRaw(
  rawCode: number,
  missingRaw = 9000,
  noCoverageRaw = 0,
): NationalDisplaySample {
  if (!Number.isInteger(rawCode) || rawCode < 0 || rawCode > 0xffff) {
    throw new RangeError("National raw code must be an unsigned 16-bit integer");
  }
  if (rawCode === missingRaw) return { status: "missing", rawCode, valueDbz: null };
  if (rawCode === noCoverageRaw) return { status: "no_coverage", rawCode, valueDbz: null };
  return { status: "valid", rawCode, valueDbz: (-9990 + rawCode) / 10 };
}

/**
 * Mirrors the National fragment shader's sampling contract so it stays
 * testable outside WebGL. `Smooth` weights only the valid neighbors of the
 * footprint and renormalizes: a missing or no-coverage cell never contributes
 * its value, but it no longer collapses the fragment to a hard nearest-cell
 * block either. The returned `coverage` drives the display-only edge fade.
 */
export function sampleNationalGrid(
  rawCodes: Uint16Array,
  width: number,
  height: number,
  x: number,
  y: number,
  mode: RadarDisplayMode,
  missingRaw = 9000,
  noCoverageRaw = 0,
): NationalDisplayFragment {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 1
    || height < 1
    || rawCodes.length !== width * height
    || !Number.isFinite(x)
    || !Number.isFinite(y)
  ) {
    throw new Error("National sampling grid is invalid");
  }
  const nearestX = clamp(Math.floor(x + 0.5), 0, width - 1);
  const nearestY = clamp(Math.floor(y + 0.5), 0, height - 1);
  const nearest = rawCodes[nearestY * width + nearestX];
  const nearestSample = decodeNationalRaw(nearest, missingRaw, noCoverageRaw);
  // An invalid nearest cell paints nothing at all, so the measured footprint
  // is identical in both modes; only opacity inside it can soften.
  if (mode === "native" || nearestSample.status !== "valid") {
    return { ...nearestSample, coverage: 1 };
  }
  const lowerX = clamp(Math.floor(x), 0, width - 1);
  const lowerY = clamp(Math.floor(y), 0, height - 1);
  const upperX = Math.min(lowerX + 1, width - 1);
  const upperY = Math.min(lowerY + 1, height - 1);
  const fractionX = clamp(x - Math.floor(x), 0, 1);
  const fractionY = clamp(y - Math.floor(y), 0, 1);
  const corners = [
    { raw: rawCodes[lowerY * width + lowerX], weight: (1 - fractionX) * (1 - fractionY) },
    { raw: rawCodes[lowerY * width + upperX], weight: fractionX * (1 - fractionY) },
    { raw: rawCodes[upperY * width + lowerX], weight: (1 - fractionX) * fractionY },
    { raw: rawCodes[upperY * width + upperX], weight: fractionX * fractionY },
  ];
  let coverage = 0;
  let weighted = 0;
  for (const corner of corners) {
    if (decodeNationalRaw(corner.raw, missingRaw, noCoverageRaw).status !== "valid") continue;
    coverage += corner.weight;
    weighted += corner.weight * corner.raw;
  }
  if (coverage <= 0) return { ...nearestSample, coverage: 1 };
  const rawCode = weighted / coverage;
  return {
    status: "valid",
    rawCode,
    valueDbz: (-9990 + rawCode) / 10,
    coverage: clamp(coverage, 0, 1),
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}
