export function validateAlphaLiveSoak(report, targetFrames) {
  const failures = [];
  requireGate(failures, Number.isSafeInteger(targetFrames) && targetFrames >= 4 && targetFrames <= 20, "invalid soak target");
  requireGate(failures, report?.siteSwitch?.pendingTopSite === "KTLX", "requested KINX was claimed before it painted");
  requireGate(failures, report?.siteSwitch?.pendingFreshness === "UPDATING KINX", "pending site was not named in freshness");
  requireGate(failures, report?.siteSwitch?.finalTopSite === "KTLX", "superseding KTLX did not own final site truth");
  requireGate(failures, report?.historyEvents?.length === targetFrames, "soak did not observe every history size");
  requireGate(failures, report?.final?.history?.residentCount === targetFrames, "final live history count is wrong");
  requireGate(failures, report?.final?.history?.capacity === 20, "live history capacity is not twenty");
  requireGate(failures, report?.final?.history?.partial === (targetFrames < 20), "partial-history truth is wrong");
  requireGate(failures, report?.final?.renderer?.metrics?.residentFrameCount === targetFrames, "renderer and live history counts disagree");
  requireGate(failures, report?.final?.renderer?.residentObservationIds?.length === targetFrames, "renderer ID list is incomplete");
  requireGate(failures, new Set(report?.final?.renderer?.residentObservationIds ?? []).size === targetFrames, "resident history contains duplicate IDs");

  const events = report?.historyEvents ?? [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    requireGate(failures, event.residentCount === index + 1, `history event ${index + 1} has the wrong count`);
    requireGate(failures, event.site === "KTLX", `history event ${index + 1} is from the wrong site`);
    if (index > 0) {
      const previous = events[index - 1];
      const expectedVolume = previous.volumeIndex === 999 ? 1 : previous.volumeIndex + 1;
      requireGate(failures, event.volumeIndex === expectedVolume, `history event ${index + 1} skipped a provider volume`);
      requireGate(failures, event.volumeStartedAtUnixMs > previous.volumeStartedAtUnixMs, `history event ${index + 1} is not newer`);
      requireGate(failures, event.observationId !== previous.observationId, `history event ${index + 1} duplicated an observation`);
    }
  }

  const expectedUploadDelta = targetFrames;
  requireGate(failures, report?.preRecoveryFrameUploadDelta === expectedUploadDelta, "live residency did not upload exactly one frame per observation");
  requireGate(failures, (report?.final?.renderer?.metrics?.gpuResourceBytes ?? Infinity) <= 200 * 1024 * 1024, "live history exceeds the GPU target");
  requireGate(failures, report?.scrub?.oldestObservationId === events[0]?.observationId, "oldest direct scrub painted the wrong frame");
  requireGate(failures, report?.scrub?.newestObservationId === events.at(-1)?.observationId, "newest direct scrub painted the wrong frame");
  requireGate(failures, report?.recovery?.recovery?.phase === "ready", "live history context recovery did not complete");
  requireGate(failures, sameMembers(report?.recovery?.before?.residentObservationIds, report?.recovery?.after?.residentObservationIds), "context recovery changed live residency");
  requireGate(failures, report?.recovery?.after?.lastPaintedObservationId === report?.scrub?.newestObservationId, "context recovery did not repaint the visible newest frame");
  if (targetFrames < 20) {
    requireGate(failures, report?.final?.timelineText?.includes(`BUILDING ${targetFrames}/20`), "partial live history is not labeled in the timeline");
  } else {
    requireGate(failures, report?.final?.timelineText?.includes("20 / 20"), "full live history position is not labeled in the timeline");
    requireGate(failures, !report?.final?.timelineText?.includes("BUILDING"), "full live history is still labeled as building");
  }
  requireGate(failures, !/\bINCOMPLETE\b/i.test(report?.final?.bodyText ?? ""), "UI labels an incomplete observation");
  requireGate(failures, report?.fatalErrors?.length === 0, "soak encountered a fatal product error");
  return failures;
}

function sameMembers(left = [], right = []) {
  return left.length === right.length && left.every(value => right.includes(value));
}

function requireGate(failures, passed, message) {
  if (!passed) failures.push(message);
}
