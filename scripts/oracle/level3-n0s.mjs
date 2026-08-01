import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const decode = require("nexrad-level-3-data");

const [inputPath, siteIcao, outputPath] = process.argv.slice(2);
if (!inputPath || !siteIcao || !outputPath) {
  throw new Error("usage: node scripts/oracle/level3-n0s.mjs <input> <site-icao> <output>");
}

const input = await readFile(inputPath);
const warnings = [];
const result = decode(input, {
  logger: {
    log() {},
    error(message) { warnings.push(String(message)); },
    warn(message) { warnings.push(String(message)); },
  },
});
if (warnings.length > 0) throw new Error(`oracle emitted warnings: ${warnings.join(" | ")}`);
if (result.messageHeader?.code !== 56 || result.textHeader?.type !== "N0S") {
  throw new Error("oracle did not identify product 56 / N0S");
}
if (siteIcao.length !== 4 || siteIcao.slice(1) !== result.textHeader.id3) {
  throw new Error("oracle site does not match requested ICAO");
}
const packet = result.radialPackets?.flat(Infinity).find((candidate) => candidate?.packetCodeHex === "af1f");
if (!packet || packet.radials.length !== packet.numRadials) {
  throw new Error("oracle did not expose one complete AF1F radial packet");
}

const thresholdWords = [...result.productDescription.dependent31_46.values()]
  .reduce((words, byte, index, bytes) => {
    if (index % 2 === 0) words.push((byte << 8) | bytes[index + 1]);
    return words;
  }, []);
const thresholds = thresholdWords.map((word) => {
  const flag = word >>> 8;
  const magnitude = word & 0xff;
  if (flag === 0x80) return null;
  if (flag === 0x01) return -magnitude;
  if (flag === 0x00 || flag === 0x02) return magnitude;
  throw new Error(`unsupported oracle threshold 0x${word.toString(16)}`);
});

const azimuthHash = createHash("sha256");
const fieldHash = createHash("sha256");
const statusHash = createHash("sha256");
const rawHash = createHash("sha256");
const counts = Array(16).fill(0);
let cellCount = 0;
const sortedRadials = packet.radials
  .map((radial, sourceIndex) => ({ radial, sourceIndex }))
  .sort((left, right) => {
    const leftCenter = (left.radial.startAngle + left.radial.angleDelta / 2) % 360;
    const rightCenter = (right.radial.startAngle + right.radial.angleDelta / 2) % 360;
    return leftCenter - rightCenter;
  });
for (const { radial } of sortedRadials) {
  if (radial.bins.length !== packet.numberBins) throw new Error("oracle radial bin count mismatch");
  const start = Math.fround(radial.startAngle);
  const width = Math.fround(radial.angleDelta);
  const center = Math.fround(start + Math.fround(width / Math.fround(2)));
  hashF32(azimuthHash, center >= 360 ? Math.fround(center - 360) : center);
  for (const category of radial.bins) {
    counts[category] += 1;
    cellCount += 1;
    const status = category === 0 ? 1 : category === 15 ? 2 : 0;
    fieldHash.update(Buffer.from([status === 0 ? 1 : 0]));
    hashF32(fieldHash, status === 0 ? thresholds[category] : 0);
    statusHash.update(Buffer.from([status]));
    const raw = Buffer.alloc(2);
    raw.writeUInt16LE(category);
    rawHash.update(raw);
  }
}

const product = result.productDescription;
const report = {
  schemaVersion: 1,
  oracle: "nexrad-level-3-data@0.6.1",
  siteIcao,
  productCode: result.messageHeader.code,
  productMnemonic: result.textHeader.type,
  productLabel: "storm_relative_velocity",
  units: "kt",
  radarLatitudeDegrees: product.latitude,
  radarLongitudeDegrees: product.longitude,
  heightFeet: product.height,
  vcp: product.vcp,
  volumeScanDate: product.volumeScanDate,
  volumeScanSeconds: product.volumeScanTime,
  productDate: product.productDate,
  productSeconds: product.productTime,
  elevationNumber: product.elevationNumber,
  elevationDegrees: product.elevationAngle,
  maxNegativeVelocityKt: product.maxNegativeVelocity,
  maxPositiveVelocityKt: product.maxPositiveVelocity,
  averageStormSpeedKt: product.averageStormSpeed,
  averageStormDirectionDegrees: product.averageStormDirection,
  packetCode: packet.packetCodeHex,
  radialCount: packet.numRadials,
  gateCount: packet.numberBins,
  cellCount,
  firstBin: packet.firstBin,
  rangeScaleKm: packet.rangeScale,
  categoryThresholdWords: thresholdWords.map((word) => `0x${word.toString(16).padStart(4, "0")}`),
  categoryThresholdsKt: thresholds,
  categoryCounts: counts,
  azimuthSha256: azimuthHash.digest("hex"),
  oracleFieldSha256: fieldHash.digest("hex"),
  gateStatusSha256: statusHash.digest("hex"),
  rawCodesSha256: rawHash.digest("hex"),
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

function hashF32(hash, value) {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatLE(Math.fround(value));
  hash.update(bytes);
}
