import { describe, expect, it, vi } from "vitest";
import { runNationalBackfillLoop } from "./NationalBackfillLoop";

describe("runNationalBackfillLoop", () => {
  it("returns partial after repeated failure so the caller can start live polling", async () => {
    const prepare = vi.fn(async () => { throw new Error("unavailable"); });
    const waitBeforeRetry = vi.fn(async () => {});
    expect(await runNationalBackfillLoop({
      shouldContinue: () => true, prepare, commit: async () => {},
      reachedLimit: () => false, isSuperseded: () => false,
      onFailure: () => {}, waitBeforeRetry,
    })).toBe("partial");
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(waitBeforeRetry).toHaveBeenCalledTimes(2);
  });
  it("retries an unconsumed predecessor and resets bounded backoff after success", async () => {
    const firstFailure = new Error("temporary predecessor download failure");
    const secondFailure = new Error("temporary predecessor upload failure");
    const preparations: Array<Error | string | null> = [
      firstFailure,
      "older-a",
      "older-b",
      "older-b",
      null,
    ];
    const committed: string[] = [];
    const failed: unknown[] = [];
    const retryAttempts: number[] = [];
    let failedSecondCommit = false;

    const result = await runNationalBackfillLoop({
      shouldContinue: () => true,
      async prepare() {
        const next = preparations.shift();
        if (next instanceof Error) throw next;
        return next ?? null;
      },
      async commit(candidate) {
        if (candidate === "older-b" && !failedSecondCommit) {
          failedSecondCommit = true;
          throw secondFailure;
        }
        committed.push(candidate);
      },
      reachedLimit: () => false,
      isSuperseded: () => false,
      onFailure(error) {
        failed.push(error);
      },
      async waitBeforeRetry(attempt) {
        retryAttempts.push(attempt);
      },
    });

    expect(result).toBe("complete");
    expect(committed).toEqual(["older-a", "older-b"]);
    expect(failed).toEqual([firstFailure, secondFailure]);
    expect(retryAttempts).toEqual([1, 1]);
  });

  it("checks for newer observations between successful steps without stopping the backfill", async () => {
    const preparations = ["older-a", "older-b", null];
    const events: string[] = [];
    let checks = 0;
    const result = await runNationalBackfillLoop({
      shouldContinue: () => true,
      prepare: async () => preparations.shift() ?? null,
      commit: async (candidate) => { events.push(candidate); },
      reachedLimit: () => false,
      isSuperseded: () => false,
      onFailure: () => {},
      waitBeforeRetry: async () => {},
      async betweenSteps() {
        checks += 1;
        events.push(`check-${checks}`);
        if (checks === 1) throw new Error("newer inventory unavailable");
      },
    });
    expect(result).toBe("complete");
    expect(events).toEqual(["older-a", "check-1", "older-b", "check-2"]);
  });

  it("finishes when a newer observation fills the history, and stops on supersession", async () => {
    let retained = 58;
    const filled = await runNationalBackfillLoop({
      shouldContinue: () => true,
      prepare: async () => "older",
      commit: async () => { retained += 1; },
      reachedLimit: () => retained >= 60,
      isSuperseded: () => false,
      onFailure: () => {},
      waitBeforeRetry: async () => {},
      betweenSteps: async () => { retained += 1; },
    });
    expect(filled).toBe("complete");
    expect(retained).toBe(60);

    const superseded = new Error("superseded");
    const stopped = await runNationalBackfillLoop({
      shouldContinue: () => true,
      prepare: async () => "older",
      commit: async () => {},
      reachedLimit: () => false,
      isSuperseded: (error) => error === superseded,
      onFailure: () => {},
      waitBeforeRetry: async () => {},
      betweenSteps: async () => { throw superseded; },
    });
    expect(stopped).toBe("superseded");
  });

  it("stops without delay when ownership is superseded", async () => {
    const superseded = new Error("superseded");
    const waitBeforeRetry = vi.fn<() => Promise<void>>();

    const result = await runNationalBackfillLoop({
      shouldContinue: () => true,
      prepare: async () => {
        throw superseded;
      },
      commit: async () => {},
      reachedLimit: () => false,
      isSuperseded: (error) => error === superseded,
      onFailure: () => {},
      waitBeforeRetry,
    });

    expect(result).toBe("superseded");
    expect(waitBeforeRetry).not.toHaveBeenCalled();
  });
});
