import type { RadarSweepCpuModel } from "../radar-renderer/cpuModel";
import { isSupportedRadarSite } from "../data/radarSites";

export const MAX_LIVE_HISTORY_FRAMES = 20;

export interface LiveHistoryUpdate {
  frames: readonly RadarSweepCpuModel[];
  appended: boolean;
  evictedObservationIds: readonly string[];
}

export interface LiveHistoryPrependUpdate {
  frames: readonly RadarSweepCpuModel[];
  prepended: boolean;
}

export function beginLiveHistory(
  model: RadarSweepCpuModel,
  rendererGeneration: number,
): readonly RadarSweepCpuModel[] {
  assertRendererGeneration(rendererGeneration);
  assertLiveReflectivity(model);
  return [withRendererGeneration(model, rendererGeneration)];
}

export function appendLiveHistory(
  current: readonly RadarSweepCpuModel[],
  incoming: RadarSweepCpuModel,
  limit = MAX_LIVE_HISTORY_FRAMES,
): LiveHistoryUpdate {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIVE_HISTORY_FRAMES) {
    throw new RangeError(`live history limit must be between 1 and ${MAX_LIVE_HISTORY_FRAMES}`);
  }
  if (current.length < 1 || current.length > limit) {
    throw new Error("live history must contain at least one frame and remain within its limit");
  }

  const rendererGeneration = generationNumber(current[0]);
  for (let index = 0; index < current.length; index += 1) {
    const frame = current[index];
    assertLiveReflectivity(frame);
    if (generationNumber(frame) !== rendererGeneration) {
      throw new Error("live history frames must share one renderer generation");
    }
    if (index > 0 && frame.observedAtUnixMs <= current[index - 1].observedAtUnixMs) {
      throw new Error("live history must be strictly chronological");
    }
  }
  assertLiveReflectivity(incoming);
  assertSameRenderKey(current[0], incoming);

  if (current.some((frame) => frame.observationId === incoming.observationId)) {
    return { frames: current, appended: false, evictedObservationIds: [] };
  }
  const newest = current[current.length - 1];
  if (incoming.observedAtUnixMs <= newest.observedAtUnixMs) {
    throw new Error("incoming live observation is not newer than resident history");
  }

  const normalized = withRendererGeneration(incoming, rendererGeneration);
  const combined = [...current, normalized];
  const evicted = combined.slice(0, Math.max(0, combined.length - limit));
  return {
    frames: combined.slice(-limit),
    appended: true,
    evictedObservationIds: evicted.map((frame) => frame.observationId),
  };
}

export function prependLiveHistory(
  current: readonly RadarSweepCpuModel[],
  incoming: RadarSweepCpuModel,
  limit = MAX_LIVE_HISTORY_FRAMES,
): LiveHistoryPrependUpdate {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIVE_HISTORY_FRAMES) {
    throw new RangeError(`live history limit must be between 1 and ${MAX_LIVE_HISTORY_FRAMES}`);
  }
  if (current.length < 1 || current.length > limit) {
    throw new Error("live history must contain at least one frame and remain within its limit");
  }

  const rendererGeneration = generationNumber(current[0]);
  for (let index = 0; index < current.length; index += 1) {
    const frame = current[index];
    assertLiveReflectivity(frame);
    if (generationNumber(frame) !== rendererGeneration) {
      throw new Error("live history frames must share one renderer generation");
    }
    if (index > 0 && frame.observedAtUnixMs <= current[index - 1].observedAtUnixMs) {
      throw new Error("live history must be strictly chronological");
    }
  }
  assertLiveReflectivity(incoming);
  assertSameRenderKey(current[0], incoming);

  if (current.some((frame) => frame.observationId === incoming.observationId)) {
    return { frames: current, prepended: false };
  }
  if (current.length >= limit) {
    throw new Error("live history is already at capacity");
  }
  const oldest = current[0];
  if (incoming.observedAtUnixMs >= oldest.observedAtUnixMs) {
    throw new Error("incoming backfill observation is not older than resident history");
  }

  return {
    frames: [withRendererGeneration(incoming, rendererGeneration), ...current],
    prepended: true,
  };
}

function withRendererGeneration(
  model: RadarSweepCpuModel,
  rendererGeneration: number,
): RadarSweepCpuModel {
  return model.generation === BigInt(rendererGeneration)
    ? model
    : { ...model, generation: BigInt(rendererGeneration) };
}

function assertLiveReflectivity(model: RadarSweepCpuModel): void {
  if (
    model.sourceKind !== "nexrad_level2_chunks"
    || model.product !== "reflectivity"
    || model.units !== "dBZ"
    || !isSupportedRadarSite(model.siteIcao)
  ) {
    throw new Error("live history accepts selected-site Level II reflectivity only");
  }
}

function assertSameRenderKey(
  current: RadarSweepCpuModel,
  incoming: RadarSweepCpuModel,
): void {
  if (
    incoming.siteIcao !== current.siteIcao
    || incoming.product !== current.product
    || incoming.sourceKind !== current.sourceKind
    || incoming.scale !== current.scale
    || incoming.offset !== current.offset
    || incoming.center.longitude !== current.center.longitude
    || incoming.center.latitude !== current.center.latitude
  ) {
    throw new Error("incoming live observation does not match the resident render key");
  }
}

function generationNumber(model: RadarSweepCpuModel): number {
  const generation = Number(model.generation);
  assertRendererGeneration(generation);
  return generation;
}

function assertRendererGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("renderer generation must be a positive safe integer");
  }
}
