// activity-telemetry-policy.js — pure client/server activity timing contract

export const ACTIVITY_WATCHDOG_MS = 15 * 60 * 1000;
export const ACTIVITY_PUBLISH_MAX_INTERVAL_MS = 2 * 60 * 1000;
export const ACTIVITY_TRAILING_PUBLISH_MS = 20 * 1000;

function number(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function watchdogDueMs(lastActivityMs, thresholdMs = ACTIVITY_WATCHDOG_MS) {
  const activity = number(lastActivityMs);
  if (!activity) return 0;
  return activity + Math.max(60_000, Number(thresholdMs) || ACTIVITY_WATCHDOG_MS);
}

export function shouldPublishActivity({ lastPublishedMs, lastActivityMs, nowMs = Date.now() } = {}) {
  const published = number(lastPublishedMs);
  const activity = number(lastActivityMs);
  const now = number(nowMs) || Date.now();
  if (!activity) return false;
  if (!published) return true;
  if (activity <= published) return false;
  return now - published >= ACTIVITY_PUBLISH_MAX_INTERVAL_MS;
}

export function buildActivityTelemetry({ userId, role, projectId = "ipro", timeZone, lastActivityMs } = {}) {
  const id = String(userId || "").trim();
  const activity = number(lastActivityMs);
  if (!id || !activity) return null;
  return {
    userId: id,
    role: String(role || "").trim().toLowerCase(),
    projectId: String(projectId || "ipro").trim() || "ipro",
    timeZone: String(timeZone || "").trim(),
    lastActivityMs: activity,
    watchdogDueMs: watchdogDueMs(activity),
    telemetryVersion: 1,
  };
}
