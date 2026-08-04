import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { filterRadarSites, type RadarSiteOption } from "../data/radarSites";
import type { GateInterrogation } from "../radar-renderer/cpuModel";
import type { RadarDisplayMode } from "../radar-renderer/RadarCustomLayer";
import {
  radarDisplayModeLabel,
  timelinePosition,
  type FrameAgePresentation,
} from "./radarChromeModel";

export interface RadarChromeProps {
  displayedAtUnixMs?: number;
  displayMode: RadarDisplayMode;
  displayModeReady: boolean;
  dismissPanelsSignal: number;
  frameAge: FrameAgePresentation;
  frameCount: number;
  frameIndex: number;
  interrogation: GateInterrogation | null;
  inspectionSelected: boolean;
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
  radarNotice?: { kind: "info" | "error"; message: string };
  recenterReady: boolean;
  paintedSourceKind: "site" | "national";
  requestedSourceKind?: "site" | "national";
  requestedSite?: string;
  selectedSite: string;
  siteSelectionReady: boolean;
  sites: readonly RadarSiteOption[];
}

type OpenPanel = "context-sites" | "context-view" | null;
type ToolbarTool = "site" | "recenter" | "view";

export function RadarChrome({
  displayedAtUnixMs,
  displayMode,
  displayModeReady,
  dismissPanelsSignal,
  frameAge,
  frameCount,
  frameIndex,
  interrogation,
  inspectionSelected,
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
  const [toolbarTabStop, setToolbarTabStop] = useState<ToolbarTool>("site");
  const siteTriggerRef = useRef<HTMLButtonElement>(null);
  const recenterTriggerRef = useRef<HTMLButtonElement>(null);
  const viewTriggerRef = useRef<HTMLButtonElement>(null);
  const panelOriginRef = useRef<"site" | "view">("site");

  const closePanel = useCallback((restoreFocus = true) => {
    const returnTarget = panelOriginRef.current === "site"
      ? siteTriggerRef.current
      : viewTriggerRef.current;
    setOpenPanel(null);
    if (restoreFocus) {
      globalThis.requestAnimationFrame(() => returnTarget?.focus());
    }
  }, []);

  useEffect(() => {
    setOpenPanel(null);
  }, [dismissPanelsSignal]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && openPanel) {
        event.preventDefault();
        closePanel();
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [closePanel, openPanel]);

  useEffect(() => {
    if (!openPanel) return;
    const panelId = openPanel === "context-sites"
      ? "mistr-context-site-panel"
      : "mistr-context-view-panel";
    const frame = globalThis.requestAnimationFrame(() => {
      const panel = document.getElementById(panelId);
      const selectedView = openPanel === "context-view"
        ? panel?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
        : null;
      (selectedView
        ?? panel?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)"))
        ?.focus();
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [openPanel]);

  const moveToolbarFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLButtonElement) || !event.target.matches(".context-tool")) {
      return;
    }
    const orderedTools: Array<[ToolbarTool, HTMLButtonElement | null]> = [
      ["site", siteTriggerRef.current],
      ["recenter", recenterTriggerRef.current],
      ["view", viewTriggerRef.current],
    ];
    const availableTools = orderedTools.filter((entry): entry is [ToolbarTool, HTMLButtonElement] => (
      Boolean(entry[1]) && !entry[1]?.disabled
    ));
    if (availableTools.length === 0) return;
    const currentIndex = Math.max(
      0,
      availableTools.findIndex(([, button]) => button === event.target),
    );
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % availableTools.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + availableTools.length) % availableTools.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = availableTools.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const [nextTool, nextButton] = availableTools[nextIndex];
    setToolbarTabStop(nextTool);
    nextButton.focus();
  };

  const selectSite = (site: string) => {
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
  const timestamp = formatScanTimestamp(displayedAtUnixMs);
  const sample = formatSample(interrogation);
  const sampleDisplay = sample
    ?? (inspectionSelected ? "OUTSIDE RADAR COVERAGE" : "CLICK TO INSPECT");
  const sampleAnnouncement = sample
    ?? (inspectionSelected ? "Outside radar coverage." : "No radar point selected.");
  const availableToolbarTools: ToolbarTool[] = [
    ...(siteSelectionReady ? ["site" as const] : []),
    ...(recenterReady ? ["recenter" as const] : []),
    ...(displayModeReady ? ["view" as const] : []),
  ];
  const effectiveToolbarTabStop = availableToolbarTools.includes(toolbarTabStop)
    ? toolbarTabStop
    : availableToolbarTools[0];

  return (
    <div className="radar-chrome">
      <div
        aria-label="Radar tools"
        className="context-bar"
        onKeyDown={moveToolbarFocus}
        role="toolbar"
      >
        <span className="mistr-wordmark" aria-label="Mistr">Mistr</span>
        <span aria-hidden="true" className="instrument-divider" />
        <IconToolButton
          aria-controls="mistr-context-site-panel"
          aria-expanded={openPanel === "context-sites"}
          aria-haspopup="dialog"
          aria-label={`Choose radar source. ${paintedSourceKind === "national" ? "National CONUS" : `${selectedSite} Site`} is displayed.${requestedSourceKind === "national" ? " Updating National." : requestedSite ? ` Updating ${requestedSite}.` : ""}`}
          className="context-tool context-tool--site"
          data-control="radar-sites"
          data-role="radar-source"
          data-displayed-site={selectedSite}
          data-painted-source={paintedSourceKind}
          data-requested-site={requestedSite}
          data-requested-source={requestedSourceKind}
          disabled={!siteSelectionReady}
          onClick={() => {
            if (openPanel === "context-sites") closePanel();
            else {
              panelOriginRef.current = "site";
              setOpenPanel("context-sites");
            }
          }}
          onFocus={() => setToolbarTabStop("site")}
          ref={siteTriggerRef}
          tabIndex={effectiveToolbarTabStop === "site" ? 0 : -1}
          tooltip={`Radar Source · ${paintedSourceKind === "national" ? "National" : selectedSite}`}
          tooltipSuppressed={openPanel === "context-sites"}
          type="button"
        >
          <RadarSiteIcon />
          {requestedSite || requestedSourceKind === "national"
            ? <span aria-hidden="true" className="site-activity" />
            : null}
        </IconToolButton>
        <IconToolButton
          aria-label={paintedSourceKind === "national"
            ? "Recenter National radar on the contiguous United States"
            : `Recenter radar on ${selectedSite}`}
          className="context-tool context-tool--recenter"
          data-control="recenter-radar"
          disabled={!recenterReady}
          onClick={() => {
            setOpenPanel(null);
            onRecenter();
          }}
          onFocus={() => setToolbarTabStop("recenter")}
          ref={recenterTriggerRef}
          tabIndex={effectiveToolbarTabStop === "recenter" ? 0 : -1}
          tooltip="Recenter Radar"
          type="button"
        >
          <RecenterIcon />
        </IconToolButton>
        <span aria-hidden="true" className="instrument-divider" />
        <IconToolButton
          aria-controls="mistr-context-view-panel"
          aria-expanded={openPanel === "context-view"}
          aria-haspopup="menu"
          aria-label={`Radar view. ${radarDisplayModeLabel(displayMode)} selected.`}
          className="context-tool context-tool--view"
          data-control="radar-view"
          disabled={!displayModeReady}
          onClick={() => {
            if (openPanel === "context-view") closePanel();
            else {
              panelOriginRef.current = "view";
              setOpenPanel("context-view");
            }
          }}
          onFocus={() => setToolbarTabStop("view")}
          ref={viewTriggerRef}
          tabIndex={effectiveToolbarTabStop === "view" ? 0 : -1}
          tooltip="Radar View"
          tooltipSuppressed={openPanel === "context-view"}
          type="button"
        >
          <EyeIcon />
        </IconToolButton>

        {openPanel === "context-view" ? (
          <ViewPanel
            currentMode={displayMode}
            id="mistr-context-view-panel"
            onSelect={selectDisplayMode}
          />
        ) : null}
      </div>

      {openPanel === "context-sites" ? (
        <SourcePanel
          className="tool-panel--site"
          currentSite={selectedSite}
          id="mistr-context-site-panel"
          onSelectNational={selectNational}
          onSelect={selectSite}
          paintedSourceKind={paintedSourceKind}
          selectionReady={siteSelectionReady}
          sites={sites}
        />
      ) : null}

      {preparingLabel ? (
        <section
          aria-label="Radar preparation"
          className={`playback-bar playback-bar--preparing${preparingFailed ? " playback-bar--failed" : ""}`}
        >
          <span aria-hidden="true" className="preparing-indicator" />
          <span className="preparing-copy">
            <strong>{preparingFailed ? "RADAR UNAVAILABLE" : "PREPARING RADAR"}</strong>
            <small>{preparingLabel}</small>
          </span>
        </section>
      ) : (
        <section aria-label="Radar playback" className="playback-bar">
        <div className="scan-time" aria-label={`Displayed scan ${timestamp.accessible}`}>
          <span>{timestamp.date}</span>
          <strong>{timestamp.time}</strong>
          <span>{timestamp.zone}</span>
        </div>
        <span aria-hidden="true" className="instrument-divider" />
        <button
          aria-label={preparingPlayback
            ? "Cancel radar playback preparation"
            : playing ? "Pause radar loop" : "Play radar loop"}
          className="playback-toggle"
          disabled={!playbackReady || frameCount < 2}
          onClick={onTogglePlayback}
          type="button"
        >
          {playing || preparingPlayback ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div className="timeline">
          <input
            aria-label="Displayed radar scan"
            aria-valuetext={`Frame ${Math.min(frameIndex + 1, frameCount)} of ${frameCount || 0}. ${timestamp.accessible}. ${frameAge.accessibleLabel}`}
            disabled={!playbackReady || frameCount < 2}
            max={Math.max(0, frameCount - 1)}
            min="0"
            onChange={(event) => onScrub(Number(event.currentTarget.value))}
            step="1"
            type="range"
            value={Math.min(frameIndex, Math.max(0, frameCount - 1))}
          />
          <div aria-hidden="true" className="timeline-ticks" />
          <div className="timeline-meta">
            <span>{timelinePosition(
              frameIndex,
              frameCount,
            )}</span>
          </div>
        </div>
        <span aria-hidden="true" className="instrument-divider" />
        <output
          aria-label={frameAge.accessibleLabel}
          className={`frame-age frame-age--${frameAge.kind}`}
          data-frame-age-kind={frameAge.kind}
        >
          {frameAge.label}
        </output>
        <output className={`sample-readout${sample ? " sample-readout--active" : ""}`}>
          {sampleDisplay}
        </output>
        </section>
      )}

      {radarNotice ? (
        <p
          className={`radar-notice radar-notice--${radarNotice.kind}`}
          role={radarNotice.kind === "error" ? "alert" : "status"}
        >
          {radarNotice.message}
        </p>
      ) : null}

      <p aria-live="polite" className="sr-only">
        {radarNotice || preparingFailed
          ? ""
          : preparingLabel
          ? `Preparing radar. ${preparingLabel}.`
          : `${playbackStatus}. ${sampleAnnouncement}`}
      </p>
    </div>
  );
}

interface IconToolButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tooltip: string;
  tooltipSuppressed?: boolean;
}

const IconToolButton = forwardRef<HTMLButtonElement, IconToolButtonProps>(function IconToolButton({
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
      className="context-tool-anchor"
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
          if (!tooltipSuppressed) setTooltipVisible(true);
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
        <span className="context-tooltip" id={tooltipId} role="tooltip">{tooltip}</span>
      ) : null}
    </span>
  );
});

const DISPLAY_MODES: readonly RadarDisplayMode[] = ["smooth", "native"];

function ViewPanel({
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
    const currentIndex = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement));
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % options.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + options.length) % options.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = options.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    options[nextIndex].focus();
  };

  return (
    <div
      aria-label="Radar view"
      className="tool-panel tool-panel--view"
      id={id}
      onKeyDown={moveFocus}
      role="menu"
    >
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
            <span>{radarDisplayModeLabel(mode)}</span>
            {selected ? <CheckIcon /> : null}
          </button>
        );
      })}
    </div>
  );
}

function SourcePanel({
  className,
  currentSite,
  id,
  onSelectNational,
  onSelect,
  paintedSourceKind,
  selectionReady,
  sites,
}: {
  className: string;
  currentSite: string;
  id: string;
  onSelectNational(): void;
  onSelect(site: string): void;
  paintedSourceKind: "site" | "national";
  selectionReady: boolean;
  sites: readonly RadarSiteOption[];
}) {
  const [query, setQuery] = useState("");
  const [sourceView, setSourceView] = useState<"site" | "national">(paintedSourceKind);
  const filteredSites = filterRadarSites(sites, query);

  useEffect(() => setSourceView(paintedSourceKind), [paintedSourceKind]);

  return (
    <aside
      aria-label="Choose radar source"
      className={`tool-panel ${className}`}
      id={id}
      role="dialog"
    >
      <PanelHeader eyebrow="Radar source" supporting="NATIONAL COVERS CONUS" />
      <div aria-label="Radar source" className="source-choices" role="radiogroup">
        <button
          aria-checked={sourceView === "national"}
          disabled={!selectionReady}
          onClick={() => {
            setSourceView("national");
            onSelectNational();
          }}
          role="radio"
          type="button"
        >
          <span><strong>National</strong><small>CONUS MRMS mosaic</small></span>
          {paintedSourceKind === "national" ? <CheckIcon /> : null}
        </button>
        <button
          aria-checked={sourceView === "site"}
          disabled={!selectionReady}
          onClick={() => setSourceView("site")}
          role="radio"
          type="button"
        >
          <span><strong>Site</strong><small>One WSR-88D station</small></span>
          {paintedSourceKind === "site" ? <CheckIcon /> : null}
        </button>
      </div>
      {sourceView === "site" ? <>
      <div className="site-search">
        <SearchIcon />
        <input
          aria-controls={`${id}-site-list`}
          aria-label="Search radar sites"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search ID or place"
          type="search"
          value={query}
        />
      </div>
      <p aria-live="polite" className="sr-only" role="status">
        {filteredSites.length === 0
          ? "No matching radar sites."
          : `${filteredSites.length} radar ${filteredSites.length === 1 ? "site" : "sites"}.`}
      </p>
      <div className="site-list" id={`${id}-site-list`}>
        {filteredSites.map((site) => {
          const current = paintedSourceKind === "site" && site.id === currentSite;
          return (
            <button
              aria-current={current ? "true" : undefined}
              disabled={!selectionReady}
              key={site.id}
              onClick={() => onSelect(site.id)}
              type="button"
            >
              <span><strong>{site.id}</strong><small>{site.name}</small></span>
              {current ? <CheckIcon /> : null}
            </button>
          );
        })}
        {filteredSites.length === 0 ? (
          <p className="site-list__empty">No matching radar sites.</p>
        ) : null}
      </div>
      </> : (
        <p className="source-supporting">
          National displays NOAA&apos;s processed, quality-controlled CONUS reflectivity mosaic.
        </p>
      )}
    </aside>
  );
}

function PanelHeader({ eyebrow, supporting }: { eyebrow: string; supporting: string }) {
  return (
    <header className="panel-header">
      <h2>{eyebrow}</h2>
      <p>{supporting}</p>
    </header>
  );
}

function formatScanTimestamp(unixMs: number | undefined) {
  if (unixMs === undefined) {
    return { date: "---- -- --", time: "--:--:--", zone: "", accessible: "waiting" };
  }
  const date = new Date(unixMs);
  const dateText = [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join("-");
  const timeText = [
    date.getHours().toString().padStart(2, "0"),
    date.getMinutes().toString().padStart(2, "0"),
    date.getSeconds().toString().padStart(2, "0"),
  ].join(":");
  const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value ?? "";
  return {
    date: dateText,
    time: timeText,
    zone,
    accessible: `${dateText} ${timeText} ${zone}`.trim(),
  };
}

function formatSample(interrogation: GateInterrogation | null): string | null {
  if (!interrogation) return null;
  if (interrogation.status !== "valid" || interrogation.value === null) {
    return interrogation.status.replaceAll("_", " ").toUpperCase();
  }
  return `${interrogation.value.toFixed(1)} ${interrogation.units}`;
}

function PlayIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 6 9 6-9 6Z" /></svg>;
}

function PauseIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 7v10M15 7v10" /></svg>;
}

function RecenterIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" /><path d="M12 2v4M22 12h-4M12 22v-4M2 12h4" /></svg>;
}

function RadarSiteIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 21s6-5.7 6-11a6 6 0 1 0-12 0c0 5.3 6 11 6 11Z" />
      <circle cx="12" cy="10" r="2.2" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M2.7 12s3.4-5.5 9.3-5.5 9.3 5.5 9.3 5.5-3.4 5.5-9.3 5.5S2.7 12 2.7 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

function CheckIcon() {
  return <svg aria-hidden="true" className="check-icon" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></svg>;
}

function SearchIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>;
}
