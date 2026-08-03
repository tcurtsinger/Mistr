import { describe, expect, it } from "vitest";
import { validateAlphaReadiness } from "./alpha-readiness-validation.mjs";

function validReport() {
  return {
    userAgent: "Edg/140",
    documentTitle: "Mistr",
    renderer: { status: "painted", metrics: { residentFrameCount: 20 } },
    viewports: [[3_840, 2_160], [1_100, 700], [1_024, 640]].flatMap(([width, height]) => (
      ["smooth", "native"].map((displayMode) => ({
        innerWidth: width,
        innerHeight: height,
        scrollWidth: width,
        scrollHeight: height,
        displayMode,
        persistentControlsInside: true,
        undersizedControls: [],
        openPanelCount: 0,
      }))
    )),
    keyboard: {
      menuInitialFocus: "Recenter radarReturn to KTLX",
      menuFocusVisible: true,
      menuEscapeClosed: true,
      menuEscapeReturn: "Open Mistr menu",
      contextInitialFocus: "Search radar sites",
      contextFocusVisible: true,
      contextEscapeClosed: true,
      contextEscapeReturn: "SITEKTLX",
      viewInitialFocus: "Smooth",
      viewFocusVisible: true,
      viewOpenPanelCount: 1,
      viewArrowFocus: "Native",
      viewSelectedMode: "native",
      viewEscapeClosed: true,
      viewEscapeReturn: "Radar display: Native",
      viewRestoredMode: "smooth",
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
      viewHasPopup: "menu",
      viewAccessibleName: "Radar display: Smooth",
    },
    forcedColors: {
      matches: true,
      focusOutlineVisibleBoth: true,
      modes: [
        { displayMode: "native", accessibleName: "Radar display: Native", focusOutlineVisible: true },
        { displayMode: "smooth", accessibleName: "Radar display: Smooth", focusOutlineVisible: true },
      ],
    },
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
    ["forced colors", (report) => { report.forcedColors.focusOutlineVisibleBoth = false; }],
    ["forced-color mode label", (report) => { report.forcedColors.modes[1].accessibleName = "Radar display"; }],
    ["reduced-motion styles", (report) => { report.reducedMotion.transitionDuration = "0.2s"; }],
    ["contrast", (report) => { report.contrast.inactiveSample = 4.2; }],
    ["prototype terminology", (report) => { report.visiblePrototypeTerms = ["benchmark"]; }],
  ])("rejects %s regression", (_name, mutate) => {
    const report = validReport();
    mutate(report);
    expect(validateAlphaReadiness(report)).not.toEqual([]);
  });
});
