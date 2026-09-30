// Native-residency contract (owner decision, 2026-08-04): all 60 retained
// observations are GPU-resident at the exact factor-1 grid; receipts carry
// the native manifest factor, and no detail/fallback level exists.
const TARGET_BYTES = 3328 * 1024 * 1024;
const HARD_CEILING_BYTES = 3584 * 1024 * 1024;
// Slices adapt to measured throughput; cold-start overshoot of the 4 ms
// pacing budget is tolerated, long tasks are not.
const UPLOAD_SLICE_LONG_TASK_CEILING_MS = 50;

export function validateNationalPhase4Acceptance(report) {
  const failures = [];
  failures.push(...validateNationalPartialPlaybackChrome(report.partialPlaybackChrome));
  const partialControls = report.partialHistoryControls;
  if (
    !(partialControls?.partialSampleCount > 0)
    || partialControls?.buttonFoundSampleCount !== partialControls?.partialSampleCount
    || !(partialControls?.stableStagingSampleCount > 0)
    || partialControls?.enabledStableStagingSampleCount !== partialControls?.stableStagingSampleCount
    || !sameMembers(
      partialControls?.enabledStableStagingRetainedCounts ?? [],
      partialControls?.stableStagingRetainedCounts ?? [],
    )
  ) failures.push("partial-history playback control availability");
  const history = report.history?.history;
  const renderer = report.history?.renderer;
  const playback = report.history?.playback;
  const retained = history?.retained ?? [];
  const ids = retained.map(observationId);
  const times = retained.map((observation) => observation.observationTimeUnixMs);

  if (history?.historyLimit !== 60 || retained.length !== 60) failures.push("60 retained observations");
  if (!strictlyIncreasing(times) || new Set(ids).size !== 60) failures.push("chronological unique history");
  if (!(times.at(-1) - times[0] >= 100 * 60_000)) failures.push("approximately two-hour history span");
  if (
    history?.staged !== null
    || history?.mutationReversible !== false
    || history?.reversibleCommitBytes !== 0
    || !(history?.totalBackendBytes > 0 && history.totalBackendBytes <= history.backendTargetBytes)
  ) failures.push("bounded finalized backend history");
  if (
    renderer?.status !== "painted"
    || renderer?.mutationAwaitingCommit !== false
    || renderer?.commonResidentObservationIds?.length !== 60
    || !sameMembers(renderer?.commonResidentObservationIds ?? [], ids)
  ) failures.push("all-frame common GPU residency");
  if (!(renderer?.gpuResourceBytes > 0 && renderer.gpuResourceBytes < TARGET_BYTES && renderer.peakGpuResourceBytes < HARD_CEILING_BYTES)) failures.push("National GPU memory budget");
  if (!(renderer?.maximumUploadSliceMs > 0 && renderer.maximumUploadSliceMs <= UPLOAD_SLICE_LONG_TASK_CEILING_MS)) failures.push("upload slice long-task ceiling");
  if (playback?.residentCount !== 60 || !ids.includes(playback?.selectedObservationId)) failures.push("60-frame playback timeline");

  const transitions = report.transitions;
  if (transitions?.requestedTransitions !== 1_000 || transitions?.completedTransitions !== 1_000) failures.push("1000 resident transitions");
  if (!zeroActivity(transitions?.activityDelta)) failures.push("zero hot-path backend activity");
  if (
    transitions?.rendererBefore?.uploadCount !== transitions?.rendererAfter?.uploadCount
    || transitions?.rendererBefore?.uploadBytes !== transitions?.rendererAfter?.uploadBytes
  ) failures.push("zero hot-path upload activity");
  if (
    transitions?.receipts?.length !== 1_000
    || transitions.receipts.some((receipt) => receipt.presentationFactor !== 1 || !ids.includes(receipt.observationId))
  ) failures.push("native transition receipts");

  const oldestScrub = report.scrub?.oldest;
  const newestScrub = report.scrub?.newest;
  if (
    oldestScrub?.receipt?.observationId !== ids[0]
    || newestScrub?.receipt?.observationId !== ids.at(-1)
    || oldestScrub?.receipt?.presentationFactor !== 1
    || newestScrub?.receipt?.presentationFactor !== 1
    || !zeroActivity(oldestScrub?.activityDelta)
    || !zeroActivity(newestScrub?.activityDelta)
  ) failures.push("direct resident scrub receipts");

  const detail = report.detail?.renderer;
  if (
    detail?.presentationFactor !== 1
    || detail?.fallbackChunkCount !== 0
    || detail?.commonResidentObservationIds?.length !== 60
    || detail?.detailedObservationIds?.length !== 0
    || detail?.mutationAwaitingCommit !== false
  ) failures.push("camera-independent native residency");

  const active = report.activePlayback;
  if (
    active?.playback?.playing !== true
    || active?.playback?.qualityLockFactor !== 4
    || active?.renderer?.playbackQualityFactor !== 4
    || active?.renderer?.presentationFactor !== 1
    || active?.renderer?.detailedObservationIds?.length !== 0
    || !(active?.renderer?.gpuResourceBytes > 0 && active.renderer.gpuResourceBytes < TARGET_BYTES)
    || !(active?.renderer?.peakGpuResourceBytes < HARD_CEILING_BYTES)
  ) failures.push("high-zoom native playback");
  if (
    !sameSharpPlaybackActivity(active?.activityBefore, active?.activityAfter)
    || active?.rendererBefore?.uploadCount !== active?.rendererAfter?.uploadCount
    || active?.rendererBefore?.uploadBytes !== active?.rendererAfter?.uploadBytes
  ) failures.push("zero sharp-playback transfer and upload work");
  if (
    active?.inspectionQueue?.maxConcurrentCount !== 1
    || !(active?.inspectionQueue?.startedCount > 0)
    || active?.inspectionQueueAfterPlayback?.running !== false
    || active?.inspectionQueueAfterPlayback?.pending !== false
    || active?.inspectionQueueAfterPlayback?.maxConcurrentCount !== 1
    || active?.inspectionQueueAfterPlayback?.startedCount
      !== active?.inspectionQueueAfterPlayback?.completedCount
  ) failures.push("latest-only inspection lookup queue");

  const reset = report.contextReset;
  if (
    reset?.receipt?.contextEpoch !== (reset?.before?.contextEpoch ?? 0) + 1
    || reset?.after?.status !== "painted"
    || reset?.after?.commonResidentObservationIds?.length !== 60
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
  const keptGeneration = failedSite?.before?.painted?.generation;
  const keptRetained = failedSite?.history?.retained ?? [];
  if (
    failedSite?.failureMessage !== "diagnostic Site transition failure after the Site lane began"
    || failedSite?.before?.painted?.source?.kind !== "national"
    || failedSite?.after?.painted?.source?.kind !== "national"
    || failedSite?.after?.transition
    || !(keptGeneration > 0)
    || failedSite?.after?.painted?.generation !== keptGeneration
    || keptRetained.length < 1
    || keptRetained.some((observation) => observation.generation !== keptGeneration)
    || failedSite?.renderer?.status !== "painted"
    || failedSite?.renderer?.generation !== keptGeneration
    || failedSite?.renderer?.paintReceipt?.generation !== keptGeneration
    || failedSite?.transfer?.lanes?.national?.generation !== keptGeneration
    || failedSite?.transfer?.lanes?.national?.active !== true
    || failedSite?.backfillStartCountAfter !== failedSite?.backfillStartCountBefore
    || failedSite?.playbackBeforeFailure?.playing !== true
    || failedSite?.playbackAfterRestoration?.playing !== true
    || failedSite?.renderer?.contextEpoch !== failedSite?.rendererBeforeFailure?.contextEpoch
  ) failures.push("failed Site transition keeps the active National session");
  failures.push(...validateResidentHandoff(report.residentHandoff));
  failures.push(...validateZoomHandoff(report.zoomHandoff));
  failures.push(...validateLatestIntent(report.latestIntent));
  failures.push(...validateAbandonedNationalLoad(report.abandonedNationalLoad));
  failures.push(...validateTimeCarry(report.timeCarry));
  failures.push(...validateBackfillFreshness(report.history?.backfillFreshness));
  failures.push(...validateSiteInspection(report.siteInspection));
  const site = report.restoredSite;
  if (
    site?.sourceState?.painted?.source?.kind !== "site"
    || site?.sourceState?.painted?.source?.siteIcao !== "KTLX"
    || site?.sourceState?.transition !== null
    || site?.display?.lastComplete?.site !== "KTLX"
  ) failures.push("National to Site atomic handoff");
  return failures;
}

// Switching National -> Site -> National keeps the same National history alive
// and reveals it without any acquisition, decode, or bulk transfer.
export function validateResidentHandoff(handoff) {
  const failures = [];
  const generation = handoff?.nationalGenerationBefore;
  const whileSite = handoff?.whileSite;
  if (
    !(generation > 0)
    || whileSite?.sourceState?.painted?.source?.kind !== "site"
    || whileSite?.resident !== true
    || whileSite?.renderer?.visibility !== "resident"
    || whileSite?.renderer?.paintReceipt !== undefined
    || whileSite?.transfer?.lanes?.national?.active !== true
    || whileSite?.transfer?.lanes?.national?.generation !== generation
  ) failures.push("National stays resident while the Site is displayed");
  const retained = handoff?.history?.retained ?? [];
  if (
    handoff?.after?.painted?.source?.kind !== "national"
    || handoff?.after?.painted?.generation !== generation
    || handoff?.after?.transition
    || handoff?.renderer?.status !== "painted"
    || handoff?.renderer?.visibility !== "visible"
    || handoff?.renderer?.paintReceipt?.presented !== true
    || handoff?.renderer?.paintReceipt?.generation !== generation
    || handoff?.backfillStartCountAfter !== handoff?.backfillStartCountBefore
    || retained.length < handoff?.retainedBefore
    || retained.some((observation) => observation.generation !== generation)
    || handoff?.siteLayerRemoved !== true
  ) failures.push("resident National reveals under its original generation");
  const before = handoff?.reveal?.activityBefore;
  const after = handoff?.reveal?.activityAfter;
  const quiet = before && after && [
    "networkRequests",
    "responseBytes",
    "decoderRuns",
    "bulkIpcTransfers",
    "bulkIpcBytes",
  ].every((field) => Number.isSafeInteger(before[field]) && after[field] === before[field]);
  if (!quiet) failures.push("National reveal performs no acquisition, decode, or bulk transfer");
  // The switch deliberately includes the Site fade-out; the reveal itself stays within 250 ms.
  const fadeMs = handoff?.reveal?.fadeMs ?? 0;
  if (!(handoff?.reveal?.revealMs >= 0 && fadeMs >= 0 && handoff.reveal.revealMs <= 250 + fadeMs)) {
    failures.push("National reveal completes within 250 ms plus the fade");
  }
  return failures;
}

function sameCamera(left, right) {
  return Boolean(left && right)
    && Math.abs(left.longitude - right.longitude) < 1e-6
    && Math.abs(left.latitude - right.latitude) < 1e-6
    && Math.abs(left.zoom - right.zoom) < 1e-6;
}

// Zooming in past the threshold fades the preloaded Site in over resident
// National; zooming out fades back to that same National history. Neither
// switch moves the camera.
const MINUTE_MS = 60_000;

// Largest gap between adjacent frame times, the tolerance for "nearest".
function largestGapMs(times) {
  let gap = 0;
  for (let index = 1; index < times.length; index += 1) gap = Math.max(gap, times[index] - times[index - 1]);
  return gap;
}

// A switch keeps playback time: each side lands on its frame nearest the
// other's time (paused) or keeps the loop running (playing).
export function validateTimeCarry(carry) {
  const failures = [];
  const site = carry?.paused?.site;
  const siteTimes = site?.times ?? [];
  const covered = siteTimes.length > 0 && siteTimes[0] <= site?.targetUnixMs;
  if (
    !(siteTimes.length > 0)
    || site?.playing !== false
    || site?.selectedIndex < 0
    || site?.selectedIndex !== site?.expectedIndex
    || (covered && !(Math.abs(site.playheadUnixMs - site.targetUnixMs) <= Math.max(largestGapMs(siteTimes), 11 * MINUTE_MS)))
  ) failures.push("a Site opened from paused National lands on its scan nearest the paused time");
  const national = carry?.paused?.national;
  const nationalTarget = national?.ids?.[national?.expectedIndex];
  if (
    national?.playing !== false
    || !(national?.expectedIndex >= 0)
    || national?.selectedIndex !== national?.expectedIndex
    || national?.revealReceiptObservationId !== nationalTarget
    || !(Math.abs(national.playheadUnixMs - national.targetUnixMs) <= 1.5 * MINUTE_MS)
  ) failures.push("National revealed from a paused Site reappears on its frame nearest the Site's time");
  if (carry?.playing?.site?.playing !== true || !(carry?.playing?.site?.frames >= 2)) {
    failures.push("a Site opened from playing National keeps the loop playing");
  }
  if (carry?.playing?.national?.playing !== true) {
    failures.push("National revealed from a playing Site keeps the loop playing");
  }
  return failures;
}

// Newer observations are checked while history fills. A backfill longer than
// the 30-second check interval (plus margin) must have checked at least once.
export function validateBackfillFreshness(freshness) {
  const durationMs = freshness?.completedAtUnixMs - freshness?.startedAtUnixMs;
  if (!(freshness?.startedAtUnixMs > 0) || !(freshness?.completedAtUnixMs >= freshness.startedAtUnixMs)) {
    return ["National history backfill reports its newer-observation checks"];
  }
  if (durationMs > 35_000 && !(freshness.checks >= 1)) {
    return ["National history backfill checks for newer observations while it fills"];
  }
  return [];
}

// A Site opened from National re-inspects the pinned point on every scan it paints.
export function validateSiteInspection(inspection) {
  const steps = inspection?.steps ?? [];
  const followsScan = steps.length === 2
    && new Set(steps.map((step) => step.paintedObservationId)).size === 2
    && steps.every((step) => step.paintedObservationId && step.inspectedObservationId === step.paintedObservationId);
  return followsScan ? [] : ["a Site opened from National inspects the scan it painted"];
}

// A Site download the view no longer calls for is abandoned within seconds
// rather than waited out, while National stays displayed.
export function validateLatestIntent(intent) {
  const failures = [];
  const site = intent?.site;
  const heldOpen = (inFlight) => Boolean(site)
    && inFlight?.switchInFlight?.target?.siteIcao === site
    && inFlight?.switchInFlight?.abandoned === false
    && inFlight?.painted === "national"
    && inFlight?.siteLaneActive === true;
  const zoomOut = intent?.zoomOut;
  if (
    !site
    || !heldOpen(zoomOut?.inFlight)
    || !(zoomOut?.settledMs >= 0 && zoomOut.settledMs <= 5_000)
    || zoomOut?.painted !== "national"
    || zoomOut?.siteLaneActive !== false
    || zoomOut?.siteLayerPresent !== false
  ) failures.push("zooming out during a slow Site download abandons it within seconds");
  const pan = intent?.pan;
  if (
    !heldOpen(pan?.inFlight)
    || !intent?.nextSite
    || pan?.painted !== intent.nextSite
    || !(pan?.switchMs >= 0)
    || (intent?.sources ?? []).includes(site)
    || !(intent?.abandoned >= 2)
  ) failures.push("panning to another Site during a slow download switches to that Site instead");
  return failures;
}

// Zooming back in during a fresh National load abandons it within seconds:
// the Site stays shown, the National lane is released, and Site updates
// resume on their own lane.
export function validateAbandonedNationalLoad(load) {
  const inFlight = load?.inFlight;
  const heldOpen = Boolean(load?.site)
    && inFlight?.switchInFlight?.target?.kind === "national"
    && inFlight?.switchInFlight?.abandoned === false
    && inFlight?.painted === load.site
    && inFlight?.nationalLaneActive === true;
  const passed = heldOpen
    && load?.settledMs >= 0 && load.settledMs <= 5_000
    && load?.painted === load.site
    && load?.nationalLaneActive === false
    && load?.siteUpdatesResumedMs >= 0
    && load?.siteOpacity === 1;
  return passed ? [] : ["zooming back in during a fresh National load keeps the Site updating"];
}

export function validateZoomHandoff(handoff) {
  const failures = [];
  const site = handoff?.site;
  const preloaded = handoff?.preloaded;
  const afterSite = handoff?.afterSite;
  const fadeMs = handoff?.fadeMs ?? 0;
  if (
    !site
    || preloaded?.site !== site
    || afterSite?.sourceState?.painted?.source?.kind !== "site"
    || afterSite?.sourceState?.painted?.source?.siteIcao !== site
    || afterSite?.sourceState?.painted?.generation !== preloaded?.generation
    || afterSite?.siteOpacity !== 1
    || afterSite?.nationalRenderer?.visibility !== "resident"
    || !sameCamera(afterSite?.camera, afterSite?.cameraSet)
    || !(handoff?.siteSwitchMs >= 0 && handoff.siteSwitchMs <= 1_500 + fadeMs)
  ) failures.push("zooming in fades the preloaded Site in without moving the camera");
  const hop = handoff?.afterHop;
  const hopSources = hop?.sources ?? [];
  if (
    !hop?.site
    || hop.site === site
    || hop?.sourceState?.painted?.source?.kind !== "site"
    || hop?.sourceState?.painted?.source?.siteIcao !== hop.site
    || hop?.sourceState?.transition
    || hopSources.join(">") !== `${site}>national>${hop.site}`
    || hop?.siteOpacity !== 1
    || hop?.nationalRenderer?.visibility !== "resident"
    || !sameCamera(hop?.camera, hop?.cameraSet)
    || !(hop?.switchMs >= 0)
  ) failures.push("panning into another Site's coverage fades through National to that Site");
  const afterNational = handoff?.afterNational;
  if (
    afterNational?.sourceState?.painted?.source?.kind !== "national"
    || afterNational?.sourceState?.painted?.generation !== handoff?.nationalGenerationBefore
    || afterNational?.siteLayerPresent !== false
    || afterNational?.nationalRenderer?.visibility !== "visible"
    || !sameCamera(afterNational?.camera, afterNational?.cameraSet)
    || !(handoff?.nationalSwitchMs >= 0 && handoff.nationalSwitchMs <= 750 + fadeMs)
  ) failures.push("zooming out fades back to the resident National without moving the camera");
  return failures;
}

export function validateNationalPartialPlaybackChrome(chrome) {
  const failures = [];
  if (!stablePlaybackChrome(chrome)) failures.push("stable partial-history playback chrome");
  if (chrome?.compactViewports !== undefined) {
    const expected = [[878, 640], [720, 540]];
    if (
      !Array.isArray(chrome.compactViewports)
      || chrome.compactViewports.length !== expected.length
      || chrome.compactViewports.some((viewport, index) => (
        viewport?.innerWidth !== expected[index][0]
        || viewport?.innerHeight !== expected[index][1]
        || !stablePlaybackChrome(viewport)
      ))
    ) failures.push("stable compact partial-history playback chrome");
  }
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

function stableRect(maxDelta) {
  return Number.isFinite(maxDelta) && maxDelta <= 0.25;
}

function stablePlaybackChrome(chrome) {
  return chrome?.sampleCount >= 30
    && chrome.playingSampleCount === chrome.sampleCount
    && chrome.partialHistorySampleCount === chrome.sampleCount
    && chrome.loadingNoticeSampleCount > 0
    && chrome.buttonDisabledSampleCount === 0
    && chrome.falseOutsideCoverageSampleCount === 0
    && chrome.pendingSampleCount > 0
    && chrome.pendingPresentationMismatchCount === 0
    && chrome.distinctSampleTexts?.includes("--.- dBZ")
    && chrome.distinctSampleTexts.some((label) => /^-?\d+\.\d dBZ$/.test(label))
    && stableRect(chrome.playbackBarMaxRectDelta)
    && stableRect(chrome.timelineMaxRectDelta)
    && stableRect(chrome.telemetryMaxRectDelta)
    && stableRect(chrome.sampleReadoutMaxRectDelta)
    && chrome.distinctAnnouncements?.length === 1
    && ["", "Playing"].includes(chrome.distinctAnnouncements[0]);
}

function zeroActivity(activity) {
  return activity && Object.values(activity).every((value) => value === 0);
}

function sameSharpPlaybackActivity(before, after) {
  const forbiddenHotPathFields = [
    "networkRequests",
    "responseBytes",
    "decoderRuns",
    "bulkIpcTransfers",
    "bulkIpcBytes",
  ];
  return before
    && after
    && forbiddenHotPathFields.every((key) => after[key] === before[key]);
}
