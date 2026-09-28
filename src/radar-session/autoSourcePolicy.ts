import type { RadarSiteOption } from "../data/radarSites";
import { rangeBearing, type LngLatPoint } from "../radar-renderer/geo";

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
  const preferred = input.preferredSite
    ? sites.find((site) => site.id === input.preferredSite)
    : undefined;
  const preferenceHolds = Boolean(
    preferred && distanceM(center, preferred) <= AUTO_SITE_KEEP_RANGE_M,
  );
  const spent = input.preferredSite && !preferenceHolds ? { preferenceSpent: true as const } : {};
  if (visible.kind === "site") {
    // A picked Site replaces the displayed one by way of National.
    if (preferenceHolds && preferred!.id !== visible.siteIcao && zoom >= AUTO_SITE_ENTER_ZOOM) {
      return { target: NATIONAL };
    }
    const current = sites.find((site) => site.id === visible.siteIcao);
    const stays = current
      && zoom >= AUTO_SITE_EXIT_ZOOM
      && distanceM(center, current) <= AUTO_SITE_KEEP_RANGE_M;
    return { target: stays ? visible : NATIONAL, ...spent };
  }
  const candidate = preferenceHolds ? preferred!.id : nearestCoveringSite(center, sites);
  if (!candidate) return { target: NATIONAL, ...spent };
  if (zoom >= AUTO_SITE_ENTER_ZOOM) return { target: { kind: "site", siteIcao: candidate }, ...spent };
  if (zoom >= AUTO_SITE_PRELOAD_ZOOM) return { target: NATIONAL, preload: candidate, ...spent };
  return { target: NATIONAL, ...spent };
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
