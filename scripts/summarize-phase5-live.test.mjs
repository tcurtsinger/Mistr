import { describe, expect, it } from "vitest";
import { summarizeReports } from "./summarize-phase5-live.mjs";

function report(site, delay, validFraction, matches = true) {
  const cells = 100;
  return {
    schemaVersion: 1,
    capturedAtUtc: "2026-08-01T00:01:00.000Z",
    site,
    freshOnly: true,
    safe: {
      volumeIndex: 1,
      volumeStartedAtUnixMs: 1_785_556_800_000,
      safeSequence: 8,
      safeChunkLastModifiedUnixMs: 1_785_556_810_000,
      decodeCompletedAtUnixMs: 1_785_556_810_000 + delay,
      decoderAttempts: 2,
      gapObservations: 0,
      duplicateObservations: 0,
    },
    sweep: {
      vcp: site === "KTLX" ? 212 : 35,
      radialCount: 10,
      gateCount: 10,
      validGateCount: cells * validFraction,
      sweepEndedAtUtc: "2026-08-01T00:00:05.000Z",
      normalizedSha256: site.toLowerCase().padEnd(64, "0"),
    },
    complete: {
      terminalSequence: 60,
      safeMatchesComplete: matches,
      rawCodesMatch: matches,
      gateStatusesMatch: matches,
      azimuthsMatch: matches,
    },
    provider: {
      noaaFirstSeenAtUtc: "2026-08-01T00:00:15.000Z",
      iemFirstSeenAtUtc: "2026-08-01T00:00:20.000Z",
      archiveFirstSeenAtUtc: "2026-08-01T00:05:00.000Z",
    },
  };
}

describe("Phase 5 live evidence summary", () => {
  it("uses nearest-rank distributions and preserves comparison truth", () => {
    const summary = summarizeReports([
      report("KTLX", 1_000, 0.20),
      report("KABR", 3_000, 0.02),
    ]);
    expect(summary.sampleCount).toBe(2);
    expect(summary.vcps).toEqual([35, 212]);
    expect(summary.echoCoverageClasses).toEqual({
      lower_echo_coverage: 1,
      higher_echo_coverage: 1,
    });
    expect(summary.latencySummary.rawAvailableToSafeDecodeMs).toMatchObject({
      p50: 1_000,
      p95: 3_000,
      worst: 3_000,
    });
    expect(summary.latencySummary.safeDecodeLeadVsNoaaMs.worst)
      .toBe(summary.latencySummary.safeDecodeLeadVsNoaaMs.minimum);
    expect(summary.latencySummary.safeDecodeLeadVsNoaaMs.p95)
      .toBeGreaterThan(summary.latencySummary.safeDecodeLeadVsNoaaMs.worst);
    expect(summary.latencySummary.safeDecodeLeadVsIemMs.worst)
      .toBe(summary.latencySummary.safeDecodeLeadVsIemMs.minimum);
    expect(summary.latencySummary.safeDecodeLeadVsIemMs.p95)
      .toBeGreaterThan(summary.latencySummary.safeDecodeLeadVsIemMs.worst);
    expect(summary.completeVolumeComparisons).toEqual({ compared: 2, allMatched: true });
  });
});
