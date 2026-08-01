import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type {
  AddLayerObject,
  Map as MapLibreMap,
  MapMouseEvent,
} from "maplibre-gl";
import { configureMapLibreWorker } from "./mapWorker";
import { updateMapReadiness, type MapReadiness } from "./mapReadiness";
import { PackedSweepTransferClient, tauriInvokeFunction } from "./packed-sweep/transferClient";
import { benchmarkRendererCandidates, type RendererCandidateBenchmark } from "./radar-renderer/candidateBenchmark";
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
  RadarCustomLayer,
  type RadarRendererSnapshot,
} from "./radar-renderer/RadarCustomLayer";
import { getRuntimeSnapshot, type RuntimeSnapshot } from "./runtime";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";
const RANGE_SOURCE_ID = "mistr-range-source";
const RANGE_LAYER_ID = "mistr-range-before-radar";
const ANCHOR_SOURCE_ID = "mistr-anchor-source";
const ANCHOR_LAYER_ID = "mistr-anchors-after-radar";

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
  const [phase3, setPhase3] = useState<Phase3State>({ kind: "idle" });
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
      instance.addControl(
        new maplibregl.AttributionControl({ compact: true }),
        "bottom-right",
      );
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
    let clickHandler: ((event: MapMouseEvent) => void) | null = null;
    let releasePending: (() => Promise<void>) | null = null;
    setPhase3({ kind: "running", stage: "DECODING KTLX" });

    const run = async () => {
      const invoke = await tauriInvokeFunction();
      const client = new PackedSweepTransferClient(invoke);
      await client.open();
      await client.begin(1);
      const lease = await client.requestPhase3Fixture();
      releasePending = lease.release;
      try {
        if (cancelled) return;
        setPhase3({ kind: "running", stage: "BUILDING GPU MODEL" });
        const model = createRadarSweepCpuModel(lease.packed);
        if (model.sourceKind !== "nexrad_level2_archive_ii") {
          throw new Error("Phase 3 requires the real decoded KTLX Level II fixture");
        }
        const candidates = benchmarkRendererCandidates(model.radialCount, model.gateCount);
        const alignment = createAlignmentReport(model);
        let renderer: RadarRendererSnapshot | undefined;
        let baseReport: Omit<Phase3Report, "renderer"> = {
          model: summarizeModel(model),
          candidates,
          alignment,
          coexistence: emptyLayerCoexistenceReport(),
        };
        const publish = () => {
          if (!cancelled) {
            setPhase3({ kind: "complete", report: { ...baseReport, renderer } });
          }
        };
        layer = new RadarCustomLayer(model, {
          onSnapshot(snapshot) {
            renderer = snapshot;
            publish();
          },
        });
        const beforeId = firstSymbolLayer(instance);
        const insertionOrder = installDiagnosticLayers(
          instance,
          model,
          alignment,
          layer,
          beforeId,
        );
        baseReport = {
          ...baseReport,
          coexistence: layerCoexistenceReport(instance, insertionOrder),
        };
        clickHandler = (event) => {
          setInterrogation(interrogateLngLat(model, {
            longitude: event.lngLat.lng,
            latitude: event.lngLat.lat,
          }));
        };
        instance.on("click", clickHandler);
        const initial = alignment.anchors.find((anchor) => anchor.gateIndex > 0)
          ?? alignment.anchors[0];
        setInterrogation(interrogateLngLat(model, {
          longitude: initial.longitude,
          latitude: initial.latitude,
        }));
        instance.jumpTo({
          center: [model.center.longitude, model.center.latitude],
          zoom: 5.8,
          bearing: 0,
          pitch: 0,
        });
        installDiagnosticApi(instance, model, () => ({
          ...baseReport,
          renderer: layer?.getSnapshot() ?? renderer,
        }));
        publish();
      } finally {
        await lease.release();
        releasePending = null;
      }
    };

    void run().catch((error: unknown) => {
      removeDiagnosticLayers(instance, layer);
      if (!cancelled) {
        setPhase3({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return () => {
      cancelled = true;
      if (clickHandler) instance.off("click", clickHandler);
      if (globalThis.__MISTR_PHASE3__) delete globalThis.__MISTR_PHASE3__;
      removeDiagnosticLayers(instance, layer);
      if (releasePending) void releasePending();
    };
  }, [mapLoaded, runtime.shell]);

  const radarStatus = phase3.kind === "complete"
    ? overallStatus(phase3.report)
    : phase3.kind === "error"
      ? "ERROR"
      : phase3.kind === "running"
        ? "RUNNING"
        : "TAURI ONLY";

  return (
    <main className="app-shell">
      <div ref={mapContainer} className="map-surface" aria-label="Mistr map" />
      <header className="top-rail">
        <div>
          <p className="eyebrow">NEXRAD RENDERING EXPERIMENT</p>
          <h1>MISTR <span>PHASE 3</span></h1>
        </div>
        <div className="status-cluster" aria-label="Prototype status">
          <Status label="SHELL" value={runtime.shell.toUpperCase()} />
          <Status label="MAP" value={mapState} />
          <Status label="RADAR GPU" value={radarStatus} />
        </div>
      </header>
      <section className="checkpoint" aria-labelledby="checkpoint-title">
        <p className="eyebrow">CURRENT CHECKPOINT</p>
        <h2 id="checkpoint-title">Static polar GPU renderer</h2>
        <p>
          One decoded KTLX Level II sweep is sampled directly from compact integer
          textures inside a public MapLibre WebGL2 custom layer.
        </p>
        <Phase3Readout state={phase3} />
        <InterrogationReadout value={interrogation} />
      </section>
      <footer className="bottom-rail">
        <span>KTLX / 2024-05-20 23:05Z / 0.48 DEG</span>
        <span className="truth-label">PROTOTYPE - NOT OPERATIONAL</span>
      </footer>
    </main>
  );
}

interface Phase3ModelSummary {
  observationId: string;
  sourceKind: string;
  radialCount: number;
  gateCount: number;
  cpuBytes: number;
  estimatedGpuBytes: number;
}

export interface Phase3Report {
  model: Phase3ModelSummary;
  candidates: RendererCandidateBenchmark;
  alignment: AlignmentReport;
  coexistence: LayerCoexistenceReport;
  renderer?: RadarRendererSnapshot;
}

export interface LayerCoexistenceReport {
  rangeLayerPresent: boolean;
  radarLayerPresent: boolean;
  anchorLayerPresent: boolean;
  expectedInsertionOrder: string[];
  standardLayersBeforeAndAfter: boolean;
}

type Phase3State =
  | { kind: "idle" }
  | { kind: "running"; stage: string }
  | { kind: "complete"; report: Phase3Report }
  | { kind: "error"; message: string };

function Phase3Readout({ state }: { state: Phase3State }) {
  if (state.kind === "error") {
    return <p className="benchmark-error" role="alert">{state.message}</p>;
  }
  if (state.kind !== "complete") {
    return (
      <dl>
        <div><dt>PACKAGED PROBE</dt><dd>{state.kind === "running" ? state.stage : "TAURI REQUIRED"}</dd></div>
        <div><dt>REPRESENTATION</dt><dd>POLAR QUAD</dd></div>
        <div><dt>PLAYBACK</dt><dd>PHASE 4</dd></div>
      </dl>
    );
  }
  const { report } = state;
  const metrics = report.renderer?.metrics;
  const receipt = report.renderer?.paintReceipt;
  return (
    <dl aria-label="Packaged Phase 3 renderer report">
      <div><dt>RESULT</dt><dd>{overallStatus(report)}</dd></div>
      <div><dt>REPRESENTATION</dt><dd>POLAR QUAD / 2 TRI</dd></div>
      <div><dt>GPU RADAR</dt><dd>{formatMiB(report.model.estimatedGpuBytes)} MiB</dd></div>
      <div><dt>UPLOAD</dt><dd>{metrics ? `${formatMs(metrics.uploadMs)} ms` : "WAITING"}</dd></div>
      <div><dt>FIRST PAINT</dt><dd>{receipt ? `${formatMs(receipt.firstPaintLatencyMs)} ms` : "WAITING"}</dd></div>
      <div><dt>DRAW CPU P95</dt><dd>{metrics ? `${formatMs(metrics.drawCpuP95Ms)} ms` : "WAITING"}</dd></div>
      <div><dt>ALIGNMENT</dt><dd>{report.alignment.allSelectedCorrectGate ? `${report.alignment.anchors.length}/${report.alignment.anchors.length} GATES` : "FAILED"}</dd></div>
      <div><dt>GPU TRUTH</dt><dd>{report.renderer?.textureValidation?.allPassed ? "READBACK PASS" : "CHECKING"}</dd></div>
      <div><dt>MAP LAYERS</dt><dd>{report.coexistence.standardLayersBeforeAndAfter ? "BEFORE + AFTER" : "FAILED"}</dd></div>
      <div>
        <dt>GL DEVICE</dt>
        <dd>{report.renderer?.capabilities
          ? report.renderer.capabilities.hardwareAcceleration ? "HARDWARE" : "UNVERIFIED"
          : "CHECKING"}</dd>
      </div>
    </dl>
  );
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

function summarizeModel(model: RadarSweepCpuModel): Phase3ModelSummary {
  return {
    observationId: model.observationId,
    sourceKind: model.sourceKind,
    radialCount: model.radialCount,
    gateCount: model.gateCount,
    cpuBytes: model.cpuBytes,
    estimatedGpuBytes: model.estimatedGpuBytes,
  };
}

function overallStatus(report: Phase3Report): "PASS" | "RUNNING" | "FAIL" {
  if (!report.alignment.allSelectedCorrectGate) return "FAIL";
  if (!report.coexistence.standardLayersBeforeAndAfter) return "FAIL";
  if (report.renderer?.status === "error") return "FAIL";
  if (report.renderer?.status !== "painted") return "RUNNING";
  if (!report.renderer.textureValidation?.allPassed) return "FAIL";
  if (!report.renderer.capabilities?.hardwareAcceleration) return "FAIL";
  if (report.model.estimatedGpuBytes > 16 * 1024 * 1024) return "FAIL";
  return "PASS";
}

function installDiagnosticLayers(
  map: MapLibreMap,
  model: RadarSweepCpuModel,
  alignment: AlignmentReport,
  radarLayer: RadarCustomLayer,
  beforeId: string | undefined,
): string[] {
  const insertionOrder: string[] = [];
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
  insertionOrder.push(RANGE_LAYER_ID);
  addLayer(map, radarLayer, beforeId);
  insertionOrder.push(radarLayer.id);
  map.addSource(ANCHOR_SOURCE_ID, {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: alignment.anchors.map((anchor) => ({
        type: "Feature" as const,
        properties: {
          id: anchor.id,
          radial: anchor.radialIndex,
          gate: anchor.gateIndex,
        },
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
  insertionOrder.push(ANCHOR_LAYER_ID);
  return insertionOrder;
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
  return {
    rangeLayerPresent: false,
    radarLayerPresent: false,
    anchorLayerPresent: false,
    expectedInsertionOrder: [RANGE_LAYER_ID, "mistr-static-radar", ANCHOR_LAYER_ID],
    standardLayersBeforeAndAfter: false,
  };
}

function layerCoexistenceReport(
  map: MapLibreMap,
  insertionOrder = [RANGE_LAYER_ID, "mistr-static-radar", ANCHOR_LAYER_ID],
): LayerCoexistenceReport {
  const expectedInsertionOrder = [RANGE_LAYER_ID, "mistr-static-radar", ANCHOR_LAYER_ID];
  const rangeLayerPresent = map.getLayer(RANGE_LAYER_ID)?.type === "line";
  const radarLayerPresent = map.getLayer("mistr-static-radar")?.type === "custom";
  const anchorLayerPresent = map.getLayer(ANCHOR_LAYER_ID)?.type === "circle";
  return {
    rangeLayerPresent,
    radarLayerPresent,
    anchorLayerPresent,
    expectedInsertionOrder: insertionOrder,
    standardLayersBeforeAndAfter:
      rangeLayerPresent
      && radarLayerPresent
      && anchorLayerPresent
      && insertionOrder.every((id, index) => id === expectedInsertionOrder[index]),
  };
}

function addLayer(map: MapLibreMap, layer: AddLayerObject, beforeId?: string) {
  if (beforeId) map.addLayer(layer, beforeId);
  else map.addLayer(layer);
}

function installDiagnosticApi(
  map: MapLibreMap,
  model: RadarSweepCpuModel,
  report: () => Phase3Report,
) {
  globalThis.__MISTR_PHASE3__ = {
    report,
    setCamera(longitude, latitude, zoom) {
      map.jumpTo({ center: [longitude, latitude], zoom, bearing: 0, pitch: 0 });
    },
    interrogate(longitude, latitude) {
      return interrogateLngLat(model, { longitude, latitude });
    },
    layerOrder() {
      return layerCoexistenceReport(map).expectedInsertionOrder;
    },
  };
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
  var __MISTR_PHASE3__: undefined | {
    report(): Phase3Report;
    setCamera(longitude: number, latitude: number, zoom: number): void;
    interrogate(longitude: number, latitude: number): GateInterrogation | null;
    layerOrder(): string[];
  };
}
