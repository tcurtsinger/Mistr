import { describe, expect, it } from "vitest";
import { getWorkerUrl } from "maplibre-gl";
import { configureMapLibreWorker } from "./mapWorker";

describe("MapLibre worker packaging", () => {
  it("sets the Vite-emitted module worker URL before map construction", () => {
    const url = configureMapLibreWorker();
    expect(url).toContain("maplibre-gl-worker");
    expect(getWorkerUrl()).toBe(url);
  });
});
