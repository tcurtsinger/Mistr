import { describe, expect, it } from "vitest";
import { validateStartupCase } from "./startup-validation.mjs";

function liveSite(site = "KTLX") {
  return {
    painted: site,
    transition: false,
    liveSite: site,
    liveSourceKind: "nexrad_level2_chunks",
    siteRenderer: "painted",
    sitePlaybackReady: true,
    nationalRenderer: null,
    archiveShownAtLaunch: false,
    falseDisplayClaims: [],
    alert: null,
  };
}

function national() {
  return {
    painted: "national",
    transition: false,
    nationalRenderer: "painted",
    archiveShownAtLaunch: false,
    falseDisplayClaims: [],
    alert: null,
  };
}

describe("startup gate", () => {
  it("accepts a fresh profile and a country view opening National", () => {
    expect(validateStartupCase("fresh", national())).toEqual([]);
    expect(validateStartupCase("national", national())).toEqual([]);
    expect(validateStartupCase("fresh", liveSite())).toContain("the launch reaches current National radar");
  });

  it("accepts a zoomed-in launch opening live KTLX", () => {
    expect(validateStartupCase("site", liveSite())).toEqual([]);
  });

  it("rejects a launch that shows the bundled archive scan", () => {
    expect(validateStartupCase("site", { ...liveSite(), archiveShownAtLaunch: true })).toContain(
      "the launch shows no bundled archive scan",
    );
    expect(validateStartupCase("site", { ...liveSite(), liveSourceKind: "nexrad_level2_archive_ii" })).toContain(
      "the Site shows live radar",
    );
  });

  it("accepts a reload mid-download that reaches live KTLX again", () => {
    expect(validateStartupCase("reload", { ...liveSite(), reloaded: true })).toEqual([]);
    expect(validateStartupCase("reload", liveSite())).toContain("the page reloaded mid-download");
  });

  it("requires the full archive loop from a KFWS or National launch", () => {
    expect(validateStartupCase("kfws", { ...liveSite("KFWS"), archive: { residentFrames: 20 } })).toEqual([]);
    expect(validateStartupCase("national-archive", { ...national(), archive: { residentFrames: 20 } })).toEqual([]);
    expect(validateStartupCase("national-archive", { ...national(), archive: { residentFrames: null, error: "x" } }))
      .toContain("diagnostics hydrate the full archive loop from this launch");
  });

  it("rejects claiming a displayed source before anything paints", () => {
    const claimed = { ...national(), falseDisplayClaims: ["Choose radar source. KTLX Site is displayed."] };
    expect(validateStartupCase("national", claimed)).toContain(
      "nothing is claimed as displayed before a source paints",
    );
  });

  it("reports an alert on screen", () => {
    expect(validateStartupCase("site", { ...liveSite(), alert: "KTLX radar is unavailable" })).toContain(
      "the launch reports: KTLX radar is unavailable",
    );
  });
});
