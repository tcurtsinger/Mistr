export type NationalPollingErrorKind = "superseded" | "not_strictly_newer" | "failure";

export interface NationalPollingLoopOptions {
  shouldContinue(): boolean;
  poll(): Promise<void>;
  classifyError(error: unknown): NationalPollingErrorKind;
  onHealthyPoll(): void;
  onFailure(error: unknown, attempt: number): void;
  requestDelayMs(attempt: number): Promise<number>;
  wait(delayMs: number): Promise<void>;
  maximumAttempt?: number;
}

export type NationalPollingLoopResult = "stopped" | "superseded";

/**
 * Polls for strictly newer National observations without letting a transient
 * delay-command failure terminate the session's sole discovery loop.
 */
export async function runNationalPollingLoop(
  options: NationalPollingLoopOptions,
): Promise<NationalPollingLoopResult> {
  const maximumAttempt = options.maximumAttempt ?? 3;
  if (!Number.isSafeInteger(maximumAttempt) || maximumAttempt < 0 || maximumAttempt > 10) {
    throw new RangeError("National polling maximum attempt must be an integer from 0 to 10");
  }

  let attempt = 0;
  while (options.shouldContinue()) {
    try {
      await options.poll();
      attempt = 0;
      options.onHealthyPoll();
    } catch (error) {
      const kind = options.classifyError(error);
      if (kind === "superseded") return "superseded";
      if (kind === "not_strictly_newer") {
        // A successful inventory with no newer object proves that a prior
        // transient provider error has recovered and returns to base cadence.
        attempt = 0;
        options.onHealthyPoll();
      } else {
        attempt = Math.min(attempt + 1, maximumAttempt);
        options.onFailure(error, attempt);
      }
    }

    if (!options.shouldContinue()) break;
    let delayMs: number;
    try {
      delayMs = await options.requestDelayMs(attempt);
    } catch (error) {
      if (!options.shouldContinue()) break;
      if (options.classifyError(error) === "superseded") return "superseded";
      attempt = Math.min(attempt + 1, maximumAttempt);
      options.onFailure(error, attempt);
      delayMs = nationalPollingFallbackDelayMs(attempt);
    }
    await options.wait(delayMs);
  }
  return "stopped";
}

export function nationalPollingFallbackDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new RangeError("National polling fallback attempt must be a non-negative integer");
  }
  return Math.min(120_000, 15_000 * (2 ** Math.min(attempt, 3)));
}
