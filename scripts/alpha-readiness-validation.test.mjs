import { describe, expect, it } from "vitest";
import { validateAlphaReadiness } from "./alpha-readiness-validation.mjs";

function validReport() {
  return {
    userAgent: "Edg/140",
    documentTitle: "Mistr",
    renderer: { status: "painted", metrics: { residentFrameCount: 20 } },
    viewports: [[3_840, 2_160], [1_100, 700], [1_024, 640]].map(([width, height]) => ({
      innerWidth: width,
      innerHeight: height,
      scrollWidth: width,
      scrollHeight: height,
      persistentControlsInside: true,
      undersizedControls: [],
      openPanelCount: 0,
    })),
    keyboard: {
      menuInitialFocus: "Radar sitesChoose a NEXRAD station",
      menuFocusVisible: true,
      menuEscapeClosed: true,
      menuEscapeReturn: "Open Mistr menu",
      contextInitialFocus: "KTLXOklahoma City, Oklahoma",
      contextFocusVisible: true,
      contextEscapeClosed: true,
      contextEscapeReturn: "SITEKTLX",
      playbackBarStable: true,
      sliderBefore: 0,
      sliderAfter: 1,
      sliderValueTextUpdated: true,
    },
    accessibility: {
      unnamedInteractive: [],
      mapTabIndex: 0,
      mapAccessibleName: "Map",
      contextHasPopup: null,
    },
    forcedColors: { focusOutlineVisible: true },
    reducedMotion: { matches: true, transitionDuration: "1e-05s", animationDuration: "0.01ms" },
    contrast: { inactiveSample: 6.65 },
    visiblePrototypeTerms: [],
  };
}

describe("Alpha readiness packaged validation", () => {
  it("accepts the complete release surface contract", () => {
    expect(validateAlphaReadiness(validReport())).toEqual([]);
  });

  it.each([
    ["document overflow", (report) => { report.viewports[2].scrollWidth += 1; }],
    ["control target", (report) => { report.viewports[1].undersizedControls = ["button"]; }],
    ["focus restoration", (report) => { report.keyboard.menuEscapeReturn = ""; }],
    ["keyboard scrub", (report) => { report.keyboard.sliderAfter = 0; }],
    ["unnamed control", (report) => { report.accessibility.unnamedInteractive = ["button"]; }],
    ["forced colors", (report) => { report.forcedColors.focusOutlineVisible = false; }],
    ["reduced-motion styles", (report) => { report.reducedMotion.transitionDuration = "0.2s"; }],
    ["contrast", (report) => { report.contrast.inactiveSample = 4.2; }],
    ["prototype terminology", (report) => { report.visiblePrototypeTerms = ["benchmark"]; }],
  ])("rejects %s regression", (_name, mutate) => {
    const report = validReport();
    mutate(report);
    expect(validateAlphaReadiness(report)).not.toEqual([]);
  });
});
