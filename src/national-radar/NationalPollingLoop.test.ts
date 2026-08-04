import { describe, expect, it, vi } from "vitest";
import { runNationalPollingLoop } from "./NationalPollingLoop";

describe("runNationalPollingLoop", () => {
  it("clears a transient request error when a healthy inventory has no newer frame", async () => {
    const transient = new Error("provider unavailable");
    const noNewer = new Error("no strictly newer observation");
    let polls = 0;
    let keepRunning = true;
    const delays: number[] = [];
    const healthy = vi.fn();
    const failures: Array<{ error: unknown; attempt: number }> = [];

    await runNationalPollingLoop({
      shouldContinue: () => keepRunning,
      async poll() {
        polls += 1;
        if (polls === 1) throw transient;
        if (polls === 2) throw noNewer;
        keepRunning = false;
      },
      classifyError: (error) => (
        error === noNewer ? "not_strictly_newer" : "failure"
      ),
      onHealthyPoll: healthy,
      onFailure: (error, attempt) => failures.push({ error, attempt }),
      async requestDelayMs(attempt) {
        delays.push(attempt);
        return 1;
      },
      wait: async () => {},
    });

    expect(polls).toBe(3);
    expect(failures).toEqual([{ error: transient, attempt: 1 }]);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1, 0]);
  });

  it("uses bounded local backoff and keeps polling after the delay command fails", async () => {
    const delayFailure = new Error("local IPC unavailable");
    const noNewer = new Error("no strictly newer observation");
    let polls = 0;
    let keepRunning = true;
    const waited: number[] = [];
    const failures: Array<{ error: unknown; attempt: number }> = [];

    await runNationalPollingLoop({
      shouldContinue: () => keepRunning,
      async poll() {
        polls += 1;
        if (polls === 1) throw noNewer;
        keepRunning = false;
      },
      classifyError: (error) => (
        error === noNewer ? "not_strictly_newer" : "failure"
      ),
      onHealthyPoll: () => {},
      onFailure: (error, attempt) => failures.push({ error, attempt }),
      requestDelayMs: async () => {
        throw delayFailure;
      },
      wait: async (delayMs) => {
        waited.push(delayMs);
      },
    });

    expect(polls).toBe(2);
    expect(failures).toEqual([{ error: delayFailure, attempt: 1 }]);
    expect(waited).toEqual([30_000]);
  });
});
