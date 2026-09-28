import catalog from "./radar-sites.json";

/**
 * Operational WSR-88D sites exposed by Mistr's fixed Unidata Level II chunks
 * provider. The JSON catalog is shared with Rust so unsupported/test IDs fail
 * before any network request.
 */
export interface RadarSiteOption {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
}

export const RADAR_SITES: readonly RadarSiteOption[] = catalog.sites;

const RADAR_SITES_BY_ID = new Map(RADAR_SITES.map((site) => [site.id, site]));

export function isSupportedRadarSite(value: string): boolean {
  return RADAR_SITES_BY_ID.has(value);
}

export function radarSiteById(id: string): RadarSiteOption | undefined {
  return RADAR_SITES_BY_ID.get(id);
}

export function filterRadarSites(
  sites: readonly RadarSiteOption[],
  query: string,
): readonly RadarSiteOption[] {
  const normalized = query.trim().toLocaleUpperCase("en-US");
  if (!normalized) return sites;
  return sites.filter((site) =>
    site.id.includes(normalized) || site.name.toLocaleUpperCase("en-US").includes(normalized)
  );
}
