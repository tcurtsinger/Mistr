import { describe, expect, it } from "vitest";
import { evaluateLayerCoexistence } from "./layerCoexistence";

const IDS = {
  range: "range",
  radar: "radar",
  anchor: "anchor",
};

describe("actual MapLibre layer coexistence", () => {
  it("passes only when the real style order has standard layers on both sides", () => {
    const report = evaluateLayerCoexistence([
      { id: "background", type: "background" },
      { id: "roads", type: "line" },
      { id: "range", type: "line" },
      { id: "radar", type: "custom" },
      { id: "anchor", type: "circle" },
      { id: "labels", type: "symbol" },
    ], IDS);
    expect(report).toMatchObject({
      actualDiagnosticOrder: ["range", "radar", "anchor"],
      standardLayerBeforeId: "roads",
      standardLayerAfterId: "labels",
      standardLayersBeforeAndAfter: true,
    });
  });

  it("fails when diagnostics are merely appended after every standard layer", () => {
    const report = evaluateLayerCoexistence([
      { id: "background", type: "background" },
      { id: "range", type: "line" },
      { id: "radar", type: "custom" },
      { id: "anchor", type: "circle" },
    ], IDS);
    expect(report.standardLayerAfterId).toBeNull();
    expect(report.standardLayersBeforeAndAfter).toBe(false);
  });
});
