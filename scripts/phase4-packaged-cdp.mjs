import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CdpClient,
  fetchJsonWithTimeout,
  openWebSocketWithTimeout,
} from "./cdp-client.mjs";
import {
  parseAcceptanceWorkload,
  phase4ScenarioTimeoutMs,
  validatePhase4Acceptance,
} from "./phase4-packaged-validation.mjs";
import { isRadarSignalPixel } from "./radar-pixel-evidence.mjs";

const port = Number(process.env.MISTR_CDP_PORT ?? 9337);
const { transitions, stabilityRuns } = parseAcceptanceWorkload();
const output = resolve(process.env.MISTR_PHASE4_OUTPUT ?? "artifacts/phase-4");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid CDP port");

await mkdir(output, { recursive: true });
const target = await waitForTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await openWebSocketWithTimeout(socket);

const client = new CdpClient(socket);

try {
  await call("Runtime.enable");
  await call("Page.enable");
  await call("HeapProfiler.enable");
  await waitForPhase4Api();
  await evaluate("window.__MISTR_PHASE4__.prepareArchive()", true, 30_000);
  await evaluate("window.__MISTR_PHASE4__.pause()");
  const windowInfo = await call("Browser.getWindowForTarget", { targetId: target.id });
  assertProtocolResult(windowInfo, "Browser.getWindowForTarget");
  const windowId = windowInfo.result.windowId;
  const resize = await call("Browser.setWindowBounds", {
    windowId,
    bounds: { left: 0, top: 0, width: 3_840, height: 2_160, windowState: "normal" },
  });
  assertProtocolResult(resize, "Browser.setWindowBounds");
  await delay(1_500);

  const scenarios = [];
  for (let run = 1; run <= stabilityRuns; run += 1) {
    const displayMode = run % 2 === 1 ? "native" : "smooth";
    await evaluate(`window.__MISTR_PHASE4__.setDisplayMode('${displayMode}')`);
    const scenario = await evaluate(
      `(async()=>{window.__MISTR_PHASE4__.pause();await new Promise(r=>setTimeout(r,750));return window.__MISTR_PHASE4__.runScenario(${transitions})})()`,
      true,
      phase4ScenarioTimeoutMs(transitions),
    );
    // Rapid synthetic camera changes can leave the public basemap's tile
    // workers finishing requests after the radar scenario itself completes.
    // Wait for MapLibre's public idle signal before claiming a stabilized heap.
    await evaluate("window.__MISTR_PHASE4__.settleMap()", true, 35_000);
    await call("HeapProfiler.collectGarbage");
    await delay(500);
    await call("HeapProfiler.collectGarbage");
    await delay(500);
    scenario.stabilizedHeapBytes = await evaluate(
      "performance.memory?.usedJSHeapSize ?? null",
    );
    scenario.displayMode = displayMode;
    scenarios.push(scenario);
  }
  const beforeModeSwitch = await evaluate("window.__MISTR_PHASE4__.report()");
  await evaluate("window.__MISTR_PHASE4__.setDisplayMode('native')");
  await delay(250);
  const nativeReport = await evaluate("window.__MISTR_PHASE4__.report()");
  await evaluate("window.__MISTR_PHASE4__.recenter()");
  await delay(500);
  const nativeCoverageScreenshot = await captureScreenshot();
  await evaluate("window.__MISTR_PHASE4__.setCamera(-97.27776, 35.333363, 8.6)");
  await delay(500);
  const nativeCloseScreenshot = await captureScreenshot();

  await evaluate("window.__MISTR_PHASE4__.setDisplayMode('smooth')");
  await delay(250);
  const smoothReport = await evaluate("window.__MISTR_PHASE4__.report()");
  const smoothCloseScreenshot = await captureScreenshot();
  await evaluate("window.__MISTR_PHASE4__.recenter()");
  await delay(500);
  const smoothCoverageScreenshot = await captureScreenshot();
  const report = await evaluate("window.__MISTR_PHASE4__.report()");
  const modeEvidence = buildModeEvidence(beforeModeSwitch, nativeReport, smoothReport);
  const bodyText = await evaluate("document.body.innerText");
  const finalBounds = await call("Browser.getWindowForTarget", { targetId: target.id });
  assertProtocolResult(finalBounds, "Browser.getWindowForTarget");

  await evaluate("window.__MISTR_PHASE4__.setCamera(-97.27776, 35.333363, 8.6)");
  await evaluate("window.__MISTR_PHASE4__.isolateRadarForEvidence()");
  await evaluate("document.querySelector('.radar-chrome').style.display='none';document.querySelector('.maplibregl-control-container').style.display='none'");
  await evaluate("window.__MISTR_PHASE4__.setDisplayMode('native')");
  await delay(300);
  const evidenceClip = { x: 1_280, y: 600, width: 1_280, height: 960, scale: 1 };
  const isolatedNativeScreenshot = await captureScreenshot(evidenceClip);
  await evaluate("window.__MISTR_PHASE4__.setDisplayMode('smooth')");
  await delay(300);
  const isolatedSmoothScreenshot = await captureScreenshot(evidenceClip);
  const pixelEvidence = await analyzeRadarPixels(
    isolatedNativeScreenshot,
    isolatedSmoothScreenshot,
  );
  await writeFile(resolve(output, "packaged-report-4k.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(output, "packaged-scenarios-4k.json"), `${JSON.stringify(scenarios, null, 2)}\n`);
  await writeFile(resolve(output, "packaged-display-modes-4k.json"), `${JSON.stringify(modeEvidence, null, 2)}\n`);
  await writeFile(resolve(output, "packaged-pixel-evidence-4k.json"), `${JSON.stringify(pixelEvidence, null, 2)}\n`);
  await writeFile(resolve(output, "packaged-ui-4k.txt"), `${bodyText}\n`);
  await writeFile(
    resolve(output, "packaged-4k.png"),
    Buffer.from(smoothCoverageScreenshot, "base64"),
  );
  await writeFile(resolve(output, "packaged-native-coverage-4k.png"), Buffer.from(nativeCoverageScreenshot, "base64"));
  await writeFile(resolve(output, "packaged-native-close-4k.png"), Buffer.from(nativeCloseScreenshot, "base64"));
  await writeFile(resolve(output, "packaged-smooth-close-4k.png"), Buffer.from(smoothCloseScreenshot, "base64"));
  await writeFile(resolve(output, "packaged-smooth-coverage-4k.png"), Buffer.from(smoothCoverageScreenshot, "base64"));
  await writeFile(resolve(output, "packaged-native-isolated-4k.png"), Buffer.from(isolatedNativeScreenshot, "base64"));
  await writeFile(resolve(output, "packaged-smooth-isolated-4k.png"), Buffer.from(isolatedSmoothScreenshot, "base64"));

  const failures = validatePhase4Acceptance(
    report,
    scenarios,
    finalBounds.result.bounds,
    transitions,
    stabilityRuns,
    modeEvidence,
    pixelEvidence,
  );
  const summary = {
    status: failures.length === 0 ? "PASS" : "FAIL",
    bounds: finalBounds.result.bounds,
    scenarios: scenarios.map((scenario) => ({
      displayMode: scenario.displayMode,
      transitions: scenario.completedTransitions,
      frameP95Ms: scenario.frameTiming.p95Ms,
      switchP50Ms: scenario.switchTiming.p50Ms,
      switchP95Ms: scenario.switchTiming.p95Ms,
      switchP99Ms: scenario.switchTiming.p99Ms,
      switchMaximumMs: scenario.switchTiming.maximumMs,
      longTaskCount: scenario.frameTiming.longTaskCount,
      longTaskObserverAvailable: scenario.frameTiming.longTaskObserverAvailable,
      hotPathActivityZero: scenario.hotPathActivityZero,
      rollingHistoryPassed: scenario.rollingHistory?.passed,
      heapBeforeBytes: scenario.heapBeforeBytes,
      heapAfterBytes: scenario.heapAfterBytes,
      stabilizedHeapBytes: scenario.stabilizedHeapBytes,
    })),
    renderer: report.renderer?.metrics,
    displayModes: modeEvidence,
    pixelEvidence,
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

async function captureScreenshot(clip) {
  const screenshot = await call("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    fromSurface: true,
    ...(clip ? { clip } : {}),
  });
  assertProtocolResult(screenshot, "Page.captureScreenshot");
  return screenshot.result.data;
}

async function analyzeRadarPixels(nativePng, smoothPng) {
  return evaluate(`(async()=>{
    const isRadarSignalPixel = ${isRadarSignalPixel.toString()};
    const load = source => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('pixel evidence image decode failed'));
      image.src = 'data:image/png;base64,' + source;
    });
    const [nativeImage, smoothImage] = await Promise.all([
      load(${JSON.stringify(nativePng)}),
      load(${JSON.stringify(smoothPng)})
    ]);
    if (nativeImage.width !== smoothImage.width || nativeImage.height !== smoothImage.height) {
      throw new Error('pixel evidence dimensions differ');
    }
    const canvas = document.createElement('canvas');
    canvas.width = nativeImage.width;
    canvas.height = nativeImage.height;
    const context = canvas.getContext('2d', {willReadFrequently:true});
    context.drawImage(nativeImage, 0, 0);
    const nativePixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(smoothImage, 0, 0);
    const smoothPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nativeSignalPixels = 0;
    let smoothSignalPixels = 0;
    let changedPixels = 0;
    let commonBackgroundPixels = 0;
    for (let index = 0; index < nativePixels.length; index += 4) {
      const nativeSignal = isRadarSignalPixel(
        nativePixels[index],
        nativePixels[index + 1],
        nativePixels[index + 2]
      );
      const smoothSignal = isRadarSignalPixel(
        smoothPixels[index],
        smoothPixels[index + 1],
        smoothPixels[index + 2]
      );
      if (nativeSignal) nativeSignalPixels += 1;
      if (smoothSignal) smoothSignalPixels += 1;
      if (!nativeSignal && !smoothSignal) commonBackgroundPixels += 1;
      if (
        Math.max(
          Math.abs(nativePixels[index] - smoothPixels[index]),
          Math.abs(nativePixels[index + 1] - smoothPixels[index + 1]),
          Math.abs(nativePixels[index + 2] - smoothPixels[index + 2])
        ) > 2
      ) changedPixels += 1;
    }
    const pixelCount = nativePixels.length / 4;
    const evidence = {
      width:canvas.width,
      height:canvas.height,
      pixelCount,
      nativeSignalPixels,
      smoothSignalPixels,
      changedPixels,
      commonBackgroundPixels,
      nativeSignalRatio:nativeSignalPixels/pixelCount,
      smoothSignalRatio:smoothSignalPixels/pixelCount,
      changedRatio:changedPixels/pixelCount,
      commonBackgroundRatio:commonBackgroundPixels/pixelCount
    };
    return {
      ...evidence,
      passed:evidence.nativeSignalRatio > 0.01
        && evidence.smoothSignalRatio > 0.01
        && evidence.changedRatio > 0.01
        && evidence.commonBackgroundRatio > 0.001
        && evidence.smoothSignalPixels > evidence.nativeSignalPixels
    };
  })()`, true, 30_000);
}

function buildModeEvidence(before, native, smooth) {
  const beforeMetrics = before.renderer?.metrics;
  const nativeMetrics = native.renderer?.metrics;
  const smoothMetrics = smooth.renderer?.metrics;
  const observationTruthUnchanged = [native, smooth].every((candidate) => (
    candidate.renderer?.observationId === before.renderer?.observationId
    && candidate.renderer?.lastPaintedObservationId === before.renderer?.lastPaintedObservationId
    && candidate.renderer?.generation === before.renderer?.generation
    && candidate.renderer?.selectionSequence === before.renderer?.selectionSequence
    && candidate.renderer?.paintReceipt?.selectionSequence
      === before.renderer?.paintReceipt?.selectionSequence
  ));
  const evidence = {
    nativeMode: native.renderer?.displayMode,
    smoothMode: smooth.renderer?.displayMode,
    nativeStatus: native.renderer?.status,
    smoothStatus: smooth.renderer?.status,
    observationTruthUnchanged,
    frameUploadCountDelta: (smoothMetrics?.frameUploadCount ?? NaN)
      - (beforeMetrics?.frameUploadCount ?? NaN),
    frameUploadBytesDelta: (smoothMetrics?.frameUploadBytes ?? NaN)
      - (beforeMetrics?.frameUploadBytes ?? NaN),
    gpuResourceBytesBefore: beforeMetrics?.gpuResourceBytes,
    gpuResourceBytesAfter: smoothMetrics?.gpuResourceBytes,
  };
  return {
    ...evidence,
    passed: evidence.nativeMode === "native"
      && evidence.smoothMode === "smooth"
      && evidence.nativeStatus === "painted"
      && evidence.smoothStatus === "painted"
      && evidence.observationTruthUnchanged
      && evidence.frameUploadCountDelta === 0
      && evidence.frameUploadBytesDelta === 0
      && evidence.gpuResourceBytesBefore === evidence.gpuResourceBytesAfter,
  };
}

async function evaluate(expression, awaitPromise = false, timeoutMs) {
  const response = await call("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  }, timeoutMs);
  assertProtocolResult(response, "Runtime.evaluate");
  if (response.result.exceptionDetails) {
    throw new Error(JSON.stringify(response.result.exceptionDetails));
  }
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
      // The packaged process and WebView2 child are still starting.
    }
    await delay(250);
  }
  throw new Error(`Mistr page target did not appear on CDP port ${port}`);
}

async function waitForPhase4Api() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const ready = await evaluate("Boolean(window.__MISTR_PHASE4__)");
    if (ready) return;
    const errorText = await evaluate(
      "document.querySelector('.radar-notice[role=alert]')?.textContent ?? null",
    );
    if (errorText) throw new Error(`packaged app failed before residency: ${errorText}`);
    await delay(250);
  }
  throw new Error("Phase 4 diagnostic API did not become ready");
}

function assertProtocolResult(response, method) {
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
