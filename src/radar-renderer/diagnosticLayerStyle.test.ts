import { describe, expect, it } from "vitest";
import { HIDDEN_DIAGNOSTIC_LAYOUT } from "./diagnosticLayerStyle";

describe("diagnostic map layers", () => {
  it("keeps engineering alignment geometry hidden in the product map", () => {
    expect(HIDDEN_DIAGNOSTIC_LAYOUT).toEqual({ visibility: "none" });
  });
});
