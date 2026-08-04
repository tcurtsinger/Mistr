export interface LatestOnlyAsyncQueueSnapshot {
  running: boolean;
  pending: boolean;
  startedCount: number;
  completedCount: number;
  failedCount: number;
  replacedPendingCount: number;
  maxConcurrentCount: number;
}

/**
 * Runs at most one expensive operation and retains only the newest request
 * that arrives while it is active. This bounds work without pretending the
 * already-running native operation can be cancelled.
 */
export class LatestOnlyAsyncQueue<TRequest, TResult> {
  private pending: PendingRequest<TRequest, TResult> | null = null;
  private runningPromise: Promise<void> | null = null;
  private startedCount = 0;
  private completedCount = 0;
  private failedCount = 0;
  private replacedPendingCount = 0;
  private concurrentCount = 0;
  private maxConcurrentCount = 0;

  constructor(
    private readonly execute: (request: TRequest) => Promise<TResult>,
  ) {}

  enqueue(request: TRequest): Promise<TResult | null> {
    const result = new Promise<TResult | null>((resolve) => {
      if (this.pending) {
        this.replacedPendingCount += 1;
        this.pending.resolve(null);
      }
      this.pending = { request, resolve };
    });
    this.startDrain();
    return result;
  }

  cancelPending(): void {
    this.pending?.resolve(null);
    this.pending = null;
  }

  async waitForIdle(): Promise<void> {
    while (this.runningPromise) await this.runningPromise;
  }

  snapshot(): LatestOnlyAsyncQueueSnapshot {
    return {
      running: this.runningPromise !== null,
      pending: this.pending !== null,
      startedCount: this.startedCount,
      completedCount: this.completedCount,
      failedCount: this.failedCount,
      replacedPendingCount: this.replacedPendingCount,
      maxConcurrentCount: this.maxConcurrentCount,
    };
  }

  private startDrain() {
    if (this.runningPromise || !this.pending) return;
    const running = this.drain();
    this.runningPromise = running;
    void running.finally(() => {
      if (this.runningPromise !== running) return;
      this.runningPromise = null;
      this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const pending = this.pending;
      this.pending = null;
      this.startedCount += 1;
      this.concurrentCount += 1;
      this.maxConcurrentCount = Math.max(this.maxConcurrentCount, this.concurrentCount);
      try {
        pending.resolve(await this.execute(pending.request));
      } catch {
        pending.resolve(null);
        this.failedCount += 1;
      } finally {
        this.concurrentCount -= 1;
        this.completedCount += 1;
      }
    }
  }
}

interface PendingRequest<TRequest, TResult> {
  request: TRequest;
  resolve(result: TResult | null): void;
}
