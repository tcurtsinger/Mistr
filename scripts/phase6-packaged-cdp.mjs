import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CdpClient,
  fetchJsonWithTimeout,
  openWebSocketWithTimeout,
} from "./cdp-client.mjs";
import { validatePhase6Acceptance } from "./phase6-packaged-validation.mjs";

const port = Number(process.env.MISTR_CDP_PORT ?? 9340);
const pass = Number(process.env.MISTR_PHASE6_PASS ?? 1);
const output = resolve(process.env.MISTR_PHASE6_OUTPUT ?? "artifacts/phase-6");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid CDP port");
if (!Number.isSafeInteger(pass) || pass < 1 || pass > 10) throw new Error("invalid restart pass");

await mkdir(output, { recursive: true });
const target = await waitForTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await openWebSocketWithTimeout(socket);
const client = new CdpClient(socket);

try {
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Network.enable");
  await waitForPhase6Api();
  await evaluate("window.__MISTR_PHASE4__.prepareArchive()", true, 30_000);
  await evaluate("window.__MISTR_PHASE4__.pause()");
  const windowInfo = await call("Browser.getWindowForTarget", { targetId: target.id });
  assertProtocolResult(windowInfo, "Browser.getWindowForTarget");
  const windowId = windowInfo.result.windowId;
  await setBounds(windowId, { left: 0, top: 0, width: 1_920, height: 1_080, windowState: "normal" });
  await delay(750);
  await evaluate("window.__MISTR_PHASE6__.resize()");

  const report = {
    schemaVersion: 1,
    pass,
    capturedAt: new Date().toISOString(),
    userAgent: await evaluate("navigator.userAgent"),
    initial: await evaluate("window.__MISTR_PHASE6__.report()"),
  };
  report.reflectivityContextReset = await evaluate(
    "window.__MISTR_PHASE6__.resetContext(150)", true, 30_000,
  );
  report.postRecoveryStep = await evaluate(
    "window.__MISTR_PHASE4__.step().then(receipt=>({receipt,...window.__MISTR_PHASE6__.report().renderer}))",
    true,
    10_000,
  );

  await setBounds(windowId, { windowState: "minimized" });
  await delay(1_000);
  await setBounds(windowId, { left: 0, top: 0, width: 1_920, height: 1_080, windowState: "normal" });
  await delay(750);
  report.minimizeRestore = await evaluate(
    "(async()=>{window.__MISTR_PHASE6__.resize();const receipt=await window.__MISTR_PHASE4__.step();const r=window.__MISTR_PHASE6__.report();return {receipt,selectedObservationId:r.renderer.selectedObservationId,renderer:r.renderer}})()",
    true,
    10_000,
  );

  report.sleepWake = {
    status: "MANUAL_REQUIRED",
    reason: "CDP Page freezing permanently suppresses requestAnimationFrame and is not equivalent to Windows sleep/wake",
  };

  await emulateOffline(true);
  report.offlineResidentStep = await evaluate(
    "window.__MISTR_PHASE4__.step().then(receipt=>{const r=window.__MISTR_PHASE6__.report();return {receipt,selectedObservationId:r.renderer.selectedObservationId}})",
    true,
    10_000,
  );
  await emulateOffline(false);

  report.scaleChanges = [];
  for (const deviceScaleFactor of [1, 2]) {
    assertProtocolResult(await call("Emulation.setDeviceMetricsOverride", {
      width: 1_280,
      height: 720,
      deviceScaleFactor,
      mobile: false,
    }), "Emulation.setDeviceMetricsOverride");
    await delay(250);
    const change = await evaluate(
      "(async()=>{window.__MISTR_PHASE6__.resize();const receipt=await window.__MISTR_PHASE4__.step();return {receipt,devicePixelRatio}})()",
      true,
      10_000,
    );
    change.requestedDeviceScaleFactor = deviceScaleFactor;
    report.scaleChanges.push(change);
  }
  assertProtocolResult(await call("Emulation.clearDeviceMetricsOverride"), "Emulation.clearDeviceMetricsOverride");

  report.n0s = await evaluate("window.__MISTR_PHASE6__.loadN0s()", true, 30_000);
  report.n0sContextReset = await evaluate(
    "window.__MISTR_PHASE6__.resetContext(150)", true, 30_000,
  );
  report.final = await evaluate("window.__MISTR_PHASE6__.report()");
  report.bounds = (await call("Browser.getWindowForTarget", { targetId: target.id })).result.bounds;

  const screenshot = await call("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    fromSurface: true,
  });
  assertProtocolResult(screenshot, "Page.captureScreenshot");
  const failures = validatePhase6Acceptance(report);
  report.status = failures.length === 0 ? "PASS" : "FAIL";
  report.failures = failures;
  await writeFile(resolve(output, `packaged-report-pass-${pass}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    resolve(output, `packaged-n0s-pass-${pass}.png`),
    Buffer.from(screenshot.result.data, "base64"),
  );
  console.log(JSON.stringify({ pass, status: report.status, failures }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await emulateOffline(false).catch(() => {});
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

async function emulateOffline(offline) {
  const response = await call("Network.emulateNetworkConditions", {
    offline,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  assertProtocolResult(response, "Network.emulateNetworkConditions");
}

async function setBounds(windowId, bounds) {
  const response = await call("Browser.setWindowBounds", { windowId, bounds });
  assertProtocolResult(response, "Browser.setWindowBounds");
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

async function waitForPhase6Api() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await evaluate("Boolean(window.__MISTR_PHASE6__)")) return;
    const errorText = await evaluate("document.querySelector('.radar-notice[role=alert]')?.textContent ?? null");
    if (errorText) throw new Error(`packaged app failed before Phase 6: ${errorText}`);
    await delay(250);
  }
  throw new Error("Phase 6 diagnostic API did not become ready");
}

function assertProtocolResult(response, method) {
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
