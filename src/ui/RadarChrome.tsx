import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { filterRadarSites, type RadarSiteOption } from "../data/radarSites";
import type { GateInterrogation } from "../radar-renderer/cpuModel";
import type { RadarDisplayMode } from "../radar-renderer/RadarCustomLayer";
import { colorForReflectivity } from "../radar-renderer/palette";
import {
  inspectionReadoutPresentation,
  playbackAnnouncement,
  radarDisplayModeLabel,
  timelineFill,
  type FrameAgePresentation,
  type InspectionState,
  type LiveHistoryStatus,
} from "./radarChromeModel";
import { readRecentSites, rememberRecentSite } from "./recentSites";

export interface RadarNotice {
  kind: "info" | "error";
  message: string;
  /** A few words for the timeline row; the message stays the full account. */
  short?: string;
  /** Caution is an error the painted radar survives, such as a retry. */
  tone?: "info" | "caution" | "error";
}

export interface RadarChromeProps {
  ageCaution?: boolean;
  displayedAtUnixMs?: number;
  displayMode: RadarDisplayMode;
  displayModeReady: boolean;
  dismissPanelsSignal: number;
  frameAge: FrameAgePresentation;
  frameCount: number;
  frameIndex: number;
  /** Each frame's measured time, oldest first. */
  frameTimes?: readonly number[];
  historyCapacity?: number;
  interrogation: GateInterrogation | null;
  inspectionState: InspectionState;
  liveHistoryStatus?: LiveHistoryStatus;
  onClearInspection?(): void;
  onRecenter(): void;
  onSelectNational(): void;
  onSelectDisplayMode(mode: RadarDisplayMode): void;
  onScrub(index: number): void;
  onSelectSite(site: string): void;
  onTogglePlayback(): void;
  playbackReady: boolean;
  playbackStatus: string;
  playing: boolean;
  preparingFailed?: boolean;
  preparingLabel?: string;
  radarNotice?: RadarNotice;
  recenterReady: boolean;
  /** "none" until a source has painted. */
  paintedSourceKind: "site" | "national" | "none";
  requestedSourceKind?: "site" | "national";
  requestedSite?: string;
  selectedSite: string;
  siteSelectionReady: boolean;
  sites: readonly RadarSiteOption[];
}

type OpenPanel = "sites" | "view" | null;
type RailTool = "site" | "recenter" | "view";

export function RadarChrome({
  ageCaution = false,
  displayedAtUnixMs,
  displayMode,
  displayModeReady,
  dismissPanelsSignal,
  frameAge,
  frameCount,
  frameIndex,
  frameTimes,
  historyCapacity,
  interrogation,
  inspectionState,
  liveHistoryStatus,
  onClearInspection,
  onRecenter,
  onSelectNational,
  onSelectDisplayMode,
  onScrub,
  onSelectSite,
  onTogglePlayback,
  playbackReady,
  playbackStatus,
  playing,
  preparingFailed,
  preparingLabel,
  radarNotice,
  recenterReady,
  paintedSourceKind,
  requestedSourceKind,
  requestedSite,
  selectedSite,
  siteSelectionReady,
  sites,
}: RadarChromeProps) {
  const preparingPlayback = playbackStatus === "PREPARING PLAYBACK";
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null);
  const [railTabStop, setRailTabStop] = useState<RailTool>("site");
  const [recentSites, setRecentSites] = useState<string[]>(() => readRecentSites());
  const siteTriggerRef = useRef<HTMLButtonElement>(null);
  const recenterTriggerRef = useRef<HTMLButtonElement>(null);
  const viewTriggerRef = useRef<HTMLButtonElement>(null);
  const panelOriginRef = useRef<"site" | "view">("site");
  const transportReady = playbackReady && frameCount >= 2;

  const closePanel = useCallback((restoreFocus = true) => {
    const returnTarget = panelOriginRef.current === "site"
      ? siteTriggerRef.current
      : viewTriggerRef.current;
    setOpenPanel(null);
    if (restoreFocus) {
      globalThis.requestAnimationFrame(() => returnTarget?.focus());
    }
  }, []);

  const openSites = useCallback(() => {
    panelOriginRef.current = "site";
    setOpenPanel("sites");
  }, []);

  useEffect(() => {
    setOpenPanel(null);
  }, [dismissPanelsSignal]);

  // Keyboard: Escape closes a panel or clears the inspected point; `/` opens
  // site search; Space plays; left and right step one scan. Typing and focused
  // controls keep their own keys.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (event.key === "Escape") {
        if (openPanel) {
          event.preventDefault();
          closePanel();
        } else if (inspectionState !== "idle") {
          onClearInspection?.();
        }
        return;
      }
      if (target?.closest("input:not([type=range]), textarea, select, [contenteditable=true]")) return;
      if (event.key === "/") {
        if (!siteSelectionReady) return;
        event.preventDefault();
        openSites();
        return;
      }
      if (target?.closest("button, input, [role=menuitemradio], [role=option]")) return;
      if (event.key === " ") {
        if (!transportReady) return;
        event.preventDefault();
        onTogglePlayback();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (!transportReady) return;
        event.preventDefault();
        // The map pans with arrow keys when focused; stepping wins left and right.
        event.stopPropagation();
        const step = event.key === "ArrowLeft" ? -1 : 1;
        onScrub(Math.min(frameCount - 1, Math.max(0, frameIndex + step)));
      }
    };
    globalThis.addEventListener("keydown", onKeyDown, true);
    return () => globalThis.removeEventListener("keydown", onKeyDown, true);
  }, [
    closePanel, frameCount, frameIndex, inspectionState, onClearInspection, onScrub,
    onTogglePlayback, openPanel, openSites, siteSelectionReady, transportReady,
  ]);

  useEffect(() => {
    if (!openPanel) return;
    const panelId = openPanel === "sites" ? "mistr-context-site-panel" : "mistr-context-view-panel";
    const frame = globalThis.requestAnimationFrame(() => {
      const panel = document.getElementById(panelId);
      const target = openPanel === "view"
        ? panel?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
        : panel?.querySelector<HTMLElement>("input");
      target?.focus();
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [openPanel]);

  const moveRailFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLButtonElement) || !event.target.matches(".rail-button")) return;
    const ordered: Array<[RailTool, HTMLButtonElement | null]> = [
      ["site", siteTriggerRef.current],
      ["recenter", recenterTriggerRef.current],
      ["view", viewTriggerRef.current],
    ];
    const available = ordered.filter((entry): entry is [RailTool, HTMLButtonElement] => (
      Boolean(entry[1]) && !entry[1]?.disabled
    ));
    if (available.length === 0) return;
    const current = Math.max(0, available.findIndex(([, button]) => button === event.target));
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (current + 1) % available.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      next = (current - 1 + available.length) % available.length;
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = available.length - 1;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    const [tool, button] = available[next];
    setRailTabStop(tool);
    button.focus();
  };

  const selectSite = (site: string) => {
    setRecentSites(rememberRecentSite(site));
    onSelectSite(site);
    closePanel();
  };
  const selectNational = () => {
    onSelectNational();
    closePanel();
  };
  const selectDisplayMode = (mode: RadarDisplayMode) => {
    onSelectDisplayMode(mode);
    closePanel();
  };

  const availableTools: RailTool[] = [
    ...(siteSelectionReady ? ["site" as const] : []),
    ...(recenterReady ? ["recenter" as const] : []),
    ...(displayModeReady ? ["view" as const] : []),
  ];
  const tabStop = availableTools.includes(railTabStop) ? railTabStop : availableTools[0];
  const paintedName = paintedSourceKind === "national" ? "National" : selectedSite;
  const updating = requestedSourceKind === "national" ? "National" : requestedSite;
  const sample = inspectionReadoutPresentation(inspectionState, interrogation);

  return (
    <div className="radar-chrome">
      <ColorScale />

      <div
        aria-label="Radar tools"
        aria-orientation="vertical"
        className="radar-rail"
        onKeyDown={moveRailFocus}
        role="toolbar"
      >
        <div className="rail-group">
          <RailButton
            aria-controls="mistr-context-site-panel"
            aria-expanded={openPanel === "sites"}
            aria-haspopup="dialog"
            aria-label={`Choose radar source. ${paintedSourceKind === "none" ? "No radar is displayed yet." : `${paintedSourceKind === "national" ? "National CONUS" : `${selectedSite} Site`} is displayed.`}${requestedSourceKind === "national" ? " Updating National." : requestedSite ? ` Updating ${requestedSite}.` : ""}`}
            className="rail-button rail-button--site"
            data-control="radar-sites"
            data-role="radar-source"
            data-displayed-site={selectedSite}
            data-painted-source={paintedSourceKind}
            data-requested-site={requestedSite}
            data-requested-source={requestedSourceKind}
            disabled={!siteSelectionReady}
            onClick={() => (openPanel === "sites" ? closePanel() : openSites())}
            onFocus={() => setRailTabStop("site")}
            ref={siteTriggerRef}
            tabIndex={tabStop === "site" ? 0 : -1}
            tooltip={`Radar · ${paintedSourceKind === "none" ? "Loading" : paintedName}`}
            tooltipSuppressed={openPanel === "sites"}
            type="button"
          >
            <RadarIcon />
            {updating ? <span aria-hidden="true" className="site-activity" /> : null}
          </RailButton>
          <RailButton
            aria-label={paintedSourceKind === "national"
              ? "Recenter National radar on the contiguous United States"
              : `Recenter radar on ${selectedSite}`}
            className="rail-button rail-button--recenter"
            data-control="recenter-radar"
            disabled={!recenterReady}
            onClick={() => {
              setOpenPanel(null);
              onRecenter();
            }}
            onFocus={() => setRailTabStop("recenter")}
            ref={recenterTriggerRef}
            tabIndex={tabStop === "recenter" ? 0 : -1}
            tooltip="Recenter"
            type="button"
          >
            <FitIcon />
          </RailButton>
        </div>
        <div className="rail-group">
          <RailButton
            aria-controls="mistr-context-view-panel"
            aria-expanded={openPanel === "view"}
            aria-haspopup="menu"
            aria-label={`Radar view. ${radarDisplayModeLabel(displayMode)} selected.`}
            className="rail-button rail-button--view"
            data-control="radar-view"
            disabled={!displayModeReady}
            onClick={() => {
              if (openPanel === "view") closePanel();
              else {
                panelOriginRef.current = "view";
                setOpenPanel("view");
              }
            }}
            onFocus={() => setRailTabStop("view")}
            ref={viewTriggerRef}
            tabIndex={tabStop === "view" ? 0 : -1}
            tooltip={`Radar view · ${radarDisplayModeLabel(displayMode)}`}
            tooltipSuppressed={openPanel === "view"}
            type="button"
          >
            <EyeIcon />
          </RailButton>
        </div>
        {openPanel === "view" ? (
          <ViewPopover currentMode={displayMode} id="mistr-context-view-panel" onSelect={selectDisplayMode} />
        ) : null}
      </div>

      {openPanel === "sites" ? (
        <SourceSheet
          currentSite={selectedSite}
          id="mistr-context-site-panel"
          onClose={() => closePanel()}
          onSelect={selectSite}
          onSelectNational={selectNational}
          paintedSourceKind={paintedSourceKind === "none" ? requestedSourceKind ?? "site" : paintedSourceKind}
          recentSites={recentSites}
          selectionReady={siteSelectionReady}
          sites={sites}
        />
      ) : null}

      {preparingLabel ? (
        <section
          aria-label="Radar preparation"
          className={`playback-bar playback-bar--preparing${preparingFailed ? " playback-bar--failed" : ""}`}
        >
          <span aria-hidden="true" className="preparing-indicator">
            {preparingFailed ? <AlertIcon /> : <span className="preparing-spinner" />}
          </span>
          <span className="preparing-copy">
            <strong>
              {preparingFailed
                ? "Radar unavailable"
                : requestedSourceKind === "national" ? "National" : requestedSite ?? selectedSite}
            </strong>
            <small>{preparingLabel}</small>
          </span>
        </section>
      ) : (
        <section aria-label="Radar playback" className="playback-bar">
          <button
            aria-label={preparingPlayback
              ? "Cancel radar playback preparation"
              : playing ? "Pause radar loop" : "Play radar loop"}
            className="playback-toggle"
            disabled={!transportReady}
            onClick={onTogglePlayback}
            type="button"
          >
            {playing || preparingPlayback ? <PauseIcon /> : <PlayIcon />}
          </button>
          <ScanReadout
            ageCaution={ageCaution}
            displayedAtUnixMs={displayedAtUnixMs}
            frameAge={frameAge}
          >
            <span
              className={`tag${updating && paintedSourceKind !== "none" ? " tag--pending" : ""}`}
              data-source-tag={paintedSourceKind}
            >
              {paintedSourceKind === "none" ? updating ?? "Radar" : paintedName}
              {updating && paintedSourceKind !== "none" && updating !== paintedName
                ? <><span aria-hidden="true" className="tag-arrow">→</span>{updating}</>
                : null}
            </span>
          </ScanReadout>
          <Timeline
            disabled={!transportReady}
            frameAge={frameAge}
            frameCount={frameCount}
            frameIndex={frameIndex}
            frameTimes={frameTimes}
            historyCapacity={historyCapacity}
            liveHistoryStatus={liveHistoryStatus}
            notice={radarNotice}
            displayedAtUnixMs={displayedAtUnixMs}
            onScrub={onScrub}
          />
          <span aria-hidden="true" className="bar-divider" />
          <div className="telemetry-readouts">
            <output
              aria-busy={sample.busy}
              aria-label={sample.accessibleLabel}
              className={`sample-readout sample-readout--${sample.kind}`}
              data-inspection-state={inspectionState}
            >
              {sample.kind === "hint" ? <InspectIcon /> : null}
              {sample.valueDbz !== undefined ? (
                <span
                  aria-hidden="true"
                  className="sample-swatch"
                  style={{ background: reflectivityCss(sample.valueDbz, true) }}
                />
              ) : null}
              {sample.label}
            </output>
          </div>
        </section>
      )}

      {radarNotice ? (
        <p
          className="sr-only radar-notice"
          role={radarNotice.kind === "error" ? "alert" : "status"}
        >
          {radarNotice.message}
        </p>
      ) : null}

      <p aria-live="polite" className="sr-only radar-announcement">
        {radarNotice || preparingFailed
          ? ""
          : preparingLabel
          ? `Preparing radar. ${preparingLabel}.`
          : playing
            ? playbackAnnouncement(playbackStatus)
            : `${playbackAnnouncement(playbackStatus)}. ${sample.accessibleLabel}`}
      </p>
    </div>
  );
}

function ScanReadout({
  ageCaution,
  children,
  displayedAtUnixMs,
  frameAge,
}: {
  ageCaution: boolean;
  children: ReactNode;
  displayedAtUnixMs?: number;
  frameAge: FrameAgePresentation;
}) {
  const timestamp = formatScanTimestamp(displayedAtUnixMs);
  return (
    <div className="scan-readout">
      {/* A scan from another day shows its date where the zone sits, in the
          same slot, so a loop across midnight never moves the row. */}
      <div className="scan-time" aria-label={`Displayed scan ${timestamp.accessible}`}>
        <strong className="scan-time__clock">{timestamp.time}</strong>
        {timestamp.today
          ? <span className="scan-time__zone">{timestamp.zone}</span>
          : <span className="scan-time__date">{timestamp.dateShort}</span>}
      </div>
      <output
        aria-label={frameAge.accessibleLabel}
        className={`frame-age frame-age--${frameAge.kind}${ageCaution ? " frame-age--caution" : ""}`}
        data-frame-age-kind={frameAge.kind}
      >
        {frameAge.label}
      </output>
      {children}
    </div>
  );
}

// Inset of the range thumb's centre from each end of the track.
const THUMB_INSET_PX = 6;
// Clock ticks at the first interval that keeps them to a dozen or fewer.
const TICK_INTERVALS_MS = [15, 30, 60, 120].map((minutes) => minutes * 60_000);
const MAX_TICKS = 12;

/** The scans that cross a clock tick, at the finest interval that stays sparse. */
export function clockTickIndexes(times: readonly number[]): number[] {
  let marks: number[] = [];
  for (const interval of TICK_INTERVALS_MS) {
    marks = [];
    for (let index = 1; index < times.length; index += 1) {
      if (Math.floor(times[index] / interval) !== Math.floor(times[index - 1] / interval)) marks.push(index);
    }
    if (marks.length <= MAX_TICKS) return marks;
  }
  return marks;
}

function Timeline({
  disabled,
  displayedAtUnixMs,
  frameAge,
  frameCount,
  frameIndex,
  frameTimes,
  historyCapacity,
  liveHistoryStatus,
  notice,
  onScrub,
}: {
  disabled: boolean;
  displayedAtUnixMs?: number;
  frameAge: FrameAgePresentation;
  frameCount: number;
  frameIndex: number;
  frameTimes?: readonly number[];
  historyCapacity?: number;
  liveHistoryStatus?: LiveHistoryStatus;
  notice?: RadarNotice;
  onScrub(index: number): void;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const noticeTooltipId = useId();
  const fill = timelineFill(frameCount, historyCapacity, liveHistoryStatus);
  const pendingShare = 1 - fill.loadedShare;
  const times = frameTimes?.length === frameCount ? frameTimes : undefined;
  const lastIndex = Math.max(0, frameCount - 1);
  const position = (index: number) => (lastIndex === 0 ? 1 : index / lastIndex);
  const ticks = useMemo(() => (times ? clockTickIndexes(times) : []), [times]);
  const timestamp = formatScanTimestamp(displayedAtUnixMs);
  const tone = notice ? notice.tone ?? (notice.kind === "error" ? "error" : "info") : undefined;
  const statusLabel = notice?.short;

  useEffect(() => {
    if (!statusLabel) setNoticeOpen(false);
  }, [statusLabel]);

  const trackHover = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || frameCount < 2) return;
    const box = event.currentTarget.getBoundingClientRect();
    const span = box.width - THUMB_INSET_PX * 2;
    if (span <= 0) return;
    const share = Math.min(1, Math.max(0, (event.clientX - box.left - THUMB_INSET_PX) / span));
    setHoverIndex(Math.round(share * lastIndex));
  };

  return (
    <div className="timeline" data-loading={fill.loadingLabel ? "true" : undefined}>
      <div aria-hidden="true" className="timeline__rail">
        {pendingShare > 0 ? (
          <span className="timeline__pending" style={{ width: `${pendingShare * 100}%` }} />
        ) : null}
        <span className="timeline__loaded" style={{ left: `${pendingShare * 100}%` }} />
      </div>
      <div
        className="timeline__frames"
        onPointerLeave={() => setHoverIndex(null)}
        onPointerMove={trackHover}
        style={{ left: `${pendingShare * 100}%` }}
      >
        <div aria-hidden="true" className="timeline-ticks">
          {ticks.map((index) => (
            <span key={index} style={{ "--p": position(index) } as CSSProperties} />
          ))}
        </div>
        <input
          aria-label="Displayed radar scan"
          aria-valuetext={`Frame ${Math.min(frameIndex + 1, frameCount)} of ${frameCount || 0}. ${timestamp.accessible}. ${frameAge.accessibleLabel}`}
          disabled={disabled}
          max={lastIndex}
          min="0"
          onChange={(event) => onScrub(Number(event.currentTarget.value))}
          step="1"
          type="range"
          value={Math.min(frameIndex, lastIndex)}
        />
        {hoverIndex !== null && times ? (
          <span
            aria-hidden="true"
            className="timeline__hover"
            style={{ "--p": position(hoverIndex) } as CSSProperties}
          >
            {formatShortClock(times[hoverIndex])}
          </span>
        ) : null}
      </div>
      {statusLabel && hoverIndex === null ? (
        <span
          aria-describedby={noticeOpen ? noticeTooltipId : undefined}
          className={`timeline__status timeline__status--${tone}`}
          onBlur={() => setNoticeOpen(false)}
          onFocus={() => setNoticeOpen(true)}
          onPointerEnter={() => setNoticeOpen(true)}
          onPointerLeave={() => setNoticeOpen(false)}
          tabIndex={0}
        >
          {tone === "info" ? <span aria-hidden="true" className="status-spinner" /> : null}
          {statusLabel}
          {noticeOpen && notice ? (
            <span className="chrome-tooltip chrome-tooltip--above" id={noticeTooltipId} role="tooltip">
              {notice.message}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

// The radar's own display colours, weak returns faded as on the map.
const SCALE_MIN_DBZ = 5;
const SCALE_MAX_DBZ = 70;
const SCALE_TICKS = [10, 20, 30, 40, 50, 60];

function scaleShare(dbz: number) {
  return (dbz - SCALE_MIN_DBZ) / (SCALE_MAX_DBZ - SCALE_MIN_DBZ);
}

function reflectivityCss(dbz: number, opaque = false) {
  const [red, green, blue, alpha] = colorForReflectivity(dbz);
  return `rgba(${red}, ${green}, ${blue}, ${opaque ? 1 : (alpha / 255).toFixed(3)})`;
}

function ColorScale() {
  const gradient = useMemo(() => {
    const stops: string[] = [];
    for (let dbz = SCALE_MIN_DBZ; dbz <= SCALE_MAX_DBZ; dbz += 2.5) {
      stops.push(`${reflectivityCss(dbz)} ${(scaleShare(dbz) * 100).toFixed(2)}%`);
    }
    return `linear-gradient(90deg, ${stops.join(", ")})`;
  }, []);
  return (
    <div
      aria-label={`Reflectivity color scale, ${SCALE_MIN_DBZ} to ${SCALE_MAX_DBZ} dBZ`}
      className="color-scale"
      role="img"
    >
      <span className="color-scale__end">Light</span>
      <span className="color-scale__scale">
        <span className="color-scale__bar" style={{ background: gradient }} />
        <span aria-hidden="true" className="color-scale__ticks">
          {SCALE_TICKS.map((dbz) => (
            <span key={dbz} style={{ left: `${scaleShare(dbz) * 100}%` }}>{dbz}</span>
          ))}
        </span>
      </span>
      <span className="color-scale__end">Heavy · dBZ</span>
    </div>
  );
}

interface RailButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tooltip: string;
  tooltipSuppressed?: boolean;
}

const RailButton = forwardRef<HTMLButtonElement, RailButtonProps>(function RailButton({
  children,
  onBlur,
  onClick,
  onFocus,
  onKeyDown,
  tooltip,
  tooltipSuppressed = false,
  ...buttonProps
}, ref) {
  const tooltipId = useId();
  const hoverTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      globalThis.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);
  const hideTooltip = useCallback(() => {
    clearHoverTimer();
    setTooltipVisible(false);
  }, [clearHoverTimer]);

  useEffect(() => hideTooltip, [hideTooltip]);
  useEffect(() => {
    if (tooltipSuppressed) hideTooltip();
  }, [hideTooltip, tooltipSuppressed]);

  return (
    <span
      className="rail-anchor"
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse" || tooltipSuppressed) return;
        clearHoverTimer();
        hoverTimerRef.current = globalThis.setTimeout(() => {
          setTooltipVisible(true);
          hoverTimerRef.current = null;
        }, 400);
      }}
      onPointerLeave={hideTooltip}
    >
      <button
        {...buttonProps}
        aria-describedby={tooltipVisible ? tooltipId : undefined}
        onBlur={(event) => {
          hideTooltip();
          onBlur?.(event);
        }}
        onClick={(event) => {
          hideTooltip();
          onClick?.(event);
        }}
        onFocus={(event) => {
          // Keyboard focus only: focus returning after a click stays quiet.
          if (!tooltipSuppressed && event.currentTarget.matches(":focus-visible")) setTooltipVisible(true);
          onFocus?.(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") hideTooltip();
          onKeyDown?.(event);
        }}
        ref={ref}
      >
        {children}
      </button>
      {tooltipVisible ? (
        <span className="chrome-tooltip chrome-tooltip--left" id={tooltipId} role="tooltip">{tooltip}</span>
      ) : null}
    </span>
  );
});

const DISPLAY_MODES: readonly RadarDisplayMode[] = ["smooth", "native"];
const DISPLAY_MODE_CAPTIONS: Record<RadarDisplayMode, string> = {
  smooth: "Softer gate edges, same values.",
  native: "Every measured gate, unsmoothed.",
};

function ViewPopover({
  currentMode,
  id,
  onSelect,
}: {
  currentMode: RadarDisplayMode;
  id: string;
  onSelect(mode: RadarDisplayMode): void;
}) {
  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const options = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    );
    if (options.length === 0) return;
    const current = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement));
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (current + 1) % options.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      next = (current - 1 + options.length) % options.length;
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    options[next].focus();
  };

  return (
    <div
      aria-label="Radar view"
      className="tool-panel tool-panel--view"
      id={id}
      onKeyDown={moveFocus}
      role="menu"
    >
      <div className="segmented">
        {DISPLAY_MODES.map((mode) => {
          const selected = mode === currentMode;
          return (
            <button
              aria-checked={selected}
              key={mode}
              onClick={() => onSelect(mode)}
              role="menuitemradio"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {radarDisplayModeLabel(mode)}
            </button>
          );
        })}
      </div>
      <p className="view-caption">{DISPLAY_MODE_CAPTIONS[currentMode]}</p>
    </div>
  );
}

type SourceOption =
  | { key: string; kind: "national" }
  | { key: string; kind: "site"; site: RadarSiteOption };

interface SourceGroup {
  label?: string;
  options: SourceOption[];
}

const NATIONAL_TERMS = ["NATIONAL", "CONUS", "MRMS", "MOSAIC"];

export function sourceOptionGroups(
  sites: readonly RadarSiteOption[],
  query: string,
  recentSites: readonly string[],
): SourceGroup[] {
  const normalized = query.trim().toLocaleUpperCase("en-US");
  const national: SourceOption = { key: "national", kind: "national" };
  if (normalized) {
    const nationalMatches = NATIONAL_TERMS.some((term) => term.startsWith(normalized) || normalized.startsWith(term));
    const matches = filterRadarSites(sites, normalized)
      .map((site): SourceOption => ({ key: `site-${site.id}`, kind: "site", site }));
    return [{ options: [...(nationalMatches ? [national] : []), ...matches] }];
  }
  const byId = new Map(sites.map((site) => [site.id, site]));
  const recent = recentSites
    .map((id) => byId.get(id))
    .filter((site): site is RadarSiteOption => site !== undefined)
    .map((site): SourceOption => ({ key: `recent-${site.id}`, kind: "site", site }));
  return [
    { options: [national] },
    ...(recent.length > 0 ? [{ label: "Recent", options: recent }] : []),
    {
      label: "All sites",
      options: sites.map((site): SourceOption => ({ key: `site-${site.id}`, kind: "site", site })),
    },
  ];
}

function SourceSheet({
  currentSite,
  id,
  onClose,
  onSelect,
  onSelectNational,
  paintedSourceKind,
  recentSites,
  selectionReady,
  sites,
}: {
  currentSite: string;
  id: string;
  onClose(): void;
  onSelect(site: string): void;
  onSelectNational(): void;
  paintedSourceKind: "site" | "national";
  recentSites: readonly string[];
  selectionReady: boolean;
  sites: readonly RadarSiteOption[];
}) {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => sourceOptionGroups(sites, query, recentSites), [query, recentSites, sites]);
  const options = groups.flatMap((group) => group.options);
  const isCurrent = (option: SourceOption) => (option.kind === "national"
    ? paintedSourceKind === "national"
    : paintedSourceKind === "site" && option.site.id === currentSite);
  const startIndex = () => (query.trim() ? 0 : Math.max(0, options.findIndex(isCurrent)));
  const [active, setActive] = useState(startIndex);
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const optionId = (index: number) => `${id}-option-${index}`;

  // A new search starts at its first match; clearing it returns to the radar shown.
  useEffect(() => setActive(startIndex()), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[aria-selected="true"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, query]);

  const choose = (option: SourceOption | undefined) => {
    if (!option || !selectionReady) return;
    if (option.kind === "national") onSelectNational();
    else onSelect(option.site.id);
  };
  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + options.length) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(options[activeIndex]);
    }
  };

  let index = -1;
  return (
    <aside aria-label="Choose radar source" className="tool-panel tool-panel--site" id={id} role="dialog">
      <header className="sheet-header">
        <h2>Radar</h2>
        <button aria-label="Close radar list" className="icon-button" onClick={onClose} type="button">
          <CloseIcon />
        </button>
      </header>
      <div className="site-search">
        <SearchIcon />
        <input
          aria-activedescendant={options.length > 0 ? optionId(activeIndex) : undefined}
          aria-autocomplete="list"
          aria-controls={`${id}-list`}
          aria-expanded="true"
          aria-label="Search radar sites"
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onSearchKey}
          placeholder="Search site ID or city"
          ref={searchRef}
          role="combobox"
          spellCheck={false}
          type="search"
          value={query}
        />
        {query ? (
          <button
            aria-label="Clear search"
            className="icon-button site-search__clear"
            onClick={() => {
              setQuery("");
              searchRef.current?.focus();
            }}
            type="button"
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>
      <p aria-live="polite" className="sr-only" role="status">
        {options.length === 0
          ? "No matching radar sites."
          : `${options.length} ${options.length === 1 ? "result" : "results"}.`}
      </p>
      <div aria-label="Radar sources" className="source-list" id={`${id}-list`} ref={listRef} role="listbox">
        {groups.map((group, groupIndex) => (
          <div
            aria-label={group.label}
            className="source-group"
            key={group.label ?? `group-${groupIndex}`}
            role="group"
          >
            {group.label ? <p aria-hidden="true" className="source-group__label">{group.label}</p> : null}
            {group.options.map((option) => {
              index += 1;
              const optionIndex = index;
              const current = isCurrent(option);
              return (
                <button
                  aria-current={current ? "true" : undefined}
                  aria-selected={optionIndex === activeIndex}
                  className="source-option"
                  data-source-option={option.kind === "national" ? "national" : option.site.id}
                  disabled={!selectionReady}
                  id={optionId(optionIndex)}
                  key={option.key}
                  onClick={() => choose(option)}
                  onPointerMove={() => setActive(optionIndex)}
                  role="option"
                  tabIndex={-1}
                  type="button"
                >
                  {option.kind === "national" ? (
                    <span><strong>National</strong><small>CONUS mosaic</small></span>
                  ) : (
                    <span><strong>{option.site.id}</strong><small>{option.site.name}</small></span>
                  )}
                  {current ? <CheckIcon /> : null}
                </button>
              );
            })}
          </div>
        ))}
        {options.length === 0 ? <p className="source-list__empty">No matching radar sites.</p> : null}
      </div>
    </aside>
  );
}

// Built once: constructing an Intl formatter costs far more than formatting.
const ZONE_FORMAT = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" });
const SHORT_DATE_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

export function formatScanTimestamp(unixMs: number | undefined, nowUnixMs = Date.now()) {
  if (unixMs === undefined) {
    return {
      date: "---- -- --", dateShort: "", today: true, time: "--:--:--", zone: "", accessible: "waiting",
    };
  }
  const date = new Date(unixMs);
  const now = new Date(nowUnixMs);
  const dateText = [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join("-");
  const timeText = [
    (date.getHours() % 12 || 12).toString(),
    date.getMinutes().toString().padStart(2, "0"),
    date.getSeconds().toString().padStart(2, "0"),
  ].join(":") + (date.getHours() < 12 ? " AM" : " PM");
  const zone = ZONE_FORMAT
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value ?? "";
  return {
    date: dateText,
    dateShort: SHORT_DATE_FORMAT.format(date),
    today: date.toDateString() === now.toDateString(),
    time: timeText,
    zone,
    accessible: `${dateText} ${timeText} ${zone}`.trim(),
  };
}

function formatShortClock(unixMs: number) {
  const date = new Date(unixMs);
  return `${date.getHours() % 12 || 12}:${date.getMinutes().toString().padStart(2, "0")}`
    + (date.getHours() < 12 ? " AM" : " PM");
}

// Controls: 24px grid, 1.75 stroke, round joins.
function UiIcon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

function PlayIcon() {
  return (
    <UiIcon>
      <path d="M8 5.5v13a.8.8 0 0 0 1.2.7l10.4-6.5a.8.8 0 0 0 0-1.4L9.2 4.8A.8.8 0 0 0 8 5.5z" fill="currentColor" stroke="none" />
    </UiIcon>
  );
}

function PauseIcon() {
  return (
    <UiIcon>
      <rect fill="currentColor" height="14" rx="1.2" stroke="none" width="3.6" x="6.5" y="5" />
      <rect fill="currentColor" height="14" rx="1.2" stroke="none" width="3.6" x="13.9" y="5" />
    </UiIcon>
  );
}

function RadarIcon() {
  return (
    <UiIcon>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 12 17.3 6.7" />
      <path d="M12 7.5a4.5 4.5 0 1 0 4.5 4.5" />
      <circle cx="12" cy="12" fill="currentColor" r="1.1" stroke="none" />
    </UiIcon>
  );
}

function FitIcon() {
  return (
    <UiIcon>
      <path d="M4.5 9V6a1.5 1.5 0 0 1 1.5-1.5h3M15 4.5h3A1.5 1.5 0 0 1 19.5 6v3M19.5 15v3a1.5 1.5 0 0 1-1.5 1.5h-3M9 19.5H6A1.5 1.5 0 0 1 4.5 18v-3" />
      <circle cx="12" cy="12" r="2.25" />
    </UiIcon>
  );
}

function EyeIcon() {
  return (
    <UiIcon>
      <path d="M2.75 12S6.1 6.25 12 6.25 21.25 12 21.25 12 17.9 17.75 12 17.75 2.75 12 2.75 12z" />
      <circle cx="12" cy="12" r="2.75" />
    </UiIcon>
  );
}

function InspectIcon() {
  return (
    <UiIcon className="inspect-icon">
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21" />
    </UiIcon>
  );
}

function AlertIcon() {
  return (
    <UiIcon>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.75v5" />
      <path d="M12 16.25v.01" strokeWidth="2.4" />
    </UiIcon>
  );
}

function CheckIcon() {
  return (
    <UiIcon className="check-icon">
      <path d="m5.5 12.5 4 4 9-9" />
    </UiIcon>
  );
}

function CloseIcon() {
  return (
    <UiIcon>
      <path d="m6 6 12 12M18 6 6 18" />
    </UiIcon>
  );
}

function SearchIcon() {
  return (
    <UiIcon>
      <circle cx="11" cy="11" r="6.25" />
      <path d="m20 20-4.5-4.5" />
    </UiIcon>
  );
}
