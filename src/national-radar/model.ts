import type { PackedGridManifest } from "../packed-grid/packedGrid";

export interface NationalObservationIdentity {
  generation: number;
  observationId: string;
  observationTimeUnixMs: number;
  contentSha256: string;
  objectKey: string;
}

export function nationalObservationIdentity(
  manifest: PackedGridManifest,
): NationalObservationIdentity {
  const generation = Number(manifest.generation);
  const observationTimeUnixMs = Number(manifest.observationTimeUnixMs);
  if (
    !Number.isSafeInteger(generation)
    || generation < 1
    || !Number.isSafeInteger(observationTimeUnixMs)
    || observationTimeUnixMs < 1
  ) {
    throw new Error("National manifest identity exceeds frontend integer bounds");
  }
  return {
    generation,
    observationId: `${observationTimeUnixMs}:${manifest.contentSha256}`,
    observationTimeUnixMs,
    contentSha256: manifest.contentSha256,
    objectKey: manifest.objectKey,
  };
}
