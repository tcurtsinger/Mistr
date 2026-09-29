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

  it("accepts National without the startup scan", () => {
    expect(validateStartupFallbackCase("corrupt", {
      startupFallback: { painted: false, elapsedMs: 30, error: "fixture hash mismatch" },
      painted: "national",
      transition: false,
      nationalRenderer: "painted",
      alert: null,
    })).toEqual([]);
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

  it("rejects claiming a displayed source before anything paints", () => {
    const claimed = { ...liveSite(false), falseDisplayClaims: ["Choose radar source. KTLX Site is displayed."] };
    expect(validateStartupFallbackCase("missing", claimed)).toContain(
      "nothing is claimed as displayed before a source paints",
    );
  });

  it("rejects a skipped scan that records no reason", () => {
    const silent = liveSite(false);
    delete silent.startupFallback.error;
    expect(validateStartupFallbackCase("missing", silent)).toContain("a skipped startup scan records why");
  });
});
