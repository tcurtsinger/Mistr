import { describe, expect, it } from "vitest";
import { validateAlphaSleepWake } from "./alpha-sleep-wake-validation.mjs";

function validReport() {
  const renderer = {
    status: "painted",
    recovery: { phase: "ready" },
    metrics: { residentFrameCount: 20 },
    residentObservationIds: ["a", "b"],
    paintReceipt: { completedAtUnixMs: 2_000 },
  };
  return {
    preSleep: { renderer, playback: { playing: true } },
    detectedGapMs: 20_000,
    wakeDetectedAtUnixMs: 1_500,
    postWake: { renderer: { ...renderer }, playback: { playing: true } },
    postWakeSelectedObservationId: "b",
    postWakeScrub: { observationId: "b", framebufferWidth: 1_100, framebufferHeight: 700 },
  };
}

describe("Alpha sleep/wake validation", () => {
  it("accepts resident playback and post-wake paint truth", () => {
    expect(validateAlphaSleepWake(validReport())).toEqual([]);
  });

  it.each([
    ["heartbeat", (report) => { report.detectedGapMs = 1_000; }],
    ["residency", (report) => { report.postWake.renderer.metrics.residentFrameCount = 1; }],
    ["playback", (report) => { report.postWake.playback.playing = false; }],
    ["paint", (report) => { report.postWake.renderer.paintReceipt.completedAtUnixMs = 1_000; }],
    ["scrub", (report) => { report.postWakeScrub.observationId = "a"; }],
  ])("rejects %s regression", (_name, mutate) => {
    const report = validReport();
    mutate(report);
    expect(validateAlphaSleepWake(report)).not.toEqual([]);
  });
});
