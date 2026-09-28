import { readFileSync } from "node:fs";
import type { CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePackedGridChunk, parsePackedGridManifest } from "../packed-grid/packedGrid";
import { viewportCoverage } from "./coverage";
import { NationalGridLayer } from "./NationalGridLayer";

const MANIFEST = new URL("../../fixtures/expected/national-phase2/packed-grid-v1-manifest.bin", import.meta.url);
const CHUNK = new URL("../../fixtures/expected/national-phase2/packed-grid-v1-chunk-000.bin", import.meta.url);

const GL_CONSTANTS: Record<string, number> = {
  NO_ERROR: 0,
  ALREADY_SIGNALED: 0x911a,
  TIMEOUT_EXPIRED: 0x911b,
  CONDITION_SATISFIED: 0x911c,
  WAIT_FAILED: 0x911d,
};

// Just enough WebGL2 for the layer's state machine: every call is a no-op
// except fences, which a test can hold open, and draws, which are counted.
function fakeGl() {
  const state = { draws: 0, fences: 0, fenceSignaled: true, lost: false };
  const gl = new Proxy({}, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      if (property in GL_CONSTANTS) return GL_CONSTANTS[property];
      if (/^[A-Z0-9_]+$/.test(property)) return 1;
      switch (property) {
        case "drawingBufferWidth": return 1920;
        case "drawingBufferHeight": return 1080;
        case "drawArrays": return () => { state.draws += 1; };
        case "fenceSync": return () => { state.fences += 1; return {}; };
        case "clientWaitSync":
          return () => state.fenceSignaled ? GL_CONSTANTS.ALREADY_SIGNALED : GL_CONSTANTS.TIMEOUT_EXPIRED;
        case "getError": return () => 0;
        case "isContextLost": return () => state.lost;
        case "isEnabled": return () => false;
        case "getParameter": return () => null;
        case "getShaderParameter":
        case "getProgramParameter": return () => true;
        default: return () => ({});
      }
    },
  }) as WebGL2RenderingContext;
  return { gl, state };
}

function fakeMap(handlers = new Map<string, () => void>()) {
  return {
    triggerRepaint() {},
    on(event: string, handler: () => void) { handlers.set(event, handler); },
    off() {},
    getLayer() { return undefined; },
    getStyle() { return { layers: [] }; },
  } as unknown as MapLibreMap;
}

const RENDER_INPUT = {
  defaultProjectionData: { mainMatrix: new Float32Array(16) },
} as unknown as CustomRenderMethodInput;

async function paintedLayer() {
  const { gl, state } = fakeGl();
  const handlers = new Map<string, () => void>();
  const map = fakeMap(handlers);
  const layer = new NationalGridLayer();
  layer.onAdd(map, gl);
  const manifest = parsePackedGridManifest(Uint8Array.from(readFileSync(MANIFEST)).buffer);
  const chunk = await parsePackedGridChunk(Uint8Array.from(readFileSync(CHUNK)).buffer);
  const coverage = viewportCoverage(manifest, { west: -129.99, east: -129.9, south: 54.9, north: 54.99 }, 1);
  expect(coverage.requiredChunkIndices).toEqual([0]);
  const stage = async () => {
    layer.beginStaging(manifest, coverage);
    await layer.uploadStagedChunk(chunk);
  };
  const render = () => layer.render(gl, RENDER_INPUT);
  await stage();
  const committed = layer.commitStaging();
  render();
  render();
  await expect(committed).resolves.toMatchObject({ presented: true });
  return { layer, state, stage, render, map, handlers, gl };
}

describe("National resident visibility", () => {
  const originalFrame = globalThis.requestAnimationFrame;
  beforeEach(() => {
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => (
      globalThis.setTimeout(() => callback(0), 0) as unknown as number
    )) as typeof globalThis.requestAnimationFrame;
  });
  afterEach(() => {
    globalThis.requestAnimationFrame = originalFrame;
  });

  it("commits while hidden on a fence without drawing or claiming a paint", async () => {
    const { layer, state, stage, render } = await paintedLayer();
    layer.setVisibility("resident");
    expect(layer.getSnapshot()).toMatchObject({ visibility: "resident", status: "ready" });
    expect(layer.getSnapshot().paintReceipt).toBeUndefined();

    await stage();
    const committed = layer.commitStaging();
    const drawsBefore = state.draws;
    render();
    render();
    const receipt = await committed;

    expect(receipt.presented).toBe(false);
    expect(state.draws).toBe(drawsBefore);
    const snapshot = layer.getSnapshot();
    expect(snapshot.status).toBe("resident");
    expect(snapshot.paintReceipt).toBeUndefined();
    expect(snapshot.residentReceipt).toMatchObject({ presented: false });
    await expect(layer.waitForAuthoritativeReceipt(receipt, 1_000)).resolves.toMatchObject({ presented: false });
  });

  it("reveals only after a real draw completes", async () => {
    const { layer, state, render } = await paintedLayer();
    layer.setVisibility("resident");
    render();
    render();
    expect(layer.getSnapshot().status).toBe("resident");

    const revealed = layer.revealAndWait(1_000);
    const drawsBefore = state.draws;
    render();
    render();
    const receipt = await revealed;
    expect(receipt.presented).toBe(true);
    expect(state.draws).toBeGreaterThan(drawsBefore);
    expect(layer.getSnapshot()).toMatchObject({ status: "painted", visibility: "visible" });
  });

  it("does not let a hidden fence that completes after reveal satisfy the reveal", async () => {
    const { layer, state, render } = await paintedLayer();
    layer.setVisibility("resident");
    state.fenceSignaled = false;
    render();
    let revealedReceipt: unknown;
    const revealed = layer.revealAndWait(1_000).then((receipt) => { revealedReceipt = receipt; });

    state.fenceSignaled = true;
    render();
    await Promise.resolve();
    expect(revealedReceipt).toBeUndefined();

    render();
    await revealed;
    expect(revealedReceipt).toMatchObject({ presented: true });
  });

  it("downgrades a draw that completes after hide to a resident receipt", async () => {
    const { layer, state, stage, render } = await paintedLayer();
    await stage();
    const committed = layer.commitStaging();
    state.fenceSignaled = false;
    render();
    layer.setVisibility("resident");
    state.fenceSignaled = true;
    render();

    await expect(committed).resolves.toMatchObject({ presented: false });
    const snapshot = layer.getSnapshot();
    expect(snapshot.status).toBe("resident");
    expect(snapshot.paintReceipt).toBeUndefined();
  });

  it("finishes context recovery while hidden, then reveals with a new epoch", async () => {
    const { layer, state, render, map, handlers, gl } = await paintedLayer();
    layer.setVisibility("resident");
    render();
    render();
    const epochBefore = layer.getSnapshot().contextEpoch;

    handlers.get("webglcontextlost")?.();
    state.lost = true;
    layer.onRemove(map, gl);
    state.lost = false;
    layer.onAdd(map, gl);
    for (let frame = 0; frame < 20 && layer.getSnapshot().status !== "resident"; frame += 1) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      render();
    }
    expect(layer.getSnapshot()).toMatchObject({ status: "resident", contextEpoch: epochBefore + 1 });

    const revealed = layer.revealAndWait(1_000);
    render();
    render();
    await expect(revealed).resolves.toMatchObject({ presented: true, contextEpoch: epochBefore + 1 });
  });

  it("rejects frame selection and reveal at the wrong moments", async () => {
    const { layer, stage, render } = await paintedLayer();
    layer.setVisibility("resident");
    const selected = layer.getSnapshot().selectedObservationId ?? layer.getSnapshot().observationId!;
    await expect(layer.selectResidentAndWait(selected)).rejects.toThrow("hidden");

    await stage();
    const committed = layer.commitStaging();
    await expect(layer.revealAndWait(1_000)).rejects.toThrow("unfinished mutation");
    render();
    render();
    await committed;
  });
});
