const TARGET_BYTES = 200 * 1024 * 1024;
const HARD_CEILING_BYTES = 256 * 1024 * 1024;

export function validateNationalPhase4Acceptance(report) {
  const failures = [];
  const history = report.history?.history;
  const renderer = report.history?.renderer;
  const playback = report.history?.playback;
  const retained = history?.retained ?? [];
  const ids = retained.map(observationId);
  const times = retained.map((observation) => observation.observationTimeUnixMs);

  if (history?.historyLimit !== 20 || retained.length !== 20) failures.push("20 retained observations");
  if (!strictlyIncreasing(times) || new Set(ids).size !== 20) failures.push("chronological unique history");
  if (!(times.at(-1) - times[0] >= 30 * 60_000)) failures.push("approximately 38 minute history span");
  if (
    history?.staged !== null
    || history?.mutationReversible !== false
    || history?.reversibleCommitBytes !== 0
    || !(history?.totalBackendBytes > 0 && history.totalBackendBytes <= history.backendTargetBytes)
  ) failures.push("bounded finalized backend history");
  if (
    renderer?.status !== "painted"
    || renderer?.mutationAwaitingCommit !== false
    || renderer?.commonResidentObservationIds?.length !== 20
    || !sameMembers(renderer?.commonResidentObservationIds ?? [], ids)
  ) failures.push("all-frame common GPU residency");
  if (!(renderer?.gpuResourceBytes > 0 && renderer.gpuResourceBytes < TARGET_BYTES && renderer.peakGpuResourceBytes < HARD_CEILING_BYTES)) failures.push("National GPU memory budget");
  if (!(renderer?.maximumUploadSliceMs > 0 && renderer.maximumUploadSliceMs <= 4)) failures.push("4 ms upload slice budget");
  if (playback?.residentCount !== 20 || !ids.includes(playback?.selectedObservationId)) failures.push("20-frame playback timeline");

  const transitions = report.transitions;
  if (transitions?.requestedTransitions !== 1_000 || transitions?.completedTransitions !== 1_000) failures.push("1000 resident transitions");
  if (!zeroActivity(transitions?.activityDelta)) failures.push("zero hot-path backend activity");
  if (
    transitions?.rendererBefore?.uploadCount !== transitions?.rendererAfter?.uploadCount
    || transitions?.rendererBefore?.uploadBytes !== transitions?.rendererAfter?.uploadBytes
  ) failures.push("zero hot-path upload activity");
  if (
    transitions?.receipts?.length !== 1_000
    || transitions.receipts.some((receipt) => receipt.presentationFactor !== 4 || !ids.includes(receipt.observationId))
  ) failures.push("common-level transition receipts");

  const oldestScrub = report.scrub?.oldest;
  const newestScrub = report.scrub?.newest;
  if (
    oldestScrub?.receipt?.observationId !== ids[0]
    || newestScrub?.receipt?.observationId !== ids.at(-1)
    || oldestScrub?.receipt?.presentationFactor !== 4
    || newestScrub?.receipt?.presentationFactor !== 4
    || !zeroActivity(oldestScrub?.activityDelta)
    || !zeroActivity(newestScrub?.activityDelta)
  ) failures.push("direct resident scrub receipts");

  const detail = report.detail?.renderer;
  if (
    detail?.presentationFactor !== 1
    || detail?.fallbackPresentationFactor !== 4
    || detail?.fallbackChunkCount !== 28
    || detail?.commonResidentObservationIds?.length !== 20
    || !(detail?.detailedObservationIds?.length >= 2 && detail.detailedObservationIds.length <= 3)
    || detail?.mutationAwaitingCommit !== false
  ) failures.push("selected and temporal-window detail residency");

  const active = report.activePlayback;
  if (
    active?.playback?.playing !== true
    || active?.playback?.qualityLockFactor !== 4
    || active?.renderer?.playbackQualityFactor !== 4
    || active?.renderer?.presentationFactor !== 4
  ) failures.push("high-zoom playback quality lock");

  const reset = report.contextReset;
  if (
    reset?.receipt?.contextEpoch !== (reset?.before?.contextEpoch ?? 0) + 1
    || reset?.after?.status !== "painted"
    || reset?.after?.commonResidentObservationIds?.length !== 20
    || !zeroActivity(reset?.activityDelta)
  ) failures.push("network-free all-frame context recovery");

  const peak = report.peak;
  if (
    peak?.status !== "valid"
    || !Number.isFinite(peak?.valueDbz)
    || !ids.includes(`${peak?.observationTimeUnixMs}:${peak?.contentSha256}`)
  ) failures.push("exact retained-frame point lookup");

  const inspection = report.inspectionRefresh;
  if (
    observationId(inspection?.initial) !== newestScrub?.receipt?.observationId
    || observationId(inspection?.oldest) !== oldestScrub?.receipt?.observationId
    || observationId(inspection?.restoredNewest) !== newestScrub?.receipt?.observationId
    || inspection?.initial?.inspectionId === inspection?.oldest?.inspectionId
    || inspection?.oldest?.inspectionId === inspection?.restoredNewest?.inspectionId
    || inspection?.initial?.longitude !== inspection?.oldest?.longitude
    || inspection?.initial?.latitude !== inspection?.oldest?.latitude
    || inspection?.oldest?.longitude !== inspection?.restoredNewest?.longitude
    || inspection?.oldest?.latitude !== inspection?.restoredNewest?.latitude
  ) failures.push("inspection refresh across observation cuts");

  const credits = report.transferSnapshot;
  if (credits?.creditLimit !== 2 || credits?.heldCredits !== 0 || credits?.inFlightCredits !== 0) failures.push("shared two-credit release");
  const failedSite = report.failedSiteRecovery;
  const restoredGeneration = failedSite?.after?.painted?.generation;
  const restoredRetained = failedSite?.history?.retained ?? [];
  if (
    failedSite?.failureMessage !== "diagnostic Site transition failure after National cancellation"
    || failedSite?.before?.painted?.source?.kind !== "national"
    || failedSite?.after?.painted?.source?.kind !== "national"
    || failedSite?.after?.transition
    || !(restoredGeneration > failedSite?.before?.painted?.generation)
    || restoredRetained.length < 1
    || restoredRetained.some((observation) => observation.generation !== restoredGeneration)
    || failedSite?.renderer?.status !== "painted"
    || failedSite?.renderer?.generation !== restoredGeneration
    || failedSite?.renderer?.paintReceipt?.generation !== restoredGeneration
    || failedSite?.transfer?.generation !== restoredGeneration
    || failedSite?.backfillStartCountAfter !== failedSite?.backfillStartCountBefore + 1
    || failedSite?.playbackBeforeFailure?.playing !== true
    || failedSite?.playbackAfterRestoration?.playing !== false
    || failedSite?.renderer?.contextEpoch !== failedSite?.rendererBeforeFailure?.contextEpoch + 1
    || failedSite?.renderer?.paintReceipt?.contextEpoch !== failedSite?.renderer?.contextEpoch
  ) failures.push("failed Site transition restores active National session");
  const site = report.restoredSite;
  if (
    site?.sourceState?.painted?.source?.kind !== "site"
    || site?.sourceState?.painted?.source?.siteIcao !== "KTLX"
    || site?.sourceState?.transition !== null
    || site?.display?.lastComplete?.site !== "KTLX"
  ) failures.push("National to Site atomic handoff");
  return failures;
}

function observationId(observation) {
  return `${observation?.observationTimeUnixMs}:${observation?.contentSha256}`;
}

function strictlyIncreasing(values) {
  return values.length > 0 && values.every((value, index) => index === 0 || value > values[index - 1]);
}

function sameMembers(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function zeroActivity(activity) {
  return activity && Object.values(activity).every((value) => value === 0);
}
