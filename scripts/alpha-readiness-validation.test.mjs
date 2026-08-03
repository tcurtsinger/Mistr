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
        toolbarTargetSizes: [
          { name: "Choose radar site. KTLX is displayed.", width: 40, height: 40 },
          { name: "Recenter radar on KTLX", width: 40, height: 40 },
          { name: "Radar view. Smooth selected.", width: 40, height: 40 },
        ],
        openPanelCount: 0,
      }))
    )),
    keyboard: {
      contextInitialFocus: "Search radar sites",
      contextFocusVisible: true,
      contextOpenPanelCount: 1,
      contextEscapeClosed: true,
      contextEscapeReturn: "Choose radar site. KTLX is displayed.",
      toolbarRecenterFocus: "Recenter radar on KTLX",
      toolbarViewFocus: "Radar view. Smooth selected.",
      toolbarHomeFocus: "Choose radar site. KTLX is displayed.",
      viewTooltip: "Radar View",
      viewInitialFocus: "Smooth",
      viewFocusVisible: true,
      viewOpenPanelCount: 1,
      viewArrowFocus: "Native",
      viewSelectedMode: "native",
      viewEscapeClosed: true,
      viewEscapeReturn: "Radar view. Native selected.",
      viewRestoredMode: "smooth",
      playbackBarStable: true,
      legacyMenuAbsent: true,
      sliderBefore: 0,
      sliderAfter: 1,
      sliderValueTextUpdated: true,
    },
    accessibility: {
      unnamedInteractive: [],
      mapTabIndex: 0,
      mapAccessibleName: "Map",
      toolbarRole: "toolbar",
      contextHasPopup: "dialog",
      contextAccessibleName: "Choose radar site. KTLX is displayed.",
      displayedSite: "KTLX",
      recenterAccessibleName: "Recenter radar on KTLX",
      viewHasPopup: "menu",
      viewAccessibleName: "Radar view. Smooth selected.",
    },
    forcedColors: {
      matches: true,
      focusOutlineVisibleBoth: true,
      modes: [
        { displayMode: "native", accessibleName: "Radar view. Native selected.", focusOutlineVisible: true },
        { displayMode: "smooth", accessibleName: "Radar view. Smooth selected.", focusOutlineVisible: true },
      ],
    },
    reducedMotion: { matches: true, transitionDuration: "1e-05s", animationDuration: "0.01ms" },
    contrast: { inactiveSample: 6.65 },
    frameAge: { text: "2d", accessibleName: "Historical scan, observed 2 days ago.", kind: "historical" },
    visibleStatusNoise: [],
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
    ["toolbar target", (report) => { report.viewports[0].toolbarTargetSizes[1].width = 36; }],
    ["focus restoration", (report) => { report.keyboard.contextEscapeReturn = ""; }],
    ["toolbar navigation", (report) => { report.keyboard.toolbarViewFocus = ""; }],
    ["view tooltip", (report) => { report.keyboard.viewTooltip = "View"; }],
    ["keyboard scrub", (report) => { report.keyboard.sliderAfter = 0; }],
    ["unnamed control", (report) => { report.accessibility.unnamedInteractive = ["button"]; }],
    ["forced colors", (report) => { report.forcedColors.focusOutlineVisibleBoth = false; }],
    ["forced-color mode label", (report) => { report.forcedColors.modes[1].accessibleName = "Radar view"; }],
    ["reduced-motion styles", (report) => { report.reducedMotion.transitionDuration = "0.2s"; }],
    ["contrast", (report) => { report.contrast.inactiveSample = 4.2; }],
    ["frame age semantics", (report) => { report.frameAge.kind = "current"; }],
    ["status noise", (report) => { report.visibleStatusNoise = ["Paused"]; }],
    ["prototype terminology", (report) => { report.visiblePrototypeTerms = ["benchmark"]; }],
  ])("rejects %s regression", (_name, mutate) => {
    const report = validReport();
    mutate(report);
    expect(validateAlphaReadiness(report)).not.toEqual([]);
  });
});
