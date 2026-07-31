import { describe, expect, it } from "vitest";
import { getRuntimeSnapshot } from "./runtime";

describe("getRuntimeSnapshot", () => {
  it("reports a browser development shell outside Tauri", async () => {
    await expect(getRuntimeSnapshot()).resolves.toEqual({
      shell: "browser",
      appVersion: "development",
    });
  });
});
