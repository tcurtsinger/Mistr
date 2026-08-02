import { useCallback, useEffect, useRef, useState } from "react";
import { filterRadarSites, type RadarSiteOption } from "../data/radarSites";
import type { GateInterrogation } from "../radar-renderer/cpuModel";
import {
  timelinePosition,
  type FreshnessPresentation,
  type LiveHistoryStatus,
} from "./radarChromeModel";

export interface RadarChromeProps {
  appVersion: string;
  displayedAtUnixMs?: number;
  dismissPanelsSignal: number;
  frameCount: number;
  frameIndex: number;
  historyCapacity?: number;
  liveHistoryStatus?: LiveHistoryStatus;
  freshness: FreshnessPresentation;
  interrogation: GateInterrogation | null;
  inspectionSelected: boolean;
  mapStatus: string;
  onRecenter(): void;
  onScrub(index: number): void;
  onSelectSite(site: string): void;
  onTogglePlayback(): void;
  playbackLabel: string;
  playbackReady: boolean;
  playing: boolean;
  preparingFailed?: boolean;
  preparingLabel?: string;
  radarNotice?: { kind: "info" | "error"; message: string };
  selectedSite: string;
  siteSelectionReady: boolean;
  sites: readonly RadarSiteOption[];
}

type OpenPanel = "menu" | "context-sites" | "about" | null;

export function RadarChrome({
  appVersion,
  displayedAtUnixMs,
  dismissPanelsSignal,
  frameCount,
  frameIndex,
  historyCapacity,
  liveHistoryStatus,
  freshness,
  interrogation,
  inspectionSelected,
  mapStatus,
  onRecenter,
  onScrub,
  onSelectSite,
  onTogglePlayback,
  playbackLabel,
  playbackReady,
  playing,
  preparingFailed,
  preparingLabel,
  radarNotice,
  selectedSite,
  siteSelectionReady,
  sites,
}: RadarChromeProps) {
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const contextTriggerRef = useRef<HTMLButtonElement>(null);
  const panelOriginRef = useRef<"menu" | "context">("menu");

  const closePanel = useCallback((restoreFocus = true) => {
    const returnTarget = panelOriginRef.current === "context"
      ? contextTriggerRef.current
      : menuTriggerRef.current;
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
      : "mistr-tool-panel";
    const frame = globalThis.requestAnimationFrame(() => {
      document.getElementById(panelId)
        ?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)")
        ?.focus();
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [openPanel]);

  const selectSite = (site: string) => {
    onSelectSite(site);
    closePanel();
  };
  const timestamp = formatScanTimestamp(displayedAtUnixMs);
  const sample = formatSample(interrogation);
  const sampleDisplay = sample
    ?? (inspectionSelected ? "OUTSIDE RADAR COVERAGE" : "CLICK TO INSPECT");
  const sampleAnnouncement = sample
    ?? (inspectionSelected ? "Outside radar coverage." : "No radar point selected.");
  const menuPanelOpen = openPanel === "menu" || openPanel === "about";

  return (
    <div className="radar-chrome">
      <button
        aria-controls="mistr-tool-panel"
        aria-expanded={menuPanelOpen}
        aria-label={menuPanelOpen ? "Close Mistr menu" : "Open Mistr menu"}
        className={`edge-trigger${menuPanelOpen ? " edge-trigger--active" : ""}`}
        onClick={() => {
          if (menuPanelOpen) closePanel();
          else {
            panelOriginRef.current = "menu";
            setOpenPanel("menu");
          }
        }}
        ref={menuTriggerRef}
        type="button"
      >
        <MenuIcon open={menuPanelOpen} />
      </button>

      <nav aria-label="Radar context" className="context-bar">
        <span className="mistr-wordmark" aria-label="Mistr">Mistr</span>
        <span aria-hidden="true" className="instrument-divider" />
        <button
          aria-controls="mistr-context-site-panel"
          aria-expanded={openPanel === "context-sites"}
          className="context-selector"
          disabled={!siteSelectionReady}
          onClick={() => {
            if (openPanel === "context-sites") closePanel();
            else {
              panelOriginRef.current = "context";
              setOpenPanel("context-sites");
            }
          }}
          ref={contextTriggerRef}
          type="button"
        >
          <span className="context-selector__label">SITE</span>
          <strong>{selectedSite}</strong>
          <ChevronIcon />
        </button>
      </nav>

      {openPanel === "context-sites" ? (
        <SitePanel
          className="tool-panel--context"
          currentSite={selectedSite}
          id="mistr-context-site-panel"
          onSelect={selectSite}
          selectionReady={siteSelectionReady}
          sites={sites}
        />
      ) : null}

      {openPanel === "menu" ? (
        <aside aria-label="Mistr menu" className="tool-panel tool-panel--left" id="mistr-tool-panel">
          <PanelHeader eyebrow="Menu" supporting={`${selectedSite} · CURRENT RADAR`} />
          <div className="menu-group">
            <p>MAP</p>
            <button onClick={() => { onRecenter(); closePanel(); }} type="button">
              <RecenterIcon />
              <span><strong>Recenter radar</strong><small>Return to {selectedSite}</small></span>
            </button>
          </div>
          <div className="menu-group">
            <p>APPLICATION</p>
            <button onClick={() => setOpenPanel("about")} type="button">
              <InfoIcon />
              <span><strong>About Mistr</strong><small>Version and data sources</small></span>
              <ChevronIcon direction="right" />
            </button>
          </div>
        </aside>
      ) : null}

      {openPanel === "about" ? (
        <aside aria-label="About Mistr" className="tool-panel tool-panel--left" id="mistr-tool-panel">
          <PanelBack onClick={() => setOpenPanel("menu")} />
          <PanelHeader eyebrow="About Mistr" supporting={`VERSION ${appVersion}`} />
          <div className="about-copy">
            <p>A focused desktop instrument for inspecting measured NEXRAD radar.</p>
            <p>Radar data is provided through public NOAA NEXRAD distribution on AWS Open Data and Unidata infrastructure. No NOAA endorsement is implied.</p>
            <dl>
              <div><dt>MAP</dt><dd>{mapStatus}</dd></div>
              <div><dt>RADAR</dt><dd>BASE REFLECTIVITY · LOWEST TILT</dd></div>
            </dl>
          </div>
        </aside>
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
          aria-label={playing ? "Pause radar loop" : "Play radar loop"}
          className="playback-toggle"
          disabled={!playbackReady || frameCount < 2}
          onClick={onTogglePlayback}
          type="button"
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div className="timeline">
          <input
            aria-label="Displayed radar scan"
            aria-valuetext={`${Math.min(frameIndex + 1, frameCount)} of ${frameCount || 0}, ${timestamp.accessible}`}
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
              historyCapacity,
              liveHistoryStatus,
            )}</span>
            <strong>{playbackLabel}</strong>
          </div>
        </div>
        <span aria-hidden="true" className="instrument-divider" />
        <output className={`freshness freshness--${freshness.kind}`}>
          {freshness.label}
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
          : `${playbackLabel}. Radar ${freshness.kind}. ${sampleAnnouncement}`}
      </p>
    </div>
  );
}

function SitePanel({
  className,
  currentSite,
  id,
  onBack,
  onSelect,
  selectionReady,
  sites,
}: {
  className: string;
  currentSite: string;
  id: string;
  onBack?: () => void;
  onSelect(site: string): void;
  selectionReady: boolean;
  sites: readonly RadarSiteOption[];
}) {
  const [query, setQuery] = useState("");
  const filteredSites = filterRadarSites(sites, query);

  return (
    <aside aria-label="Radar sites" className={`tool-panel ${className}`} id={id}>
      {onBack ? <PanelBack onClick={onBack} /> : null}
      <PanelHeader eyebrow="Radar sites" supporting={`${sites.length} WSR-88D STATIONS`} />
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
          const current = site.id === currentSite;
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

function PanelBack({ onClick }: { onClick(): void }) {
  return (
    <button aria-label="Back to Mistr menu" className="panel-back" onClick={onClick} type="button">
      <ChevronIcon direction="left" />
      BACK
    </button>
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

function MenuIcon({ open }: { open: boolean }) {
  return open ? (
    <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 7h14M5 12h14M5 17h14" /></svg>
  );
}

function ChevronIcon({ direction = "down" }: { direction?: "down" | "left" | "right" }) {
  const path = direction === "left" ? "m14 6-6 6 6 6" : direction === "right" ? "m10 6 6 6-6 6" : "m6 9 6 6 6-6";
  return <svg aria-hidden="true" className="chevron-icon" viewBox="0 0 24 24"><path d={path} /></svg>;
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

function InfoIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></svg>;
}

function CheckIcon() {
  return <svg aria-hidden="true" className="check-icon" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></svg>;
}

function SearchIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>;
}
