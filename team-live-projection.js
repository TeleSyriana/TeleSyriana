// team-live-projection.js — pure Phase 3 live status/attendance projection
//
// No DOM, Firebase, storage or network dependency. Converts today's existing
// agentDays rows into a project/team-scoped operational summary.

import { EMPLOYEE_ROLES, normaliseCanonicalRole } from "./employee-model.js";
import { buildProjectHierarchy, supervisorTeam } from "./project-hierarchy-shadow.js";

const OPERATIONAL_STATUSES = Object.freeze({
  in_operation: "operating",
  operating: "operating",
  online: "operating",
  break: "break",
  meeting: "meeting",
  handling: "handling",
  unavailable: "unavailable",
  away: "unavailable",
  offline: "unavailable",
});

function clean(value) {
  return String(value ?? "").trim();
}

function ccms(row = {}) {
  return clean(row.ccmsId || row.userId || row.id);
}

function toMs(value) {
  if (!value) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeOperationalStatus(status) {
  return OPERATIONAL_STATUSES[clean(status).toLowerCase()] || "unavailable";
}

export function projectDayKey(timeZone = "Asia/Damascus", now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function operationalTeamForActor(actor, employees = [], projectId = "ipro") {
  const role = normaliseCanonicalRole(actor?.roleKey || actor?.role);
  if (role === EMPLOYEE_ROLES.SUPERVISOR) {
    return supervisorTeam(projectId, clean(actor?.employeeUid), employees).agents.map((row) => ({ ...row }));
  }
  if (role === EMPLOYEE_ROLES.ACM || role === EMPLOYEE_ROLES.HR || role === EMPLOYEE_ROLES.CEO) {
    const hierarchy = buildProjectHierarchy(projectId, employees);
    return hierarchy.supervisors.flatMap((group) => group.agents.map((row) => ({ ...row })));
  }
  return [];
}

function explicitAttendance(row = {}) {
  const raw = clean(row.attendanceStatus).toLowerCase();
  const late = row.late === true || raw === "late";
  const absent = row.absent === true || raw === "absent";
  const known = Boolean(raw) || typeof row.late === "boolean" || typeof row.absent === "boolean";
  return { known, late, absent };
}

export function buildLiveTeamProjection(actor, {
  employees = [],
  dayRows = [],
  projectId = "ipro",
  timeZone = "Asia/Damascus",
  now = new Date(),
  staleAfterMinutes = 15,
} = {}) {
  const team = operationalTeamForActor(actor, employees, projectId);
  const rowByCcms = new Map((dayRows || []).map((row) => [ccms(row), row]));
  const status = { operating: 0, break: 0, meeting: 0, handling: 0, unavailable: 0 };
  let signedIn = 0;
  let notSignedIn = 0;
  let late = 0;
  let absent = 0;
  let attendanceKnown = 0;
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const staleMs = Math.max(1, Number(staleAfterMinutes) || 15) * 60_000;

  const members = team.map((employee) => {
    const row = rowByCcms.get(ccms(employee)) || null;
    const loginTimeMs = toMs(row?.loginTime);
    const updatedAtMs = toMs(row?.updatedAt);
    const hasDayRow = Boolean(row);
    const hasSignedIn = Boolean(hasDayRow && (loginTimeMs || clean(row?.status)));
    if (hasSignedIn) signedIn += 1;
    else notSignedIn += 1;

    const attendance = explicitAttendance(row || {});
    if (attendance.known) {
      attendanceKnown += 1;
      if (attendance.late) late += 1;
      if (attendance.absent) absent += 1;
    }

    const normalized = hasSignedIn ? normalizeOperationalStatus(row?.status) : "unavailable";
    status[normalized] += 1;
    const stale = Boolean(hasSignedIn && updatedAtMs && nowMs - updatedAtMs > staleMs);

    return {
      employeeUid: clean(employee.employeeUid),
      ccmsId: ccms(employee),
      fullName: clean(employee.fullName || employee.name || ccms(employee)),
      status: normalized,
      rawStatus: clean(row?.status),
      signedIn: hasSignedIn,
      loginTimeMs,
      updatedAtMs,
      stale,
      attendanceKnown: attendance.known,
      late: attendance.late,
      absent: attendance.absent,
    };
  });

  return {
    projectId,
    day: projectDayKey(timeZone, now instanceof Date ? now : new Date(nowMs)),
    timeZone,
    teamSize: team.length,
    signedIn,
    notSignedIn,
    status,
    attendance: {
      coverage: attendanceKnown,
      total: team.length,
      late: attendanceKnown ? late : null,
      absent: attendanceKnown ? absent : null,
    },
    members,
  };
}
