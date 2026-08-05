// Native-residency contract (owner decision, 2026-08-04): every retained
// observation is one complete-domain full-resolution presentation — 392
// chunks at factor 1. There is no coarser level, no viewport refinement, and
// no fallback presentation in the product path.
const TARGET_BYTES = 1280 * 1024 * 1024;
const HARD_CEILING_BYTES = 1536 * 1024 * 1024;
const NATIVE_CHUNKS = 392;
// Individual upload slices adapt to measured throughput; a cold first slice
// may overshoot the 4 ms pacing budget, but no slice may become a long task.
const UPLOAD_SLICE_LONG_TASK_CEILING_MS = 50;

export function validateNationalPhase3Acceptance(report) {
  const failures = [];
  const overview = report.overview;
  const preparation = overview?.preparation;
  const overviewWorkingSet = overview?.workingSet;
  const overviewReceipt = overviewWorkingSet?.receipt;
  const overviewRenderer = overview?.renderer;
  if (!/^CONUS\/MergedBaseReflectivityQC_00\.50\/\d{8}\/MRMS_MergedBaseReflectivityQC_00\.50_\d{8}-\d{6}\.grib2\.gz$/.test(preparation?.objectKey ?? "")) failures.push("exact NOAA object identity");
  if (!/^[0-9a-f]{64}$/.test(preparation?.compressedSha256 ?? "")) failures.push("compressed content hash");
  if (!(preparation?.compressedBytes > 0 && preparation?.retainedBackendBytes >= 49_000_000)) failures.push("bounded retained exact grid");
  if (overviewWorkingSet?.manifest?.presentationFactor !== 1 || overviewWorkingSet?.manifest?.chunks?.length !== NATIVE_CHUNKS) failures.push("complete native manifest");
  if (overviewWorkingSet?.coverage?.kind !== "complete_domain" || overviewWorkingSet?.chunkCount !== NATIVE_CHUNKS) failures.push("complete native coverage");
  if (overviewReceipt?.presentationFactor !== 1 || overviewReceipt?.coverageKind !== "complete_domain" || overviewReceipt?.requiredChunkCount !== NATIVE_CHUNKS) failures.push("native paint receipt");
  if (overviewRenderer?.status !== "painted" || overviewRenderer?.coverageComplete !== true || overviewRenderer?.residentChunkCount !== NATIVE_CHUNKS) failures.push("native renderer completion");
  if (overviewReceipt?.generation !== preparation?.generation || overviewReceipt?.observationTimeUnixMs !== preparation?.observationTimeUnixMs || overviewReceipt?.contentSha256 !== preparation?.compressedSha256) failures.push("native identity chain");
  if (!(overviewRenderer?.gpuResourceBytes > 0 && overviewRenderer.gpuResourceBytes < TARGET_BYTES && overviewRenderer.peakGpuResourceBytes < HARD_CEILING_BYTES)) failures.push("GPU memory ceiling");
  if (!(overviewRenderer?.maximumUploadSliceMs >= 0 && overviewRenderer.maximumUploadSliceMs <= UPLOAD_SLICE_LONG_TASK_CEILING_MS)) failures.push("upload slice long-task ceiling");

  const peak = report.peak;
  if (peak?.status !== "valid" || !Number.isFinite(peak?.valueDbz) || !Number.isInteger(peak?.rawCode)) failures.push("exact peak point lookup");
  if (peak?.generation !== overviewReceipt?.generation || peak?.observationTimeUnixMs !== overviewReceipt?.observationTimeUnixMs || peak?.contentSha256 !== overviewReceipt?.contentSha256) failures.push("point lookup painted identity");

  // refineForCamera is report-only under native residency: the presentation
  // after a camera move is the same complete-domain native frame, untouched.
  const detail = report.detail;
  const detailReceipt = detail?.workingSet?.receipt;
  if (detail?.workingSet?.manifest?.presentationFactor !== 1 || detail?.workingSet?.coverage?.kind !== "complete_domain") failures.push("camera-independent native presentation");
  if (detail?.workingSet?.chunkCount !== NATIVE_CHUNKS) failures.push("complete native chunk set");
  if (detailReceipt?.presentationFactor !== 1 || detailReceipt?.coverageKind !== "complete_domain" || detailReceipt?.requiredChunkCount !== NATIVE_CHUNKS) failures.push("camera-move paint receipt stability");
  if (detailReceipt?.observationId !== overviewReceipt?.observationId || detailReceipt?.generation !== overviewReceipt?.generation) failures.push("refinement identity stability");
  if (
    detail?.renderer?.residentChunkCount !== NATIVE_CHUNKS
    || detail?.renderer?.fallbackChunkCount !== 0
    || detail?.renderer?.coverageComplete !== true
  ) failures.push("single native presentation without fallback");

  const modes = report.modeEvidence;
  if (modes?.native?.displayMode !== "native" || modes?.smooth?.displayMode !== "smooth") failures.push("Smooth and Native controls");
  if (modes?.native?.observationId !== modes?.smooth?.observationId || modes?.native?.observationTimeUnixMs !== modes?.smooth?.observationTimeUnixMs) failures.push("presentation-only mode switch");
  if (!(modes?.pixels?.changedPixels > 50 && modes?.pixels?.changedRatio > 0)) failures.push("visible Native versus Smooth rendering");

  const reset = report.contextReset;
  if (reset?.receipt?.contextEpoch !== (reset?.before?.contextEpoch ?? 0) + 1 || reset?.after?.status !== "painted") failures.push("real context recovery epoch");
  if (reset?.receipt?.observationId !== detailReceipt?.observationId || reset?.receipt?.presentationFactor !== detailReceipt?.presentationFactor || reset?.receipt?.coverageVersion !== detailReceipt?.coverageVersion) failures.push("visible-first context recovery identity");
  if (
    reset?.after?.fallbackChunkCount !== 0
    || reset?.after?.residentChunkCount !== NATIVE_CHUNKS
    || !(reset?.after?.maximumUploadSliceMs <= UPLOAD_SLICE_LONG_TASK_CEILING_MS)
  ) failures.push("time-sliced context recovery residency");

  const sourceUi = report.sourceUi;
  if (sourceUi?.paintedSource !== "national" || sourceUi?.requestedSource !== null || !/National CONUS/.test(sourceUi?.accessibleName ?? "")) failures.push("National painted source UI truth");
  if (sourceUi?.nationalChecked !== "true" || sourceUi?.siteChecked !== "false" || sourceUi?.supportingCopy !== "NATIONAL COVERS CONUS") failures.push("explicit National and Site choices");
  if (sourceUi?.overflow !== false || sourceUi?.panelWithinViewport !== true) failures.push("compact source panel overflow");
  if (sourceUi?.reducedMotion !== true || sourceUi?.forcedColors !== true || sourceUi?.focusedChoice !== "National") failures.push("source panel accessibility media and focus");

  const credits = report.transferSnapshot;
  if (credits?.creditLimit !== 2 || credits?.heldCredits !== 0 || credits?.inFlightCredits !== 0) failures.push("shared two-credit broker release");

  const site = report.restoredSite;
  if (site?.sourceState?.painted?.source?.kind !== "site" || site?.sourceState?.painted?.source?.siteIcao !== "KTLX") failures.push("National to Site painted handoff");
  if (site?.sourceState?.transition !== null || site?.ui?.paintedSource !== "site" || site?.ui?.displayedSite !== "KTLX") failures.push("Site handoff UI truth");
  if (!site?.display?.lastComplete?.observationId || site?.display?.lastComplete?.site !== "KTLX") failures.push("Site renderer restored");
  return failures;
}
