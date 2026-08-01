import type { PackedRadial } from "../packed-sweep/packedSweep";

export const EARTH_MEAN_RADIUS_M = 6_371_008.8;
// Py-ART/Doviak-Zrnic standard-atmosphere beam model uses 4/3 of 6371 km.
export const EFFECTIVE_EARTH_RADIUS_M = 4 / 3 * 6_371_000;
export const AZIMUTH_LOOKUP_SIZE = 4_096;
const MAX_MERCATOR_LATITUDE = 85.051_128_779_806_6;

export interface LngLatPoint {
  longitude: number;
  latitude: number;
}

export interface RangeBearing {
  rangeM: number;
  bearingDegrees: number;
}

export interface MercatorPoint {
  x: number;
  y: number;
}

export interface MercatorBounds {
  west: number;
  east: number;
  north: number;
  south: number;
}

export function destinationPoint(
  origin: LngLatPoint,
  bearingDegrees: number,
  distanceM: number,
): LngLatPoint {
  const angularDistance = distanceM / EARTH_MEAN_RADIUS_M;
  const bearing = degreesToRadians(bearingDegrees);
  const latitude1 = degreesToRadians(origin.latitude);
  const longitude1 = degreesToRadians(origin.longitude);
  const sinLatitude1 = Math.sin(latitude1);
  const cosLatitude1 = Math.cos(latitude1);
  const sinDistance = Math.sin(angularDistance);
  const cosDistance = Math.cos(angularDistance);
  const latitude2 = Math.asin(
    sinLatitude1 * cosDistance
      + cosLatitude1 * sinDistance * Math.cos(bearing),
  );
  const longitude2 = longitude1 + Math.atan2(
    Math.sin(bearing) * sinDistance * cosLatitude1,
    cosDistance - sinLatitude1 * Math.sin(latitude2),
  );
  return {
    longitude: normalizeLongitude(radiansToDegrees(longitude2)),
    latitude: radiansToDegrees(latitude2),
  };
}

export function rangeBearing(
  origin: LngLatPoint,
  target: LngLatPoint,
): RangeBearing {
  const latitude1 = degreesToRadians(origin.latitude);
  const latitude2 = degreesToRadians(target.latitude);
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = degreesToRadians(
    normalizeLongitude(target.longitude - origin.longitude),
  );
  const sinHalfLatitude = Math.sin(deltaLatitude / 2);
  const sinHalfLongitude = Math.sin(deltaLongitude / 2);
  const haversine = sinHalfLatitude * sinHalfLatitude
    + Math.cos(latitude1) * Math.cos(latitude2)
      * sinHalfLongitude * sinHalfLongitude;
  const rangeM = 2 * EARTH_MEAN_RADIUS_M
    * Math.asin(Math.min(1, Math.sqrt(haversine)));
  const y = Math.sin(deltaLongitude) * Math.cos(latitude2);
  const x = Math.cos(latitude1) * Math.sin(latitude2)
    - Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(deltaLongitude);
  return {
    rangeM,
    bearingDegrees: normalizeBearing(radiansToDegrees(Math.atan2(y, x))),
  };
}

export function lngLatToMercator(point: LngLatPoint): MercatorPoint {
  const latitude = Math.max(
    -MAX_MERCATOR_LATITUDE,
    Math.min(MAX_MERCATOR_LATITUDE, point.latitude),
  );
  const latitudeRadians = degreesToRadians(latitude);
  return {
    x: (point.longitude + 180) / 360,
    y: (1 - Math.log(
      Math.tan(Math.PI / 4 + latitudeRadians / 2),
    ) / Math.PI) / 2,
  };
}

export function mercatorToLngLat(point: MercatorPoint): LngLatPoint {
  const wrappedX = point.x - Math.floor(point.x);
  return {
    longitude: wrappedX * 360 - 180,
    latitude: radiansToDegrees(
      Math.atan(Math.sinh(Math.PI * (1 - 2 * point.y))),
    ),
  };
}

export function buildMercatorBounds(
  origin: LngLatPoint,
  radiusM: number,
  sampleCount = 720,
): MercatorBounds {
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw new RangeError("radiusM must be positive and finite");
  }
  if (!Number.isInteger(sampleCount) || sampleCount < 4) {
    throw new RangeError("sampleCount must be an integer of at least four");
  }
  const center = lngLatToMercator(origin);
  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.POSITIVE_INFINITY;
  let south = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < sampleCount; index += 1) {
    const destination = destinationPoint(origin, index * 360 / sampleCount, radiusM);
    const projected = lngLatToMercator(destination);
    projected.x += Math.round(center.x - projected.x);
    west = Math.min(west, projected.x);
    east = Math.max(east, projected.x);
    north = Math.min(north, projected.y);
    south = Math.max(south, projected.y);
  }
  return { west, east, north, south };
}

export function buildAzimuthLookup(
  radials: readonly PackedRadial[],
  size = AZIMUTH_LOOKUP_SIZE,
): Uint16Array {
  if (radials.length === 0 || radials.length >= 65_535) {
    throw new RangeError("radial count must be between 1 and 65534");
  }
  if (!Number.isInteger(size) || size < 360 || size > 65_536) {
    throw new RangeError("azimuth lookup size must be between 360 and 65536");
  }
  for (let index = 1; index < radials.length; index += 1) {
    if (radials[index].azimuthDegrees <= radials[index - 1].azimuthDegrees) {
      throw new RangeError("radials must have strictly increasing azimuths");
    }
  }
  const lookup = new Uint16Array(size);
  const halfBin = 180 / size;
  for (let bin = 0; bin < size; bin += 1) {
    const azimuth = (bin + 0.5) * 360 / size;
    const radialIndex = nearestRadial(radials, azimuth);
    const radial = radials[radialIndex];
    if (
      angularDistanceDegrees(azimuth, radial.azimuthDegrees)
      <= radial.beamWidthDegrees / 2 + halfBin
    ) {
      lookup[bin] = radialIndex + 1;
    }
  }
  return lookup;
}

export function radialFromLookup(
  lookup: Uint16Array,
  bearingDegrees: number,
): number | null {
  const normalized = normalizeBearing(bearingDegrees);
  const bin = Math.min(
    lookup.length - 1,
    Math.floor(normalized / 360 * lookup.length),
  );
  const encoded = lookup[bin];
  return encoded === 0 ? null : encoded - 1;
}

export function gateIndexForRange(
  rangeM: number,
  firstGateCenterM: number,
  gateSpacingM: number,
  gateCount: number,
): number | null {
  const gateCoordinate = (rangeM - firstGateCenterM) / gateSpacingM;
  if (gateCoordinate < -0.5 || gateCoordinate > gateCount - 0.5) {
    return null;
  }
  return Math.max(0, Math.min(gateCount - 1, Math.floor(gateCoordinate + 0.5)));
}

/** Convert Level II beam slant range to surface arc distance (4/3-Earth model). */
export function groundRangeForSlantRange(
  slantRangeM: number,
  elevationDegrees: number,
): number {
  assertBeamCoordinates(slantRangeM, elevationDegrees);
  const elevation = degreesToRadians(elevationDegrees);
  const groundAngle = Math.atan2(
    slantRangeM * Math.cos(elevation),
    EFFECTIVE_EARTH_RADIUS_M + slantRangeM * Math.sin(elevation),
  );
  return EFFECTIVE_EARTH_RADIUS_M * groundAngle;
}

/** Invert the 4/3-Earth beam model from surface arc distance to slant range. */
export function slantRangeForGroundRange(
  groundRangeM: number,
  elevationDegrees: number,
): number {
  assertBeamCoordinates(groundRangeM, elevationDegrees);
  const elevation = degreesToRadians(elevationDegrees);
  const groundAngle = groundRangeM / EFFECTIVE_EARTH_RADIUS_M;
  const denominator = Math.cos(elevation + groundAngle);
  if (denominator <= 0) {
    throw new RangeError("ground range lies beyond the beam-model horizon");
  }
  return EFFECTIVE_EARTH_RADIUS_M * Math.sin(groundAngle) / denominator;
}

export function angularDistanceDegrees(left: number, right: number): number {
  const difference = Math.abs(normalizeBearing(left) - normalizeBearing(right));
  return Math.min(difference, 360 - difference);
}

export function normalizeBearing(value: number): number {
  return ((value % 360) + 360) % 360;
}

export function normalizeLongitude(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function nearestRadial(radials: readonly PackedRadial[], azimuth: number): number {
  let low = 0;
  let high = radials.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (radials[middle].azimuthDegrees < azimuth) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const next = low % radials.length;
  const previous = (low - 1 + radials.length) % radials.length;
  return angularDistanceDegrees(azimuth, radials[previous].azimuthDegrees)
      <= angularDistanceDegrees(azimuth, radials[next].azimuthDegrees)
    ? previous
    : next;
}

function assertBeamCoordinates(rangeM: number, elevationDegrees: number) {
  if (!Number.isFinite(rangeM) || rangeM < 0) {
    throw new RangeError("beam range must be finite and nonnegative");
  }
  if (
    !Number.isFinite(elevationDegrees)
    || elevationDegrees < 0
    || elevationDegrees > 90
  ) {
    throw new RangeError("beam elevation must be finite and between 0 and 90 degrees");
  }
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function radiansToDegrees(value: number): number {
  return value * 180 / Math.PI;
}
