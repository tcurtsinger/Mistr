import { isSupportedRadarSite } from "../data/radarSites";

export type RadarSourceKey =
  | { readonly kind: "site"; readonly siteIcao: string }
  | { readonly kind: "national"; readonly domain: "conus" };

export type SiteRadarSourceKey = Extract<RadarSourceKey, { readonly kind: "site" }>;

export interface RadarPaintIdentity {
  readonly source: RadarSourceKey;
  readonly generation: number;
  readonly observationId: string;
}

export interface RadarSourceTransition {
  readonly id: number;
  readonly requestedSource: RadarSourceKey;
  readonly generation: number;
  readonly persistOnPaint: boolean;
}

export interface RadarSessionSnapshot {
  readonly generation: number;
  readonly requestedSource?: RadarSourceKey;
  readonly painted?: RadarPaintIdentity;
  readonly transition?: RadarSourceTransition;
  readonly lastFailure?: string;
}

export interface RadarSessionCoordinatorOptions {
  readonly persistPaintedSource?: (source: RadarSourceKey) => void;
}

type SnapshotListener = (snapshot: RadarSessionSnapshot) => void;

/**
 * Owns source intent separately from the source proven by a GPU paint receipt.
 * Data-source sessions do the acquisition and rendering work; this coordinator
 * decides whether their final receipt is still allowed to publish UI truth.
 */
export class RadarSessionCoordinator {
  private readonly listeners = new Set<SnapshotListener>();
  private readonly persistPaintedSource?: (source: RadarSourceKey) => void;
  private generation = 0;
  private transitionSequence = 0;
  private transition: RadarSourceTransition | undefined;
  private painted: RadarPaintIdentity | undefined;
  private lastFailure: string | undefined;

  constructor(options: RadarSessionCoordinatorOptions = {}) {
    this.persistPaintedSource = options.persistPaintedSource;
  }

  beginTransition(
    requestedSource: RadarSourceKey,
    minimumGeneration: number,
    options: { readonly persistOnPaint?: boolean } = {},
  ): RadarSourceTransition {
    assertSourceKey(requestedSource);
    assertGeneration(minimumGeneration);
    this.generation = Math.max(this.generation + 1, minimumGeneration);
    this.transitionSequence += 1;
    this.transition = {
      id: this.transitionSequence,
      requestedSource: cloneSourceKey(requestedSource),
      generation: this.generation,
      persistOnPaint: options.persistOnPaint ?? true,
    };
    this.lastFailure = undefined;
    this.emit();
    return cloneTransition(this.transition);
  }

  acceptPaint(transition: RadarSourceTransition, receipt: RadarPaintIdentity): boolean {
    assertPaintIdentity(receipt);
    if (!this.isCurrent(transition)) return false;
    if (
      receipt.generation !== transition.generation
      || !sameRadarSource(receipt.source, transition.requestedSource)
    ) return false;

    const persistOnPaint = transition.persistOnPaint;
    this.painted = clonePaintIdentity(receipt);
    this.generation = Math.max(this.generation, receipt.generation);
    this.transition = undefined;
    this.lastFailure = undefined;
    this.emit();

    if (persistOnPaint) {
      try {
        this.persistPaintedSource?.(cloneSourceKey(receipt.source));
      } catch {
        // Persistence is an after-paint convenience. Storage failure cannot
        // invalidate an authoritative paint or make radar selection fail.
      }
    }
    return true;
  }

  failTransition(transition: RadarSourceTransition, error: unknown): boolean {
    if (!this.isCurrent(transition)) return false;
    this.transition = undefined;
    this.lastFailure = error instanceof Error ? error.message : String(error);
    this.emit();
    return true;
  }

  cancelPending(minimumGeneration: number): void {
    assertGeneration(minimumGeneration);
    this.generation = Math.max(this.generation, minimumGeneration);
    this.transition = undefined;
    this.lastFailure = undefined;
    this.emit();
  }

  establishPaintedSource(receipt: RadarPaintIdentity): void {
    assertPaintIdentity(receipt);
    this.generation = Math.max(this.generation, receipt.generation);
    this.painted = clonePaintIdentity(receipt);
    this.lastFailure = undefined;
    this.emit();
  }

  synchronizePaint(receipt: RadarPaintIdentity): boolean {
    assertPaintIdentity(receipt);
    if (!this.painted || !sameRadarSource(this.painted.source, receipt.source)) return false;
    if (
      this.transition
      && this.transition.generation === receipt.generation
      && sameRadarSource(this.transition.requestedSource, receipt.source)
    ) {
      // The data-source session must explicitly accept the transition. The
      // renderer snapshot callback cannot bypass supersession or persistence.
      return false;
    }
    if (receipt.generation < this.painted.generation) return false;
    this.generation = Math.max(this.generation, receipt.generation);
    this.painted = clonePaintIdentity(receipt);
    this.emit();
    return true;
  }

  isCurrent(transition: RadarSourceTransition): boolean {
    return this.transition?.id === transition.id
      && this.transition.generation === transition.generation
      && sameRadarSource(this.transition.requestedSource, transition.requestedSource);
  }

  snapshot(): RadarSessionSnapshot {
    return {
      generation: this.generation,
      requestedSource: this.transition
        ? cloneSourceKey(this.transition.requestedSource)
        : undefined,
      painted: this.painted ? clonePaintIdentity(this.painted) : undefined,
      transition: this.transition ? cloneTransition(this.transition) : undefined,
      lastFailure: this.lastFailure,
    };
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function siteRadarSource(siteIcao: string): SiteRadarSourceKey {
  const normalized = siteIcao.trim().toLocaleUpperCase("en-US");
  if (!isSupportedRadarSite(normalized)) {
    throw new Error(`unsupported NEXRAD site ${normalized || "(empty)"}`);
  }
  return { kind: "site", siteIcao: normalized };
}

export function sameRadarSource(left: RadarSourceKey, right: RadarSourceKey): boolean {
  return left.kind === "site" && right.kind === "site"
    ? left.siteIcao === right.siteIcao
    : left.kind === "national" && right.kind === "national"
      ? left.domain === right.domain
      : false;
}

function assertSourceKey(source: RadarSourceKey): void {
  if (source.kind === "site") {
    if (!isSupportedRadarSite(source.siteIcao)) {
      throw new Error(`unsupported NEXRAD site ${source.siteIcao}`);
    }
    return;
  }
  if (source.kind !== "national" || source.domain !== "conus") {
    throw new Error("unsupported radar source");
  }
}

function assertGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("radar source generation must be a positive safe integer");
  }
}

function assertPaintIdentity(receipt: RadarPaintIdentity): void {
  assertSourceKey(receipt.source);
  assertGeneration(receipt.generation);
  if (!receipt.observationId) throw new Error("radar paint identity requires an observation");
}

function cloneSourceKey(source: RadarSourceKey): RadarSourceKey {
  return source.kind === "site"
    ? { kind: "site", siteIcao: source.siteIcao }
    : { kind: "national", domain: source.domain };
}

function clonePaintIdentity(receipt: RadarPaintIdentity): RadarPaintIdentity {
  return {
    source: cloneSourceKey(receipt.source),
    generation: receipt.generation,
    observationId: receipt.observationId,
  };
}

function cloneTransition(transition: RadarSourceTransition): RadarSourceTransition {
  return {
    id: transition.id,
    requestedSource: cloneSourceKey(transition.requestedSource),
    generation: transition.generation,
    persistOnPaint: transition.persistOnPaint,
  };
}
