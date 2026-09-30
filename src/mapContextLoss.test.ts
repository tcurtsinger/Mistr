import { describe, expect, it } from "vitest";
import { Style } from "maplibre-gl";
import { type ContextLossHost, releaseStylesOnContextLoss } from "./mapContextLoss";

type Listener = () => void;

// A map whose context loss runs as MapLibre's does: the event reaches the
// canvas container first, then MapLibre destroys the style, drops it, and
// fires its own `webglcontextlost`.
function fakeMap() {
  const container = new EventTarget();
  const listeners = new Set<Listener>();
  const calls: string[] = [];
  const style = {
    destroy: () => calls.push("destroy"),
    _remove: (mapRemoved?: boolean) => calls.push(`_remove(${mapRemoved})`),
  };
  const map = {
    style: style as unknown,
    getCanvasContainer: () => container,
    on: (_type: string, listener: Listener) => listeners.add(listener),
    off: (_type: string, listener: Listener) => listeners.delete(listener),
    loseContext() {
      container.dispatchEvent(new Event("webglcontextlost"));
      (map.style as typeof style | null)?.destroy();
      map.style = null;
      for (const listener of listeners) listener();
    },
  } satisfies ContextLossHost & { loseContext(): void };
  return { map, calls, listeners };
}

describe("releaseStylesOnContextLoss", () => {
  it("finishes removing the style MapLibre destroys on a lost context", () => {
    const { map, calls } = fakeMap();
    releaseStylesOnContextLoss(map);
    map.loseContext();
    expect(calls).toEqual(["destroy", "_remove(false)"]);
    // A later loss with no style has nothing to release.
    map.loseContext();
    expect(calls).toEqual(["destroy", "_remove(false)"]);
  });

  it("stops listening once disposed", () => {
    const { map, calls, listeners } = fakeMap();
    releaseStylesOnContextLoss(map)();
    map.loseContext();
    expect(calls).toEqual(["destroy"]);
    expect(listeners.size).toBe(0);
  });

  it("relies on a MapLibre style removal that still exists", () => {
    // If an upgrade renames it, the release silently does nothing; fail here
    // instead, and check whether `Style.destroy()` now unsubscribes itself.
    expect(typeof (Style.prototype as unknown as { _remove?: unknown })._remove).toBe("function");
  });
});
