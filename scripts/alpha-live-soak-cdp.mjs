import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CdpClient, fetchJsonWithTimeout, openWebSocketWithTimeout } from "./cdp-client.mjs";
import { validateAlphaLiveSoak } from "./alpha-live-soak-validation.mjs";

const port = Number(process.env.MISTR_CDP_PORT ?? 9341);
const targetFrames = Number(process.env.MISTR_ALPHA_SOAK_FRAMES ?? 20);
const timeoutSeconds = Number(process.env.MISTR_ALPHA_SOAK_TIMEOUT_SECONDS ?? 2_700);
const output = resolve(process.env.MISTR_ALPHA_SOAK_OUTPUT ?? "artifacts/alpha-release/live-soak");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid CDP port");
if (!Number.isSafeInteger(targetFrames) || targetFrames < 4 || targetFrames > 20) throw new Error("soak target must be between 4 and 20 frames");
if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 900 || timeoutSeconds > 7_200) throw new Error("soak timeout must be between 900 and 7200 seconds");

await mkdir(output, { recursive: true });
const target = await waitForTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await openWebSocketWithTimeout(socket);
const client = new CdpClient(socket, 30_000);
const fatalErrors = [];

try {
  await call("Runtime.enable");
  await call("Page.enable");
  await waitForRadar();
  const startup = await evaluate(`(()=>{
    const phase4=window.__MISTR_PHASE4__.report();
    return {
      firstPaintMs:phase4.renderer?.paintReceipt?.completedAtUnixMs-performance.timeOrigin,
      preparedArchiveFrameCount:phase4.frames?.count,
      diskReads:phase4.activityAtResidency?.diskReads,
      bodyText:document.body.innerText
    };
  })()`);
  await evaluate("window.__MISTR_PHASE4__.prepareArchive()", true, 30_000);
  await evaluate("window.__MISTR_PHASE4__.pause()");
  const windowInfo = await call("Browser.getWindowForTarget", { targetId: target.id });
  assertProtocolResult(windowInfo, "Browser.getWindowForTarget");
  await call("Browser.setWindowBounds", {
    windowId: windowInfo.result.windowId,
    bounds: { left: 0, top: 0, width: 3_840, height: 2_160, windowState: "normal" },
  });
  await delay(1_000);

  const archiveUploads = await evaluate("window.__MISTR_PHASE4__.report().renderer.metrics.frameUploadCount");
  await selectSite("KINX");
  const pendingTruth = await waitForPendingSite("KINX");
  await selectSite("KTLX");

  const historyEvents = [];
  let lastCount = 0;
  let degradedSamples = 0;
  const startedAtUnixMs = Date.now();
  const deadline = startedAtUnixMs + timeoutSeconds * 1_000;
  while (Date.now() < deadline && lastCount < targetFrames) {
    const snapshot = await evaluate(`(()=>{
      const live=window.__MISTR_PHASE5__.report();
      const phase4=window.__MISTR_PHASE4__.report();
      return {
        displayKind:live.display?.kind,
        history:live.history,
        evidence:live.evidence,
        receipt:live.receipt,
        historyUpdate:live.historyUpdate,
        renderer:phase4.renderer,
        playback:phase4.playback,
        freshness:document.querySelector('.freshness')?.textContent?.trim(),
        topSite:document.querySelector('.context-selector strong')?.textContent?.trim(),
        error:document.querySelector('[role=alert]')?.textContent?.trim() ?? null
      };
    })()`);
    if (snapshot.error && !snapshot.error.includes("cancel")) fatalErrors.push(snapshot.error);
    if (snapshot.displayKind === "degraded") degradedSamples += 1;
    const count = snapshot.history?.residentCount ?? snapshot.renderer?.metrics?.residentFrameCount ?? 0;
    const historyEvidence = snapshot.historyUpdate?.evidence ?? snapshot.evidence;
    if (count > lastCount && historyEvidence?.safe?.site === "KTLX") {
      historyEvents.push({
        residentCount: count,
        site: historyEvidence.safe.site,
        observationId: historyEvidence.observationId,
        volumeIndex: historyEvidence.safe.volumeIndex,
        volumeStartedAtUnixMs: historyEvidence.safe.volumeStartedAtUnixMs,
        rendererGeneration: snapshot.renderer.generation,
        rendererResidentCount: snapshot.renderer.metrics?.residentFrameCount,
        frameUploadCount: snapshot.renderer.metrics?.frameUploadCount,
        capturedAtUnixMs: Date.now(),
      });
      lastCount = count;
      console.log(`Alpha live soak: ${count}/${targetFrames} resident observations`);
    }
    if (lastCount < targetFrames) await delay(2_000);
  }
  if (lastCount < targetFrames) fatalErrors.push(`soak timed out at ${lastCount}/${targetFrames} frames`);
  // Freeze the bounded resident set before scrub and context-recovery checks.
  // This cancels either the next predecessor or future-volume request without
  // changing the last authoritative GPU paint.
  await evaluate("window.__MISTR_PHASE5__.stopSession()", true, 10_000);
  await delay(100);

  const finalBeforeInteraction = await snapshotFinal();
  const residentIds = finalBeforeInteraction.renderer?.residentObservationIds ?? [];
  const oldest = await evaluate("window.__MISTR_PHASE4__.scrub(0)", true, 5_000);
  const newest = await evaluate(`window.__MISTR_PHASE4__.scrub(${Math.max(0, residentIds.length - 1)})`, true, 5_000);
  const preRecoveryFrameUploadDelta = (finalBeforeInteraction.renderer?.metrics?.frameUploadCount ?? 0) - archiveUploads;
  const recovery = await evaluate("window.__MISTR_PHASE6__.resetContext(250)", true, 30_000);
  const final = await snapshotFinal();
  const report = {
    targetFrames,
    timeoutSeconds,
    startup,
    startedAtUnixMs,
    completedAtUnixMs: Date.now(),
    siteSwitch: {
      pendingTopSite: pendingTruth.topSite,
      pendingFreshness: pendingTruth.freshness,
      finalTopSite: final.topSite,
    },
    historyEvents,
    degradedSamples,
    preRecoveryFrameUploadDelta,
    final,
    scrub: {
      oldestObservationId: oldest.observationId,
      newestObservationId: newest.observationId,
    },
    recovery,
    fatalErrors: [...new Set(fatalErrors)],
  };
  const failures = validateAlphaLiveSoak(report, targetFrames);
  const summary = {
    status: failures.length === 0 ? "PASS" : "FAIL",
    elapsedMinutes: Number(((report.completedAtUnixMs - startedAtUnixMs) / 60_000).toFixed(1)),
    targetFrames,
    observedFrames: historyEvents.length,
    volumes: historyEvents.map(event => event.volumeIndex),
    degradedSamples,
    residentGpuBytes: final.renderer?.metrics?.gpuResourceBytes,
    failures,
  };
  await writeFile(resolve(output, "soak-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(output, "soak-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length > 0) process.exitCode = 1;
} finally {
  client.close();
}

async function selectSite(site) {
  await evaluate("document.querySelector('.context-selector').click()");
  await delay(50);
  const selected = await evaluate(`(()=>{
    const button=[...document.querySelectorAll('#mistr-context-site-panel button')]
      .find(candidate=>candidate.querySelector('strong')?.textContent?.trim()===${JSON.stringify(site)});
    if(!button)return false;
    button.click();
    return true;
  })()`);
  if (!selected) throw new Error(`site ${site} was not available in the product selector`);
}

function surfaceTruth() {
  return evaluate(`(()=>({
    topSite:document.querySelector('.context-selector strong')?.textContent?.trim(),
    freshness:document.querySelector('.freshness')?.textContent?.trim()
  }))()`);
}

async function waitForPendingSite(site, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const truth = await surfaceTruth();
    if (truth.freshness === `UPDATING ${site}`) return truth;
    if (truth.topSite === site) {
      throw new Error(`${site} painted before the pending request could be superseded`);
    }
    await delay(10);
  }
  throw new Error(`pending ${site} acquisition state did not appear`);
}

function snapshotFinal() {
  return evaluate(`(()=>{
    const live=window.__MISTR_PHASE5__.report();
    const phase4=window.__MISTR_PHASE4__.report();
    return {
      history:live.history,
      evidence:live.evidence,
      receipt:live.receipt,
      publicationRenderer:live.renderer,
      historyUpdate:live.historyUpdate,
      renderer:phase4.renderer,
      playback:phase4.playback,
      topSite:document.querySelector('.context-selector strong')?.textContent?.trim(),
      freshness:document.querySelector('.freshness')?.textContent?.trim(),
      timelineText:document.querySelector('.timeline-meta')?.textContent?.replace(/\\s+/g,' ').trim(),
      bodyText:document.body.innerText
    };
  })()`);
}

function call(method, params = {}, timeoutMs) {
  return client.call(method, params, timeoutMs);
}

async function evaluate(expression, awaitPromise = false, timeoutMs) {
  const response = await call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, timeoutMs);
  assertProtocolResult(response, "Runtime.evaluate");
  if (response.result.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails));
  return response.result.result.value;
}

async function waitForTarget() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/json`);
      const page = targets.find(candidate => candidate.type === "page");
      if (page) return page;
    } catch {
      // Packaged WebView is still starting.
    }
    await delay(250);
  }
  throw new Error(`Mistr page target did not appear on CDP port ${port}`);
}

async function waitForRadar() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await evaluate("Boolean(window.__MISTR_PHASE4__ && window.__MISTR_PHASE5__ && window.__MISTR_PHASE6__)")) return;
    const errorText = await evaluate("document.querySelector('.radar-notice[role=alert]')?.textContent ?? null");
    if (errorText) throw new Error(`packaged app failed before soak: ${errorText}`);
    await delay(250);
  }
  throw new Error("packaged diagnostic APIs did not become ready");
}

function assertProtocolResult(response, method) {
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}
