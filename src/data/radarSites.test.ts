import { describe, expect, it } from "vitest";
import { filterRadarSites, isSupportedRadarSite, RADAR_SITES } from "./radarSites";

describe("operational radar site catalog", () => {
  it("contains the 155 provider-qualified WSR-88D sites exactly once", () => {
    expect(RADAR_SITES).toHaveLength(155);
    expect(new Set(RADAR_SITES.map((site) => site.id)).size).toBe(RADAR_SITES.length);
    expect(RADAR_SITES.map((site) => site.id)).toEqual(
      [...RADAR_SITES.map((site) => site.id)].sort(),
    );
  });

  it("includes non-CONUS identifiers and excludes the unavailable KOUN test site", () => {
    expect(isSupportedRadarSite("KTLX")).toBe(true);
    expect(isSupportedRadarSite("PABC")).toBe(true);
    expect(isSupportedRadarSite("PGUA")).toBe(true);
    expect(isSupportedRadarSite("TJUA")).toBe(true);
    expect(isSupportedRadarSite("KOUN")).toBe(false);
  });

  it("filters by station identifier or place without changing the source catalog", () => {
    expect(filterRadarSites(RADAR_SITES, "tlx").map((site) => site.id)).toEqual(["KTLX"]);
    expect(filterRadarSites(RADAR_SITES, "guam").map((site) => site.id)).toEqual(["PGUA"]);
    expect(filterRadarSites(RADAR_SITES, "")).toBe(RADAR_SITES);
  });
});
