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
