export type MapReadiness =
  | "INITIALIZING"
  | "BASEMAP READY"
  | "BASEMAP UNAVAILABLE";

export type MapReadinessEvent = "load" | "error";

export function updateMapReadiness(
  current: MapReadiness,
  event: MapReadinessEvent,
): MapReadiness {
  if (event === "load") {
    return "BASEMAP READY";
  }

  // A failed tile or glyph request after initial load must not claim that the
  // whole basemap is unavailable. Ongoing resource health belongs in separate
  // telemetry when that diagnostic surface is introduced.
  return current === "BASEMAP READY" ? current : "BASEMAP UNAVAILABLE";
}
