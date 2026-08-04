import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CdpClient, fetchJsonWithTimeout, openWebSocketWithTimeout } from "./cdp-client.mjs";
import { validateNationalPhase4Acceptance } from "./national-phase4-packaged-validation.mjs";

const port = Number(process.env.MISTR_CDP_PORT ?? 9344);
const output = resolve(process.env.MISTR_NATIONAL_PHASE4_OUTPUT ?? "artifacts/national-phase-4");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid CDP port");

await mkdir(output, { recursive: true });
const target = await waitForTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await openWebSocketWithTimeout(socket);
const client = new CdpClient(socket);

try {
  await call("Runtime.enable");
  await call("Page.enable");
  await waitForApi();
  const window = await call("Browser.getWindowForTarget", { targetId: target.id });
  assertProtocolResult(window, "Browser.getWindowForTarget");
  await call("Browser.setWindowBounds", {
    windowId: window.result.windowId,
    bounds: { width: 3840, height: 2160, windowState: "normal" },
  });
  await delay(500);

  const startedAt = new Date().toISOString();
  await evaluate(serialized("window.__MISTR_NATIONAL_PHASE4__.startNational()"), true, 300_000);
  const history = await evaluate(
    serialized("window.__MISTR_NATIONAL_PHASE4__.waitForHistory(20, 600000)"),
    true,
    660_000,
  );
  const historyScreenshot = await captureScreenshot();

  const transitions = await evaluate(
    serialized("window.__MISTR_NATIONAL_PHASE4__.runTransitions(1000)"),
    true,
    180_000,
  );
  const oldest = await evaluate(
    serialized("window.__MISTR_NATIONAL_PHASE4__.scrubWithEvidence(0)"),
    true,
    30_000,
  );
  const newest = await evaluate(
    serialized("window.__MISTR_NATIONAL_PHASE4__.scrubWithEvidence(19)"),
    true,
    30_000,
  );
  const peak = await evaluate(
    serialized("window.__MISTR_NATIONAL_PHASE3__.peak()"),
    true,
    60_000,
  );
  const initialInspection = await evaluate(
    serialized(`window.__MISTR_NATIONAL_PHASE4__.inspect(${peak.longitude}, ${peak.latitude})`),
    true,
    60_000,
  );
  await evaluate(serialized("window.__MISTR_NATIONAL_PHASE4__.scrub(0)"), true, 30_000);
  const refreshedOldestInspection = await evaluate(
    serialized(`window.__MISTR_NATIONAL_PHASE4__.waitForInspection(${JSON.stringify(oldest.receipt.observationId)})`),
    true,
    60_000,
  );
  await evaluate(serialized("window.__MISTR_NATIONAL_PHASE4__.scrub(19)"), true, 30_000);
  const restoredNewestInspection = await evaluate(
    serialized(`window.__MISTR_NATIONAL_PHASE4__.waitForInspection(${JSON.stringify(newest.receipt.observationId)})`),
    true,
    60_000,
  );
  const inspectionRefresh = {
    initial: initialInspection,
    oldest: refreshedOldestInspection,
    restoredNewest: restoredNewestInspection,
  };

  await evaluate(`window.__MISTR_NATIONAL_PHASE4__.setCamera(${peak.longitude}, ${peak.latitude}, 8.6)`);
  await delay(250);
  await evaluate(serialized("window.__MISTR_NATIONAL_PHASE4__.refineForCamera()"), true, 240_000);
  const detail = await waitForReport(
    "report.renderer?.presentationFactor===1 && report.renderer?.detailedObservationIds?.length>=1",
    240_000,
  );
  const detailScreenshot = await captureScreenshot();

  await evaluate("window.__MISTR_NATIONAL_PHASE4__.play()", true, 60_000);
  await delay(1_500);
  const activePlayback = await evaluate(serialized("window.__MISTR_NATIONAL_PHASE4__.report()"), true);
  await evaluate("window.__MISTR_NATIONAL_PHASE4__.pause()");

  await evaluate("window.__MISTR_NATIONAL_PHASE4__.setCamera(-98.5,39.5,4.5)");
  await delay(1_000);
  await waitForReport("report.renderer?.presentationFactor===4", 30_000);
  const contextReset = await evaluate(
    serialized("window.__MISTR_NATIONAL_PHASE4__.resetContext(150)"),
    true,
    90_000,
  );
  const transferSnapshot = await waitForReleasedTransferCredits();

  const failedSiteRecovery = await evaluate(
    serialized("window.__MISTR_NATIONAL_PHASE4__.proveFailedSiteRestoresNational('KTLX')"),
    true,
    300_000,
  );

  await evaluate(serialized("window.__MISTR_NATIONAL_PHASE4__.startSite('KTLX')"), true, 300_000);
  await delay(500);
  const restoredSite = {
    sourceState: await evaluate("(()=>{const value=window.__MISTR_NATIONAL_PHASE4__.sourceState();return {...value,transition:value?.transition??null}})()"),
    display: await evaluate("window.__MISTR_PHASE5__.report().display"),
  };

  const report = {
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    userAgent: await evaluate("navigator.userAgent"),
    history,
    transitions,
    scrub: { oldest, newest },
    peak,
    inspectionRefresh,
    detail,
    activePlayback,
    contextReset,
    transferSnapshot,
    failedSiteRecovery,
    restoredSite,
  };
  report.failures = validateNationalPhase4Acceptance(report);
  report.status = report.failures.length === 0 ? "PASS" : "FAIL";
  await writeFile(resolve(output, "packaged-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(output, "national-history-4k.png"), Buffer.from(historyScreenshot, "base64"));
  await writeFile(resolve(output, "national-detail-4k.png"), Buffer.from(detailScreenshot, "base64"));
  console.log(JSON.stringify({
    status: report.status,
    retainedCount: history?.history?.retained?.length,
    historyMinutes: ((history?.history?.retained?.at(-1)?.observationTimeUnixMs ?? 0)
      - (history?.history?.retained?.[0]?.observationTimeUnixMs ?? 0)) / 60_000,
    commonResidentCount: history?.renderer?.commonResidentObservationIds?.length,
    detailResidentCount: detail?.renderer?.detailedObservationIds?.length,
    transitions: transitions?.completedTransitions,
    hotPathActivity: transitions?.activityDelta,
    peakGpuBytes: detail?.renderer?.peakGpuResourceBytes,
    maxUploadSliceMs: detail?.renderer?.maximumUploadSliceMs,
    contextEpoch: contextReset?.receipt?.contextEpoch,
    restoredSource: restoredSite?.sourceState?.painted?.source,
    failures: report.failures,
  }, null, 2));
  if (report.failures.length > 0) process.exitCode = 1;
} finally {
  client.close();
}

function serialized(expression) {
  return `Promise.resolve(${expression}).then(value=>JSON.parse(JSON.stringify(value,(_,item)=>typeof item==='bigint'?Number(item):item)))`;
}

async function waitForReport(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let report = null;
  while (Date.now() < deadline) {
    report = await evaluate(serialized("window.__MISTR_NATIONAL_PHASE4__.report()"), true, 30_000);
    const matches = await evaluate(`(report=>${condition})(${JSON.stringify(report)})`);
    if (matches) return report;
    await delay(100);
  }
  throw new Error(`National report did not satisfy ${condition}: ${JSON.stringify(report)}`);
}

async function captureScreenshot() {
  const response = await call("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    fromSurface: true,
  }, 30_000);
  assertProtocolResult(response, "Page.captureScreenshot");
  return response.result.data;
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
    } catch {}
    await delay(250);
  }
  throw new Error(`Mistr page target did not appear on CDP port ${port}`);
}

async function waitForApi() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await evaluate("Boolean(window.__MISTR_NATIONAL_PHASE4__ && window.__MISTR_NATIONAL_PHASE3__ && window.__MISTR_PHASE5__)")) return;
    await delay(250);
  }
  throw new Error("National Phase 4 diagnostic API did not become ready");
}

async function waitForReleasedTransferCredits() {
  const deadline = Date.now() + 30_000;
  let snapshot = null;
  while (Date.now() < deadline) {
    snapshot = await evaluate("window.__MISTR_NATIONAL_PHASE4__.transferSnapshot()", true, 30_000);
    if (snapshot?.heldCredits === 0 && snapshot?.inFlightCredits === 0) return snapshot;
    await delay(100);
  }
  throw new Error(`shared transfer credits did not settle: ${JSON.stringify(snapshot)}`);
}

function assertProtocolResult(response, name) {
  if (response.error) throw new Error(`${name}: ${JSON.stringify(response.error)}`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
