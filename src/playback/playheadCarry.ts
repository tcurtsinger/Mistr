/** Where the outgoing source's playback stood when the view switched sources. */
export interface CarriedPlayhead {
  readonly observedAtUnixMs: number;
  readonly playing: boolean;
  readonly atNewest: boolean;
}

export type PlayheadCarryStep =
  | { readonly kind: "done" }
  | { readonly kind: "wait" }
  | { readonly kind: "apply"; readonly index: number; readonly play: boolean };

/**
 * Index of the frame nearest a time, in ascending frame times. Ties go to the
 * older frame; times outside the history clamp to its ends. -1 when empty.
 */
export function nearestFrameIndex(times: readonly number[], targetUnixMs: number): number {
  if (times.length === 0) return -1;
  let low = 0;
  let high = times.length - 1;
  if (targetUnixMs <= times[low]) return low;
  if (targetUnixMs >= times[high]) return high;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (times[middle] <= targetUnixMs) low = middle;
    else high = middle;
  }
  return targetUnixMs - times[low] <= times[high] - targetUnixMs ? low : high;
}

/**
 * Decides how an incoming source adopts the outgoing playhead as its history
 * loads. Paused on the newest frame stays on the newest. A running loop keeps
 * running from the nearest frame once there are two frames to play. A paused
 * older frame waits until history reaches back to it (or stops loading), then
 * jumps there once.
 */
export function planPlayheadCarry(
  carry: CarriedPlayhead,
  times: readonly number[],
  historyComplete: boolean,
): PlayheadCarryStep {
  if (!carry.playing && carry.atNewest) return { kind: "done" };
  const minimumFrames = carry.playing ? 2 : 1;
  if (times.length < minimumFrames) return historyComplete ? { kind: "done" } : { kind: "wait" };
  if (!carry.playing && times[0] > carry.observedAtUnixMs && !historyComplete) {
    return { kind: "wait" };
  }
  return {
    kind: "apply",
    index: nearestFrameIndex(times, carry.observedAtUnixMs),
    play: carry.playing,
  };
}
