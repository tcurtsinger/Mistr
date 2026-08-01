import { readFile, writeFile } from "node:fs/promises";

const [rustPath, oraclePath, outputPath] = process.argv.slice(2);
if (!rustPath || !oraclePath || !outputPath) {
  throw new Error("usage: node scripts/compare-level3-n0s.mjs <rust-json> <oracle-json> <output-json>");
}
const rust = JSON.parse(await readFile(rustPath, "utf8"));
const oracle = JSON.parse(await readFile(oraclePath, "utf8"));
const checks = {
  siteIcao: rust.siteIcao === oracle.siteIcao,
  productIdentity: rust.product === oracle.productLabel && oracle.productCode === 56 && oracle.productMnemonic === "N0S",
  units: rust.units === oracle.units,
  coordinates: rust.radarLatitudeDegrees === oracle.radarLatitudeDegrees && rust.radarLongitudeDegrees === oracle.radarLongitudeDegrees,
  elevation: rust.elevationNumber === oracle.elevationNumber && rust.elevationDegrees === oracle.elevationDegrees,
  vcp: rust.vcp === oracle.vcp,
  dimensions: rust.radialCount === oracle.radialCount && rust.gateCount === oracle.gateCount && rust.cellCount === oracle.cellCount,
  gateGeometry: rust.gateSpacingM === Math.round(oracle.rangeScaleKm * 1_000) && rust.firstGateCenterM === Math.ceil(rust.gateSpacingM / 2),
  validCount: rust.validCount === oracle.categoryCounts.slice(1, 15).reduce((sum, value) => sum + value, 0),
  missingCount: rust.belowThresholdCount === oracle.categoryCounts[0],
  rangeFoldedCount: rust.rangeFoldedCount === oracle.categoryCounts[15],
  azimuthSha256: rust.azimuthSha256 === oracle.azimuthSha256,
  oracleFieldSha256: rust.oracleFieldSha256 === oracle.oracleFieldSha256,
  gateStatusSha256: rust.gateStatusSha256 === oracle.gateStatusSha256,
  rawCodesSha256: rust.rawCodesSha256 === oracle.rawCodesSha256,
};
const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
const comparison = {
  schemaVersion: 1,
  passed: failed.length === 0,
  rustDecoder: rust.decoder,
  independentOracle: oracle.oracle,
  siteIcao: rust.siteIcao,
  sourceSha256: rust.sourceSha256,
  checks,
  failed,
};
await writeFile(outputPath, `${JSON.stringify(comparison, null, 2)}\n`);
if (failed.length > 0) throw new Error(`N0S comparison failed: ${failed.join(", ")}`);
