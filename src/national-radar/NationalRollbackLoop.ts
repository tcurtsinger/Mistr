import type {
  NationalHistoryObservation,
  NationalHistorySnapshot,
} from "../packed-sweep/transferClient";

export interface NationalRollbackLoopOptions<Result> {
  shouldContinue(): boolean;
  rollback(): Promise<Result>;
  recoverRolledBack(): Promise<Result | null>;
  isTerminal(error: unknown): boolean;
  onFailure(error: unknown, retryDelayLevel: number): void;
  waitBeforeRetry(retryDelayLevel: number): Promise<void>;
  cancellationError(lastError: unknown): Error;
  maximumRetryDelayLevel?: number;
}

/**
 * A renderer rollback makes publication impossible, so its matching Rust
 * mutation must also resolve. Retry delay is capped; retry count is not.
 */
export async function rollbackNationalHistoryUntilSettled<Result>(
  options: NationalRollbackLoopOptions<Result>,
): Promise<Result> {
  const maximumRetryDelayLevel = options.maximumRetryDelayLevel ?? 6;
  if (!Number.isSafeInteger(maximumRetryDelayLevel) || maximumRetryDelayLevel < 1) {
    throw new RangeError("National rollback retry delay level must be a positive integer");
  }

  let retryDelayLevel = 0;
  let lastError: unknown = new Error("National history rollback was cancelled");
  while (options.shouldContinue()) {
    try {
      return await options.rollback();
    } catch (error) {
      lastError = error;
      try {
        const recovered = await options.recoverRolledBack();
        if (recovered !== null) return recovered;
      } catch {
        // A lost snapshot response cannot prove that the mutation is gone.
        // Keep retrying the exact identity-bound rollback.
      }
      if (options.isTerminal(error)) throw error;
      if (!options.shouldContinue()) break;
      retryDelayLevel = Math.min(retryDelayLevel + 1, maximumRetryDelayLevel);
      options.onFailure(error, retryDelayLevel);
      await options.waitBeforeRetry(retryDelayLevel);
    }
  }
  throw options.cancellationError(lastError);
}

export function snapshotProvesNationalHistoryRollback(
  snapshot: NationalHistorySnapshot,
  observation: NationalHistoryObservation,
): boolean {
  return snapshot.generation === observation.generation
    && snapshot.staged === null
    && snapshot.stagedBackendBytes === 0
    && !snapshot.mutationReversible
    && snapshot.reversibleCommitBytes === 0
    && !snapshot.retained.some((retained) => (
      retained.generation === observation.generation
      && retained.observationTimeUnixMs === observation.observationTimeUnixMs
      && retained.contentSha256 === observation.contentSha256
      && retained.objectKey === observation.objectKey
    ));
}
