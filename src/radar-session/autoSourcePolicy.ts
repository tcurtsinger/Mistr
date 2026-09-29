import type { RadarSiteOption } from "../data/radarSites";
import { rangeBearing, type LngLatPoint } from "../radar-renderer/geo";
import type { RadarSourceKey } from "./RadarSessionCoordinator";

/** Zoom at which a covering Site replaces the ~1 km National mosaic. */
export const AUTO_SITE_ENTER_ZOOM = 9;
/** Below this zoom a displayed Site hands back to National (hysteresis). */
export const AUTO_SITE_EXIT_ZOOM = 8.5;
/** From this zoom the likely Site is fetched ahead so the switch is instant. */
export const AUTO_SITE_PRELOAD_ZOOM = 8;
/** The view center must be this close to a Site to switch to it. */
export const AUTO_SITE_ENTER_RANGE_M = 200_000;
/** A displayed Site is kept while the view center stays this close to it. */
export const AUTO_SITE_KEEP_RANGE_M = 230_000;
/**
 * Outside the National grid (Alaska, Hawaii, Guam, Puerto Rico) National
 * shows nothing, so a Site is entered and kept down to regional zooms. The
 * floor keeps a continental view, which may include the grid, on National.
 */
export const AUTO_SITE_OFFSHORE_ENTER_ZOOM = 6;
export const AUTO_SITE_OFFSHORE_EXIT_ZOOM = 5.5;

/** The MRMS CONUS grid National draws (cell centers, `mrms.rs`). */
export const NATIONAL_GRID_BOUNDS = {
  west: -129.995,
  east: -60.005,
  south: 20.005,
  north: 54.995,
} as const;

export function nationalCovers(point: LngLatPoint): boolean {
  return point.longitude >= NATIONAL_GRID_BOUNDS.west
    && point.longitude <= NATIONAL_GRID_BOUNDS.east
    && point.latitude >= NATIONAL_GRID_BOUNDS.south
    && point.latitude <= NATIONAL_GRID_BOUNDS.north;
}

export type AutoSource =
  | { readonly kind: "national" }
  | { readonly kind: "site"; readonly siteIcao: string };

export interface AutoSourceInput {
  readonly zoom: number;
  readonly center: LngLatPoint;
  readonly visible: AutoSource;
  /** Site the operator picked; preferred while the view stays inside its coverage. */
  readonly preferredSite?: string;
}

export interface AutoSourceDecision {
  readonly target: AutoSource;
  /** Site worth fetching ahead of the switch, only while National is displayed. */
  readonly preload?: string;
  /** The view has left the preferred Site's coverage, so the pick no longer applies. */
  readonly preferenceSpent?: true;
}

const NATIONAL: AutoSource = { kind: "national" };

/**
 * Zoom decides the source. Moving between Sites always passes through
 * National, so only one Site is ever loaded.
 */
export function decideAutoSource(
  input: AutoSourceInput,
  sites: readonly RadarSiteOption[],
): AutoSourceDecision {
  const { zoom, center, visible } = input;
  const covered = nationalCovers(center);
  const enterZoom = covered ? AUTO_SITE_ENTER_ZOOM : AUTO_SITE_OFFSHORE_ENTER_ZOOM;
  const exitZoom = covered ? AUTO_SITE_EXIT_ZOOM : AUTO_SITE_OFFSHORE_EXIT_ZOOM;
  const preloadZoom = covered ? AUTO_SITE_PRELOAD_ZOOM : AUTO_SITE_OFFSHORE_EXIT_ZOOM;
  const preferred = input.preferredSite
    ? sites.find((site) => site.id === input.preferredSite)
    : undefined;
  const preferenceHolds = Boolean(
    preferred && distanceM(center, preferred) <= AUTO_SITE_KEEP_RANGE_M,
  );
  const spent = input.preferredSite && !preferenceHolds ? { preferenceSpent: true as const } : {};
  if (visible.kind === "site") {
    // A picked Site replaces the displayed one by way of National.
    if (preferenceHolds && preferred!.id !== visible.siteIcao && zoom >= enterZoom) {
      return { target: NATIONAL };
    }
    const current = sites.find((site) => site.id === visible.siteIcao);
    const stays = current
      && zoom >= exitZoom
      && distanceM(center, current) <= AUTO_SITE_KEEP_RANGE_M;
    return { target: stays ? visible : NATIONAL, ...spent };
  }
  const candidate = preferenceHolds ? preferred!.id : nearestCoveringSite(center, sites);
  if (!candidate) return { target: NATIONAL, ...spent };
  if (zoom >= enterZoom) return { target: { kind: "site", siteIcao: candidate }, ...spent };
  if (zoom >= preloadZoom) return { target: NATIONAL, preload: candidate, ...spent };
  return { target: NATIONAL, ...spent };
}

export function autoSourceOf(source: RadarSourceKey): AutoSource {
  return source.kind === "national" ? NATIONAL : { kind: "site", siteIcao: source.siteIcao };
}

/**
 * The switch a pick calls for next from the visible source: picking another
 * Site passes through National, and picking National (undefined) goes there.
 */
export function pickedNextSource(pick: string | undefined, visible: AutoSource): AutoSource {
  if (pick === undefined) return NATIONAL;
  if (visible.kind === "site") return visible.siteIcao === pick ? visible : NATIONAL;
  return { kind: "site", siteIcao: pick };
}

export function sameAutoSource(left: AutoSource, right: AutoSource): boolean {
  return left.kind === right.kind
    && (left.kind === "national" || left.siteIcao === (right as { siteIcao: string }).siteIcao);
}

function nearestCoveringSite(
  center: LngLatPoint,
  sites: readonly RadarSiteOption[],
): string | undefined {
  let nearest: { id: string; distance: number } | undefined;
  for (const site of sites) {
    const distance = distanceM(center, site);
    if (distance <= AUTO_SITE_ENTER_RANGE_M && (!nearest || distance < nearest.distance)) {
      nearest = { id: site.id, distance };
    }
  }
  return nearest?.id;
}

function distanceM(center: LngLatPoint, site: RadarSiteOption): number {
  return rangeBearing(center, { longitude: site.longitude, latitude: site.latitude }).rangeM;
}
