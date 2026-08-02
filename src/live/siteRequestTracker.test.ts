import { describe, expect, it } from "vitest";
import { SiteRequestTracker } from "./siteRequestTracker";

describe("SiteRequestTracker", () => {
  it("distinguishes superseded requests even when they target the same site", () => {
    const tracker = new SiteRequestTracker();
    const startupRequest = tracker.begin();
    const repeatedSiteRequest = tracker.begin();

    expect(tracker.isCurrent(startupRequest)).toBe(false);
    expect(tracker.isCurrent(repeatedSiteRequest)).toBe(true);

    tracker.invalidate();
    expect(tracker.isCurrent(repeatedSiteRequest)).toBe(false);
  });
});
