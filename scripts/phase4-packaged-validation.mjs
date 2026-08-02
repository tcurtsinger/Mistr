export const MIN_PHASE4_TRANSITIONS = 1_000;
export const MIN_PHASE4_STABILITY_RUNS = 2;
export const PHASE4_SWITCH_P95_CEILING_MS = 33.4;

export function parseAcceptanceWorkload(environment = process.env) {
  const transitions = Number(
    environment.MISTR_PHASE4_TRANSITIONS ?? MIN_PHASE4_TRANSITIONS,
  );
  const stabilityRuns = Number(
    environment.MISTR_PHASE4_STABILITY_RUNS ?? MIN_PHASE4_STABILITY_RUNS,
  );
  if (
    !Number.isSafeInteger(transitions)
    || transitions < MIN_PHASE4_TRANSITIONS
    || transitions > 10_000
  ) {
    throw new Error(
      `Phase 4 acceptance requires ${MIN_PHASE4_TRANSITIONS}-10000 transitions per run`,
    );
  }
  if (
    !Number.isSafeInteger(stabilityRuns)
    || stabilityRuns < MIN_PHASE4_STABILITY_RUNS
    || stabilityRuns > 5
  ) {
    throw new Error(
      `Phase 4 acceptance requires ${MIN_PHASE4_STABILITY_RUNS}-5 stability runs`,
    );
  }
  return { transitions, stabilityRuns };
}

export function phase4ScenarioTimeoutMs(transitions) {
  if (!Number.isSafeInteger(transitions) || transitions < MIN_PHASE4_TRANSITIONS) {
    throw new RangeError("scenario timeout requires an accepted transition count");
  }
  return Math.max(60_000, transitions * 60);
}

export function validatePhase4Acceptance(
  report,
  scenarios,
  bounds,
  expectedTransitions,
  expectedStabilityRuns,
) {
  const failures = [];
  const metrics = report.renderer?.metrics;
  if (scenarios.length !== expectedStabilityRuns) failures.push("stability_run_count");
  if (bounds.width !== 3_840 || bounds.height !== 2_160) failures.push("window_not_4k");
  if (!report.alignment?.allSelectedCorrectGate) failures.push("alignment");
  if (!report.coexistence?.standardLayersBeforeAndAfter) failures.push("layer_coexistence");
  if (report.renderer?.status !== "painted") failures.push("renderer_status");
  if (report.renderer?.paintReceipt?.framebufferWidth < 3_840) failures.push("paint_not_4k_width");
  if (report.renderer?.paintReceipt?.framebufferHeight < 2_160) failures.push("paint_not_4k_height");
  if (metrics?.residentFrameCount !== 20) failures.push("resident_count");
  if (report.renderer?.textureValidationsPassed !== 20) failures.push("texture_readback");
  if (!report.renderer?.capabilities?.hardwareAcceleration) failures.push("hardware_renderer");
  if ((metrics?.gpuResourceBytes ?? Infinity) > 200 * 1024 * 1024) failures.push("gpu_target");
  if ((metrics?.peakGpuResourceBytes ?? Infinity) > 256 * 1024 * 1024) failures.push("gpu_ceiling");
  for (const [index, scenario] of scenarios.entries()) {
    const prefix = `run_${index + 1}`;
    if (
      scenario.requestedTransitions !== expectedTransitions
      || scenario.completedTransitions !== expectedTransitions
    ) {
      failures.push(`${prefix}_transitions`);
    }
    if (!scenario.receiptTruthPassed) failures.push(`${prefix}_paint_truth`);
    if (!scenario.hotPathActivityZero) failures.push(`${prefix}_hot_path_activity`);
    if (!scenario.replacementStable) failures.push(`${prefix}_replacement_growth`);
    if (!scenario.rollingHistory?.passed) failures.push(`${prefix}_rolling_history`);
    if (scenario.frameTiming.p95Ms >= 16.7) failures.push(`${prefix}_frame_p95`);
    if (scenario.switchTiming?.sampleCount !== expectedTransitions) {
      failures.push(`${prefix}_switch_sample_count`);
    }
    if ((scenario.switchTiming?.p95Ms ?? Infinity) >= PHASE4_SWITCH_P95_CEILING_MS) {
      failures.push(`${prefix}_switch_p95`);
    }
    if (!scenario.frameTiming.longTaskObserverAvailable) {
      failures.push(`${prefix}_long_task_observer_unavailable`);
    }
    if (scenario.frameTiming.longTaskCount !== 0) failures.push(`${prefix}_long_tasks`);
    if (scenario.framebufferWidth < 3_840 || scenario.framebufferHeight < 2_160) {
      failures.push(`${prefix}_framebuffer`);
    }
  }
  const stabilizedHeaps = scenarios
    .map((scenario) => scenario.stabilizedHeapBytes)
    .filter((value) => typeof value === "number");
  if (stabilizedHeaps.length !== expectedStabilityRuns) {
    failures.push("stabilized_heap_unavailable");
  } else if (stabilizedHeaps.at(-1) > stabilizedHeaps[0] + 5 * 1024 * 1024) {
    failures.push("stabilized_heap_growth");
  }
  return failures;
}
