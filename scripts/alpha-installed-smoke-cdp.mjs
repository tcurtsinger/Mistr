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
  await waitForArchive();
  await evaluate("window.__MISTR_PHASE4__.prepareArchive()", true, 30_000);
  await evaluate("window.__MISTR_PHASE4__.pause()");
  const report = await evaluate(`(()=>({
    phase4:window.__MISTR_PHASE4__.report(),
    phase5:window.__MISTR_PHASE5__.report(),
    phase6:window.__MISTR_PHASE6__.report(),
    bodyText:document.body.innerText,
    playbackText:document.querySelector('.playback-bar')?.innerText ?? '',
    topSite:document.querySelector('[data-control=radar-sites]')?.dataset.displayedSite,
    frameAge:(()=>{const output=document.querySelector('.frame-age');return {
      text:output?.textContent?.trim() ?? null,
      accessibleName:output?.getAttribute('aria-label') ?? null,
      kind:output?.classList.contains('frame-age--current')?'current':output?.classList.contains('frame-age--historical')?'historical':null
    }})(),
    error:document.querySelector('[role=alert]')?.textContent?.trim() ?? null
  }))()`);
  const failures = [];
  if (report.phase4?.renderer?.status !== "painted") failures.push("installed radar is not painted");
  if (report.phase4?.renderer?.metrics?.residentFrameCount !== 20) failures.push("installed archive loop is not resident");
  if (report.phase4?.renderer?.paintReceipt?.framebufferWidth <= 0) failures.push("installed archive has no GPU paint receipt");
  if (report.topSite !== "KTLX") failures.push("installed first launch does not paint KTLX");
  if (report.phase6?.sourceKind !== "nexrad_level2_archive_ii") failures.push("installed first launch does not preserve archive source truth");
  if (report.frameAge?.kind !== "historical") failures.push("installed archive age is not historical");
  if (!report.frameAge?.accessibleName?.startsWith("Historical scan,")) failures.push("installed archive age lacks non-color historical semantics");
  if (/\b(?:FRESH|STALE|PAUSED|NEWEST)\b/i.test(report.playbackText)) failures.push("installed playback bar exposes removed status noise");
  if (report.error) failures.push(`installed first launch reports: ${report.error}`);
  const summary = {
    status: failures.length === 0 ? "PASS" : "FAIL",
    residentFrameCount: report.phase4?.renderer?.metrics?.residentFrameCount,
    topSite: report.topSite,
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

async function waitForArchive() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(`Boolean(
        window.__MISTR_PHASE4__
        && window.__MISTR_PHASE6__
        && window.__MISTR_PHASE4__.report()?.renderer?.status === 'painted'
      )`);
      if (ready) return;
      const errorText = await evaluate("document.querySelector('[role=alert]')?.textContent ?? null");
      if (errorText) throw new Error(`installed app failed before archive residency: ${errorText}`);
    } catch (error) {
      if (String(error).includes("failed before archive")) throw error;
      // Reload is still rebuilding the document and diagnostic API.
    }
    await delay(250);
  }
  throw new Error("installed first launch did not establish the archive loop");
}

function assertProtocolResult(response, method) {
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}
