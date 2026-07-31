export const PACKED_SWEEP_HEADER_BYTES = 320;
export const PACKED_SWEEP_MAX_BYTES = 32 * 1024 * 1024;
export const PACKED_SWEEP_VERSION = 1;

const MAGIC = new TextEncoder().encode("MSTRSWP1");
const ENDIAN_MARKER = 0x01020304;
const FLAG_RAW_U8 = 1;
const FLAG_RAW_U16 = 2;
const RADIAL_BYTES = 24;
const WIRE_HASH_START = 208;
const WIRE_HASH_END = 240;
const MAX_RADIALS = 2048;
const MAX_GATES = 4096;
const MAX_CELLS = 4_194_304;

export type PackedSweepErrorCode =
  | "input_alignment"
  | "truncated_header"
  | "payload_too_large"
  | "invalid_magic"
  | "invalid_endian_marker"
  | "unsupported_version"
  | "invalid_header_length"
  | "total_length_mismatch"
  | "invalid_flags"
  | "invalid_product"
  | "invalid_source_kind"
  | "invalid_encoding"
  | "nonzero_reserved"
  | "invalid_site"
  | "invalid_dimensions"
  | "invalid_metadata"
  | "invalid_section"
  | "observation_id_mismatch"
  | "hash_mismatch"
  | "invalid_radial"
  | "invalid_gate";

export class PackedSweepError extends Error {
  readonly code: PackedSweepErrorCode;

  constructor(code: PackedSweepErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PackedSweepError";
    this.code = code;
  }
}

export interface PackedRadial {
  sourceAzimuthNumber: number;
  azimuthDegrees: number;
  beamWidthDegrees: number;
  elevationDegrees: number;
  collectedAtUnixMs: bigint;
}

export interface PackedSweepMetadata {
  schemaVersion: number;
  generation: bigint;
  observationId: string;
  siteIcao: string;
  product: "reflectivity" | "base_velocity";
  units: "dBZ" | "m/s";
  sourceKind: "nexrad_level2_archive_ii" | "mistr_phase2_synthetic";
  elevationNumber: number;
  dataWordSizeBits: 8 | 16;
  vcp: number;
  radialCount: number;
  gateCount: number;
  cellCount: number;
  gateSpacingM: number;
  firstGateCenterM: number;
  radarLatitudeDegrees: number;
  radarLongitudeDegrees: number;
  siteAltitudeM: number;
  towerHeightM: number;
  elevationDegrees: number;
  scale: number;
  offset: number;
  volumeStartedAtUnixMs: bigint;
  volumeEndedAtUnixMs: bigint;
  sweepStartedAtUnixMs: bigint;
  sweepEndedAtUnixMs: bigint;
  sourceSha256: string;
  normalizedSha256: string;
  wireSha256: string;
  totalBytes: number;
}

export interface PackedSweep {
  metadata: PackedSweepMetadata;
  bytes: Uint8Array;
  values: Float32Array;
  statuses: Uint8Array;
  rawCodes: Uint8Array | Uint16Array;
  radial(index: number): PackedRadial;
}

interface Section {
  offset: number;
  length: number;
}

/**
 * Parse and cryptographically validate one strict PackedSweep v1 buffer.
 * Typed-array fields are zero-copy views over the received ArrayBuffer.
 */
export async function parsePackedSweep(
  input: ArrayBuffer | Uint8Array,
): Promise<PackedSweep> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset % 8 !== 0) {
    throw new PackedSweepError("input_alignment");
  }
  if (bytes.byteLength < PACKED_SWEEP_HEADER_BYTES) {
    throw new PackedSweepError("truncated_header");
  }
  if (bytes.byteLength > PACKED_SWEEP_MAX_BYTES) {
    throw new PackedSweepError("payload_too_large");
  }
  if (!isLittleEndian()) {
    throw new PackedSweepError("invalid_endian_marker", "host is not little-endian");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) {
      throw new PackedSweepError("invalid_magic");
    }
  }
  if (view.getUint32(8, true) !== ENDIAN_MARKER) {
    throw new PackedSweepError("invalid_endian_marker");
  }
  const schemaVersion = view.getUint16(12, true);
  if (schemaVersion !== PACKED_SWEEP_VERSION) {
    throw new PackedSweepError("unsupported_version", String(schemaVersion));
  }
  const headerLength = view.getUint16(14, true);
  if (headerLength !== PACKED_SWEEP_HEADER_BYTES) {
    throw new PackedSweepError("invalid_header_length", String(headerLength));
  }
  const totalBytes = view.getUint32(16, true);
  if (totalBytes !== bytes.byteLength) {
    throw new PackedSweepError(
      "total_length_mismatch",
      `${totalBytes} declared, ${bytes.byteLength} received`,
    );
  }

  const flags = view.getUint32(20, true);
  if (flags !== FLAG_RAW_U8 && flags !== FLAG_RAW_U16) {
    throw new PackedSweepError("invalid_flags", `0x${flags.toString(16)}`);
  }
  const productCode = view.getUint16(24, true);
  const product = productCode === 1
    ? "reflectivity"
    : productCode === 2
      ? "base_velocity"
      : null;
  if (product === null) {
    throw new PackedSweepError("invalid_product", String(productCode));
  }
  const sourceKindCode = view.getUint16(26, true);
  const sourceKind = sourceKindCode === 1
    ? "nexrad_level2_archive_ii"
    : sourceKindCode === 2
      ? "mistr_phase2_synthetic"
      : null;
  if (sourceKind === null) {
    throw new PackedSweepError("invalid_source_kind", String(sourceKindCode));
  }
  assertZero(bytes, 28, 32);
  assertZero(bytes, 66, 68);
  assertZero(bytes, 272, PACKED_SWEEP_HEADER_BYTES);

  const dataWordSizeBits = bytes[61];
  if (
    bytes[62] !== 1
    || bytes[63] !== 1
    || (flags === FLAG_RAW_U8 && dataWordSizeBits !== 8)
    || (flags === FLAG_RAW_U16 && dataWordSizeBits !== 16)
  ) {
    throw new PackedSweepError("invalid_encoding");
  }

  const siteIcao = decodeAscii(bytes.subarray(56, 60));
  if (!/^[A-Z0-9]{4}$/.test(siteIcao)) {
    throw new PackedSweepError("invalid_site");
  }
  const radialCount = view.getUint32(68, true);
  const gateCount = view.getUint32(72, true);
  const cellCount = view.getUint32(76, true);
  if (radialCount < 1 || radialCount > MAX_RADIALS) {
    throw new PackedSweepError("invalid_dimensions", "radial count");
  }
  if (gateCount < 1 || gateCount > MAX_GATES) {
    throw new PackedSweepError("invalid_dimensions", "gate count");
  }
  if (radialCount * gateCount !== cellCount || cellCount > MAX_CELLS) {
    throw new PackedSweepError("invalid_dimensions", "cell count");
  }

  const gateSpacingM = view.getUint32(80, true);
  const firstGateCenterM = view.getUint32(84, true);
  const radarLatitudeDegrees = view.getFloat32(88, true);
  const radarLongitudeDegrees = view.getFloat32(92, true);
  const elevationDegrees = view.getFloat32(100, true);
  const scale = view.getFloat32(104, true);
  const offset = view.getFloat32(108, true);
  if (gateSpacingM === 0) {
    throw new PackedSweepError("invalid_metadata", "gate spacing");
  }
  if (!Number.isFinite(radarLatitudeDegrees) || radarLatitudeDegrees < -90 || radarLatitudeDegrees > 90) {
    throw new PackedSweepError("invalid_metadata", "radar latitude");
  }
  if (!Number.isFinite(radarLongitudeDegrees) || radarLongitudeDegrees < -180 || radarLongitudeDegrees > 180) {
    throw new PackedSweepError("invalid_metadata", "radar longitude");
  }
  if (!Number.isFinite(elevationDegrees) || elevationDegrees < 0 || elevationDegrees > 90) {
    throw new PackedSweepError("invalid_metadata", "sweep elevation");
  }
  if (!Number.isFinite(scale) || !Number.isFinite(offset)) {
    throw new PackedSweepError("invalid_metadata", "scale or offset");
  }
  const volumeStartedAtUnixMs = view.getBigInt64(112, true);
  const volumeEndedAtUnixMs = view.getBigInt64(120, true);
  const sweepStartedAtUnixMs = view.getBigInt64(128, true);
  const sweepEndedAtUnixMs = view.getBigInt64(136, true);
  if (volumeEndedAtUnixMs < volumeStartedAtUnixMs) {
    throw new PackedSweepError("invalid_metadata", "volume time ordering");
  }
  if (sweepEndedAtUnixMs < sweepStartedAtUnixMs) {
    throw new PackedSweepError("invalid_metadata", "sweep time ordering");
  }

  const normalizedShaBytes = bytes.subarray(176, 208);
  if (!equalBytes(bytes.subarray(40, 56), normalizedShaBytes.subarray(0, 16))) {
    throw new PackedSweepError("observation_id_mismatch");
  }

  const radials = readSection(view, 240);
  const valuesSection = readSection(view, 248);
  const statusesSection = readSection(view, 256);
  const rawSection = readSection(view, 264);
  const rawWidth = dataWordSizeBits / 8;
  validateSection("radials", radials, PACKED_SWEEP_HEADER_BYTES, radialCount * RADIAL_BYTES);
  validateSection("values", valuesSection, align8(endOf(radials)), cellCount * 4);
  validateSection("statuses", statusesSection, align8(endOf(valuesSection)), cellCount);
  validateSection("raw", rawSection, align8(endOf(statusesSection)), cellCount * rawWidth);
  if (align8(endOf(rawSection)) !== totalBytes) {
    throw new PackedSweepError("invalid_section", "canonical total length");
  }
  assertZero(bytes, endOf(radials), valuesSection.offset);
  assertZero(bytes, endOf(valuesSection), statusesSection.offset);
  assertZero(bytes, endOf(statusesSection), rawSection.offset);
  assertZero(bytes, endOf(rawSection), totalBytes);

  const expectedWireHash = bytes.subarray(WIRE_HASH_START, WIRE_HASH_END);
  const actualWireHash = await calculateWireHash(bytes);
  if (!equalBytes(expectedWireHash, actualWireHash)) {
    throw new PackedSweepError("hash_mismatch");
  }

  for (let index = 0; index < radialCount; index += 1) {
    validateRadial(view, radials.offset + index * RADIAL_BYTES, index);
  }

  const values = new Float32Array(
    bytes.buffer,
    bytes.byteOffset + valuesSection.offset,
    cellCount,
  );
  const statuses = new Uint8Array(
    bytes.buffer,
    bytes.byteOffset + statusesSection.offset,
    cellCount,
  );
  const rawCodes = dataWordSizeBits === 8
    ? new Uint8Array(bytes.buffer, bytes.byteOffset + rawSection.offset, cellCount)
    : new Uint16Array(bytes.buffer, bytes.byteOffset + rawSection.offset, cellCount);
  validateGates(values, statuses, rawCodes, scale, offset);

  const metadata: PackedSweepMetadata = {
    schemaVersion,
    generation: view.getBigUint64(32, true),
    observationId: hex(bytes.subarray(40, 56)),
    siteIcao,
    product,
    units: product === "reflectivity" ? "dBZ" : "m/s",
    sourceKind,
    elevationNumber: bytes[60],
    dataWordSizeBits: dataWordSizeBits as 8 | 16,
    vcp: view.getUint16(64, true),
    radialCount,
    gateCount,
    cellCount,
    gateSpacingM,
    firstGateCenterM,
    radarLatitudeDegrees,
    radarLongitudeDegrees,
    siteAltitudeM: view.getInt16(96, true),
    towerHeightM: view.getUint16(98, true),
    elevationDegrees,
    scale,
    offset,
    volumeStartedAtUnixMs,
    volumeEndedAtUnixMs,
    sweepStartedAtUnixMs,
    sweepEndedAtUnixMs,
    sourceSha256: hex(bytes.subarray(144, 176)),
    normalizedSha256: hex(normalizedShaBytes),
    wireSha256: hex(expectedWireHash),
    totalBytes,
  };

  return {
    metadata,
    bytes,
    values,
    statuses,
    rawCodes,
    radial(index: number) {
      if (!Number.isInteger(index) || index < 0 || index >= radialCount) {
        throw new RangeError(`radial index ${index} is out of bounds`);
      }
      return readRadial(view, radials.offset + index * RADIAL_BYTES);
    },
  };
}

async function calculateWireHash(bytes: Uint8Array): Promise<Uint8Array> {
  const material = new Uint8Array(bytes.byteLength - (WIRE_HASH_END - WIRE_HASH_START));
  material.set(bytes.subarray(0, WIRE_HASH_START), 0);
  material.set(bytes.subarray(WIRE_HASH_END), WIRE_HASH_START);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", material);
  return new Uint8Array(digest);
}

function validateGates(
  values: Float32Array,
  statuses: Uint8Array,
  rawCodes: Uint8Array | Uint16Array,
  scale: number,
  offset: number,
) {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const status = statuses[index];
    const raw = rawCodes[index];
    if (!Number.isFinite(value)) {
      throw new PackedSweepError("invalid_gate", `${index}: non-finite value`);
    }
    let expectedStatus: number;
    let expectedValue: number;
    if (scale === 0) {
      expectedStatus = 0;
      expectedValue = raw;
    } else if (raw === 0) {
      expectedStatus = 1;
      expectedValue = 0;
    } else if (raw === 1) {
      expectedStatus = 2;
      expectedValue = 0;
    } else {
      expectedStatus = 0;
      expectedValue = Math.fround(Math.fround(raw - offset) / scale);
    }
    if (status !== expectedStatus) {
      throw new PackedSweepError("invalid_gate", `${index}: raw/status disagreement`);
    }
    if (!Object.is(value, expectedValue)) {
      throw new PackedSweepError("invalid_gate", `${index}: raw/value disagreement`);
    }
  }
}

function validateRadial(view: DataView, offset: number, index: number) {
  if (view.getUint16(offset + 2, true) !== 0) {
    throw new PackedSweepError("invalid_radial", `${index}: reserved bytes`);
  }
  const radial = readRadial(view, offset);
  if (!Number.isFinite(radial.azimuthDegrees) || radial.azimuthDegrees < 0 || radial.azimuthDegrees >= 360) {
    throw new PackedSweepError("invalid_radial", `${index}: azimuth`);
  }
  if (!Number.isFinite(radial.beamWidthDegrees) || radial.beamWidthDegrees <= 0 || radial.beamWidthDegrees > 360) {
    throw new PackedSweepError("invalid_radial", `${index}: beam width`);
  }
  if (!Number.isFinite(radial.elevationDegrees) || radial.elevationDegrees < 0 || radial.elevationDegrees > 90) {
    throw new PackedSweepError("invalid_radial", `${index}: elevation`);
  }
}

function readRadial(view: DataView, offset: number): PackedRadial {
  return {
    sourceAzimuthNumber: view.getUint16(offset, true),
    azimuthDegrees: view.getFloat32(offset + 4, true),
    beamWidthDegrees: view.getFloat32(offset + 8, true),
    elevationDegrees: view.getFloat32(offset + 12, true),
    collectedAtUnixMs: view.getBigInt64(offset + 16, true),
  };
}

function readSection(view: DataView, offset: number): Section {
  return {
    offset: view.getUint32(offset, true),
    length: view.getUint32(offset + 4, true),
  };
}

function validateSection(
  name: string,
  section: Section,
  expectedOffset: number,
  expectedLength: number,
) {
  if (section.offset % 8 !== 0) {
    throw new PackedSweepError("invalid_section", `${name}: unaligned offset`);
  }
  if (section.offset !== expectedOffset) {
    throw new PackedSweepError("invalid_section", `${name}: noncanonical offset`);
  }
  if (section.length !== expectedLength) {
    throw new PackedSweepError("invalid_section", `${name}: length mismatch`);
  }
}

function endOf(section: Section): number {
  const end = section.offset + section.length;
  if (!Number.isSafeInteger(end) || end < section.offset || end > PACKED_SWEEP_MAX_BYTES) {
    throw new PackedSweepError("invalid_section", "offset overflow or out of bounds");
  }
  return end;
}

function align8(value: number): number {
  const aligned = Math.ceil(value / 8) * 8;
  if (!Number.isSafeInteger(aligned) || aligned > PACKED_SWEEP_MAX_BYTES) {
    throw new PackedSweepError("invalid_section", "alignment overflow");
  }
  return aligned;
}

function assertZero(bytes: Uint8Array, start: number, end: number) {
  if (start > end || end > bytes.byteLength) {
    throw new PackedSweepError("invalid_section", "padding out of bounds");
  }
  for (let index = start; index < end; index += 1) {
    if (bytes[index] !== 0) {
      throw new PackedSweepError("nonzero_reserved");
    }
  }
}

function decodeAscii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function hex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }
  return output;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function isLittleEndian(): boolean {
  const marker = new Uint16Array([1]);
  return new Uint8Array(marker.buffer)[0] === 1;
}

