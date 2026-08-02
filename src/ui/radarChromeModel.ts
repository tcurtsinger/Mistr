import { isSupportedRadarSite } from "../data/radarSites";

export interface TimelineFrame {
  observationId: string;
  observedAtUnixMs: number;
}

export interface PlaybackLike {
  playing: boolean;
  selectedObservationId?: string;
  lastPaintedObservationId?: string;
  holdReason?: string;
}

export type FreshnessKind = "fresh" | "stale" | "archive" | "updating" | "error" | "waiting";

export interface FreshnessPresentation {
  kind: FreshnessKind;
  label: string;
}

export interface RendererStatusLike {
  status: string;
  error?: string;
}

export function normalizeRadarSite(value: string | null | undefined, fallback = "KTLX"): string {
  const normalized = value?.trim().toUpperCase() ?? "";
  return isSupportedRadarSite(normalized) ? normalized : fallback;
}

export function rendererFailureMessage(renderer: RendererStatusLike | undefined): string | null {
  if (renderer?.status !== "error") return null;
  return renderer.error ?? "Radar renderer failed";
}

export function playbackErrorAfterRendererStatus(
  current: string | null,
  status: RendererStatusLike["status"],
): string | null {
  return status === "painted" ? null : current;
}

export function paintedFrameIndex(
  frames: readonly TimelineFrame[],
  playback: PlaybackLike | undefined,
): number {
  if (frames.length === 0) return 0;
  const paintedId = playback?.lastPaintedObservationId ?? playback?.selectedObservationId;
  const index = paintedId
    ? frames.findIndex((frame) => frame.observationId === paintedId)
    : -1;
  return index >= 0 ? index : frames.length - 1;
}

export function playbackPresentation(
  playback: PlaybackLike | undefined,
  frameIndex: number,
  frameCount: number,
): string {
  if (playback?.holdReason?.startsWith("GPU_RECOVERY")) return "RECOVERING";
  if (playback?.playing) return "PLAYING";
  if (playback?.holdReason === "AWAITING_GPU_PAINT") return "LOADING SCAN";
  if (frameCount > 0 && frameIndex === frameCount - 1) return "PAUSED · NEWEST";
  return "PAUSED";
}

export function radarInitializationLabel(stage: string | undefined): string {
  const progress = stage?.match(/^DECODING OBSERVATION (\d+)\/(\d+)$/);
  if (progress) return `LOADING HISTORY ${progress[1]}/${progress[2]}`;
  if (stage === "OPENING RESIDENT LOOP") return "OPENING RADAR HISTORY";
  return "READYING DISPLAY";
}

export function timelinePosition(
  frameIndex: number,
  frameCount: number,
  historyCapacity?: number,
): string {
  const position = frameCount > 0 ? `${Math.min(frameIndex + 1, frameCount)} / ${frameCount}` : "0 / 0";
  if (
    historyCapacity === undefined
    || frameCount < 1
    || frameCount >= historyCapacity
  ) return position;
  return `${position} · BUILDING ${frameCount}/${historyCapacity}`;
}

export function freshnessPresentation(
  source: "live" | "archive" | "archive_frame" | "updating" | "error" | "waiting",
  observedAtUnixMs: number | undefined,
  nowUnixMs: number,
): FreshnessPresentation {
  if (source === "archive") return { kind: "archive", label: "ARCHIVE LOOP" };
  if (source === "archive_frame") return { kind: "archive", label: "ARCHIVE FRAME" };
  if (source === "updating") return { kind: "updating", label: "UPDATING LIVE" };
  if (source === "error") return { kind: "error", label: "RADAR ERROR" };
  if (source === "waiting" || observedAtUnixMs === undefined) {
    return { kind: "waiting", label: "WAITING FOR RADAR" };
  }

  const ageMs = Math.max(0, nowUnixMs - observedAtUnixMs);
  const ageSeconds = Math.floor(ageMs / 1_000);
  if (ageSeconds < 600) {
    return { kind: "fresh", label: `FRESH · ${formatAge(ageSeconds)}` };
  }
  return { kind: "stale", label: `STALE · ${formatAge(ageSeconds)}` };
}

export function liveFailureLabel(site: string, retrying: boolean): string {
  if (!isSupportedRadarSite(site)) {
    throw new Error("failure label requires a supported NEXRAD site");
  }
  return retrying ? `RETRYING ${site}` : `${site} UNAVAILABLE`;
}

export function userFacingRadarError(
  area: "initialization" | "map" | "renderer" | "playback" | "live_unavailable" | "live_retrying",
  site?: string,
): string {
  if (area === "initialization") return "Mistr could not prepare radar. Restart Mistr to try again.";
  if (area === "map") return "Mistr could not prepare the map. Check your connection and restart Mistr.";
  if (area === "renderer") return "Mistr could not paint radar. Restart Mistr to restore the radar display.";
  if (area === "playback") return "Mistr could not change scans. The last completed scan remains displayed.";
  if (!site || !isSupportedRadarSite(site)) {
    throw new Error("live error copy requires a supported NEXRAD site");
  }
  if (area === "live_retrying") {
    return `${site} update failed. The last completed scan remains displayed while Mistr retries.`;
  }
  return `${site} radar is unavailable. The last completed scan remains displayed; choose the site again to retry.`;
}

export function formatAge(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  if (safeSeconds < 3_600) {
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  if (safeSeconds < 86_400) {
    const hours = Math.floor(safeSeconds / 3_600);
    const minutes = Math.floor((safeSeconds % 3_600) / 60);
    return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  }
  return `${Math.floor(safeSeconds / 86_400)}d`;
}
