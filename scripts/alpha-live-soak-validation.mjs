export function validateAlphaLiveSoak(report, targetFrames) {
  const failures = [];
  requireGate(failures, Number.isSafeInteger(targetFrames) && targetFrames >= 4 && targetFrames <= 20, "invalid soak target");
  requireGate(failures, report?.startup?.firstPaintMs > 0 && report.startup.firstPaintMs <= 15_000, "packaged first radar paint exceeded 15 seconds");
  requireGate(failures, report?.startup?.preparedArchiveFrameCount === 1, "normal startup decoded the full diagnostic archive before first paint");
  requireGate(failures, report?.startup?.diskReads === 1, "normal startup performed more than one archive disk read before live radar");
  requireGate(failures, !/RADAR UNAVAILABLE/i.test(report?.startup?.bodyText ?? ""), "normal startup exposed radar unavailable");
  requireGate(failures, report?.siteSwitch?.pendingTopSite === "KTLX", "requested KINX was claimed before it painted");
  requireGate(
    failures,
    report?.siteSwitch?.pendingNotice?.includes("Showing KTLX")
      && report.siteSwitch.pendingNotice.includes("while KINX live radar loads."),
    "pending notice does not name both painted and requested sites",
  );
  requireGate(failures, report?.siteSwitch?.finalTopSite === "KTLX", "superseding KTLX did not own final site truth");
  requireGate(failures, (report?.historyEvents?.length ?? 0) >= 1, "soak did not observe live-history growth");
  requireGate(failures, report?.final?.history?.residentCount === targetFrames, "final live history count is wrong");
  requireGate(failures, report?.final?.history?.capacity === 20, "live history capacity is not twenty");
  requireGate(failures, report?.final?.history?.partial === (targetFrames < 20), "partial-history truth is wrong");
  requireGate(failures, report?.final?.renderer?.metrics?.residentFrameCount === targetFrames, "renderer and live history counts disagree");
  requireGate(failures, report?.final?.renderer?.residentObservationIds?.length === targetFrames, "renderer ID list is incomplete");
  requireGate(failures, new Set(report?.final?.renderer?.residentObservationIds ?? []).size === targetFrames, "resident history contains duplicate IDs");
  requireGate(failures, report?.final?.history?.observationIds?.length === targetFrames, "history observation list is incomplete");
  requireGate(failures, report?.final?.history?.observedAtUnixMs?.length === targetFrames, "history timestamp list is incomplete");
  requireGate(
    failures,
    report?.final?.receipt?.observationId === report?.final?.evidence?.observationId,
    "published live evidence and paint receipt disagree",
  );
  requireGate(
    failures,
    report?.final?.publicationRenderer?.selectedObservationId === report?.final?.evidence?.observationId
      && report?.final?.publicationRenderer?.lastPaintedObservationId === report?.final?.evidence?.observationId,
    "published live evidence and renderer snapshot disagree",
  );
  requireGate(
    failures,
    strictlyIncreasing(report?.final?.history?.observedAtUnixMs ?? []),
    "resident history is not strictly chronological",
  );

  const events = report?.historyEvents ?? [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    requireGate(failures, event.residentCount >= 1 && event.residentCount <= targetFrames, `history event ${index + 1} has the wrong count`);
    requireGate(failures, event.site === "KTLX", `history event ${index + 1} is from the wrong site`);
    if (index > 0) {
      const previous = events[index - 1];
      const expectedVolume = decrementVolume(
        previous.volumeIndex,
        event.residentCount - previous.residentCount,
      );
      requireGate(failures, event.volumeIndex === expectedVolume, `history event ${index + 1} skipped a provider predecessor`);
      requireGate(failures, event.volumeStartedAtUnixMs < previous.volumeStartedAtUnixMs, `history event ${index + 1} is not older`);
      requireGate(failures, event.observationId !== previous.observationId, `history event ${index + 1} duplicated an observation`);
    }
  }
  requireGate(
    failures,
    report?.historyLoadingNotice?.includes("Loading recent scans."),
    "live-history growth never exposed its loading notice",
  );

  const expectedUploadDelta = targetFrames;
  requireGate(failures, report?.preRecoveryFrameUploadDelta === expectedUploadDelta, "live residency did not upload exactly one frame per observation");
  requireGate(failures, (report?.final?.renderer?.metrics?.gpuResourceBytes ?? Infinity) <= 200 * 1024 * 1024, "live history exceeds the GPU target");
  requireGate(failures, report?.scrub?.oldestObservationId === report?.final?.history?.observationIds?.[0], "oldest direct scrub painted the wrong frame");
  requireGate(failures, report?.scrub?.newestObservationId === report?.final?.history?.observationIds?.at(-1), "newest direct scrub painted the wrong frame");
  requireGate(failures, report?.recovery?.recovery?.phase === "ready", "live history context recovery did not complete");
  requireGate(failures, sameMembers(report?.recovery?.before?.residentObservationIds, report?.recovery?.after?.residentObservationIds), "context recovery changed live residency");
  requireGate(failures, report?.recovery?.after?.lastPaintedObservationId === report?.scrub?.newestObservationId, "context recovery did not repaint the visible newest frame");
  requireGate(failures, report?.final?.timelineText === `${targetFrames} / ${targetFrames}`, "visible timeline position does not match resident history");
  requireGate(failures, report?.final?.sliderMaximum === targetFrames - 1, "timeline maximum does not match resident history");
  requireGate(failures, report?.final?.sliderValue === targetFrames - 1, "timeline does not finish on the painted newest frame");
  requireGate(
    failures,
    report?.final?.sliderValueText?.startsWith(`Frame ${targetFrames} of ${targetFrames}.`),
    "timeline accessible value does not match the painted newest frame",
  );
  const newestObservedAt = report?.final?.history?.observedAtUnixMs?.at(-1);
  const ageCapturedAt = report?.final?.frameAgeCapturedAtUnixMs;
  const expectedAgeKind = Number.isFinite(newestObservedAt) && Number.isFinite(ageCapturedAt)
    && Math.floor(Math.max(0, ageCapturedAt - newestObservedAt) / 1_000) < 600
    ? "current"
    : "historical";
  requireGate(failures, report?.final?.frameAge?.kind === expectedAgeKind, "frame age color state disagrees with measured newest-scan age");
  requireGate(
    failures,
    report?.final?.frameAge?.accessibleName?.startsWith("Latest live scan,"),
    "newest live frame age lacks non-color accessible semantics",
  );
  requireGate(failures, !/\b(?:FRESH|STALE|PAUSED|NEWEST)\b/i.test(report?.final?.timelineText ?? ""), "timeline exposes removed status noise");
  requireGate(failures, !/\bINCOMPLETE\b/i.test(report?.final?.bodyText ?? ""), "UI labels an incomplete observation");
  requireGate(failures, report?.fatalErrors?.length === 0, "soak encountered a fatal product error");
  return failures;
}

function sameMembers(left = [], right = []) {
  return left.length === right.length && left.every(value => right.includes(value));
}

function strictlyIncreasing(values = []) {
  return values.length > 0 && values.every((value, index) => index === 0 || value > values[index - 1]);
}

function decrementVolume(volumeIndex, count) {
  return ((volumeIndex - 1 - count + 999 * 2) % 999) + 1;
}

function requireGate(failures, passed, message) {
  if (!passed) failures.push(message);
}
