export interface FadeOptions {
  durationMs: number;
  /** Returns false once a newer switch owns the layer; the fade then stops. */
  isCurrent?: () => boolean;
  now?: () => number;
  nextFrame?: () => Promise<void>;
}

/**
 * Eases opacity from one value to another across animation frames. Resolves
 * true once the target opacity has had a frame to draw, or false if the fade
 * was superseded part-way.
 */
export async function fadeOpacity(
  apply: (opacity: number) => void,
  from: number,
  to: number,
  options: FadeOptions,
): Promise<boolean> {
  const now = options.now ?? (() => performance.now());
  const nextFrame = options.nextFrame ?? animationFrame;
  const current = options.isCurrent ?? (() => true);
  const started = now();
  apply(from);
  while (true) {
    await nextFrame();
    if (!current()) return false;
    const progress = options.durationMs <= 0
      ? 1
      : Math.min(1, (now() - started) / options.durationMs);
    const eased = progress * progress * (3 - 2 * progress);
    apply(from + (to - from) * eased);
    if (progress >= 1) {
      await nextFrame();
      return current();
    }
  }
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => globalThis.requestAnimationFrame(() => resolve()));
}
