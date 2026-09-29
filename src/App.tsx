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
  type NationalHistoryActivitySnapshot,
  type NationalHistoryObservation,
  type NationalHistoryPrepareReport,
  type NationalHistorySnapshot,
  type NationalPointLookup,
  type LiveSweepCursor,
  type TransferLane,
  type TransferTiming,
} from "./packed-sweep/transferClient";
import {
  ResidentPlaybackController,
  type PlaybackStateSnapshot,
} from "./playback/ResidentPlaybackController";
import {
  NationalPlaybackController,
  type NationalPlaybackSnapshot,
} from "./playback/NationalPlaybackController";
import { nearestFrameIndex, planPlayheadCarry, type CarriedPlayhead } from "./playback/playheadCarry";
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
  isPaintedNationalSource,
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
import { NationalMrmsSession, type NationalMrmsPaintResult } from "./radar-session/NationalMrmsSession";
import { RADAR_SITES, radarSiteById, type RadarSiteOption } from "./data/radarSites";
import {
  commonResidencyReadyForInteraction,
  NationalGridLayer,
  type NationalGridRendererSnapshot,
  type NationalPaintReceipt,
} from "./national-radar/NationalGridLayer";
import {
  NationalHistoryWorkingSetController,
  observationId as nationalObservationId,
  type NationalHistoryWorkingSetResult,
} from "./national-radar/NationalHistoryWorkingSetController";
import {
  LatestOnlyAsyncQueue,
  type LatestOnlyAsyncQueueSnapshot,
} from "./national-radar/LatestOnlyAsyncQueue";
import { retryBackfillStep } from "./live/backfillRetry";
import { runNationalBackfillLoop, waitRunningDueChecks } from "./national-radar/NationalBackfillLoop";
import { finalizeNationalHistoryUntilSettled } from "./national-radar/NationalFinalizeLoop";
import {
  nationalPollingFallbackDelayMs,
  runNationalPollingLoop,
} from "./national-radar/NationalPollingLoop";
import {
  rollbackNationalHistoryUntilSettled,
  snapshotProvesNationalHistoryRollback,
} from "./national-radar/NationalRollbackLoop";
import { colorForReflectivity } from "./radar-renderer/palette";
import { RadarChrome } from "./ui/RadarChrome";
import { fadeOpacity } from "./radar-renderer/fade";
import {
  autoSourceOf,
  decideAutoSource,
  launchAutoSource,
  pickedNextSource,
  sameAutoSource,
  type AutoSource,
} from "./radar-session/autoSourcePolicy";
import {
  frameAgePresentation,
  nationalHistoryStatus,
  userFacingRadarError,
  normalizeRadarDisplayMode,
  normalizeRadarSite,
  paintedFrameIndex,
  playbackErrorAfterRendererStatus,
  playbackPresentation,
  radarInitializationLabel,
  rendererFailureMessage,
  type InspectionState,
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
const CAMERA_STORAGE_KEY = "mistr.camera";
/** Zoom the picker and recenter use for a Site: past the automatic switch threshold. */
const SITE_DETAIL_ZOOM = 9.5;
const SOURCE_FADE_MS = 300;
// While history backfills, how often newer observations are checked.
const NATIONAL_BACKFILL_FRESHNESS_MS = 30_000;
const SITE_BACKFILL_FRESHNESS_MS = 120_000;
const SITE_FRESHNESS_PROBE_WAIT_S = 3;
const CAMERA_FLIGHT_MS = 1_200;
/** A preloaded Site scan older than this is refetched at the switch. */
const SITE_PREFETCH_MAX_AGE_MS = 5 * 60_000;
/** An automatic switch to a Site that just failed waits this long before retrying. */
const AUTO_SITE_RETRY_MS = 60_000;
const CONUS_BOUNDS: [[number, number], [number, number]] = [[-125.0, 24.0], [-66.5, 50.0]];
const CAMERA_PADDING = { top: 100, right: 88, bottom: 124, left: 88 };

// Starting a source from scratch cancels the other lane. Site requests use
// beginSiteLane instead, so a resident National survives them.
async function beginExclusiveLane(
  activeClient: PackedSweepTransferClient,
  lane: TransferLane,
  generation: number,
) {
  const other: TransferLane = lane === "site" ? "national" : "site";
  if (activeClient.isActive(other)) await activeClient.cancel(other);
  await activeClient.begin(lane, generation);
}

configureMapLibreWorker();

export function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const playbackControllerRef = useRef<ResidentPlaybackController | null>(null);
  const nationalPlaybackControllerRef = useRef<NationalPlaybackController | null>(null);
  const radarLayerRef = useRef<RadarCustomLayer | null>(null);
  const nationalLayerRef = useRef<NationalGridLayer | null>(null);
  const nationalWorkingSetRef = useRef<NationalHistoryWorkingSetController | null>(null);
  const startupSourceRef = useRef(restoreStartupSource());
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
  const autoSourceRef = useRef<AutoSourceHandle | null>(null);
  const inspectionMarkerRef = useRef<maplibregl.Marker | null>(null);
  const inspectionPointRef = useRef<{ longitude: number; latitude: number } | null>(null);
  const interrogationObservationRef = useRef<string | null>(null);
  const inspectionRequestRef = useRef<string | null>(null);
  const queuedScrubRef = useRef<number | null>(null);
  const scrubRunningRef = useRef(false);
  // The outgoing source's playback, waiting for the incoming source to adopt it.
  const playheadCarryRef = useRef<{ target: "site" | "national"; playhead: CarriedPlayhead } | null>(null);
  // Bumped by every operator play, pause, or scrub; their intent outranks a carry.
  const operatorPlaybackIntentRef = useRef(0);
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
  const [inspectionState, setInspectionState] = useState<InspectionState>("idle");
  const [paintedSourceKind, setPaintedSourceKind] = useState<RadarSweepCpuModel["sourceKind"]>(
    "nexrad_level2_archive_ii",
  );
  const [paintedRadarSource, setPaintedRadarSource] = useState<RadarSourceKey>(
    siteRadarSource("KTLX"),
  );
  const [requestedSourceKind, setRequestedSourceKind] = useState<"site" | "national" | undefined>();
  const [nationalPhase3, setNationalPhase3] = useState<NationalPhase3Report | null>(null);
  const [nationalPlayback, setNationalPlayback] = useState<NationalPlaybackSnapshot | null>(null);
  const [nationalHistory, setNationalHistory] = useState<NationalHistorySnapshot | null>(null);
  const [timelineFrames, setTimelineFrames] = useState<TimelineFrame[]>([]);
  const [liveHistoryStatus, setLiveHistoryStatus] = useState<LiveHistoryStatus | undefined>();
  const [displayMode, setDisplayMode] = useState<RadarDisplayMode>(restoreRadarDisplayMode);
  const displayModeRef = useRef(displayMode);
  const [selectedSite, setSelectedSite] = useState(restoreLastSite());
  const [requestedSite, setRequestedSite] = useState<string | null>(null);
  const [siteRequestError, setSiteRequestError] = useState<string | null>(null);
  // Site an automatic switch could not load; National stays displayed.
  const [autoSiteError, setAutoSiteError] = useState<string | null>(null);
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
        ...initialMapCamera(startupSourceRef.current),
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
      const created = instance;
      created.on("moveend", () => storeCamera(created));
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
    let nationalWorkingSet: NationalHistoryWorkingSetController | null = null;
    let nationalPlaybackController: NationalPlaybackController | null = null;
    let nationalObservations: NationalHistoryObservation[] = [];
    let latestNationalHistory: NationalHistorySnapshot | null = null;
    let latestNationalInspection: NationalPointLookup | null = null;
    let nationalInspectionLookupQueueForCleanup: LatestOnlyAsyncQueue<
      NationalInspectionLookupRequest,
      NationalPointLookup | null
    > | null = null;
    let nationalHistorySession = 0;
    let nationalBackfillStartCount = 0;
    // Newer-observation checks made during the latest National backfill.
    let nationalBackfillFreshness = { checks: 0, commits: 0, startedAtUnixMs: 0, completedAtUnixMs: 0 };
    // Recent National load steps, kept so a stalled load can be diagnosed.
    const nationalLoadTrace: { atUnixMs: number; step: string; detail?: string }[] = [];
    const traceNationalLoad = (step: string, detail?: string) => {
      nationalLoadTrace.push({ atUnixMs: Date.now(), step, ...(detail ? { detail } : {}) });
      if (nationalLoadTrace.length > 200) nationalLoadTrace.splice(0, nationalLoadTrace.length - 200);
    };
    let activeNationalBackfillSession: number | null = null;
    // National lane generation of the retained history. National can stay
    // resident (hidden, still acquiring) while a Site is displayed.
    let nationalGeneration = 0;
    let nationalResident = false;
    let hiddenNationalRequestError: string | null = null;
    const revealedNationalReports = new WeakSet<NationalPhase3Report>();
    let nationalMrmsSession: NationalMrmsSession<NationalPhase3Report> | null = null;
    let lastNationalRestorationAfterSiteFailure: Promise<NationalPhase3Report> | null = null;
    let failNextSiteFromNationalForDiagnostics = false;
    // Diagnostics: the next Site switch from National waits for a new scan.
    let slowNextSiteFromNationalForDiagnostics = false;
    let nationalAcquisitionOperation: Promise<unknown> | null = null;
    let nationalResidentOnlyReservations = 0;
    let nationalPhase4EvidenceRelease: (() => void) | null = null;
    let latestNationalPhase3: NationalPhase3Report | null = null;
    let staticNationalDiagnostic = false;
    let clickHandler: ((event: MapMouseEvent) => void) | null = null;
    let autoSourceMoveHandlerForCleanup: ((event: { originalEvent?: unknown }) => void) | null = null;
    let unsubscribeAutoSourceFlush: (() => void) | null = null;
    let autoSiteRetryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
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

    // Every Site layer, however it was created, keeps the display mode and the
    // inspected value bound to the scan it actually painted.
    const handleSiteRendererSnapshot = (
      renderer: RadarRendererSnapshot,
      siteController: ResidentPlaybackController | null,
    ) => {
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
          const nextInterrogation = interrogateLngLat(paintedModel, point);
          setInterrogation(nextInterrogation);
          setInspectionState(nextInterrogation ? "settled" : "outside");
        }
      }
      publish({ renderer, playback: siteController?.snapshot() });
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
      await beginExclusiveLane(client, "site", 1);
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
          handleSiteRendererSnapshot(renderer, controller);
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
            setInspectionState("idle");
            return;
          }
          inspectionPointRef.current = point;
          interrogationObservationRef.current = null;
          setInspectionState("pending");
          setInterrogation(null);
          placeInspectionMarker(instance, event.lngLat, inspectionMarkerRef);
          // The shared refresh path also runs for every later playback/scrub
          // receipt, so this exact value can never survive an observation cut.
          void refreshNationalInterrogation(renderer.paintReceipt);
          return;
        }
        const paintedId = layer?.getSnapshot().lastPaintedObservationId;
        const paintedModel = paintedId ? modelsById.get(paintedId) : undefined;
        if (!paintedModel) {
          setInterrogation(null);
          latestNationalInspection = null;
          setInspectionState("idle");
          return;
        }
        const nextInterrogation = interrogateLngLat(paintedModel, point);
        setInspectionState(nextInterrogation ? "settled" : "outside");
        setInterrogation(nextInterrogation);
        inspectionPointRef.current = point;
        interrogationObservationRef.current = paintedModel.observationId;
        placeInspectionMarker(instance, event.lngLat, inspectionMarkerRef);
      };
      instance.on("click", clickHandler);
      setInterrogation(null);
      setInspectionState("idle");
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
        // Waits this briefly for a newer scan; finding none changes nothing.
        probeWaitSeconds?: number,
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
        const probing = probeWaitSeconds !== undefined && appendingHistory;
        if (probeWaitSeconds !== undefined && !probing) {
          throw new Error("a newer-scan probe requires painted live history for the site");
        }
        const displayBeforeProbe = liveDisplay;
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
          await beginSiteLane(activeClient, generation);
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
            probeWaitSeconds,
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
          if (appendingHistory || prependingHistory) applySitePlayheadCarry();
          if (!appendingHistory && !prependingHistory) {
            inspectionMarkerRef.current?.remove();
            inspectionMarkerRef.current = null;
            inspectionPointRef.current = null;
            interrogationObservationRef.current = null;
            setInterrogation(null);
            setInspectionState("idle");
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
          if (probing) {
            // No newer scan yet: leave the display exactly as it was.
            if (liveDisplay.kind === "refreshing" && liveDisplay.generation === generation) {
              liveDisplay = displayBeforeProbe;
              publishPhase5({ ...latestPhase5, display: liveDisplay });
            }
          } else if (!prependingHistory && transferGeneration === generation) {
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
        // Newer scans are probed while the history fills, so fresh weather
        // never waits behind the whole backfill.
        let nextFreshnessProbeAt = Date.now() + SITE_BACKFILL_FRESHNESS_MS;
        const probeForNewerScan = async () => {
          if (cancelled || pollingSession !== livePollingSession || Date.now() < nextFreshnessProbeAt) return;
          try {
            await acquireLive(site, true, 60, "after", undefined, SITE_FRESHNESS_PROBE_WAIT_S);
          } catch {
            // No newer scan yet, or a transient failure the next probe retries.
          }
          nextFreshnessProbeAt = Date.now() + SITE_BACKFILL_FRESHNESS_MS;
        };
        while (
          !cancelled
          && pollingSession === livePollingSession
          && residentLiveHistory
          && residentLiveHistory.length < historyLimit
        ) {
          try {
            const loaded = await retryBackfillStep(
              () => acquireLive(site, true, 30, "before"),
              () => !cancelled && pollingSession === livePollingSession,
              delay,
            );
            if (!loaded) throw new Error("Historical predecessor unavailable after bounded retries");
            if (!cancelled && pollingSession === livePollingSession) {
              setLiveHistoryStatus(
                residentLiveHistory.length >= MAX_LIVE_HISTORY_FRAMES ? "full" : "loading",
              );
            }
            await probeForNewerScan();
          } catch {
            // A missing/replaced ring predecessor is not a live-radar failure.
            // Preserve the current painted observation and the history already
            // loaded, then continue waiting for future scans.
            if (!cancelled && pollingSession === livePollingSession) {
              setLiveHistoryStatus("partial");
              applySitePlayheadCarry(true);
            }
            return false;
          }
        }
        const residentCount = residentLiveHistory?.length ?? 0;
        const reachedHistoryLimit = !cancelled
          && pollingSession === livePollingSession
          && residentCount >= historyLimit;
        if (!cancelled && pollingSession === livePollingSession) applySitePlayheadCarry(true);
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

      const nextSiteGeneration = () => Math.max(
        transferGeneration + 1,
        (layer?.getSnapshot().generation ?? transferGeneration) + 1,
        (nationalLayer?.getSnapshot().generation ?? transferGeneration) + 1,
      );

      const startSiteFromNational = async (
        site: string,
        generation: number,
      ): Promise<Phase5Report> => {
        if (!client) throw new Error("selected-site transfer client is unavailable");
        const activeClient = client;
        const siteTransitionIsCurrent = () => {
          const transition = radarSessionCoordinatorRef.current!.snapshot().transition;
          return transition?.generation === generation
            && transition.requestedSource.kind === "site"
            && transition.requestedSource.siteIcao === site;
        };
        if (!siteTransitionIsCurrent()) {
          throw new RadarSourceSupersededError("Site transition was superseded before it began");
        }
        queuedScrubRef.current = null;
        // National keeps acquiring and playing on its own lane until the Site
        // has faded in over it; then it becomes resident.
        const waitForNextScan = slowNextSiteFromNationalForDiagnostics;
        slowNextSiteFromNationalForDiagnostics = false;
        const prefetched = takePrefetchedSite(site, generation);
        transferGeneration = generation;
        livePollingSession += 1;
        const pollingSession = livePollingSession;
        let sweep: PrefetchedSiteSweep;
        if (prefetched && !waitForNextScan) {
          sweep = prefetched;
        } else {
          await activeClient.begin("site", generation);
          if (failNextSiteFromNationalForDiagnostics) {
            failNextSiteFromNationalForDiagnostics = false;
            throw new Error("diagnostic Site transition failure after the Site lane began");
          }
          // An abandoned switch cancels the lane; one abandoned during begin
          // must not go on to wait out the full download.
          if (!siteTransitionIsCurrent()) {
            throw new RadarSourceSupersededError("Site transition was superseded before its download");
          }
          sweep = await acquireSiteSweep(activeClient, site, generation, waitForNextScan);
        }
        const { model, evidence } = sweep;
        const fadeMs = sourceFadeMs();
        let createdLayer: RadarCustomLayer | null = null;
        let createdController: ResidentPlaybackController | null = null;
        try {
          if (transferGeneration !== generation) {
            throw new RadarSourceSupersededError("Site bootstrap was superseded before GPU staging");
          }
          modelsById.clear();
          modelsById.set(model.observationId, model);
          createdLayer = new RadarCustomLayer([model], {
            displayMode: displayModeRef.current,
            recoveryBeforeLayerId: ANCHOR_LAYER_ID,
            // The first frame paints invisibly, then fades in over National.
            opacity: fadeMs > 0 ? 0 : 1,
            onSnapshot(renderer) {
              handleSiteRendererSnapshot(renderer, createdController);
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
          const fadingLayer = createdLayer;
          const faded = await fadeOpacity((value) => fadingLayer.setOpacity(value), 0, 1, {
            durationMs: fadeMs,
            isCurrent: () => siteTransitionIsCurrent() && transferGeneration === generation,
          });
          if (!faded) throw new RadarSourceSupersededError("Site fade-in was superseded");
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
            transferTiming: sweep.timing,
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
        }
      };

      const acquireSiteSweep = async (
        activeClient: PackedSweepTransferClient,
        site: string,
        generation: number,
        // Diagnostics only: wait for the scan after the current one, a long download.
        waitForNextScan = false,
      ): Promise<PrefetchedSiteSweep> => {
        const lease = await activeClient.requestPhase5Live(site, waitForNextScan, 180);
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
          return { site, generation, model, evidence, timing: lease.timing, fetchedAtUnixMs: Date.now() };
        } finally {
          await lease.release();
        }
      };

      // --- Automatic source switching ------------------------------------------
      // Zoom decides the source; only camera moves the operator makes (or an
      // explicit picker/recenter flight) are evaluated, never programmatic ones.
      let preferredSite: string | undefined;
      let evaluateOnNextMove = false;
      let pendingAutoEvaluation = false;
      // The automatic switch in flight; it may wait on a preload before its
      // transition begins. The latest intent wins: a newer camera or pick
      // abandons a switch it no longer calls for instead of waiting out its
      // download, and the view is re-evaluated once the switch has unwound.
      interface AutoSwitch {
        readonly target: AutoSource;
        // A Site replacing its own archive scan is never abandoned.
        readonly abandonable: boolean;
        // A fresh National acquisition cancels the Site lane it replaces.
        readonly nationalAcquire: boolean;
        abandoned: boolean;
      }
      let autoSwitch: AutoSwitch | null = null;
      let abandonedAutoSwitches = 0;
      let prefetchedSite: PrefetchedSiteSweep | null = null;
      let prefetchInFlight: { site: string; promise: Promise<void> } | null = null;
      let prefetchSession = 0;
      const autoSiteFailures = new Map<string, number>();
      let autoErrorSite: string | undefined;
      let lastAutoFailure: { site: string; message: string; atUnixMs: number } | null = null;
      const clearAutoSiteError = () => {
        if (autoErrorSite === undefined) return;
        autoErrorSite = undefined;
        setAutoSiteError(null);
      };
      let lastAutoDecision: { target: AutoSource; preload?: string; atUnixMs: number } | null = null;

      const prefetchIsUsable = (sweep: PrefetchedSiteSweep | null, site: string) => Boolean(
        sweep
        && sweep.site === site
        && Date.now() - sweep.fetchedAtUnixMs <= SITE_PREFETCH_MAX_AGE_MS
        && client?.isActive("site")
        && client.laneGeneration("site") === sweep.generation,
      );

      const takePrefetchedSite = (site: string, generation: number): PrefetchedSiteSweep | null => {
        const sweep = prefetchedSite;
        prefetchedSite = null;
        prefetchSession += 1;
        return sweep && sweep.generation === generation && prefetchIsUsable(sweep, site) ? sweep : null;
      };

      const prefetchSite = (site: string): Promise<void> => {
        const activeClient = client;
        const snapshot = radarSessionCoordinatorRef.current!.snapshot();
        if (
          !activeClient
          || cancelled
          || snapshot.transition
          || snapshot.painted?.source.kind !== "national"
          || layer
          || !radarSiteById(site)
        ) return Promise.resolve();
        if (prefetchInFlight?.site === site) return prefetchInFlight.promise;
        if (prefetchIsUsable(prefetchedSite, site)) return Promise.resolve();
        const token = ++prefetchSession;
        prefetchedSite = null;
        const generation = nextSiteGeneration();
        transferGeneration = generation;
        const entry: { site: string; promise: Promise<void> } = { site, promise: Promise.resolve() };
        entry.promise = (async () => {
          try {
            await beginSiteLane(activeClient, generation);
            // Cancelled while the lane began: skip the download.
            if (token !== prefetchSession) return;
            const sweep = await acquireSiteSweep(activeClient, site, generation);
            if (token === prefetchSession) prefetchedSite = sweep;
          } catch {
            // Preloading is best-effort; the switch fetches if nothing is ready.
          } finally {
            if (prefetchInFlight === entry) prefetchInFlight = null;
          }
        })();
        prefetchInFlight = entry;
        return entry.promise;
      };

      // Stops a preload the view no longer calls for; its download ends at
      // the backend's next poll instead of running to its timeout.
      const cancelPrefetch = () => {
        if (!prefetchInFlight) return;
        prefetchInFlight = null;
        prefetchSession += 1;
        const snapshot = radarSessionCoordinatorRef.current!.snapshot();
        if (!layer && !snapshot.transition && client?.isActive("site")) {
          void client.cancel("site").catch(() => {});
        }
      };

      const startSiteSession = async (
        site: string,
        options: { persistOnPaint?: boolean; isCurrent?: () => boolean } = {},
      ) => {
        if (!siteLevel2Session) throw new Error("selected-site session is unavailable");
        if (prefetchInFlight?.site === site) await prefetchInFlight.promise;
        if (options.isCurrent && !options.isCurrent()) {
          throw new RadarSourceSupersededError("Site switch was superseded while its scan preloaded");
        }
        const residentGeneration = prefetchIsUsable(prefetchedSite, site)
          ? prefetchedSite!.generation
          : undefined;
        return siteLevel2Session.start(site, {
          persistOnPaint: options.persistOnPaint,
          residentGeneration,
        });
      };

      const beginAutoSwitch = (
        target: AutoSource,
        options: { abandonable: boolean; nationalAcquire?: boolean },
      ): AutoSwitch => {
        const entry: AutoSwitch = {
          target,
          abandonable: options.abandonable,
          nationalAcquire: options.nationalAcquire ?? false,
          abandoned: false,
        };
        autoSwitch = entry;
        return entry;
      };

      const abandonAutoSwitch = () => {
        const entry = autoSwitch;
        if (!entry || entry.abandoned || !entry.abandonable) return;
        entry.abandoned = true;
        abandonedAutoSwitches += 1;
        const coordinator = radarSessionCoordinatorRef.current!;
        const snapshot = coordinator.snapshot();
        const transition = snapshot.transition;
        // The switch's session sees its transition is no longer current and
        // unwinds: a fading Site is removed, a fading-out Site is restored.
        if (transition && sameAutoSource(autoSourceOf(transition.requestedSource), entry.target)) {
          coordinator.cancelPending(snapshot.generation);
        }
        // A Site download checks its lane between polls, so it ends within
        // about a second. National stays visible, so the lane is free.
        if (entry.target.kind === "site" && client?.isActive("site")) {
          void client.cancel("site").catch(() => {});
        }
        // A fresh National load stops at its next backend check, so the Site
        // it would have replaced resumes updating without waiting it out.
        if (entry.nationalAcquire && client?.isActive("national")) {
          void client.cancel("national").catch(() => {});
        }
      };

      // A switch that succeeded re-checks the same camera: Site to Site goes
      // through National, and the second leg needs no further camera move.
      // An abandoned switch re-checks it for the intent that replaced it.
      const settleAutoSwitch = (entry: AutoSwitch, succeeded: boolean) => {
        if (autoSwitch !== entry) return;
        autoSwitch = null;
        if (!succeeded && !entry.abandoned && !pendingAutoEvaluation) return;
        pendingAutoEvaluation = false;
        evaluateAutoSource();
      };

      const evaluateAutoSource = () => {
        if (cancelled || !siteLevel2Session || !nationalMrmsSession) return;
        const snapshot = radarSessionCoordinatorRef.current!.snapshot();
        // A pick's flight is evaluated where it lands; meanwhile its Site preloads.
        if (evaluateOnNextMove && instance.isMoving()) {
          if (preferredSite && !autoSwitch) void prefetchSite(preferredSite);
          return;
        }
        // Manual transitions finish first; an abandoned switch unwinds first.
        if ((snapshot.transition && !autoSwitch) || autoSwitch?.abandoned) {
          pendingAutoEvaluation = true;
          return;
        }
        const painted = snapshot.painted;
        if (!painted) return;
        const visible = autoSourceOf(painted.source);
        const center = instance.getCenter();
        const decision = decideAutoSource({
          zoom: instance.getZoom(),
          center: { longitude: center.lng, latitude: center.lat },
          visible,
          preferredSite,
        }, RADAR_SITES);
        lastAutoDecision = { ...decision, atUnixMs: Date.now() };
        if (decision.preferenceSpent) preferredSite = undefined;
        // The notice only applies while the view still calls for that Site.
        if (decision.target.kind !== "site" || decision.target.siteIcao !== autoErrorSite) {
          clearAutoSiteError();
        }
        if (autoSwitch) {
          if (!sameAutoSource(decision.target, autoSwitch.target)) {
            abandonAutoSwitch();
            pendingAutoEvaluation = true;
          }
          return;
        }
        // A Site showing only the bundled archive scan still needs its live radar.
        const visibleSiteIsLive = painted.source.kind !== "site"
          || residentLiveHistory?.at(-1)?.siteIcao === painted.source.siteIcao;
        if (sameAutoSource(decision.target, visible) && visibleSiteIsLive) {
          if (decision.preload) void prefetchSite(decision.preload);
          else if (visible.kind === "national") cancelPrefetch();
          return;
        }
        if (decision.target.kind === "national") {
          const nationalAcquire = !nationalCanReveal();
          const entry = beginAutoSwitch(decision.target, { abandonable: true, nationalAcquire });
          void nationalMrmsSession.start().then(() => settleAutoSwitch(entry, true), (error: unknown) => {
            if (!isRadarSourceSuperseded(error) && !entry.abandoned) {
              setNationalRequestError(error instanceof Error ? error.message : String(error));
            }
            // A fresh acquisition cancelled the Site lane; the Site it would
            // have replaced keeps updating.
            if (entry.abandoned && entry.nationalAcquire) {
              resumeSitePollingAfterNationalFailure(nationalGeneration);
            }
            // The Site stays; a playhead captured for National no longer applies.
            if (entry.abandoned && playheadCarryRef.current?.target === "national") {
              playheadCarryRef.current = null;
            }
            settleAutoSwitch(entry, false);
          });
          return;
        }
        const target = decision.target.siteIcao;
        const failedAt = autoSiteFailures.get(target);
        if (failedAt !== undefined && Date.now() - failedAt < AUTO_SITE_RETRY_MS) return;
        const entry = beginAutoSwitch(decision.target, { abandonable: visible.kind === "national" });
        void startSiteSession(target, { isCurrent: () => !entry.abandoned }).then(() => {
          clearAutoSiteError();
          settleAutoSwitch(entry, true);
        }, (error: unknown) => {
          if (!isRadarSourceSuperseded(error) && !entry.abandoned) {
            autoSiteFailures.set(target, Date.now());
            lastAutoFailure = {
              site: target,
              message: error instanceof Error ? error.message : String(error),
              atUnixMs: Date.now(),
            };
            autoErrorSite = target;
            setAutoSiteError(target);
            // Retry once the cooldown ends, if the camera still calls for this Site.
            if (autoSiteRetryTimer !== null) globalThis.clearTimeout(autoSiteRetryTimer);
            autoSiteRetryTimer = globalThis.setTimeout(() => {
              autoSiteRetryTimer = null;
              if (!cancelled) evaluateAutoSource();
            }, AUTO_SITE_RETRY_MS + 50);
          }
          settleAutoSwitch(entry, false);
        });
      };

      const autoSourceMoveHandler = (event: { originalEvent?: unknown }) => {
        if (!event.originalEvent && !evaluateOnNextMove) return;
        evaluateOnNextMove = false;
        evaluateAutoSource();
      };
      instance.on("moveend", autoSourceMoveHandler);
      autoSourceMoveHandlerForCleanup = autoSourceMoveHandler;
      // A camera move made during a manual switch is evaluated once it ends.
      unsubscribeAutoSourceFlush = radarSessionCoordinatorRef.current!.subscribe((snapshot) => {
        if (snapshot.transition || autoSwitch || !pendingAutoEvaluation) return;
        pendingAutoEvaluation = false;
        queueMicrotask(evaluateAutoSource);
      });
      autoSourceRef.current = {
        setPreferredSite(site) {
          preferredSite = site;
          // Picking a Site is an explicit retry; it skips the failure cooldown.
          if (site) autoSiteFailures.delete(site);
          // A pick replaces a switch under way unless it is the pick's own next step.
          const painted = radarSessionCoordinatorRef.current!.snapshot().painted;
          if (autoSwitch && painted) {
            const next = pickedNextSource(site, autoSourceOf(painted.source));
            if (!sameAutoSource(next, autoSwitch.target)) abandonAutoSwitch();
          }
        },
        prefetch(site) {
          void prefetchSite(site);
        },
        evaluateAfterNextMove() {
          evaluateOnNextMove = true;
        },
        evaluateIfSettled() {
          // A flight to where the camera already is may never emit moveend.
          if (instance.isMoving()) return;
          evaluateOnNextMove = false;
          evaluateAutoSource();
        },
      };
      globalThis.__MISTR_AUTO_SOURCE__ = {
        evaluate: evaluateAutoSource,
        state: () => ({
          preferredSite: preferredSite ?? null,
          lastDecision: lastAutoDecision,
          prefetchedSite: prefetchedSite
            ? { site: prefetchedSite.site, generation: prefetchedSite.generation, fetchedAtUnixMs: prefetchedSite.fetchedAtUnixMs }
            : null,
          prefetchInFlight: prefetchInFlight?.site ?? null,
          siteOpacity: layer?.getOpacity() ?? null,
          lastFailure: lastAutoFailure,
          switchInFlight: autoSwitch
            ? { target: autoSwitch.target, abandoned: autoSwitch.abandoned }
            : null,
          abandonedSwitches: abandonedAutoSwitches,
        }),
        prefetch: (site) => prefetchSite(normalizeRadarSite(site)),
      };

      const fadeOutSiteLayer = async (isCurrent: () => boolean) => {
        const siteLayer = layer;
        if (!siteLayer) return;
        const faded = await fadeOpacity((value) => siteLayer.setOpacity(value), siteLayer.getOpacity(), 0, {
          durationMs: sourceFadeMs(),
          isCurrent,
        });
        if (!faded) {
          siteLayer.setOpacity(1);
          throw new RadarSourceSupersededError("National switch was superseded during the fade");
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
        setInspectionState("idle");
        inspectionMarkerRef.current?.remove();
        inspectionMarkerRef.current = null;
        inspectionPointRef.current = null;
        interrogationObservationRef.current = null;
        updateDiagnosticSources(instance, model, createAlignmentReport(model));
        carryPlayheadInto("site");
        if (!hideNationalBehindSite()) teardownNational();
        continueLiveBackfillAndPolling(model.siteIcao, pollingSession);
        radarSessionCoordinatorRef.current!.synchronizePaint(
          radarPaintIdentity(model, receipt),
        );
        applySitePlayheadCarry();
      };

      const restoreNationalAfterSiteFailure = () => {
        const sourceState = radarSessionCoordinatorRef.current!.snapshot();
        if (
          cancelled
          || sourceState.transition
          || sourceState.painted?.source.kind !== "national"
        ) return;
        // National never stopped acquiring or playing; only the failed Site
        // lane needs releasing.
        if (client?.isActive("site")) void client.cancel("site").catch(() => {});
        const restoration = (async () => {
          if (!latestNationalPhase3) throw new Error("National radar is no longer displayed");
          return latestNationalPhase3;
        })();
        lastNationalRestorationAfterSiteFailure = restoration;
        void restoration.catch((error: unknown) => {
          if (isRadarSourceSuperseded(error)) return;
          setPlaybackError(error instanceof Error ? error.message : String(error));
        });
      };

      if (!layer) throw new Error("selected-site renderer is unavailable");
      siteLevel2Session = new SiteLevel2Session({
        coordinator: radarSessionCoordinatorRef.current!,
        nextGeneration: () => nextSiteGeneration(),
        acquireAndPaint: async (siteIcao, generation) => {
          // A National layer may exist only as partial staging while Site is
          // still the authoritative paint. Reuse that painted Site renderer
          // until a complete National receipt has actually been accepted.
          const report = isPaintedNationalSource(radarSessionCoordinatorRef.current!.snapshot())
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
        onTransitionFailed: () => {
          restoreNationalAfterSiteFailure();
        },
      });
      siteLevel2SessionRef.current = siteLevel2Session;
      const removeSiteAfterNationalPaint = () => {
        livePollingSession += 1;
        if (client?.isActive("site")) void client.cancel("site").catch(() => {});
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
        // National always sits below the Site stack so a Site can fade over it.
        const nationalBeforeLayerId = () => (
          instance.getLayer(RANGE_LAYER_ID)
            ? RANGE_LAYER_ID
            : radarContextAnchorLayerId(instance.getStyle().layers ?? [])
        );
        nationalLayer = new NationalGridLayer({
          displayMode: displayModeRef.current,
          recoveryBeforeLayerId: nationalBeforeLayerId,
          onSnapshot(renderer) {
            setPlaybackError((current) => playbackErrorAfterRendererStatus(current, renderer.status));
            if (renderer.displayMode !== displayModeRef.current) {
              displayModeRef.current = renderer.displayMode;
              setDisplayMode(renderer.displayMode);
              storeRadarDisplayMode(renderer.displayMode);
            }
            if (latestNationalPhase3) {
              latestNationalPhase3 = { ...latestNationalPhase3, renderer };
              setNationalPhase3(latestNationalPhase3);
            }
            if (nationalPlaybackController) {
              setNationalPlayback(nationalPlaybackController.snapshot());
            }
          },
        });
        nationalWorkingSet = new NationalHistoryWorkingSetController(
          activeClientForNational(),
          nationalLayer,
        );
        addLayer(instance, nationalLayer, nationalBeforeLayerId());
        nationalLayerRef.current = nationalLayer;
        nationalWorkingSetRef.current = nationalWorkingSet;
      };

      const activeClientForNational = () => {
        if (!client) throw new Error("National transfer client is unavailable");
        return client;
      };

      const nationalIsVisible = () => (
        radarSessionCoordinatorRef.current!.snapshot().painted?.source.kind === "national"
      );

      // Background National work while hidden must not overwrite the visible
      // Site's history status or error notice; it is replayed on reveal.
      const reportNationalRequestError = (message: string | null) => {
        if (nationalIsVisible()) setNationalRequestError(message);
        else hiddenNationalRequestError = message;
      };

      const setVisibleNationalHistoryStatus = (status: LiveHistoryStatus) => {
        if (nationalIsVisible()) setLiveHistoryStatus(status);
      };

      const nationalCanReveal = () => Boolean(
        nationalResident
        && nationalLayer
        && latestNationalPhase3
        && client?.isActive("national")
        && client.laneGeneration("national") === nationalGeneration
        && !["error", "removed"].includes(nationalLayer.getSnapshot().status),
      );

      // --- Playback time across a source switch ---------------------------------
      const captureNationalPlayhead = (): CarriedPlayhead | null => {
        const snapshot = nationalPlaybackController?.snapshot();
        const newest = nationalObservations.at(-1);
        if (!snapshot || snapshot.playheadObservedAtUnixMs === undefined || !newest) return null;
        return {
          observedAtUnixMs: snapshot.playheadObservedAtUnixMs,
          playing: snapshot.playing || snapshot.resumingAfterReplacement,
          atNewest: snapshot.selectedObservationId === nationalObservationId(newest),
        };
      };

      const captureSitePlayhead = (): CarriedPlayhead | null => {
        const snapshot = controller?.snapshot();
        const newest = residentLiveHistory?.at(-1);
        // Only a live Site carries its time; the startup archive scan does not.
        if (
          !snapshot
          || !newest
          || newest.sourceKind !== "nexrad_level2_chunks"
          || snapshot.playheadObservedAtUnixMs === undefined
        ) return null;
        return {
          observedAtUnixMs: snapshot.playheadObservedAtUnixMs,
          playing: snapshot.playing,
          atNewest: snapshot.selectedObservationId === newest.observationId,
        };
      };

      const carryPlayheadInto = (target: "site" | "national"): CarriedPlayhead | null => {
        const pending = playheadCarryRef.current;
        // A carry the outgoing source never got to apply passes through as is.
        const playhead = pending && pending.target !== target
          ? pending.playhead
          : target === "site" ? captureNationalPlayhead() : captureSitePlayhead();
        playheadCarryRef.current = playhead ? { target, playhead } : null;
        return playhead;
      };

      const applySitePlayheadCarry = (historyComplete = false) => {
        const carry = playheadCarryRef.current;
        const activeController = controller;
        const history = residentLiveHistory;
        if (carry?.target !== "site" || !activeController || !history) return;
        if (activeController.snapshot().residentReplacementPending) return;
        const step = planPlayheadCarry(
          carry.playhead,
          history.map((frame) => frame.observedAtUnixMs),
          historyComplete,
        );
        if (step.kind === "wait") return;
        playheadCarryRef.current = null;
        if (step.kind === "done") return;
        const intent = operatorPlaybackIntentRef.current;
        void (async () => {
          if (activeController.snapshot().selectedObservationId !== history[step.index].observationId) {
            await activeController.scrub(step.index);
          }
          if (
            step.play
            && !cancelled
            && controller === activeController
            && operatorPlaybackIntentRef.current === intent
          ) activeController.play();
        })().catch(() => {
          // A history update landed mid-scrub; retry on the next one unless
          // the operator or another switch has taken over since.
          if (playheadCarryRef.current === null && operatorPlaybackIntentRef.current === intent) {
            playheadCarryRef.current = carry;
          }
        });
      };

      const applyNationalPlayheadCarry = (historyComplete = false) => {
        const carry = playheadCarryRef.current;
        const activeController = nationalPlaybackController;
        if (carry?.target !== "national" || !activeController || !nationalIsVisible()) return;
        const observations = nationalObservations;
        const step = planPlayheadCarry(
          carry.playhead,
          observations.map((observation) => observation.observationTimeUnixMs),
          historyComplete,
        );
        if (step.kind === "wait") return;
        playheadCarryRef.current = null;
        if (step.kind === "done") return;
        const intent = operatorPlaybackIntentRef.current;
        void (async () => {
          const target = nationalObservationId(observations[step.index]);
          if (activeController.snapshot().selectedObservationId !== target) {
            await activeController.scrub(step.index);
          }
          if (
            step.play
            && !cancelled
            && nationalPlaybackController === activeController
            && operatorPlaybackIntentRef.current === intent
          ) await activeController.play();
        })().catch(() => {
          // A history commit landed mid-scrub; retry on the next one unless
          // the operator or another switch has taken over since.
          if (playheadCarryRef.current === null && operatorPlaybackIntentRef.current === intent) {
            playheadCarryRef.current = carry;
          }
        });
      };

      const hideNationalBehindSite = (): boolean => {
        const activeLayer = nationalLayer;
        if (
          !activeLayer
          || !latestNationalPhase3
          || !client?.isActive("national")
          || client.laneGeneration("national") !== nationalGeneration
          || ["error", "removed"].includes(activeLayer.getSnapshot().status)
        ) return false;
        nationalPlaybackController?.pause();
        activeLayer.setVisibility("resident");
        nationalResident = true;
        nationalInspectionLookupQueueForCleanup?.cancelPending();
        return true;
      };

      const teardownNational = () => {
        if (nationalLayer && instance.getLayer(nationalLayer.id)) instance.removeLayer(nationalLayer.id);
        nationalLayer = null;
        nationalWorkingSet = null;
        nationalPlaybackController?.dispose();
        nationalPlaybackController = null;
        nationalPlaybackControllerRef.current = null;
        nationalObservations = [];
        latestNationalHistory = null;
        nationalHistorySession += 1;
        nationalResident = false;
        hiddenNationalRequestError = null;
        nationalLayerRef.current = null;
        nationalWorkingSetRef.current = null;
        latestNationalPhase3 = null;
        setNationalPhase3(null);
        setNationalPlayback(null);
        setNationalHistory(null);
        if (client?.isActive("national")) void client.cancel("national").catch(() => {});
      };

      const beginSiteLane = async (activeClient: PackedSweepTransferClient, generation: number) => {
        // Cancel National only when nothing displays or keeps it resident.
        if (activeClient.isActive("national") && !nationalResident && !nationalIsVisible()) {
          await activeClient.cancel("national");
        }
        await activeClient.begin("site", generation);
      };

      const nationalInspectionLookupQueue = new LatestOnlyAsyncQueue<
        NationalInspectionLookupRequest,
        NationalPointLookup | null
      >(async (request) => {
        if (
          inspectionRequestRef.current !== request.inspectionId
          || !inspectionPointRef.current
        ) return null;
        try {
          const lookup = await activeClientForNational().lookupNationalHistoryPoint({
            generation: request.receipt.generation,
            observationTimeUnixMs: request.receipt.observationTimeUnixMs,
            contentSha256: request.receipt.contentSha256,
            inspectionId: request.inspectionId,
            longitude: request.longitude,
            latitude: request.latitude,
          });
          const painted = radarSessionCoordinatorRef.current!.snapshot().painted;
          const currentReceipt = nationalLayer?.getSnapshot().paintReceipt;
          if (
            inspectionRequestRef.current !== request.inspectionId
            || painted?.source.kind !== "national"
            || painted.generation !== request.receipt.generation
            || painted.observationId !== request.receipt.observationId
            || currentReceipt?.generation !== request.receipt.generation
            || currentReceipt.observationId !== request.receipt.observationId
            || currentReceipt.observationTimeUnixMs !== request.receipt.observationTimeUnixMs
            || currentReceipt.contentSha256 !== request.receipt.contentSha256
          ) return null;
          latestNationalInspection = lookup;
          setInterrogation(nationalPointInterrogation(lookup));
          setInspectionState("settled");
          return lookup;
        } catch (error) {
          if (inspectionRequestRef.current === request.inspectionId) {
            setInterrogation(null);
            setInspectionState(
              nationalHistoryErrorCode(error) === "national_point_outside_coverage"
                ? "outside"
                : "unavailable",
            );
          }
          return null;
        }
      });
      nationalInspectionLookupQueueForCleanup = nationalInspectionLookupQueue;

      const refreshNationalInterrogation = async (
        receipt: NationalPaintReceipt,
      ): Promise<NationalPointLookup | null> => {
        const point = inspectionPointRef.current;
        if (!point) return null;
        if (interrogationObservationRef.current === receipt.observationId) {
          if (latestNationalInspection) return latestNationalInspection;
          await nationalInspectionLookupQueue.waitForIdle();
          return interrogationObservationRef.current === receipt.observationId
            ? latestNationalInspection
            : null;
        }
        const inspectionId = globalThis.crypto.randomUUID();
        inspectionRequestRef.current = inspectionId;
        interrogationObservationRef.current = receipt.observationId;
        latestNationalInspection = null;
        setInterrogation(null);
        setInspectionState("pending");
        const result = await nationalInspectionLookupQueue.enqueue({
          receipt,
          inspectionId,
          ...point,
        });
        return inspectionRequestRef.current === inspectionId ? result : null;
      };

      const finalizeNationalHistoryCommit = async (
        activeClient: PackedSweepTransferClient,
        observation: NationalHistoryObservation,
      ): Promise<NationalHistorySnapshot> => {
        return finalizeNationalHistoryUntilSettled({
          shouldContinue: () => !cancelled,
          finalize: () => activeClient.finalizeNationalHistoryFrame(observation),
          async recoverFinalized() {
            const snapshot = await activeClient.nationalHistorySnapshot();
            return nationalHistoryContainsFinalizedObservation(snapshot, observation)
              ? snapshot
              : null;
          },
          isTerminal: (error) => (
            nationalHistoryErrorCode(error) === "national_history_generation_stale"
          ),
          onFailure(error) {
            reportNationalRequestError(
              `National history is sealing before acquisition can continue: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
          waitBeforeRetry: (attempt) => waitMilliseconds(
            Math.min(1_000, 25 * (2 ** (attempt - 1))),
          ),
          cancellationError: () => new RadarSourceSupersededError(
            "National history finalization was cancelled during application teardown",
          ),
        });
      };

      const rollbackNationalHistoryCommit = async (
        activeClient: PackedSweepTransferClient,
        observation: NationalHistoryObservation,
      ): Promise<NationalHistorySnapshot> => {
        return rollbackNationalHistoryUntilSettled({
          shouldContinue: () => !cancelled,
          rollback: () => activeClient.rollbackNationalHistoryFrame(observation),
          async recoverRolledBack() {
            const snapshot = await activeClient.nationalHistorySnapshot();
            return snapshotProvesNationalHistoryRollback(snapshot, observation)
              ? snapshot
              : null;
          },
          isTerminal: (error) => (
            nationalHistoryErrorCode(error) === "national_history_generation_stale"
          ),
          onFailure(error) {
            reportNationalRequestError(
              `National history is rolling back before acquisition can continue: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
          waitBeforeRetry: (attempt) => waitMilliseconds(
            Math.min(1_000, 25 * (2 ** (attempt - 1))),
          ),
          cancellationError: () => new RadarSourceSupersededError(
            "National history rollback was cancelled during application teardown",
          ),
        });
      };

      const acquireNationalResidentOnlyActivity = async (): Promise<() => void> => {
        nationalResidentOnlyReservations += 1;
        const acquisition = nationalAcquisitionOperation;
        if (acquisition) await acquisition.catch(() => {});
        await nationalWorkingSet?.waitForIdle();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          nationalResidentOnlyReservations = Math.max(0, nationalResidentOnlyReservations - 1);
        };
      };

      const runNationalAcquisition = async <T,>(operation: () => Promise<T>): Promise<T> => {
        while (nationalResidentOnlyReservations > 0) {
          await waitMilliseconds(100);
        }
        const pending = operation();
        nationalAcquisitionOperation = pending;
        try {
          return await pending;
        } finally {
          if (nationalAcquisitionOperation === pending) nationalAcquisitionOperation = null;
        }
      };



      const publishNationalHistory = (
        history: NationalHistorySnapshot,
        receipt: NationalPaintReceipt,
        resumePlayback: boolean,
      ) => {
        nationalObservations = [...history.retained];
        latestNationalHistory = history;
        setNationalHistory(history);
        if (nationalIsVisible()) {
          setTimelineFrames(nationalObservations.map((observation) => ({
            observationId: nationalObservationId(observation),
            observedAtUnixMs: observation.observationTimeUnixMs,
          })));
        }
        setVisibleNationalHistoryStatus(nationalHistoryStatus(
          history.retained.length,
          history.historyLimit,
          history.pendingBackfillCount,
          activeNationalBackfillSession !== null,
        ));
        nationalPlaybackController?.acceptHistory(nationalObservations, receipt);
        nationalPlaybackController?.resumeAfterMutation(resumePlayback);
        applyNationalPlayheadCarry();
      };

      const nationalHistoryOwnershipCheck = (generation: number, historySession: number) => {
        const painted = radarSessionCoordinatorRef.current!.snapshot().painted;
        const displayed = painted?.source.kind === "national" && painted.generation === generation;
        if (
          cancelled
          || historySession !== nationalHistorySession
          || nationalGeneration !== generation
          || !client?.isActive("national")
          || client.laneGeneration("national") !== generation
          || !(displayed || nationalResident)
        ) {
          throw new RadarSourceSupersededError("National history work was superseded");
        }
      };

      const commitNationalHistoryMutation = async (
        preparation: NationalHistoryPrepareReport,
        historySession: number,
      ) => {
        const activeClient = activeClientForNational();
        const activeWorkingSet = nationalWorkingSet;
        const activePlayback = nationalPlaybackController;
        const activeLayer = nationalLayer;
        if (!activeWorkingSet || !activePlayback || !activeLayer) {
          throw new Error("National history renderer is unavailable");
        }
        const generation = preparation.observation.generation;
        const before = [...nationalObservations];
        const candidateId = nationalObservationId(preparation.observation);
        const proposed = preparation.kind === "predecessor"
          ? [preparation.observation, ...before]
          : [...before, preparation.observation].slice(-MAX_LIVE_HISTORY_FRAMES);
        const previousNewestId = before.length > 0
          ? nationalObservationId(before.at(-1)!)
          : candidateId;
        // Resolve only after staging and the pending playback paint have settled.
        // Capturing this before uploading would rewind a still-running loop.
        const selectionAtCommit = () => {
          const current = activePlayback.snapshot();
          let selected = current.selectedObservationId;
          if (preparation.kind === "newer" && !resumePlayback && !current.playing
            && selected === previousNewestId) selected = candidateId;
          return proposed.some(item => nationalObservationId(item) === selected)
            ? selected : nationalObservationId(proposed[0]);
        };
        let resumePlayback = false;
        let workingSet: NationalHistoryWorkingSetResult | undefined;
        let backendFinalized = false;
        let rendererFinalized = false;
        try {
          traceNationalLoad("commit:wait-idle", preparation.kind);
          await activeWorkingSet.waitForIdle();
          nationalHistoryOwnershipCheck(generation, historySession);
          traceNationalLoad("commit:stage");
          workingSet = await activeWorkingSet.stageHistoryOverview(
            preparation.observation,
            proposed.map(nationalObservationId),
            selectionAtCommit,
            () => nationalHistoryOwnershipCheck(generation, historySession),
            async () => {
              activePlayback.markReplacementPending(true);
              traceNationalLoad("commit:pause-playback");
              // Even an operator-paused loop may still have a paint in flight.
              resumePlayback = await activePlayback.pauseAndWait(false);
              traceNationalLoad("commit:playback-paused");
              nationalHistoryOwnershipCheck(generation, historySession);
            },
          );
          traceNationalLoad("commit:staged");
          if (!workingSet.receipt) {
            throw new Error("National history mutation completed without a paint receipt");
          }
          nationalHistoryOwnershipCheck(generation, historySession);
          traceNationalLoad("commit:backend");
          await activeClient.commitNationalHistoryFrame(preparation.observation);
          nationalHistoryOwnershipCheck(generation, historySession);
          activeLayer.finalizeHistoryMutation(workingSet.receipt);
          rendererFinalized = true;
          const finalizedHistory = await finalizeNationalHistoryCommit(
            activeClient,
            preparation.observation,
          );
          backendFinalized = true;
          traceNationalLoad("commit:wait-paint");
          const authoritativeReceipt = await activeLayer.waitForAuthoritativeReceipt(
            workingSet.receipt,
          );
          nationalHistoryOwnershipCheck(generation, historySession);
          const finalizedWorkingSet = { ...workingSet, receipt: authoritativeReceipt };
          publishNationalHistory(finalizedHistory, authoritativeReceipt, resumePlayback);
          traceNationalLoad("commit:published", String(finalizedHistory.retained.length));
          reportNationalRequestError(null);
          return finalizedWorkingSet;
        } catch (error) {
          traceNationalLoad("commit:failed", error instanceof Error ? error.message : String(error));
          activePlayback.markReplacementPending(false);
          if (workingSet?.receipt && !rendererFinalized) {
            try {
              await activeLayer.rollbackHistoryMutation(workingSet.receipt);
            } catch {
              // The controller may already have rolled back a superseded paint.
            }
          }
          if (!backendFinalized && !rendererFinalized) {
            try {
              await rollbackNationalHistoryCommit(activeClient, preparation.observation);
            } catch {
              // A newer generation may already own the backend. Preserve the
              // original mutation error rather than relabeling it.
            }
          }
          activePlayback.resumeAfterMutation(resumePlayback);
          throw error;
        }
      };

      const runNationalPolling = async (generation: number, historySession: number) => {
        await runNationalPollingLoop({
          shouldContinue: () => !cancelled && historySession === nationalHistorySession,
          poll: () => runNationalAcquisition(async () => {
            nationalHistoryOwnershipCheck(generation, historySession);
            const preparation = await activeClientForNational().prepareNationalHistoryNewer();
            nationalHistoryOwnershipCheck(generation, historySession);
            await commitNationalHistoryMutation(preparation, historySession);
          }),
          classifyError(error) {
            if (isRadarSourceSuperseded(error)) return "superseded";
            return nationalHistoryErrorCode(error) === "mrms_not_strictly_newer"
              ? "not_strictly_newer"
              : "failure";
          },
          onHealthyPoll() {
            reportNationalRequestError(null);
          },
          onFailure(error) {
            reportNationalRequestError(error instanceof Error ? error.message : String(error));
          },
          async requestDelayMs(attempt) {
            const delay = await activeClientForNational().nationalHistoryPollDelay(
              attempt,
              Date.now() % Number.MAX_SAFE_INTEGER,
            );
            return delay.totalMs;
          },
          wait: waitMilliseconds,
        });
      };

      const runNationalBackfill = async (generation: number) => {
        nationalBackfillStartCount += 1;
        const historySession = nationalHistorySession + 1;
        nationalHistorySession = historySession;
        activeNationalBackfillSession = historySession;
        setVisibleNationalHistoryStatus("loading");
        traceNationalLoad("backfill:start", String(generation));
        // Newer observations are checked while the history fills, so fresh
        // weather never waits behind the whole backfill.
        let nextFreshnessCheckAt = Date.now() + NATIONAL_BACKFILL_FRESHNESS_MS;
        let freshnessAttempt = 0;
        const freshness = { checks: 0, commits: 0, startedAtUnixMs: Date.now(), completedAtUnixMs: 0 };
        nationalBackfillFreshness = freshness;
        const checkFreshnessDuringBackfill = async () => {
          if (Date.now() < nextFreshnessCheckAt) return;
          freshness.checks += 1;
          try {
            await runNationalAcquisition(async () => {
              nationalHistoryOwnershipCheck(generation, historySession);
              traceNationalLoad("backfill:freshness-check");
              const preparation = await activeClientForNational().prepareNationalHistoryNewer();
              nationalHistoryOwnershipCheck(generation, historySession);
              await commitNationalHistoryMutation(preparation, historySession);
            });
            freshness.commits += 1;
            freshnessAttempt = 0;
          } catch (error) {
            if (isRadarSourceSuperseded(error)) throw error;
            freshnessAttempt = nationalHistoryErrorCode(error) === "mrms_not_strictly_newer"
              ? 0
              : Math.min(freshnessAttempt + 1, 3);
          }
          nextFreshnessCheckAt = Date.now() + Math.max(
            NATIONAL_BACKFILL_FRESHNESS_MS,
            nationalPollingFallbackDelayMs(freshnessAttempt),
          );
        };
        try {
          const result = await runNationalBackfillLoop({
            shouldContinue: () => !cancelled && historySession === nationalHistorySession,
            prepare: () => runNationalAcquisition(async () => {
              nationalHistoryOwnershipCheck(generation, historySession);
              traceNationalLoad("backfill:prepare");
              const preparation = await activeClientForNational().prepareNationalHistoryPredecessor();
              traceNationalLoad("backfill:prepared");
              return preparation;
            }),
            commit: async (preparation) => {
              await runNationalAcquisition(
                () => commitNationalHistoryMutation(preparation, historySession),
              );
            },
            reachedLimit: () => nationalObservations.length >= MAX_LIVE_HISTORY_FRAMES,
            isSuperseded: isRadarSourceSuperseded,
            betweenSteps: checkFreshnessDuringBackfill,
            onFailure(error) {
              traceNationalLoad("backfill:failure", error instanceof Error ? error.message : String(error));
              setVisibleNationalHistoryStatus(nationalObservations.length >= MAX_LIVE_HISTORY_FRAMES ? "full" : "loading");
              reportNationalRequestError(error instanceof Error ? error.message : String(error));
            },
            async waitBeforeRetry(attempt) {
              let delayMs: number;
              try {
                const delay = await activeClientForNational().nationalHistoryPollDelay(
                  attempt,
                  Date.now() % Number.MAX_SAFE_INTEGER,
                );
                delayMs = delay.totalMs;
              } catch (error) {
                nationalHistoryOwnershipCheck(generation, historySession);
                reportNationalRequestError(error instanceof Error ? error.message : String(error));
                delayMs = nationalPollingFallbackDelayMs(attempt);
              }
              traceNationalLoad("backfill:retry-wait", String(delayMs));
              // A predecessor waiting to retry must not hold newer observations
              // back: freshness checks keep their own cadence through the wait.
              await waitRunningDueChecks(delayMs, {
                nextCheckAt: () => nextFreshnessCheckAt,
                check: async () => {
                  nationalHistoryOwnershipCheck(generation, historySession);
                  await checkFreshnessDuringBackfill();
                },
                wait: waitMilliseconds,
              });
              nationalHistoryOwnershipCheck(generation, historySession);
            },
          }).finally(() => {
            if (activeNationalBackfillSession === historySession) activeNationalBackfillSession = null;
          });
          traceNationalLoad("backfill:end", result);
          freshness.completedAtUnixMs = Date.now();
          if (result === "superseded") return;
          nationalHistoryOwnershipCheck(generation, historySession);
          setVisibleNationalHistoryStatus(nationalObservations.length >= MAX_LIVE_HISTORY_FRAMES ? "full" : "partial");
          applyNationalPlayheadCarry(true);
          await runNationalPolling(generation, historySession);
        } catch (error) {
          traceNationalLoad("backfill:error", error instanceof Error ? error.message : String(error));
          if (isRadarSourceSuperseded(error)) return;
          setVisibleNationalHistoryStatus(nationalObservations.length >= MAX_LIVE_HISTORY_FRAMES ? "full" : "partial");
          reportNationalRequestError(error instanceof Error ? error.message : String(error));
        }
      };

      const revealResidentNational = async (
        generation: number,
      ): Promise<NationalMrmsPaintResult<NationalPhase3Report>> => {
        const activeLayer = nationalLayer;
        const priorReport = latestNationalPhase3;
        if (!activeLayer || !priorReport || !nationalResident || nationalGeneration !== generation) {
          throw new Error("resident National radar is unavailable");
        }
        let receipt: NationalPaintReceipt;
        try {
          const carried = carryPlayheadInto("national");
          const step = carried
            ? planPlayheadCarry(
              carried,
              nationalObservations.map((observation) => observation.observationTimeUnixMs),
              activeNationalBackfillSession === null,
            )
            : undefined;
          receipt = await activeLayer.revealAndWait(
            undefined,
            step?.kind === "apply" ? nationalObservationId(nationalObservations[step.index]) : undefined,
          );
          const transition = radarSessionCoordinatorRef.current!.snapshot().transition;
          if (transition?.generation !== generation || transition.requestedSource.kind !== "national") {
            throw new RadarSourceSupersededError("National reveal was superseded");
          }
          if (!receipt.presented || receipt.generation !== generation) {
            throw new Error("National reveal did not paint the resident history");
          }
          await fadeOutSiteLayer(() => {
            const current = radarSessionCoordinatorRef.current!.snapshot().transition;
            return current?.generation === generation && current.requestedSource.kind === "national";
          });
        } catch (error) {
          if (nationalResident && nationalLayer === activeLayer) activeLayer.setVisibility("resident");
          layer?.setOpacity(1);
          throw error;
        }
        const report: NationalPhase3Report = {
          ...priorReport,
          workingSet: { ...priorReport.workingSet, receipt },
          renderer: activeLayer.getSnapshot(),
        };
        revealedNationalReports.add(report);
        return {
          value: report,
          paint: {
            source: { kind: "national", domain: "conus" },
            generation,
            observationId: receipt.observationId,
          },
        };
      };

      const acceptRevealedNational = (report: NationalPhase3Report) => {
        latestNationalPhase3 = report;
        setNationalPhase3(report);
        nationalResident = false;
        // Remove the Site first: its teardown resets the shared history status.
        removeSiteAfterNationalPaint();
        if (latestNationalHistory) setNationalHistory(latestNationalHistory);
        setTimelineFrames(nationalObservations.map((observation) => ({
          observationId: nationalObservationId(observation),
          observedAtUnixMs: observation.observationTimeUnixMs,
        })));
        setLiveHistoryStatus(latestNationalHistory
          ? nationalHistoryStatus(
            latestNationalHistory.retained.length,
            latestNationalHistory.historyLimit,
            latestNationalHistory.pendingBackfillCount,
            activeNationalBackfillSession !== null,
          )
          : "partial");
        setNationalRequestError(hiddenNationalRequestError);
        hiddenNationalRequestError = null;
        setInterrogation(null);
        latestNationalInspection = null;
        setInspectionState("idle");
        inspectionMarkerRef.current?.remove();
        inspectionMarkerRef.current = null;
        inspectionPointRef.current = null;
        interrogationObservationRef.current = null;
        inspectionRequestRef.current = null;
        nationalInspectionLookupQueue.cancelPending();
        nationalPlaybackController?.acceptHistory(nationalObservations, report.workingSet.receipt);
        applyNationalPlayheadCarry(activeNationalBackfillSession === null);
      };

      nationalMrmsSession = new NationalMrmsSession({
        coordinator: radarSessionCoordinatorRef.current!,
        nextGeneration: () => Math.max(
          transferGeneration + 1,
          (layer?.getSnapshot().generation ?? transferGeneration) + 1,
          (nationalLayer?.getSnapshot().generation ?? transferGeneration) + 1,
        ),
        residentGeneration: () => (nationalCanReveal() ? nationalGeneration : undefined),
        acquireAndPaint: async (generation, mode) => {
          if (mode === "reveal") return revealResidentNational(generation);
          const activeClient = activeClientForNational();
          transferGeneration = generation;
          nationalGeneration = generation;
          nationalResident = false;
          hiddenNationalRequestError = null;
          livePollingSession += 1;
          nationalHistorySession += 1;
          await beginExclusiveLane(activeClient, "national", generation);
          const pending = radarSessionCoordinatorRef.current!.snapshot().transition;
          if (pending?.generation !== generation || pending.requestedSource.kind !== "national") {
            throw new RadarSourceSupersededError("National transition was superseded before its download");
          }
          const historyPreparation = await activeClient.prepareNationalHistoryCurrent();
          if (
            historyPreparation.observation.generation !== generation
            || transferGeneration !== generation
          ) {
            throw new RadarSourceSupersededError("National preparation was superseded");
          }
          ensureNationalLayer();
          const activeLayer = nationalLayer!;
          const activeWorkingSet = nationalWorkingSet!;
          activeLayer.setVisibility("visible");
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
          let backendFinalized = false;
          let rendererFinalized = false;
          try {
            let historyWorkingSet: NationalHistoryWorkingSetResult | undefined;
            historyWorkingSet = await activeWorkingSet.stageInitialOverview(
              historyPreparation.observation,
              ownershipCheck,
            );
            if (!historyWorkingSet.receipt) {
              throw new Error("National current frame completed without a paint receipt");
            }
            await activeClient.commitNationalHistoryFrame(
              historyPreparation.observation,
            );
            ownershipCheck();
            activeLayer.finalizeHistoryMutation(historyWorkingSet.receipt);
            rendererFinalized = true;
            const finalizedHistory = await finalizeNationalHistoryCommit(
              activeClient,
              historyPreparation.observation,
            );
            backendFinalized = true;
            const authoritativeReceipt = await activeLayer.waitForAuthoritativeReceipt(
              historyWorkingSet.receipt,
            );
            ownershipCheck();
            await fadeOutSiteLayer(() => {
              try {
                ownershipCheck();
                return true;
              } catch {
                return false;
              }
            });
            const workingSet = workingSetWithReceipt({
              ...historyWorkingSet,
              receipt: authoritativeReceipt,
            });
            const preparation = phase3CompatibilityPreparation(historyPreparation);
            const renderer = activeLayer.getSnapshot();
            const report: NationalPhase3Report = { preparation, workingSet, renderer };
            nationalObservations = [...finalizedHistory.retained];
            latestNationalHistory = finalizedHistory;
            setNationalHistory(finalizedHistory);
            return {
              value: report,
              paint: {
                source: { kind: "national", domain: "conus" },
                generation: historyWorkingSet.receipt.generation,
                observationId: historyWorkingSet.receipt.observationId,
              },
            };
          } catch (error) {
            const receipt = activeLayer.getSnapshot().mutationAwaitingCommit
              ? activeLayer.getSnapshot().paintReceipt
              : undefined;
            if (receipt && !rendererFinalized) {
              try {
                await activeLayer.rollbackHistoryMutation(receipt);
              } catch {
                // The renderer may already have rolled back during supersession.
              }
            }
            if (!backendFinalized && !rendererFinalized) {
              try {
                await rollbackNationalHistoryCommit(
                  activeClient,
                  historyPreparation.observation,
                );
              } catch {
                // Preserve the acquisition/rendering failure that caused rollback.
              }
            }
            activeLayer.setPresentationEnabled(
              radarSessionCoordinatorRef.current!.snapshot().painted?.source.kind === "national",
            );
            throw error;
          }
        },
        onPaintAccepted: (report) => {
          if (revealedNationalReports.has(report)) {
            acceptRevealedNational(report);
            return;
          }
          latestNationalPhase3 = report;
          setNationalPhase3(report);
          const currentObservation = nationalObservations[0];
          if (!currentObservation) {
            throw new Error("National source painted without a retained current observation");
          }
          carryPlayheadInto("national");
          nationalPlaybackController?.dispose();
          nationalPlaybackController = new NationalPlaybackController(
            nationalLayer!,
            nationalObservations,
            {
              onState(snapshot) {
                setNationalPlayback(snapshot);
              },
              onPaint(receipt) {
                // A hidden commit completes on a fence; nothing was drawn.
                if (!receipt.presented) return;
                void refreshNationalInterrogation(receipt);
                radarSessionCoordinatorRef.current!.synchronizePaint({
                  source: { kind: "national", domain: "conus" },
                  generation: receipt.generation,
                  observationId: receipt.observationId,
                });
                if (latestNationalPhase3) {
                  latestNationalPhase3 = {
                    ...latestNationalPhase3,
                    renderer: nationalLayer?.getSnapshot() ?? latestNationalPhase3.renderer,
                  };
                  setNationalPhase3(latestNationalPhase3);
                }
              },
              acquireResidentOnlyActivity: acquireNationalResidentOnlyActivity,
            },
          );
          nationalPlaybackControllerRef.current = nationalPlaybackController;
          nationalPlaybackController.establishInitialPaint(report.workingSet.receipt);
          setTimelineFrames(nationalObservations.map((observation) => ({
            observationId: nationalObservationId(observation),
            observedAtUnixMs: observation.observationTimeUnixMs,
          })));
          setLiveHistoryStatus("loading");
          setInterrogation(null);
          latestNationalInspection = null;
          setInspectionState("idle");
          inspectionMarkerRef.current?.remove();
          inspectionMarkerRef.current = null;
          inspectionPointRef.current = null;
          interrogationObservationRef.current = null;
          inspectionRequestRef.current = null;
          nationalInspectionLookupQueue.cancelPending();
          removeSiteAfterNationalPaint();
          setLiveHistoryStatus(staticNationalDiagnostic ? "partial" : "loading");
          if (!staticNationalDiagnostic) {
            void runNationalBackfill(report.workingSet.receipt.generation);
          }
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
            throw new Error("diagnostic history limit must be between 4 and 60 frames");
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
          await beginExclusiveLane(client, "site", generation);
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
        await beginExclusiveLane(client, "site", generation);
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
            setInspectionState("settled");
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
        if (nationalResident) teardownNational();
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
          await beginExclusiveLane(client, "site", generation);
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
          if (nationalResident) teardownNational();
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
            await beginExclusiveLane(client, "national", generation);
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
        async startNational() {
          if (!nationalMrmsSession) throw new Error("National session is unavailable");
          staticNationalDiagnostic = true;
          try {
            return await nationalMrmsSession.start();
          } finally {
            staticNationalDiagnostic = false;
          }
        },
        startSite: (site = "KTLX") => siteLevel2Session?.start(normalizeRadarSite(site))
          ?? Promise.reject(new Error("Site session is unavailable")),
        async refineForCamera() {
          // Native residency: every retained observation is already the exact
          // full-resolution presentation, so there is nothing to refine.
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
          return client.lookupNationalHistoryPoint({
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
          return client.findNationalHistoryPeakPoint({
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
      globalThis.__MISTR_NATIONAL_PHASE4__ = {
        loadTrace: () => [...nationalLoadTrace],
        report: () => ({
          backfillFreshness: { ...nationalBackfillFreshness },
          history: latestNationalHistory,
          renderer: nationalLayer?.getSnapshot() ?? null,
          playback: nationalPlaybackController?.snapshot() ?? null,
          inspectionQueue: nationalInspectionLookupQueue.snapshot(),
        }),
        startNational: () => nationalMrmsSession?.start()
          ?? Promise.reject(new Error("National session is unavailable")),
        startSite: (site = "KTLX") => siteLevel2Session?.start(normalizeRadarSite(site))
          ?? Promise.reject(new Error("Site session is unavailable")),
        async proveFailedSiteKeepsNational(site = "KTLX") {
          if (!client || !siteLevel2Session || !nationalLayer || !nationalPlaybackController) {
            throw new Error("National failed-Site diagnostic is unavailable");
          }
          const before = radarSessionCoordinatorRef.current!.snapshot();
          const rendererBeforeFailure = nationalLayer.getSnapshot();
          const backfillStartCountBefore = nationalBackfillStartCount;
          if (before.transition || before.painted?.source.kind !== "national") {
            throw new Error("National must be the settled painted source before the failed-Site proof");
          }
          await nationalPlaybackController.play();
          const playbackBeforeFailure = nationalPlaybackController.snapshot();
          if (!playbackBeforeFailure.playing) {
            throw new Error("National playback did not start before the failed-Site proof");
          }
          failNextSiteFromNationalForDiagnostics = true;
          let failureMessage = "";
          try {
            await siteLevel2Session.start(normalizeRadarSite(site), { persistOnPaint: false });
            throw new Error("diagnostic Site transition unexpectedly succeeded");
          } catch (error) {
            failureMessage = error instanceof Error ? error.message : String(error);
            if (failureMessage !== "diagnostic Site transition failure after the Site lane began") {
              throw error;
            }
          } finally {
            failNextSiteFromNationalForDiagnostics = false;
          }
          const restoration = lastNationalRestorationAfterSiteFailure;
          if (!restoration) throw new Error("failed Site transition did not settle National");
          await restoration;
          return {
            failureMessage,
            before,
            after: radarSessionCoordinatorRef.current!.snapshot(),
            history: latestNationalHistory,
            renderer: nationalLayer.getSnapshot(),
            transfer: await client.transferSnapshot(),
            backfillStartCountBefore,
            backfillStartCountAfter: nationalBackfillStartCount,
            playbackBeforeFailure,
            playbackAfterRestoration: nationalPlaybackController?.snapshot() ?? null,
            rendererBeforeFailure,
          };
        },
        async proveResidentHandoff(site = "KTLX") {
          if (!client || !siteLevel2Session || !nationalMrmsSession || !nationalLayer) {
            throw new Error("National resident handoff diagnostic is unavailable");
          }
          const before = radarSessionCoordinatorRef.current!.snapshot();
          if (before.transition || before.painted?.source.kind !== "national") {
            throw new Error("National must be the settled painted source before the handoff proof");
          }
          const nationalGenerationBefore = nationalGeneration;
          const backfillStartCountBefore = nationalBackfillStartCount;
          const retainedBefore = latestNationalHistory?.retained.length ?? 0;
          await siteLevel2Session.start(normalizeRadarSite(site), { persistOnPaint: false });
          const whileSite = {
            sourceState: radarSessionCoordinatorRef.current!.snapshot(),
            renderer: nationalLayer?.getSnapshot() ?? null,
            transfer: await client.transferSnapshot(),
            resident: nationalResident,
          };
          const release = await acquireNationalResidentOnlyActivity();
          let reveal;
          try {
            const activityBefore = await client.nationalHistoryActivitySnapshot();
            const started = performance.now();
            await nationalMrmsSession.start();
            const revealMs = performance.now() - started;
            reveal = {
              activityBefore,
              activityAfter: await client.nationalHistoryActivitySnapshot(),
              revealMs,
              fadeMs: sourceFadeMs(),
            };
          } finally {
            release();
          }
          return {
            before,
            nationalGenerationBefore,
            backfillStartCountBefore,
            retainedBefore,
            whileSite,
            reveal,
            after: radarSessionCoordinatorRef.current!.snapshot(),
            renderer: nationalLayer?.getSnapshot() ?? null,
            history: latestNationalHistory,
            backfillStartCountAfter: nationalBackfillStartCount,
            siteLayerRemoved: !instance.getLayer(DIAGNOSTIC_LAYER_IDS.radar),
          };
        },
        async proveSiteInspectionFollowsScan(site = "KTLX") {
          const coordinator = radarSessionCoordinatorRef.current!;
          const location = radarSiteById(normalizeRadarSite(site));
          if (!siteLevel2Session || !nationalMrmsSession || !location) {
            throw new Error("Site inspection proof is unavailable");
          }
          if (coordinator.snapshot().painted?.source.kind !== "national") {
            throw new Error("National must be displayed before the Site inspection proof");
          }
          const waitFor = async (condition: () => boolean, timeoutMs: number, label: string) => {
            const started = performance.now();
            while (!condition()) {
              if (performance.now() - started > timeoutMs) throw new Error(`${label} timed out`);
              await waitMilliseconds(100);
            }
          };
          await siteLevel2Session.start(location.id, { persistOnPaint: false });
          await waitFor(() => (residentLiveHistory?.length ?? 0) >= 3, 180_000, "Site history of three scans");
          // Pin a point 30 km north of the radar, as a click would.
          inspectionPointRef.current = { longitude: location.longitude, latitude: location.latitude + 0.27 };
          interrogationObservationRef.current = null;
          const steps = [];
          for (const index of [0, (residentLiveHistory?.length ?? 1) - 1]) {
            await controller!.scrub(index);
            await waitMilliseconds(100);
            steps.push({
              index,
              paintedObservationId: layer?.getSnapshot().paintReceipt?.observationId ?? null,
              inspectedObservationId: interrogationObservationRef.current,
            });
          }
          inspectionPointRef.current = null;
          interrogationObservationRef.current = null;
          await nationalMrmsSession.start();
          return { site: location.id, steps };
        },
        async proveTimeCarry(site = "KTLX") {
          const coordinator = radarSessionCoordinatorRef.current!;
          const before = coordinator.snapshot();
          if (
            !siteLevel2Session
            || !nationalMrmsSession
            || !nationalPlaybackController
            || before.transition
            || before.painted?.source.kind !== "national"
            || nationalObservations.length < 20
          ) {
            throw new Error("time-carry proof needs a settled National history of at least 20 frames");
          }
          const waitFor = async (condition: () => boolean, timeoutMs: number, label: string) => {
            const started = performance.now();
            while (!condition()) {
              if (performance.now() - started > timeoutMs) throw new Error(`${label} timed out`);
              await waitMilliseconds(100);
            }
          };
          const siteState = () => {
            const snapshot = controller?.snapshot();
            const times = (residentLiveHistory ?? []).map((frame) => frame.observedAtUnixMs);
            return {
              playing: snapshot?.playing ?? null,
              playheadUnixMs: snapshot?.playheadObservedAtUnixMs ?? null,
              selectedIndex: (residentLiveHistory ?? []).findIndex(
                (frame) => frame.observationId === snapshot?.selectedObservationId,
              ),
              times,
            };
          };
          const nationalState = () => {
            const snapshot = nationalPlaybackController?.snapshot();
            return {
              playing: snapshot?.playing ?? null,
              playheadUnixMs: snapshot?.playheadObservedAtUnixMs ?? null,
              selectedIndex: nationalObservations.findIndex(
                (observation) => nationalObservationId(observation) === snapshot?.selectedObservationId,
              ),
              revealReceiptObservationId: nationalLayer?.getSnapshot().paintReceipt?.observationId ?? null,
              times: nationalObservations.map((observation) => observation.observationTimeUnixMs),
              ids: nationalObservations.map(nationalObservationId),
            };
          };
          const carrySettled = () => playheadCarryRef.current === null;
          const siteSettled = () => {
            const snapshot = coordinator.snapshot();
            return !snapshot.transition && snapshot.painted?.source.kind === "site";
          };
          const nationalSettled = () => {
            const snapshot = coordinator.snapshot();
            return !snapshot.transition && snapshot.painted?.source.kind === "national";
          };

          // Paused on an older frame: each side lands on its frame nearest the other.
          nationalPlaybackController.pause();
          const pausedIndex = nationalObservations.length - 16;
          await nationalPlaybackController.scrub(pausedIndex);
          const pausedAtUnixMs = nationalObservations[pausedIndex].observationTimeUnixMs;
          await siteLevel2Session.start(normalizeRadarSite(site), { persistOnPaint: false });
          await waitFor(() => siteSettled() && carrySettled(), 180_000, "Site adopting a paused National time");
          const pausedSite = { targetUnixMs: pausedAtUnixMs, ...siteState() };
          await nationalMrmsSession.start();
          await waitFor(() => nationalSettled() && carrySettled(), 60_000, "National adopting a paused Site time");
          const pausedNational = {
            targetUnixMs: pausedSite.playheadUnixMs,
            expectedIndex: pausedSite.playheadUnixMs === null
              ? -1
              : nearestFrameIndex(nationalState().times, pausedSite.playheadUnixMs),
            ...nationalState(),
          };

          // Playing: each side keeps the loop running.
          await nationalPlaybackController.play();
          await siteLevel2Session.start(normalizeRadarSite(site), { persistOnPaint: false });
          await waitFor(() => siteSettled() && siteState().playing === true, 180_000, "Site continuing a playing loop");
          const playingSite = siteState();
          await nationalMrmsSession.start();
          await waitFor(
            () => nationalSettled() && nationalPlaybackController?.snapshot().playing === true,
            60_000,
            "National continuing a playing loop",
          );
          const playingNational = nationalState();
          nationalPlaybackController?.pause();
          return {
            site: normalizeRadarSite(site),
            paused: {
              site: { ...pausedSite, expectedIndex: nearestFrameIndex(pausedSite.times, pausedAtUnixMs) },
              national: pausedNational,
            },
            playing: {
              site: { playing: playingSite.playing, frames: playingSite.times.length },
              national: { playing: playingNational.playing },
            },
          };
        },
        async proveZoomHandoff(site = "KTLX", nextSite = "KFWS") {
          const location = radarSiteById(normalizeRadarSite(site));
          const nextLocation = radarSiteById(normalizeRadarSite(nextSite));
          const auto = globalThis.__MISTR_AUTO_SOURCE__;
          if (!location || !nextLocation || !auto || !nationalLayer) {
            throw new Error("zoom handoff diagnostic is unavailable");
          }
          const coordinator = radarSessionCoordinatorRef.current!;
          if (coordinator.snapshot().painted?.source.kind !== "national") {
            throw new Error("National must be displayed before the zoom handoff proof");
          }
          const waitFor = async (condition: () => boolean, timeoutMs: number, label: string) => {
            const started = performance.now();
            while (!condition()) {
              if (performance.now() - started > timeoutMs) throw new Error(`${label} timed out`);
              await waitMilliseconds(50);
            }
          };
          const camera = () => {
            const center = instance.getCenter();
            return { longitude: center.lng, latitude: center.lat, zoom: instance.getZoom() };
          };
          const settled = (kind: "site" | "national") => {
            const snapshot = coordinator.snapshot();
            return !snapshot.transition && snapshot.painted?.source.kind === kind;
          };
          const nationalGenerationBefore = nationalGeneration;
          const center: [number, number] = [location.longitude, location.latitude];

          instance.jumpTo({ center, zoom: 8.3, bearing: 0, pitch: 0 });
          auto.evaluate();
          await waitFor(() => auto.state().prefetchedSite?.site === location.id, 120_000, "Site preload");
          const preloaded = auto.state().prefetchedSite;

          instance.jumpTo({ center, zoom: 9.6, bearing: 0, pitch: 0 });
          const siteCameraSet = camera();
          const siteStarted = performance.now();
          auto.evaluate();
          await waitFor(() => settled("site"), 60_000, "zoom-in switch");
          const siteSwitchMs = performance.now() - siteStarted;
          const afterSite = {
            sourceState: coordinator.snapshot(),
            camera: camera(),
            cameraSet: siteCameraSet,
            siteOpacity: layer?.getOpacity() ?? null,
            nationalRenderer: nationalLayer?.getSnapshot() ?? null,
          };

          // Panning at detail zoom into another Site's coverage fades through
          // National and on to that Site from one camera move.
          const nextCenter: [number, number] = [nextLocation.longitude, nextLocation.latitude];
          const hopSources: string[] = [];
          const stopWatchingHop = coordinator.subscribe((snapshot) => {
            const painted = snapshot.painted?.source;
            const label = !painted ? "none" : painted.kind === "site" ? painted.siteIcao : "national";
            if (hopSources.at(-1) !== label) hopSources.push(label);
          });
          instance.jumpTo({ center: nextCenter, zoom: 9.6, bearing: 0, pitch: 0 });
          const hopCameraSet = camera();
          const hopStarted = performance.now();
          let afterHop;
          try {
            auto.evaluate();
            await waitFor(
              () => settled("site") && coordinator.snapshot().painted?.source.kind === "site"
                && (coordinator.snapshot().painted?.source as { siteIcao?: string }).siteIcao === nextLocation.id,
              120_000,
              "Site to Site pan",
            );
            afterHop = {
              site: nextLocation.id,
              switchMs: performance.now() - hopStarted,
              sources: [...hopSources],
              sourceState: coordinator.snapshot(),
              camera: camera(),
              cameraSet: hopCameraSet,
              siteOpacity: layer?.getOpacity() ?? null,
              nationalRenderer: nationalLayer?.getSnapshot() ?? null,
            };
          } finally {
            stopWatchingHop();
          }

          instance.jumpTo({ center: nextCenter, zoom: 7.5, bearing: 0, pitch: 0 });
          const nationalCameraSet = camera();
          const nationalStarted = performance.now();
          auto.evaluate();
          await waitFor(() => settled("national"), 60_000, "zoom-out switch");
          const nationalSwitchMs = performance.now() - nationalStarted;
          return {
            site: location.id,
            fadeMs: sourceFadeMs(),
            nationalGenerationBefore,
            preloaded,
            siteSwitchMs,
            afterSite,
            afterHop,
            nationalSwitchMs,
            afterNational: {
              sourceState: coordinator.snapshot(),
              camera: camera(),
              cameraSet: nationalCameraSet,
              siteLayerPresent: Boolean(instance.getLayer(DIAGNOSTIC_LAYER_IDS.radar)),
              nationalRenderer: nationalLayer?.getSnapshot() ?? null,
            },
          };
        },
        async proveLatestIntentWins(site = "KTLX", nextSite = "KFWS") {
          const location = radarSiteById(normalizeRadarSite(site));
          const nextLocation = radarSiteById(normalizeRadarSite(nextSite));
          const auto = globalThis.__MISTR_AUTO_SOURCE__;
          const activeClient = client;
          if (!location || !nextLocation || !auto || !activeClient) {
            throw new Error("latest-intent diagnostic is unavailable");
          }
          const coordinator = radarSessionCoordinatorRef.current!;
          if (coordinator.snapshot().painted?.source.kind !== "national" || coordinator.snapshot().transition) {
            throw new Error("National must be displayed before the latest-intent proof");
          }
          const waitFor = async (condition: () => boolean, timeoutMs: number, label: string) => {
            const started = performance.now();
            while (!condition()) {
              if (performance.now() - started > timeoutMs) throw new Error(`${label} timed out`);
              await waitMilliseconds(50);
            }
          };
          const paintedLabel = () => {
            const painted = coordinator.snapshot().painted?.source;
            return !painted ? "none" : painted.kind === "site" ? painted.siteIcao : "national";
          };
          const idle = () => !coordinator.snapshot().transition && !auto.state().switchInFlight;
          const sources: string[] = [];
          const stopWatching = coordinator.subscribe(() => {
            const label = paintedLabel();
            if (sources.at(-1) !== label) sources.push(label);
          });
          const center: [number, number] = [location.longitude, location.latitude];
          const nextCenter: [number, number] = [nextLocation.longitude, nextLocation.latitude];
          // Zoom in over the Site with its download held open waiting for the
          // next scan, minutes away, as a slow connection would.
          const startSlowSwitch = async () => {
            cancelPrefetch();
            prefetchedSite = null;
            slowNextSiteFromNationalForDiagnostics = true;
            instance.jumpTo({ center, zoom: 9.6, bearing: 0, pitch: 0 });
            auto.evaluate();
            await waitMilliseconds(2_000);
            return {
              switchInFlight: auto.state().switchInFlight,
              painted: paintedLabel(),
              siteLaneActive: activeClient.isActive("site"),
            };
          };
          const abandonedBefore = auto.state().abandonedSwitches;
          try {
            // Zooming back out abandons the download; National never left.
            const zoomOutInFlight = await startSlowSwitch();
            instance.jumpTo({ center, zoom: 7, bearing: 0, pitch: 0 });
            const zoomOutStarted = performance.now();
            auto.evaluate();
            await waitFor(idle, 30_000, "abandoned zoom-in");
            const zoomOut = {
              inFlight: zoomOutInFlight,
              settledMs: performance.now() - zoomOutStarted,
              painted: paintedLabel(),
              siteLaneActive: activeClient.isActive("site"),
              siteLayerPresent: Boolean(layer),
            };

            // Panning to another Site replaces the download with that Site's.
            const panInFlight = await startSlowSwitch();
            instance.jumpTo({ center: nextCenter, zoom: 9.6, bearing: 0, pitch: 0 });
            const panStarted = performance.now();
            auto.evaluate();
            await waitFor(() => idle() && paintedLabel() === nextLocation.id, 120_000, "replacement Site");
            const pan = {
              inFlight: panInFlight,
              switchMs: performance.now() - panStarted,
              painted: paintedLabel(),
            };

            instance.jumpTo({ center: nextCenter, zoom: 7.5, bearing: 0, pitch: 0 });
            auto.evaluate();
            await waitFor(() => idle() && paintedLabel() === "national", 60_000, "return to National");
            return {
              site: location.id,
              nextSite: nextLocation.id,
              zoomOut,
              pan,
              abandoned: auto.state().abandonedSwitches - abandonedBefore,
              sources: [...sources],
            };
          } finally {
            slowNextSiteFromNationalForDiagnostics = false;
            stopWatching();
          }
        },
        async proveAbandonedNationalLoadKeepsSite(site = "KTLX") {
          const location = radarSiteById(normalizeRadarSite(site));
          const auto = globalThis.__MISTR_AUTO_SOURCE__;
          const activeClient = client;
          if (!location || !auto || !activeClient) {
            throw new Error("abandoned National load diagnostic is unavailable");
          }
          const coordinator = radarSessionCoordinatorRef.current!;
          const waitFor = async (condition: () => boolean, timeoutMs: number, label: string) => {
            const started = performance.now();
            while (!condition()) {
              if (performance.now() - started > timeoutMs) throw new Error(`${label} timed out`);
              await waitMilliseconds(50);
            }
          };
          const paintedLabel = () => {
            const painted = coordinator.snapshot().painted?.source;
            return !painted ? "none" : painted.kind === "site" ? painted.siteIcao : "national";
          };
          const idle = () => !coordinator.snapshot().transition && !auto.state().switchInFlight;
          const center: [number, number] = [location.longitude, location.latitude];
          const liveSiteShown = () => idle()
            && paintedLabel() === location.id
            && residentLiveHistory?.at(-1)?.siteIcao === location.id;
          if (!liveSiteShown()) {
            instance.jumpTo({ center, zoom: 9.6, bearing: 0, pitch: 0 });
            auto.evaluate();
            await waitFor(liveSiteShown, 120_000, "live Site before the National load");
          }
          // Without a resident National, zooming out starts a fresh National
          // load, which takes the Site lane; zooming back in abandons it.
          teardownNational();
          instance.jumpTo({ center, zoom: 7, bearing: 0, pitch: 0 });
          auto.evaluate();
          await waitFor(
            () => activeClient.isActive("national") && auto.state().switchInFlight?.target.kind === "national",
            10_000,
            "fresh National load",
          );
          const inFlight = {
            switchInFlight: auto.state().switchInFlight,
            painted: paintedLabel(),
            nationalLaneActive: activeClient.isActive("national"),
            siteLaneActive: activeClient.isActive("site"),
          };
          instance.jumpTo({ center, zoom: 9.6, bearing: 0, pitch: 0 });
          const started = performance.now();
          auto.evaluate();
          await waitFor(idle, 30_000, "abandoned National load");
          const settledMs = performance.now() - started;
          const nationalLaneActive = activeClient.isActive("national");
          await waitFor(() => activeClient.isActive("site"), 30_000, "Site updates resuming");
          return {
            site: location.id,
            inFlight,
            settledMs,
            painted: paintedLabel(),
            nationalLaneActive,
            siteUpdatesResumedMs: performance.now() - started,
            siteOpacity: layer?.getOpacity() ?? null,
            nationalLayerPresent: Boolean(nationalLayer),
          };
        },
        async waitForHistory(frameCount = MAX_LIVE_HISTORY_FRAMES, timeoutMs = 300_000) {
          if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > MAX_LIVE_HISTORY_FRAMES) {
            throw new RangeError("National history wait requires 1 to 60 observations");
          }
          const started = performance.now();
          while ((latestNationalHistory?.retained.length ?? 0) < frameCount) {
            if (performance.now() - started > timeoutMs) {
              throw new Error(`National history did not reach ${frameCount} observations`);
            }
            await waitMilliseconds(100);
          }
          return this.report();
        },
        async beginResidentEvidence() {
          if (nationalPhase4EvidenceRelease) {
            throw new Error("National resident evidence is already reserved");
          }
          nationalPhase4EvidenceRelease = await acquireNationalResidentOnlyActivity();
        },
        endResidentEvidence() {
          const release = nationalPhase4EvidenceRelease;
          nationalPhase4EvidenceRelease = null;
          release?.();
        },
        play() {
          return nationalPlaybackController?.play()
            ?? Promise.reject(new Error("National playback is unavailable"));
        },
        pause() {
          nationalPlaybackController?.pause();
        },
        scrub(index) {
          return nationalPlaybackController?.scrub(index)
            ?? Promise.reject(new Error("National playback is unavailable"));
        },
        async scrubWithEvidence(index) {
          if (!client || !nationalPlaybackController || !nationalLayer) {
            throw new Error("National playback diagnostics are unavailable");
          }
          const release = await acquireNationalResidentOnlyActivity();
          try {
            const activityBefore = await client.nationalHistoryActivitySnapshot();
            const rendererBefore = nationalLayer.getSnapshot();
            const receipt = await nationalPlaybackController.scrub(index);
            const activityAfter = await client.nationalHistoryActivitySnapshot();
            return {
              index,
              receipt,
              activityBefore,
              activityAfter,
              activityDelta: subtractNationalActivity(activityAfter, activityBefore),
              rendererBefore,
              rendererAfter: nationalLayer.getSnapshot(),
            };
          } finally {
            release();
          }
        },
        async runTransitions(count = 1_000) {
          if (!client || !nationalPlaybackController || !nationalLayer) {
            throw new Error("National playback diagnostics are unavailable");
          }
          const release = await acquireNationalResidentOnlyActivity();
          try {
            const activityBefore = await client.nationalHistoryActivitySnapshot();
            const rendererBefore = nationalLayer.getSnapshot();
            const receipts = await nationalPlaybackController.runTransitions(count);
            const activityAfter = await client.nationalHistoryActivitySnapshot();
            const rendererAfter = nationalLayer.getSnapshot();
            return {
              requestedTransitions: count,
              completedTransitions: receipts.length,
              activityBefore,
              activityAfter,
              activityDelta: subtractNationalActivity(activityAfter, activityBefore),
              rendererBefore,
              rendererAfter,
              receipts,
            };
          } finally {
            release();
          }
        },
        async refineForCamera() {
          // Native residency: nothing to refine; report current truth.
          return this.report();
        },
        async resetContext(holdMs = 100) {
          if (!client || !nationalLayer) throw new Error("National renderer is unavailable");
          const release = await acquireNationalResidentOnlyActivity();
          try {
            const activityBefore = await client.nationalHistoryActivitySnapshot();
            const before = nationalLayer.getSnapshot();
            const receipt = await nationalLayer.simulateContextResetForTest(holdMs);
            await nationalLayer.waitForCommonResidency();
            const activityAfter = await client.nationalHistoryActivitySnapshot();
            return {
              before,
              receipt,
              after: nationalLayer.getSnapshot(),
              activityBefore,
              activityAfter,
              activityDelta: subtractNationalActivity(activityAfter, activityBefore),
            };
          } finally {
            release();
          }
        },
        setCamera(longitude, latitude, zoom) {
          instance.jumpTo({ center: [longitude, latitude], zoom, bearing: 0, pitch: 0 });
        },
        async inspect(longitude, latitude) {
          if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
            throw new TypeError("National inspection coordinates must be finite");
          }
          const receipt = nationalLayer?.getSnapshot().paintReceipt;
          if (!receipt) throw new Error("National renderer has no authoritative receipt");
          inspectionPointRef.current = { longitude, latitude };
          interrogationObservationRef.current = null;
          setInspectionState("pending");
          return refreshNationalInterrogation(receipt);
        },
        async waitForInspection(observationId, timeoutMs = 60_000) {
          const started = performance.now();
          while (true) {
            const lookup = latestNationalInspection;
            if (
              lookup
              && `${lookup.observationTimeUnixMs}:${lookup.contentSha256}` === observationId
            ) return lookup;
            if (performance.now() - started > timeoutMs) {
              throw new Error(`National inspection did not refresh for ${observationId}`);
            }
            await waitMilliseconds(50);
          }
        },
        async waitForInspectionIdle() {
          await nationalInspectionLookupQueue.waitForIdle();
          return nationalInspectionLookupQueue.snapshot();
        },
        activity: () => client?.nationalHistoryActivitySnapshot()
          ?? Promise.reject(new Error("National transfer client is unavailable")),
        transferSnapshot: () => client?.transferSnapshot()
          ?? Promise.reject(new Error("National transfer client is unavailable")),
        sourceState: () => radarSessionCoordinatorRef.current?.snapshot() ?? null,
      };
      // The packaged archive is a safe first paint, not a permanent demo mode.
      // Every launch proceeds to the source the restored camera calls for; a
      // fresh profile starts with KTLX Site.
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
      if (autoSourceMoveHandlerForCleanup) instance.off("moveend", autoSourceMoveHandlerForCleanup);
      unsubscribeAutoSourceFlush?.();
      if (autoSiteRetryTimer !== null) globalThis.clearTimeout(autoSiteRetryTimer);
      autoSourceRef.current = null;
      if (globalThis.__MISTR_AUTO_SOURCE__) delete globalThis.__MISTR_AUTO_SOURCE__;
      if (globalThis.__MISTR_PHASE4__) delete globalThis.__MISTR_PHASE4__;
      if (globalThis.__MISTR_PHASE5__) delete globalThis.__MISTR_PHASE5__;
      if (globalThis.__MISTR_PHASE6__) delete globalThis.__MISTR_PHASE6__;
      if (globalThis.__MISTR_NATIONAL_PHASE2__) delete globalThis.__MISTR_NATIONAL_PHASE2__;
      if (globalThis.__MISTR_NATIONAL_PHASE3__) delete globalThis.__MISTR_NATIONAL_PHASE3__;
      if (globalThis.__MISTR_NATIONAL_PHASE4__) delete globalThis.__MISTR_NATIONAL_PHASE4__;
      if (siteLevel2SessionRef.current === siteLevel2Session) siteLevel2SessionRef.current = null;
      if (nationalMrmsSessionRef.current === nationalMrmsSession) nationalMrmsSessionRef.current = null;
      nationalHistorySession += 1;
      nationalPhase4EvidenceRelease?.();
      nationalPhase4EvidenceRelease = null;
      nationalPlaybackController?.dispose();
      if (nationalPlaybackControllerRef.current === nationalPlaybackController) {
        nationalPlaybackControllerRef.current = null;
      }
      nationalWorkingSet?.cancel();
      nationalInspectionLookupQueueForCleanup?.cancelPending();
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

  const nationalActive = paintedRadarSource.kind === "national";
  const nationalCommonResidencyReady = nationalActive
    && nationalPhase3 !== null
    && commonResidencyReadyForInteraction(
      nationalPhase3.renderer,
      nationalHistory?.retained.length ?? 0,
    );
  const sitePlayback = phase4.kind === "complete" ? phase4.report.playback : undefined;
  // A brief hold for an atomic National history commit resumes on its own,
  // so the chrome keeps presenting it as playing.
  const playback = nationalActive
    ? nationalPlayback?.resumingAfterReplacement
      ? { ...nationalPlayback, playing: true }
      : nationalPlayback ?? undefined
    : sitePlayback;
  const frameIndex = paintedFrameIndex(timelineFrames, playback);
  const displayedAtUnixMs = playback?.playheadObservedAtUnixMs
    ?? (nationalActive
      ? nationalPhase3?.workingSet.receipt.observationTimeUnixMs
      : phase5.display.lastComplete?.observedAtUnixMs);
  const playbackStatus = playbackPresentation(
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
  const displayedFrameIsLatestLive = timelineFrames.length > 0
    && frameIndex === timelineFrames.length - 1
    && (nationalActive || paintedSourceKind === "nexrad_level2_chunks");
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
            : autoSiteError
              ? userFacingRadarError("auto_unavailable", autoSiteError)
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
      : playbackStatus === "PREPARING PLAYBACK"
        ? {
            kind: "info" as const,
            message: "Preparing sharp National playback for this map view.",
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
        : liveHistoryStatus === "loading"
          && (nationalActive || paintedSourceKind === "nexrad_level2_chunks")
          ? {
              kind: "info" as const,
              message: nationalActive
                ? "Current National radar is ready. Loading recent observations."
                : `Current ${displayedSite} radar is ready. Loading recent scans.`,
            }
          : undefined);

  const togglePlayback = () => {
    playheadCarryRef.current = null;
    operatorPlaybackIntentRef.current += 1;
    if (nationalActive) {
      const controller = nationalPlaybackControllerRef.current;
      if (!controller) return;
      const snapshot = controller.snapshot();
      if (snapshot.playing || snapshot.preparingQuality || snapshot.resumingAfterReplacement) {
        controller.pause();
      }
      else {
        void controller.play().catch((error) => {
          if (isRadarSourceSuperseded(error)) return;
          setPlaybackError(error instanceof Error ? error.message : String(error));
        });
      }
      return;
    }
    const controller = playbackControllerRef.current;
    if (!controller) return;
    if (controller.snapshot().playing) controller.pause();
    else controller.play();
  };

  const queueScrub = (index: number) => {
    playheadCarryRef.current = null;
    operatorPlaybackIntentRef.current += 1;
    queuedScrubRef.current = index;
    if (scrubRunningRef.current) return;
    scrubRunningRef.current = true;
    void (async () => {
      try {
        while (queuedScrubRef.current !== null) {
          const nextIndex = queuedScrubRef.current;
          queuedScrubRef.current = null;
          if (nationalActive) {
            await nationalPlaybackControllerRef.current?.scrub(nextIndex);
          } else {
            await playbackControllerRef.current?.scrub(nextIndex);
          }
        }
      } catch (error) {
        if (!isRadarSourceSuperseded(error)) {
          setPlaybackError(error instanceof Error ? error.message : String(error));
        }
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
    setInspectionState("idle");
    inspectionMarkerRef.current?.remove();
    inspectionMarkerRef.current = null;
    inspectionPointRef.current = null;
    interrogationObservationRef.current = null;
    inspectionRequestRef.current = null;
    // The picker flies to the Site; zoom then keeps it displayed. From National
    // the Site preloads during the flight and the landing switches to it; from
    // another Site the landing fades through National first.
    const auto = autoSourceRef.current;
    auto?.setPreferredSite(normalized);
    const instance = map.current;
    const location = radarSiteById(normalized);
    if (instance && location) {
      auto?.evaluateAfterNextMove();
      flyToSite(instance, location);
    }
    const painted = radarSessionCoordinatorRef.current?.snapshot().painted;
    if (auto && instance && location && painted) {
      if (painted.source.kind === "national") auto.prefetch(normalized);
      auto.evaluateIfSettled();
      return;
    }
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
    const alreadyNational = sourceState?.transition?.requestedSource.kind === "national"
      || (sourceState?.painted?.source.kind === "national" && !sourceState.transition);
    if (!alreadyNational) {
      setNationalRequestError(null);
      setSiteRequestError(null);
      setInterrogation(null);
      setInspectionState("idle");
      inspectionMarkerRef.current?.remove();
      inspectionMarkerRef.current = null;
      inspectionPointRef.current = null;
      interrogationObservationRef.current = null;
      inspectionRequestRef.current = null;
    }
    // Picking National zooms out to the country, even when National is already
    // displayed; the landing switches source if needed.
    const auto = autoSourceRef.current;
    auto?.setPreferredSite(undefined);
    const instance = map.current;
    if (auto && instance) {
      auto.evaluateAfterNextMove();
      flyToNational(instance);
      auto.evaluateIfSettled();
      return;
    }
    if (alreadyNational) return;
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
    if (!instance) return;
    autoSourceRef.current?.evaluateAfterNextMove();
    if (paintedRadarSource.kind === "national") {
      flyToNational(instance);
    } else {
      const location = radarSiteById(paintedRadarSource.siteIcao);
      if (location) flyToSite(instance, location);
    }
    autoSourceRef.current?.evaluateIfSettled();
  };

  const selectDisplayMode = (mode: RadarDisplayMode) => {
    const siteLayer = radarLayerRef.current;
    const nationalLayer = nationalLayerRef.current;
    if (!siteLayer && !nationalLayer) return;
    // Both layers can be resident at once. Each carries the chosen mode, so a
    // hidden layer can never reverse-sync an older mode back into the UI.
    displayModeRef.current = mode;
    siteLayer?.setDisplayMode(mode);
    nationalLayer?.setDisplayMode(mode);
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
        inspectionState={inspectionState}
        onRecenter={recenterRadar}
        onSelectNational={selectNational}
        onSelectDisplayMode={selectDisplayMode}
        onScrub={queueScrub}
        onSelectSite={selectSite}
        onTogglePlayback={togglePlayback}
        playbackReady={(nationalActive
          ? Boolean(nationalPlaybackControllerRef.current)
            && (nationalHistory?.retained.length ?? 0) > 1
            // A replacement commit must not disable the operator's control:
            // play/pause during the commit window wait out the mutation
            // through the controller's own residency gates, and the resumed
            // commons stay >= 2 throughout. residentCount keeps the button
            // live while the transient commit flags flip.
            && (nationalCommonResidencyReady || (playback?.residentCount ?? 0) > 1)
            && !pendingSite
          : Boolean(playbackControllerRef.current) && phase4.kind === "complete")
          && !rendererError}
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

interface AutoSourceHandle {
  setPreferredSite(site: string | undefined): void;
  prefetch(site: string): void;
  evaluateAfterNextMove(): void;
  evaluateIfSettled(): void;
}

interface PrefetchedSiteSweep {
  site: string;
  generation: number;
  model: RadarSweepCpuModel;
  evidence: Phase5LiveTransferEvidence;
  timing: TransferTiming;
  fetchedAtUnixMs: number;
}

function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

function sourceFadeMs(): number {
  return prefersReducedMotion() ? 0 : SOURCE_FADE_MS;
}

function flyToSite(instance: MapLibreMap, site: RadarSiteOption): void {
  instance.flyTo({
    center: [site.longitude, site.latitude],
    zoom: Math.max(instance.getZoom(), SITE_DETAIL_ZOOM),
    bearing: 0,
    pitch: 0,
    duration: prefersReducedMotion() ? 0 : CAMERA_FLIGHT_MS,
    essential: true,
  });
}

function flyToNational(instance: MapLibreMap): void {
  instance.fitBounds(CONUS_BOUNDS, {
    bearing: 0,
    pitch: 0,
    maxZoom: 5.5,
    padding: CAMERA_PADDING,
    duration: prefersReducedMotion() ? 0 : CAMERA_FLIGHT_MS,
  });
}

function initialMapCamera(
  startupSource: RadarSourceKey,
): Pick<maplibregl.MapOptions, "center" | "zoom" | "bounds" | "fitBoundsOptions"> {
  const stored = restoreCamera();
  if (stored) return stored;
  if (startupSource.kind === "site") {
    const site = radarSiteById(startupSource.siteIcao);
    if (site) return { center: [site.longitude, site.latitude], zoom: SITE_DETAIL_ZOOM };
    return { center: DEFAULT_CENTER, zoom: SITE_DETAIL_ZOOM };
  }
  return { bounds: CONUS_BOUNDS, fitBoundsOptions: { padding: CAMERA_PADDING, maxZoom: 5.5 } };
}

function restoreCamera(): { center: [number, number]; zoom: number } | null {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(CAMERA_STORAGE_KEY) ?? "null");
    if (
      value
      && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180
      && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 85
      && Number.isFinite(value.zoom) && value.zoom >= 0 && value.zoom <= 22
    ) return { center: [value.longitude, value.latitude], zoom: value.zoom };
  } catch {
    // A missing or malformed camera falls back to the stored source.
  }
  return null;
}

function storeCamera(instance: MapLibreMap): void {
  try {
    const center = instance.getCenter();
    globalThis.localStorage?.setItem(CAMERA_STORAGE_KEY, JSON.stringify({
      longitude: center.lng,
      latitude: center.lat,
      zoom: instance.getZoom(),
    }));
  } catch {
    // Camera memory is a convenience; storage failure changes nothing else.
  }
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

function workingSetWithReceipt(
  workingSet: NationalHistoryWorkingSetResult,
): NationalHistoryWorkingSetResult & { receipt: NationalPaintReceipt } {
  if (!workingSet.receipt) {
    throw new Error("National working set has no authoritative paint receipt");
  }
  return { ...workingSet, receipt: workingSet.receipt };
}

function phase3CompatibilityPreparation(
  report: NationalHistoryPrepareReport,
): NationalPhase3PrepareReport {
  const observation = report.observation;
  return {
    generation: observation.generation,
    objectKey: observation.objectKey,
    observationTimeUnixMs: observation.observationTimeUnixMs,
    compressedSha256: observation.contentSha256,
    normalizedSha256: observation.contentSha256,
    compressedBytes: observation.compressedBytes,
    retainedBackendBytes: report.history.totalBackendBytes,
    presentationFactors: [1, 2, 4],
    presentationGpuBytes: [
      {
        presentationFactor: 1,
        chunkCount: 392,
        transferBytes: 49_000_000,
        projectedGpuBytes: 49_000_000,
      },
      {
        presentationFactor: 2,
        chunkCount: 98,
        transferBytes: 12_250_000,
        projectedGpuBytes: 12_250_000,
      },
      {
        presentationFactor: 4,
        chunkCount: observation.overviewChunkCount,
        transferBytes: observation.overviewGpuBytes,
        projectedGpuBytes: observation.overviewGpuBytes,
      },
    ],
    discoveryMs: report.discoveryMs,
    downloadMs: report.downloadMs,
    decodeAndLevelMs: report.decodeAndLevelMs,
  };
}

function nationalHistoryErrorCode(error: unknown): string {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : "unknown";
}

function nationalHistoryContainsFinalizedObservation(
  snapshot: NationalHistorySnapshot,
  observation: NationalHistoryObservation,
): boolean {
  return snapshot.generation === observation.generation
    && snapshot.staged === null
    && !snapshot.mutationReversible
    && snapshot.reversibleCommitBytes === 0
    && snapshot.retained.some((retained) => (
      retained.generation === observation.generation
      && retained.observationTimeUnixMs === observation.observationTimeUnixMs
      && retained.contentSha256 === observation.contentSha256
      && retained.objectKey === observation.objectKey
    ));
}

function waitMilliseconds(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function subtractNationalActivity(
  after: NationalHistoryActivitySnapshot,
  before: NationalHistoryActivitySnapshot,
): NationalHistoryActivitySnapshot {
  return {
    networkRequests: after.networkRequests - before.networkRequests,
    responseBytes: after.responseBytes - before.responseBytes,
    decoderRuns: after.decoderRuns - before.decoderRuns,
    bulkIpcTransfers: after.bulkIpcTransfers - before.bulkIpcTransfers,
    bulkIpcBytes: after.bulkIpcBytes - before.bulkIpcBytes,
    pointLookupDecodes: after.pointLookupDecodes - before.pointLookupDecodes,
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

/**
 * A launch opens the source the restored camera calls for, not whatever
 * source was last shown: zoom decides the source. Without a stored camera
 * (a fresh profile) the stored source, or KTLX, sets both.
 */
function restoreStartupSource(): RadarSourceKey {
  const camera = restoreCamera();
  if (!camera) return restoreRadarSource();
  const [longitude, latitude] = camera.center;
  const target = launchAutoSource({ zoom: camera.zoom, center: { longitude, latitude } }, RADAR_SITES);
  return target.kind === "national"
    ? { kind: "national", domain: "conus" }
    : siteRadarSource(target.siteIcao);
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
  workingSet: NationalHistoryWorkingSetResult & { receipt: NationalPaintReceipt };
  renderer: NationalGridRendererSnapshot;
}

export interface NationalPhase3ContextResetReport {
  before: NationalGridRendererSnapshot;
  receipt: NationalPaintReceipt;
  after: NationalGridRendererSnapshot;
}

export interface NationalPhase4Report {
  history: NationalHistorySnapshot | null;
  renderer: NationalGridRendererSnapshot | null;
  playback: NationalPlaybackSnapshot | null;
  inspectionQueue: LatestOnlyAsyncQueueSnapshot;
}

interface NationalInspectionLookupRequest {
  receipt: NationalPaintReceipt;
  inspectionId: string;
  longitude: number;
  latitude: number;
}

export interface NationalPhase4TransitionReport {
  requestedTransitions: number;
  completedTransitions: number;
  activityBefore: NationalHistoryActivitySnapshot;
  activityAfter: NationalHistoryActivitySnapshot;
  activityDelta: NationalHistoryActivitySnapshot;
  rendererBefore: NationalGridRendererSnapshot;
  rendererAfter: NationalGridRendererSnapshot;
  receipts: NationalPaintReceipt[];
}

export interface NationalPhase4ScrubReport {
  index: number;
  receipt: NationalPaintReceipt;
  activityBefore: NationalHistoryActivitySnapshot;
  activityAfter: NationalHistoryActivitySnapshot;
  activityDelta: NationalHistoryActivitySnapshot;
  rendererBefore: NationalGridRendererSnapshot;
  rendererAfter: NationalGridRendererSnapshot;
}

export interface NationalPhase4ContextResetReport extends NationalPhase3ContextResetReport {
  activityBefore: NationalHistoryActivitySnapshot;
  activityAfter: NationalHistoryActivitySnapshot;
  activityDelta: NationalHistoryActivitySnapshot;
}

export interface NationalPhase4FailedSiteRecoveryReport {
  failureMessage: string;
  before: RadarSessionSnapshot;
  after: RadarSessionSnapshot;
  history: NationalHistorySnapshot | null;
  renderer: NationalGridRendererSnapshot;
  transfer: import("./packed-sweep/transferClient").TransferSnapshot;
  backfillStartCountBefore: number;
  backfillStartCountAfter: number;
  playbackBeforeFailure: NationalPlaybackSnapshot;
  playbackAfterRestoration: NationalPlaybackSnapshot | null;
  rendererBeforeFailure: NationalGridRendererSnapshot;
}

export interface NationalPhase4ResidentHandoffReport {
  before: RadarSessionSnapshot;
  nationalGenerationBefore: number;
  backfillStartCountBefore: number;
  retainedBefore: number;
  whileSite: {
    sourceState: RadarSessionSnapshot;
    renderer: NationalGridRendererSnapshot | null;
    transfer: import("./packed-sweep/transferClient").TransferSnapshot;
    resident: boolean;
  };
  reveal: {
    activityBefore: NationalHistoryActivitySnapshot;
    activityAfter: NationalHistoryActivitySnapshot;
    revealMs: number;
    fadeMs: number;
  } | undefined;
  after: RadarSessionSnapshot;
  renderer: NationalGridRendererSnapshot | null;
  history: NationalHistorySnapshot | null;
  backfillStartCountAfter: number;
  siteLayerRemoved: boolean;
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
  var __MISTR_AUTO_SOURCE__: undefined | {
    evaluate(): void;
    state(): {
      preferredSite: string | null;
      lastDecision: { target: AutoSource; preload?: string; atUnixMs: number } | null;
      prefetchedSite: { site: string; generation: number; fetchedAtUnixMs: number } | null;
      prefetchInFlight: string | null;
      siteOpacity: number | null;
      lastFailure: { site: string; message: string; atUnixMs: number } | null;
      switchInFlight: { target: AutoSource; abandoned: boolean } | null;
      abandonedSwitches: number;
    };
    prefetch(site: string): Promise<void>;
  };
  var __MISTR_NATIONAL_PHASE4__: undefined | {
    report(): NationalPhase4Report;
    startNational(): Promise<NationalPhase3Report>;
    startSite(site?: string): Promise<Phase5Report>;
    proveFailedSiteKeepsNational(site?: string): Promise<NationalPhase4FailedSiteRecoveryReport>;
    proveResidentHandoff(site?: string): Promise<NationalPhase4ResidentHandoffReport>;
    proveZoomHandoff(site?: string, nextSite?: string): Promise<unknown>;
    proveLatestIntentWins(site?: string, nextSite?: string): Promise<unknown>;
    proveAbandonedNationalLoadKeepsSite(site?: string): Promise<unknown>;
    proveTimeCarry(site?: string): Promise<unknown>;
    proveSiteInspectionFollowsScan(site?: string): Promise<unknown>;
    loadTrace(): { atUnixMs: number; step: string; detail?: string }[];
    waitForHistory(frameCount?: number, timeoutMs?: number): Promise<NationalPhase4Report>;
    beginResidentEvidence(): Promise<void>;
    endResidentEvidence(): void;
    play(): Promise<void>;
    pause(): void;
    scrub(index: number): Promise<NationalPaintReceipt>;
    scrubWithEvidence(index: number): Promise<NationalPhase4ScrubReport>;
    runTransitions(count?: number): Promise<NationalPhase4TransitionReport>;
    refineForCamera(): Promise<NationalPhase4Report>;
    resetContext(holdMs?: number): Promise<NationalPhase4ContextResetReport>;
    setCamera(longitude: number, latitude: number, zoom: number): void;
    inspect(longitude: number, latitude: number): Promise<NationalPointLookup | null>;
    waitForInspection(observationId: string, timeoutMs?: number): Promise<NationalPointLookup>;
    waitForInspectionIdle(): Promise<LatestOnlyAsyncQueueSnapshot>;
    activity(): Promise<NationalHistoryActivitySnapshot>;
    transferSnapshot(): Promise<import("./packed-sweep/transferClient").TransferSnapshot>;
    sourceState(): import("./radar-session/RadarSessionCoordinator").RadarSessionSnapshot | null;
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
