import { isSupportedRadarSite } from "../data/radarSites";
import type { RadarDisplayMode } from "../radar-renderer/RadarCustomLayer";

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

export type FrameAgeKind = "current" | "historical";

export interface FrameAgePresentation {
  accessibleLabel: string;
  kind: FrameAgeKind;
  label: string;
}

export interface RendererStatusLike {
  status: string;
  error?: string;
}

export type LiveHistoryStatus = "loading" | "partial" | "full";

export function normalizeRadarDisplayMode(value: string | null | undefined): RadarDisplayMode {
  return value === "native" ? "native" : "smooth";
}

export function radarDisplayModeLabel(mode: RadarDisplayMode): "Smooth" | "Native" {
  return mode === "smooth" ? "Smooth" : "Native";
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
  liveHistoryStatus?: LiveHistoryStatus,
): string {
  if (playback?.holdReason?.startsWith("GPU_RECOVERY")) return "RECOVERING";
  if (playback?.holdReason === "PREPARING_PLAYBACK_QUALITY") return "PREPARING PLAYBACK";
  if (playback?.playing) return "PLAYING";
  if (playback?.holdReason === "AWAITING_GPU_PAINT") return "LOADING SCAN";
  if (frameCount === 1 && liveHistoryStatus === "loading") return "LOADING RECENT";
  if (frameCount === 1 && liveHistoryStatus) return "WAITING FOR NEXT SCAN";
  if (frameCount > 0 && frameIndex === frameCount - 1) return "PAUSED · NEWEST";
  return "PAUSED";
}

export function radarInitializationLabel(stage: string | undefined): string {
  if (stage === "LOADING NEWEST SAFE SCAN") return "LOADING SAFE RADAR";
  const progress = stage?.match(/^DECODING OBSERVATION (\d+)\/(\d+)$/);
  if (progress) return `LOADING HISTORY ${progress[1]}/${progress[2]}`;
  if (stage === "OPENING RESIDENT LOOP") return "OPENING RADAR HISTORY";
  return "READYING DISPLAY";
}

export function timelinePosition(
  frameIndex: number,
  frameCount: number,
  historyCapacity?: number,
  liveHistoryStatus?: LiveHistoryStatus,
): string {
  const position = frameCount > 0 ? `${Math.min(frameIndex + 1, frameCount)} / ${frameCount}` : "0 / 0";
  if (
    historyCapacity === undefined
    || frameCount < 1
    || frameCount >= historyCapacity
    || liveHistoryStatus === undefined
    || liveHistoryStatus === "full"
  ) return position;
  const historyLabel = liveHistoryStatus === "loading" ? "LOADING RECENT" : "RECENT";
  return `${position} · ${historyLabel} ${frameCount}/${historyCapacity}`;
}

export function frameAgePresentation(
  observedAtUnixMs: number | undefined,
  nowUnixMs: number,
  latestLiveScan: boolean,
  newestLabel = "Latest live scan",
): FrameAgePresentation {
  if (observedAtUnixMs === undefined) {
    return {
      accessibleLabel: "Displayed scan age unavailable.",
      kind: "historical",
      label: "--:--",
    };
  }

  const ageMs = Math.max(0, nowUnixMs - observedAtUnixMs);
  const ageSeconds = Math.floor(ageMs / 1_000);
  const latestDescription = latestLiveScan ? newestLabel : "Historical scan";
  return {
    accessibleLabel: `${latestDescription}, observed ${formatAccessibleAge(ageSeconds)} ago.`,
    kind: latestLiveScan && ageSeconds < 600 ? "current" : "historical",
    label: formatAge(ageSeconds),
  };
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

export function formatAccessibleAge(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  if (safeSeconds < 60) return `${safeSeconds} ${safeSeconds === 1 ? "second" : "seconds"}`;
  if (safeSeconds < 3_600) {
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return [
      `${minutes} ${minutes === 1 ? "minute" : "minutes"}`,
      seconds > 0 ? `${seconds} ${seconds === 1 ? "second" : "seconds"}` : null,
    ].filter(Boolean).join(" ");
  }
  if (safeSeconds < 86_400) {
    const hours = Math.floor(safeSeconds / 3_600);
    const minutes = Math.floor((safeSeconds % 3_600) / 60);
    return [
      `${hours} ${hours === 1 ? "hour" : "hours"}`,
      minutes > 0 ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}` : null,
    ].filter(Boolean).join(" ");
  }
  const days = Math.floor(safeSeconds / 86_400);
  return `${days} ${days === 1 ? "day" : "days"}`;
}
