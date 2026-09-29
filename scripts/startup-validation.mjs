// Startup gate: a launch paints current radar for its restored camera, and
// no bundled archive scan. A fresh profile opens National. The archive loop
// stays available to diagnostics from any launch.
const EXPECTED = {
  fresh: { painted: "national" },
  national: { painted: "national" },
  site: { painted: "KTLX" },
  reload: { painted: "KTLX", reloaded: true },
  kfws: { painted: "KFWS", archiveFrames: 20 },
  "national-archive": { painted: "national", archiveFrames: 20 },
};

export function validateStartupCase(label, result) {
  const expected = EXPECTED[label];
  if (!expected) return [`unknown startup case ${label}`];
  const failures = [];
  if (result?.transition || result?.painted !== expected.painted) {
    failures.push(`the launch reaches current ${expected.painted === "national" ? "National" : "Site"} radar`);
  }
  if (expected.painted === "national" && result?.nationalRenderer !== "painted") {
    failures.push("National paints on its own");
  }
  if (expected.painted !== "national") {
    if (result?.liveSite !== expected.painted || result?.liveSourceKind !== "nexrad_level2_chunks") {
      failures.push("the Site shows live radar");
    }
    if (result?.siteRenderer !== "painted" || result?.sitePlaybackReady !== true) {
      failures.push("the Site renderer and playback are ready");
    }
  }
  if (result?.archiveShownAtLaunch) failures.push("the launch shows no bundled archive scan");
  if (expected.reloaded && result?.reloaded !== true) failures.push("the page reloaded mid-download");
  if (expected.archiveFrames && result?.archive?.residentFrames !== expected.archiveFrames) {
    failures.push("diagnostics hydrate the full archive loop from this launch");
  }
  if (result?.falseDisplayClaims?.length) {
    failures.push("nothing is claimed as displayed before a source paints");
  }
  if (result?.alert) failures.push(`the launch reports: ${result.alert}`);
  return failures;
}
