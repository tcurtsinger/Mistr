export function validatePhase5Acceptance(report, cancellation, rolling, bounds, bodyText) {
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
  requireGate(failures, cancellation?.displayMode === "native", "site supersession did not run in Native");
  requireGate(
    failures,
    ["live_start_failed", "live_sweep_failed", "stale_response"].includes(cancellation?.oldCode),
    "superseded request reported an unexpected error",
  );
  requireGate(
    failures,
    cancellation?.currentObservationId === rolling?.history?.oldestObservationId,
    "current site request did not establish the first rolling observation",
  );
  const expectedNextVolumeIndex = cancellation?.currentVolumeIndex === 999
    ? 1
    : cancellation?.currentVolumeIndex + 1;
  requireGate(failures, rolling?.nextObservationId === evidence?.observationId, "next live observation did not own final publication");
  requireGate(failures, rolling?.displayMode === "smooth", "rolling history did not run in Smooth");
  requireGate(failures, rolling?.nextObservationId !== cancellation?.currentObservationId, "rolling history duplicated the first observation");
  requireGate(failures, rolling?.nextVolumeIndex === expectedNextVolumeIndex, "rolling history skipped the exact next volume index");
  requireGate(
    failures,
    rolling?.nextVolumeStartedAtUnixMs > cancellation?.currentVolumeStartedAtUnixMs,
    "rolling history did not advance measured volume time",
  );
  requireGate(failures, rolling?.history?.residentCount === 2, "rolling history did not retain two observations");
  requireGate(failures, rolling?.history?.capacity === 20, "rolling history capacity is not bounded at twenty");
  requireGate(failures, rolling?.history?.partial === true, "partial rolling history is not explicit");
  requireGate(
    failures,
    rolling?.renderer?.metrics?.frameUploadCount === cancellation?.currentFrameUploadCount + 1,
    "rolling history did not upload exactly one new GPU frame",
  );
  requireGate(
    failures,
    rolling?.renderer?.residentObservationIds?.[0] === cancellation?.currentObservationId
      && rolling?.renderer?.residentObservationIds?.[1] === rolling?.nextObservationId,
    "rolling GPU observations are not chronological and resident",
  );
  requireGate(failures, rolling?.oldestScrubObservationId === cancellation?.currentObservationId, "direct scrub did not paint the oldest live scan");
  requireGate(failures, rolling?.newestScrubObservationId === rolling?.nextObservationId, "direct scrub did not restore the newest live scan");
  requireGate(failures, !/\bINCOMPLETE\b/i.test(bodyText), "UI labels an incomplete frame");
  return failures;
}

function requireGate(failures, passed, message) {
  if (!passed) failures.push(message);
}
