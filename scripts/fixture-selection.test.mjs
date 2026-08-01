import { describe, expect, it } from "vitest";
import {
  parseFixtureVerificationArgs,
  selectFixturesForVerification,
} from "./fixture-selection.mjs";

describe("fixture verification scope", () => {
  it("selects only the requested set in declared order", () => {
    const fixtures = [{ id: "phase4-a" }, { id: "future-only" }, { id: "phase4-b" }];
    const selected = selectFixturesForVerification(fixtures, {
      phase4KtlxReflectivityLoop: ["phase4-a", "phase4-b"],
    }, "phase4KtlxReflectivityLoop");

    expect(selected.map((fixture) => fixture.id)).toEqual(["phase4-a", "phase4-b"]);
  });

  it("parses a download plus set scope and rejects unsupported arguments", () => {
    expect(parseFixtureVerificationArgs([
      "--download",
      "--set",
      "phase4KtlxReflectivityLoop",
    ])).toEqual({ shouldDownload: true, setName: "phase4KtlxReflectivityLoop" });
    expect(() => parseFixtureVerificationArgs(["--everything"]))
      .toThrow("Unsupported fixture verifier argument");
  });
});
