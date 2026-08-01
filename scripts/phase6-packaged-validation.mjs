export function validateContextRecovery(reset, expectedResidents) {
  const failures = [];
  if (reset.before.contextEpoch + 1 !== reset.after.contextEpoch) failures.push("context_epoch");
  if (reset.before.selectedObservationId !== reset.after.selectedObservationId) failures.push("visible_selection");
  if (reset.after.status !== "painted") failures.push("renderer_status");
  if (reset.recovery.phase !== "ready") failures.push("recovery_phase");
  if (!reset.recovery.visibleFramePainted) failures.push("visible_frame_not_painted");
  if (reset.recovery.targetResidentCount !== expectedResidents) failures.push("recovery_target_count");
  if (reset.recovery.currentResidentCount !== expectedResidents) failures.push("recovery_resident_count");
  if (reset.after.residentObservationIds.length !== expectedResidents) failures.push("resident_ids");
  if (reset.after.paintReceipt?.contextEpoch !== reset.after.contextEpoch) failures.push("paint_epoch");
  if (reset.after.paintReceipt?.observationId !== reset.after.selectedObservationId) failures.push("paint_observation");
  return failures;
}

export function validatePhase6Acceptance(report) {
  const failures = [];
  if (!report.userAgent?.includes("Edg/")) failures.push("webview2_user_agent");
  if (!report.initial?.renderer?.capabilities?.hardwareAcceleration) failures.push("hardware_renderer");
  if (report.initial?.renderer?.recovery?.targetResidentCount !== 20) failures.push("initial_loop_count");
  failures.push(...validateContextRecovery(report.reflectivityContextReset, 20)
    .map((failure) => `reflectivity_${failure}`));
  if (report.postRecoveryStep?.contextEpoch !== report.reflectivityContextReset.after.contextEpoch) {
    failures.push("post_recovery_step_epoch");
  }
  if (report.minimizeRestore?.receipt?.observationId !== report.minimizeRestore?.selectedObservationId) {
    failures.push("minimize_restore_paint");
  }
  if (report.offlineResidentStep?.receipt?.observationId !== report.offlineResidentStep?.selectedObservationId) {
    failures.push("offline_resident_paint");
  }
  if (
    report.n0s?.product !== "storm_relative_velocity"
    || report.n0s?.units !== "kt"
    || report.n0s?.sourceKind !== "nexrad_level3_n0s"
    || report.n0s?.sample?.units !== "kt"
  ) {
    failures.push("n0s_product_truth");
  }
  failures.push(...validateContextRecovery(report.n0sContextReset, 1)
    .map((failure) => `n0s_${failure}`));
  if (!Array.isArray(report.scaleChanges) || report.scaleChanges.length !== 2) {
    failures.push("scale_change_count");
  } else if (report.scaleChanges.some((change) => (
    change.receipt?.framebufferWidth < 1 || change.receipt?.framebufferHeight < 1
  ))) {
    failures.push("scale_change_framebuffer");
  }
  return failures;
}
