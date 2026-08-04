const TARGET_BYTES = 200 * 1024 * 1024;
const HARD_CEILING_BYTES = 256 * 1024 * 1024;

export function validateNationalPhase3Acceptance(report) {
  const failures = [];
  const overview = report.overview;
  const preparation = overview?.preparation;
  const overviewWorkingSet = overview?.workingSet;
  const overviewReceipt = overviewWorkingSet?.receipt;
  const overviewRenderer = overview?.renderer;
  if (!/^CONUS\/MergedBaseReflectivityQC_00\.50\/\d{8}\/MRMS_MergedBaseReflectivityQC_00\.50_\d{8}-\d{6}\.grib2\.gz$/.test(preparation?.objectKey ?? "")) failures.push("exact NOAA object identity");
  if (!/^[0-9a-f]{64}$/.test(preparation?.compressedSha256 ?? "")) failures.push("compressed content hash");
  if (JSON.stringify(preparation?.presentationFactors) !== JSON.stringify([1, 2, 4])) failures.push("static presentation levels");
  if (!(preparation?.compressedBytes > 0 && preparation?.retainedBackendBytes >= 49_000_000)) failures.push("bounded retained exact grid");
  if (overviewWorkingSet?.manifest?.presentationFactor !== 4 || overviewWorkingSet?.manifest?.chunks?.length !== 28) failures.push("complete overview manifest");
  if (overviewWorkingSet?.coverage?.kind !== "complete_domain" || overviewWorkingSet?.chunkCount !== 28) failures.push("complete overview coverage");
  if (overviewReceipt?.presentationFactor !== 4 || overviewReceipt?.coverageKind !== "complete_domain" || overviewReceipt?.requiredChunkCount !== 28) failures.push("overview paint receipt");
  if (overviewRenderer?.status !== "painted" || overviewRenderer?.coverageComplete !== true || overviewRenderer?.residentChunkCount !== 28) failures.push("overview renderer completion");
  if (overviewReceipt?.generation !== preparation?.generation || overviewReceipt?.observationTimeUnixMs !== preparation?.observationTimeUnixMs || overviewReceipt?.contentSha256 !== preparation?.compressedSha256) failures.push("overview identity chain");
  if (!(overviewRenderer?.gpuResourceBytes > 0 && overviewRenderer.gpuResourceBytes < TARGET_BYTES && overviewRenderer.peakGpuResourceBytes < HARD_CEILING_BYTES)) failures.push("GPU memory ceiling");
  if (!(overviewRenderer?.maximumUploadSliceMs >= 0 && overviewRenderer.maximumUploadSliceMs <= 4)) failures.push("four millisecond upload budget");

  const peak = report.peak;
  if (peak?.status !== "valid" || !Number.isFinite(peak?.valueDbz) || !Number.isInteger(peak?.rawCode)) failures.push("exact peak point lookup");
  if (peak?.generation !== overviewReceipt?.generation || peak?.observationTimeUnixMs !== overviewReceipt?.observationTimeUnixMs || peak?.contentSha256 !== overviewReceipt?.contentSha256) failures.push("point lookup painted identity");

  const detail = report.detail;
  const detailReceipt = detail?.workingSet?.receipt;
  if (detail?.workingSet?.manifest?.presentationFactor !== 1 || detail?.workingSet?.coverage?.kind !== "viewport") failures.push("exact viewport presentation");
  if (!(detail?.workingSet?.chunkCount > 0 && detail.workingSet.chunkCount < 392)) failures.push("bounded viewport chunk set");
  if (detailReceipt?.presentationFactor !== 1 || detailReceipt?.coverageKind !== "viewport" || detailReceipt?.requiredChunkCount !== detail?.workingSet?.chunkCount) failures.push("viewport paint receipt");
  if (detailReceipt?.observationId !== overviewReceipt?.observationId || detailReceipt?.generation !== overviewReceipt?.generation) failures.push("refinement identity stability");
  if (
    detail?.renderer?.residentChunkCount !== detail?.workingSet?.chunkCount + 28
    || detail?.renderer?.fallbackPresentationFactor !== 4
    || detail?.renderer?.fallbackChunkCount !== 28
    || detail?.renderer?.coverageComplete !== true
  ) failures.push("resident complete overview fallback");

  const modes = report.modeEvidence;
  if (modes?.native?.displayMode !== "native" || modes?.smooth?.displayMode !== "smooth") failures.push("Smooth and Native controls");
  if (modes?.native?.observationId !== modes?.smooth?.observationId || modes?.native?.observationTimeUnixMs !== modes?.smooth?.observationTimeUnixMs) failures.push("presentation-only mode switch");
  if (!(modes?.pixels?.changedPixels > 50 && modes?.pixels?.changedRatio > 0)) failures.push("visible Native versus Smooth rendering");

  const reset = report.contextReset;
  if (reset?.receipt?.contextEpoch !== (reset?.before?.contextEpoch ?? 0) + 1 || reset?.after?.status !== "painted") failures.push("real context recovery epoch");
  if (reset?.receipt?.observationId !== detailReceipt?.observationId || reset?.receipt?.presentationFactor !== detailReceipt?.presentationFactor || reset?.receipt?.coverageVersion !== detailReceipt?.coverageVersion) failures.push("visible-first context recovery identity");
  if (
    reset?.after?.fallbackPresentationFactor !== 4
    || reset?.after?.fallbackChunkCount !== 28
    || reset?.after?.residentChunkCount !== detail?.workingSet?.chunkCount + 28
    || !(reset?.after?.maximumUploadSliceMs <= 4)
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
