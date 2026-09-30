import { isSupportedRadarSite } from "../data/radarSites";

const RECENT_SITES_KEY = "mistr.recentSites";
export const MAX_RECENT_SITES = 5;

/** The sites the operator chose most recently, newest first. */
export function readRecentSites(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(RECENT_SITES_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((site): site is string => (
      typeof site === "string" && isSupportedRadarSite(site)
    )))].slice(0, MAX_RECENT_SITES);
  } catch {
    return [];
  }
}

/** Moves `site` to the front of the recent sites and returns the new list. */
export function rememberRecentSite(
  site: string,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = safeStorage(),
): string[] {
  if (!isSupportedRadarSite(site)) return readRecentSites(storage);
  const next = [site, ...readRecentSites(storage).filter((recent) => recent !== site)]
    .slice(0, MAX_RECENT_SITES);
  try {
    storage?.setItem(RECENT_SITES_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked store only costs the recent list.
  }
  return next;
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
