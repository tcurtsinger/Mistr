import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CdpClient } from "./cdp-client.mjs";
import {
  parseAcceptanceWorkload,
  validatePhase4Acceptance,
} from "./phase4-packaged-validation.mjs";

const port = Number(process.env.MISTR_CDP_PORT ?? 9337);
const { transitions, stabilityRuns } = parseAcceptanceWorkload();
const output = resolve(process.env.MISTR_PHASE4_OUTPUT ?? "artifacts/phase-4");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid CDP port");

await mkdir(output, { recursive: true });
const target = await waitForTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => {
  socket.onopen = resolveOpen;
  socket.onerror = rejectOpen;
});

const client = new CdpClient(socket);

try {
  await call("Runtime.enable");
  await call("Page.enable");
  await call("HeapProfiler.enable");
  await waitForPhase4Api();
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
    const scenario = await evaluate(
      `(async()=>{window.__MISTR_PHASE4__.pause();await new Promise(r=>setTimeout(r,750));return window.__MISTR_PHASE4__.runScenario(${transitions})})()`,
      true,
      60_000,
    );
    await call("HeapProfiler.collectGarbage");
    await delay(500);
    scenario.stabilizedHeapBytes = await evaluate(
      "performance.memory?.usedJSHeapSize ?? null",
    );
    scenarios.push(scenario);
  }
  const report = await evaluate("window.__MISTR_PHASE4__.report()");
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
  await writeFile(resolve(output, "packaged-scenarios-4k.json"), `${JSON.stringify(scenarios, null, 2)}\n`);
  await writeFile(resolve(output, "packaged-ui-4k.txt"), `${bodyText}\n`);
  await writeFile(
    resolve(output, "packaged-4k.png"),
    Buffer.from(screenshot.result.data, "base64"),
  );

  const failures = validatePhase4Acceptance(
    report,
    scenarios,
    finalBounds.result.bounds,
    transitions,
    stabilityRuns,
  );
  const summary = {
    status: failures.length === 0 ? "PASS" : "FAIL",
    bounds: finalBounds.result.bounds,
    scenarios: scenarios.map((scenario) => ({
      transitions: scenario.completedTransitions,
      frameP95Ms: scenario.frameTiming.p95Ms,
      longTaskCount: scenario.frameTiming.longTaskCount,
      longTaskObserverAvailable: scenario.frameTiming.longTaskObserverAvailable,
      hotPathActivityZero: scenario.hotPathActivityZero,
      heapBeforeBytes: scenario.heapBeforeBytes,
      heapAfterBytes: scenario.heapAfterBytes,
      stabilizedHeapBytes: scenario.stabilizedHeapBytes,
    })),
    renderer: report.renderer?.metrics,
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
  if (response.result.exceptionDetails) {
    throw new Error(JSON.stringify(response.result.exceptionDetails));
  }
  return response.result.result.value;
}

async function waitForTarget() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
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
      "document.querySelector('.benchmark-error')?.textContent ?? null",
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
