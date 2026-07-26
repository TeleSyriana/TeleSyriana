// inactivity-policy.js — pure inactivity rules for Phase 4A
//
// This is deliberately conservative. Lack of keyboard/mouse activity while an
// employee is on Break or in a Meeting is expected and must not auto-punish them.

export const INACTIVITY_UNAVAILABLE_MS = 15 * 60 * 1000;

const AUTO_UNAVAILABLE_STATUSES = new Set([
  "in_operation",
  "operating",
  "handling",
]);

function clean(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function statusEligibleForInactivity(status) {
  return AUTO_UNAVAILABLE_STATUSES.has(clean(status));
}

export function inactivityDurationMs(lastActivityMs, nowMs = Date.now()) {
  const last = Number(lastActivityMs || 0);
  const now = Number(nowMs || Date.now());
  if (!Number.isFinite(last) || last <= 0 || !Number.isFinite(now) || now <= last) return 0;
  return now - last;
}

export function shouldAutoUnavailable({
  status,
  lastActivityMs,
  nowMs = Date.now(),
  thresholdMs = INACTIVITY_UNAVAILABLE_MS,
} = {}) {
  if (!statusEligibleForInactivity(status)) return false;
  const threshold = Math.max(60_000, Number(thresholdMs) || INACTIVITY_UNAVAILABLE_MS);
  return inactivityDurationMs(lastActivityMs, nowMs) >= threshold;
}
