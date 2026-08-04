import { describe, expect, it, vi } from "vitest";
import { clearPriorWebGlErrors } from "./NationalGridLayer";

describe("National WebGL upload error isolation", () => {
  it("drains sticky errors left by shared-context rendering before an upload", () => {
    const errors = [0x0500, 0x0502, 0];
    const getError = vi.fn(() => errors.shift() ?? 0);

    expect(() => clearPriorWebGlErrors({ NO_ERROR: 0, getError })).not.toThrow();
    expect(getError).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the prior error queue cannot be cleared", () => {
    const getError = vi.fn(() => 0x0502);

    expect(() => clearPriorWebGlErrors({ NO_ERROR: 0, getError })).toThrow(
      "National renderer could not clear the prior WebGL error state",
    );
    expect(getError).toHaveBeenCalledTimes(32);
  });
});
