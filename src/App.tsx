/**
 * THESIS: Radar is the stage; four disciplined control zones replace prototype panels and dashboard chrome.
 * OWN-WORLD: Matte night, bounded smoked glass, sparse cue type, and one cobalt-to-rose-to-dawn edge light.
 * STORY: Choose what radar to inspect at the top, inspect the map directly, and control measured time at the bottom.
 * FIRST VIEWPORT: Full-screen radar, compact top context bar, one left menu trigger, and a stable bottom playback bar.
 * FORM: Stormlight Cyclorama catalog challenger; splice-strip scan staging; seed d88dac67. The generated comps guide hierarchy, not literal pixels.
 */
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
  type Phase5LiveTransferEvidence,
  type TransferTiming,
} from "./packed-sweep/transferClient";
import {
  ResidentPlaybackController,
  type PlaybackStateSnapshot,
} from "./playback/ResidentPlaybackController";
import {
  FramePerformanceMonitor,
  summarizeDurations,
  type DurationSummary,
  type FrameTimingSummary,
} from "./playback/performanceMonitor";
import {
  createAlignmentReport,
  createRadarSweepCpuModel,
  interrogateGate,
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
import {
  beginLiveDisplay,
  failLiveDisplay,
  initialLiveDisplay,
  publishLiveDisplay,
  retainPaintedFallback,
  type LiveDisplayState,
  type PaintedFrameTruth,
} from "./live/liveDisplayState";
import { SiteRequestTracker } from "./live/siteRequestTracker";
import { RadarChrome, type RadarSiteOption } from "./ui/RadarChrome";
import {
  freshnessPresentation,
  normalizeRadarSite,
  paintedFrameIndex,
  playbackPresentation,
  type TimelineFrame,
} from "./ui/radarChromeModel";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";
const PHASE4_FRAME_COUNT = 20;
const PHASE4_TRANSITIONS = 1_000;
const PHASE4_REPLACEMENT_ROUNDS = 5;
const RANGE_SOURCE_ID = "mistr-range-source";
const RANGE_LAYER_ID = "mistr-range-before-radar";
const ANCHOR_SOURCE_ID = "mistr-anchor-source";
const ANCHOR_LAYER_ID = "mistr-anchors-after-radar";
const DIAGNOSTIC_LAYER_IDS = {
  range: RANGE_LAYER_ID,
  radar: "mistr-resident-radar",
  anchor: ANCHOR_LAYER_ID,
};
const DEFAULT_CENTER: [number, number] = [-97.27776, 35.333363];
const LAST_SITE_STORAGE_KEY = "mistr.lastRadarSite";
const RADAR_ENGINE_PREPARING_ERROR = "Radar engine is still preparing the resident loop";
const ALPHA_SITES: readonly RadarSiteOption[] = [
  { id: "KTLX", name: "Oklahoma City, Oklahoma" },
  { id: "KOUN", name: "Norman, Oklahoma" },
  { id: "KINX", name: "Tulsa, Oklahoma" },
  { id: "KVNX", name: "Vance AFB, Oklahoma" },
  { id: "KFDR", name: "Frederick, Oklahoma" },
];

configureMapLibreWorker();

export function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const playbackControllerRef = useRef<ResidentPlaybackController | null>(null);
  const selectedSiteRef = useRef(restoreLastSite());
  const siteRequestTrackerRef = useRef(new SiteRequestTracker());
  const paintedSiteRef = useRef("KTLX");
  const radarModelRef = useRef<RadarSweepCpuModel | null>(null);
  const inspectionMarkerRef = useRef<maplibregl.Marker | null>(null);
  const inspectionPointRef = useRef<{ longitude: number; latitude: number } | null>(null);
  const interrogationObservationRef = useRef<string | null>(null);
  const queuedScrubRef = useRef<number | null>(null);
  const scrubRunningRef = useRef(false);
  const acquireLiveRef = useRef<((site: string, freshOnly?: boolean) => Promise<Phase5Report>) | null>(null);
  const [runtime, setRuntime] = useState<RuntimeSnapshot>({
    shell: "browser",
    appVersion: "development",
  });
  const [mapState, setMapState] = useState<MapReadiness>("INITIALIZING");
  const [mapLoaded, setMapLoaded] = useState(false);
  const [phase4, setPhase4] = useState<Phase4State>({ kind: "idle" });
  const [phase5, setPhase5] = useState<Phase5Report>({
    display: initialLiveDisplay(),
  });
  const [interrogation, setInterrogation] = useState<GateInterrogation | null>(null);
  const [timelineFrames, setTimelineFrames] = useState<TimelineFrame[]>([]);
  const [selectedSite, setSelectedSite] = useState("KTLX");
  const [requestedSite, setRequestedSite] = useState<string | null>(null);
  const [siteRequestError, setSiteRequestError] = useState<string | null>(null);
  const [siteSelectionReady, setSiteSelectionReady] = useState(false);
  const [dismissPanelsSignal, setDismissPanelsSignal] = useState(0);
  const [nowUnixMs, setNowUnixMs] = useState(Date.now());

  useEffect(() => {
    void getRuntimeSnapshot().then(setRuntime);
  }, []);

  useEffect(() => {
    const timer = globalThis.setInterval(() => setNowUnixMs(Date.now()), 1_000);
    return () => globalThis.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!mapContainer.current || map.current) return;
    let instance: MapLibreMap | undefined;
    try {
      instance = new maplibregl.Map({
        container: mapContainer.current,
        style: MAP_STYLE,
        center: DEFAULT_CENTER,
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
      instance.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
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
    let startupAcquisition: Promise<void> | null = null;
    let prepareArchiveForDiagnostics: (() => Promise<RadarPaintReceipt>) | null = null;
    let transferGeneration = 1;
    let liveDisplay = initialLiveDisplay();
    let latestPhase5: Phase5Report = { display: liveDisplay };
    const modelsById = new Map<string, RadarSweepCpuModel>();

    const publishPhase5 = (report: Phase5Report) => {
      latestPhase5 = report;
      if (!cancelled) setPhase5(report);
    };

    const synchronizeArchiveFallback = (renderer: RadarRendererSnapshot) => {
      const receipt = renderer.paintReceipt;
      const paintedModel = receipt ? modelsById.get(receipt.observationId) : undefined;
      if (!receipt || paintedModel?.sourceKind !== "nexrad_level2_archive_ii") return;
      const synchronized = retainPaintedFallback(
        liveDisplay,
        frameTruth(paintedModel, receipt),
      );
      if (synchronized === liveDisplay) return;
      liveDisplay = synchronized;
      publishPhase5({ ...latestPhase5, display: synchronized });
    };

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
          await activeController.replaceResidentFrames(baseModels.map((model) => ({
            ...model,
            generation: BigInt(replacementGeneration),
          })));
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
          switchTiming: summarizeDurations(
            receipts.map((receipt) => receipt.residentSwitchLatencyMs),
          ),
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
      radarModelRef.current = diagnosticModel;
      setTimelineFrames(models.map(timelineFrame));
      const alignment = createAlignmentReport(diagnosticModel);
      latestReport = {
        frames: summarizeFrames(models),
        alignment,
        coexistence: emptyLayerCoexistenceReport(),
      };
      layer = new RadarCustomLayer(models, {
        onSnapshot(renderer) {
          synchronizeArchiveFallback(renderer);
          const receipt = renderer.paintReceipt;
          const point = inspectionPointRef.current;
          if (
            receipt
            && point
            && interrogationObservationRef.current !== receipt.observationId
          ) {
            const paintedModel = modelsById.get(receipt.observationId);
            if (paintedModel) {
              interrogationObservationRef.current = receipt.observationId;
              setInterrogation(interrogateLngLat(paintedModel, point));
            }
          }
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
      playbackControllerRef.current = controller;
      const initialReceipt = await controller.establishInitialPaint();
      const newestReceipt = models.length > 1
        ? await controller.scrub(models.length - 1)
        : initialReceipt;
      const initialModel = modelsById.get(newestReceipt.observationId);
      if (!initialModel) throw new Error("newest painted archive frame is unknown");
      paintedSiteRef.current = initialModel.siteIcao;
      radarModelRef.current = initialModel;
      liveDisplay = initialLiveDisplay(frameTruth(initialModel, newestReceipt));
      publishPhase5({ display: liveDisplay });
      const activityAtResidency = await client.phase4ActivitySnapshot();
      publish({
        renderer: layer.getSnapshot(),
        playback: controller.snapshot(),
        activityAtResidency,
      });
      clickHandler = (event) => {
        setDismissPanelsSignal((value) => value + 1);
        const paintedId = layer?.getSnapshot().lastPaintedObservationId;
        const paintedModel = paintedId ? modelsById.get(paintedId) : undefined;
        if (!paintedModel) {
          setInterrogation(null);
          return;
        }
        setInterrogation(interrogateLngLat(paintedModel, {
          longitude: event.lngLat.lng,
          latitude: event.lngLat.lat,
        }));
        inspectionPointRef.current = {
          longitude: event.lngLat.lng,
          latitude: event.lngLat.lat,
        };
        interrogationObservationRef.current = paintedModel.observationId;
        if (!inspectionMarkerRef.current) {
          const element = document.createElement("span");
          element.className = "inspection-marker";
          element.setAttribute("aria-hidden", "true");
          inspectionMarkerRef.current = new maplibregl.Marker({
            anchor: "center",
            element,
          }).setLngLat(event.lngLat).addTo(instance);
        } else {
          inspectionMarkerRef.current.setLngLat(event.lngLat);
        }
      };
      instance.on("click", clickHandler);
      setInterrogation(null);
      focusRadar(instance, diagnosticModel);
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
        recenter() {
          const selectedId = layer?.getSnapshot().selectedObservationId;
          const selectedModel = selectedId ? modelsById.get(selectedId) : undefined;
          focusRadar(instance, selectedModel ?? diagnosticModel);
        },
        prepareArchive: () => prepareArchiveForDiagnostics?.()
          ?? Promise.reject(new Error("archive diagnostic preparation is unavailable")),
        layerOrder: () => currentLayerCoexistenceReport(instance).actualDiagnosticOrder,
      };
      const acquireLive = async (
        site: string,
        freshOnly = false,
        timeoutSeconds = freshOnly ? 900 : 180,
      ): Promise<Phase5Report> => {
        if (!layer || !controller || !client) throw new Error("live renderer is unavailable");
        const activeLayer = layer;
        const activeController = controller;
        const activeClient = client;
        const generation = Math.max(
          transferGeneration + 1,
          activeLayer.getSnapshot().generation + 1,
        );
        transferGeneration = generation;
        liveDisplay = beginLiveDisplay(liveDisplay, generation, site, freshOnly);
        publishPhase5({ display: liveDisplay });
        let lease: Awaited<ReturnType<PackedSweepTransferClient["requestPhase5Live"]>> | undefined;
        try {
          await activeClient.begin(generation);
          lease = await activeClient.requestPhase5Live(site, freshOnly, timeoutSeconds);
          const model = createRadarSweepCpuModel(lease.packed);
          if (model.sourceKind !== "nexrad_level2_chunks" || model.siteIcao !== site) {
            throw new Error("live response does not match the requested NEXRAD site/source");
          }
          const evidence = await activeClient.phase5LiveEvidence(model.observationId);
          if (
            evidence.observationId !== model.observationId
            || evidence.safe.generation !== generation
            || evidence.safe.site !== site
          ) {
            throw new Error("live evidence does not match the decoded response");
          }
          if (transferGeneration !== generation) {
            throw new Error(`live generation ${generation} was superseded before GPU publication`);
          }
          const liveAlignment = createAlignmentReport(model);
          const receipt = await activeController.replaceResidentFrames([model], () => {
            if (transferGeneration !== generation) {
              throw new Error(`live generation ${generation} was superseded before GPU publication`);
            }
          });
          if (receipt.observationId !== model.observationId || receipt.generation !== generation) {
            throw new Error("GPU paint receipt does not match the live sweep");
          }
          modelsById.clear();
          modelsById.set(model.observationId, model);
          paintedSiteRef.current = model.siteIcao;
          radarModelRef.current = model;
          setTimelineFrames([timelineFrame(model)]);
          inspectionMarkerRef.current?.remove();
          inspectionMarkerRef.current = null;
          inspectionPointRef.current = null;
          interrogationObservationRef.current = null;
          setInterrogation(null);
          liveDisplay = publishLiveDisplay(
            liveDisplay,
            generation,
            frameTruth(model, receipt),
          );
          let report: Phase5Report = {
            display: liveDisplay,
            evidence,
            receipt,
            transferTiming: lease.timing,
            renderer: activeLayer.getSnapshot(),
          };
          // GPU paint is authoritative even if auxiliary MapLibre diagnostics
          // disappear during a style lifecycle. Publish that truth first.
          publishPhase5(report);
          try {
            updateDiagnosticSources(instance, model, liveAlignment);
            focusRadar(instance, model);
          } catch (diagnosticError) {
            report = {
              ...report,
              diagnosticsError: diagnosticError instanceof Error
                ? diagnosticError.message
                : String(diagnosticError),
            };
            publishPhase5(report);
          }
          return report;
        } catch (error) {
          const priorDisplay = liveDisplay;
          const failedDisplay = failLiveDisplay(
            liveDisplay,
            generation,
            error instanceof Error ? error.message : String(error),
          );
          liveDisplay = failedDisplay;
          if (failedDisplay !== priorDisplay) publishPhase5({ display: failedDisplay });
          throw error;
        } finally {
          await lease?.release();
        }
      };
      acquireLiveRef.current = (site, freshOnly) => acquireLive(site, freshOnly);
      setSiteSelectionReady(true);
      setSiteRequestError((current) => (
        current === RADAR_ENGINE_PREPARING_ERROR ? null : current
      ));
      globalThis.__MISTR_PHASE5__ = {
        report: () => latestPhase5,
        acquire: acquireLive,
      };
      const phase6Report = (): Phase6Report => {
        if (!layer || !controller) throw new Error("Phase 6 renderer is unavailable");
        const renderer = layer.getSnapshot();
        const model = modelsById.get(renderer.selectedObservationId);
        if (!model) throw new Error("Phase 6 selected observation has no CPU model");
        const validCell = model.statuses.findIndex((status) => status === 0);
        const sample = validCell < 0
          ? undefined
          : interrogateGate(
              model,
              Math.floor(validCell / model.gateCount),
              validCell % model.gateCount,
            );
        return {
          renderer,
          playback: controller.snapshot(),
          product: model.product,
          units: model.units,
          sourceKind: model.sourceKind,
          siteIcao: model.siteIcao,
          observedAtUnixMs: model.observedAtUnixMs,
          sample,
        };
      };
      const loadN0s = async (
        fixtureId = "ktlx-n0s-2024-05-20-230512",
      ): Promise<Phase6Report> => {
        if (!layer || !controller || !client) throw new Error("Phase 6 renderer is unavailable");
        const generation = Math.max(
          transferGeneration + 1,
          layer.getSnapshot().generation + 1,
        );
        transferGeneration = generation;
        await client.begin(generation);
        const lease = await client.requestPhase6N0sFixture(fixtureId);
        try {
          const model = createRadarSweepCpuModel(lease.packed);
          if (
            model.product !== "storm_relative_velocity"
            || model.units !== "kt"
            || model.sourceKind !== "nexrad_level3_n0s"
          ) {
            throw new Error("Phase 6 fixture is not explicit Level III N0S storm-relative velocity");
          }
          const alignment = createAlignmentReport(model);
          await controller.replaceResidentFrames([model]);
          modelsById.clear();
          modelsById.set(model.observationId, model);
          radarModelRef.current = model;
          updateDiagnosticSources(instance, model, alignment);
          const firstValid = model.statuses.findIndex((status) => status === 0);
          if (firstValid >= 0) {
            setInterrogation(interrogateGate(
              model,
              Math.floor(firstValid / model.gateCount),
              firstValid % model.gateCount,
            ));
          }
          focusRadar(instance, model);
          return phase6Report();
        } finally {
          await lease.release();
        }
      };
      globalThis.__MISTR_PHASE6__ = {
        report: phase6Report,
        loadN0s,
        async resetContext(holdMs = 100) {
          if (!layer) throw new Error("Phase 6 renderer is unavailable");
          const before = layer.getSnapshot();
          const recovery = await layer.simulateContextResetForTest(holdMs);
          return { before, recovery, after: layer.getSnapshot() };
        },
        resize() {
          instance.resize();
          return layer?.getSnapshot() ?? null;
        },
      };
      prepareArchiveForDiagnostics = async () => {
        if (!layer || !controller || !client) {
          throw new Error("archive diagnostic preparation is unavailable");
        }
        // Packaged gates reuse the normal WebView profile. Supersede and await
        // any persisted-site startup request before restoring the measured
        // archive loop, so live publication cannot overlap gate measurements.
        siteRequestTrackerRef.current.invalidate();
        const generation = Math.max(
          transferGeneration + 1,
          layer.getSnapshot().generation + 1,
        );
        transferGeneration = generation;
        await client.begin(generation);
        await startupAcquisition?.catch(() => {});

        const archiveModels = models.map((model) => ({
          ...model,
          generation: BigInt(generation),
        }));
        const receipt = await controller.replaceResidentFrames(archiveModels);
        const paintedModel = archiveModels.find(
          (model) => model.observationId === receipt.observationId,
        );
        if (!paintedModel) throw new Error("prepared archive paint receipt is unknown");

        modelsById.clear();
        archiveModels.forEach((model) => modelsById.set(model.observationId, model));
        paintedSiteRef.current = paintedModel.siteIcao;
        selectedSiteRef.current = paintedModel.siteIcao;
        radarModelRef.current = paintedModel;
        setSelectedSite(paintedModel.siteIcao);
        setRequestedSite(null);
        setSiteRequestError(null);
        setTimelineFrames(archiveModels.map(timelineFrame));
        liveDisplay = initialLiveDisplay(frameTruth(paintedModel, receipt));
        publishPhase5({ display: liveDisplay });
        publish({
          renderer: layer.getSnapshot(),
          playback: controller.snapshot(),
          activityAtResidency: await client.phase4ActivitySnapshot(),
        });
        return receipt;
      };
      if (hasStoredSite()) {
        const startupSite = selectedSiteRef.current;
        const requestSequence = siteRequestTrackerRef.current.begin();
        setRequestedSite(startupSite);
        startupAcquisition = acquireLive(startupSite, false).then(
          () => {
            if (siteRequestTrackerRef.current.isCurrent(requestSequence)) {
              setSelectedSite(startupSite);
              setRequestedSite(null);
              storeLastSite(startupSite);
              setSiteRequestError(null);
            }
          },
          (error: unknown) => {
            if (siteRequestTrackerRef.current.isCurrent(requestSequence)) {
              const fallbackSite = paintedSiteRef.current;
              selectedSiteRef.current = fallbackSite;
              setSelectedSite(fallbackSite);
              setRequestedSite(null);
              // A failed refresh does not earn persistence. Keep the last
              // successfully painted live-site preference for the next launch.
              setSiteRequestError(error instanceof Error ? error.message : String(error));
            }
          },
        );
      }
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
      siteRequestTrackerRef.current.invalidate();
      controller?.dispose();
      if (playbackControllerRef.current === controller) playbackControllerRef.current = null;
      if (clickHandler) instance.off("click", clickHandler);
      if (globalThis.__MISTR_PHASE4__) delete globalThis.__MISTR_PHASE4__;
      if (globalThis.__MISTR_PHASE5__) delete globalThis.__MISTR_PHASE5__;
      if (globalThis.__MISTR_PHASE6__) delete globalThis.__MISTR_PHASE6__;
      acquireLiveRef.current = null;
      inspectionMarkerRef.current?.remove();
      inspectionMarkerRef.current = null;
      inspectionPointRef.current = null;
      interrogationObservationRef.current = null;
      removeDiagnosticLayers(instance, layer);
    };
  }, [mapLoaded, runtime.shell]);

  const playback = phase4.kind === "complete" ? phase4.report.playback : undefined;
  const frameIndex = paintedFrameIndex(timelineFrames, playback);
  const displayedAtUnixMs = playback?.playheadObservedAtUnixMs
    ?? phase5.display.lastComplete?.observedAtUnixMs;
  const playbackLabel = playbackPresentation(playback, frameIndex, timelineFrames.length);
  const freshnessSource = phase4.kind === "error" || siteRequestError
    ? "error"
    : phase5.display.kind === "acquiring"
      ? "updating"
      : phase5.display.kind === "painted"
        ? "live"
        : phase5.display.kind === "degraded"
          ? "error"
          : displayedAtUnixMs === undefined
            ? "waiting"
            : "archive";
  const freshness = freshnessPresentation(freshnessSource, displayedAtUnixMs, nowUnixMs);
  if (freshnessSource === "updating") {
    freshness.label = `UPDATING ${requestedSite ?? selectedSite}`;
  }

  const togglePlayback = () => {
    const controller = playbackControllerRef.current;
    if (!controller) return;
    if (controller.snapshot().playing) controller.pause();
    else controller.play();
  };

  const queueScrub = (index: number) => {
    queuedScrubRef.current = index;
    if (scrubRunningRef.current) return;
    scrubRunningRef.current = true;
    void (async () => {
      try {
        while (queuedScrubRef.current !== null) {
          const nextIndex = queuedScrubRef.current;
          queuedScrubRef.current = null;
          await playbackControllerRef.current?.scrub(nextIndex);
        }
      } catch (error) {
        setSiteRequestError(error instanceof Error ? error.message : String(error));
      } finally {
        scrubRunningRef.current = false;
        if (queuedScrubRef.current !== null) queueScrub(queuedScrubRef.current);
      }
    })();
  };

  const selectSite = (site: string) => {
    const normalized = normalizeRadarSite(site);
    const acquire = acquireLiveRef.current;
    if (!acquire) {
      setSiteRequestError(RADAR_ENGINE_PREPARING_ERROR);
      return;
    }
    const requestSequence = siteRequestTrackerRef.current.begin();
    selectedSiteRef.current = normalized;
    setRequestedSite(normalized);
    setSiteRequestError(null);
    setInterrogation(null);
    inspectionMarkerRef.current?.remove();
    inspectionMarkerRef.current = null;
    inspectionPointRef.current = null;
    interrogationObservationRef.current = null;
    void acquire(normalized, false).then(
      () => {
        if (siteRequestTrackerRef.current.isCurrent(requestSequence)) {
          setSelectedSite(normalized);
          setRequestedSite(null);
          storeLastSite(normalized);
          setSiteRequestError(null);
        }
      },
      (error: unknown) => {
        if (siteRequestTrackerRef.current.isCurrent(requestSequence)) {
          const fallbackSite = paintedSiteRef.current;
          selectedSiteRef.current = fallbackSite;
          setSelectedSite(fallbackSite);
          setRequestedSite(null);
          // Preserve the last successful live-site preference when a new
          // request fails, even when an archive fallback is what remains painted.
          setSiteRequestError(error instanceof Error ? error.message : String(error));
        }
      },
    );
  };

  const recenterRadar = () => {
    const instance = map.current;
    const model = radarModelRef.current;
    if (instance && model) focusRadar(instance, model);
  };

  return (
    <main className="app-shell">
      <div ref={mapContainer} className="map-surface" aria-label="Mistr map" />
      <RadarChrome
        appVersion={runtime.appVersion}
        displayedAtUnixMs={displayedAtUnixMs}
        dismissPanelsSignal={dismissPanelsSignal}
        frameCount={timelineFrames.length}
        frameIndex={frameIndex}
        freshness={freshness}
        interrogation={interrogation}
        mapStatus={mapState}
        onRecenter={recenterRadar}
        onScrub={queueScrub}
        onSelectSite={selectSite}
        onTogglePlayback={togglePlayback}
        playbackLabel={phase4.kind === "error" ? "RADAR UNAVAILABLE" : playbackLabel}
        playbackReady={Boolean(playbackControllerRef.current) && phase4.kind === "complete"}
        playing={playback?.playing ?? false}
        selectedSite={selectedSite}
        siteSelectionReady={siteSelectionReady}
        sites={ALPHA_SITES}
      />
      {phase4.kind === "error" ? (
        <p className="benchmark-error sr-only" role="alert">{phase4.message}</p>
      ) : null}
    </main>
  );
}

function timelineFrame(model: RadarSweepCpuModel): TimelineFrame {
  return {
    observationId: model.observationId,
    observedAtUnixMs: model.observedAtUnixMs,
  };
}

function focusRadar(instance: MapLibreMap, model: RadarSweepCpuModel): void {
  const rangeM = model.maxRangeM * 1.05;
  const north = destinationPoint(model.center, 0, rangeM);
  const east = destinationPoint(model.center, 90, rangeM);
  const south = destinationPoint(model.center, 180, rangeM);
  const west = destinationPoint(model.center, 270, rangeM);
  instance.fitBounds(
    [
      [west.longitude, south.latitude],
      [east.longitude, north.latitude],
    ],
    {
      bearing: 0,
      duration: 0,
      maxZoom: 7.5,
      padding: { top: 100, right: 88, bottom: 124, left: 88 },
      pitch: 0,
    },
  );
}

function restoreLastSite(): string {
  try {
    return normalizeRadarSite(globalThis.localStorage?.getItem(LAST_SITE_STORAGE_KEY));
  } catch {
    return "KTLX";
  }
}

function hasStoredSite(): boolean {
  try {
    return globalThis.localStorage?.getItem(LAST_SITE_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function storeLastSite(site: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_SITE_STORAGE_KEY, site);
  } catch {
    // Storage failure must not block radar selection.
  }
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
  switchTiming: DurationSummary;
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

export interface Phase5Report {
  display: LiveDisplayState;
  evidence?: Phase5LiveTransferEvidence;
  receipt?: RadarPaintReceipt;
  transferTiming?: TransferTiming;
  renderer?: RadarRendererSnapshot;
  diagnosticsError?: string;
}

export interface Phase6Report {
  renderer: RadarRendererSnapshot;
  playback: PlaybackStateSnapshot;
  product: RadarSweepCpuModel["product"];
  units: RadarSweepCpuModel["units"];
  sourceKind: RadarSweepCpuModel["sourceKind"];
  siteIcao: string;
  observedAtUnixMs: number;
  sample?: GateInterrogation;
}

export interface Phase6ContextResetReport {
  before: RadarRendererSnapshot;
  recovery: RadarRendererSnapshot["recovery"];
  after: RadarRendererSnapshot;
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

function frameTruth(model: RadarSweepCpuModel, receipt: RadarPaintReceipt): PaintedFrameTruth {
  if (
    model.sourceKind !== "nexrad_level2_archive_ii"
    && model.sourceKind !== "nexrad_level2_chunks"
  ) {
    throw new Error(`unsupported display-truth source ${model.sourceKind}`);
  }
  return {
    observationId: model.observationId,
    site: model.siteIcao,
    source: model.sourceKind,
    observedAtUnixMs: model.observedAtUnixMs,
    paintedAtUnixMs: receipt.completedAtUnixMs,
  };
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

function installDiagnosticLayers(
  map: MapLibreMap,
  model: RadarSweepCpuModel,
  alignment: AlignmentReport,
  radarLayer: RadarCustomLayer,
  beforeId: string | undefined,
): void {
  map.addSource(RANGE_SOURCE_ID, {
    type: "geojson",
    data: rangeFeature(model),
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
    data: anchorFeatures(alignment),
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

function updateDiagnosticSources(
  map: MapLibreMap,
  model: RadarSweepCpuModel,
  alignment: AlignmentReport,
): void {
  const range = map.getSource(RANGE_SOURCE_ID);
  const anchors = map.getSource(ANCHOR_SOURCE_ID);
  if (range?.type !== "geojson" || anchors?.type !== "geojson") {
    throw new Error("radar diagnostic sources are unavailable during site replacement");
  }
  (range as maplibregl.GeoJSONSource).setData(rangeFeature(model));
  (anchors as maplibregl.GeoJSONSource).setData(anchorFeatures(alignment));
}

function rangeFeature(model: RadarSweepCpuModel) {
  const ring = Array.from({ length: 181 }, (_, index) => {
    const point = destinationPoint(model.center, index * 2, model.maxRangeM);
    return [point.longitude, point.latitude];
  });
  return {
    type: "Feature" as const,
    properties: { role: "range-boundary" },
    geometry: { type: "LineString" as const, coordinates: ring },
  };
}

function anchorFeatures(alignment: AlignmentReport) {
  return {
    type: "FeatureCollection" as const,
    features: alignment.anchors.map((anchor) => ({
      type: "Feature" as const,
      properties: { id: anchor.id, radial: anchor.radialIndex, gate: anchor.gateIndex },
      geometry: {
        type: "Point" as const,
        coordinates: [anchor.longitude, anchor.latitude],
      },
    })),
  };
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

function formatMs(milliseconds: number) {
  return milliseconds.toFixed(1);
}

declare global {
  var __MISTR_PHASE4__: undefined | {
    report(): Phase4Report;
    runScenario(transitionCount?: number): Promise<Phase4ScenarioReport>;
    prepareArchive(): Promise<RadarPaintReceipt>;
    play(): void;
    pause(): void;
    step(): Promise<RadarPaintReceipt>;
    scrub(index: number): Promise<RadarPaintReceipt>;
    setCamera(longitude: number, latitude: number, zoom: number): void;
    recenter(): void;
    layerOrder(): string[];
  };
  var __MISTR_PHASE5__: undefined | {
    report(): Phase5Report;
    acquire(site: string, freshOnly?: boolean, timeoutSeconds?: number): Promise<Phase5Report>;
  };
  var __MISTR_PHASE6__: undefined | {
    report(): Phase6Report;
    loadN0s(fixtureId?: string): Promise<Phase6Report>;
    resetContext(holdMs?: number): Promise<Phase6ContextResetReport>;
    resize(): RadarRendererSnapshot | null;
  };
}
