export function validateAlphaReadiness(report) {
  const failures = [];
  requireGate(failures, report?.userAgent?.includes("Edg/"), "packaged runtime is not WebView2");
  requireGate(failures, report?.renderer?.status === "painted", "archive radar is not painted");
  requireGate(failures, report?.renderer?.metrics?.residentFrameCount === 20, "archive loop is not fully resident");
  requireGate(failures, report?.documentTitle === "Mistr", "packaged document title exposes non-product naming");

  const expectedViewports = [[3_840, 2_160], [1_100, 700], [1_024, 640]];
  requireGate(failures, report?.viewports?.length === expectedViewports.length, "viewport matrix is incomplete");
  for (let index = 0; index < expectedViewports.length; index += 1) {
    const viewport = report?.viewports?.[index];
    const [width, height] = expectedViewports[index];
    const prefix = `viewport ${width}x${height}`;
    requireGate(failures, viewport?.innerWidth === width && viewport?.innerHeight === height, `${prefix} did not apply`);
    requireGate(failures, viewport?.scrollWidth === width && viewport?.scrollHeight === height, `${prefix} has document overflow`);
    requireGate(failures, viewport?.persistentControlsInside === true, `${prefix} clips a persistent instrument`);
    requireGate(failures, viewport?.undersizedControls?.length === 0, `${prefix} has a control below the 24px target minimum`);
    requireGate(failures, viewport?.openPanelCount === 0, `${prefix} unexpectedly starts with a panel open`);
  }

  const keyboard = report?.keyboard;
  requireGate(failures, keyboard?.menuInitialFocus?.startsWith("Recenter radar"), "menu does not move focus into its first action");
  requireGate(failures, keyboard?.menuFocusVisible === true, "menu action lacks visible keyboard focus");
  requireGate(failures, keyboard?.menuEscapeClosed === true, "Escape does not close the menu");
  requireGate(failures, keyboard?.menuEscapeReturn === "Open Mistr menu", "menu close does not restore trigger focus");
  requireGate(failures, keyboard?.contextInitialFocus === "Search radar sites", "site panel does not move focus into search");
  requireGate(failures, keyboard?.contextFocusVisible === true, "site action lacks visible keyboard focus");
  requireGate(failures, keyboard?.contextEscapeClosed === true, "Escape does not close the site panel");
  requireGate(failures, keyboard?.contextEscapeReturn?.includes("SITE"), "site panel close does not restore selector focus");
  requireGate(failures, keyboard?.playbackBarStable === true, "opening a panel moves the playback bar");
  requireGate(failures, Math.abs(keyboard?.sliderAfter - keyboard?.sliderBefore) === 1, "timeline arrow key did not scrub one frame");
  requireGate(failures, keyboard?.sliderValueTextUpdated === true, "timeline accessible value did not follow keyboard scrub");

  requireGate(failures, report?.accessibility?.unnamedInteractive?.length === 0, "accessibility tree contains unnamed controls");
  requireGate(failures, report?.accessibility?.mapTabIndex === 0, "map is not keyboard focusable");
  requireGate(failures, Boolean(report?.accessibility?.mapAccessibleName), "map has no accessible name");
  requireGate(failures, report?.accessibility?.contextHasPopup === null, "site selector claims a popup role the panel does not implement");
  requireGate(failures, report?.forcedColors?.focusOutlineVisible === true, "Windows forced-colors focus is not visible");
  requireGate(failures, report?.reducedMotion?.matches === true, "reduced-motion preference was not honored");
  requireGate(
    failures,
    maximumCssDurationMs(report?.reducedMotion?.transitionDuration) <= 0.1,
    "reduced-motion preference did not suppress chrome transitions",
  );
  requireGate(
    failures,
    maximumCssDurationMs(report?.reducedMotion?.animationDuration) <= 0.1,
    "reduced-motion preference did not suppress chrome animations",
  );
  requireGate(failures, report?.contrast?.inactiveSample >= 4.5, "inactive inspection instruction fails text contrast");
  requireGate(failures, report?.visiblePrototypeTerms?.length === 0, "normal UI exposes engineering terminology");
  return failures;
}

function requireGate(failures, passed, message) {
  if (!passed) failures.push(message);
}

function maximumCssDurationMs(value) {
  if (typeof value !== "string" || value.length === 0) return Number.POSITIVE_INFINITY;
  const durations = value.split(",").map(duration => {
    const match = duration.trim().match(/^([0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?)(ms|s)$/i);
    if (!match) return Number.POSITIVE_INFINITY;
    const amount = Number(match[1]);
    return match[2].toLowerCase() === "s" ? amount * 1_000 : amount;
  });
  return Math.max(...durations);
}
