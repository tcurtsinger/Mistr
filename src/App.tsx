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
  StyleSpecification,
} from "maplibre-gl";
import fixtureManifest from "../fixtures/manifest.json";
import openFreeMapDarkStyle from "./data/openFreeMapDarkStyle.json";
import { RADAR_SITES } from "./data/radarSites";
import { configureMapLibreWorker } from "./mapWorker";
import { mapReadinessError, updateMapReadiness, type MapReadiness } from "./mapReadiness";
import {
  PackedSweepTransferClient,
  tauriInvokeFunction,
  type Phase4ActivitySnapshot,
  type Phase5LiveTransferEvidence,
  type LiveSweepCursor,
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
import { HIDDEN_DIAGNOSTIC_LAYOUT } from "./radar-renderer/diagnosticLayerStyle";
import {
  evaluateLayerCoexistence,
  type LayerCoexistenceReport,
} from "./radar-renderer/layerCoexistence";
import {
  RadarCustomLayer,
  type RadarDisplayMode,
  type RadarPaintReceipt,
  type RadarRendererSnapshot,
} from "./radar-renderer/RadarCustomLayer";
import { getRuntimeSnapshot, type RuntimeSnapshot } from "./runtime";
import {
  beginLiveDisplay,
  beginLiveRefresh,
  failLiveDisplay,
  initialLiveDisplay,
  publishLiveDisplay,
  retainPaintedFallback,
  type LiveDisplayState,
  type PaintedFrameTruth,
} from "./live/liveDisplayState";
import {
  appendLiveHistory,
  beginLiveHistory,
  MAX_LIVE_HISTORY_FRAMES,
  prependLiveHistory,
} from "./live/liveHistory";
import { SiteRequestTracker } from "./live/siteRequestTracker";
import { RadarChrome } from "./ui/RadarChrome";
import {
  freshnessPresentation,
  liveFailureLabel,
  userFacingRadarError,
  normalizeRadarDisplayMode,
  normalizeRadarSite,
  paintedFrameIndex,
  playbackErrorAfterRendererStatus,
  playbackPresentation,
  radarInitializationLabel,
  rendererFailureMessage,
  type LiveHistoryStatus,
  type TimelineFrame,
} from "./ui/radarChromeModel";

// Keep the style graph local so radar startup never waits for a remote style
// document. Tile, glyph, and sprite resources remain remote, but radar begins
// as soon as MapLibre has installed this local style.
const MAP_STYLE = openFreeMapDarkStyle as StyleSpecification;
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
const RADAR_DISPLAY_MODE_STORAGE_KEY = "mistr.radarDisplayMode";
const RADAR_ENGINE_PREPARING_ERROR = "Radar engine is still preparing the resident loop";
const LIVE_POLL_RETRY_MS = 15_000;

configureMapLibreWorker();

export function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const playbackControllerRef = useRef<ResidentPlaybackController | null>(null);
  const radarLayerRef = useRef<RadarCustomLayer | null>(null);
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
  const [radarHostReady, setRadarHostReady] = useState(false);
  const [phase4, setPhase4] = useState<Phase4State>({ kind: "idle" });
  const [phase5, setPhase5] = useState<Phase5Report>({
    display: initialLiveDisplay(),
  });
  const [interrogation, setInterrogation] = useState<GateInterrogation | null>(null);
  const [inspectionSelected, setInspectionSelected] = useState(false);
  const [paintedSourceKind, setPaintedSourceKind] = useState<RadarSweepCpuModel["sourceKind"]>(
    "nexrad_level2_archive_ii",
  );
  const [timelineFrames, setTimelineFrames] = useState<TimelineFrame[]>([]);
  const [liveHistoryStatus, setLiveHistoryStatus] = useState<LiveHistoryStatus | undefined>();
  const [displayMode, setDisplayMode] = useState<RadarDisplayMode>(restoreRadarDisplayMode);
  const displayModeRef = useRef(displayMode);
  const [selectedSite, setSelectedSite] = useState("KTLX");
  const [requestedSite, setRequestedSite] = useState<string | null>(null);
  const [siteRequestError, setSiteRequestError] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
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
        style: structuredClone(MAP_STYLE),
        center: DEFAULT_CENTER,
        zoom: 5.8,
        bearing: 0,
        pitch: 0,
        attributionControl: false,
        // Keep the basemap's out-of-view vector-tile cache bounded at 4K.
        // Radar observations have their own independently bounded residency.
        maxTileCacheSize: 0,
        maxPitch: 0,
        dragRotate: false,
        touchPitch: false,
        pitchWithRotate: false,
        canvasContextAttributes: { antialias: false },
      });
      instance.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
      instance.once("style.load", () => {
        instance?.setProjection({ type: "mercator" });
        setRadarHostReady(true);
      });
      instance.once("load", () => {
        setMapState((current) => updateMapReadiness(current, "load"));
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
    if (runtime.shell !== "tauri" || !radarHostReady || !instance) return;
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
    let livePollingSession = 0;
    let residentLiveHistory: readonly RadarSweepCpuModel[] | null = null;
    let liveSweepCursor: LiveSweepCursor | null = null;
    let liveBackfillCursor: LiveSweepCursor | null = null;
    let diagnosticHistoryLimit = MAX_LIVE_HISTORY_FRAMES;
    let liveDisplay = initialLiveDisplay();
    let latestPhase5: Phase5Report = { display: liveDisplay };
    const modelsById = new Map<string, RadarSweepCpuModel>();

    const publishPhase5 = (report: Phase5Report) => {
      latestPhase5 = report;
      if (!cancelled) setPhase5(report);
    };

    const synchronizePaintedDisplay = (renderer: RadarRendererSnapshot) => {
      const receipt = renderer.paintReceipt;
      const paintedModel = receipt ? modelsById.get(receipt.observationId) : undefined;
      if (
        !receipt
        || (
          paintedModel?.sourceKind !== "nexrad_level2_archive_ii"
          && paintedModel?.sourceKind !== "nexrad_level2_chunks"
        )
      ) return;
      radarModelRef.current = paintedModel;
      paintedSiteRef.current = paintedModel.siteIcao;
      setPaintedSourceKind(paintedModel.sourceKind);
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
      if (
        baseModels.length !== PHASE4_FRAME_COUNT
        || baseModels.some((model) => model.sourceKind !== "nexrad_level2_archive_ii")
      ) {
        throw new Error("Phase 4 scenario requires the prepared 20-frame archive loop");
      }
      activeScenario = (async () => {
        await activeController.pauseAndWait();
        const rollingGeneration = activeLayer.getSnapshot().generation + 1;
        let rollingModels = [{ ...baseModels[0], generation: BigInt(rollingGeneration) }];
        await activeController.replaceResidentFrames(rollingModels);
        const rollingUploadStart = activeLayer.getSnapshot().metrics?.frameUploadCount ?? 0;
        const rollingResidentCounts: number[] = [];
        const rollingReceipts: RadarPaintReceipt[] = [];
        for (let index = 1; index < baseModels.length; index += 1) {
          rollingModels = [
            ...rollingModels,
            { ...baseModels[index], generation: BigInt(rollingGeneration) },
          ].slice(-5);
          const receipt = await activeController.updateResidentHistory(rollingModels);
          rollingReceipts.push(receipt);
          rollingResidentCounts.push(activeLayer.getSnapshot().metrics?.residentFrameCount ?? 0);
        }
        const expectedRollingIds = rollingModels.map((model) => model.observationId);
        const scrubOldest = await activeController.scrub(0);
        const scrubNewest = await activeController.scrub(rollingModels.length - 1);
        const beforeRollingRecovery = activeLayer.getSnapshot();
        const rollingRecovery = await activeLayer.simulateContextResetForTest(100);
        const afterRollingRecovery = activeLayer.getSnapshot();
        const rollingUploadEnd = beforeRollingRecovery.metrics?.frameUploadCount ?? 0;
        const rollingHistory: Phase4RollingHistoryEvidence = {
          requestedUpdates: baseModels.length - 1,
          completedUpdates: rollingReceipts.length,
          uploadCountDelta: rollingUploadEnd - rollingUploadStart,
          residentCounts: rollingResidentCounts,
          finalResidentObservationIds: beforeRollingRecovery.residentObservationIds,
          recoveredResidentObservationIds: afterRollingRecovery.residentObservationIds,
          oldestScrubObservationId: scrubOldest.observationId,
          newestScrubObservationId: scrubNewest.observationId,
          contextEpochBefore: beforeRollingRecovery.contextEpoch,
          contextEpochAfter: afterRollingRecovery.contextEpoch,
          recovery: rollingRecovery,
          passed: rollingReceipts.length === baseModels.length - 1
            && rollingReceipts.every((receipt, index) => (
              receipt.generation === rollingGeneration
              && receipt.observationId === baseModels[index + 1].observationId
            ))
            && rollingUploadEnd - rollingUploadStart === baseModels.length - 1
            && rollingResidentCounts.every((count, index) => count === Math.min(index + 2, 5))
            && arraysEqual(beforeRollingRecovery.residentObservationIds, expectedRollingIds)
            && sameMembers(afterRollingRecovery.residentObservationIds, expectedRollingIds)
            && scrubOldest.observationId === expectedRollingIds[0]
            && scrubNewest.observationId === expectedRollingIds.at(-1)
            && rollingRecovery.phase === "ready"
            && afterRollingRecovery.contextEpoch === beforeRollingRecovery.contextEpoch + 1
            && afterRollingRecovery.lastPaintedObservationId === scrubNewest.observationId,
        };
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
          rollingHistory,
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
      const archiveModels: RadarSweepCpuModel[] = [];
      const decodeArchiveFixture = async (fixtureId: string) => {
        if (!client) throw new Error("archive transfer client is unavailable");
        const lease = await client.requestPhase4Fixture(fixtureId);
        try {
          const model = createRadarSweepCpuModel(lease.packed);
          if (model.sourceKind !== "nexrad_level2_archive_ii" || model.siteIcao !== "KTLX") {
            throw new Error("Phase 4 accepts real KTLX Level II observations only");
          }
          return model;
        } finally {
          await lease.release();
        }
      };
      // Paint one known-safe bundled observation first. Loading all twenty raw
      // archives before the first paint made development startup take roughly
      // a minute and delayed live radar for work the normal product path does
      // not need. The full loop is hydrated only for its packaged diagnostics.
      setPhase4({ kind: "running", stage: "LOADING NEWEST SAFE SCAN" });
      const newestArchiveModel = await decodeArchiveFixture(fixtureIds[fixtureIds.length - 1]);
      archiveModels.push(newestArchiveModel);
      modelsById.set(newestArchiveModel.observationId, newestArchiveModel);

      const hydrateArchiveLoop = async () => {
        if (archiveModels.length === PHASE4_FRAME_COUNT) return archiveModels;
        const existingIds = new Set(archiveModels.map((model) => model.observationId));
        for (let index = 0; index < fixtureIds.length; index += 1) {
          if (cancelled) throw new Error("archive hydration was cancelled");
          const fixtureId = fixtureIds[index];
          if (fixtureId === fixtureIds[fixtureIds.length - 1]) continue;
          setPhase4({
            kind: "running",
            stage: `DECODING OBSERVATION ${index + 1}/${fixtureIds.length}`,
          });
          const model = await decodeArchiveFixture(fixtureId);
          if (!existingIds.has(model.observationId)) {
            archiveModels.push(model);
            existingIds.add(model.observationId);
          }
        }
        archiveModels.sort((left, right) => left.observedAtUnixMs - right.observedAtUnixMs);
        if (
          archiveModels.length !== PHASE4_FRAME_COUNT
          || new Set(archiveModels.map((model) => model.observationId)).size !== PHASE4_FRAME_COUNT
        ) {
          throw new Error("Phase 4 fixture loop does not contain 20 distinct observations");
        }
        return archiveModels;
      };
      const diagnosticModel = newestArchiveModel;
      radarModelRef.current = diagnosticModel;
      setTimelineFrames([timelineFrame(diagnosticModel)]);
      const alignment = createAlignmentReport(diagnosticModel);
      latestReport = {
        frames: summarizeFrames([diagnosticModel]),
        alignment,
        coexistence: emptyLayerCoexistenceReport(),
      };
      layer = new RadarCustomLayer([diagnosticModel], {
        displayMode,
        recoveryBeforeLayerId: ANCHOR_LAYER_ID,
        onSnapshot(renderer) {
          if (renderer.displayMode !== displayModeRef.current) {
            displayModeRef.current = renderer.displayMode;
            setDisplayMode(renderer.displayMode);
            storeRadarDisplayMode(renderer.displayMode);
          }
          setPlaybackError((current) => playbackErrorAfterRendererStatus(current, renderer.status));
          synchronizePaintedDisplay(renderer);
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
      radarLayerRef.current = layer;
      const beforeId = firstSymbolLayer(instance);
      installDiagnosticLayers(instance, diagnosticModel, alignment, layer, beforeId);
      publish({ coexistence: currentLayerCoexistenceReport(instance) });
      controller = new ResidentPlaybackController(layer, [diagnosticModel], {
        onState(playback) {
          publish({ playback, renderer: layer?.getSnapshot() });
        },
      });
      playbackControllerRef.current = controller;
      const initialReceipt = await controller.establishInitialPaint();
      const newestReceipt = initialReceipt;
      const initialModel = modelsById.get(newestReceipt.observationId);
      if (!initialModel) throw new Error("newest painted archive frame is unknown");
      paintedSiteRef.current = initialModel.siteIcao;
      radarModelRef.current = initialModel;
      setPaintedSourceKind(initialModel.sourceKind);
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
          setInspectionSelected(false);
          return;
        }
        setInspectionSelected(true);
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
      setInspectionSelected(false);
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
        setDisplayMode(mode) {
          layer?.setDisplayMode(mode);
          setDisplayMode(mode);
        },
        isolateRadarForEvidence() {
          const radarLayerId = layer?.id;
          for (const layerId of instance.getLayersOrder()) {
            if (layerId !== radarLayerId) {
              instance.setLayoutProperty(layerId, "visibility", "none");
            }
          }
        },
        prepareArchive: () => prepareArchiveForDiagnostics?.()
          ?? Promise.reject(new Error("archive diagnostic preparation is unavailable")),
        settleMap: (timeoutMs) => waitForMapIdle(instance, timeoutMs),
        layerOrder: () => currentLayerCoexistenceReport(instance).actualDiagnosticOrder,
      };
      const acquireLive = async (
        site: string,
        freshOnly = false,
        timeoutSeconds = freshOnly ? 900 : 180,
        historyDirection: "after" | "before" = "after",
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
        const appendingHistory = freshOnly
          && historyDirection === "after"
          && residentLiveHistory?.[0]?.siteIcao === site
          && residentLiveHistory[0].sourceKind === "nexrad_level2_chunks"
          && liveSweepCursor !== null;
        const prependingHistory = freshOnly
          && historyDirection === "before"
          && residentLiveHistory?.[0]?.siteIcao === site
          && residentLiveHistory[0].sourceKind === "nexrad_level2_chunks"
          && liveBackfillCursor !== null;
        if (!prependingHistory) {
          liveDisplay = appendingHistory
            ? beginLiveRefresh(liveDisplay, generation, site)
            : beginLiveDisplay(liveDisplay, generation, site, freshOnly);
          publishPhase5(appendingHistory
            ? { ...latestPhase5, display: liveDisplay }
            : { display: liveDisplay });
        }
        let lease: Awaited<ReturnType<PackedSweepTransferClient["requestPhase5Live"]>> | undefined;
        let stagedObservationId: string | undefined;
        let priorStagedModel: RadarSweepCpuModel | undefined;
        try {
          await activeClient.begin(generation);
          lease = await activeClient.requestPhase5Live(
            site,
            freshOnly,
            timeoutSeconds,
            prependingHistory
              ? liveBackfillCursor ?? undefined
              : appendingHistory
                ? liveSweepCursor ?? undefined
                : undefined,
            historyDirection,
          );
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
          const ownershipCheck = () => {
            if (transferGeneration !== generation) {
              throw new Error(`live generation ${generation} was superseded before GPU publication`);
            }
          };
          let nextHistory: readonly RadarSweepCpuModel[];
          let receipt: RadarPaintReceipt;
          if (prependingHistory && residentLiveHistory) {
            const update = prependLiveHistory(residentLiveHistory, model);
            nextHistory = update.frames;
            if (update.prepended) {
              const normalizedModel = nextHistory[0];
              stagedObservationId = normalizedModel.observationId;
              priorStagedModel = modelsById.get(stagedObservationId);
              modelsById.set(stagedObservationId, normalizedModel);
              receipt = await activeController.updateResidentHistory(nextHistory, ownershipCheck);
            } else {
              ownershipCheck();
              const currentReceipt = activeLayer.getSnapshot().paintReceipt;
              if (!currentReceipt) throw new Error("resident live history has no painted frame");
              receipt = currentReceipt;
            }
          } else if (appendingHistory && residentLiveHistory) {
            const update = appendLiveHistory(residentLiveHistory, model);
            nextHistory = update.frames;
            if (update.appended) {
              const normalizedModel = nextHistory[nextHistory.length - 1];
              stagedObservationId = normalizedModel.observationId;
              priorStagedModel = modelsById.get(stagedObservationId);
              modelsById.set(stagedObservationId, normalizedModel);
              receipt = await activeController.updateResidentHistory(nextHistory, ownershipCheck);
            } else {
              ownershipCheck();
              const currentReceipt = activeLayer.getSnapshot().paintReceipt;
              if (!currentReceipt) throw new Error("resident live history has no painted frame");
              receipt = currentReceipt;
            }
          } else {
            nextHistory = beginLiveHistory(model, generation);
            const normalizedModel = nextHistory[0];
            stagedObservationId = normalizedModel.observationId;
            priorStagedModel = modelsById.get(stagedObservationId);
            modelsById.set(stagedObservationId, normalizedModel);
            receipt = await activeController.replaceResidentFrames(nextHistory, ownershipCheck);
          }
          ownershipCheck();
          const rendererGeneration = Number(nextHistory[0].generation);
          const paintedModel = nextHistory.find(
            (candidate) => candidate.observationId === receipt.observationId,
          );
          if (!paintedModel || receipt.generation !== rendererGeneration) {
            throw new Error("GPU paint receipt does not match resident live history");
          }
          residentLiveHistory = nextHistory;
          const receivedCursor = {
            volumeIndex: evidence.safe.volumeIndex,
            volumeStartedAtUnixMs: evidence.safe.volumeStartedAtUnixMs,
          };
          if (prependingHistory) liveBackfillCursor = receivedCursor;
          else liveSweepCursor = receivedCursor;
          if (!appendingHistory && !prependingHistory) {
            liveBackfillCursor = receivedCursor;
          }
          modelsById.clear();
          nextHistory.forEach((residentModel) => {
            modelsById.set(residentModel.observationId, residentModel);
          });
          paintedSiteRef.current = paintedModel.siteIcao;
          radarModelRef.current = paintedModel;
          setPaintedSourceKind(paintedModel.sourceKind);
          setTimelineFrames(nextHistory.map(timelineFrame));
          if (!appendingHistory && !prependingHistory) {
            inspectionMarkerRef.current?.remove();
            inspectionMarkerRef.current = null;
            inspectionPointRef.current = null;
            interrogationObservationRef.current = null;
            setInterrogation(null);
            setInspectionSelected(false);
          }
          if (!prependingHistory) {
            liveDisplay = publishLiveDisplay(
              liveDisplay,
              generation,
              frameTruth(paintedModel, receipt),
            );
          }
          const renderer = activeLayer.getSnapshot();
          // A predecessor extends resident history without publishing that
          // older scan as the displayed live observation. Preserve the prior
          // evidence/receipt/renderer publication trio and expose the
          // background history transfer separately. Otherwise the diagnostic
          // report would falsely pair an older acquisition with the retained
          // visible scan's paint receipt.
          let report: Phase5Report = prependingHistory
            ? {
                ...latestPhase5,
                display: liveDisplay,
                historyUpdate: {
                  evidence,
                  retainedVisibleReceipt: receipt,
                  transferTiming: lease.timing,
                  renderer,
                },
                history: liveHistoryReport(nextHistory),
              }
            : {
                display: liveDisplay,
                evidence,
                receipt,
                transferTiming: lease.timing,
                renderer,
                history: liveHistoryReport(nextHistory),
              };
          // GPU paint is authoritative even if auxiliary MapLibre diagnostics
          // disappear during a style lifecycle. Publish that truth first.
          publishPhase5(report);
          try {
            updateDiagnosticSources(
              instance,
              paintedModel,
              createAlignmentReport(paintedModel),
            );
            if (!appendingHistory && !prependingHistory) focusRadar(instance, paintedModel);
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
          if (stagedObservationId) {
            if (priorStagedModel) modelsById.set(stagedObservationId, priorStagedModel);
            else modelsById.delete(stagedObservationId);
          }
          if (!prependingHistory && transferGeneration === generation) {
            const priorDisplay = liveDisplay;
            const failedDisplay = failLiveDisplay(
              liveDisplay,
              generation,
              error instanceof Error ? error.message : String(error),
            );
            liveDisplay = failedDisplay;
            if (failedDisplay !== priorDisplay) publishPhase5({ display: failedDisplay });
          }
          throw error;
        } finally {
          await lease?.release();
        }
      };
      const runLivePolling = async (site: string, pollingSession: number) => {
        while (!cancelled && pollingSession === livePollingSession) {
          try {
            await acquireLive(site, true);
            if (
              !cancelled
              && pollingSession === livePollingSession
              && residentLiveHistory?.length === MAX_LIVE_HISTORY_FRAMES
            ) {
              setLiveHistoryStatus("full");
            }
          } catch {
            if (cancelled || pollingSession !== livePollingSession) return;
            await delay(LIVE_POLL_RETRY_MS);
          }
        }
      };
      const runLiveBackfill = async (
        site: string,
        pollingSession: number,
        historyLimit: number,
      ): Promise<boolean> => {
        while (
          !cancelled
          && pollingSession === livePollingSession
          && residentLiveHistory
          && residentLiveHistory.length < historyLimit
        ) {
          try {
            await acquireLive(site, true, 30, "before");
            if (!cancelled && pollingSession === livePollingSession) {
              setLiveHistoryStatus(
                residentLiveHistory.length >= MAX_LIVE_HISTORY_FRAMES ? "full" : "loading",
              );
            }
          } catch {
            // A missing/replaced ring predecessor is not a live-radar failure.
            // Preserve the current painted observation and the history already
            // loaded, then continue waiting for future scans.
            if (!cancelled && pollingSession === livePollingSession) {
              setLiveHistoryStatus("partial");
            }
            return false;
          }
        }
        const residentCount = residentLiveHistory?.length ?? 0;
        const reachedHistoryLimit = !cancelled
          && pollingSession === livePollingSession
          && residentCount >= historyLimit;
        if (reachedHistoryLimit) {
          setLiveHistoryStatus(
            residentCount >= MAX_LIVE_HISTORY_FRAMES ? "full" : "partial",
          );
        }
        return reachedHistoryLimit && historyLimit < MAX_LIVE_HISTORY_FRAMES;
      };
      const startLiveSession = async (site: string): Promise<Phase5Report> => {
        const pollingSession = livePollingSession + 1;
        const historyLimit = diagnosticHistoryLimit;
        livePollingSession = pollingSession;
        liveSweepCursor = null;
        liveBackfillCursor = null;
        setLiveHistoryStatus(undefined);
        const report = await acquireLive(site, false);
        if (!cancelled && pollingSession === livePollingSession) {
          setLiveHistoryStatus("loading");
          void runLiveBackfill(site, pollingSession, historyLimit).then((stoppedAtLimit) => {
            if (!cancelled && pollingSession === livePollingSession && !stoppedAtLimit) {
              void runLivePolling(site, pollingSession);
            }
          });
        }
        return report;
      };
      acquireLiveRef.current = (site) => startLiveSession(site);
      setSiteSelectionReady(true);
      setSiteRequestError((current) => (
        current === RADAR_ENGINE_PREPARING_ERROR ? null : current
      ));
      globalThis.__MISTR_PHASE5__ = {
        report: () => latestPhase5,
        setHistoryLimitForDiagnostics: (frameCount) => {
          if (
            !Number.isSafeInteger(frameCount)
            || frameCount < 4
            || frameCount > MAX_LIVE_HISTORY_FRAMES
          ) {
            throw new Error("diagnostic history limit must be between 4 and 20 frames");
          }
          diagnosticHistoryLimit = frameCount;
        },
        startSession: async (site) => {
          const normalized = normalizeRadarSite(site);
          selectedSiteRef.current = normalized;
          const report = await startLiveSession(normalized);
          if (!cancelled) setSelectedSite(normalized);
          return report;
        },
        stopSession: async () => {
          livePollingSession += 1;
          if (!client || !layer) return latestPhase5;
          const generation = Math.max(
            transferGeneration + 1,
            layer.getSnapshot().generation + 1,
          );
          transferGeneration = generation;
          await client.begin(generation);
          if (residentLiveHistory) {
            setLiveHistoryStatus(
              residentLiveHistory.length >= MAX_LIVE_HISTORY_FRAMES ? "full" : "partial",
            );
          }
          return latestPhase5;
        },
        acquire: (site, freshOnly, timeoutSeconds) => {
          livePollingSession += 1;
          return acquireLive(site, freshOnly, timeoutSeconds);
        },
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
        livePollingSession += 1;
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
          residentLiveHistory = null;
          liveSweepCursor = null;
          liveBackfillCursor = null;
          setLiveHistoryStatus(undefined);
          modelsById.clear();
          modelsById.set(model.observationId, model);
          radarModelRef.current = model;
          setPaintedSourceKind(model.sourceKind);
          setTimelineFrames([timelineFrame(model)]);
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
        livePollingSession += 1;
        const generation = Math.max(
          transferGeneration + 1,
          layer.getSnapshot().generation + 1,
        );
        transferGeneration = generation;
        await client.begin(generation);
        await startupAcquisition?.catch(() => {});

        const hydratedArchive = await hydrateArchiveLoop();
        const preparedArchiveModels = hydratedArchive.map((model) => ({
          ...model,
          generation: BigInt(generation),
        }));
        const receipt = await controller.replaceResidentFrames(preparedArchiveModels);
        const paintedModel = preparedArchiveModels.find(
          (model) => model.observationId === receipt.observationId,
        );
        if (!paintedModel) throw new Error("prepared archive paint receipt is unknown");

        modelsById.clear();
        residentLiveHistory = null;
        liveSweepCursor = null;
        liveBackfillCursor = null;
        setLiveHistoryStatus(undefined);
        preparedArchiveModels.forEach((model) => modelsById.set(model.observationId, model));
        paintedSiteRef.current = paintedModel.siteIcao;
        selectedSiteRef.current = paintedModel.siteIcao;
        radarModelRef.current = paintedModel;
        setPaintedSourceKind(paintedModel.sourceKind);
        updateDiagnosticSources(instance, paintedModel, createAlignmentReport(paintedModel));
        setSelectedSite(paintedModel.siteIcao);
        setRequestedSite(null);
        setSiteRequestError(null);
        setTimelineFrames(preparedArchiveModels.map(timelineFrame));
        liveDisplay = initialLiveDisplay(frameTruth(paintedModel, receipt));
        publishPhase5({ display: liveDisplay });
        publish({
          frames: summarizeFrames(preparedArchiveModels),
          renderer: layer.getSnapshot(),
          playback: controller.snapshot(),
          activityAtResidency: await client.phase4ActivitySnapshot(),
        });
        return receipt;
      };
      // The packaged archive is a safe first paint, not a permanent demo mode.
      // Every launch proceeds to current live radar; a stored site chooses the
      // target and a fresh profile starts with KTLX.
      const startupSite = selectedSiteRef.current;
      const requestSequence = siteRequestTrackerRef.current.begin();
      setRequestedSite(startupSite);
      startupAcquisition = startLiveSession(startupSite).then(
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
      livePollingSession += 1;
      siteRequestTrackerRef.current.invalidate();
      controller?.dispose();
      if (playbackControllerRef.current === controller) playbackControllerRef.current = null;
      if (radarLayerRef.current === layer) radarLayerRef.current = null;
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
  }, [radarHostReady, runtime.shell]);

  const playback = phase4.kind === "complete" ? phase4.report.playback : undefined;
  const frameIndex = paintedFrameIndex(timelineFrames, playback);
  const displayedAtUnixMs = playback?.playheadObservedAtUnixMs
    ?? phase5.display.lastComplete?.observedAtUnixMs;
  const playbackLabel = playbackPresentation(
    playback,
    frameIndex,
    timelineFrames.length,
    liveHistoryStatus,
  );
  const initializationError = phase4.kind === "error" ? phase4.message : null;
  const rendererError = phase4.kind === "complete"
    ? rendererFailureMessage(phase4.report.renderer)
    : null;
  const mapError = mapReadinessError(mapState);
  const radarUnavailableError = initializationError ?? rendererError;
  const freshnessSource = radarUnavailableError || siteRequestError || playbackError
    ? "error"
    : phase5.display.kind === "acquiring"
      ? "updating"
      : phase5.display.kind === "degraded"
        ? "error"
        : paintedSourceKind === "nexrad_level3_n0s"
          || (
            paintedSourceKind === "nexrad_level2_archive_ii"
            && timelineFrames.length === 1
          )
          ? "archive_frame"
          : phase5.display.kind === "painted" || phase5.display.kind === "refreshing"
            ? "live"
          : displayedAtUnixMs === undefined
            ? "waiting"
            : "archive";
  const freshness = freshnessPresentation(freshnessSource, displayedAtUnixMs, nowUnixMs);
  if (freshnessSource === "updating") {
    freshness.label = `UPDATING ${requestedSite ?? selectedSite}`;
  } else if (phase5.display.kind === "degraded") {
    const failedSite = phase5.display.requestedSite;
    const retrying = phase5.display.lastComplete?.source === "nexrad_level2_chunks"
      && phase5.display.lastComplete.site === failedSite;
    freshness.label = liveFailureLabel(failedSite, retrying);
  }
  const liveFailureSite = phase5.display.kind === "degraded"
    ? phase5.display.requestedSite
    : undefined;
  const liveRetrying = phase5.display.kind === "degraded"
    && phase5.display.lastComplete?.source === "nexrad_level2_chunks"
    && phase5.display.lastComplete.site === liveFailureSite;
  const userFacingError = initializationError
    ? userFacingRadarError("initialization")
    : rendererError
      ? userFacingRadarError("renderer")
      : playbackError
        ? userFacingRadarError("playback")
        : liveFailureSite
          ? userFacingRadarError(liveRetrying ? "live_retrying" : "live_unavailable", liveFailureSite)
          : siteRequestError
            ? siteRequestError === RADAR_ENGINE_PREPARING_ERROR
              ? userFacingRadarError("initialization")
              : userFacingRadarError("live_unavailable", selectedSite)
            : null;
  const preparingFailed = displayedAtUnixMs === undefined && Boolean(radarUnavailableError);
  const preparingLabel = displayedAtUnixMs === undefined
    ? preparingFailed
      ? "NO RADAR SCAN DISPLAYED"
      : radarInitializationLabel(phase4.kind === "running" ? phase4.stage : undefined)
    : undefined;
  const pendingSite = phase5.display.kind === "acquiring"
    ? phase5.display.requestedSite
    : undefined;
  const displayedSite = phase5.display.lastComplete?.site ?? selectedSite;
  const displayedSource = paintedSourceKind === "nexrad_level2_chunks" ? "live radar" : "archive radar";
  const radarNotice = userFacingError
    ? { kind: "error" as const, message: userFacingError }
    : pendingSite
      ? {
          kind: "info" as const,
          message: `Showing ${displayedSite} ${displayedSource} while ${pendingSite} live radar loads.`,
        }
      : mapError
        ? {
            kind: "info" as const,
            message: "Basemap unavailable. Radar remains available.",
          }
        : liveHistoryStatus === "loading" && paintedSourceKind === "nexrad_level2_chunks"
          ? {
              kind: "info" as const,
              message: `Current ${displayedSite} radar is ready. Loading recent scans.`,
            }
          : undefined;

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
        setPlaybackError(error instanceof Error ? error.message : String(error));
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
    setInspectionSelected(false);
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

  const selectDisplayMode = (mode: RadarDisplayMode) => {
    const layer = radarLayerRef.current;
    if (!layer) return;
    displayModeRef.current = mode;
    layer.setDisplayMode(mode);
    setDisplayMode(mode);
    storeRadarDisplayMode(mode);
  };

  return (
    <main className="app-shell">
      <div ref={mapContainer} className="map-surface" aria-label="Mistr map" />
      <RadarChrome
        appVersion={runtime.appVersion}
        displayedAtUnixMs={displayedAtUnixMs}
        displayMode={displayMode}
        displayModeReady={phase4.kind === "complete" && Boolean(radarLayerRef.current)}
        dismissPanelsSignal={dismissPanelsSignal}
        frameCount={timelineFrames.length}
        frameIndex={frameIndex}
        historyCapacity={paintedSourceKind === "nexrad_level2_chunks"
          ? MAX_LIVE_HISTORY_FRAMES
          : undefined}
        liveHistoryStatus={liveHistoryStatus}
        freshness={freshness}
        interrogation={interrogation}
        inspectionSelected={inspectionSelected}
        mapStatus={mapState}
        onRecenter={recenterRadar}
        onSelectDisplayMode={selectDisplayMode}
        onScrub={queueScrub}
        onSelectSite={selectSite}
        onTogglePlayback={togglePlayback}
        playbackLabel={radarUnavailableError ? "RADAR UNAVAILABLE" : playbackLabel}
        playbackReady={Boolean(playbackControllerRef.current)
          && phase4.kind === "complete"
          && !rendererError
          && !playback?.residentReplacementPending}
        playing={playback?.playing ?? false}
        preparingFailed={preparingFailed}
        preparingLabel={preparingLabel}
        radarNotice={radarNotice}
        selectedSite={selectedSite}
        siteSelectionReady={siteSelectionReady}
        sites={RADAR_SITES}
      />
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

function storeLastSite(site: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_SITE_STORAGE_KEY, site);
  } catch {
    // Storage failure must not block radar selection.
  }
}

function restoreRadarDisplayMode(): RadarDisplayMode {
  try {
    return normalizeRadarDisplayMode(
      globalThis.localStorage?.getItem(RADAR_DISPLAY_MODE_STORAGE_KEY),
    );
  } catch {
    return "smooth";
  }
}

function storeRadarDisplayMode(mode: RadarDisplayMode): void {
  try {
    globalThis.localStorage?.setItem(RADAR_DISPLAY_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage failure must not block changing the radar view.
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
  rollingHistory: Phase4RollingHistoryEvidence;
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

export interface Phase4RollingHistoryEvidence {
  requestedUpdates: number;
  completedUpdates: number;
  uploadCountDelta: number;
  residentCounts: number[];
  finalResidentObservationIds: string[];
  recoveredResidentObservationIds: string[];
  oldestScrubObservationId: string;
  newestScrubObservationId: string;
  contextEpochBefore: number;
  contextEpochAfter: number;
  recovery: RadarRendererSnapshot["recovery"];
  passed: boolean;
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
  historyUpdate?: Phase5HistoryUpdateReport;
  history?: LiveHistoryReport;
  diagnosticsError?: string;
}

export interface Phase5HistoryUpdateReport {
  evidence: Phase5LiveTransferEvidence;
  retainedVisibleReceipt: RadarPaintReceipt;
  transferTiming: TransferTiming;
  renderer: RadarRendererSnapshot;
}

export interface LiveHistoryReport {
  residentCount: number;
  capacity: number;
  partial: boolean;
  observationIds: string[];
  observedAtUnixMs: number[];
  oldestObservationId: string;
  newestObservationId: string;
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

function liveHistoryReport(history: readonly RadarSweepCpuModel[]): LiveHistoryReport {
  if (history.length < 1) throw new Error("live history report requires a resident frame");
  return {
    residentCount: history.length,
    capacity: MAX_LIVE_HISTORY_FRAMES,
    partial: history.length < MAX_LIVE_HISTORY_FRAMES,
    observationIds: history.map((model) => model.observationId),
    observedAtUnixMs: history.map((model) => model.observedAtUnixMs),
    oldestObservationId: history[0].observationId,
    newestObservationId: history[history.length - 1].observationId,
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

function waitForMapIdle(map: MapLibreMap, timeoutMs = 30_000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    return Promise.reject(new RangeError("map idle timeout must be an integer from 1 to 60000 ms"));
  }
  if (!map.isMoving() && map.loaded() && map.areTilesLoaded()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onIdle = () => {
      globalThis.clearTimeout(timeout);
      resolve();
    };
    const timeout = globalThis.setTimeout(() => {
      map.off("idle", onIdle);
      reject(new Error(`map did not settle within ${timeoutMs} ms`));
    }, timeoutMs);
    map.once("idle", onIdle);
  });
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
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
    layout: HIDDEN_DIAGNOSTIC_LAYOUT,
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
    layout: HIDDEN_DIAGNOSTIC_LAYOUT,
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
    settleMap(timeoutMs?: number): Promise<void>;
    play(): void;
    pause(): void;
    step(): Promise<RadarPaintReceipt>;
    scrub(index: number): Promise<RadarPaintReceipt>;
    setCamera(longitude: number, latitude: number, zoom: number): void;
    recenter(): void;
    setDisplayMode(mode: RadarDisplayMode): void;
    isolateRadarForEvidence(): void;
    layerOrder(): string[];
  };
  var __MISTR_PHASE5__: undefined | {
    report(): Phase5Report;
    setHistoryLimitForDiagnostics(frameCount: number): void;
    startSession(site: string): Promise<Phase5Report>;
    stopSession(): Promise<Phase5Report>;
    acquire(site: string, freshOnly?: boolean, timeoutSeconds?: number): Promise<Phase5Report>;
  };
  var __MISTR_PHASE6__: undefined | {
    report(): Phase6Report;
    loadN0s(fixtureId?: string): Promise<Phase6Report>;
    resetContext(holdMs?: number): Promise<Phase6ContextResetReport>;
    resize(): RadarRendererSnapshot | null;
  };
}
