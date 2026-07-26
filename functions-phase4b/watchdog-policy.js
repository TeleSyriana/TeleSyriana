'use strict';

const WATCHDOG_THRESHOLD_MS = 15 * 60 * 1000;
const DEFAULT_TIME_ZONE = 'Asia/Damascus';
const IPRO_ORG_CHANGE_EFFECTIVE_MS = Date.parse('2026-07-27T00:00:00+03:00');
const ELIGIBLE_OPERATIONAL_STATUSES = new Set(['in_operation', 'operating', 'handling']);

function clean(value) {
  return String(value ?? '').trim();
}

function number(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function safeTimeZone(value) {
  const candidate = clean(value) || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function dayKeyInTimeZone(timeZone, nowMs = Date.now()) {
  const zone = safeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(Number(nowMs) || Date.now()));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function eligibleOperationalStatus(status) {
  return ELIGIBLE_OPERATIONAL_STATUSES.has(clean(status).toLowerCase());
}

function effectiveActivityRole(activity = {}, nowMs = Date.now()) {
  const now = Number(nowMs) || Date.now();
  const userId = clean(activity.userId);
  const employeeUid = clean(activity.employeeUid);
  const rawRole = clean(activity.role).toLowerCase();

  if (now >= IPRO_ORG_CHANGE_EFFECTIVE_MS) {
    // Reema retains employeeUid emp_legacy_9003 but is Supervisor 2002 from Monday.
    if (userId === '9003' || userId === '2002' || employeeUid === 'emp_legacy_9003') return 'supervisor';
    // Qamar resigned; stale Agent telemetry must be disarmed rather than acted on.
    if (userId === '9002' || employeeUid === 'emp_legacy_9002') return 'inactive';
  }

  return rawRole;
}

function evaluateWatchdog({ activity = {}, dayRow = null, nowMs = Date.now() } = {}) {
  const now = Number(nowMs) || Date.now();
  const dueMs = number(activity.watchdogDueMs);
  const lastActivityMs = number(activity.lastActivityMs);
  const role = effectiveActivityRole(activity, now);

  if (!dueMs || dueMs > now) {
    return { due: false, shouldUnavailable: false, clearDue: false, reason: 'not_due' };
  }
  if (role !== 'agent') {
    return { due: true, shouldUnavailable: false, clearDue: true, reason: role === 'inactive' ? 'inactive_employee' : 'not_agent' };
  }
  if (!lastActivityMs || now - lastActivityMs < WATCHDOG_THRESHOLD_MS) {
    return { due: true, shouldUnavailable: false, clearDue: true, reason: 'activity_not_stale' };
  }
  if (!dayRow) {
    return { due: true, shouldUnavailable: false, clearDue: true, reason: 'missing_day_row' };
  }

  const status = clean(dayRow.status).toLowerCase();
  if (!eligibleOperationalStatus(status)) {
    return { due: true, shouldUnavailable: false, clearDue: true, reason: `status_${status || 'unknown'}` };
  }

  return { due: true, shouldUnavailable: true, clearDue: true, reason: 'idle_threshold_reached' };
}

module.exports = {
  WATCHDOG_THRESHOLD_MS,
  DEFAULT_TIME_ZONE,
  IPRO_ORG_CHANGE_EFFECTIVE_MS,
  dayKeyInTimeZone,
  eligibleOperationalStatus,
  effectiveActivityRole,
  evaluateWatchdog,
};
