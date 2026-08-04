import type { RadarDisplayMode } from "../radar-renderer/RadarCustomLayer";

export type NationalCellStatus = "valid" | "missing" | "no_coverage";

export interface NationalDisplaySample {
  status: NationalCellStatus;
  rawCode: number | null;
  valueDbz: number | null;
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

export function sampleNationalGrid(
  rawCodes: Uint16Array,
  width: number,
  height: number,
  x: number,
  y: number,
  mode: RadarDisplayMode,
  missingRaw = 9000,
  noCoverageRaw = 0,
): NationalDisplaySample {
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
  if (mode === "native" || nearestSample.status !== "valid") return nearestSample;
  const lowerX = clamp(Math.floor(x), 0, width - 1);
  const lowerY = clamp(Math.floor(y), 0, height - 1);
  const upperX = Math.min(lowerX + 1, width - 1);
  const upperY = Math.min(lowerY + 1, height - 1);
  const corners = [
    rawCodes[lowerY * width + lowerX],
    rawCodes[lowerY * width + upperX],
    rawCodes[upperY * width + lowerX],
    rawCodes[upperY * width + upperX],
  ];
  if (corners.some((raw) => decodeNationalRaw(raw, missingRaw, noCoverageRaw).status !== "valid")) {
    return nearestSample;
  }
  const fractionX = clamp(x - Math.floor(x), 0, 1);
  const fractionY = clamp(y - Math.floor(y), 0, 1);
  const top = mix(corners[0], corners[1], fractionX);
  const bottom = mix(corners[2], corners[3], fractionX);
  const rawCode = mix(top, bottom, fractionY);
  return {
    status: "valid",
    rawCode,
    valueDbz: (-9990 + rawCode) / 10,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function mix(lower: number, upper: number, fraction: number) {
  return lower + (upper - lower) * fraction;
}
