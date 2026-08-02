import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CdpClient, fetchJsonWithTimeout, openWebSocketWithTimeout } from "./cdp-client.mjs";
import { validateAlphaSleepWake } from "./alpha-sleep-wake-validation.mjs";

const port = Number(process.env.MISTR_CDP_PORT ?? 9342);
const waitMinutes = Number(process.env.MISTR_SLEEP_WAKE_WAIT_MINUTES ?? 20);
const output = resolve(process.env.MISTR_SLEEP_WAKE_OUTPUT ?? "artifacts/alpha-release/sleep-wake");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid CDP port");
if (!Number.isSafeInteger(waitMinutes) || waitMinutes < 5 || waitMinutes > 60) throw new Error("wait window must be between 5 and 60 minutes");

await mkdir(output, { recursive: true });
let client = null;

try {
  await reconnectClient();
  await waitForRadar();
  await evaluate("window.__MISTR_PHASE4__.prepareArchive()", true, 30_000);
  await evaluate("window.__MISTR_PHASE4__.play()");
  await delay(2_000);
  const preSleep = await evaluate("window.__MISTR_PHASE6__.report()");
  const ready = {
    status: "READY",
    instruction: "Put Windows to sleep for at least 15 seconds, then wake it.",
    readyAtUnixMs: Date.now(),
    waitMinutes,
    preSleep,
  };
  await writeFile(resolve(output, "sleep-wake-ready.json"), `${JSON.stringify(ready, null, 2)}\n`);
  console.log("MISTR_SLEEP_WAKE_READY: Put Windows to sleep for at least 15 seconds, then wake it.");

  const deadline = Date.now() + waitMinutes * 60_000;
  let priorHeartbeat = Date.now();
  let detectedGapMs = 0;
  while (Date.now() < deadline && detectedGapMs < 10_000) {
    await delay(1_000);
    const now = Date.now();
    detectedGapMs = Math.max(detectedGapMs, now - priorHeartbeat);
    priorHeartbeat = now;
  }
  if (detectedGapMs < 10_000) throw new Error("No Windows sleep/wake heartbeat gap was detected before timeout");
  const wakeDetectedAtUnixMs = Date.now();
  await writeFile(resolve(output, "sleep-wake-gap.json"), `${JSON.stringify({
    preSleep,
    detectedGapMs,
    wakeDetectedAtUnixMs,
  }, null, 2)}\n`);
  await delay(5_000);
  // A Windows sleep can leave the pre-sleep DevTools WebSocket connected but
  // permanently unresponsive. Reconnect to the still-running WebView before
  // collecting wake evidence so the validator measures Mistr, not socket luck.
  await reconnectClient();
  await waitForRadar();
  const postWake = await evaluate("window.__MISTR_PHASE6__.report()");
  const frameCount = postWake.renderer?.residentObservationIds?.length ?? 0;
  const selectedIndex = postWake.playback?.playheadIndex ?? 0;
  const nextIndex = frameCount > 1 ? (selectedIndex + 1) % frameCount : 0;
  const postWakeScrub = await evaluate(`window.__MISTR_PHASE4__.scrub(${nextIndex})`, true, 5_000);
  const report = {
    preSleep,
    detectedGapMs,
    wakeDetectedAtUnixMs,
    postWake,
    postWakeSelectedObservationId: postWake.renderer?.residentObservationIds?.[nextIndex],
    postWakeScrub,
    completedAtUnixMs: Date.now(),
  };
  const failures = validateAlphaSleepWake(report);
  const summary = {
    status: failures.length === 0 ? "PASS" : "FAIL",
    detectedGapMs,
    contextEpochBefore: preSleep.renderer?.contextEpoch,
    contextEpochAfter: postWake.renderer?.contextEpoch,
    postWakeObservationId: postWakeScrub.observationId,
    failures,
  };
  await writeFile(resolve(output, "sleep-wake-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(output, "sleep-wake-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length > 0) process.exitCode = 1;
} finally {
  client?.close();
}

function call(method, params = {}, timeoutMs) {
  if (!client) return Promise.reject(new Error("CDP client is not connected"));
  return client.call(method, params, timeoutMs);
}

async function reconnectClient() {
  client?.close();
  client = null;
  const target = await waitForTarget();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await openWebSocketWithTimeout(socket);
  const nextClient = new CdpClient(socket, 30_000);
  client = nextClient;
  try {
    await call("Runtime.enable");
    await call("Page.enable");
  } catch (error) {
    nextClient.close();
    if (client === nextClient) client = null;
    throw error;
  }
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
    if (await evaluate("Boolean(window.__MISTR_PHASE4__ && window.__MISTR_PHASE6__)")) return;
    const errorText = await evaluate("document.querySelector('.benchmark-error')?.textContent ?? null");
    if (errorText) throw new Error(`packaged app failed before sleep/wake: ${errorText}`);
    await delay(250);
  }
  throw new Error("packaged recovery APIs did not become ready");
}

function assertProtocolResult(response, method) {
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}
