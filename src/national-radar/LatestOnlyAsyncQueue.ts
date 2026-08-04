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
  private pendingRequest: TRequest | undefined;
  private hasPendingRequest = false;
  private runningPromise: Promise<TResult | null> | null = null;
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
    if (this.hasPendingRequest) this.replacedPendingCount += 1;
    this.pendingRequest = request;
    this.hasPendingRequest = true;
    if (!this.runningPromise) {
      const running = this.drain();
      this.runningPromise = running;
      void running.finally(() => {
        if (this.runningPromise === running) this.runningPromise = null;
      });
    }
    return this.runningPromise;
  }

  cancelPending(): void {
    this.pendingRequest = undefined;
    this.hasPendingRequest = false;
  }

  async waitForIdle(): Promise<void> {
    while (this.runningPromise) await this.runningPromise;
  }

  snapshot(): LatestOnlyAsyncQueueSnapshot {
    return {
      running: this.runningPromise !== null,
      pending: this.hasPendingRequest,
      startedCount: this.startedCount,
      completedCount: this.completedCount,
      failedCount: this.failedCount,
      replacedPendingCount: this.replacedPendingCount,
      maxConcurrentCount: this.maxConcurrentCount,
    };
  }

  private async drain(): Promise<TResult | null> {
    let latestResult: TResult | null = null;
    while (this.hasPendingRequest) {
      const request = this.pendingRequest as TRequest;
      this.pendingRequest = undefined;
      this.hasPendingRequest = false;
      this.startedCount += 1;
      this.concurrentCount += 1;
      this.maxConcurrentCount = Math.max(this.maxConcurrentCount, this.concurrentCount);
      try {
        latestResult = await this.execute(request);
      } catch {
        latestResult = null;
        this.failedCount += 1;
      } finally {
        this.concurrentCount -= 1;
        this.completedCount += 1;
      }
    }
    return latestResult;
  }
}
