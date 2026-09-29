import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CdpClient, fetchJsonWithTimeout, openWebSocketWithTimeout } from "./cdp-client.mjs";

const port = Number(process.env.MISTR_CDP_PORT ?? 9343);
const output = resolve(process.env.MISTR_INSTALLED_SMOKE_OUTPUT ?? "artifacts/alpha-release/installer/smoke");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid CDP port");

await mkdir(output, { recursive: true });
const target = await waitForTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await openWebSocketWithTimeout(socket);
const client = new CdpClient(socket, 30_000);

try {
  await call("Runtime.enable");
  await call("Page.enable");
  await evaluate("localStorage.clear(); location.reload()", false);
  await delay(1_000);
  // A fresh install opens National over the whole country; installers carry
  // no radar archives.
  await waitForFirstPaint();
  const report = await evaluate(`(()=>({
    sourceState:window.__MISTR_NATIONAL_PHASE4__.sourceState(),
    national:window.__MISTR_NATIONAL_PHASE4__.report(),
    playbackText:document.querySelector('.playback-bar')?.innerText ?? '',
    paintedSource:document.querySelector('[data-control=radar-sites]')?.dataset.paintedSource,
    frameAge:(()=>{const output=document.querySelector('.frame-age');return {
      text:output?.textContent?.trim() ?? null,
      accessibleName:output?.getAttribute('aria-label') ?? null,
      kind:output?.classList.contains('frame-age--current')?'current':output?.classList.contains('frame-age--historical')?'historical':null
    }})(),
    error:document.querySelector('[role=alert]')?.textContent?.trim() ?? null
  }))()`);
  const failures = [];
  const painted = report.sourceState?.painted?.source;
  const receipt = report.national?.renderer?.paintReceipt;
  if (painted?.kind !== "national") failures.push("installed first launch does not open National");
  if (report.national?.renderer?.status !== "painted") failures.push("installed National radar is not painted");
  if (!(receipt?.framebufferWidth > 0)) failures.push("installed National radar has no GPU paint receipt");
  if (report.paintedSource !== "national") failures.push("installed source control does not name National");
  if (report.frameAge?.kind !== "current" || !report.frameAge?.accessibleName?.startsWith("Newest National observation,")) {
    failures.push("installed first launch does not show the newest National observation as current");
  }
  if (/\b(?:FRESH|STALE|PAUSED|NEWEST)\b/i.test(report.playbackText)) failures.push("installed playback bar exposes removed status noise");
  if (report.error) failures.push(`installed first launch reports: ${report.error}`);
  const summary = {
    status: failures.length === 0 ? "PASS" : "FAIL",
    paintedSource: painted?.kind ?? null,
    frameAge: report.frameAge,
    failures,
  };
  await writeFile(resolve(output, `smoke-${port}.json`), `${JSON.stringify({ report, summary }, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length > 0) process.exitCode = 1;
} finally {
  client.close();
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
      // Installed WebView is still starting.
    }
    await delay(250);
  }
  throw new Error(`installed Mistr page did not appear on CDP port ${port}`);
}

async function waitForFirstPaint() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(`Boolean(
        window.__MISTR_NATIONAL_PHASE4__?.sourceState?.()?.painted
        && !window.__MISTR_NATIONAL_PHASE4__.sourceState().transition
      )`);
      if (ready) return;
      const errorText = await evaluate("document.querySelector('[role=alert]')?.textContent ?? null");
      if (errorText) throw new Error(`installed app failed before its first paint: ${errorText}`);
    } catch (error) {
      if (String(error).includes("failed before its first paint")) throw error;
      // Reload is still rebuilding the document and diagnostic API.
    }
    await delay(250);
  }
  throw new Error("installed first launch did not paint radar");
}

function assertProtocolResult(response, method) {
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}
