export function validateAlphaReadiness(report) {
  const failures = [];
  requireGate(failures, report?.userAgent?.includes("Edg/"), "packaged runtime is not WebView2");
  requireGate(failures, report?.renderer?.status === "painted", "archive radar is not painted");
  requireGate(failures, report?.renderer?.metrics?.residentFrameCount === 20, "archive loop is not fully resident");
  requireGate(failures, report?.documentTitle === "Mistr", "packaged document title exposes non-product naming");

  const expectedViewports = [[3_840, 2_160], [1_100, 700], [1_024, 640]]
    .flatMap(([width, height]) => [
      [width, height, "smooth"],
      [width, height, "native"],
    ]);
  requireGate(failures, report?.viewports?.length === expectedViewports.length, "viewport matrix is incomplete");
  for (let index = 0; index < expectedViewports.length; index += 1) {
    const viewport = report?.viewports?.[index];
    const [width, height, displayMode] = expectedViewports[index];
    const prefix = `viewport ${width}x${height} ${displayMode}`;
    requireGate(failures, viewport?.innerWidth === width && viewport?.innerHeight === height, `${prefix} did not apply`);
    requireGate(failures, viewport?.displayMode === displayMode, `${prefix} did not apply its display mode`);
    requireGate(failures, viewport?.scrollWidth === width && viewport?.scrollHeight === height, `${prefix} has document overflow`);
    requireGate(failures, viewport?.persistentControlsInside === true, `${prefix} clips a persistent instrument`);
    requireGate(failures, viewport?.undersizedControls?.length === 0, `${prefix} has a control below the 24px target minimum`);
    requireGate(
      failures,
      viewport?.toolbarTargetSizes?.length === 3
        && viewport.toolbarTargetSizes.every(target => target.width >= 40 && target.height >= 40),
      `${prefix} has a radar toolbar target below 40px`,
    );
    requireGate(failures, viewport?.openPanelCount === 0, `${prefix} unexpectedly starts with a panel open`);
  }

  const keyboard = report?.keyboard;
  requireGate(failures, keyboard?.contextInitialFocus === "Search radar sites", "site panel does not move focus into search");
  requireGate(failures, keyboard?.contextFocusVisible === true, "site action lacks visible keyboard focus");
  requireGate(failures, keyboard?.contextOpenPanelCount === 1, "site picker violates the one-panel rule");
  requireGate(failures, keyboard?.contextEscapeClosed === true, "Escape does not close the site panel");
  requireGate(failures, keyboard?.contextEscapeReturn === "Choose radar site. KTLX is displayed.", "site panel close does not restore selector focus");
  requireGate(failures, keyboard?.toolbarRecenterFocus === "Recenter radar on KTLX", "toolbar arrow key did not move to recenter");
  requireGate(failures, keyboard?.toolbarViewFocus === "Radar view. Smooth selected.", "toolbar arrow key did not move to radar view");
  requireGate(failures, keyboard?.toolbarHomeFocus === "Choose radar site. KTLX is displayed.", "toolbar Home did not return to radar sites");
  requireGate(failures, keyboard?.viewTooltip === "Radar View", "radar view tooltip is missing or mislabeled");
  requireGate(failures, keyboard?.viewInitialFocus === "Smooth", "view menu does not focus the selected Smooth option");
  requireGate(failures, keyboard?.viewFocusVisible === true, "view option lacks visible keyboard focus");
  requireGate(failures, keyboard?.viewOpenPanelCount === 1, "view menu violates the one-panel rule");
  requireGate(failures, keyboard?.viewArrowFocus === "Native", "view menu arrow key did not move to Native");
  requireGate(failures, keyboard?.viewSelectedMode === "native", "view menu did not apply Native");
  requireGate(failures, keyboard?.viewEscapeClosed === true, "Escape does not close the view menu");
  requireGate(failures, keyboard?.viewEscapeReturn === "Radar view. Native selected.", "view menu close does not restore selector focus");
  requireGate(failures, keyboard?.viewRestoredMode === "smooth", "view menu did not restore Smooth after its keyboard check");
  requireGate(failures, keyboard?.playbackBarStable === true, "opening a panel moves the playback bar");
  requireGate(failures, keyboard?.legacyMenuAbsent === true, "removed menu or About surface is still present");
  requireGate(failures, Math.abs(keyboard?.sliderAfter - keyboard?.sliderBefore) === 1, "timeline arrow key did not scrub one frame");
  requireGate(failures, keyboard?.sliderValueTextUpdated === true, "timeline accessible value did not follow keyboard scrub");

  requireGate(failures, report?.accessibility?.unnamedInteractive?.length === 0, "accessibility tree contains unnamed controls");
  requireGate(failures, report?.accessibility?.mapTabIndex === 0, "map is not keyboard focusable");
  requireGate(failures, Boolean(report?.accessibility?.mapAccessibleName), "map has no accessible name");
  requireGate(failures, report?.accessibility?.toolbarRole === "toolbar", "radar tools do not expose their toolbar relationship");
  requireGate(failures, report?.accessibility?.contextHasPopup === "dialog", "site selector does not expose its dialog relationship");
  requireGate(failures, report?.accessibility?.contextAccessibleName === "Choose radar site. KTLX is displayed.", "site selector does not name painted site truth");
  requireGate(failures, report?.accessibility?.displayedSite === "KTLX", "site selector data does not follow painted site truth");
  requireGate(failures, report?.accessibility?.recenterAccessibleName === "Recenter radar on KTLX", "recenter control does not name the painted site");
  requireGate(failures, report?.accessibility?.viewHasPopup === "menu", "view selector does not expose its menu relationship");
  requireGate(failures, report?.accessibility?.viewAccessibleName === "Radar view. Smooth selected.", "view selector does not name the active mode");
  requireGate(failures, report?.forcedColors?.matches === true, "Windows forced-colors mode was not active");
  requireGate(
    failures,
    report?.forcedColors?.focusOutlineVisibleBoth === true,
    "Windows forced-colors focus is not visible in both radar display modes",
  );
  requireGate(
    failures,
    report?.forcedColors?.modes?.map(mode => mode.accessibleName).join("|")
      === "Radar view. Native selected.|Radar view. Smooth selected.",
    "Windows forced-colors evidence did not preserve both radar display labels",
  );
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
  requireGate(failures, report?.frameAge?.kind === "historical", "archive frame age is not presented as historical");
  requireGate(failures, report?.frameAge?.accessibleName?.startsWith("Historical scan,"), "frame age lacks non-color historical semantics");
  requireGate(failures, /^(?:\d{2}:\d{2}|\d+h \d{2}m|\d+d)$/.test(report?.frameAge?.text ?? ""), "frame age is not a concise elapsed timer");
  requireGate(failures, report?.visibleStatusNoise?.length === 0, "playback bar exposes Fresh, Stale, Paused, or Newest noise");
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
