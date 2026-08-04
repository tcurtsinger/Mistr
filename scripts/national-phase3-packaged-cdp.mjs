import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CdpClient, fetchJsonWithTimeout, openWebSocketWithTimeout } from "./cdp-client.mjs";
import { validateNationalPhase3Acceptance } from "./national-phase3-packaged-validation.mjs";

const port = Number(process.env.MISTR_CDP_PORT ?? 9343);
const output = resolve(process.env.MISTR_NATIONAL_PHASE3_OUTPUT ?? "artifacts/national-phase-3");
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
  await call("Browser.setWindowBounds", { windowId: window.result.windowId, bounds: { width: 3840, height: 2160, windowState: "normal" } });
  await delay(500);

  const startedAt = new Date().toISOString();
  const overview = await evaluate(serialized("window.__MISTR_NATIONAL_PHASE3__.startNational()"), true, 240_000);
  await delay(500);
  const overviewScreenshot = await captureScreenshot();
  const sourceUi = await sourceUiEvidence();
  const peak = await evaluate("window.__MISTR_NATIONAL_PHASE3__.peak()", true, 30_000);

  await evaluate(`window.__MISTR_NATIONAL_PHASE3__.setCamera(${peak.longitude}, ${peak.latitude}, 8.6)`);
  await delay(500);
  const detail = await evaluate(serialized("window.__MISTR_NATIONAL_PHASE3__.refineForCamera()"), true, 180_000);
  await evaluate("window.__MISTR_NATIONAL_PHASE3__.setDisplayMode('native')");
  await delay(350);
  const native = await evaluate(serialized("window.__MISTR_NATIONAL_PHASE3__.report().renderer"), true);
  const nativePng = await captureScreenshot();
  await evaluate("window.__MISTR_NATIONAL_PHASE3__.setDisplayMode('smooth')");
  await delay(350);
  const smooth = await evaluate(serialized("window.__MISTR_NATIONAL_PHASE3__.report().renderer"), true);
  const smoothPng = await captureScreenshot();
  const pixels = await analyzeChangedPixels(nativePng, smoothPng);

  let contextReset;
  try {
    contextReset = await evaluate(serialized("window.__MISTR_NATIONAL_PHASE3__.resetContext(150)"), true, 60_000);
  } catch (error) {
    const renderer = await evaluate(serialized("window.__MISTR_NATIONAL_PHASE3__.report()?.renderer"), true, 30_000);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; renderer=${JSON.stringify(renderer)}`);
  }
  const transferSnapshot = await waitForReleasedTransferCredits();
  await evaluate(serialized("window.__MISTR_NATIONAL_PHASE3__.startSite('KTLX')"), true, 240_000);
  await delay(500);
  const restoredSite = {
    sourceState: await evaluate("(()=>{const value=window.__MISTR_NATIONAL_PHASE3__.sourceState();return {...value,transition:value?.transition??null}})()"),
    display: await evaluate("window.__MISTR_PHASE5__.report().display"),
    ui: await evaluate(`(()=>{const e=document.querySelector('[data-role="radar-source"]');return {paintedSource:e?.dataset.paintedSource,displayedSite:e?.dataset.displayedSite,requestedSource:e?.dataset.requestedSource??null}})()`),
  };

  const report = {
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    userAgent: await evaluate("navigator.userAgent"),
    overview,
    sourceUi,
    peak,
    detail,
    modeEvidence: { native, smooth, pixels },
    contextReset,
    transferSnapshot,
    restoredSite,
  };
  report.failures = validateNationalPhase3Acceptance(report);
  report.status = report.failures.length === 0 ? "PASS" : "FAIL";
  await writeFile(resolve(output, "packaged-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(output, "national-overview-4k.png"), Buffer.from(overviewScreenshot, "base64"));
  await writeFile(resolve(output, "national-native-detail-4k.png"), Buffer.from(nativePng, "base64"));
  await writeFile(resolve(output, "national-smooth-detail-4k.png"), Buffer.from(smoothPng, "base64"));
  console.log(JSON.stringify({
    status: report.status,
    objectKey: overview?.preparation?.objectKey,
    overviewChunks: overview?.workingSet?.chunkCount,
    detailChunks: detail?.workingSet?.chunkCount,
    peakDbz: peak?.valueDbz,
    maxUploadSliceMs: overview?.renderer?.maximumUploadSliceMs,
    peakGpuBytes: detail?.renderer?.peakGpuResourceBytes,
    changedPixels: pixels.changedPixels,
    contextEpoch: contextReset?.receipt?.contextEpoch,
    restoredSource: restoredSite?.sourceState?.painted?.source,
    failures: report.failures,
  }, null, 2));
  if (report.failures.length > 0) process.exitCode = 1;
} finally {
  client.close();
}

async function sourceUiEvidence() {
  await call("Emulation.setDeviceMetricsOverride", { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false });
  await call("Emulation.setEmulatedMedia", { features: [
    { name: "prefers-reduced-motion", value: "reduce" },
    { name: "forced-colors", value: "active" },
  ] });
  await delay(100);
  await evaluate("document.querySelector('[data-role=radar-source]').click()");
  await delay(100);
  const evidence = await evaluate(`(()=>{
    const source=document.querySelector('[data-role="radar-source"]');
    const panel=document.querySelector('[aria-label="Choose radar source"]');
    const choices=[...document.querySelectorAll('.source-choices [role="radio"]')];
    const rect=panel?.getBoundingClientRect();
    return {
      paintedSource:source?.dataset.paintedSource,
      requestedSource:source?.dataset.requestedSource??null,
      accessibleName:source?.getAttribute('aria-label'),
      nationalChecked:choices.find(e=>e.querySelector('strong')?.textContent==='National')?.getAttribute('aria-checked'),
      siteChecked:choices.find(e=>e.querySelector('strong')?.textContent==='Site')?.getAttribute('aria-checked'),
      supportingCopy:panel?.querySelector('.panel-header p')?.textContent?.trim(),
      overflow:document.documentElement.scrollWidth>window.innerWidth || document.documentElement.scrollHeight>window.innerHeight,
      panelWithinViewport:Boolean(rect&&rect.left>=0&&rect.top>=0&&rect.right<=window.innerWidth&&rect.bottom<=window.innerHeight),
      reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
      forcedColors:matchMedia('(forced-colors: active)').matches,
      focusedChoice:document.activeElement?.querySelector?.('strong')?.textContent??null
    };
  })()`);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await call("Emulation.setEmulatedMedia", { features: [] });
  await call("Emulation.setDeviceMetricsOverride", { width: 3840, height: 2160, deviceScaleFactor: 1, mobile: false });
  await delay(100);
  return evidence;
}

function serialized(expression) {
  return `Promise.resolve(${expression}).then(value=>JSON.parse(JSON.stringify(value,(_,item)=>typeof item==='bigint'?Number(item):item)))`;
}

async function analyzeChangedPixels(nativePng, smoothPng) {
  return evaluate(`(async()=>{
    const load=source=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('image decode failed'));image.src='data:image/png;base64,'+source});
    const [a,b]=await Promise.all([load(${JSON.stringify(nativePng)}),load(${JSON.stringify(smoothPng)})]);
    const canvas=document.createElement('canvas');canvas.width=a.width;canvas.height=a.height;
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(a,0,0);const ap=context.getImageData(0,0,a.width,a.height).data;context.clearRect(0,0,a.width,a.height);context.drawImage(b,0,0);const bp=context.getImageData(0,0,a.width,a.height).data;
    let changedPixels=0;for(let i=0;i<ap.length;i+=4){if(Math.max(Math.abs(ap[i]-bp[i]),Math.abs(ap[i+1]-bp[i+1]),Math.abs(ap[i+2]-bp[i+2]),Math.abs(ap[i+3]-bp[i+3]))>2)changedPixels++}
    return {width:a.width,height:a.height,changedPixels,changedRatio:changedPixels/(ap.length/4)};
  })()`, true, 30_000);
}

async function captureScreenshot() {
  const response = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true }, 30_000);
  assertProtocolResult(response, "Page.captureScreenshot");
  return response.result.data;
}

function call(method, params = {}, timeoutMs) { return client.call(method, params, timeoutMs); }

async function evaluate(expression, awaitPromise = false, timeoutMs) {
  const response = await call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, timeoutMs);
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
    if (await evaluate("Boolean(window.__MISTR_NATIONAL_PHASE3__ && window.__MISTR_PHASE4__ && window.__MISTR_PHASE5__)")) return;
    await delay(250);
  }
  throw new Error("National Phase 3 diagnostic API did not become ready");
}

async function waitForReleasedTransferCredits() {
  const deadline = Date.now() + 30_000;
  let snapshot = null;
  while (Date.now() < deadline) {
    snapshot = await evaluate("window.__MISTR_NATIONAL_PHASE3__.transferSnapshot()", true, 30_000);
    if (snapshot?.heldCredits === 0 && snapshot?.inFlightCredits === 0) return snapshot;
    await delay(100);
  }
  throw new Error(`shared transfer credits did not settle: ${JSON.stringify(snapshot)}`);
}

function assertProtocolResult(response, name) {
  if (response.error) throw new Error(`${name}: ${JSON.stringify(response.error)}`);
}

function delay(milliseconds) { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)); }
