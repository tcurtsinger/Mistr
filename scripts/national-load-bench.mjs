// Repeatable National load and regional-render benchmark over CDP.
// Usage: scripts/run-national-load-bench.ps1 -Label <label> [-Runs n]. Results: artifacts/bench/<label>.json
import { writeFile, mkdir } from "node:fs/promises";
import { CdpClient, fetchJsonWithTimeout, openWebSocketWithTimeout } from "./cdp-client.mjs";

const label = process.argv[2] ?? "run";
const port = Number(process.env.MISTR_CDP_PORT ?? 9344);
const outDir = new URL("../artifacts/bench/", import.meta.url);
await mkdir(outDir, { recursive: true });

// The debugging endpoint can answer before the WebView publishes its page.
async function waitForPageTarget(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Endpoint not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no WebView page target on port ${port} within ${timeoutMs} ms`);
}

const page = await waitForPageTarget();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await openWebSocketWithTimeout(socket);
const cdp = new CdpClient(socket, 240_000);
const evaluate = async (expression) => {
  const reply = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 600));
  return reply.result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// MISTR_BENCH_NO_PROFILE=1 keeps the sampling profiler from skewing
// load-time frame pacing.
const profileLoad = process.env.MISTR_BENCH_NO_PROFILE !== "1";

function summarizeProfile(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfMs = new Map();
  let totalMs = 0;
  profile.samples.forEach((id, index) => {
    const node = byId.get(id);
    const ms = (profile.timeDeltas[index] ?? 0) / 1000;
    totalMs += ms;
    const name = node.callFrame.functionName || "(anonymous)";
    selfMs.set(name, (selfMs.get(name) ?? 0) + ms);
  });
  const idle = (selfMs.get("(idle)") ?? 0) + (selfMs.get("(program)") ?? 0);
  const top = [...selfMs].filter(([name]) => !["(idle)", "(program)"].includes(name))
    .sort((left, right) => right[1] - left[1]).slice(0, 12)
    .map(([name, ms]) => ({ name, ms: Math.round(ms) }));
  // Who calls the blocking GL queries, by caller name and line.
  const parentOf = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parentOf.set(child, node);
  const callers = {};
  profile.samples.forEach((id, index) => {
    const node = byId.get(id);
    const name = node.callFrame.functionName;
    if (!["getError", "getParameter", "isEnabled", "clientWaitSync"].includes(name)) return;
    const parent = parentOf.get(id);
    const key = parent ? `${parent.callFrame.functionName || "(anonymous)"}:${parent.callFrame.lineNumber + 1}` : "(root)";
    callers[name] ??= {};
    callers[name][key] = (callers[name][key] ?? 0) + (profile.timeDeltas[index] ?? 0) / 1000;
  });
  for (const name of Object.keys(callers)) {
    callers[name] = Object.fromEntries(Object.entries(callers[name])
      .sort((left, right) => right[1] - left[1]).slice(0, 6).map(([key, ms]) => [key, Math.round(ms)]));
  }
  return {
    windowMs: Math.round(totalMs),
    busyMs: Math.round(totalMs - idle),
    getErrorMs: Math.round(selfMs.get("getError") ?? 0),
    top,
    callers,
  };
}

// A launch opens the source its restored camera calls for; a country view
// opens National.
const nationalCamera = `localStorage.setItem("mistr.camera", JSON.stringify({ longitude: -98.5, latitude: 39.5, zoom: 4.5 }))`;

if (label === "--prime") {
  // Stores a country view so the next launch opens National and is measurable.
  await evaluate(`${nationalCamera}; true`);
  cdp.close();
  process.exit(0);
}

try {
  await cdp.call("Page.enable");
  await cdp.call("Profiler.enable");
  await cdp.call("Profiler.setSamplingInterval", { interval: 500 });
  // The app was just launched on National; keep the next launch there too.
  await evaluate(`${nationalCamera}; true`);
  await evaluate(`(() => {
    globalThis.__bench = { longTasks: [], frames: {}, loadFrameMs: [] };
    // Frame pacing while history loads: every animation-frame interval.
    let lastFrame;
    const pace = (time) => {
      if (lastFrame !== undefined) __bench.loadFrameMs.push(time - lastFrame);
      lastFrame = time;
      const count = globalThis.__MISTR_NATIONAL_PHASE4__?.report?.()?.history?.retained?.length ?? 0;
      if (count < 60 && performance.now() < 240000) requestAnimationFrame(pace);
    };
    requestAnimationFrame(pace);
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) __bench.longTasks.push(Math.round(entry.duration)); })
      .observe({ type: "longtask", buffered: true });
    const benchTimer = setInterval(() => {
      const count = globalThis.__MISTR_NATIONAL_PHASE4__?.report?.()?.history?.retained?.length ?? 0;
      if (count > 0 && __bench.frames[count] === undefined) __bench.frames[count] = Math.round(performance.now());
      if (count >= 60 || performance.now() > 240000) clearInterval(benchTimer);
    }, 50);
    return true;
  })()`);
  await sleep(3_000);
  let loadProfile = null;
  if (profileLoad) {
    const uploadsBefore = await evaluate(`__MISTR_NATIONAL_PHASE4__?.report()?.renderer?.uploadCount ?? 0`);
    await cdp.call("Profiler.start");
    await sleep(15_000);
    loadProfile = summarizeProfile((await cdp.call("Profiler.stop")).result.profile);
    const uploadsAfter = await evaluate(`__MISTR_NATIONAL_PHASE4__?.report()?.renderer?.uploadCount ?? 0`);
    loadProfile.chunksUploaded = uploadsAfter - uploadsBefore;
    loadProfile.busyMsPerChunk = Math.round(loadProfile.busyMs / Math.max(1, loadProfile.chunksUploaded) * 1000) / 1000;
    loadProfile.getErrorMsPerChunk = Math.round(loadProfile.getErrorMs / Math.max(1, loadProfile.chunksUploaded) * 1000) / 1000;
  }
  const load = await evaluate(`(async () => {
    const end = performance.now() + 200000;
    while ((__MISTR_NATIONAL_PHASE4__?.report()?.history?.retained?.length ?? 0) < 60 && performance.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const report = __MISTR_NATIONAL_PHASE4__.report();
    const pick = (n) => __bench.frames[n] ?? null;
    // Network-independent: how long each frame's GPU staging took (stage -> pause).
    const trace = __MISTR_NATIONAL_PHASE4__.loadTrace?.() ?? [];
    const staging = [];
    for (let index = 0; index < trace.length; index += 1) {
      if (trace[index].step !== "commit:stage") continue;
      const pause = trace.slice(index + 1).find((entry) => entry.step === "commit:pause-playback");
      if (pause) staging.push(pause.atUnixMs - trace[index].atUnixMs);
    }
    staging.sort((a, b) => a - b);
    const paced = [...__bench.loadFrameMs].sort((a, b) => a - b);
    const q = (p) => paced.length ? Math.round(paced[Math.min(paced.length - 1, Math.floor(paced.length * p))] * 10) / 10 : null;
    return {
      loadFramePacing: {
        frames: paced.length,
        p50: q(0.5),
        p95: q(0.95),
        p99: q(0.99),
        max: paced.length ? Math.round(paced.at(-1) * 10) / 10 : null,
        // At 120 Hz a refresh is 8.3 ms: over 12.5 ms means at least one was missed.
        missedRefresh: paced.filter((ms) => ms > 12.5).length,
        over33ms: paced.filter((ms) => ms > 33.4).length,
      },
      frameAtMs: { 1: pick(1), 2: pick(2), 20: pick(20), 40: pick(40), 60: pick(60) },
      stagingMsPerFrame: staging.length
        ? { frames: staging.length, p50: staging[Math.floor(staging.length / 2)], p90: staging[Math.floor(staging.length * 0.9)] }
        : null,
      longTasks: { count: __bench.longTasks.length, maxMs: Math.max(0, ...__bench.longTasks) },
      uploadCount: report.renderer?.uploadCount ?? null,
      maximumUploadSliceMs: report.renderer?.maximumUploadSliceMs ?? null,
      gpuBytes: report.renderer?.gpuResourceBytes ?? null,
    };
  })()`);

  // Regional render cost: KTLX metro at zoom 8.3, loop playing.
  await evaluate(`__MISTR_NATIONAL_PHASE4__.setCamera(-97.3, 35.4, 8.3); true`);
  await sleep(1_500);
  await evaluate(`__MISTR_NATIONAL_PHASE4__.play().then(() => true)`);
  await sleep(1_000);
  await cdp.call("Profiler.start");
  const frames = await evaluate(`(async () => {
    const samples = []; let last; let handle;
    const tick = (time) => { if (last) samples.push(time - last); last = time; handle = requestAnimationFrame(tick); };
    handle = requestAnimationFrame(tick);
    await new Promise((resolve) => setTimeout(resolve, 10000));
    cancelAnimationFrame(handle);
    samples.sort((a, b) => a - b);
    const at = (q) => Math.round(samples[Math.floor(samples.length * q)] * 10) / 10;
    return { frames: samples.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: Math.round(samples.at(-1) * 10) / 10 };
  })()`);
  const renderProfile = summarizeProfile((await cdp.call("Profiler.stop")).result.profile);
  await evaluate(`__MISTR_NATIONAL_PHASE4__.pause(); true`);

  const result = { label, at: new Date().toISOString(), load, loadProfile, regionalPlayback: { frames, profile: renderProfile } };
  await writeFile(new URL(`${label}.json`, outDir), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    label,
    frameAtMs: load.frameAtMs,
    loadFramePacing: load.loadFramePacing,
    longTasks: load.longTasks,
    uploads: load.uploadCount,
    stagingMsPerFrame: load.stagingMsPerFrame,
    chunksInWindow: loadProfile?.chunksUploaded,
    busyMsPerChunk: loadProfile?.busyMsPerChunk,
    getErrorMsPerChunk: loadProfile?.getErrorMsPerChunk,
    loadBusyMs: loadProfile?.busyMs,
    loadGetErrorMs: loadProfile?.getErrorMs,
    loadTop: loadProfile?.top.slice(0, 8),
    loadCallers: loadProfile?.callers,
    playback: frames,
    renderBusyMs: renderProfile.busyMs,
    renderTop: renderProfile.top.slice(0, 8),
    renderCallers: renderProfile.callers,
  }, null, 1));
} finally {
  cdp.close();
}
