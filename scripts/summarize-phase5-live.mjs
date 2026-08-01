import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function summarizeReports(reports) {
  const samples = reports.map(toSample).sort((left, right) => (
    left.volumeStartedAtUnixMs - right.volumeStartedAtUnixMs || left.site.localeCompare(right.site)
  ));
  const metricNames = [
    "sweepEndToRawAvailableMs",
    "rawAvailableToSafeDecodeMs",
    "sweepEndToSafeDecodeMs",
    "safeDecodeLeadVsNoaaMs",
    "safeDecodeLeadVsIemMs",
    "volumeStartToArchiveAvailableMs",
  ];
  const lowerIsWorse = new Set([
    "safeDecodeLeadVsNoaaMs",
    "safeDecodeLeadVsIemMs",
  ]);
  const latencySummary = Object.fromEntries(metricNames.map(name => [
    name,
    distribution(
      samples.map(sample => sample.latency[name]).filter(Number.isFinite),
      lowerIsWorse.has(name),
    ),
  ]));
  return {
    schemaVersion: 1,
    observedThroughUtc: new Date(Math.max(...reports.map(report => {
      const captured = Date.parse(report.capturedAtUtc);
      if (!Number.isFinite(captured)) throw new Error("probe capturedAtUtc is invalid");
      return captured;
    }))).toISOString(),
    measurement: {
      providerPollIntervalMs: 5_000,
      providerComparisonUncertaintyMs: 5_000,
      s3LastModifiedResolutionMs: 1_000,
      crossClockCaution: "S3 Last-Modified and local completion use different clocks; sub-second negative deltas are timestamp granularity, not pre-availability decode.",
      interpretation: "Positive provider-lead values mean Mistr safe decode was observed before that provider frame.",
    },
    sampleCount: samples.length,
    sites: [...new Set(samples.map(sample => sample.site))].sort(),
    vcps: [...new Set(samples.map(sample => sample.vcp))].sort((a, b) => a - b),
    echoCoverageClasses: countBy(samples, sample => sample.echoCoverageClass),
    completeVolumeComparisons: {
      compared: samples.filter(sample => sample.completeComparison !== null).length,
      allMatched: samples
        .filter(sample => sample.completeComparison !== null)
        .every(sample => sample.completeComparison.safeMatchesComplete),
    },
    latencySummary,
    samples,
  };
}

function toSample(report) {
  if (report?.schemaVersion !== 1 || !report.safe || !report.sweep) {
    throw new Error("input is not a Mistr Phase 5 probe report");
  }
  const sweepEnd = Date.parse(report.sweep.sweepEndedAtUtc);
  const noaaSeen = optionalTime(report.provider?.noaaFirstSeenAtUtc);
  const iemSeen = optionalTime(report.provider?.iemFirstSeenAtUtc);
  const archiveSeen = optionalTime(report.provider?.archiveFirstSeenAtUtc);
  const cells = report.sweep.radialCount * report.sweep.gateCount;
  const valid = Number.isSafeInteger(report.sweep.validGateCount)
    ? report.sweep.validGateCount
    : null;
  const validFraction = valid === null || cells === 0 ? null : valid / cells;
  return {
    site: report.site,
    volumeIndex: report.safe.volumeIndex,
    volumeStartedAtUnixMs: report.safe.volumeStartedAtUnixMs,
    capturedAtUtc: report.capturedAtUtc,
    freshOnly: report.freshOnly,
    vcp: report.sweep.vcp,
    radialCount: report.sweep.radialCount,
    gateCount: report.sweep.gateCount,
    validGateFraction: validFraction,
    echoCoverageClass: validFraction === null
      ? "not_recorded"
      : validFraction >= 0.20 ? "higher_echo_coverage" : "lower_echo_coverage",
    safeSequence: report.safe.safeSequence,
    decoderAttempts: report.safe.decoderAttempts,
    gapObservations: report.safe.gapObservations,
    duplicateObservations: report.safe.duplicateObservations,
    acquisition: {
      networkRequests: report.safe.acquisitionDelta?.networkRequests ?? null,
      responseBytes: report.safe.acquisitionDelta?.responseBytes ?? null,
    },
    normalizedSha256: report.sweep.normalizedSha256,
    completeComparison: report.complete ? {
      terminalSequence: report.complete.terminalSequence,
      safeMatchesComplete: report.complete.safeMatchesComplete,
      rawCodesMatch: report.complete.rawCodesMatch,
      gateStatusesMatch: report.complete.gateStatusesMatch,
      azimuthsMatch: report.complete.azimuthsMatch,
    } : null,
    latency: {
      sweepEndToRawAvailableMs: report.safe.safeChunkLastModifiedUnixMs - sweepEnd,
      rawAvailableToSafeDecodeMs:
        report.safe.decodeCompletedAtUnixMs - report.safe.safeChunkLastModifiedUnixMs,
      sweepEndToSafeDecodeMs: report.safe.decodeCompletedAtUnixMs - sweepEnd,
      safeDecodeLeadVsNoaaMs: noaaSeen === null
        ? null
        : noaaSeen - report.safe.decodeCompletedAtUnixMs,
      safeDecodeLeadVsIemMs: iemSeen === null
        ? null
        : iemSeen - report.safe.decodeCompletedAtUnixMs,
      volumeStartToArchiveAvailableMs: archiveSeen === null
        ? null
        : archiveSeen - report.safe.volumeStartedAtUnixMs,
    },
  };
}

function distribution(values, lowerIsWorse = false) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    minimum: sorted[0],
    worst: lowerIsWorse ? sorted[0] : sorted.at(-1),
  };
}

function percentile(sorted, fraction) {
  const rank = Math.ceil(sorted.length * fraction);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
}

function countBy(values, key) {
  const counts = {};
  for (const value of values) counts[key(value)] = (counts[key(value)] ?? 0) + 1;
  return counts;
}

function optionalTime(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  if (outputIndex < 0 || outputIndex === args.length - 1) {
    throw new Error("usage: node scripts/summarize-phase5-live.mjs REPORT... --output DATASET.json");
  }
  const output = resolve(args[outputIndex + 1]);
  const inputs = args.slice(0, outputIndex);
  if (inputs.length < 1) throw new Error("at least one probe report is required");
  const reports = await Promise.all(inputs.map(async input => (
    JSON.parse(await readFile(resolve(input), "utf8"))
  )));
  const dataset = summarizeReports(reports);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(dataset, null, 2)}\n`);
  console.log(`Wrote ${dataset.sampleCount} reviewed public-data sample(s) to ${output}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
