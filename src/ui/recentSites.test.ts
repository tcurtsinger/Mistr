import { describe, expect, it } from "vitest";
import { MAX_RECENT_SITES, readRecentSites, rememberRecentSite } from "./recentSites";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [["mistr.recentSites", initial]]);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("recent radar sites", () => {
  it("keeps the newest choice first without duplicates, up to the limit", () => {
    const storage = memoryStorage();
    for (const site of ["KTLX", "KFWS", "KINX", "KTLX"]) rememberRecentSite(site, storage);
    expect(readRecentSites(storage)).toEqual(["KTLX", "KINX", "KFWS"]);
    for (const site of ["KAMA", "KLBB", "KVNX", "KDYX"]) rememberRecentSite(site, storage);
    expect(readRecentSites(storage)).toHaveLength(MAX_RECENT_SITES);
    expect(readRecentSites(storage)[0]).toBe("KDYX");
  });

  it("ignores unsupported sites and unreadable storage", () => {
    expect(readRecentSites(memoryStorage('["KOUN","KTLX",3]'))).toEqual(["KTLX"]);
    expect(readRecentSites(memoryStorage("not json"))).toEqual([]);
    expect(readRecentSites(undefined)).toEqual([]);
    const storage = memoryStorage();
    expect(rememberRecentSite("KOUN", storage)).toEqual([]);
  });
});
