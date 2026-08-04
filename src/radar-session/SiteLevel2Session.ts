import {
  RadarSessionCoordinator,
  siteRadarSource,
  type RadarPaintIdentity,
} from "./RadarSessionCoordinator";

export interface SiteLevel2PaintResult<T> {
  readonly value: T;
  readonly paint: RadarPaintIdentity;
}

export interface SiteLevel2SessionOptions<T> {
  readonly coordinator: RadarSessionCoordinator;
  readonly nextGeneration: () => number;
  readonly acquireAndPaint: SiteLevel2AcquireAndPaint<T>;
  readonly onPaintAccepted?: (value: T, paint: RadarPaintIdentity) => void;
}

export type SiteLevel2AcquireAndPaint<T> = (
  siteIcao: string,
  generation: number,
) => Promise<SiteLevel2PaintResult<T>>;

export interface SiteLevel2StartOptions {
  readonly persistOnPaint?: boolean;
}

/**
 * Selected-site adapter for the shared source coordinator. It intentionally
 * delegates Level II acquisition, history, decoding, and rendering to the
 * already-qualified engine and only owns the source-transition boundary.
 */
export class SiteLevel2Session<T> {
  private readonly coordinator: RadarSessionCoordinator;
  private readonly nextGeneration: () => number;
  private readonly acquireAndPaint: SiteLevel2SessionOptions<T>["acquireAndPaint"];
  private readonly onPaintAccepted?: SiteLevel2SessionOptions<T>["onPaintAccepted"];

  constructor(options: SiteLevel2SessionOptions<T>) {
    this.coordinator = options.coordinator;
    this.nextGeneration = options.nextGeneration;
    this.acquireAndPaint = options.acquireAndPaint;
    this.onPaintAccepted = options.onPaintAccepted;
  }

  async start(siteIcao: string, options: SiteLevel2StartOptions = {}): Promise<T> {
    return this.runTransition(siteIcao, this.acquireAndPaint, options);
  }

  async startWith(
    siteIcao: string,
    acquireAndPaint: SiteLevel2AcquireAndPaint<T>,
    options: SiteLevel2StartOptions = {},
  ): Promise<T> {
    return this.runTransition(siteIcao, acquireAndPaint, options);
  }

  private async runTransition(
    siteIcao: string,
    acquireAndPaint: SiteLevel2AcquireAndPaint<T>,
    options: SiteLevel2StartOptions,
  ): Promise<T> {
    const source = siteRadarSource(siteIcao);
    const transition = this.coordinator.beginTransition(
      source,
      this.nextGeneration(),
      { persistOnPaint: options.persistOnPaint },
    );
    try {
      const result = await acquireAndPaint(source.siteIcao, transition.generation);
      if (!this.coordinator.acceptPaint(transition, result.paint)) {
        throw new RadarSourceSupersededError(
          `site transition ${transition.id} was superseded before paint acceptance`,
        );
      }
      this.onPaintAccepted?.(result.value, result.paint);
      return result.value;
    } catch (error) {
      const wasCurrent = this.coordinator.isCurrent(transition);
      this.coordinator.failTransition(transition, error);
      if (!wasCurrent && !(error instanceof RadarSourceSupersededError)) {
        throw markSuperseded(error, transition.id);
      }
      throw error;
    }
  }
}

export class RadarSourceSupersededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RadarSourceSupersededError";
  }
}

const supersededErrors = new WeakSet<object>();

export function isRadarSourceSuperseded(error: unknown): boolean {
  return error instanceof RadarSourceSupersededError
    || (typeof error === "object" && error !== null && supersededErrors.has(error));
}

function markSuperseded(error: unknown, transitionId: number): unknown {
  if (typeof error === "object" && error !== null) {
    supersededErrors.add(error);
    return error;
  }
  return new RadarSourceSupersededError(
    `site transition ${transitionId} was superseded before completion (${String(error)})`,
  );
}
