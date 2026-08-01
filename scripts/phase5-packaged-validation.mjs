export function validatePhase5Acceptance(report, cancellation, bounds, bodyText) {
  const failures = [];
  const evidence = report?.evidence;
  const receipt = report?.receipt;
  const renderer = report?.renderer;
  const display = report?.display;
  requireGate(failures, display?.kind === "painted", "live display is not painted truth");
  requireGate(failures, display?.live?.source === "nexrad_level2_chunks", "painted source is not live Level II chunks");
  requireGate(failures, evidence?.sourceKind === "nexrad_level2_chunks", "backend evidence source is not live chunks");
  requireGate(failures, evidence?.safe?.site === "KTLX", "packaged live site is not KTLX");
  requireGate(failures, evidence?.safe?.safeSequence >= 1, "safe chunk boundary is absent");
  requireGate(failures, evidence?.safe?.gapObservations === 0, "packaged observation crossed a chunk gap");
  requireGate(failures, evidence?.safe?.decodeCompletedAtUnixMs >= evidence?.safe?.decodeStartedAtUnixMs, "decode timestamps are inconsistent");
  requireGate(failures, receipt?.observationId === evidence?.observationId, "paint receipt and backend evidence disagree");
  requireGate(failures, receipt?.completedAtUnixMs >= evidence?.safe?.decodeCompletedAtUnixMs, "GPU paint precedes safe decode");
  requireGate(failures, renderer?.selectedObservationId === evidence?.observationId, "renderer selection is not the live observation");
  requireGate(failures, renderer?.lastPaintedObservationId === evidence?.observationId, "renderer last paint is not the live observation");
  requireGate(failures, renderer?.capabilities?.hardwareAcceleration === true, "hardware acceleration is unavailable");
  requireGate(failures, receipt?.framebufferWidth >= 3_840 && receipt?.framebufferHeight >= 2_160, "live paint did not occur at 4K");
  requireGate(failures, bounds?.width >= 3_840 && bounds?.height >= 2_160, "packaged window is smaller than 4K");
  requireGate(failures, cancellation?.oldRejected === true, "superseded site request was not rejected");
  requireGate(failures, cancellation?.oldCode === "live_sweep_failed" || cancellation?.oldCode === "stale_response", "superseded request reported an unexpected error");
  requireGate(failures, cancellation?.currentObservationId === evidence?.observationId, "current site request did not own final publication");
  requireGate(failures, !/\bINCOMPLETE\b/i.test(bodyText), "UI labels an incomplete frame");
  return failures;
}

function requireGate(failures, passed, message) {
  if (!passed) failures.push(message);
}
