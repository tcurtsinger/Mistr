import { describe, expect, it } from "vitest";
import { updateMapReadiness } from "./mapReadiness";

describe("updateMapReadiness", () => {
  it("reports an initial load failure", () => {
    expect(updateMapReadiness("INITIALIZING", "error")).toBe(
      "BASEMAP UNAVAILABLE",
    );
  });

  it("recovers when the style subsequently loads", () => {
    expect(updateMapReadiness("BASEMAP UNAVAILABLE", "load")).toBe(
      "BASEMAP READY",
    );
  });

  it("does not let a transient resource error overwrite readiness", () => {
    expect(updateMapReadiness("BASEMAP READY", "error")).toBe(
      "BASEMAP READY",
    );
  });
});
