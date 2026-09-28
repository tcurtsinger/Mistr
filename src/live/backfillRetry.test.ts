import { describe, expect, it, vi } from "vitest";
import { retryBackfillStep } from "./backfillRetry";

describe("historical fetch retries", () => {
  it("recovers a transient failure and bounds delays", async () => {
    const acquire = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue(undefined);
    const wait = vi.fn(async () => {});
    expect(await retryBackfillStep(acquire, () => true, wait)).toBe(true);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(500);
  });
  it("does not indefinitely retry a missing predecessor", async () => {
    const acquire = vi.fn().mockRejectedValue(new Error("missing"));
    const wait = vi.fn(async () => {});
    expect(await retryBackfillStep(acquire, () => true, wait)).toBe(false);
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[500], [1000]]);
  });
  it("does not issue a retry after the site changes during backoff", async () => {
    let current = true;
    const acquire = vi.fn().mockRejectedValue(new Error("network"));
    expect(await retryBackfillStep(acquire, () => current, async () => { current = false; })).toBe(false);
    expect(acquire).toHaveBeenCalledTimes(1);
  });
});
