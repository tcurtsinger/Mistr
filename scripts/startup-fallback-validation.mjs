// Startup-fallback gate: the bundled startup scan is a bridge, not a
// prerequisite. With it present it paints first; missing or corrupt, the
// launch still reaches current radar for the restored camera.
const EXPECTED = {
  bundled: { fallbackPainted: true, painted: "KTLX" },
  missing: { fallbackPainted: false, painted: "KTLX" },
  corrupt: { fallbackPainted: false, painted: "national" },
};

export function validateStartupFallbackCase(label, result) {
  const expected = EXPECTED[label];
  if (!expected) return [`unknown startup-fallback case ${label}`];
  const failures = [];
  const fallback = result?.startupFallback;
  if (fallback?.painted !== expected.fallbackPainted) {
    failures.push(expected.fallbackPainted
      ? "the bundled startup scan paints first"
      : "a missing or corrupt startup scan is skipped");
  }
  if (!expected.fallbackPainted && !fallback?.error) failures.push("a skipped startup scan records why");
  if (result?.transition || result?.painted !== expected.painted) {
    failures.push(`the launch reaches current ${expected.painted === "national" ? "National" : "Site"} radar`);
  }
  if (expected.painted === "national" && result?.nationalRenderer !== "painted") {
    failures.push("National paints without the startup scan");
  }
  if (expected.painted !== "national") {
    if (result?.liveSite !== expected.painted || result?.liveSourceKind !== "nexrad_level2_chunks") {
      failures.push("the Site shows live radar");
    }
    if (result?.siteRenderer !== "painted" || result?.sitePlaybackReady !== true) {
      failures.push("the Site renderer and playback are ready");
    }
  }
  if (result?.alert) failures.push(`the launch reports: ${result.alert}`);
  return failures;
}
