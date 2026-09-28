export type NationalBackfillLoopResult = "complete" | "partial" | "superseded";

export interface NationalBackfillLoopOptions<Candidate> {
  shouldContinue(): boolean;
  prepare(): Promise<Candidate | null>;
  commit(candidate: Candidate): Promise<void>;
  reachedLimit(): boolean;
  isSuperseded(error: unknown): boolean;
  onFailure(error: unknown, retryAttempt: number): void;
  waitBeforeRetry(retryAttempt: number): Promise<void>;
  /**
   * Runs between successful backfill steps, so newer observations are not
   * held behind the whole history fill. Only supersession stops the backfill;
   * any other failure is the hook's own to report.
   */
  betweenSteps?(): Promise<void>;
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
      retryAttempt += 1;
      options.onFailure(error, retryAttempt);
      // A permanently unavailable predecessor must not block fresh scans forever.
      // The mutation owner settles/rolls back a failed commit before returning here.
      if (retryAttempt >= maximumRetryAttempt) return "partial";
      try {
        await options.waitBeforeRetry(retryAttempt);
      } catch (waitError) {
        if (!options.shouldContinue() || options.isSuperseded(waitError)) return "superseded";
        throw waitError;
      }
      continue;
    }
    if (!options.betweenSteps || !options.shouldContinue()) continue;
    try {
      await options.betweenSteps();
    } catch (error) {
      if (options.isSuperseded(error)) return "superseded";
    }
    // A newer observation can fill the history before the predecessors do.
    if (options.reachedLimit()) return "complete";
  }
  return "superseded";
}
