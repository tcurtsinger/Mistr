import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CdpClient, fetchJsonWithTimeout, openWebSocketWithTimeout } from "./cdp-client.mjs";
import { validatePhase5Acceptance } from "./phase5-packaged-validation.mjs";

const port = Number(process.env.MISTR_CDP_PORT ?? 9338);
const output = resolve(process.env.MISTR_PHASE5_OUTPUT ?? "artifacts/phase-5/packaged");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid CDP port");

await mkdir(output, { recursive: true });
const target = await waitForTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await openWebSocketWithTimeout(socket);
const client = new CdpClient(socket);

try {
  await call("Runtime.enable");
  await call("Page.enable");
  await waitForPhase5Api();
  await evaluate("window.__MISTR_PHASE4__.prepareArchive()", true, 30_000);
  await evaluate("window.__MISTR_PHASE4__.pause()");
  const windowInfo = await call("Browser.getWindowForTarget", { targetId: target.id });
  assertProtocolResult(windowInfo, "Browser.getWindowForTarget");
  const resize = await call("Browser.setWindowBounds", {
    windowId: windowInfo.result.windowId,
    bounds: { left: 0, top: 0, width: 3_840, height: 2_160, windowState: "normal" },
  });
  assertProtocolResult(resize, "Browser.setWindowBounds");
  await delay(1_500);

  await evaluate("window.__MISTR_PHASE4__.setDisplayMode('native')");
  const cancellation = await evaluate(`(async()=>{
    const errorCode = error => error && typeof error === "object" && "code" in error
      ? error.code
      : "unknown";
    const old = window.__MISTR_PHASE5__.acquire("KAMX", true, 60)
      .then(() => ({oldRejected:false,oldCode:"none"}))
      .catch(error => ({oldRejected:true,oldCode:errorCode(error)}));
    await new Promise(resolve => setTimeout(resolve, 1000));
    const current = await window.__MISTR_PHASE5__.acquire("KTLX", false, 180);
    const oldResult = await old;
    return {
      ...oldResult,
      currentObservationId:current.evidence?.observationId,
      currentVolumeIndex:current.evidence?.safe?.volumeIndex,
      currentVolumeStartedAtUnixMs:current.evidence?.safe?.volumeStartedAtUnixMs,
      currentFrameUploadCount:current.renderer?.metrics?.frameUploadCount,
      displayMode:current.renderer?.displayMode,
    };
  })()`, true, 240_000);
  await evaluate("window.__MISTR_PHASE4__.setDisplayMode('smooth')");
  const rolling = await evaluate(`(async()=>{
    const next = await window.__MISTR_PHASE5__.acquire("KTLX", true, 900);
    const oldest = await window.__MISTR_PHASE4__.scrub(0);
    const newest = await window.__MISTR_PHASE4__.scrub(1);
    return {
      nextObservationId:next.evidence?.observationId,
      nextVolumeIndex:next.evidence?.safe?.volumeIndex,
      nextVolumeStartedAtUnixMs:next.evidence?.safe?.volumeStartedAtUnixMs,
      history:next.history,
      renderer:next.renderer,
      oldestScrubObservationId:oldest.observationId,
      newestScrubObservationId:newest.observationId,
      displayMode:next.renderer?.displayMode,
    };
  })()`, true, 960_000);
  const report = await evaluate("window.__MISTR_PHASE5__.report()");
  const bodyText = await evaluate("document.body.innerText");
  const finalBounds = await call("Browser.getWindowForTarget", { targetId: target.id });
  assertProtocolResult(finalBounds, "Browser.getWindowForTarget");
  const screenshot = await call("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    fromSurface: true,
  });
  assertProtocolResult(screenshot, "Page.captureScreenshot");

  await writeFile(resolve(output, "packaged-report-4k.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(output, "packaged-cancellation.json"), `${JSON.stringify(cancellation, null, 2)}\n`);
  await writeFile(resolve(output, "packaged-rolling-history.json"), `${JSON.stringify(rolling, null, 2)}\n`);
  await writeFile(resolve(output, "packaged-ui-4k.txt"), `${bodyText}\n`);
  await writeFile(resolve(output, "packaged-4k.png"), Buffer.from(screenshot.result.data, "base64"));

  const failures = validatePhase5Acceptance(
    report,
    cancellation,
    rolling,
    finalBounds.result.bounds,
    bodyText,
  );
  const summary = {
    status: failures.length === 0 ? "PASS" : "FAIL",
    bounds: finalBounds.result.bounds,
    observationId: report.evidence?.observationId,
    site: report.evidence?.safe?.site,
    safeSequence: report.evidence?.safe?.safeSequence,
    rawToDecodeMs: report.evidence
      ? report.evidence.safe.decodeCompletedAtUnixMs - report.evidence.safe.safeChunkLastModifiedUnixMs
      : null,
    decodeToPaintMs: report.evidence && report.receipt
      ? report.receipt.completedAtUnixMs - report.evidence.safe.decodeCompletedAtUnixMs
      : null,
    cancellation,
    rollingHistory: {
      residentCount: rolling.history?.residentCount,
      firstObservationId: cancellation.currentObservationId,
      nextObservationId: rolling.nextObservationId,
      oldestScrubObservationId: rolling.oldestScrubObservationId,
      newestScrubObservationId: rolling.newestScrubObservationId,
    },
    failures,
  };
  await writeFile(resolve(output, "packaged-summary-4k.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length > 0) process.exitCode = 1;
} finally {
  client.close();
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
  assertProtocolResult(response, "Runtime.evaluate");
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
      // Packaged WebView is still starting.
    }
    await delay(250);
  }
  throw new Error(`Mistr page target did not appear on CDP port ${port}`);
}

async function waitForPhase5Api() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await evaluate("Boolean(window.__MISTR_PHASE4__ && window.__MISTR_PHASE5__)")) return;
    const errorText = await evaluate("document.querySelector('.radar-notice[role=alert]')?.textContent ?? null");
    if (errorText) throw new Error(`packaged app failed before residency: ${errorText}`);
    await delay(250);
  }
  throw new Error("Phase 5 diagnostic API did not become ready");
}

function assertProtocolResult(response, method) {
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}
