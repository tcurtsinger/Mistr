import type { NationalHistoryObservation } from "../packed-sweep/transferClient";
import type { NationalPlaybackQualityFactor } from "../playback/NationalPlaybackController";
import {
  NATIONAL_GPU_TARGET_BYTES,
  type NationalGridLayer,
} from "./NationalGridLayer";
import {
  type NationalDetailPresentationFactor,
  type NationalHistoryWorkingSetController,
  observationId,
} from "./NationalHistoryWorkingSetController";
import type { GeographicBounds } from "./coverage";

export const NATIONAL_SHARP_PLAYBACK_MIN_ZOOM = 6;

type PlaybackQualityWorkingSet = Pick<
  NationalHistoryWorkingSetController,
  "prefetchDetail"
>;

type PlaybackQualityLayer = Pick<
  NationalGridLayer,
  | "finestCompletePlaybackFactor"
  | "projectedUniformDetailGpuBytes"
  | "pruneDetailResidency"
>;

export interface NationalPlaybackQualityPreparationOptions {
  zoom: number;
  observations: readonly NationalHistoryObservation[];
  selectedObservationId: string;
  bounds: GeographicBounds;
  workingSet: PlaybackQualityWorkingSet;
  layer: PlaybackQualityLayer;
  ownershipCheck(): void;
  gpuTargetBytes?: number;
}

export interface NationalPlaybackQualityPreparationResult {
  factor: NationalPlaybackQualityFactor;
  projectedGpuBytes: number;
  detailedObservationCount: number;
}

export function nationalPlaybackDetailCandidates(
  zoom: number,
): readonly NationalDetailPresentationFactor[] {
  if (!Number.isFinite(zoom)) throw new RangeError("National playback zoom must be finite");
  return zoom >= NATIONAL_SHARP_PLAYBACK_MIN_ZOOM ? [1, 2] : [];
}

/**
 * Prepare sharp playback detail beside a running loop. Every staging is a
 * prefetch: nothing here selects, paints, or otherwise changes the visible
 * observation — the caller applies the returned factor through the playback
 * quality lock, and the next frame selection paints it with a receipt.
 *
 * Below the sharp-zoom threshold no detail is staged and existing residency
 * is left untouched, so a complete-domain refined presentation survives a
 * home-view playback session intact.
 */
export async function prepareNationalPlaybackQuality(
  options: NationalPlaybackQualityPreparationOptions,
): Promise<NationalPlaybackQualityPreparationResult> {
  const {
    observations,
    selectedObservationId,
    bounds,
    workingSet,
    layer,
    ownershipCheck,
    gpuTargetBytes = NATIONAL_GPU_TARGET_BYTES,
  } = options;
  if (!Number.isSafeInteger(gpuTargetBytes) || gpuTargetBytes < 1) {
    throw new RangeError("National playback GPU target must be a positive safe integer");
  }
  const timelineIds = observations.map(observationId);
  const selected = observations.find(
    (observation) => observationId(observation) === selectedObservationId,
  );
  if (!selected || timelineIds.length < 1) {
    throw new Error("National playback quality requires the selected retained observation");
  }
  const candidates = nationalPlaybackDetailCandidates(options.zoom);
  if (candidates.length < 1) {
    ownershipCheck();
    return { factor: 4, projectedGpuBytes: 0, detailedObservationCount: 0 };
  }

  try {
    for (const factor of candidates) {
      ownershipCheck();
      await workingSet.prefetchDetail(
        selected,
        bounds,
        timelineIds,
        ownershipCheck,
        factor,
      );
      ownershipCheck();
      layer.pruneDetailResidency([selectedObservationId]);
      const projectedGpuBytes = layer.projectedUniformDetailGpuBytes(
        selectedObservationId,
        factor,
      );
      if (projectedGpuBytes > gpuTargetBytes) {
        layer.pruneDetailResidency([]);
        continue;
      }
      for (const observation of observations) {
        if (observationId(observation) === selectedObservationId) continue;
        ownershipCheck();
        await workingSet.prefetchDetail(
          observation,
          bounds,
          timelineIds,
          ownershipCheck,
          factor,
        );
      }
      ownershipCheck();
      if (layer.finestCompletePlaybackFactor() !== factor) {
        throw new Error(
          `National factor-${factor} playback detail is not complete for every observation`,
        );
      }
      return {
        factor,
        projectedGpuBytes,
        detailedObservationCount: observations.length,
      };
    }
    return { factor: 4, projectedGpuBytes: 0, detailedObservationCount: 0 };
  } catch (error) {
    try {
      layer.pruneDetailResidency([]);
    } catch {
      // Preserve the preparation error; residency pruning is best-effort here.
    }
    throw error;
  }
}
