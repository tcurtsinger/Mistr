import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RadarChrome, formatScanTimestamp, type RadarChromeProps } from "./RadarChrome";

const props: RadarChromeProps = {
  displayMode: "smooth", displayModeReady: true, dismissPanelsSignal: 0,
  frameAge: { kind: "current", label: "03:01", accessibleLabel: "3 minutes 1 second old" },
  frameCount: 60, frameIndex: 27, interrogation: null, inspectionState: "idle",
  onRecenter() {}, onSelectNational() {}, onSelectDisplayMode() {}, onScrub() {},
  onSelectSite() {}, onTogglePlayback() {}, playbackReady: true,
  playbackStatus: "PLAYING", playing: true, recenterReady: true,
  paintedSourceKind: "national", selectedSite: "KTLX", siteSelectionReady: true, sites: [],
};

describe("compact radar chrome", () => {
  it.each(["error", "info"] as const)("keeps %s notices out of the visible layout", kind => {
    const html = renderToStaticMarkup(<RadarChrome {...props} radarNotice={{ kind, message: "Background retry" }} />);
    expect(html).toContain('class="sr-only radar-notice"');
    expect(html).not.toContain("radar-notice--");
    expect(html).toContain('aria-label="Radar playback"');
  });

  it.each([
    ["error", "Radar problem"],
    ["info", "Radar status"],
  ] as const)("marks a %s notice beside the frame age without showing its text", (kind, label) => {
    const html = renderToStaticMarkup(<RadarChrome {...props} radarNotice={{ kind, message: "Background retry" }} />);
    expect(html).toContain(`class="radar-status radar-status--${kind}"`);
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('role="tooltip"');
    expect(html.split("Background retry")).toHaveLength(2);
  });

  it("keeps an empty status slot when there is no notice", () => {
    const html = renderToStaticMarkup(<RadarChrome {...props} />);
    expect(html).toContain('<span aria-hidden="true" class="radar-status-anchor"></span>');
    expect(html).not.toContain("radar-status--");
  });

  it.each([
    [0, "12:05:09 AM"], [1, "01:05:09 AM"], [11, "11:05:09 AM"],
    [12, "12:05:09 PM"], [15, "03:05:09 PM"], [23, "11:05:09 PM"],
  ])("formats local hour %i in 12-hour time", (hour, expected) => {
    const result = formatScanTimestamp(new Date(2026, 8, 10, hour, 5, 9).getTime());
    expect(result.time).toBe(expected);
    expect(result.date).toBe("2026-09-10");
    expect(result.zone).not.toBe("");
    expect(result.accessible).toContain(expected);
  });

  it("names no displayed source before any radar has painted", () => {
    const html = renderToStaticMarkup(<RadarChrome {...props} paintedSourceKind="none" requestedSite="KTLX"
      requestedSourceKind="site" />);
    expect(html).toContain("Choose radar source. No radar is displayed yet. Updating KTLX.");
    expect(html).not.toContain("KTLX Site is displayed");
    expect(html).toContain('data-painted-source="none"');
  });

  it("uses AM/PM in the scan readout and accessible timeline text for either source", () => {
    for (const source of ["national", "site"] as const) {
      const html = renderToStaticMarkup(<RadarChrome {...props} paintedSourceKind={source}
        displayedAtUnixMs={new Date(2026, 8, 10, 15, 2, 3).getTime()} />);
      expect(html).toContain("03:02:03 PM");
      expect(html).not.toContain("15:02:03");
    }
    expect(formatScanTimestamp(undefined).time).toBe("--:--:--");
  });
});
