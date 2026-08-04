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

export interface NationalMrmsSessionOptions<T> {
  coordinator: RadarSessionCoordinator;
  nextGeneration(): number;
  acquireAndPaint(generation: number): Promise<NationalMrmsPaintResult<T>>;
  onPaintAccepted?(value: T, paint: RadarPaintIdentity): void;
}

export class NationalMrmsSession<T> {
  constructor(private readonly options: NationalMrmsSessionOptions<T>) {}

  async start(): Promise<T> {
    const transition = this.options.coordinator.beginTransition(
      NATIONAL_SOURCE,
      this.options.nextGeneration(),
    );
    try {
      const result = await this.options.acquireAndPaint(transition.generation);
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
      if (!wasCurrent && !(error instanceof RadarSourceSupersededError)) {
        throw new RadarSourceSupersededError(
          `National transition ${transition.id} was superseded before completion`,
        );
      }
      throw error;
    }
  }
}
