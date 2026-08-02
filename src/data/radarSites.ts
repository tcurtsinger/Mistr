import catalog from "./radar-sites.json";

/**
 * Operational WSR-88D sites exposed by Mistr's fixed Unidata Level II chunks
 * provider. The JSON catalog is shared with Rust so unsupported/test IDs fail
 * before any network request.
 */
export interface RadarSiteOption {
  readonly id: string;
  readonly name: string;
}

export const RADAR_SITES: readonly RadarSiteOption[] = catalog.sites;

const RADAR_SITE_IDS = new Set(RADAR_SITES.map((site) => site.id));

export function isSupportedRadarSite(value: string): boolean {
  return RADAR_SITE_IDS.has(value);
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
