export const PACKED_GRID_VERSION = 1;
export const PACKED_GRID_HEADER_BYTES = 176;
export const PACKED_GRID_DESCRIPTOR_BYTES = 72;
export const PACKED_GRID_MANIFEST_LIMIT = 1024 * 1024;
export const PACKED_GRID_CHUNK_LIMIT = 512 * 1024;

const MANIFEST_MAGIC = new TextEncoder().encode("MGRD");
const CHUNK_MAGIC = new TextEncoder().encode("MGCK");
const RECORD_MANIFEST = 1;
const RECORD_CHUNK = 2;
const CHUNK_INTERIOR = 256;
const CONTENT_HASH_START = 120;
const CONTENT_HASH_END = 152;

export type PackedGridErrorCode =
  | "truncated_header"
  | "payload_too_large"
  | "invalid_magic"
  | "unsupported_version"
  | "invalid_record_kind"
  | "invalid_header_length"
  | "total_length_mismatch"
  | "invalid_source"
  | "invalid_grid"
  | "invalid_encoding"
  | "invalid_string_section"
  | "invalid_descriptor_section"
  | "invalid_chunk_bounds"
  | "hash_mismatch";

export class PackedGridError extends Error {
  readonly code: PackedGridErrorCode;

  constructor(code: PackedGridErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PackedGridError";
    this.code = code;
  }
}

export interface PackedGridChunkDescriptor {
  index: number;
  chunkX: number;
  chunkY: number;
  interiorX: number;
  interiorY: number;
  interiorWidth: number;
  interiorHeight: number;
  haloX: number;
  haloY: number;
  haloWidth: number;
  haloHeight: number;
  encodedLength: number;
  payloadSha256: string;
}

export interface PackedGridManifest {
  schemaVersion: 1;
  generation: bigint;
  sourceKind: "national_mrms";
  domain: "conus";
  product: "MergedBaseReflectivityQC_00.50";
  provider: "noaa-mrms-pds.s3.amazonaws.com";
  objectKey: string;
  observationTimeUnixMs: bigint;
  contentSha256: string;
  width: number;
  height: number;
  firstLatitudeDegrees: number;
  firstLongitudeDegrees: number;
  lastLatitudeDegrees: number;
  lastLongitudeDegrees: number;
  longitudeStepDegrees: number;
  latitudeStepDegrees: number;
  rowOrientation: "north_to_south";
  bitDepth: 16;
  referenceValue: -9990;
  binaryScale: 0;
  decimalScale: 1;
  missingRaw: 9000;
  noCoverageRaw: 0;
  presentationFactor: number;
  chunkInteriorSize: 256;
  chunks: readonly PackedGridChunkDescriptor[];
}

export interface PackedGridChunk {
  schemaVersion: 1;
  generation: bigint;
  observationTimeUnixMs: bigint;
  contentSha256: string;
  width: number;
  height: number;
  presentationFactor: number;
  descriptor: PackedGridChunkDescriptor;
  bitDepth: 16;
  referenceValue: -9990;
  binaryScale: 0;
  decimalScale: 1;
  missingRaw: 9000;
  noCoverageRaw: 0;
  rawCodes: Uint16Array;
}

export function parsePackedGridManifest(
  input: ArrayBuffer | Uint8Array,
): PackedGridManifest {
  const bytes = asBytes(input);
  assertCommonHeader(bytes, MANIFEST_MAGIC, RECORD_MANIFEST, PACKED_GRID_MANIFEST_LIMIT);
  const view = dataView(bytes);
  const width = view.getUint32(32, false);
  const height = view.getUint32(36, false);
  const presentationFactor = view.getUint16(80, false);
  if (
    presentationFactor < 1
    || presentationFactor > 16
    || !isPowerOfTwo(presentationFactor)
    || width !== Math.ceil(7000 / presentationFactor)
    || height !== Math.ceil(3500 / presentationFactor)
    || view.getInt32(40, false) !== 54_995_000
    || view.getInt32(44, false) !== -129_995_000
    || view.getInt32(48, false) !== 20_005_001
    || view.getInt32(52, false) !== -60_005_002
    || view.getUint32(56, false) !== 10_000 * presentationFactor
    || view.getUint32(60, false) !== 10_000 * presentationFactor
    || bytes[64] !== 1
  ) {
    throw new PackedGridError("invalid_grid");
  }
  if (
    bytes[65] !== 16
    || view.getFloat32(68, false) !== -9990
    || view.getInt16(72, false) !== 0
    || view.getInt16(74, false) !== 1
    || view.getUint16(76, false) !== 9000
    || view.getUint16(78, false) !== 0
    || view.getUint16(82, false) !== CHUNK_INTERIOR
  ) {
    throw new PackedGridError("invalid_encoding");
  }

  const descriptorOffset = view.getUint32(152, false);
  const descriptorBytes = view.getUint16(156, false);
  const chunkCount = view.getUint32(84, false);
  const expectedChunkCount = Math.ceil(width / CHUNK_INTERIOR) * Math.ceil(height / CHUNK_INTERIOR);
  if (
    descriptorBytes !== PACKED_GRID_DESCRIPTOR_BYTES
    || chunkCount !== expectedChunkCount
    || descriptorOffset < PACKED_GRID_HEADER_BYTES
    || descriptorOffset + chunkCount * descriptorBytes !== bytes.byteLength
  ) {
    throw new PackedGridError("invalid_descriptor_section");
  }
  assertZero(bytes, 66, 68);
  assertZero(bytes, 158, 160);
  assertZero(bytes, 168, PACKED_GRID_HEADER_BYTES);

  const ranges = [88, 96, 104, 112, 160].map((offset) => readStringRange(bytes, view, offset, descriptorOffset));
  const [sourceKind, domain, product, provider, objectKey] = ranges.map(({ value }) => value);
  if (
    sourceKind !== "national_mrms"
    || domain !== "conus"
    || product !== "MergedBaseReflectivityQC_00.50"
    || provider !== "noaa-mrms-pds.s3.amazonaws.com"
    || objectObservationTime(objectKey) !== view.getBigInt64(24, false)
  ) {
    throw new PackedGridError("invalid_source");
  }
  const sortedRanges = [...ranges].sort((left, right) => left.start - right.start);
  let cursor = PACKED_GRID_HEADER_BYTES;
  for (const range of sortedRanges) {
    if (range.start !== cursor) throw new PackedGridError("invalid_string_section", "gapped or overlapping ranges");
    cursor = range.end;
  }
  if (cursor !== descriptorOffset) {
    throw new PackedGridError("invalid_string_section", "strings do not end at descriptors");
  }

  const chunks: PackedGridChunkDescriptor[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const base = descriptorOffset + index * descriptorBytes;
    const descriptor = readDescriptor(bytes, view, base);
    assertZero(bytes, base + 68, base + PACKED_GRID_DESCRIPTOR_BYTES, "invalid_descriptor_section");
    validateDescriptor(descriptor, index, width, height);
    chunks.push(descriptor);
  }
  return {
    schemaVersion: 1,
    generation: view.getBigUint64(16, false),
    sourceKind: "national_mrms",
    domain: "conus",
    product: "MergedBaseReflectivityQC_00.50",
    provider: "noaa-mrms-pds.s3.amazonaws.com",
    objectKey,
    observationTimeUnixMs: view.getBigInt64(24, false),
    contentSha256: toHex(bytes.subarray(CONTENT_HASH_START, CONTENT_HASH_END)),
    width,
    height,
    firstLatitudeDegrees: view.getInt32(40, false) / 1_000_000,
    firstLongitudeDegrees: view.getInt32(44, false) / 1_000_000,
    lastLatitudeDegrees: view.getInt32(48, false) / 1_000_000,
    lastLongitudeDegrees: view.getInt32(52, false) / 1_000_000,
    longitudeStepDegrees: view.getUint32(56, false) / 1_000_000,
    latitudeStepDegrees: view.getUint32(60, false) / 1_000_000,
    rowOrientation: "north_to_south",
    bitDepth: 16,
    referenceValue: -9990,
    binaryScale: 0,
    decimalScale: 1,
    missingRaw: 9000,
    noCoverageRaw: 0,
    presentationFactor,
    chunkInteriorSize: 256,
    chunks,
  };
}

export async function parsePackedGridChunk(
  input: ArrayBuffer | Uint8Array,
): Promise<PackedGridChunk> {
  const bytes = asBytes(input);
  assertCommonHeader(bytes, CHUNK_MAGIC, RECORD_CHUNK, PACKED_GRID_CHUNK_LIMIT);
  const view = dataView(bytes);
  if (bytes[64] !== 1 || bytes[65] !== 1 || bytes[66] !== 1 || bytes[67] !== 1) {
    throw new PackedGridError("invalid_source");
  }
  const width = view.getUint32(68, false);
  const height = view.getUint32(72, false);
  const presentationFactor = view.getUint16(76, false);
  if (
    presentationFactor < 1
    || presentationFactor > 16
    || !isPowerOfTwo(presentationFactor)
    || width !== Math.ceil(7000 / presentationFactor)
    || height !== Math.ceil(3500 / presentationFactor)
    || view.getUint16(78, false) !== CHUNK_INTERIOR
  ) {
    throw new PackedGridError("invalid_grid");
  }
  if (
    bytes[112] !== 16
    || view.getFloat32(116, false) !== -9990
    || view.getInt16(120, false) !== 0
    || view.getInt16(122, false) !== 1
    || view.getUint16(124, false) !== 9000
    || view.getUint16(126, false) !== 0
  ) {
    throw new PackedGridError("invalid_encoding");
  }
  const payloadOffset = view.getUint32(128, false);
  const payloadLength = view.getUint32(132, false);
  if (
    payloadOffset !== PACKED_GRID_HEADER_BYTES
    || payloadLength % 2 !== 0
    || payloadOffset + payloadLength !== bytes.byteLength
  ) {
    throw new PackedGridError("invalid_chunk_bounds", "payload range");
  }
  assertZero(bytes, 113, 116);
  assertZero(bytes, 168, PACKED_GRID_HEADER_BYTES);
  const descriptor: PackedGridChunkDescriptor = {
    index: view.getUint32(80, false),
    chunkX: view.getUint16(84, false),
    chunkY: view.getUint16(86, false),
    interiorX: view.getUint32(88, false),
    interiorY: view.getUint32(92, false),
    interiorWidth: view.getUint16(96, false),
    interiorHeight: view.getUint16(98, false),
    haloX: view.getUint32(100, false),
    haloY: view.getUint32(104, false),
    haloWidth: view.getUint16(108, false),
    haloHeight: view.getUint16(110, false),
    encodedLength: bytes.byteLength,
    payloadSha256: "",
  };
  validateDescriptor(descriptor, descriptor.index, width, height);
  if (descriptor.haloWidth * descriptor.haloHeight * 2 !== payloadLength) {
    throw new PackedGridError("invalid_chunk_bounds", "halo cell count");
  }
  const payload = bytes.subarray(payloadOffset);
  const payloadCopy = new Uint8Array(payload.byteLength);
  payloadCopy.set(payload);
  const payloadHash = new Uint8Array(await crypto.subtle.digest("SHA-256", payloadCopy.buffer));
  if (!equalBytes(payloadHash, bytes.subarray(136, 168))) {
    throw new PackedGridError("hash_mismatch");
  }
  descriptor.payloadSha256 = toHex(payloadHash);
  const rawCodes = new Uint16Array(payloadLength / 2);
  for (let index = 0; index < rawCodes.length; index += 1) {
    rawCodes[index] = view.getUint16(payloadOffset + index * 2, false);
  }
  return {
    schemaVersion: 1,
    generation: view.getBigUint64(16, false),
    observationTimeUnixMs: view.getBigInt64(24, false),
    contentSha256: toHex(bytes.subarray(32, 64)),
    width,
    height,
    presentationFactor,
    descriptor,
    bitDepth: 16,
    referenceValue: -9990,
    binaryScale: 0,
    decimalScale: 1,
    missingRaw: 9000,
    noCoverageRaw: 0,
    rawCodes,
  };
}

export function assertChunkMatchesManifest(
  manifest: PackedGridManifest,
  chunk: PackedGridChunk,
): void {
  const expected = manifest.chunks[chunk.descriptor.index];
  if (
    !expected
    || chunk.generation !== manifest.generation
    || chunk.observationTimeUnixMs !== manifest.observationTimeUnixMs
    || chunk.contentSha256 !== manifest.contentSha256
    || chunk.width !== manifest.width
    || chunk.height !== manifest.height
    || chunk.presentationFactor !== manifest.presentationFactor
    || JSON.stringify(chunk.descriptor) !== JSON.stringify(expected)
  ) {
    throw new PackedGridError("invalid_chunk_bounds", "chunk does not match its manifest identity");
  }
}

function assertCommonHeader(
  bytes: Uint8Array,
  magic: Uint8Array,
  kind: number,
  limit: number,
) {
  if (bytes.byteLength < PACKED_GRID_HEADER_BYTES) throw new PackedGridError("truncated_header");
  if (bytes.byteLength > limit) throw new PackedGridError("payload_too_large");
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[index] !== magic[index]) throw new PackedGridError("invalid_magic");
  }
  const view = dataView(bytes);
  const version = view.getUint16(4, false);
  if (version !== PACKED_GRID_VERSION) throw new PackedGridError("unsupported_version", String(version));
  if (view.getUint16(6, false) !== kind) throw new PackedGridError("invalid_record_kind");
  if (view.getUint32(8, false) !== PACKED_GRID_HEADER_BYTES) {
    throw new PackedGridError("invalid_header_length");
  }
  if (view.getUint32(12, false) !== bytes.byteLength) {
    throw new PackedGridError("total_length_mismatch");
  }
  if (view.getBigUint64(16, false) === 0n || view.getBigInt64(24, false) <= 0n) {
    throw new PackedGridError("invalid_source", "generation or observation time");
  }
}

function objectObservationTime(objectKey: string): bigint | null {
  const match = /^CONUS\/MergedBaseReflectivityQC_00\.50\/(\d{8})\/MRMS_MergedBaseReflectivityQC_00\.50_(\d{8})-(\d{6})\.grib2\.gz$/.exec(objectKey);
  if (!match || match[1] !== match[2]) return null;
  const stamp = `${match[2]}${match[3]}`;
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  const hour = Number(stamp.slice(8, 10));
  const minute = Number(stamp.slice(10, 12));
  const second = Number(stamp.slice(12, 14));
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second);
  const roundTrip = new Date(milliseconds);
  if (
    roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() !== month - 1
    || roundTrip.getUTCDate() !== day
    || roundTrip.getUTCHours() !== hour
    || roundTrip.getUTCMinutes() !== minute
    || roundTrip.getUTCSeconds() !== second
  ) return null;
  return BigInt(milliseconds);
}

function readDescriptor(bytes: Uint8Array, view: DataView, base: number): PackedGridChunkDescriptor {
  return {
    index: view.getUint32(base, false),
    chunkX: view.getUint16(base + 4, false),
    chunkY: view.getUint16(base + 6, false),
    interiorX: view.getUint32(base + 8, false),
    interiorY: view.getUint32(base + 12, false),
    interiorWidth: view.getUint16(base + 16, false),
    interiorHeight: view.getUint16(base + 18, false),
    haloX: view.getUint32(base + 20, false),
    haloY: view.getUint32(base + 24, false),
    haloWidth: view.getUint16(base + 28, false),
    haloHeight: view.getUint16(base + 30, false),
    encodedLength: view.getUint32(base + 32, false),
    payloadSha256: toHex(bytes.subarray(base + 36, base + 68)),
  };
}

function validateDescriptor(
  descriptor: PackedGridChunkDescriptor,
  expectedIndex: number,
  width: number,
  height: number,
) {
  const expectedX = descriptor.chunkX * CHUNK_INTERIOR;
  const expectedY = descriptor.chunkY * CHUNK_INTERIOR;
  const expectedInteriorWidth = Math.min(CHUNK_INTERIOR, width - expectedX);
  const expectedInteriorHeight = Math.min(CHUNK_INTERIOR, height - expectedY);
  const expectedHaloX = Math.max(0, expectedX - 1);
  const expectedHaloY = Math.max(0, expectedY - 1);
  const expectedHaloWidth = Math.min(width, expectedX + expectedInteriorWidth + 1) - expectedHaloX;
  const expectedHaloHeight = Math.min(height, expectedY + expectedInteriorHeight + 1) - expectedHaloY;
  if (
    descriptor.index !== expectedIndex
    || expectedX >= width
    || expectedY >= height
    || descriptor.interiorX !== expectedX
    || descriptor.interiorY !== expectedY
    || descriptor.interiorWidth !== expectedInteriorWidth
    || descriptor.interiorHeight !== expectedInteriorHeight
    || descriptor.haloX !== expectedHaloX
    || descriptor.haloY !== expectedHaloY
    || descriptor.haloWidth !== expectedHaloWidth
    || descriptor.haloHeight !== expectedHaloHeight
    || descriptor.encodedLength !== PACKED_GRID_HEADER_BYTES + expectedHaloWidth * expectedHaloHeight * 2
    || !/^[0-9a-f]{64}$/.test(descriptor.payloadSha256 || "0".repeat(64))
  ) {
    throw new PackedGridError("invalid_chunk_bounds", `chunk ${descriptor.index}`);
  }
}

function readStringRange(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  limit: number,
) {
  const start = view.getUint32(offset, false);
  const length = view.getUint32(offset + 4, false);
  const end = start + length;
  if (length < 1 || length > 256 || start < PACKED_GRID_HEADER_BYTES || end > limit) {
    throw new PackedGridError("invalid_string_section");
  }
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end));
  } catch {
    throw new PackedGridError("invalid_string_section", "non-UTF-8 string");
  }
  return { start, end, value };
}

function asBytes(input: ArrayBuffer | Uint8Array) {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function dataView(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function assertZero(
  bytes: Uint8Array,
  start: number,
  end: number,
  code: PackedGridErrorCode = "invalid_record_kind",
) {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] !== 0) throw new PackedGridError(code, "reserved bytes are nonzero");
  }
}

function isPowerOfTwo(value: number) {
  return (value & (value - 1)) === 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function toHex(bytes: Uint8Array) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}
