import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CdpClient, fetchJsonWithTimeout, openWebSocketWithTimeout } from "./cdp-client.mjs";
import { validateAlphaReadiness } from "./alpha-readiness-validation.mjs";

const port = Number(process.env.MISTR_CDP_PORT ?? 9340);
const output = resolve(process.env.MISTR_ALPHA_READINESS_OUTPUT ?? "artifacts/alpha-release/readiness");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid CDP port");

await mkdir(output, { recursive: true });
const target = await waitForTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await openWebSocketWithTimeout(socket);
const client = new CdpClient(socket);

try {
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Accessibility.enable");
  await call("DOM.enable");
  await call("CSS.enable");
  await waitForRadar();
  await evaluate("window.__MISTR_PHASE4__.prepareArchive()", true, 30_000);
  await evaluate("window.__MISTR_PHASE4__.pause()");
  const windowInfo = await call("Browser.getWindowForTarget", { targetId: target.id });
  assertProtocolResult(windowInfo, "Browser.getWindowForTarget");
  const windowId = windowInfo.result.windowId;
  const viewports = [];
  for (const [width, height] of [[3_840, 2_160], [1_100, 700], [1_024, 640]]) {
    await setWindowBounds(windowId, width, height);
    viewports.push(await captureViewport());
  }

  await setWindowBounds(windowId, 1_100, 700);
  const keyboard = await exerciseKeyboard();
  const accessibility = await captureAccessibility();
  const forcedColors = await captureForcedColors();
  const reducedMotion = await captureReducedMotion();
  const contrast = await captureContrast();
  const visibleText = await evaluate("document.body.innerText");
  const renderer = await evaluate("window.__MISTR_PHASE4__.report().renderer");
  const report = {
    documentTitle: await evaluate("document.title"),
    userAgent: await evaluate("navigator.userAgent"),
    renderer,
    viewports,
    keyboard,
    accessibility,
    forcedColors,
    reducedMotion,
    contrast,
    visiblePrototypeTerms: `${await evaluate("document.title")}\n${visibleText}`.match(/\b(?:prototype|phase\s*[0-9]|fixture|benchmark|diagnostic)\b/gi) ?? [],
    completedAtUnixMs: Date.now(),
  };
  const failures = validateAlphaReadiness(report);
  const summary = {
    status: failures.length === 0 ? "PASS" : "FAIL",
    viewports: viewports.map(({ innerWidth, innerHeight }) => `${innerWidth}x${innerHeight}`),
    keyboard,
    unnamedInteractive: accessibility.unnamedInteractive,
    inactiveSampleContrast: contrast.inactiveSample,
    failures,
  };
  await writeFile(resolve(output, "packaged-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(output, "packaged-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length > 0) process.exitCode = 1;
} finally {
  client.close();
}

async function captureViewport() {
  return evaluate(`(()=>{
    const rect = element => {
      const value = element.getBoundingClientRect();
      return {left:value.left,top:value.top,right:value.right,bottom:value.bottom,width:value.width,height:value.height};
    };
    const inside = value => value.left >= 0 && value.top >= 0
      && value.right <= innerWidth && value.bottom <= innerHeight;
    const persistent = [...document.querySelectorAll('.edge-trigger,.context-bar,.playback-bar')].map(rect);
    const visibleControls = [...document.querySelectorAll('button,input')].filter(element => {
      const style = getComputedStyle(element);
      const value = rect(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && value.width > 0 && value.height > 0;
    });
    return {
      innerWidth,
      innerHeight,
      scrollWidth:document.documentElement.scrollWidth,
      scrollHeight:document.documentElement.scrollHeight,
      persistentControlsInside:persistent.length === 3 && persistent.every(inside),
      persistent,
      undersizedControls:visibleControls.filter(element => {
        const value = rect(element);
        return element.type !== 'range' && (value.width < 24 || value.height < 24);
      }).map(element => element.getAttribute('aria-label') || element.textContent.trim()),
      openPanelCount:document.querySelectorAll('.tool-panel').length,
    };
  })()`);
}

async function exerciseKeyboard() {
  const playbackBefore = await evaluate("(()=>{const r=document.querySelector('.playback-bar').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()");
  await evaluate("document.querySelector('.edge-trigger').click()");
  await delay(100);
  const menu = await evaluate(`(()=>({
    focus:document.activeElement?.textContent?.replace(/\\s+/g,' ').trim(),
    focusVisible:document.activeElement?.matches(':focus-visible') ?? false,
    openPanels:document.querySelectorAll('.tool-panel').length
  }))()`);
  const playbackOpen = await evaluate("(()=>{const r=document.querySelector('.playback-bar').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()");
  await pressKey("Escape", "Escape", 27);
  await delay(100);
  const menuClosed = await evaluate(`(()=>({
    closed:document.querySelectorAll('.tool-panel').length===0,
    returnName:document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.replace(/\\s+/g,' ').trim()
  }))()`);

  await evaluate("document.querySelector('.context-selector').click()");
  await delay(100);
  const context = await evaluate(`(()=>({
    focus:document.activeElement?.textContent?.replace(/\\s+/g,' ').trim(),
    focusVisible:document.activeElement?.matches(':focus-visible') ?? false
  }))()`);
  await pressKey("Escape", "Escape", 27);
  await delay(100);
  const contextClosed = await evaluate(`(()=>({
    closed:document.querySelectorAll('.tool-panel').length===0,
    returnName:document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.replace(/\\s+/g,' ').trim()
  }))()`);

  const sliderBefore = Number(await evaluate("document.querySelector('.timeline input').value"));
  const sliderMaximum = Number(await evaluate("document.querySelector('.timeline input').max"));
  const valueTextBefore = await evaluate("document.querySelector('.timeline input').getAttribute('aria-valuetext')");
  await evaluate("document.querySelector('.timeline input').focus()");
  if (sliderBefore < sliderMaximum) await pressKey("ArrowRight", "ArrowRight", 39);
  else await pressKey("ArrowLeft", "ArrowLeft", 37);
  await delay(300);
  const sliderAfter = Number(await evaluate("document.querySelector('.timeline input').value"));
  const valueTextAfter = await evaluate("document.querySelector('.timeline input').getAttribute('aria-valuetext')");
  return {
    menuInitialFocus: menu.focus,
    menuFocusVisible: menu.focusVisible,
    menuOpenPanelCount: menu.openPanels,
    menuEscapeClosed: menuClosed.closed,
    menuEscapeReturn: menuClosed.returnName,
    contextInitialFocus: context.focus,
    contextFocusVisible: context.focusVisible,
    contextEscapeClosed: contextClosed.closed,
    contextEscapeReturn: contextClosed.returnName,
    playbackBarStable: sameRect(playbackBefore, playbackOpen),
    sliderBefore,
    sliderAfter,
    sliderValueTextUpdated: valueTextBefore !== valueTextAfter && valueTextAfter?.startsWith(`${sliderAfter + 1} of `),
  };
}

async function captureAccessibility() {
  const tree = await call("Accessibility.getFullAXTree");
  assertProtocolResult(tree, "Accessibility.getFullAXTree");
  const interactiveRoles = new Set(["button", "slider", "link"]);
  const unnamedInteractive = tree.result.nodes
    .filter(node => !node.ignored && interactiveRoles.has(node.role?.value) && !node.name?.value)
    .map(node => node.role?.value);
  return evaluate(`(()=>{
    const map=document.querySelector('.maplibregl-canvas');
    const context=document.querySelector('.context-selector');
    return {
      unnamedInteractive:${JSON.stringify(unnamedInteractive)},
      mapTabIndex:map?.tabIndex ?? null,
      mapAccessibleName:map?.getAttribute('aria-label') || document.querySelector('.map-surface')?.getAttribute('aria-label'),
      contextHasPopup:context?.getAttribute('aria-haspopup') ?? null
    };
  })()`);
}

async function captureForcedColors() {
  await call("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
  const documentNode = await call("DOM.getDocument");
  assertProtocolResult(documentNode, "DOM.getDocument");
  const buttonNode = await call("DOM.querySelector", {
    nodeId: documentNode.result.root.nodeId,
    selector: ".edge-trigger",
  });
  assertProtocolResult(buttonNode, "DOM.querySelector");
  await call("CSS.forcePseudoState", {
    nodeId: buttonNode.result.nodeId,
    forcedPseudoClasses: ["focus", "focus-visible"],
  });
  const result = await evaluate(`(()=>{
    const button=document.querySelector('.edge-trigger');
    const style=getComputedStyle(button);
    return {
      matches:matchMedia('(forced-colors: active)').matches,
      outlineStyle:style.outlineStyle,
      outlineWidth:style.outlineWidth,
      focusOutlineVisible:style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2
    };
  })()`);
  await call("CSS.forcePseudoState", {
    nodeId: buttonNode.result.nodeId,
    forcedPseudoClasses: [],
  });
  await call("Emulation.setEmulatedMedia", { features: [] });
  return result;
}

async function captureReducedMotion() {
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const result = await evaluate(`(()=>{
    const style=getComputedStyle(document.querySelector('.edge-trigger'));
    return {matches:matchMedia('(prefers-reduced-motion: reduce)').matches,transitionDuration:style.transitionDuration,animationDuration:style.animationDuration};
  })()`);
  await call("Emulation.setEmulatedMedia", { features: [] });
  return result;
}

async function captureContrast() {
  return evaluate(`(()=>{
    const parse=color=>color.match(/[\\d.]+/g).slice(0,3).map(Number);
    const luminance=rgb=>rgb.map(value=>value/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4)
      .reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
    const ratio=(left,right)=>{const a=luminance(left),b=luminance(right);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};
    const root=getComputedStyle(document.documentElement);
    const foreground=parse(getComputedStyle(document.querySelector('.sample-readout')).color);
    const background=parse(root.getPropertyValue('--stage-black'));
    return {inactiveSample:ratio(foreground,background)};
  })()`);
}

async function setWindowBounds(windowId, width, height) {
  const response = await call("Browser.setWindowBounds", {
    windowId,
    bounds: { left: 0, top: 0, width, height, windowState: "normal" },
  });
  assertProtocolResult(response, "Browser.setWindowBounds");
  await delay(500);
}

async function pressKey(key, code, virtualKeyCode) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    const response = await call("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
    });
    assertProtocolResult(response, "Input.dispatchKeyEvent");
  }
}

function sameRect(left, right) {
  return ["left", "top", "width", "height"].every(key => Math.abs(left[key] - right[key]) < 0.5);
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
      // Packaged WebView is still starting.
    }
    await delay(250);
  }
  throw new Error(`Mistr page target did not appear on CDP port ${port}`);
}

async function waitForRadar() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await evaluate("Boolean(window.__MISTR_PHASE4__)") ) return;
    const errorText = await evaluate("document.querySelector('.benchmark-error')?.textContent ?? null");
    if (errorText) throw new Error(`packaged app failed before readiness: ${errorText}`);
    await delay(250);
  }
  throw new Error("Phase 4 diagnostic API did not become ready");
}

function assertProtocolResult(response, method) {
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}
