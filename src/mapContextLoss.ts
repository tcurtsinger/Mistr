type ContextLossListener = () => void;

/** The part of a MapLibre map the style release needs. */
export interface ContextLossHost {
  readonly style: unknown;
  getCanvasContainer(): Pick<EventTarget, "addEventListener" | "removeEventListener">;
  on(type: "webglcontextlost", listener: ContextLossListener): unknown;
  off(type: "webglcontextlost", listener: ContextLossListener): unknown;
}

interface RemovableStyle {
  _remove?: (mapRemoved?: boolean) => void;
}

/**
 * MapLibre 6.11 destroys its style when the WebGL context is lost and builds
 * a new one when the context is restored, but `Style.destroy()` never
 * unsubscribes the style from the global RTL text plugin emitter; only
 * `Style._remove()` does. Each lost context therefore kept the old style
 * alive, with its tiles and the tile loads it had in flight: about 2 to 5 MB
 * every time.
 *
 * The style is captured as the event reaches the canvas container, before
 * MapLibre's own canvas listener destroys it, and once MapLibre reports the
 * loss the removal `destroy()` skipped is finished. After `destroy()`,
 * `_remove(false)` only unsubscribes: what else it clears is already empty,
 * and `false` leaves the shared worker pool alone.
 */
export function releaseStylesOnContextLoss(map: ContextLossHost): () => void {
  const container = map.getCanvasContainer();
  let lost: RemovableStyle | null = null;
  const capture = () => {
    lost = (map.style as RemovableStyle | null | undefined) ?? null;
  };
  const release = () => {
    const style = lost;
    lost = null;
    if (style && style !== map.style) style._remove?.(false);
  };
  container.addEventListener("webglcontextlost", capture, { capture: true });
  map.on("webglcontextlost", release);
  return () => {
    container.removeEventListener("webglcontextlost", capture, { capture: true });
    map.off("webglcontextlost", release);
  };
}
