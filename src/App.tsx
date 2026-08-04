/**
 * THESIS: Radar is the stage; a compact tool strip and measured-time instrument keep it sovereign.
 * OWN-WORLD: Matte night, bounded smoked glass, sparse cue type, and one cobalt-to-rose-to-dawn edge light.
 * STORY: Choose what radar to inspect at the top, inspect the map directly, and control measured time at the bottom.
 * FIRST VIEWPORT: Full-screen radar, one icon-led top tool strip, and a stable bottom playback bar.
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
import { radarContextAnchorLayerId } from "./data/radarMapContext";
import { RADAR_SITES } from "./data/radarSites";
import { configureMapLibreWorker } from "./mapWorker";
import { mapReadinessError, updateMapReadiness, type MapReadiness } from "./mapReadiness";
import { assertChunkMatchesManifest } from "./packed-grid/packedGrid";
import {
  acquireAllOrRelease,
  PackedSweepTransferClient,
  tauriInvokeFunction,
  type Phase4ActivitySnapshot,
  type Phase5LiveTransferEvidence,
  type NationalPhase3PrepareReport,
  type NationalPointLookup,
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
import {
  RadarSessionCoordinator,
  siteRadarSource,
  type RadarSourceKey,
  type RadarSessionSnapshot,
} from "./radar-session/RadarSessionCoordinator";
import {
  isRadarSourceSuperseded,
  RadarSourceSupersededError,
  SiteLevel2Session,
} from "./radar-session/SiteLevel2Session";
import { NationalMrmsSession } from "./radar-session/NationalMrmsSession";
import {
  NationalGridLayer,
  type NationalGridRendererSnapshot,
  type NationalPaintReceipt,
} from "./national-radar/NationalGridLayer";
import {
  NationalWorkingSetController,
  type NationalWorkingSetResult,
} from "./national-radar/NationalWorkingSetController";
import { colorForReflectivity } from "./radar-renderer/palette";
import { RadarChrome } from "./ui/RadarChrome";
import {
  frameAgePresentation,
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
const RADAR_SOURCE_STORAGE_KEY = "mistr.radarSource";
const RADAR_DISPLAY_MODE_STORAGE_KEY = "mistr.radarDisplayMode";
const RADAR_ENGINE_PREPARING_ERROR = "Radar engine is still preparing the resident loop";
const LIVE_POLL_RETRY_MS = 15_000;

configureMapLibreWorker();

export function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const playbackControllerRef = useRef<ResidentPlaybackController | null>(null);
  const radarLayerRef = useRef<RadarCustomLayer | null>(null);
  const nationalLayerRef = useRef<NationalGridLayer | null>(null);
  const nationalWorkingSetRef = useRef<NationalWorkingSetController | null>(null);
  const startupSourceRef = useRef(restoreRadarSource());
  const radarSessionCoordinatorRef = useRef<RadarSessionCoordinator | null>(null);
  if (!radarSessionCoordinatorRef.current) {
    radarSessionCoordinatorRef.current = new RadarSessionCoordinator({
      persistPaintedSource(source) {
        storeRadarSource(source);
      },
    });
  }
  const siteLevel2SessionRef = useRef<SiteLevel2Session<Phase5Report> | null>(null);
  const nationalMrmsSessionRef = useRef<NationalMrmsSession<NationalPhase3Report> | null>(null);
  const radarModelRef = useRef<RadarSweepCpuModel | null>(null);
  const inspectionMarkerRef = useRef<maplibregl.Marker | null>(null);
  const inspectionPointRef = useRef<{ longitude: number; latitude: number } | null>(null);
  const interrogationObservationRef = useRef<string | null>(null);
  const inspectionRequestRef = useRef<string | null>(null);
  const queuedScrubRef = useRef<number | null>(null);
  const scrubRunningRef = useRef(false);
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
  const [paintedRadarSource, setPaintedRadarSource] = useState<RadarSourceKey>(
    siteRadarSource("KTLX"),
  );
  const [requestedSourceKind, setRequestedSourceKind] = useState<"site" | "national" | undefined>();
  const [nationalPhase3, setNationalPhase3] = useState<NationalPhase3Report | null>(null);
  const [timelineFrames, setTimelineFrames] = useState<TimelineFrame[]>([]);
  const [liveHistoryStatus, setLiveHistoryStatus] = useState<LiveHistoryStatus | undefined>();
  const [displayMode, setDisplayMode] = useState<RadarDisplayMode>(restoreRadarDisplayMode);
  const displayModeRef = useRef(displayMode);
  const [selectedSite, setSelectedSite] = useState(restoreLastSite());
  const [requestedSite, setRequestedSite] = useState<string | null>(null);
  const [siteRequestError, setSiteRequestError] = useState<string | null>(null);
  const [nationalRequestError, setNationalRequestError] = useState<string | null>(null);
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

  useEffect(() => radarSessionCoordinatorRef.current!.subscribe((snapshot) => {
    synchronizeRadarSourceUi(
      snapshot,
      setRequestedSite,
      setSelectedSite,
      setPaintedRadarSource,
      setRequestedSourceKind,
    );
  }), []);

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
    let siteLevel2Session: SiteLevel2Session<Phase5Report> | null = null;
    let nationalLayer: NationalGridLayer | null = null;
    let nationalWorkingSet: NationalWorkingSetController | null = null;
    let nationalMrmsSession: NationalMrmsSession<NationalPhase3Report> | null = null;
    let nationalRefinement: Promise<NationalWorkingSetResult> | null = null;
    let nationalCoverageVersion = 0;
    let lastNationalCameraKey = nationalCameraKey(instance);
    let pendingNationalCameraKey: string | null = null;
    let nationalMoveHandler: (() => void) | null = null;
    let latestNationalPhase3: NationalPhase3Report | null = null;
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
      const coordinator = radarSessionCoordinatorRef.current!;
      const pending = coordinator.snapshot().transition;
      if (
        pending
        && pending.generation === receipt.generation
        && pending.requestedSource.kind === "site"
        && pending.requestedSource.siteIcao === paintedModel.siteIcao
      ) {
        // Cross-source transitions publish their React and persistence truth
        // only after the session explicitly accepts this matching receipt.
        return;
      }
      radarModelRef.current = paintedModel;
      coordinator.synchronizePaint(radarPaintIdentity(paintedModel, receipt));
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
      const beforeId = radarContextAnchorLayerId(instance.getStyle().layers ?? []);
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
      radarModelRef.current = initialModel;
      setPaintedSourceKind(initialModel.sourceKind);
      radarSessionCoordinatorRef.current!.establishPaintedSource(
        radarPaintIdentity(initialModel, newestReceipt),
      );
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
        const point = {
          longitude: event.lngLat.lng,
          latitude: event.lngLat.lat,
        };
        const paintedTruth = radarSessionCoordinatorRef.current!.snapshot().painted;
        if (paintedTruth?.source.kind === "national") {
          const renderer = nationalLayer?.getSnapshot();
          if (
            !client
            || !renderer?.paintReceipt
            || renderer.paintReceipt.generation !== paintedTruth.generation
            || renderer.paintReceipt.observationId !== paintedTruth.observationId
          ) {
            setInterrogation(null);
            setInspectionSelected(false);
            return;
          }
          const inspectionId = globalThis.crypto.randomUUID();
          inspectionRequestRef.current = inspectionId;
          inspectionPointRef.current = point;
          interrogationObservationRef.current = paintedTruth.observationId;
          setInspectionSelected(true);
          setInterrogation(null);
          placeInspectionMarker(instance, event.lngLat, inspectionMarkerRef);
          void client.lookupNationalPoint({
            generation: renderer.paintReceipt.generation,
            observationTimeUnixMs: renderer.paintReceipt.observationTimeUnixMs,
            contentSha256: renderer.paintReceipt.contentSha256,
            inspectionId,
            ...point,
          }).then((lookup) => {
            const currentPainted = radarSessionCoordinatorRef.current!.snapshot().painted;
            if (
              inspectionRequestRef.current !== inspectionId
              || currentPainted?.source.kind !== "national"
              || currentPainted.generation !== lookup.generation
              || currentPainted.observationId !== paintedTruth.observationId
            ) return;
            setInterrogation(nationalPointInterrogation(lookup));
          }).catch(() => {
            if (inspectionRequestRef.current === inspectionId) setInterrogation(null);
          });
          return;
        }
        const paintedId = layer?.getSnapshot().lastPaintedObservationId;
        const paintedModel = paintedId ? modelsById.get(paintedId) : undefined;
        if (!paintedModel) {
          setInterrogation(null);
          setInspectionSelected(false);
          return;
        }
        setInspectionSelected(true);
        setInterrogation(interrogateLngLat(paintedModel, point));
        inspectionPointRef.current = point;
        interrogationObservationRef.current = paintedModel.observationId;
        placeInspectionMarker(instance, event.lngLat, inspectionMarkerRef);
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
        requestedGeneration?: number,
      ): Promise<Phase5Report> => {
        if (!layer || !controller || !client) throw new Error("live renderer is unavailable");
        const activeLayer = layer;
        const activeController = controller;
        const activeClient = client;
        const minimumGeneration = Math.max(
          transferGeneration + 1,
          activeLayer.getSnapshot().generation + 1,
        );
        const generation = requestedGeneration ?? minimumGeneration;
        if (!Number.isSafeInteger(generation) || generation < minimumGeneration) {
          throw new Error("requested site generation is no longer current");
        }
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
      const continueLiveBackfillAndPolling = (
        site: string,
        pollingSession: number,
        historyLimit = diagnosticHistoryLimit,
      ) => {
        void runLiveBackfill(site, pollingSession, historyLimit).then(
          (stoppedAtLimit) => {
            if (!cancelled && pollingSession === livePollingSession && !stoppedAtLimit) {
              void runLivePolling(site, pollingSession);
            }
          },
        );
      };
      const startLiveSession = async (
        site: string,
        requestedGeneration?: number,
      ): Promise<Phase5Report> => {
        const pollingSession = livePollingSession + 1;
        const historyLimit = diagnosticHistoryLimit;
        livePollingSession = pollingSession;
        liveSweepCursor = null;
        liveBackfillCursor = null;
        setLiveHistoryStatus(undefined);
        const report = await acquireLive(site, false, 180, "after", requestedGeneration);
        if (!cancelled && pollingSession === livePollingSession) {
          setLiveHistoryStatus("loading");
          continueLiveBackfillAndPolling(site, pollingSession, historyLimit);
        }
        return report;
      };
      let pendingSiteBootstrap: {
        model: RadarSweepCpuModel;
        report: Phase5Report;
        receipt: RadarPaintReceipt;
        pollingSession: number;
      } | null = null;

      const startSiteFromNational = async (
        site: string,
        generation: number,
      ): Promise<Phase5Report> => {
        if (!client) throw new Error("selected-site transfer client is unavailable");
        const activeClient = client;
        transferGeneration = generation;
        livePollingSession += 1;
        const pollingSession = livePollingSession;
        await activeClient.begin(generation);
        const lease = await activeClient.requestPhase5Live(site, false, 180);
        let createdLayer: RadarCustomLayer | null = null;
        let createdController: ResidentPlaybackController | null = null;
        try {
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
            throw new RadarSourceSupersededError("Site bootstrap was superseded before GPU staging");
          }
          modelsById.clear();
          modelsById.set(model.observationId, model);
          createdLayer = new RadarCustomLayer([model], {
            displayMode: displayModeRef.current,
            recoveryBeforeLayerId: ANCHOR_LAYER_ID,
            onSnapshot(renderer) {
              setPlaybackError((current) => playbackErrorAfterRendererStatus(current, renderer.status));
              synchronizePaintedDisplay(renderer);
              publish({ renderer, playback: createdController?.snapshot() });
            },
          });
          const beforeId = radarContextAnchorLayerId(instance.getStyle().layers ?? []);
          installDiagnosticLayers(
            instance,
            model,
            createAlignmentReport(model),
            createdLayer,
            beforeId,
          );
          createdController = new ResidentPlaybackController(createdLayer, [model], {
            onState(playback) {
              publish({ playback, renderer: createdLayer?.getSnapshot() });
            },
          });
          layer = createdLayer;
          controller = createdController;
          radarLayerRef.current = createdLayer;
          playbackControllerRef.current = createdController;
          const receipt = await createdController.establishInitialPaint();
          if (transferGeneration !== generation || receipt.generation !== generation) {
            throw new RadarSourceSupersededError("Site bootstrap was superseded before paint acceptance");
          }
          const nextHistory = beginLiveHistory(model, generation);
          residentLiveHistory = nextHistory;
          const cursor = {
            volumeIndex: evidence.safe.volumeIndex,
            volumeStartedAtUnixMs: evidence.safe.volumeStartedAtUnixMs,
          };
          liveSweepCursor = cursor;
          liveBackfillCursor = cursor;
          const display = initialLiveDisplay(frameTruth(model, receipt));
          const report: Phase5Report = {
            display,
            evidence,
            receipt,
            transferTiming: lease.timing,
            renderer: createdLayer.getSnapshot(),
            history: liveHistoryReport(nextHistory),
          };
          pendingSiteBootstrap = { model, report, receipt, pollingSession };
          return report;
        } catch (error) {
          createdController?.dispose();
          if (createdLayer) removeDiagnosticLayers(instance, createdLayer);
          if (layer === createdLayer) layer = null;
          if (controller === createdController) controller = null;
          if (radarLayerRef.current === createdLayer) radarLayerRef.current = null;
          if (playbackControllerRef.current === createdController) {
            playbackControllerRef.current = null;
          }
          throw error;
        } finally {
          await lease.release();
        }
      };

      const acceptSiteBootstrap = (report: Phase5Report) => {
        const pending = pendingSiteBootstrap;
        if (!pending || pending.report !== report) return;
        pendingSiteBootstrap = null;
        const { model, receipt, pollingSession } = pending;
        radarModelRef.current = model;
        setPaintedSourceKind(model.sourceKind);
        setTimelineFrames([timelineFrame(model)]);
        setLiveHistoryStatus("loading");
        liveDisplay = report.display;
        publishPhase5(report);
        setInterrogation(null);
        setInspectionSelected(false);
        inspectionMarkerRef.current?.remove();
        inspectionMarkerRef.current = null;
        inspectionPointRef.current = null;
        interrogationObservationRef.current = null;
        updateDiagnosticSources(instance, model, createAlignmentReport(model));
        focusRadar(instance, model);
        if (nationalLayer && instance.getLayer(nationalLayer.id)) instance.removeLayer(nationalLayer.id);
        nationalLayer = null;
        nationalWorkingSet = null;
        nationalLayerRef.current = null;
        nationalWorkingSetRef.current = null;
        latestNationalPhase3 = null;
        setNationalPhase3(null);
        continueLiveBackfillAndPolling(model.siteIcao, pollingSession);
        radarSessionCoordinatorRef.current!.synchronizePaint(
          radarPaintIdentity(model, receipt),
        );
      };

      if (!layer) throw new Error("selected-site renderer is unavailable");
      siteLevel2Session = new SiteLevel2Session({
        coordinator: radarSessionCoordinatorRef.current!,
        nextGeneration: () => Math.max(
          transferGeneration + 1,
          (layer?.getSnapshot().generation ?? transferGeneration) + 1,
          (nationalLayer?.getSnapshot().generation ?? transferGeneration) + 1,
        ),
        acquireAndPaint: async (siteIcao, generation) => {
          const report = nationalLayer
            ? await startSiteFromNational(siteIcao, generation)
            : await startLiveSession(siteIcao, generation);
          if (!report.receipt) {
            throw new Error("selected-site session completed without an authoritative paint receipt");
          }
          return {
            value: report,
            paint: {
              source: siteRadarSource(siteIcao),
              generation: report.receipt.generation,
              observationId: report.receipt.observationId,
            },
          };
        },
        onPaintAccepted: (report) => acceptSiteBootstrap(report),
      });
      siteLevel2SessionRef.current = siteLevel2Session;
      const removeSiteAfterNationalPaint = () => {
        livePollingSession += 1;
        controller?.dispose();
        if (layer) removeDiagnosticLayers(instance, layer);
        if (playbackControllerRef.current === controller) playbackControllerRef.current = null;
        if (radarLayerRef.current === layer) radarLayerRef.current = null;
        controller = null;
        layer = null;
        residentLiveHistory = null;
        liveSweepCursor = null;
        liveBackfillCursor = null;
        modelsById.clear();
        setLiveHistoryStatus(undefined);
      };

      const resumeSitePollingAfterNationalFailure = (generation: number) => {
        const sourceState = radarSessionCoordinatorRef.current!.snapshot();
        const paintedSite = sourceState.painted?.source.kind === "site"
          ? sourceState.painted.source.siteIcao
          : null;
        if (
          cancelled
          || transferGeneration !== generation
          || sourceState.transition
          || !paintedSite
          || !layer
          || !controller
          || !residentLiveHistory
          || residentLiveHistory.length === 0
          || residentLiveHistory.some((model) => model.siteIcao !== paintedSite)
        ) return;

        livePollingSession += 1;
        const pollingSession = livePollingSession;
        continueLiveBackfillAndPolling(paintedSite, pollingSession);
      };

      const ensureNationalLayer = () => {
        if (nationalLayer && nationalWorkingSet) return;
        nationalLayer = new NationalGridLayer({
          displayMode: displayModeRef.current,
          recoveryBeforeLayerId: radarContextAnchorLayerId(instance.getStyle().layers ?? []),
          onSnapshot(renderer) {
            if (renderer.displayMode !== displayModeRef.current) {
              displayModeRef.current = renderer.displayMode;
              setDisplayMode(renderer.displayMode);
              storeRadarDisplayMode(renderer.displayMode);
            }
            if (latestNationalPhase3) {
              latestNationalPhase3 = { ...latestNationalPhase3, renderer };
              setNationalPhase3(latestNationalPhase3);
            }
            if (renderer.status === "painted" && pendingNationalCameraKey) {
              const currentCameraKey = nationalCameraKey(instance);
              pendingNationalCameraKey = null;
              if (currentCameraKey !== lastNationalCameraKey) {
                lastNationalCameraKey = currentCameraKey;
                nationalCoverageVersion += 1;
                globalThis.queueMicrotask(() => refineNationalForCamera());
              }
            }
          },
        });
        nationalWorkingSet = new NationalWorkingSetController(activeClientForNational(), nationalLayer);
        const beforeId = radarContextAnchorLayerId(instance.getStyle().layers ?? []);
        addLayer(instance, nationalLayer, beforeId);
        nationalLayerRef.current = nationalLayer;
        nationalWorkingSetRef.current = nationalWorkingSet;
      };

      const activeClientForNational = () => {
        if (!client) throw new Error("National transfer client is unavailable");
        return client;
      };

      const refineNationalForCamera = () => {
        if (
          !nationalLayer
          || !nationalWorkingSet
          || nationalRefinement
          || radarSessionCoordinatorRef.current!.snapshot().painted?.source.kind !== "national"
        ) return;
        const layerSnapshot = nationalLayer.getSnapshot();
        if (layerSnapshot.status !== "painted") {
          pendingNationalCameraKey = nationalCameraKey(instance);
          return;
        }
        const expectedGeneration = layerSnapshot.generation;
        if (!expectedGeneration) return;
        nationalCoverageVersion += 1;
        const cameraVersion = nationalCoverageVersion;
        const ownershipCheck = () => {
          const painted = radarSessionCoordinatorRef.current!.snapshot().painted;
          if (
            cameraVersion !== nationalCoverageVersion
            || transferGeneration !== expectedGeneration
            || painted?.source.kind !== "national"
            || painted.generation !== expectedGeneration
          ) {
            throw new RadarSourceSupersededError("National camera refinement was superseded");
          }
        };
        const currentFactor = nationalLayer.getSnapshot().presentationFactor;
        const operation = instance.getZoom() >= 7.5
          ? nationalWorkingSet.stageDetailedViewport(
              mapBounds(instance),
              ownershipCheck,
            )
          : currentFactor === 4
            ? null
            : nationalWorkingSet.stageCompleteOverview(ownershipCheck);
        if (!operation) return;
        nationalRefinement = operation;
        void operation.then((workingSet) => {
          if (latestNationalPhase3) {
            latestNationalPhase3 = {
              ...latestNationalPhase3,
              workingSet,
              renderer: nationalLayer?.getSnapshot() ?? latestNationalPhase3.renderer,
            };
            setNationalPhase3(latestNationalPhase3);
          }
        }).catch(() => {
          // The prior complete presentation remains authoritative. A later
          // moveend retries the current camera rather than exposing a partial.
        }).finally(() => {
          nationalRefinement = null;
          if (cameraVersion !== nationalCoverageVersion) refineNationalForCamera();
        });
      };
      nationalMoveHandler = () => {
        if (radarSessionCoordinatorRef.current!.snapshot().painted?.source.kind !== "national") return;
        const currentCameraKey = nationalCameraKey(instance);
        if (currentCameraKey === lastNationalCameraKey) return;
        if (nationalLayer?.getSnapshot().status !== "painted") {
          pendingNationalCameraKey = currentCameraKey;
          return;
        }
        lastNationalCameraKey = currentCameraKey;
        pendingNationalCameraKey = null;
        nationalCoverageVersion += 1;
        nationalWorkingSet?.cancel();
        refineNationalForCamera();
      };
      instance.on("moveend", nationalMoveHandler);

      nationalMrmsSession = new NationalMrmsSession({
        coordinator: radarSessionCoordinatorRef.current!,
        nextGeneration: () => Math.max(
          transferGeneration + 1,
          (layer?.getSnapshot().generation ?? transferGeneration) + 1,
          (nationalLayer?.getSnapshot().generation ?? transferGeneration) + 1,
        ),
        acquireAndPaint: async (generation) => {
          const activeClient = activeClientForNational();
          transferGeneration = generation;
          livePollingSession += 1;
          await activeClient.begin(generation);
          const preparation = await activeClient.prepareNationalPhase3();
          if (preparation.generation !== generation || transferGeneration !== generation) {
            throw new RadarSourceSupersededError("National preparation was superseded");
          }
          ensureNationalLayer();
          const activeLayer = nationalLayer!;
          const activeWorkingSet = nationalWorkingSet!;
          activeLayer.setPresentationEnabled(true);
          const ownershipCheck = () => {
            const transition = radarSessionCoordinatorRef.current!.snapshot().transition;
            if (
              transferGeneration !== generation
              || transition?.generation !== generation
              || transition.requestedSource.kind !== "national"
            ) {
              throw new RadarSourceSupersededError("National transition was superseded");
            }
          };
          try {
            const workingSet = await activeWorkingSet.stageCompleteOverview(ownershipCheck);
            const renderer = activeLayer.getSnapshot();
            const report: NationalPhase3Report = { preparation, workingSet, renderer };
            return {
              value: report,
              paint: {
                source: { kind: "national", domain: "conus" },
                generation: workingSet.receipt.generation,
                observationId: workingSet.receipt.observationId,
              },
            };
          } catch (error) {
            activeLayer.setPresentationEnabled(
              radarSessionCoordinatorRef.current!.snapshot().painted?.source.kind === "national",
            );
            throw error;
          }
        },
        onPaintAccepted: (report) => {
          latestNationalPhase3 = report;
          setNationalPhase3(report);
          setTimelineFrames([{
            observationId: report.workingSet.receipt.observationId,
            observedAtUnixMs: report.workingSet.receipt.observationTimeUnixMs,
          }]);
          setInterrogation(null);
          setInspectionSelected(false);
          inspectionMarkerRef.current?.remove();
          inspectionMarkerRef.current = null;
          inspectionPointRef.current = null;
          interrogationObservationRef.current = null;
          removeSiteAfterNationalPaint();
          focusNational(instance);
        },
        onTransitionFailed: (_error, generation) => {
          resumeSitePollingAfterNationalFailure(generation);
        },
      });
      nationalMrmsSessionRef.current = nationalMrmsSession;
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
          if (!siteLevel2Session) throw new Error("selected-site session is unavailable");
          return siteLevel2Session.start(normalized, { persistOnPaint: false });
        },
        stopSession: async () => {
          livePollingSession += 1;
          if (!client || !layer) return latestPhase5;
          const generation = Math.max(
            transferGeneration + 1,
            layer.getSnapshot().generation + 1,
          );
          transferGeneration = generation;
          radarSessionCoordinatorRef.current!.cancelPending(generation);
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
          const normalized = normalizeRadarSite(site);
          if (!freshOnly) {
            if (!siteLevel2Session) {
              return Promise.reject(new Error("selected-site session is unavailable"));
            }
            return siteLevel2Session.start(normalized, { persistOnPaint: false });
          }
          const paintedSource = radarSessionCoordinatorRef.current!.snapshot().painted?.source;
          if (paintedSource?.kind === "site" && paintedSource.siteIcao === normalized) {
            return acquireLive(normalized, true, timeoutSeconds);
          }
          if (!siteLevel2Session) {
            return Promise.reject(new Error("selected-site session is unavailable"));
          }
          return siteLevel2Session.startWith(
            normalized,
            async (siteIcao, generation) => {
              const report = await acquireLive(
                siteIcao,
                true,
                timeoutSeconds,
                "after",
                generation,
              );
              if (!report.receipt) {
                throw new Error(
                  "selected-site diagnostic completed without an authoritative paint receipt",
                );
              }
              return {
                value: report,
                paint: {
                  source: siteRadarSource(siteIcao),
                  generation: report.receipt.generation,
                  observationId: report.receipt.observationId,
                },
              };
            },
            { persistOnPaint: false },
          );
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
        livePollingSession += 1;
        const minimumGeneration = Math.max(
          transferGeneration + 1,
          layer.getSnapshot().generation + 1,
        );
        const transition = radarSessionCoordinatorRef.current!.beginTransition(
          siteRadarSource("KTLX"),
          minimumGeneration,
          { persistOnPaint: false },
        );
        const generation = transition.generation;
        transferGeneration = generation;
        try {
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
          if (!radarSessionCoordinatorRef.current!.acceptPaint(
            transition,
            radarPaintIdentity(paintedModel, receipt),
          )) {
            throw new RadarSourceSupersededError(
              "archive diagnostic preparation was superseded before paint acceptance",
            );
          }

          modelsById.clear();
          residentLiveHistory = null;
          liveSweepCursor = null;
          liveBackfillCursor = null;
          setLiveHistoryStatus(undefined);
          preparedArchiveModels.forEach((model) => modelsById.set(model.observationId, model));
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
        } catch (error) {
          radarSessionCoordinatorRef.current!.failTransition(transition, error);
          throw error;
        }
      };
      globalThis.__MISTR_NATIONAL_PHASE2__ = {
        async run() {
          if (!client || !layer || !prepareArchiveForDiagnostics) {
            throw new Error("National Phase 2 diagnostic is unavailable");
          }
          livePollingSession += 1;
          const minimumGeneration = Math.max(
            transferGeneration + 1,
            layer.getSnapshot().generation + 1,
          );
          const transition = radarSessionCoordinatorRef.current!.beginTransition(
            { kind: "national", domain: "conus" },
            minimumGeneration,
            { persistOnPaint: false },
          );
          const generation = transition.generation;
          transferGeneration = generation;
          let backpressureCode: string | undefined;
          let transferredChunkBytes = 0;
          let manifestBytes = 0;
          try {
            await client.begin(generation);
            await startupAcquisition?.catch(() => {});
            const preparation = await client.prepareNationalPhase2();
            const manifestLease = await client.requestNationalManifest();
            const manifest = manifestLease.packed;
            manifestBytes = manifestLease.wireBytes;
            try {
              if (
                manifest.generation !== BigInt(generation)
                || manifest.objectKey !== preparation.objectKey
                || manifest.contentSha256 !== preparation.compressedSha256
              ) {
                throw new Error("National manifest does not match acquisition evidence");
              }
            } finally {
              await manifestLease.release();
            }

            if (manifest.chunks.length < 3) {
              throw new Error("National diagnostic requires at least three chunks");
            }
            const [firstLease, secondLease] = await acquireAllOrRelease([
              client.requestNationalChunk(0),
              client.requestNationalChunk(1),
            ]);
            try {
              await client.requestNationalChunk(2).then(
                async (unexpected) => {
                  await unexpected.release();
                  throw new Error("third concurrent transfer unexpectedly bypassed the two-credit limit");
                },
                (error: unknown) => {
                  backpressureCode = typeof error === "object" && error !== null && "code" in error
                    ? String(error.code)
                    : undefined;
                },
              );
            } finally {
              await Promise.all([firstLease.release(), secondLease.release()]);
            }
            if (backpressureCode !== "credit_exhausted") {
              throw new Error(`National two-credit proof returned ${backpressureCode ?? "no error"}`);
            }

            for (const descriptor of manifest.chunks) {
              const lease = await client.requestNationalChunk(descriptor.index);
              try {
                assertChunkMatchesManifest(manifest, lease.packed);
                if (lease.wireBytes !== descriptor.encodedLength) {
                  throw new Error(`National chunk ${descriptor.index} transfer length changed`);
                }
                transferredChunkBytes += lease.wireBytes;
              } finally {
                await lease.release();
              }
            }
            const transferAfter = await client.transferSnapshot();
            if (
              transferAfter.creditLimit !== 2
              || transferAfter.heldCredits !== 0
              || transferAfter.inFlightCredits !== 0
            ) {
              throw new Error("National diagnostic did not return both global transfer credits");
            }
            return {
              schemaVersion: 1,
              diagnosticOnly: true,
              generation,
              preparation,
              manifest: {
                generation: Number(manifest.generation),
                observationTimeUnixMs: Number(manifest.observationTimeUnixMs),
                objectKey: manifest.objectKey,
                contentSha256: manifest.contentSha256,
                width: manifest.width,
                height: manifest.height,
                presentationFactor: manifest.presentationFactor,
                chunkCount: manifest.chunks.length,
              },
              transfers: {
                manifestBytes,
                transferredChunkBytes,
                transferredChunkCount: manifest.chunks.length,
                backpressureCode,
                finalSnapshot: transferAfter,
              },
            };
          } finally {
            radarSessionCoordinatorRef.current!.failTransition(
              transition,
              new Error("National Phase 2 diagnostic completed without product paint"),
            );
            await prepareArchiveForDiagnostics();
          }
        },
      };
      globalThis.__MISTR_NATIONAL_PHASE3__ = {
        report: () => latestNationalPhase3,
        startNational: () => nationalMrmsSession?.start()
          ?? Promise.reject(new Error("National session is unavailable")),
        startSite: (site = "KTLX") => siteLevel2Session?.start(normalizeRadarSite(site))
          ?? Promise.reject(new Error("Site session is unavailable")),
        async refineForCamera() {
          nationalMoveHandler?.();
          await nationalRefinement;
          if (!latestNationalPhase3) throw new Error("National radar is not painted");
          return latestNationalPhase3;
        },
        async resetContext(holdMs = 100) {
          if (!nationalLayer) throw new Error("National renderer is unavailable");
          const before = nationalLayer.getSnapshot();
          const receipt = await nationalLayer.simulateContextResetForTest(holdMs);
          return { before, receipt, after: nationalLayer.getSnapshot() };
        },
        async lookup(longitude, latitude) {
          if (!client || !latestNationalPhase3) throw new Error("National radar is not painted");
          const receipt = latestNationalPhase3.renderer.paintReceipt;
          if (!receipt) throw new Error("National renderer has no authoritative receipt");
          return client.lookupNationalPoint({
            generation: receipt.generation,
            observationTimeUnixMs: receipt.observationTimeUnixMs,
            contentSha256: receipt.contentSha256,
            inspectionId: globalThis.crypto.randomUUID(),
            longitude,
            latitude,
          });
        },
        async peak() {
          if (!client || !latestNationalPhase3) throw new Error("National radar is not painted");
          const receipt = latestNationalPhase3.renderer.paintReceipt;
          if (!receipt) throw new Error("National renderer has no authoritative receipt");
          return client.findNationalPeakPoint({
            generation: receipt.generation,
            observationTimeUnixMs: receipt.observationTimeUnixMs,
            contentSha256: receipt.contentSha256,
            inspectionId: globalThis.crypto.randomUUID(),
          });
        },
        setCamera(longitude, latitude, zoom) {
          instance.jumpTo({ center: [longitude, latitude], zoom, bearing: 0, pitch: 0 });
        },
        setDisplayMode(mode) {
          nationalLayer?.setDisplayMode(mode);
        },
        transferSnapshot: () => client?.transferSnapshot()
          ?? Promise.reject(new Error("National transfer client is unavailable")),
        sourceState: () => radarSessionCoordinatorRef.current?.snapshot() ?? null,
        isolateRadarForEvidence() {
          const nationalLayerId = nationalLayer?.id;
          for (const layerId of instance.getLayersOrder()) {
            if (layerId !== nationalLayerId) {
              instance.setLayoutProperty(layerId, "visibility", "none");
            }
          }
        },
      };
      // The packaged archive is a safe first paint, not a permanent demo mode.
      // Every launch proceeds to the stored painted source; a fresh profile
      // starts with KTLX Site.
      const startupSource = startupSourceRef.current;
      if (!siteLevel2Session || !nationalMrmsSession) {
        throw new Error("radar source sessions are unavailable");
      }
      startupAcquisition = (
        startupSource.kind === "national"
          ? nationalMrmsSession.start()
          : siteLevel2Session.start(startupSource.siteIcao)
      ).then(
        () => {
          if (startupSource.kind === "national") setNationalRequestError(null);
          else setSiteRequestError(null);
        },
        (error: unknown) => {
          if (isRadarSourceSuperseded(error)) return;
          // A failed refresh does not earn persistence. The coordinator keeps
          // the prior painted source and the stored preference unchanged.
          const message = error instanceof Error ? error.message : String(error);
          if (startupSource.kind === "national") setNationalRequestError(message);
          else setSiteRequestError(message);
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
      controller?.dispose();
      if (playbackControllerRef.current === controller) playbackControllerRef.current = null;
      if (radarLayerRef.current === layer) radarLayerRef.current = null;
      if (clickHandler) instance.off("click", clickHandler);
      if (nationalMoveHandler) instance.off("moveend", nationalMoveHandler);
      if (globalThis.__MISTR_PHASE4__) delete globalThis.__MISTR_PHASE4__;
      if (globalThis.__MISTR_PHASE5__) delete globalThis.__MISTR_PHASE5__;
      if (globalThis.__MISTR_PHASE6__) delete globalThis.__MISTR_PHASE6__;
      if (globalThis.__MISTR_NATIONAL_PHASE2__) delete globalThis.__MISTR_NATIONAL_PHASE2__;
      if (globalThis.__MISTR_NATIONAL_PHASE3__) delete globalThis.__MISTR_NATIONAL_PHASE3__;
      if (siteLevel2SessionRef.current === siteLevel2Session) siteLevel2SessionRef.current = null;
      if (nationalMrmsSessionRef.current === nationalMrmsSession) nationalMrmsSessionRef.current = null;
      nationalWorkingSet?.cancel();
      if (nationalLayer && instance.getLayer(nationalLayer.id)) instance.removeLayer(nationalLayer.id);
      nationalLayerRef.current = null;
      nationalWorkingSetRef.current = null;
      inspectionMarkerRef.current?.remove();
      inspectionMarkerRef.current = null;
      inspectionPointRef.current = null;
      interrogationObservationRef.current = null;
      inspectionRequestRef.current = null;
      removeDiagnosticLayers(instance, layer);
    };
  }, [radarHostReady, runtime.shell]);

  const playback = phase4.kind === "complete" ? phase4.report.playback : undefined;
  const frameIndex = paintedFrameIndex(timelineFrames, playback);
  const nationalActive = paintedRadarSource.kind === "national";
  const displayedAtUnixMs = nationalActive
    ? nationalPhase3?.workingSet.receipt.observationTimeUnixMs
    : playback?.playheadObservedAtUnixMs ?? phase5.display.lastComplete?.observedAtUnixMs;
  const playbackStatus = nationalActive
    ? "NATIONAL CURRENT"
    : playbackPresentation(
        playback,
        frameIndex,
        timelineFrames.length,
        liveHistoryStatus,
      );
  const initializationError = phase4.kind === "error" ? phase4.message : null;
  const rendererError = nationalActive
    ? nationalPhase3?.renderer.status === "error"
      ? nationalPhase3.renderer.error ?? "National renderer failed"
      : null
    : phase4.kind === "complete"
      ? rendererFailureMessage(phase4.report.renderer)
      : null;
  const mapError = mapReadinessError(mapState);
  const radarUnavailableError = initializationError ?? rendererError;
  const displayedFrameIsLatestLive = nationalActive || (
    paintedSourceKind === "nexrad_level2_chunks"
    && timelineFrames.length > 0
    && frameIndex === timelineFrames.length - 1
  );
  const frameAge = frameAgePresentation(
    displayedAtUnixMs,
    nowUnixMs,
    displayedFrameIsLatestLive,
    nationalActive ? "Newest National observation" : undefined,
  );
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
        : nationalRequestError
          ? "National radar is unavailable. The last completed radar remains displayed; choose National again to retry."
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
  const pendingSite = requestedSourceKind === "site"
    ? requestedSite ?? (phase5.display.kind === "acquiring" ? phase5.display.requestedSite : undefined)
    : undefined;
  const displayedSite = phase5.display.lastComplete?.site ?? selectedSite;
  const displayedSource = nationalActive
    ? "National radar"
    : paintedSourceKind === "nexrad_level2_chunks" ? "live radar" : "archive radar";
  const playbackNotice = playbackStatus === "RECOVERING"
    ? {
        kind: "info" as const,
        message: "Restoring the radar display. The last completed scan remains selected.",
      }
    : playbackStatus === "LOADING SCAN"
      ? {
          kind: "info" as const,
          message: "Loading the selected radar scan.",
        }
      : undefined;
  const radarNotice = userFacingError
    ? { kind: "error" as const, message: userFacingError }
    : requestedSourceKind === "national"
      ? {
          kind: "info" as const,
          message: `Showing ${nationalActive ? "National" : `${displayedSite} ${displayedSource}`} while National CONUS radar loads.`,
        }
    : pendingSite
      ? {
          kind: "info" as const,
          message: `Showing ${nationalActive ? "National radar" : `${displayedSite} ${displayedSource}`} while ${pendingSite} live radar loads.`,
        }
      : playbackNotice ?? (mapError
        ? {
            kind: "info" as const,
            message: "Basemap unavailable. Radar remains available.",
          }
        : liveHistoryStatus === "loading" && paintedSourceKind === "nexrad_level2_chunks"
          ? {
              kind: "info" as const,
              message: `Current ${displayedSite} radar is ready. Loading recent scans.`,
            }
          : undefined);

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
    const session = siteLevel2SessionRef.current;
    if (!session) {
      setSiteRequestError(RADAR_ENGINE_PREPARING_ERROR);
      return;
    }
    setSiteRequestError(null);
    setNationalRequestError(null);
    setInterrogation(null);
    setInspectionSelected(false);
    inspectionMarkerRef.current?.remove();
    inspectionMarkerRef.current = null;
    inspectionPointRef.current = null;
    interrogationObservationRef.current = null;
    inspectionRequestRef.current = null;
    void session.start(normalized).then(
      () => {
        setSiteRequestError(null);
      },
      (error: unknown) => {
        if (isRadarSourceSuperseded(error)) return;
        // Source rollback is coordinator-owned. The UI continues naming the
        // prior painted site and persistence remains untouched.
        setSiteRequestError(error instanceof Error ? error.message : String(error));
      },
    );
  };

  const selectNational = () => {
    const session = nationalMrmsSessionRef.current;
    if (!session) {
      setNationalRequestError("National radar engine is still preparing");
      return;
    }
    const sourceState = radarSessionCoordinatorRef.current?.snapshot();
    if (
      sourceState?.transition?.requestedSource.kind === "national"
      || (sourceState?.painted?.source.kind === "national" && !sourceState.transition)
    ) return;
    setNationalRequestError(null);
    setSiteRequestError(null);
    setInterrogation(null);
    setInspectionSelected(false);
    inspectionMarkerRef.current?.remove();
    inspectionMarkerRef.current = null;
    inspectionPointRef.current = null;
    interrogationObservationRef.current = null;
    inspectionRequestRef.current = null;
    void session.start().then(
      () => setNationalRequestError(null),
      (error: unknown) => {
        if (isRadarSourceSuperseded(error)) return;
        setNationalRequestError(error instanceof Error ? error.message : String(error));
      },
    );
  };

  const recenterRadar = () => {
    const instance = map.current;
    if (instance && paintedRadarSource.kind === "national") {
      focusNational(instance);
      return;
    }
    const model = radarModelRef.current;
    if (instance && model) focusRadar(instance, model);
  };

  const selectDisplayMode = (mode: RadarDisplayMode) => {
    if (paintedRadarSource.kind === "national") {
      displayModeRef.current = mode;
      nationalLayerRef.current?.setDisplayMode(mode);
      setDisplayMode(mode);
      storeRadarDisplayMode(mode);
      return;
    }
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
        displayedAtUnixMs={displayedAtUnixMs}
        displayMode={displayMode}
        displayModeReady={nationalActive
          ? Boolean(nationalLayerRef.current)
          : phase4.kind === "complete" && Boolean(radarLayerRef.current)}
        dismissPanelsSignal={dismissPanelsSignal}
        frameAge={frameAge}
        frameCount={timelineFrames.length}
        frameIndex={frameIndex}
        interrogation={interrogation}
        inspectionSelected={inspectionSelected}
        onRecenter={recenterRadar}
        onSelectNational={selectNational}
        onSelectDisplayMode={selectDisplayMode}
        onScrub={queueScrub}
        onSelectSite={selectSite}
        onTogglePlayback={togglePlayback}
        playbackReady={Boolean(playbackControllerRef.current)
          && !nationalActive
          && phase4.kind === "complete"
          && !rendererError
          && !playback?.residentReplacementPending}
        playing={playback?.playing ?? false}
        playbackStatus={radarUnavailableError ? "RADAR UNAVAILABLE" : playbackStatus}
        preparingFailed={preparingFailed}
        preparingLabel={preparingLabel}
        radarNotice={radarNotice}
        recenterReady={displayedAtUnixMs !== undefined}
        paintedSourceKind={paintedRadarSource.kind}
        requestedSourceKind={requestedSourceKind}
        requestedSite={requestedSite ?? undefined}
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

function radarPaintIdentity(model: RadarSweepCpuModel, receipt: RadarPaintReceipt) {
  return {
    source: siteRadarSource(model.siteIcao),
    generation: receipt.generation,
    observationId: receipt.observationId,
  };
}

function synchronizeRadarSourceUi(
  snapshot: RadarSessionSnapshot,
  setRequestedSite: (site: string | null) => void,
  setSelectedSite: (site: string) => void,
  setPaintedSource: (source: RadarSourceKey) => void,
  setRequestedSourceKind: (source: "site" | "national" | undefined) => void,
): void {
  setRequestedSourceKind(snapshot.requestedSource?.kind);
  setRequestedSite(
    snapshot.requestedSource?.kind === "site"
      ? snapshot.requestedSource.siteIcao
      : null,
  );
  if (snapshot.painted?.source.kind === "site") {
    setSelectedSite(snapshot.painted.source.siteIcao);
  }
  if (snapshot.painted) setPaintedSource(snapshot.painted.source);
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

function focusNational(instance: MapLibreMap): void {
  instance.fitBounds(
    [[-125.0, 24.0], [-66.5, 50.0]],
    {
      bearing: 0,
      duration: 0,
      maxZoom: 5.5,
      padding: { top: 100, right: 88, bottom: 124, left: 88 },
      pitch: 0,
    },
  );
}

function mapBounds(instance: MapLibreMap) {
  const bounds = instance.getBounds();
  return {
    west: Math.max(-180, bounds.getWest()),
    south: Math.max(-90, bounds.getSouth()),
    east: Math.min(180, bounds.getEast()),
    north: Math.min(90, bounds.getNorth()),
  };
}

function nationalCameraKey(instance: MapLibreMap): string {
  const center = instance.getCenter();
  return `${center.lng.toFixed(5)}:${center.lat.toFixed(5)}:${instance.getZoom().toFixed(4)}`;
}

function placeInspectionMarker(
  instance: MapLibreMap,
  point: maplibregl.LngLat,
  markerRef: { current: maplibregl.Marker | null },
) {
  if (!markerRef.current) {
    const element = document.createElement("span");
    element.className = "inspection-marker";
    element.setAttribute("aria-hidden", "true");
    markerRef.current = new maplibregl.Marker({
      anchor: "center",
      element,
    }).setLngLat(point).addTo(instance);
  } else {
    markerRef.current.setLngLat(point);
  }
}

function nationalPointInterrogation(lookup: NationalPointLookup): GateInterrogation {
  const valid = lookup.status === "valid" && lookup.valueDbz !== null;
  return {
    radialIndex: lookup.row,
    gateIndex: lookup.column,
    sourceAzimuthDegrees: 0,
    slantRangeM: 0,
    groundRangeM: 0,
    rawCode: lookup.rawCode,
    status: lookup.status,
    value: lookup.valueDbz,
    units: "dBZ",
    color: valid ? colorForReflectivity(lookup.valueDbz!) : [0, 0, 0, 0],
  };
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

function restoreRadarSource(): RadarSourceKey {
  try {
    return globalThis.localStorage?.getItem(RADAR_SOURCE_STORAGE_KEY) === "national"
      ? { kind: "national", domain: "conus" }
      : siteRadarSource(restoreLastSite());
  } catch {
    return siteRadarSource("KTLX");
  }
}

function storeRadarSource(source: RadarSourceKey): void {
  try {
    globalThis.localStorage?.setItem(
      RADAR_SOURCE_STORAGE_KEY,
      source.kind === "national" ? "national" : "site",
    );
    if (source.kind === "site") storeLastSite(source.siteIcao);
  } catch {
    // Storage failure cannot invalidate a source that has already painted.
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

export interface NationalPhase3Report {
  preparation: NationalPhase3PrepareReport;
  workingSet: NationalWorkingSetResult;
  renderer: NationalGridRendererSnapshot;
}

export interface NationalPhase3ContextResetReport {
  before: NationalGridRendererSnapshot;
  receipt: NationalPaintReceipt;
  after: NationalGridRendererSnapshot;
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
  var __MISTR_NATIONAL_PHASE2__: undefined | {
    run(): Promise<NationalPhase2PackagedReport>;
  };
  var __MISTR_NATIONAL_PHASE3__: undefined | {
    report(): NationalPhase3Report | null;
    startNational(): Promise<NationalPhase3Report>;
    startSite(site?: string): Promise<Phase5Report>;
    refineForCamera(): Promise<NationalPhase3Report>;
    resetContext(holdMs?: number): Promise<NationalPhase3ContextResetReport>;
    lookup(longitude: number, latitude: number): Promise<NationalPointLookup>;
    peak(): Promise<NationalPointLookup>;
    setCamera(longitude: number, latitude: number, zoom: number): void;
    setDisplayMode(mode: RadarDisplayMode): void;
    transferSnapshot(): Promise<import("./packed-sweep/transferClient").TransferSnapshot>;
    sourceState(): import("./radar-session/RadarSessionCoordinator").RadarSessionSnapshot | null;
    isolateRadarForEvidence(): void;
  };
}

interface NationalPhase2PackagedReport {
  schemaVersion: 1;
  diagnosticOnly: true;
  generation: number;
  preparation: import("./packed-sweep/transferClient").NationalPhase2PrepareReport;
  manifest: {
    generation: number;
    observationTimeUnixMs: number;
    objectKey: string;
    contentSha256: string;
    width: number;
    height: number;
    presentationFactor: number;
    chunkCount: number;
  };
  transfers: {
    manifestBytes: number;
    transferredChunkBytes: number;
    transferredChunkCount: number;
    backpressureCode?: string;
    finalSnapshot: import("./packed-sweep/transferClient").TransferSnapshot;
  };
}
