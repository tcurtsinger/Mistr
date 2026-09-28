import { describe, expect, it } from "vitest";
import { RADAR_SITES } from "../data/radarSites";
import { decideAutoSource, nationalCovers, sameAutoSource } from "./autoSourcePolicy";

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

  it("hops a displayed Site to National when a nearby Site is picked", () => {
    // KVNX is ~110 km from KTLX, well inside KTLX's own keep range.
    const kvnx = { longitude: -98.1281, latitude: 36.7408 };
    expect(decideAutoSource({ zoom: 9.5, center: kvnx, visible: ktlx }, RADAR_SITES))
      .toEqual({ target: ktlx });
    expect(decideAutoSource(
      { zoom: 9.5, center: kvnx, visible: ktlx, preferredSite: "KVNX" },
      RADAR_SITES,
    )).toEqual({ target: national });
    expect(decideAutoSource(
      { zoom: 9.5, center: kvnx, visible: national, preferredSite: "KVNX" },
      RADAR_SITES,
    )).toEqual({ target: { kind: "site", siteIcao: "KVNX" } });
    // Below the enter zoom the displayed Site holds rather than dropping to National.
    expect(decideAutoSource(
      { zoom: 8.7, center: kvnx, visible: ktlx, preferredSite: "KVNX" },
      RADAR_SITES,
    )).toEqual({ target: ktlx });
  });

  it("marks the pick spent once the view leaves its coverage", () => {
    const amarillo = { longitude: -101.83, latitude: 35.22 };
    expect(decideAutoSource(
      { zoom: 10, center: amarillo, visible: ktlx, preferredSite: "KTLX" },
      RADAR_SITES,
    )).toEqual({ target: national, preferenceSpent: true });
    expect(decideAutoSource(
      { zoom: 10, center: KTLX, visible: ktlx, preferredSite: "KTLX" },
      RADAR_SITES,
    )).toEqual({ target: ktlx });
  });

  it("keeps and enters Sites at regional zooms where National has no grid", () => {
    for (const id of ["PAHG", "PHKI", "PGUA", "TJUA"]) {
      const site = RADAR_SITES.find((candidate) => candidate.id === id)!;
      const center = { longitude: site.longitude, latitude: site.latitude };
      const shown = { kind: "site", siteIcao: id } as const;
      expect(nationalCovers(center)).toBe(false);
      expect(decideAutoSource({ zoom: 8.4, center, visible: shown }, RADAR_SITES).target).toEqual(shown);
      expect(decideAutoSource({ zoom: 5.6, center, visible: shown }, RADAR_SITES).target).toEqual(shown);
      expect(decideAutoSource({ zoom: 5.4, center, visible: shown }, RADAR_SITES).target).toEqual(national);
      expect(decideAutoSource({ zoom: 6.2, center, visible: national }, RADAR_SITES).target).toEqual(shown);
      expect(decideAutoSource({ zoom: 5.7, center, visible: national }, RADAR_SITES))
        .toEqual({ target: national, preload: id });
    }
    // Inside the grid the regular zooms still apply.
    expect(nationalCovers(KTLX)).toBe(true);
    expect(decideAutoSource({ zoom: 8.4, center: KTLX, visible: ktlx }, RADAR_SITES).target).toEqual(national);
  });

  it("compares sources by kind and site", () => {
    expect(sameAutoSource(national, { kind: "national" })).toBe(true);
    expect(sameAutoSource(ktlx, { kind: "site", siteIcao: "KTLX" })).toBe(true);
    expect(sameAutoSource(ktlx, { kind: "site", siteIcao: "KINX" })).toBe(false);
    expect(sameAutoSource(ktlx, national)).toBe(false);
  });
});
