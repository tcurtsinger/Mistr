// The startup-fallback gate's CDP side. `prime` stores the camera the next
// launch restores; a case name checks what that launch painted and whether it
// used the bundled startup scan. (A reload is no substitute for a launch: the
// previous document's native downloads stay charged until they unwind.)
// Usage: node scripts/startup-fallback-cdp.mjs prime <longitude> <latitude> <zoom>
//        node scripts/startup-fallback-cdp.mjs <case>
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CdpClient, fetchJsonWithTimeout, openWebSocketWithTimeout } from "./cdp-client.mjs";
import { validateStartupFallbackCase } from "./startup-fallback-validation.mjs";

const [label, longitude, latitude, zoom] = process.argv.slice(2);
const port = Number(process.env.MISTR_CDP_PORT ?? 9344);
const output = resolve(process.env.MISTR_STARTUP_FALLBACK_OUTPUT ?? "artifacts/startup-fallback");
const camera = { longitude: Number(longitude), latitude: Number(latitude), zoom: Number(zoom) };
if (!label || (label === "prime" && !Object.values(camera).every(Number.isFinite))) {
  throw new Error("usage: startup-fallback-cdp.mjs prime <longitude> <latitude> <zoom> | <case>");
}
await mkdir(output, { recursive: true });

const target = await waitForTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await openWebSocketWithTimeout(socket);
const client = new CdpClient(socket, 60_000);
const evaluate = async (expression) => {
  const reply = await client.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (reply.error) throw new Error(`Runtime.evaluate: ${JSON.stringify(reply.error)}`);
  if (reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 600));
  return reply.result.result.value;
};

try {
  await client.call("Runtime.enable");
  await waitFor(() => evaluate("Boolean(window.__MISTR_PHASE4__)"), 60_000);
  if (label === "prime") {
    await evaluate(`localStorage.setItem("mistr.camera", ${JSON.stringify(JSON.stringify(camera))}); true`);
    process.exit(0);
  }
  const sample = () => evaluate(`(() => {
    const source = window.__MISTR_NATIONAL_PHASE4__?.sourceState?.();
    const painted = source?.painted?.source;
    const phase4 = window.__MISTR_PHASE4__?.report?.();
    return {
      startupFallback: window.__MISTR_PHASE4__?.startupFallback?.() ?? null,
      painted: painted ? (painted.kind === "site" ? painted.siteIcao : "national") : null,
      transition: Boolean(source?.transition),
      liveSite: window.__MISTR_PHASE5__?.report?.()?.display?.lastComplete?.site ?? null,
      liveSourceKind: window.__MISTR_PHASE5__?.report?.()?.display?.lastComplete?.source ?? null,
      siteRenderer: phase4?.renderer?.status ?? null,
      sitePlaybackReady: Boolean(phase4?.playback),
      nationalRenderer: window.__MISTR_NATIONAL_PHASE4__?.report?.()?.renderer?.status ?? null,
      alert: document.querySelector("[role=alert]")?.textContent?.trim() || null,
      preparing: document.querySelector(".playback-bar")?.innerText?.includes("LOADING") ?? false,
    };
  })()`);
  const settle = async () => {
    const started = Date.now();
    let state = null;
    const painted = [];
    while (Date.now() - started < 120_000) {
      try {
        state = await sample();
      } catch {
        // The reloaded document is still rebuilding its diagnostics.
        await delay(250);
        continue;
      }
      if (state.painted && painted.at(-1) !== state.painted) painted.push(state.painted);
      const settled = !state.transition && state.startupFallback && (
        (state.painted === "national" && state.nationalRenderer === "painted")
        || (state.painted && state.painted !== "national" && state.liveSite === state.painted
          && state.liveSourceKind === "nexrad_level2_chunks"
          && state.siteRenderer === "painted" && state.sitePlaybackReady)
      );
      if (settled) break;
      await delay(250);
    }
    return { ...state, paintedSequence: painted, settledMs: Date.now() - started };
  };
  let result;
  if (label === "reload") {
    // A reload while the first document is downloading its history must
    // still reach live radar, not have its first requests refused.
    const beforeReload = await settle();
    await delay(2_000);
    await evaluate("setTimeout(() => location.reload(), 0); true");
    await delay(500);
    result = { case: label, ...(await settle()), reloaded: true, beforeReload };
  } else {
    result = { case: label, ...(await settle()) };
  }
  result.failures = validateStartupFallbackCase(label, result);
  await writeFile(resolve(output, `${label}.json`), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length > 0) process.exitCode = 1;
} finally {
  client.close();
}

async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch {
      // The page is still starting.
    }
    await delay(250);
  }
  throw new Error("Mistr diagnostics did not appear");
}

async function waitForTarget() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((candidate) => candidate.type === "page");
      if (page) return page;
    } catch {
      // WebView2 is still starting.
    }
    await delay(250);
  }
  throw new Error(`Mistr page did not appear on CDP port ${port}`);
}

function delay(milliseconds) {
  return new Promise((done) => setTimeout(done, milliseconds));
}
