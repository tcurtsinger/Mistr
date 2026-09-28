import { describe, expect, it } from "vitest";
import { MAX_LIVE_HISTORY_FRAMES } from "../src/live/liveHistory";
import { LIVE_HISTORY_CAPACITY } from "./live-history-capacity.mjs";

describe("packaged harness live-history capacity", () => {
  it("matches the product capacity", () => {
    expect(LIVE_HISTORY_CAPACITY).toBe(MAX_LIVE_HISTORY_FRAMES);
  });
});
