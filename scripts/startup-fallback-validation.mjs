// Startup-fallback gate: the bundled startup scan is a bridge, not a
// prerequisite. A KTLX launch paints it first when it is present, and still
// reaches live KTLX when it is missing or corrupt. Other launches skip it.
const EXPECTED = {
  bundled: { fallbackPainted: true, painted: "KTLX" },
  missing: { fallbackPainted: false, painted: "KTLX" },
  corrupt: { fallbackPainted: false, painted: "KTLX" },
  national: { fallbackPainted: false, skipped: true, painted: "national" },
  reload: { fallbackPainted: true, painted: "KTLX", reloaded: true },
  kfws: { fallbackPainted: false, skipped: true, painted: "KFWS", archiveFrames: 20 },
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
  if (expected.skipped) {
    if (!fallback?.skipped || fallback?.error) failures.push("a launch that is not KTLX skips the startup scan");
  } else if (!expected.fallbackPainted && !fallback?.error) {
    failures.push("a failed startup scan records why");
  }
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
  if (expected.reloaded && result?.reloaded !== true) failures.push("the page reloaded mid-download");
  if (expected.archiveFrames && result?.archive?.residentFrames !== expected.archiveFrames) {
    failures.push("diagnostics hydrate the full archive loop without a startup scan");
  }
  if (result?.falseDisplayClaims?.length) {
    failures.push("nothing is claimed as displayed before a source paints");
  }
  if (result?.alert) failures.push(`the launch reports: ${result.alert}`);
  return failures;
}
