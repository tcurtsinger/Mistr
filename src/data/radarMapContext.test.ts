import { describe, expect, it } from "vitest";
import {
  RADAR_CONTEXT_ANCHOR_LAYER_ID,
  radarContextAnchorLayerId,
} from "./radarMapContext";

describe("radar map context anchor", () => {
  it("places radar before the explicit quiet-context boundary even when labels occur earlier", () => {
    expect(radarContextAnchorLayerId([
      { id: "background", type: "background" },
      { id: "local-labels", type: "symbol" },
      { id: RADAR_CONTEXT_ANCHOR_LAYER_ID, type: "line" },
      { id: "major-cities", type: "symbol" },
    ])).toBe(RADAR_CONTEXT_ANCHOR_LAYER_ID);
  });

  it("falls back to the first symbol for a compatible external style", () => {
    expect(radarContextAnchorLayerId([
      { id: "land", type: "fill" },
      { id: "labels", type: "symbol" },
    ])).toBe("labels");
  });

  it("returns undefined when no safe insertion anchor exists", () => {
    expect(radarContextAnchorLayerId([{ id: "land", type: "fill" }])).toBeUndefined();
  });
});
