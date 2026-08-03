import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CdpClient,
  fetchJsonWithTimeout,
  openWebSocketWithTimeout,
} from "./cdp-client.mjs";

const port = Number(process.env.MISTR_CDP_PORT ?? 9342);
const output = resolve(process.env.MISTR_NATIONAL_PHASE2_OUTPUT ?? "artifacts/national-phase-2");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid CDP port");

await mkdir(output, { recursive: true });
const target = await waitForTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await openWebSocketWithTimeout(socket);
const client = new CdpClient(socket);

try {
  await call("Runtime.enable");
  await waitForApi();
  await evaluate("window.__MISTR_PHASE4__.prepareArchive()", true, 60_000);
  const startedAt = new Date().toISOString();
  const national = await evaluate("window.__MISTR_NATIONAL_PHASE2__.run()", true, 180_000);
  const restoredSite = await evaluate("window.__MISTR_PHASE4__.report()");
  const restoredDisplay = await evaluate("window.__MISTR_PHASE5__.report().display");
  const report = {
    schemaVersion: 1,
    diagnosticOnly: true,
    startedAt,
    completedAt: new Date().toISOString(),
    userAgent: await evaluate("navigator.userAgent"),
    national,
    restoredSite: {
      selectedObservationId: restoredSite.renderer?.selectedObservationId,
      generation: restoredSite.renderer?.generation,
      residentFrameCount: restoredSite.renderer?.metrics?.residentFrameCount,
      frameCount: restoredSite.frames?.count,
      sourceKind: restoredDisplay?.lastComplete?.source,
      siteIcao: restoredDisplay?.lastComplete?.site,
    },
  };
  report.failures = validate(report);
  report.status = report.failures.length === 0 ? "PASS" : "FAIL";
  await writeFile(resolve(output, "packaged-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    status: report.status,
    objectKey: national?.preparation?.objectKey,
    chunkCount: national?.transfers?.transferredChunkCount,
    thirtyFrameBytes: national?.preparation?.retentionExtension?.thirtyPlusStagingGpuBytes,
    failures: report.failures,
  }, null, 2));
  if (report.failures.length > 0) process.exitCode = 1;
} finally {
  client.close();
}

function validate(report) {
  const failures = [];
  const national = report.national;
  const preparation = national?.preparation;
  const manifest = national?.manifest;
  const transfers = national?.transfers;
  const retention = preparation?.retentionExtension;
  if (national?.schemaVersion !== 1 || national?.diagnosticOnly !== true) failures.push("diagnostic schema");
  if (!/^CONUS\/MergedBaseReflectivityQC_00\.50\/\d{8}\/MRMS_MergedBaseReflectivityQC_00\.50_\d{8}-\d{6}\.grib2\.gz$/.test(preparation?.objectKey ?? "")) failures.push("exact object key");
  if (!Number.isInteger(preparation?.acquisitionNetworkRequests) || preparation.acquisitionNetworkRequests < 31 || preparation.acquisitionNetworkRequests > 32) failures.push("bounded inventory/download request count");
  if (!(preparation?.compressedBytes > 0 && preparation.compressedBytes <= 16 * 1024 * 1024)) failures.push("compressed byte bound");
  if (preparation?.normalizedBytes !== 49_000_000) failures.push("exact normalized grid bytes");
  for (const key of ["compressedSha256", "gribSha256", "normalizedSha256"]) {
    if (!/^[0-9a-f]{64}$/.test(preparation?.[key] ?? "")) failures.push(key);
  }
  if (manifest?.width !== 1750 || manifest?.height !== 875 || manifest?.presentationFactor !== 4) failures.push("overview shape");
  if (manifest?.objectKey !== preparation?.objectKey || manifest?.contentSha256 !== preparation?.compressedSha256) failures.push("manifest acquisition identity");
  if (manifest?.chunkCount !== preparation?.chunkCount || manifest?.chunkCount !== 28) failures.push("complete chunk manifest");
  if (transfers?.manifestBytes !== preparation?.manifestBytes) failures.push("manifest transfer bytes");
  if (transfers?.transferredChunkBytes !== preparation?.chunkTransferBytes || transfers?.transferredChunkCount !== manifest?.chunkCount) failures.push("complete chunk transfer");
  if (transfers?.backpressureCode !== "credit_exhausted") failures.push("global two-credit backpressure");
  if (transfers?.finalSnapshot?.creditLimit !== 2 || transfers?.finalSnapshot?.heldCredits !== 0 || transfers?.finalSnapshot?.inFlightCredits !== 0) failures.push("credit release");
  if (
    retention?.schemaVersion !== 1
    || retention?.extensionRetainedObservations !== 30
    || retention?.measuredObservationCount !== 30
    || retention?.distinctObservationCount !== 30
    || retention?.measuredTotalChunkCount !== 840
    || retention?.allFramesWireValidated !== true
    || retention?.exactSourceObjectsRetained !== true
    || !(retention?.retainedCompressedBytes > 0 && retention.retainedCompressedBytes <= 30 * 16 * 1024 * 1024)
    || !(retention?.diagnosticMs > 0)
    || !(retention?.measuredTimelineSpanMinutes >= 40 && retention?.measuredTimelineSpanMinutes <= 90)
    || retention?.extensionWithinTarget !== true
  ) failures.push("measured 30-frame extension bound");
  if (retention?.schemaChangeRequired !== false || retention?.rendererModelChangeRequired !== false) failures.push("30-frame schema/renderer stability");
  if (!(retention?.thirtyPlusStagingGpuBytes < retention?.targetBytes && retention?.targetBytes < retention?.hardCeilingBytes)) failures.push("memory ledger");
  if (
    report.restoredSite?.residentFrameCount !== 20
    || report.restoredSite?.frameCount !== 20
    || report.restoredSite?.siteIcao !== "KTLX"
    || report.restoredSite?.sourceKind !== "nexrad_level2_archive_ii"
  ) failures.push("Site restoration after diagnostic");
  return failures;
}

function call(method, params = {}, timeoutMs) {
  return client.call(method, params, timeoutMs);
}

async function evaluate(expression, awaitPromise = false, timeoutMs) {
  const response = await call("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  }, timeoutMs);
  if (response.error) throw new Error(`${expression}: ${JSON.stringify(response.error)}`);
  if (response.result.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails));
  return response.result.result.value;
}

async function waitForTarget() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/json`);
      const page = targets.find((candidate) => candidate.type === "page");
      if (page) return page;
    } catch {
      // Packaged WebView2 is still starting.
    }
    await delay(250);
  }
  throw new Error(`Mistr page target did not appear on CDP port ${port}`);
}

async function waitForApi() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await evaluate("Boolean(window.__MISTR_NATIONAL_PHASE2__ && window.__MISTR_PHASE4__)")) return;
    const errorText = await evaluate("document.querySelector('.radar-notice[role=alert]')?.textContent ?? null");
    if (errorText) throw new Error(`packaged app failed before National Phase 2: ${errorText}`);
    await delay(250);
  }
  throw new Error("National Phase 2 diagnostic API did not become ready");
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
