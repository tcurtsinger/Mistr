import {
  RadarSessionCoordinator,
  type RadarPaintIdentity,
} from "./RadarSessionCoordinator";
import { RadarSourceSupersededError } from "./SiteLevel2Session";

const NATIONAL_SOURCE = { kind: "national", domain: "conus" } as const;

export interface NationalMrmsPaintResult<T> {
  value: T;
  paint: RadarPaintIdentity;
}

export type NationalTransitionMode = "acquire" | "reveal";

export interface NationalMrmsSessionOptions<T> {
  coordinator: RadarSessionCoordinator;
  nextGeneration(): number;
  /** Generation of a still-resident National history that can be revealed without reacquiring it. */
  residentGeneration?(): number | undefined;
  acquireAndPaint(generation: number, mode: NationalTransitionMode): Promise<NationalMrmsPaintResult<T>>;
  onPaintAccepted?(value: T, paint: RadarPaintIdentity): void;
  onTransitionFailed?(error: unknown, generation: number): void;
}

export class NationalMrmsSession<T> {
  constructor(private readonly options: NationalMrmsSessionOptions<T>) {}

  async start(): Promise<T> {
    const residentGeneration = this.options.residentGeneration?.();
    const mode: NationalTransitionMode = residentGeneration === undefined ? "acquire" : "reveal";
    const transition = this.options.coordinator.beginTransition(
      NATIONAL_SOURCE,
      this.options.nextGeneration(),
      { residentGeneration },
    );
    try {
      const result = await this.options.acquireAndPaint(transition.generation, mode);
      if (!this.options.coordinator.acceptPaint(transition, result.paint)) {
        throw new RadarSourceSupersededError(
          `National transition ${transition.id} was superseded before paint acceptance`,
        );
      }
      this.options.onPaintAccepted?.(result.value, result.paint);
      return result.value;
    } catch (error) {
      const wasCurrent = this.options.coordinator.isCurrent(transition);
      this.options.coordinator.failTransition(transition, error);
      if (wasCurrent) {
        this.options.onTransitionFailed?.(error, transition.generation);
      }
      if (!wasCurrent && !(error instanceof RadarSourceSupersededError)) {
        throw new RadarSourceSupersededError(
          `National transition ${transition.id} was superseded before completion`,
        );
      }
      throw error;
    }
  }
}
