export type NationalBackfillLoopResult = "complete" | "superseded";

export interface NationalBackfillLoopOptions<Candidate> {
  shouldContinue(): boolean;
  prepare(): Promise<Candidate | null>;
  commit(candidate: Candidate): Promise<void>;
  reachedLimit(): boolean;
  isSuperseded(error: unknown): boolean;
  onFailure(error: unknown, retryAttempt: number): void;
  waitBeforeRetry(retryAttempt: number): Promise<void>;
  maximumRetryAttempt?: number;
}

/**
 * Keeps an unconsumed predecessor eligible after a transient failure. The
 * caller owns the actual bounded delay so the same approved backend timing
 * policy can be shared with newer-observation polling.
 */
export async function runNationalBackfillLoop<Candidate>(
  options: NationalBackfillLoopOptions<Candidate>,
): Promise<NationalBackfillLoopResult> {
  const maximumRetryAttempt = options.maximumRetryAttempt ?? 3;
  if (!Number.isSafeInteger(maximumRetryAttempt) || maximumRetryAttempt < 1) {
    throw new RangeError("National backfill retry limit must be a positive integer");
  }

  let retryAttempt = 0;
  while (options.shouldContinue()) {
    try {
      const candidate = await options.prepare();
      if (candidate === null) return "complete";
      await options.commit(candidate);
      retryAttempt = 0;
      if (options.reachedLimit()) return "complete";
    } catch (error) {
      if (options.isSuperseded(error)) return "superseded";
      retryAttempt = Math.min(retryAttempt + 1, maximumRetryAttempt);
      options.onFailure(error, retryAttempt);
      try {
        await options.waitBeforeRetry(retryAttempt);
      } catch (waitError) {
        if (!options.shouldContinue() || options.isSuperseded(waitError)) return "superseded";
        throw waitError;
      }
    }
  }
  return "superseded";
}
