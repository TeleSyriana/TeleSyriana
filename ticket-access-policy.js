// ticket-access-policy.js — project/team aware Ticket visibility and queue rules
//
// Pure policy only. No Firebase/Firestore/DOM dependency. Existing ticket UI can
// later consume this policy without changing its storage implementation first.

import {
  EMPLOYEE_ROLES,
  normaliseCanonicalRole,
  normaliseProjectId,
} from "./employee-model.js";
import {
  actorCanAccessProject,
  canSupervisorManageAgent,
  projectActor,
  resolveActorProject,
} from "./project-access-policy.js";

const RESOLVED_STATUSES = new Set(["resolved", "closed"]);
const ACTIVE_STATUSES = new Set([
  "open",
  "waiting_customer",
  "waiting_courier",
  "waiting_supplier",
  "escalated",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function employeeUid(row = {}) {
  return clean(row.employeeUid || row.uid);
}

function employeeCcms(row = {}) {
  return clean(row.ccmsId || row.id);
}

function assignmentMatches(ticket, employee) {
  const assignedUid = clean(ticket?.assignedEmployeeUid || ticket?.assignedUid);
  const assignedCcms = clean(ticket?.assignedTo || ticket?.assignedCcmsId || ticket?.assignedEmployeeId);
  const uid = employeeUid(employee);
  const ccms = employeeCcms(employee);
  return Boolean((assignedUid && uid && assignedUid === uid) || (assignedCcms && ccms && assignedCcms === ccms));
}

export function ticketProjectId(ticket = {}) {
  return normaliseProjectId(ticket.projectId || ticket.project || "ipro") || "ipro";
}

export function ticketStatus(ticket = {}) {
  return clean(ticket.status || "open").toLowerCase();
}

export function ticketIsResolved(ticket = {}) {
  return RESOLVED_STATUSES.has(ticketStatus(ticket));
}

export function ticketIsActive(ticket = {}) {
  const status = ticketStatus(ticket);
  return ACTIVE_STATUSES.has(status) || (!RESOLVED_STATUSES.has(status) && Boolean(status));
}

export function ticketVisibleInDefaultQueue(ticket = {}) {
  return ticketIsActive(ticket) && !ticketIsResolved(ticket);
}

export function directReportsForSupervisor(supervisor, employees = []) {
  return (employees || []).filter((employee) => canSupervisorManageAgent(supervisor, employee));
}

export function canViewTicket(actor, ticket, employees = []) {
  const a = projectActor(actor);
  const projectId = ticketProjectId(ticket);
  if (!actorCanAccessProject(a, projectId)) return false;

  if (a.roleKey === EMPLOYEE_ROLES.CEO) return true;
  if (a.roleKey === EMPLOYEE_ROLES.ACM) return true;
  if (a.roleKey === EMPLOYEE_ROLES.HR) return false;

  if (a.roleKey === EMPLOYEE_ROLES.SUPERVISOR) {
    if (assignmentMatches(ticket, a)) return true;
    const team = directReportsForSupervisor(a, employees);
    return team.some((agent) => assignmentMatches(ticket, agent));
  }

  if (a.roleKey === EMPLOYEE_ROLES.AGENT) {
    return assignmentMatches(ticket, a);
  }

  return false;
}

export function visibleTicketsForActor(actor, tickets = [], employees = [], { includeResolved = true } = {}) {
  return (tickets || []).filter((ticket) => {
    if (!canViewTicket(actor, ticket, employees)) return false;
    return includeResolved || !ticketIsResolved(ticket);
  });
}

export function defaultTicketQueue(actor, tickets = [], employees = []) {
  return visibleTicketsForActor(actor, tickets, employees, { includeResolved: false })
    .filter(ticketVisibleInDefaultQueue);
}

export function searchableTickets(actor, tickets = [], employees = []) {
  // Historical/resolved tickets remain searchable as long as the actor has the
  // same project/team permission that would have applied while the ticket was open.
  return visibleTicketsForActor(actor, tickets, employees, { includeResolved: true });
}

export function canAssignTicket(actor, ticket, targetEmployee, employees = []) {
  const a = projectActor(actor);
  const projectId = ticketProjectId(ticket);
  if (!actorCanAccessProject(a, projectId)) return false;
  if (!targetEmployee || ticketProjectId({ projectId: targetEmployee.projectId }) !== projectId) return false;

  const targetRole = normaliseCanonicalRole(targetEmployee.roleKey || targetEmployee.role);
  if (![EMPLOYEE_ROLES.SUPERVISOR, EMPLOYEE_ROLES.AGENT].includes(targetRole)) return false;

  if (a.roleKey === EMPLOYEE_ROLES.CEO || a.roleKey === EMPLOYEE_ROLES.ACM) return true;
  if (a.roleKey === EMPLOYEE_ROLES.SUPERVISOR) {
    if (employeeUid(targetEmployee) === a.employeeUid || employeeCcms(targetEmployee) === a.ccmsId) return true;
    return canSupervisorManageAgent(a, targetEmployee);
  }
  return false;
}

export function ticketActivityDate(ticket = {}) {
  const raw = ticket.updatedAt || ticket.modifiedAt || ticket.lastActivityAt || ticket.createdAt || null;
  if (!raw) return null;
  if (raw instanceof Date) return raw;
  if (typeof raw?.toDate === "function") return raw.toDate();
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

export function ticketMatchesDateFilter(ticket, filter, now = new Date()) {
  const mode = clean(filter || "all").toLowerCase();
  if (mode === "all") return true;
  const activity = ticketActivityDate(ticket);
  if (!activity) return false;

  const today = startOfDay(now);
  const ticketDay = startOfDay(activity);
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor((today - ticketDay) / dayMs);

  if (mode === "today") return diffDays === 0;
  if (mode === "yesterday") return diffDays === 1;
  if (mode === "last_week") return diffDays >= 0 && diffDays <= 7;
  if (mode === "last_month") return diffDays >= 0 && diffDays <= 30;
  return true;
}

export function projectForTicketActor(actor, requestedProjectId = "") {
  return resolveActorProject(actor, requestedProjectId);
}
