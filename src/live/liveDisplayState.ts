export type RadarFrameSource = "nexrad_level2_archive_ii" | "nexrad_level2_chunks";

export interface PaintedFrameTruth {
  observationId: string;
  site: string;
  source: RadarFrameSource;
  observedAtUnixMs: number;
  paintedAtUnixMs: number;
}

export interface LiveFallbackPolicy {
  retainLastComplete: true;
  retainedSource: RadarFrameSource | "none";
  nextFallback: "nexrad_level2_archive";
  terminalFallback: "provider_tiles";
}

interface LiveDisplayBase {
  generation: number;
  lastComplete?: PaintedFrameTruth;
  fallback: LiveFallbackPolicy;
}

export type LiveDisplayState =
  | (LiveDisplayBase & { kind: "idle" })
  | (LiveDisplayBase & { kind: "acquiring"; requestedSite: string; freshOnly: boolean })
  | (LiveDisplayBase & { kind: "painted"; requestedSite: string; live: PaintedFrameTruth })
  | (LiveDisplayBase & { kind: "degraded"; requestedSite: string; message: string });

export function initialLiveDisplay(lastComplete?: PaintedFrameTruth): LiveDisplayState {
  return {
    kind: "idle",
    generation: 0,
    lastComplete,
    fallback: fallbackFor(lastComplete),
  };
}

export function beginLiveDisplay(
  state: LiveDisplayState,
  generation: number,
  requestedSite: string,
  freshOnly: boolean,
): LiveDisplayState {
  if (!Number.isSafeInteger(generation) || generation <= state.generation) {
    throw new Error("live display generation must advance monotonically");
  }
  return {
    kind: "acquiring",
    generation,
    requestedSite,
    freshOnly,
    lastComplete: state.lastComplete,
    fallback: fallbackFor(state.lastComplete),
  };
}

export function publishLiveDisplay(
  state: LiveDisplayState,
  generation: number,
  frame: PaintedFrameTruth,
): LiveDisplayState {
  if (state.kind !== "acquiring" || generation !== state.generation) return state;
  if (frame.site !== state.requestedSite || frame.source !== "nexrad_level2_chunks") {
    throw new Error("live publication does not match the active site/source");
  }
  return {
    kind: "painted",
    generation,
    requestedSite: state.requestedSite,
    live: frame,
    lastComplete: frame,
    fallback: fallbackFor(frame),
  };
}

export function failLiveDisplay(
  state: LiveDisplayState,
  generation: number,
  message: string,
): LiveDisplayState {
  if (state.kind !== "acquiring" || generation !== state.generation) return state;
  return {
    kind: "degraded",
    generation,
    requestedSite: state.requestedSite,
    message,
    lastComplete: state.lastComplete,
    fallback: fallbackFor(state.lastComplete),
  };
}

function fallbackFor(lastComplete?: PaintedFrameTruth): LiveFallbackPolicy {
  return {
    retainLastComplete: true,
    retainedSource: lastComplete?.source ?? "none",
    nextFallback: "nexrad_level2_archive",
    terminalFallback: "provider_tiles",
  };
}
