import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RadarSiteOption } from "../data/radarSites";
import {
  RadarChrome,
  clockTickIndexes,
  formatScanTimestamp,
  sourceOptionGroups,
  type RadarChromeProps,
} from "./RadarChrome";

const props: RadarChromeProps = {
  displayMode: "smooth", displayModeReady: true, dismissPanelsSignal: 0,
  frameAge: { kind: "current", label: "3m 01s ago", accessibleLabel: "3 minutes 1 second old" },
  frameCount: 60, frameIndex: 27, interrogation: null, inspectionState: "idle",
  onRecenter() {}, onSelectNational() {}, onSelectDisplayMode() {}, onScrub() {},
  onSelectSite() {}, onTogglePlayback() {}, playbackReady: true,
  playbackStatus: "PLAYING", playing: true, recenterReady: true,
  paintedSourceKind: "national", selectedSite: "KTLX", siteSelectionReady: true, sites: [],
};

const sites: RadarSiteOption[] = [
  { id: "KFWS", name: "Dallas/Fort Worth, TX", latitude: 32.57, longitude: -97.3 },
  { id: "KINX", name: "Tulsa, OK", latitude: 36.18, longitude: -95.56 },
  { id: "KTLX", name: "Oklahoma City, OK", latitude: 35.33, longitude: -97.28 },
];

const valid = (value: number) => ({
  radialIndex: 0, gateIndex: 0, sourceAzimuthDegrees: 0, slantRangeM: 0, groundRangeM: 0,
  rawCode: 0, status: "valid" as const, value, units: "dBZ" as const, color: [0, 0, 0, 0] as const,
});

describe("radar chrome", () => {
  it.each(["error", "info"] as const)("keeps %s notices out of any banner", kind => {
    const html = renderToStaticMarkup(<RadarChrome {...props} radarNotice={{ kind, message: "Background retry" }} />);
    expect(html).toContain('class="sr-only radar-notice"');
    expect(html).toContain('aria-label="Radar playback"');
    expect(html).not.toContain("timeline__status");
  });

  it.each([
    ["info", "info"],
    ["error", "caution"],
    ["error", "error"],
  ] as const)("shows a %s notice's short words on the timeline in its %s tone", (kind, tone) => {
    const html = renderToStaticMarkup(<RadarChrome {...props}
      radarNotice={{ kind, message: "KTLX update failed. Mistr retries.", short: "Retrying KTLX", tone }} />);
    expect(html).toContain(`class="timeline__status timeline__status--${tone}"`);
    expect(html).toContain("Retrying KTLX");
    // The full account stays out of the row until hovered or focused.
    expect(html.split("KTLX update failed")).toHaveLength(2);
  });

  it("names the painted radar in the playback row", () => {
    expect(renderToStaticMarkup(<RadarChrome {...props} />)).toMatch(/data-source-tag="national">National</);
    const site = renderToStaticMarkup(<RadarChrome {...props} paintedSourceKind="site" />);
    expect(site).toMatch(/data-source-tag="site">KTLX</);
    const switching = renderToStaticMarkup(<RadarChrome {...props} paintedSourceKind="site" requestedSite="KFWS"
      requestedSourceKind="site" />);
    expect(switching).toContain("tag tag--pending");
    expect(switching).toContain("KTLX<span aria-hidden=\"true\" class=\"tag-arrow\">→</span>KFWS");
  });

  it("turns the age amber while the painted scan is being retried", () => {
    const html = renderToStaticMarkup(<RadarChrome {...props} ageCaution />);
    expect(html).toContain("frame-age frame-age--current frame-age--caution");
    expect(html).toContain('data-frame-age-kind="current"');
  });

  it("shows a measured value with its own radar color", () => {
    const html = renderToStaticMarkup(<RadarChrome {...props} inspectionState="settled" interrogation={valid(42.5)} />);
    expect(html).toContain('class="sample-readout sample-readout--value"');
    expect(html).toContain('class="sample-swatch"');
    expect(html).toMatch(/<\/span>42\.5 dBZ<\/output>/);
    // The map draws no colour for a non-positive return, so its swatch is empty.
    const clear = renderToStaticMarkup(<RadarChrome {...props} inspectionState="settled" interrogation={valid(-2)} />);
    expect(clear).toContain('class="sample-swatch sample-swatch--clear"');
    expect(clear).toMatch(/-2\.0 dBZ<\/output>/);
    const idle = renderToStaticMarkup(<RadarChrome {...props} />);
    expect(idle).toContain("sample-readout--hint");
    expect(idle).toContain(">Inspect</output>");
  });

  it("marks quarter-hour ticks at the scans that cross them", () => {
    const start = new Date(2026, 8, 10, 10, 7).getTime();
    const times = Array.from({ length: 6 }, (_, index) => start + index * 5 * 60_000);
    const html = renderToStaticMarkup(<RadarChrome {...props} frameCount={6} frameIndex={5} frameTimes={times} />);
    // 10:07 10:12 10:17 10:22 10:27 10:32: the scans at 10:17 and 10:32 cross.
    expect(html.match(/--p:/g)).toHaveLength(2);
  });

  it("thins clock ticks on a long loop to a dozen or fewer", () => {
    const start = new Date(2026, 8, 10, 18, 2).getTime();
    // 6:02 to 10:57 PM crosses nineteen quarter hours but only nine half hours.
    const times = Array.from({ length: 60 }, (_, index) => start + index * 5 * 60_000);
    expect(clockTickIndexes(times)).toHaveLength(9);
    expect(clockTickIndexes(times.slice(0, 13))).toHaveLength(4);
  });

  it("names no displayed source before any radar has painted", () => {
    const html = renderToStaticMarkup(<RadarChrome {...props} paintedSourceKind="none" requestedSite="KTLX"
      requestedSourceKind="site" />);
    expect(html).toContain("Choose radar source. No radar is displayed yet. Updating KTLX.");
    expect(html).not.toContain("KTLX Site is displayed");
    expect(html).toContain('data-painted-source="none"');
  });

  it("states the cause and the remedy when radar never painted", () => {
    const html = renderToStaticMarkup(<RadarChrome {...props} preparingFailed
      preparingLabel="Mistr could not prepare radar. Restart Mistr to try again." />);
    expect(html).toContain("playback-bar--failed");
    expect(html).toContain("<strong>Radar unavailable</strong>");
    expect(html).toContain("Restart Mistr to try again.");
  });

  it.each([
    [0, "12:05:09 AM"], [1, "1:05:09 AM"], [11, "11:05:09 AM"],
    [12, "12:05:09 PM"], [15, "3:05:09 PM"], [23, "11:05:09 PM"],
  ])("formats local hour %i in 12-hour time", (hour, expected) => {
    const result = formatScanTimestamp(new Date(2026, 8, 10, hour, 5, 9).getTime());
    expect(result.time).toBe(expected);
    expect(result.date).toBe("2026-09-10");
    expect(result.zone).not.toBe("");
    expect(result.accessible).toContain(expected);
  });

  it("shows the date only for a scan from another day", () => {
    const scan = new Date(2026, 8, 10, 15, 2, 3).getTime();
    expect(formatScanTimestamp(scan, new Date(2026, 8, 10, 23, 0).getTime())).toMatchObject({ today: true });
    expect(formatScanTimestamp(scan, new Date(2026, 8, 11, 1, 0).getTime()))
      .toMatchObject({ today: false, dateShort: "Sep 10" });
    expect(formatScanTimestamp(undefined).time).toBe("--:--:--");
  });

  it("uses AM/PM in the scan readout and accessible timeline text for either source", () => {
    for (const source of ["national", "site"] as const) {
      const html = renderToStaticMarkup(<RadarChrome {...props} paintedSourceKind={source}
        displayedAtUnixMs={new Date(2026, 8, 10, 15, 2, 3).getTime()} />);
      expect(html).toContain("3:02:03 PM");
      expect(html).not.toContain("15:02:03");
    }
  });
});

describe("radar source list", () => {
  it("leads with National, then recent sites, then every site", () => {
    const groups = sourceOptionGroups(sites, "", ["KTLX", "KOUN"]);
    expect(groups.map((group) => group.label)).toEqual([undefined, "Recent", "All sites"]);
    expect(groups[0].options).toEqual([{ key: "national", kind: "national" }]);
    // An unknown recent site is dropped rather than shown.
    expect(groups[1].options.map((option) => option.kind === "site" && option.site.id)).toEqual(["KTLX"]);
    expect(groups[2].options).toHaveLength(3);
  });

  it("searches IDs and places, keeping National for its own words", () => {
    const [tulsa] = sourceOptionGroups(sites, "tul", []);
    expect(tulsa.options.map((option) => option.kind === "site" && option.site.id)).toEqual(["KINX"]);
    const [national] = sourceOptionGroups(sites, "conus", []);
    expect(national.options).toEqual([{ key: "national", kind: "national" }]);
    expect(sourceOptionGroups(sites, "zzz", [])[0].options).toEqual([]);
  });
});
