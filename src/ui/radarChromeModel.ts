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

export type RadarProduct = "reflectivity" | "storm_relative_velocity";

export interface RendererStatusLike {
  status: string;
  error?: string;
}

export type LiveDisplayKind = "idle" | "acquiring" | "painted" | "degraded";

const SITE_PATTERN = /^K[A-Z0-9]{3}$/;

export function normalizeRadarSite(value: string | null | undefined, fallback = "KTLX"): string {
  const normalized = value?.trim().toUpperCase() ?? "";
  return SITE_PATTERN.test(normalized) ? normalized : fallback;
}

export function radarProductLabel(product: RadarProduct): string {
  return product === "storm_relative_velocity" ? "STORM-RELATIVE VELOCITY" : "REFLECTIVITY";
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

export function playbackInteractionReady(displayKind: LiveDisplayKind): boolean {
  return displayKind !== "acquiring";
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
  if (playback?.holdReason === "AWAITING_GPU_PAINT") return "PAINTING";
  if (playback?.playing) return "PLAYING";
  if (frameCount > 0 && frameIndex === frameCount - 1) return "PAUSED · NEWEST";
  return "PAUSED";
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
