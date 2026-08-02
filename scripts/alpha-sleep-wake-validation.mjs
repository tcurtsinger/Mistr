export function validateAlphaSleepWake(report) {
  const failures = [];
  requireGate(failures, report?.preSleep?.renderer?.status === "painted", "radar was not painted before sleep");
  requireGate(failures, report?.preSleep?.playback?.playing === true, "playback was not active before sleep");
  requireGate(failures, report?.detectedGapMs >= 10_000, "no real suspend-length heartbeat gap was detected");
  requireGate(failures, report?.postWake?.renderer?.status === "painted", "radar was not painted after wake");
  requireGate(failures, report?.postWake?.renderer?.recovery?.phase === "ready", "renderer was not ready after wake");
  requireGate(failures, report?.postWake?.renderer?.metrics?.residentFrameCount === 20, "resident loop was not restored after wake");
  requireGate(failures, sameMembers(report?.preSleep?.renderer?.residentObservationIds, report?.postWake?.renderer?.residentObservationIds), "sleep/wake changed resident observations");
  requireGate(failures, report?.postWake?.playback?.playing === true, "playback did not resume after wake");
  requireGate(failures, report?.postWake?.renderer?.paintReceipt?.completedAtUnixMs >= report?.wakeDetectedAtUnixMs, "no post-wake GPU paint receipt was observed");
  requireGate(failures, report?.postWakeScrub?.observationId === report?.postWakeSelectedObservationId, "post-wake scrub did not paint its selected observation");
  requireGate(failures, report?.postWakeScrub?.framebufferWidth > 0 && report?.postWakeScrub?.framebufferHeight > 0, "post-wake scrub has no framebuffer evidence");
  return failures;
}

function sameMembers(left = [], right = []) {
  return left.length === right.length && left.every(value => right.includes(value));
}

function requireGate(failures, passed, message) {
  if (!passed) failures.push(message);
}
