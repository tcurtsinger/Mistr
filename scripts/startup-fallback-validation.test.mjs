import { describe, expect, it } from "vitest";
import { validateStartupFallbackCase } from "./startup-fallback-validation.mjs";

function liveSite(fallbackPainted) {
  return {
    startupFallback: fallbackPainted
      ? { painted: true, elapsedMs: 400 }
      : { painted: false, elapsedMs: 20, error: "fixture read failed" },
    painted: "KTLX",
    transition: false,
    liveSite: "KTLX",
    liveSourceKind: "nexrad_level2_chunks",
    siteRenderer: "painted",
    sitePlaybackReady: true,
    nationalRenderer: null,
    alert: null,
  };
}

describe("startup-fallback gate", () => {
  it("accepts a bundled scan, then live KTLX", () => {
    expect(validateStartupFallbackCase("bundled", liveSite(true))).toEqual([]);
  });

  it("accepts live KTLX without the startup scan", () => {
    expect(validateStartupFallbackCase("missing", liveSite(false))).toEqual([]);
  });

  it("accepts live KTLX after a corrupt startup scan", () => {
    expect(validateStartupFallbackCase("corrupt", liveSite(false))).toEqual([]);
  });

  it("accepts a National launch that skips the startup scan", () => {
    const national = {
      startupFallback: { painted: false, elapsedMs: 0, skipped: "launch is not KTLX" },
      painted: "national",
      transition: false,
      nationalRenderer: "painted",
      alert: null,
    };
    expect(validateStartupFallbackCase("national", national)).toEqual([]);
    const decoded = { ...national, startupFallback: { painted: true, elapsedMs: 1_100 } };
    expect(validateStartupFallbackCase("national", decoded)).toContain(
      "a launch that is not KTLX skips the startup scan",
    );
  });

  it("rejects a launch stuck on the archive or without live radar", () => {
    const stuck = { ...liveSite(false), liveSourceKind: "nexrad_level2_archive_ii" };
    expect(validateStartupFallbackCase("missing", stuck)).toContain("the Site shows live radar");
    const failed = { ...liveSite(false), painted: null, alert: "KTLX radar is unavailable" };
    expect(validateStartupFallbackCase("missing", failed)).toEqual([
      "the launch reaches current Site radar",
      "the launch reports: KTLX radar is unavailable",
    ]);
  });

  it("accepts a reload mid-download that reaches live KTLX again", () => {
    expect(validateStartupFallbackCase("reload", { ...liveSite(true), reloaded: true })).toEqual([]);
    expect(validateStartupFallbackCase("reload", liveSite(true))).toContain("the page reloaded mid-download");
  });

  it("rejects a failed scan that records no reason", () => {
    const silent = liveSite(false);
    delete silent.startupFallback.error;
    expect(validateStartupFallbackCase("missing", silent)).toContain("a failed startup scan records why");
  });
});
