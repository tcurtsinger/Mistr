import { describe, expect, it } from "vitest";
import { LatestOnlyAsyncQueue } from "./LatestOnlyAsyncQueue";

describe("LatestOnlyAsyncQueue", () => {
  it("runs one request and replaces pending work with only the newest request", async () => {
    const calls: string[] = [];
    const resolvers: Array<(value: string) => void> = [];
    let active = 0;
    let maxActive = 0;
    const queue = new LatestOnlyAsyncQueue<string, string>((request) => {
      calls.push(request);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        resolvers.push((value) => {
          active -= 1;
          resolve(value);
        });
      });
    });

    const first = queue.enqueue("first");
    const second = queue.enqueue("second");
    const newest = queue.enqueue("newest");

    expect(calls).toEqual(["first"]);
    expect(queue.snapshot()).toMatchObject({ running: true, pending: true });
    await expect(second).resolves.toBeNull();
    resolvers[0]("first-result");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["first", "newest"]);
    expect(maxActive).toBe(1);

    resolvers[1]("newest-result");
    await expect(first).resolves.toBe("first-result");
    await expect(newest).resolves.toBe("newest-result");
    await queue.waitForIdle();
    expect(queue.snapshot()).toEqual({
      running: false,
      pending: false,
      startedCount: 2,
      completedCount: 2,
      failedCount: 0,
      replacedPendingCount: 1,
      maxConcurrentCount: 1,
    });
  });

  it("drops cancelled pending work after the active request completes", async () => {
    let finish!: (value: string) => void;
    const calls: string[] = [];
    const queue = new LatestOnlyAsyncQueue<string, string>((request) => {
      calls.push(request);
      return new Promise((resolve) => { finish = resolve; });
    });

    const running = queue.enqueue("active");
    const stalePending = queue.enqueue("stale-pending");
    queue.cancelPending();
    await expect(stalePending).resolves.toBeNull();
    finish("done");

    await expect(running).resolves.toBe("done");
    await queue.waitForIdle();
    expect(calls).toEqual(["active"]);
    expect(queue.snapshot()).toMatchObject({ running: false, pending: false });
  });

  it("settles every superseded caller without waiting for the active drain", async () => {
    let finishActive!: (value: string) => void;
    const queue = new LatestOnlyAsyncQueue<string, string>(() => (
      new Promise((resolve) => { finishActive = resolve; })
    ));

    const active = queue.enqueue("active");
    const superseded = queue.enqueue("superseded");
    const newest = queue.enqueue("newest");

    await expect(superseded).resolves.toBeNull();
    expect(queue.snapshot()).toMatchObject({ running: true, pending: true });
    queue.cancelPending();
    await expect(newest).resolves.toBeNull();
    finishActive("active-result");
    await expect(active).resolves.toBe("active-result");
    await queue.waitForIdle();
  });

  it("starts a new drain when a request arrives as the prior drain settles", async () => {
    let finishActive!: (value: string) => void;
    const activeResult = new Promise<string>((resolve) => { finishActive = resolve; });
    const calls: string[] = [];
    const queue = new LatestOnlyAsyncQueue<string, string>((request) => {
      calls.push(request);
      return request === "active" ? activeResult : Promise.resolve("late-result");
    });

    const active = queue.enqueue("active");
    const late = activeResult.then(() => queue.enqueue("late")).then((result) => result);
    finishActive("active-result");

    await expect(active).resolves.toBe("active-result");
    await expect(late).resolves.toBe("late-result");
    await queue.waitForIdle();
    expect(calls).toEqual(["active", "late"]);
  });
});
