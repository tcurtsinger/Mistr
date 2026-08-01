import { setWorkerUrl } from "maplibre-gl";
import mapLibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

/**
 * MapLibre 6 loads an adjacent ESM worker. Once Vite bundles the main module,
 * that adjacency no longer exists, so make Vite emit the worker and give
 * MapLibre its explicit public URL before the first Map is constructed.
 */
export function configureMapLibreWorker(): string {
  setWorkerUrl(mapLibreWorkerUrl);
  return mapLibreWorkerUrl;
}
