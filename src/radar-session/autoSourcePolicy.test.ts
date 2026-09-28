import { describe, expect, it } from "vitest";
import { RADAR_SITES } from "../data/radarSites";
import { decideAutoSource, sameAutoSource } from "./autoSourcePolicy";

const KTLX = { longitude: -97.2778, latitude: 35.3331 };
const OKC_METRO = { longitude: -97.52, latitude: 35.47 };
const GULF = { longitude: -89.5, latitude: 25.0 };
const national = { kind: "national" } as const;
const ktlx = { kind: "site", siteIcao: "KTLX" } as const;

describe("decideAutoSource", () => {
  it("keeps National at regional zooms and preloads the nearest Site near the threshold", () => {
    expect(decideAutoSource({ zoom: 6, center: OKC_METRO, visible: national }, RADAR_SITES))
      .toEqual({ target: national });
    expect(decideAutoSource({ zoom: 8.2, center: OKC_METRO, visible: national }, RADAR_SITES))
      .toEqual({ target: national, preload: "KTLX" });
  });

  it("switches to the nearest covering Site once zoomed in", () => {
    expect(decideAutoSource({ zoom: 9, center: OKC_METRO, visible: national }, RADAR_SITES))
      .toEqual({ target: ktlx });
  });

  it("stays on National over areas no Site covers", () => {
    expect(decideAutoSource({ zoom: 11, center: GULF, visible: national }, RADAR_SITES))
      .toEqual({ target: national });
  });

  it("holds a displayed Site between the exit and enter zooms", () => {
    expect(decideAutoSource({ zoom: 8.7, center: KTLX, visible: ktlx }, RADAR_SITES))
      .toEqual({ target: ktlx });
    expect(decideAutoSource({ zoom: 8.4, center: KTLX, visible: ktlx }, RADAR_SITES))
      .toEqual({ target: national });
  });

  it("returns to National when the view leaves the displayed Site's coverage", () => {
    // Amarillo is ~380 km from KTLX; its own radar is the better one.
    const amarillo = { longitude: -101.83, latitude: 35.22 };
    expect(decideAutoSource({ zoom: 10, center: amarillo, visible: ktlx }, RADAR_SITES))
      .toEqual({ target: national });
    expect(decideAutoSource({ zoom: 10, center: amarillo, visible: national }, RADAR_SITES).target)
      .toEqual({ kind: "site", siteIcao: "KAMA" });
  });

  it("prefers the picked Site over a nearer one while inside its coverage", () => {
    // Between KTLX and Vance AFB (KVNX); KVNX is nearer here.
    const between = { longitude: -97.9, latitude: 36.3 };
    expect(decideAutoSource({ zoom: 10, center: between, visible: national }, RADAR_SITES).target)
      .toEqual({ kind: "site", siteIcao: "KVNX" });
    expect(decideAutoSource(
      { zoom: 10, center: between, visible: national, preferredSite: "KTLX" },
      RADAR_SITES,
    ).target).toEqual(ktlx);
  });

  it("compares sources by kind and site", () => {
    expect(sameAutoSource(national, { kind: "national" })).toBe(true);
    expect(sameAutoSource(ktlx, { kind: "site", siteIcao: "KTLX" })).toBe(true);
    expect(sameAutoSource(ktlx, { kind: "site", siteIcao: "KINX" })).toBe(false);
    expect(sameAutoSource(ktlx, national)).toBe(false);
  });
});
