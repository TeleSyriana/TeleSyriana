// role-dashboard-shadow.js — pure role dashboard projections
//
// Builds Supervisor/ACM operational summaries from already-authorized project,
// team and ticket data. No storage or DOM dependencies.

import { EMPLOYEE_ROLES, normaliseCanonicalRole } from "./employee-model.js";
import { buildProjectHierarchy, supervisorTeam } from "./project-hierarchy-shadow.js";
import {
  projectForTicketActor,
  searchableTickets,
  ticketActivityDate,
  ticketIsResolved,
  ticketStatus,
  ticketVisibleInDefaultQueue,
} from "./ticket-access-policy.js";

function clean(value) {
  return String(value ?? "").trim();
}

function uid(row = {}) {
  return clean(row.employeeUid || row.uid);
}

function ccms(row = {}) {
  return clean(row.ccmsId || row.id);
}

function findPresence(employee, presenceRows = []) {
  const employeeUid = uid(employee);
  const employeeCcms = ccms(employee);
  return (presenceRows || []).find((row) =>
    (employeeUid && uid(row) === employeeUid) ||
    (employeeCcms && ccms(row) === employeeCcms)
  ) || null;
}

function findAttendance(employee, attendanceRows = []) {
  const employeeUid = uid(employee);
  const employeeCcms = ccms(employee);
  return (attendanceRows || []).find((row) =>
    (employeeUid && uid(row) === employeeUid) ||
    (employeeCcms && ccms(row) === employeeCcms)
  ) || null;
}

function statusOf(employee, presenceRows = []) {
  const presence = findPresence(employee, presenceRows);
  return clean(presence?.status || employee?.status || "unavailable").toLowerCase() || "unavailable";
}

function isEmergency(ticket = {}) {
  return clean(ticket.priority).toLowerCase() === "emergency";
}

function isOverdue(ticket = {}, now = new Date()) {
  if (!ticketVisibleInDefaultQueue(ticket)) return false;
  const raw = ticket.dueAt || ticket.slaDueAt || null;
  if (!raw) return false;
  const due = raw instanceof Date ? raw : typeof raw?.toDate === "function" ? raw.toDate() : new Date(raw);
  return !Number.isNaN(due.getTime()) && due.getTime() < now.getTime();
}

function resolvedToday(ticket = {}, now = new Date()) {
  if (!ticketIsResolved(ticket)) return false;
  const activity = ticketActivityDate(ticket);
  if (!activity) return false;
  return activity.getUTCFullYear() === now.getUTCFullYear() &&
    activity.getUTCMonth() === now.getUTCMonth() &&
    activity.getUTCDate() === now.getUTCDate();
}

function teamStatusSummary(team = [], presenceRows = [], attendanceRows = []) {
  const summary = {
    operating: 0,
    break: 0,
    meeting: 0,
    handling: 0,
    unavailable: 0,
    late: 0,
    absent: 0,
  };

  for (const employee of team) {
    const status = statusOf(employee, presenceRows);
    if (Object.prototype.hasOwnProperty.call(summary, status)) summary[status] += 1;
    else summary.unavailable += 1;

    const attendance = findAttendance(employee, attendanceRows);
    if (attendance?.late === true || clean(attendance?.attendanceStatus) === "late") summary.late += 1;
    if (attendance?.absent === true || clean(attendance?.attendanceStatus) === "absent") summary.absent += 1;
  }
  return summary;
}

function ticketSummary(tickets = [], now = new Date()) {
  return {
    totalVisible: tickets.length,
    active: tickets.filter(ticketVisibleInDefaultQueue).length,
    emergency: tickets.filter((ticket) => ticketVisibleInDefaultQueue(ticket) && isEmergency(ticket)).length,
    escalated: tickets.filter((ticket) => ticketVisibleInDefaultQueue(ticket) && ticketStatus(ticket) === "escalated").length,
    resolvedToday: tickets.filter((ticket) => resolvedToday(ticket, now)).length,
    overdue: tickets.filter((ticket) => isOverdue(ticket, now)).length,
  };
}

export function buildSupervisorDashboard(supervisor, {
  employees = [],
  tickets = [],
  presenceRows = [],
  attendanceRows = [],
  now = new Date(),
} = {}) {
  const role = normaliseCanonicalRole(supervisor?.roleKey || supervisor?.role);
  if (role !== EMPLOYEE_ROLES.SUPERVISOR) throw new Error("Supervisor dashboard requires a Supervisor actor.");
  const projectId = projectForTicketActor(supervisor);
  const group = supervisorTeam(projectId, uid(supervisor), employees);
  const team = group.agents;
  const visibleTickets = searchableTickets(supervisor, tickets, employees);

  return {
    role: EMPLOYEE_ROLES.SUPERVISOR,
    projectId,
    supervisor: { ...group.supervisor },
    team: team.map((row) => ({ ...row })),
    teamSize: team.length,
    status: teamStatusSummary(team, presenceRows, attendanceRows),
    tickets: ticketSummary(visibleTickets, now),
  };
}

export function buildAcmDashboard(acm, {
  employees = [],
  tickets = [],
  presenceRows = [],
  attendanceRows = [],
  now = new Date(),
} = {}) {
  const role = normaliseCanonicalRole(acm?.roleKey || acm?.role);
  if (role !== EMPLOYEE_ROLES.ACM) throw new Error("ACM dashboard requires an ACM actor.");
  const projectId = projectForTicketActor(acm);
  const hierarchy = buildProjectHierarchy(projectId, employees);
  const projectEmployees = [
    ...hierarchy.acms,
    ...hierarchy.hrs,
    ...hierarchy.supervisors.flatMap((group) => [group.supervisor, ...group.agents]),
    ...hierarchy.unassignedAgents,
  ];
  const unique = [...new Map(projectEmployees.map((row) => [uid(row) || ccms(row), row])).values()];
  const visibleTickets = searchableTickets(acm, tickets, employees);

  return {
    role: EMPLOYEE_ROLES.ACM,
    projectId,
    hierarchy,
    employees: unique.map((row) => ({ ...row })),
    employeeCount: unique.length,
    supervisors: hierarchy.totals.supervisors,
    agents: hierarchy.totals.agents,
    status: teamStatusSummary(unique.filter((row) => normaliseCanonicalRole(row.roleKey || row.role) === EMPLOYEE_ROLES.AGENT), presenceRows, attendanceRows),
    tickets: ticketSummary(visibleTickets, now),
  };
}
