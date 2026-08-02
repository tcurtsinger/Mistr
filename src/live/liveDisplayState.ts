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
  | (LiveDisplayBase & {
    kind: "refreshing";
    requestedSite: string;
    freshOnly: true;
    live: PaintedFrameTruth;
  })
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

export function beginLiveRefresh(
  state: LiveDisplayState,
  generation: number,
  requestedSite: string,
): LiveDisplayState {
  if (!Number.isSafeInteger(generation) || generation <= state.generation) {
    throw new Error("live display generation must advance monotonically");
  }
  const live = state.lastComplete;
  if (!live || live.source !== "nexrad_level2_chunks" || live.site !== requestedSite) {
    throw new Error("background refresh requires painted live truth for the requested site");
  }
  return {
    kind: "refreshing",
    generation,
    requestedSite,
    freshOnly: true,
    live,
    lastComplete: live,
    fallback: fallbackFor(live),
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
  if (
    (state.kind !== "acquiring" && state.kind !== "refreshing")
    || generation !== state.generation
  ) return state;
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
  if (
    (state.kind !== "acquiring" && state.kind !== "refreshing")
    || generation !== state.generation
  ) return state;
  return {
    kind: "degraded",
    generation,
    requestedSite: state.requestedSite,
    message,
    lastComplete: state.lastComplete,
    fallback: fallbackFor(state.lastComplete),
  };
}

export function retainPaintedFallback(
  state: LiveDisplayState,
  frame: PaintedFrameTruth,
): LiveDisplayState {
  if (sameFrameTruth(state.lastComplete, frame)) return state;
  if (
    (state.kind === "painted" || state.kind === "refreshing")
    && frame.source === "nexrad_level2_chunks"
    && frame.site === state.requestedSite
  ) {
    return {
      ...state,
      live: frame,
      lastComplete: frame,
      fallback: fallbackFor(frame),
    };
  }
  return {
    ...state,
    lastComplete: frame,
    fallback: fallbackFor(frame),
  };
}

function sameFrameTruth(
  left: PaintedFrameTruth | undefined,
  right: PaintedFrameTruth,
): boolean {
  return left?.observationId === right.observationId
    && left.site === right.site
    && left.source === right.source
    && left.observedAtUnixMs === right.observedAtUnixMs
    && left.paintedAtUnixMs === right.paintedAtUnixMs;
}

function fallbackFor(lastComplete?: PaintedFrameTruth): LiveFallbackPolicy {
  return {
    retainLastComplete: true,
    retainedSource: lastComplete?.source ?? "none",
    nextFallback: "nexrad_level2_archive",
    terminalFallback: "provider_tiles",
  };
}
