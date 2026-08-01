import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type {
  AddLayerObject,
  Map as MapLibreMap,
  MapMouseEvent,
} from "maplibre-gl";
import fixtureManifest from "../fixtures/manifest.json";
import { configureMapLibreWorker } from "./mapWorker";
import { updateMapReadiness, type MapReadiness } from "./mapReadiness";
import {
  PackedSweepTransferClient,
  tauriInvokeFunction,
  type Phase4ActivitySnapshot,
} from "./packed-sweep/transferClient";
import {
  ResidentPlaybackController,
  type PlaybackStateSnapshot,
} from "./playback/ResidentPlaybackController";
import {
  FramePerformanceMonitor,
  type FrameTimingSummary,
} from "./playback/performanceMonitor";
import {
  createAlignmentReport,
  createRadarSweepCpuModel,
  interrogateLngLat,
  type AlignmentReport,
  type GateInterrogation,
  type RadarSweepCpuModel,
} from "./radar-renderer/cpuModel";
import { destinationPoint } from "./radar-renderer/geo";
import {
  evaluateLayerCoexistence,
  type LayerCoexistenceReport,
} from "./radar-renderer/layerCoexistence";
import {
  RadarCustomLayer,
  type RadarPaintReceipt,
  type RadarRendererSnapshot,
} from "./radar-renderer/RadarCustomLayer";
import { getRuntimeSnapshot, type RuntimeSnapshot } from "./runtime";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";
const PHASE4_FRAME_COUNT = 20;
const PHASE4_TRANSITIONS = 1_000;
const PHASE4_REPLACEMENT_ROUNDS = 5;
const GPU_TARGET_BYTES = 200 * 1024 * 1024;
const GPU_HARD_CEILING_BYTES = 256 * 1024 * 1024;
const RANGE_SOURCE_ID = "mistr-range-source";
const RANGE_LAYER_ID = "mistr-range-before-radar";
const ANCHOR_SOURCE_ID = "mistr-anchor-source";
const ANCHOR_LAYER_ID = "mistr-anchors-after-radar";
const DIAGNOSTIC_LAYER_IDS = {
  range: RANGE_LAYER_ID,
  radar: "mistr-resident-radar",
  anchor: ANCHOR_LAYER_ID,
};

configureMapLibreWorker();

export function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [runtime, setRuntime] = useState<RuntimeSnapshot>({
    shell: "browser",
    appVersion: "development",
  });
  const [mapState, setMapState] = useState<MapReadiness>("INITIALIZING");
  const [mapLoaded, setMapLoaded] = useState(false);
  const [phase4, setPhase4] = useState<Phase4State>({ kind: "idle" });
  const [interrogation, setInterrogation] = useState<GateInterrogation | null>(null);

  useEffect(() => {
    void getRuntimeSnapshot().then(setRuntime);
  }, []);

  useEffect(() => {
    if (!mapContainer.current || map.current) return;
    let instance: MapLibreMap | undefined;
    try {
      instance = new maplibregl.Map({
        container: mapContainer.current,
        style: MAP_STYLE,
        center: [-97.27776, 35.333363],
        zoom: 5.8,
        bearing: 0,
        pitch: 0,
        attributionControl: false,
        maxPitch: 0,
        dragRotate: false,
        touchPitch: false,
        pitchWithRotate: false,
        canvasContextAttributes: { antialias: false },
      });
      instance.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
      instance.once("load", () => {
        instance?.setProjection({ type: "mercator" });
        setMapState((current) => updateMapReadiness(current, "load"));
        setMapLoaded(true);
      });
      instance.on("error", () => {
        setMapState((current) => updateMapReadiness(current, "error"));
      });
      map.current = instance;
    } catch {
      instance?.remove();
      setMapState((current) => updateMapReadiness(current, "error"));
      return;
    }
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (runtime.shell !== "tauri" || !mapLoaded || !instance) return;
    let cancelled = false;
    let layer: RadarCustomLayer | null = null;
    let controller: ResidentPlaybackController | null = null;
    let client: PackedSweepTransferClient | null = null;
    let clickHandler: ((event: MapMouseEvent) => void) | null = null;
    let latestReport: Phase4Report | null = null;
    let activeScenario: Promise<Phase4ScenarioReport> | null = null;
    const modelsById = new Map<string, RadarSweepCpuModel>();

    const publish = (patch: Partial<Phase4Report> = {}) => {
      if (!latestReport || cancelled) return;
      latestReport = { ...latestReport, ...patch };
      setPhase4({ kind: "complete", report: latestReport });
    };

    const runScenario = async (transitionCount = PHASE4_TRANSITIONS) => {
      if (activeScenario) return activeScenario;
      if (!layer || !controller || !client || !latestReport) {
        throw new Error("resident playback is not ready");
      }
      const activeLayer = layer;
      const activeController = controller;
      const activeClient = client;
      const baseModels = [...modelsById.values()]
        .sort((left, right) => left.observedAtUnixMs - right.observedAtUnixMs);
      activeScenario = (async () => {
        await activeController.pauseAndWait();
        const replacementGpuBytes: number[] = [];
        for (let round = 1; round <= PHASE4_REPLACEMENT_ROUNDS; round += 1) {
          const replacementGeneration = activeLayer.getSnapshot().generation + 1;
          activeLayer.replaceResidentFrames(baseModels.map((model) => ({
            ...model,
            generation: BigInt(replacementGeneration),
          })));
          await activeController.establishInitialPaint();
          replacementGpuBytes.push(activeLayer.getSnapshot().metrics?.gpuResourceBytes ?? 0);
        }

        // Loop replacement is a resource-lifecycle test, not part of the
        // resident playback frame-time sample. Let driver deletion and React
        // diagnostics settle before measuring the already-resident hot path.
        await delay(750);

        const activityBefore = await activeClient.phase4ActivitySnapshot();
        const rendererActivityBefore = rendererActivity(activeLayer.getSnapshot());
        const heapBeforeBytes = readHeapBytes();
        const performanceMonitor = new FramePerformanceMonitor();
        performanceMonitor.start();
        let receipts: RadarPaintReceipt[] = [];
        let frameTiming: FrameTimingSummary;
        try {
          receipts = await activeController.runTransitions(transitionCount, (transition) => {
            if (transition % 8 === 0) exerciseCamera(instance, baseModels[0], transition);
          });
        } finally {
          frameTiming = performanceMonitor.stop();
        }
        const activityAfter = await activeClient.phase4ActivitySnapshot();
        const rendererActivityAfter = rendererActivity(activeLayer.getSnapshot());
        const heapAfterBytes = readHeapBytes();
        const activityDelta = subtractActivity(activityAfter, activityBefore);
        const rendererActivityDelta = {
          frameUploadCount:
            rendererActivityAfter.frameUploadCount - rendererActivityBefore.frameUploadCount,
          frameUploadBytes:
            rendererActivityAfter.frameUploadBytes - rendererActivityBefore.frameUploadBytes,
        };
        const renderer = activeLayer.getSnapshot();
        const finalPlayback = activeController.snapshot();
        const receiptTruthPassed = receipts.length === transitionCount
          && receipts.every((receipt, index) => (
            receipt.generation === renderer.generation
            && receipt.contextEpoch === renderer.contextEpoch
            && modelsById.has(receipt.observationId)
            && (index === 0
              || receipt.selectionSequence === receipts[index - 1].selectionSequence + 1)
          ))
          && finalPlayback.lastPaintedObservationId === renderer.selectedObservationId
          && finalPlayback.playheadObservedAtUnixMs
            === modelsById.get(renderer.selectedObservationId)?.observedAtUnixMs;
        const replacementStable = replacementGpuBytes.length === PHASE4_REPLACEMENT_ROUNDS
          && new Set(replacementGpuBytes).size === 1
          && replacementGpuBytes[0] === renderer.metrics?.gpuResourceBytes;
        const scenario: Phase4ScenarioReport = {
          requestedTransitions: transitionCount,
          completedTransitions: receipts.length,
          replacementRounds: PHASE4_REPLACEMENT_ROUNDS,
          replacementGpuBytes,
          replacementStable,
          receiptTruthPassed,
          activityBefore,
          activityAfter,
          activityDelta,
          rendererActivityBefore,
          rendererActivityAfter,
          rendererActivityDelta,
          hotPathActivityZero: isZeroActivity(activityDelta)
            && rendererActivityDelta.frameUploadCount === 0
            && rendererActivityDelta.frameUploadBytes === 0,
          frameTiming,
          framebufferWidth: receipts.at(-1)?.framebufferWidth ?? 0,
          framebufferHeight: receipts.at(-1)?.framebufferHeight ?? 0,
          heapBeforeBytes,
          heapAfterBytes,
          completedAtUnixMs: Date.now(),
        };
        publish({
          renderer,
          playback: finalPlayback,
          activityAtResidency: activityBefore,
          scenario,
          coexistence: currentLayerCoexistenceReport(instance),
        });
        return scenario;
      })().finally(() => {
        activeScenario = null;
      });
      return activeScenario;
    };

    const run = async () => {
      const invoke = await tauriInvokeFunction();
      client = new PackedSweepTransferClient(invoke);
      await client.open();
      await client.begin(1);
      const fixtureIds = fixtureManifest.fixtureSets.phase4KtlxReflectivityLoop;
      const fixturesById = new Map(
        fixtureManifest.fixtures.map((fixture) => [fixture.id, fixture]),
      );
      const phase4Fixtures = fixtureIds.flatMap((id) => {
        const fixture = fixturesById.get(id);
        return fixture ? [fixture] : [];
      });
      if (
        fixtureIds.length !== PHASE4_FRAME_COUNT
        || new Set(fixtureIds).size !== PHASE4_FRAME_COUNT
        || phase4Fixtures.length !== PHASE4_FRAME_COUNT
        || phase4Fixtures.some((fixture) => fixture.station !== "KTLX")
      ) {
        throw new Error(`Phase 4 requires its explicit ${PHASE4_FRAME_COUNT}-fixture KTLX set`);
      }
      const models: RadarSweepCpuModel[] = [];
      for (let index = 0; index < fixtureIds.length; index += 1) {
        if (cancelled) return;
        setPhase4({
          kind: "running",
          stage: `DECODING OBSERVATION ${index + 1}/${fixtureIds.length}`,
        });
        const lease = await client.requestPhase4Fixture(fixtureIds[index]);
        try {
          const model = createRadarSweepCpuModel(lease.packed);
          if (model.sourceKind !== "nexrad_level2_archive_ii" || model.siteIcao !== "KTLX") {
            throw new Error("Phase 4 accepts real KTLX Level II observations only");
          }
          models.push(model);
          modelsById.set(model.observationId, model);
        } finally {
          await lease.release();
        }
      }
      models.sort((left, right) => left.observedAtUnixMs - right.observedAtUnixMs);
      if (new Set(models.map((model) => model.observationId)).size !== PHASE4_FRAME_COUNT) {
        throw new Error("Phase 4 fixture loop does not contain 20 distinct observations");
      }
      const diagnosticModel = models[models.length - 1];
      const alignment = createAlignmentReport(diagnosticModel);
      latestReport = {
        frames: summarizeFrames(models),
        alignment,
        coexistence: emptyLayerCoexistenceReport(),
      };
      layer = new RadarCustomLayer(models, {
        onSnapshot(renderer) {
          publish({
            renderer,
            playback: controller?.snapshot(),
          });
        },
      });
      const beforeId = firstSymbolLayer(instance);
      installDiagnosticLayers(instance, diagnosticModel, alignment, layer, beforeId);
      publish({ coexistence: currentLayerCoexistenceReport(instance) });
      controller = new ResidentPlaybackController(layer, models, {
        onState(playback) {
          publish({ playback, renderer: layer?.getSnapshot() });
        },
      });
      await controller.establishInitialPaint();
      const activityAtResidency = await client.phase4ActivitySnapshot();
      publish({
        renderer: layer.getSnapshot(),
        playback: controller.snapshot(),
        activityAtResidency,
      });
      clickHandler = (event) => {
        const paintedId = layer?.getSnapshot().lastPaintedObservationId;
        const paintedModel = paintedId ? modelsById.get(paintedId) : undefined;
        setInterrogation(paintedModel
          ? interrogateLngLat(paintedModel, {
              longitude: event.lngLat.lng,
              latitude: event.lngLat.lat,
            })
          : null);
      };
      instance.on("click", clickHandler);
      const initial = alignment.anchors.find((anchor) => anchor.gateIndex > 0)
        ?? alignment.anchors[0];
      setInterrogation(interrogateLngLat(diagnosticModel, {
        longitude: initial.longitude,
        latitude: initial.latitude,
      }));
      instance.jumpTo({
        center: [diagnosticModel.center.longitude, diagnosticModel.center.latitude],
        zoom: 5.8,
        bearing: 0,
        pitch: 0,
      });
      globalThis.__MISTR_PHASE4__ = {
        report: () => ({
          ...latestReport!,
          renderer: layer?.getSnapshot(),
          playback: controller?.snapshot(),
          coexistence: currentLayerCoexistenceReport(instance),
        }),
        runScenario,
        play: () => controller?.play(),
        pause: () => controller?.pause(),
        step: () => controller?.step() ?? Promise.reject(new Error("playback unavailable")),
        scrub: (index) => controller?.scrub(index)
          ?? Promise.reject(new Error("playback unavailable")),
        setCamera(longitude, latitude, zoom) {
          instance.jumpTo({ center: [longitude, latitude], zoom, bearing: 0, pitch: 0 });
        },
        layerOrder: () => currentLayerCoexistenceReport(instance).actualDiagnosticOrder,
      };
      controller.play();
    };

    setPhase4({ kind: "running", stage: "OPENING RESIDENT LOOP" });
    void run().catch((error: unknown) => {
      removeDiagnosticLayers(instance, layer);
      if (!cancelled) {
        setPhase4({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return () => {
      cancelled = true;
      controller?.dispose();
      if (clickHandler) instance.off("click", clickHandler);
      if (globalThis.__MISTR_PHASE4__) delete globalThis.__MISTR_PHASE4__;
      removeDiagnosticLayers(instance, layer);
    };
  }, [mapLoaded, runtime.shell]);

  const radarStatus = phase4.kind === "complete"
    ? overallStatus(phase4.report)
    : phase4.kind === "error"
      ? "ERROR"
      : phase4.kind === "running"
        ? "RUNNING"
        : "TAURI ONLY";

  return (
    <main className="app-shell">
      <div ref={mapContainer} className="map-surface" aria-label="Mistr map" />
      <header className="top-rail">
        <div>
          <p className="eyebrow">NEXRAD RENDERING EXPERIMENT</p>
          <h1>MISTR <span>PHASE 4</span></h1>
        </div>
        <div className="status-cluster" aria-label="Prototype status">
          <Status label="SHELL" value={runtime.shell.toUpperCase()} />
          <Status label="MAP" value={mapState} />
          <Status label="PLAYBACK" value={radarStatus} />
        </div>
      </header>
      <section className="checkpoint" aria-labelledby="checkpoint-title">
        <p className="eyebrow">CURRENT CHECKPOINT</p>
        <h2 id="checkpoint-title">Resident measured playback</h2>
        <p>
          Twenty distinct KTLX observations are decoded once, retained in compact CPU
          truth, uploaded together, and hard-cut only after a GPU paint receipt.
        </p>
        <Phase4Readout state={phase4} />
        <InterrogationReadout value={interrogation} />
      </section>
      <footer className="bottom-rail">
        <span>KTLX / 20 MEASURED OBSERVATIONS / HARD CUT</span>
        <span className="truth-label">PROTOTYPE - NOT OPERATIONAL</span>
      </footer>
    </main>
  );
}

interface Phase4FrameSummary {
  count: number;
  firstObservedAtUnixMs: number;
  lastObservedAtUnixMs: number;
  cpuBytes: number;
  projectedGpuBytes: number;
  distinctObservationCount: number;
}

export interface Phase4ScenarioReport {
  requestedTransitions: number;
  completedTransitions: number;
  replacementRounds: number;
  replacementGpuBytes: number[];
  replacementStable: boolean;
  receiptTruthPassed: boolean;
  activityBefore: Phase4ActivitySnapshot;
  activityAfter: Phase4ActivitySnapshot;
  activityDelta: Phase4ActivitySnapshot;
  rendererActivityBefore: RendererActivitySnapshot;
  rendererActivityAfter: RendererActivitySnapshot;
  rendererActivityDelta: RendererActivitySnapshot;
  hotPathActivityZero: boolean;
  frameTiming: FrameTimingSummary;
  framebufferWidth: number;
  framebufferHeight: number;
  heapBeforeBytes: number | null;
  heapAfterBytes: number | null;
  completedAtUnixMs: number;
}

interface RendererActivitySnapshot {
  frameUploadCount: number;
  frameUploadBytes: number;
}

export interface Phase4Report {
  frames: Phase4FrameSummary;
  alignment: AlignmentReport;
  coexistence: LayerCoexistenceReport;
  renderer?: RadarRendererSnapshot;
  playback?: PlaybackStateSnapshot;
  activityAtResidency?: Phase4ActivitySnapshot;
  scenario?: Phase4ScenarioReport;
}

type Phase4State =
  | { kind: "idle" }
  | { kind: "running"; stage: string }
  | { kind: "complete"; report: Phase4Report }
  | { kind: "error"; message: string };

function Phase4Readout({ state }: { state: Phase4State }) {
  if (state.kind === "error") {
    return <p className="benchmark-error" role="alert">{state.message}</p>;
  }
  if (state.kind !== "complete") {
    return (
      <dl>
        <div><dt>PACKAGED PROBE</dt><dd>{state.kind === "running" ? state.stage : "TAURI REQUIRED"}</dd></div>
        <div><dt>RESIDENT LOOP</dt><dd>20 REAL SCANS</dd></div>
        <div><dt>HOT PATH</dt><dd>GPU SELECT + PAINT</dd></div>
      </dl>
    );
  }
  const { report } = state;
  const metrics = report.renderer?.metrics;
  const scenario = report.scenario;
  const playhead = report.playback?.playheadObservedAtUnixMs;
  return (
    <dl aria-label="Packaged Phase 4 playback report">
      <div><dt>RESULT</dt><dd>{overallStatus(report)}</dd></div>
      <div><dt>RESIDENT</dt><dd>{metrics?.residentFrameCount ?? 0}/{PHASE4_FRAME_COUNT}</dd></div>
      <div><dt>PLAYHEAD</dt><dd>{playhead ? new Date(playhead).toISOString().slice(11, 19) : "WAITING"}</dd></div>
      <div><dt>CPU RADAR</dt><dd>{formatMiB(metrics?.cpuResourceBytes ?? report.frames.cpuBytes)} MiB</dd></div>
      <div><dt>GPU RADAR</dt><dd>{metrics ? `${formatMiB(metrics.gpuResourceBytes)} MiB` : "UPLOADING"}</dd></div>
      <div><dt>SWITCH P95</dt><dd>{metrics ? `${formatMs(metrics.residentSwitchP95Ms)} ms` : "WAITING"}</dd></div>
      <div><dt>FRAME P95</dt><dd>{scenario ? `${formatMs(scenario.frameTiming.p95Ms)} ms` : "RUNNING 1000"}</dd></div>
      <div><dt>FRAMEBUFFER</dt><dd>{scenario ? `${scenario.framebufferWidth}x${scenario.framebufferHeight}` : "MEASURING"}</dd></div>
      <div><dt>LONG TASKS</dt><dd>{scenario ? scenario.frameTiming.longTaskCount : "MEASURING"}</dd></div>
      <div><dt>HOT-PATH WORK</dt><dd>{scenario ? scenario.hotPathActivityZero ? "ZERO" : "FAILED" : "MEASURING"}</dd></div>
      <div><dt>PAINT TRUTH</dt><dd>{scenario ? scenario.receiptTruthPassed ? "PASS" : "FAILED" : "MEASURING"}</dd></div>
      <div><dt>TRANSITIONS</dt><dd>{scenario ? `${scenario.completedTransitions}/${scenario.requestedTransitions}` : "RUNNING"}</dd></div>
      <div><dt>LOOP REPLACE</dt><dd>{scenario ? scenario.replacementStable ? "5/5 STABLE" : "FAILED" : "RUNNING"}</dd></div>
    </dl>
  );
}

function overallStatus(report: Phase4Report): "PASS" | "RUNNING" | "FAIL" {
  if (!report.alignment.allSelectedCorrectGate) return "FAIL";
  if (!report.coexistence.standardLayersBeforeAndAfter) return "FAIL";
  if (report.renderer?.status === "error") return "FAIL";
  if (!report.renderer?.capabilities?.hardwareAcceleration) return "RUNNING";
  const metrics = report.renderer.metrics;
  if (!metrics || metrics.residentFrameCount !== PHASE4_FRAME_COUNT) return "RUNNING";
  if (report.renderer.textureValidationsPassed !== PHASE4_FRAME_COUNT) return "FAIL";
  if (metrics.gpuResourceBytes > GPU_TARGET_BYTES) return "FAIL";
  if (metrics.peakGpuResourceBytes > GPU_HARD_CEILING_BYTES) return "FAIL";
  if (!report.scenario) return "RUNNING";
  if (!report.scenario.hotPathActivityZero) return "FAIL";
  if (!report.scenario.receiptTruthPassed || !report.scenario.replacementStable) return "FAIL";
  if (report.scenario.completedTransitions !== report.scenario.requestedTransitions) return "FAIL";
  if (report.scenario.frameTiming.p95Ms >= 16.7) return "FAIL";
  if (!report.scenario.frameTiming.longTaskObserverAvailable) return "FAIL";
  if (report.scenario.frameTiming.longTaskCount > 0) return "FAIL";
  if (report.scenario.framebufferWidth < 3_840 || report.scenario.framebufferHeight < 2_160) {
    return "FAIL";
  }
  return "PASS";
}

function summarizeFrames(models: readonly RadarSweepCpuModel[]): Phase4FrameSummary {
  return {
    count: models.length,
    firstObservedAtUnixMs: models[0].observedAtUnixMs,
    lastObservedAtUnixMs: models[models.length - 1].observedAtUnixMs,
    cpuBytes: models.reduce((total, model) => total + model.cpuBytes, 0),
    projectedGpuBytes: models.reduce((total, model) => total + model.estimatedGpuBytes, 0),
    distinctObservationCount: new Set(models.map((model) => model.observationId)).size,
  };
}

function subtractActivity(
  after: Phase4ActivitySnapshot,
  before: Phase4ActivitySnapshot,
): Phase4ActivitySnapshot {
  return {
    networkRequests: after.networkRequests - before.networkRequests,
    diskReads: after.diskReads - before.diskReads,
    decoderRuns: after.decoderRuns - before.decoderRuns,
    normalizationRuns: after.normalizationRuns - before.normalizationRuns,
    bulkIpcTransfers: after.bulkIpcTransfers - before.bulkIpcTransfers,
    bulkIpcBytes: after.bulkIpcBytes - before.bulkIpcBytes,
  };
}

function isZeroActivity(activity: Phase4ActivitySnapshot): boolean {
  return Object.values(activity).every((value) => value === 0);
}

function rendererActivity(snapshot: RadarRendererSnapshot): RendererActivitySnapshot {
  return {
    frameUploadCount: snapshot.metrics?.frameUploadCount ?? 0,
    frameUploadBytes: snapshot.metrics?.frameUploadBytes ?? 0,
  };
}

function exerciseCamera(map: MapLibreMap, model: RadarSweepCpuModel, transition: number) {
  const cycle = Math.floor(transition / 8);
  const zooms = [5.0, 5.8, 6.4, 8.0];
  const longitude = model.center.longitude + Math.sin(cycle * 0.7) * 1.1;
  const latitude = model.center.latitude + Math.cos(cycle * 0.5) * 0.65;
  map.jumpTo({
    center: [longitude, latitude],
    zoom: zooms[cycle % zooms.length],
    bearing: 0,
    pitch: 0,
  });
}

function readHeapBytes(): number | null {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  }).memory;
  return typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function InterrogationReadout({ value }: { value: GateInterrogation | null }) {
  if (!value) {
    return <p className="gate-readout"><span>POINT QUERY</span> NO MEASURED GATE</p>;
  }
  return (
    <p className="gate-readout">
      <span>POINT QUERY</span>
      R{value.radialIndex} / G{value.gateIndex} / {value.status === "valid"
        ? `${value.value?.toFixed(1)} ${value.units}`
        : value.status.replace("_", " ").toUpperCase()}
    </p>
  );
}

function installDiagnosticLayers(
  map: MapLibreMap,
  model: RadarSweepCpuModel,
  alignment: AlignmentReport,
  radarLayer: RadarCustomLayer,
  beforeId: string | undefined,
): void {
  const ring = Array.from({ length: 181 }, (_, index) => {
    const point = destinationPoint(model.center, index * 2, model.maxRangeM);
    return [point.longitude, point.latitude];
  });
  map.addSource(RANGE_SOURCE_ID, {
    type: "geojson",
    data: {
      type: "Feature",
      properties: { role: "range-boundary" },
      geometry: { type: "LineString", coordinates: ring },
    },
  });
  addLayer(map, {
    id: RANGE_LAYER_ID,
    type: "line",
    source: RANGE_SOURCE_ID,
    paint: {
      "line-color": "#5ed7e8",
      "line-width": 1,
      "line-opacity": 0.28,
      "line-dasharray": [3, 3],
    },
  }, beforeId);
  addLayer(map, radarLayer, beforeId);
  map.addSource(ANCHOR_SOURCE_ID, {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: alignment.anchors.map((anchor) => ({
        type: "Feature" as const,
        properties: { id: anchor.id, radial: anchor.radialIndex, gate: anchor.gateIndex },
        geometry: {
          type: "Point" as const,
          coordinates: [anchor.longitude, anchor.latitude],
        },
      })),
    },
  });
  addLayer(map, {
    id: ANCHOR_LAYER_ID,
    type: "circle",
    source: ANCHOR_SOURCE_ID,
    paint: {
      "circle-radius": 3,
      "circle-color": "#d8fbff",
      "circle-stroke-color": "#071014",
      "circle-stroke-width": 1,
      "circle-opacity": 0.9,
    },
  }, beforeId);
}

function removeDiagnosticLayers(map: MapLibreMap, radarLayer: RadarCustomLayer | null) {
  if (!map.getStyle()) return;
  for (const id of [ANCHOR_LAYER_ID, radarLayer?.id, RANGE_LAYER_ID]) {
    if (id && map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [ANCHOR_SOURCE_ID, RANGE_SOURCE_ID]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}

function firstSymbolLayer(map: MapLibreMap): string | undefined {
  return map.getStyle().layers?.find((layer) => layer.type === "symbol")?.id;
}

function emptyLayerCoexistenceReport(): LayerCoexistenceReport {
  return evaluateLayerCoexistence([], DIAGNOSTIC_LAYER_IDS);
}

function currentLayerCoexistenceReport(map: MapLibreMap): LayerCoexistenceReport {
  const orderedLayers = map.getLayersOrder().flatMap((id) => {
    const layer = map.getLayer(id);
    return layer ? [{ id, type: layer.type }] : [];
  });
  return evaluateLayerCoexistence(orderedLayers, DIAGNOSTIC_LAYER_IDS);
}

function addLayer(map: MapLibreMap, layer: AddLayerObject, beforeId?: string) {
  if (beforeId) map.addLayer(layer, beforeId);
  else map.addLayer(layer);
}

function formatMiB(bytes: number) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function formatMs(milliseconds: number) {
  return milliseconds.toFixed(1);
}

function Status({ label, value }: { label: string; value: string }) {
  return (
    <div className="status">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

declare global {
  var __MISTR_PHASE4__: undefined | {
    report(): Phase4Report;
    runScenario(transitionCount?: number): Promise<Phase4ScenarioReport>;
    play(): void;
    pause(): void;
    step(): Promise<RadarPaintReceipt>;
    scrub(index: number): Promise<RadarPaintReceipt>;
    setCamera(longitude: number, latitude: number, zoom: number): void;
    layerOrder(): string[];
  };
}
