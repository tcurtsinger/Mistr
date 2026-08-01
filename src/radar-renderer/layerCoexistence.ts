export interface StyleLayerDescriptor {
  id: string;
  type: string;
}

export interface DiagnosticLayerIds {
  range: string;
  radar: string;
  anchor: string;
}

export interface LayerCoexistenceReport {
  rangeLayerPresent: boolean;
  radarLayerPresent: boolean;
  anchorLayerPresent: boolean;
  expectedInsertionOrder: string[];
  actualDiagnosticOrder: string[];
  standardLayerBeforeId: string | null;
  standardLayerAfterId: string | null;
  standardLayersBeforeAndAfter: boolean;
}

export function evaluateLayerCoexistence(
  layers: readonly StyleLayerDescriptor[],
  ids: DiagnosticLayerIds,
): LayerCoexistenceReport {
  const expectedInsertionOrder = [ids.range, ids.radar, ids.anchor];
  const diagnosticIds = new Set(expectedInsertionOrder);
  const actualDiagnosticOrder = layers
    .filter((layer) => diagnosticIds.has(layer.id))
    .map((layer) => layer.id);
  const rangeLayerPresent = layers.some(
    (layer) => layer.id === ids.range && layer.type === "line",
  );
  const radarLayerPresent = layers.some(
    (layer) => layer.id === ids.radar && layer.type === "custom",
  );
  const anchorLayerPresent = layers.some(
    (layer) => layer.id === ids.anchor && layer.type === "circle",
  );
  const radarIndex = layers.findIndex((layer) => layer.id === ids.radar);
  const standardLayerBeforeId = radarIndex < 0
    ? null
    : [...layers.slice(0, radarIndex)]
      .reverse()
      .find((layer) => !diagnosticIds.has(layer.id))?.id ?? null;
  const standardLayerAfterId = radarIndex < 0
    ? null
    : layers.slice(radarIndex + 1)
      .find((layer) => !diagnosticIds.has(layer.id))?.id ?? null;
  const diagnosticOrderMatches = actualDiagnosticOrder.length === expectedInsertionOrder.length
    && actualDiagnosticOrder.every((id, index) => id === expectedInsertionOrder[index]);
  return {
    rangeLayerPresent,
    radarLayerPresent,
    anchorLayerPresent,
    expectedInsertionOrder,
    actualDiagnosticOrder,
    standardLayerBeforeId,
    standardLayerAfterId,
    standardLayersBeforeAndAfter:
      rangeLayerPresent
      && radarLayerPresent
      && anchorLayerPresent
      && diagnosticOrderMatches
      && standardLayerBeforeId !== null
      && standardLayerAfterId !== null,
  };
}
