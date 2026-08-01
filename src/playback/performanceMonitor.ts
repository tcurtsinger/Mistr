export interface FrameTimingSummary {
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maximumMs: number;
  longTaskCount: number;
  longestTaskMs: number;
  longTaskObserverAvailable: boolean;
}

export class FramePerformanceMonitor {
  private frameHandle: number | null = null;
  private priorFrameAt: number | null = null;
  private frameDurations: number[] = [];
  private longTasks: number[] = [];
  private observer: PerformanceObserver | null = null;
  private longTaskObserverAvailable = false;

  start(): void {
    if (this.frameHandle !== null) return;
    this.frameDurations = [];
    this.longTasks = [];
    this.priorFrameAt = null;
    const sample = (at: number) => {
      if (this.priorFrameAt !== null) this.frameDurations.push(at - this.priorFrameAt);
      this.priorFrameAt = at;
      this.frameHandle = globalThis.requestAnimationFrame(sample);
    };
    this.frameHandle = globalThis.requestAnimationFrame(sample);
    this.longTaskObserverAvailable = typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes.includes("longtask");
    if (this.longTaskObserverAvailable) {
      try {
        this.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) this.longTasks.push(entry.duration);
        });
        this.observer.observe({ entryTypes: ["longtask"] });
      } catch {
        this.observer = null;
        this.longTaskObserverAvailable = false;
      }
    }
  }

  stop(): FrameTimingSummary {
    if (this.frameHandle !== null) globalThis.cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
    if (this.observer) {
      for (const entry of this.observer.takeRecords()) this.longTasks.push(entry.duration);
    }
    this.observer?.disconnect();
    this.observer = null;
    return summarizeFramePerformance(
      this.frameDurations,
      this.longTasks,
      this.longTaskObserverAvailable,
    );
  }
}

export function summarizeFramePerformance(
  frameDurations: readonly number[],
  longTasks: readonly number[],
  longTaskObserverAvailable = true,
): FrameTimingSummary {
  return {
    sampleCount: frameDurations.length,
    p50Ms: percentile(frameDurations, 0.5),
    p95Ms: percentile(frameDurations, 0.95),
    p99Ms: percentile(frameDurations, 0.99),
    maximumMs: frameDurations.length > 0 ? Math.max(...frameDurations) : 0,
    longTaskCount: longTasks.filter((duration) => duration >= 50).length,
    longestTaskMs: longTasks.length > 0 ? Math.max(...longTasks) : 0,
    longTaskObserverAvailable,
  };
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
}
