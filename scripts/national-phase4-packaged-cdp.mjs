import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CdpClient, fetchJsonWithTimeout, openWebSocketWithTimeout } from "./cdp-client.mjs";
import {
  validateNationalPartialPlaybackChrome,
  validateNationalPhase4Acceptance,
} from "./national-phase4-packaged-validation.mjs";

const port = Number(process.env.MISTR_CDP_PORT ?? 9344);
const output = resolve(process.env.MISTR_NATIONAL_PHASE4_OUTPUT ?? "artifacts/national-phase-4");
const chromeOnly = process.env.MISTR_NATIONAL_CHROME_ONLY === "1";
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid CDP port");

await mkdir(output, { recursive: true });
const target = await waitForTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await openWebSocketWithTimeout(socket);
const client = new CdpClient(socket);
let residentEvidenceHeld = false;

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
  await evaluate(
    serialized("window.__MISTR_NATIONAL_PHASE4__.waitForHistory(4, 600000)"),
    true,
    660_000,
  );
  const partialPeak = await evaluate(
    serialized("window.__MISTR_NATIONAL_PHASE3__.peak()"),
    true,
    60_000,
  );
  await evaluate(
    serialized(`window.__MISTR_NATIONAL_PHASE4__.inspect(${partialPeak.longitude}, ${partialPeak.latitude})`),
    true,
    60_000,
  );
  await evaluate("window.__MISTR_NATIONAL_PHASE4__.play()", true, 60_000);
  await waitForReport(
    "report.playback?.playing===true && report.history?.retained?.length>=4 && report.history.retained.length<20",
    60_000,
  );
  let partialPlaybackChrome = await observePlaybackChrome(1_500);
  const partialPlaybackScreenshot = await captureScreenshot();
  const compactScreenshots = [];
  if (chromeOnly) {
    const compactViewports = [];
    for (const [width, height] of [[878, 640], [720, 540]]) {
      await call("Browser.setWindowBounds", {
        windowId: window.result.windowId,
        bounds: { width, height, windowState: "normal" },
      });
      await delay(300);
      compactViewports.push(await observePlaybackChrome(750));
      compactScreenshots.push({ width, data: await captureScreenshot() });
    }
    partialPlaybackChrome = { ...partialPlaybackChrome, compactViewports };
  }
  const partialPlaybackFailures = validateNationalPartialPlaybackChrome(partialPlaybackChrome);
  const partialPlaybackReport = {
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    userAgent: await evaluate("navigator.userAgent"),
    partialPlaybackChrome,
    failures: partialPlaybackFailures,
    status: partialPlaybackFailures.length === 0 ? "PASS" : "FAIL",
  };
  await writeFile(
    resolve(output, "partial-playback-chrome-report.json"),
    `${JSON.stringify(partialPlaybackReport, null, 2)}\n`,
  );
  await writeFile(
    resolve(output, "national-partial-playback-chrome-4k.png"),
    Buffer.from(partialPlaybackScreenshot, "base64"),
  );
  for (const screenshot of compactScreenshots) {
    await writeFile(
      resolve(output, `national-partial-playback-chrome-${screenshot.width}.png`),
      Buffer.from(screenshot.data, "base64"),
    );
  }
  if (chromeOnly) {
    console.log(JSON.stringify(partialPlaybackReport, null, 2));
    if (partialPlaybackFailures.length > 0) process.exitCode = 1;
  } else {
  await evaluate("window.__MISTR_NATIONAL_PHASE4__.pause()");
  await evaluate(
    serialized("window.__MISTR_NATIONAL_PHASE4__.waitForInspectionIdle()"),
    true,
    60_000,
  );
  const partialHistoryControls = await observePartialHistoryControls();
  await evaluate(
    "window.__MISTR_NATIONAL_PHASE4__.beginResidentEvidence()",
    true,
    300_000,
  );
  residentEvidenceHeld = true;
  const history = await evaluate(
    serialized("window.__MISTR_NATIONAL_PHASE4__.report()"),
    true,
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
  await evaluate("window.__MISTR_NATIONAL_PHASE4__.endResidentEvidence()");
  residentEvidenceHeld = false;

  await evaluate(`window.__MISTR_NATIONAL_PHASE4__.setCamera(${peak.longitude}, ${peak.latitude}, 8.6)`);
  await delay(250);
  await evaluate(serialized("window.__MISTR_NATIONAL_PHASE4__.refineForCamera()"), true, 240_000);
  const detail = await waitForReport(
    "report.renderer?.status==='painted' && report.renderer?.presentationFactor===1 && report.renderer?.detailedObservationIds?.length===0",
    240_000,
  );
  const detailScreenshot = await captureScreenshot();

  await evaluate("window.__MISTR_NATIONAL_PHASE4__.play()", true, 300_000);
  await waitForReport(
    "report.playback?.playing===true && report.renderer?.presentationFactor===1",
    60_000,
  );
  const playbackActivityBefore = await evaluate(
    "window.__MISTR_NATIONAL_PHASE4__.activity()",
    true,
    30_000,
  );
  const playbackRendererBefore = await evaluate(
    serialized("window.__MISTR_NATIONAL_PHASE4__.report().renderer"),
    true,
  );
  await delay(1_500);
  const activePlaybackDuring = await evaluate(
    serialized("window.__MISTR_NATIONAL_PHASE4__.report()"),
    true,
  );
  const activePlaybackScreenshot = await captureScreenshot();
  const playbackActivityAfter = await evaluate(
    "window.__MISTR_NATIONAL_PHASE4__.activity()",
    true,
    30_000,
  );
  const playbackRendererAfter = activePlaybackDuring.renderer;
  await evaluate("window.__MISTR_NATIONAL_PHASE4__.pause()");
  const inspectionQueueAfterPlayback = await evaluate(
    serialized("window.__MISTR_NATIONAL_PHASE4__.waitForInspectionIdle()"),
    true,
    60_000,
  );
  const activePlayback = {
    ...activePlaybackDuring,
    activityBefore: playbackActivityBefore,
    activityAfter: playbackActivityAfter,
    rendererBefore: playbackRendererBefore,
    rendererAfter: playbackRendererAfter,
    inspectionQueueAfterPlayback,
  };

  await evaluate("window.__MISTR_NATIONAL_PHASE4__.setCamera(-98.5,39.5,4.5)");
  await delay(1_000);
  await waitForReport("report.renderer?.presentationFactor===1", 30_000);
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
    partialPlaybackChrome,
    partialHistoryControls,
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
  await writeFile(resolve(output, "national-playback-detail-4k.png"), Buffer.from(activePlaybackScreenshot, "base64"));
  console.log(JSON.stringify({
    status: report.status,
    retainedCount: history?.history?.retained?.length,
    partialPlaybackBarMaxRectDelta: partialPlaybackChrome?.playbackBarMaxRectDelta,
    partialHistoryEnabledStagingSamples: partialHistoryControls?.enabledStableStagingSampleCount,
    historyMinutes: ((history?.history?.retained?.at(-1)?.observationTimeUnixMs ?? 0)
      - (history?.history?.retained?.[0]?.observationTimeUnixMs ?? 0)) / 60_000,
    commonResidentCount: history?.renderer?.commonResidentObservationIds?.length,
    detailResidentCount: detail?.renderer?.detailedObservationIds?.length,
    playbackDetailResidentCount: activePlayback?.renderer?.detailedObservationIds?.length,
    playbackPresentationFactor: activePlayback?.renderer?.presentationFactor,
    transitions: transitions?.completedTransitions,
    hotPathActivity: transitions?.activityDelta,
    peakGpuBytes: Math.max(
      detail?.renderer?.peakGpuResourceBytes ?? 0,
      activePlayback?.renderer?.peakGpuResourceBytes ?? 0,
    ),
    maxUploadSliceMs: Math.max(
      detail?.renderer?.maximumUploadSliceMs ?? 0,
      activePlayback?.renderer?.maximumUploadSliceMs ?? 0,
    ),
    contextEpoch: contextReset?.receipt?.contextEpoch,
    restoredSource: restoredSite?.sourceState?.painted?.source,
    failures: report.failures,
  }, null, 2));
  if (report.failures.length > 0) process.exitCode = 1;
  }
} finally {
  if (residentEvidenceHeld) {
    await evaluate("window.__MISTR_NATIONAL_PHASE4__?.endResidentEvidence()").catch(() => {});
  }
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

async function observePartialHistoryControls() {
  return evaluate(serialized(`(async()=>{
    const deadline=performance.now()+600000;
    let partialSampleCount=0;
    let buttonFoundSampleCount=0;
    let stableStagingSampleCount=0;
    let enabledStableStagingSampleCount=0;
    const partialRetainedCounts=new Set();
    const stableStagingRetainedCounts=new Set();
    const enabledStableStagingRetainedCounts=new Set();
    let firstDisabledStableStaging=null;
    while(performance.now()<deadline){
      const report=window.__MISTR_NATIONAL_PHASE4__.report();
      const retainedCount=report?.history?.retained?.length??0;
      if(retainedCount>=20){
        return {
          partialSampleCount,
          buttonFoundSampleCount,
          stableStagingSampleCount,
          enabledStableStagingSampleCount,
          partialRetainedCounts:[...partialRetainedCounts].sort((a,b)=>a-b),
          stableStagingRetainedCounts:[...stableStagingRetainedCounts].sort((a,b)=>a-b),
          enabledStableStagingRetainedCounts:[...enabledStableStagingRetainedCounts].sort((a,b)=>a-b),
          firstDisabledStableStaging,
        };
      }
      if(retainedCount>=2){
        partialSampleCount+=1;
        partialRetainedCounts.add(retainedCount);
        const button=document.querySelector('.playback-toggle');
        if(button instanceof HTMLButtonElement) buttonFoundSampleCount+=1;
        const renderer=report?.renderer;
        const stableStaging=renderer?.status==='staging'
          && renderer?.mutationAwaitingCommit===false
          && renderer?.paintReceipt
          && renderer?.commonResidentObservationIds?.length===retainedCount;
        if(stableStaging){
          stableStagingSampleCount+=1;
          stableStagingRetainedCounts.add(retainedCount);
          if(button instanceof HTMLButtonElement && !button.disabled){
            enabledStableStagingSampleCount+=1;
            enabledStableStagingRetainedCounts.add(retainedCount);
          }else if(firstDisabledStableStaging===null){
            firstDisabledStableStaging={
              retainedCount,
              buttonFound:button instanceof HTMLButtonElement,
              replacementPending:report?.playback?.residentReplacementPending??null,
            };
          }
        }
      }
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw new Error('National history did not reach 20 observations while controls were observed');
  })()`), true, 660_000);
}

async function observePlaybackChrome(durationMs) {
  return evaluate(serialized(`(async()=>{
    const rect=element=>{
      const value=element?.getBoundingClientRect();
      return value?{left:value.left,top:value.top,width:value.width,height:value.height}:null;
    };
    const samples=[];
    const deadline=performance.now()+${durationMs};
    while(performance.now()<deadline){
      const report=window.__MISTR_NATIONAL_PHASE4__.report();
      const sample=document.querySelector('.sample-readout');
      samples.push({
        playbackBar:rect(document.querySelector('.playback-bar')),
        timeline:rect(document.querySelector('.timeline')),
        telemetry:rect(document.querySelector('.telemetry-readouts')),
        sampleReadout:rect(sample),
        sampleText:sample?.textContent?.trim()??'',
        sampleState:sample?.dataset.inspectionState??null,
        sampleBusy:sample?.getAttribute('aria-busy')??null,
        announcement:document.querySelector('.radar-announcement')?.textContent?.replace(/\s+/g,' ').trim()??'',
        buttonDisabled:document.querySelector('.playback-toggle')?.disabled??null,
        loadingNotice:/Loading recent observations/i.test(document.querySelector('.radar-notice')?.textContent??''),
        playing:report?.playback?.playing===true,
        retainedCount:report?.history?.retained?.length??0,
      });
      await new Promise(resolve=>setTimeout(resolve,16));
    }
    const maxRectDelta=key=>{
      const baseline=samples[0]?.[key];
      if(!baseline||samples.some(sample=>!sample[key])) return null;
      return Math.max(...samples.flatMap(sample=>[
        Math.abs(sample[key].left-baseline.left),
        Math.abs(sample[key].top-baseline.top),
        Math.abs(sample[key].width-baseline.width),
        Math.abs(sample[key].height-baseline.height),
      ]));
    };
    const pending=samples.filter(sample=>sample.sampleState==='pending');
    return {
      innerWidth,
      innerHeight,
      sampleCount:samples.length,
      playingSampleCount:samples.filter(sample=>sample.playing).length,
      partialHistorySampleCount:samples.filter(sample=>sample.retainedCount>=2&&sample.retainedCount<20).length,
      loadingNoticeSampleCount:samples.filter(sample=>sample.loadingNotice).length,
      buttonDisabledSampleCount:samples.filter(sample=>sample.buttonDisabled!==false).length,
      falseOutsideCoverageSampleCount:samples.filter(sample=>sample.sampleText==='OUTSIDE RADAR COVERAGE').length,
      pendingSampleCount:pending.length,
      pendingPresentationMismatchCount:pending.filter(sample=>sample.sampleText!=='--.- dBZ'||sample.sampleBusy!=='true').length,
      playbackBarMaxRectDelta:maxRectDelta('playbackBar'),
      timelineMaxRectDelta:maxRectDelta('timeline'),
      telemetryMaxRectDelta:maxRectDelta('telemetry'),
      sampleReadoutMaxRectDelta:maxRectDelta('sampleReadout'),
      distinctSampleTexts:[...new Set(samples.map(sample=>sample.sampleText))],
      distinctAnnouncements:[...new Set(samples.map(sample=>sample.announcement))],
    };
  })()`), true, durationMs + 30_000);
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
