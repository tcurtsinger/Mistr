export interface NationalFinalizeLoopOptions<Result> {
  shouldContinue(): boolean;
  finalize(): Promise<Result>;
  recoverFinalized(): Promise<Result | null>;
  isTerminal(error: unknown): boolean;
  onFailure(error: unknown, retryAttempt: number): void;
  waitBeforeRetry(retryAttempt: number): Promise<void>;
  cancellationError(lastError: unknown): Error;
  maximumRetryDelayLevel?: number;
}

/**
 * Once the renderer is irreversible, the matching Rust journal must be sealed
 * before the acquisition transaction can finish. Retry levels are capped for
 * delay calculation, but the number of attempts is not.
 */
export async function finalizeNationalHistoryUntilSettled<Result>(
  options: NationalFinalizeLoopOptions<Result>,
): Promise<Result> {
  const maximumRetryDelayLevel = options.maximumRetryDelayLevel ?? 6;
  if (!Number.isSafeInteger(maximumRetryDelayLevel) || maximumRetryDelayLevel < 1) {
    throw new RangeError("National finalization retry delay level must be a positive integer");
  }

  let retryAttempt = 0;
  let lastError: unknown = new Error("National history finalization was cancelled");
  while (options.shouldContinue()) {
    try {
      return await options.finalize();
    } catch (error) {
      lastError = error;
      try {
        const recovered = await options.recoverFinalized();
        if (recovered !== null) return recovered;
      } catch {
        // A lost snapshot response is as ambiguous as the finalize response.
        // Keep the exact transaction alive and retry the seal itself.
      }
      if (options.isTerminal(error)) throw error;
      if (!options.shouldContinue()) break;
      retryAttempt = Math.min(retryAttempt + 1, maximumRetryDelayLevel);
      options.onFailure(error, retryAttempt);
      await options.waitBeforeRetry(retryAttempt);
    }
  }
  throw options.cancellationError(lastError);
}
