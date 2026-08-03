export const RADAR_CONTEXT_ANCHOR_LAYER_ID = "highway_major_context_casing";

export interface RadarMapStyleLayer {
  id: string;
  type: string;
}

export function radarContextAnchorLayerId(
  layers: readonly RadarMapStyleLayer[],
): string | undefined {
  if (layers.some((layer) => layer.id === RADAR_CONTEXT_ANCHOR_LAYER_ID)) {
    return RADAR_CONTEXT_ANCHOR_LAYER_ID;
  }
  return layers.find((layer) => layer.type === "symbol")?.id;
}
