// ticket-runtime-policy-adapter.js — bridges legacy live sessions/directory rows
// into the already-tested project/team Ticket policy.
//
// Pure module: no DOM, Firebase, storage or network access.

import {
  canAssignTicket,
  canViewTicket,
  ticketProjectId,
} from './ticket-access-policy.js';
import {
  CURRENT_EMPLOYEE_IDENTITY_SEED,
  seedIdentityByCcms,
} from './employee-identity-seed.js';

function clean(value) {
  return String(value ?? '').trim();
}

function canonicalRole(role) {
  const value = clean(role).toLowerCase();
  if (value === 'admin') return 'ceo';
  if (value === 'manager') return 'acm';
  if (['ceo', 'acm', 'supervisor', 'hr', 'agent'].includes(value)) return value;
  return 'agent';
}

function fallbackUid(ccmsId) {
  const id = clean(ccmsId);
  return id ? `legacy_ccms_${id}` : '';
}

export function runtimeEmployeeIdentity(row = {}, directoryRows = []) {
  const ccmsId = clean(row.ccmsId || row.employeeId || row.id);
  if (!ccmsId) return null;
  const seeded = seedIdentityByCcms(ccmsId);
  const supervisorCcmsId = clean(
    row.supervisorCcmsId || row.supervisorId || seeded?.supervisorCcmsId
  );
  const supervisorSeed = supervisorCcmsId ? seedIdentityByCcms(supervisorCcmsId) : null;
  const directorySupervisor = supervisorCcmsId
    ? (directoryRows || []).find((candidate) => clean(candidate.ccmsId || candidate.id) === supervisorCcmsId)
    : null;

  const projectId = clean(row.projectId || seeded?.projectId || 'ipro') || 'ipro';
  const rawProjectIds = Array.isArray(row.projectIds)
    ? row.projectIds
    : Array.isArray(seeded?.projectIds)
      ? seeded.projectIds
      : [projectId];
  const projectIds = [...new Set(rawProjectIds.map(clean).filter(Boolean))];

  return {
    ...(seeded || {}),
    employeeUid: clean(row.employeeUid || seeded?.employeeUid || fallbackUid(ccmsId)),
    ccmsId,
    fullName: clean(row.fullName || row.name || seeded?.fullName || ccmsId),
    roleKey: canonicalRole(row.roleKey || row.role || seeded?.roleKey),
    projectId,
    projectIds,
    supervisorCcmsId,
    supervisorUid: clean(
      row.supervisorUid ||
      seeded?.supervisorUid ||
      supervisorSeed?.employeeUid ||
      directorySupervisor?.employeeUid ||
      fallbackUid(supervisorCcmsId)
    ),
    accountStatus: clean(row.accountStatus || seeded?.accountStatus || 'active') || 'active',
  };
}

export function runtimeEmployees(directoryRows = []) {
  const byCcms = new Map();

  // Approved identity seed carries project/supervisor structure for the seven
  // compatibility accounts even when the legacy employee collection does not.
  for (const seed of CURRENT_EMPLOYEE_IDENTITY_SEED) {
    const row = runtimeEmployeeIdentity(seed, directoryRows);
    if (row) byCcms.set(row.ccmsId, row);
  }

  for (const directory of directoryRows || []) {
    const row = runtimeEmployeeIdentity(directory, directoryRows);
    if (!row) continue;
    const existing = byCcms.get(row.ccmsId) || {};
    byCcms.set(row.ccmsId, { ...existing, ...row });
  }

  return [...byCcms.values()];
}

export function runtimeTicketActor(session = {}, directoryRows = []) {
  const ccmsId = clean(session.ccmsId || session.id);
  if (!ccmsId) return null;
  const employeeRows = runtimeEmployees(directoryRows);
  const directory = (directoryRows || []).find((row) => clean(row.ccmsId || row.id) === ccmsId) || {};
  const employee = employeeRows.find((row) => row.ccmsId === ccmsId);
  return runtimeEmployeeIdentity({
    ...employee,
    ...directory,
    ...session,
    ccmsId,
    roleKey: session.roleKey || session.role || employee?.roleKey,
  }, directoryRows);
}

export function runtimeTicketProjectId(session = {}, directoryRows = []) {
  const actor = runtimeTicketActor(session, directoryRows);
  return clean(actor?.projectId || 'ipro') || 'ipro';
}

export function runtimeCanOpenTickets(session = {}, directoryRows = []) {
  const actor = runtimeTicketActor(session, directoryRows);
  if (!actor) return false;
  return ['ceo', 'acm', 'supervisor', 'agent'].includes(actor.roleKey);
}

export function runtimeCanViewTicket(session, ticket, directoryRows = []) {
  const actor = runtimeTicketActor(session, directoryRows);
  if (!actor) return false;
  return canViewTicket(actor, ticket, runtimeEmployees(directoryRows));
}

export function runtimeTicketScope(session = {}, directoryRows = []) {
  const actor = runtimeTicketActor(session, directoryRows);
  const employees = runtimeEmployees(directoryRows);
  if (!actor || actor.roleKey === 'hr') return { mode: 'none', projectId: '', assignmentIds: [] };
  if (actor.roleKey === 'ceo') return { mode: 'global', projectId: '', assignmentIds: [] };
  if (actor.roleKey === 'acm') {
    return { mode: 'project', projectId: actor.projectId || 'ipro', assignmentIds: [] };
  }
  if (actor.roleKey === 'supervisor') {
    const assignmentIds = employees
      .filter((employee) => employee.projectId === actor.projectId)
      .filter((employee) => employee.ccmsId === actor.ccmsId || employee.supervisorCcmsId === actor.ccmsId)
      .map((employee) => employee.ccmsId);
    return { mode: 'assignments', projectId: actor.projectId || 'ipro', assignmentIds: [...new Set(assignmentIds)] };
  }
  return { mode: 'assignments', projectId: actor.projectId || 'ipro', assignmentIds: [actor.ccmsId] };
}

export function runtimeAssignmentCandidates(session = {}, directoryRows = [], ticket = null) {
  const actor = runtimeTicketActor(session, directoryRows);
  const employees = runtimeEmployees(directoryRows)
    .filter((employee) => employee.accountStatus === 'active');
  if (!actor || actor.roleKey === 'hr') return [];

  // Agents create work for themselves but cannot reassign an existing ticket.
  if (actor.roleKey === 'agent') {
    if (ticket) return [];
    return employees.filter((employee) => employee.ccmsId === actor.ccmsId);
  }

  const ticketLike = ticket || { projectId: actor.projectId || 'ipro' };
  return employees.filter((employee) => canAssignTicket(actor, ticketLike, employee, employees));
}

export function runtimeTicketProjectMatches(session, ticket, directoryRows = []) {
  const actor = runtimeTicketActor(session, directoryRows);
  if (!actor) return false;
  if (actor.roleKey === 'ceo') return true;
  return ticketProjectId(ticket) === (actor.projectId || 'ipro');
}
