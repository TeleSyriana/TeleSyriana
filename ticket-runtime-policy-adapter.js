// ticket-runtime-policy-adapter.js — bridges legacy live sessions/directory rows
// into the project/team Ticket policy.
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

function identityAliases(employee = {}) {
  return [...new Set([
    clean(employee.ccmsId),
    ...(employee.previousCcmsIds || []).map(clean),
  ].filter(Boolean))];
}

export function runtimeEmployeeIdentity(row = {}, directoryRows = []) {
  const requestedCcmsId = clean(row.ccmsId || row.employeeId || row.id);
  if (!requestedCcmsId) return null;
  const seeded = seedIdentityByCcms(requestedCcmsId);
  const effectiveCcmsId = clean(seeded?.ccmsId || requestedCcmsId);
  const seededIsAuthoritative = Boolean(seeded);

  const supervisorCcmsId = clean(
    seededIsAuthoritative
      ? seeded?.supervisorCcmsId
      : (row.supervisorCcmsId || row.supervisorId)
  );
  const supervisorSeed = supervisorCcmsId ? seedIdentityByCcms(supervisorCcmsId) : null;
  const directorySupervisor = supervisorCcmsId
    ? (directoryRows || []).find((candidate) => clean(candidate.ccmsId || candidate.id) === supervisorCcmsId)
    : null;

  const projectId = clean(
    seededIsAuthoritative
      ? seeded?.projectId
      : (row.projectId || 'ipro')
  ) || 'ipro';
  const rawProjectIds = seededIsAuthoritative && Array.isArray(seeded?.projectIds)
    ? seeded.projectIds
    : Array.isArray(row.projectIds)
      ? row.projectIds
      : [projectId];
  const projectIds = [...new Set(rawProjectIds.map(clean).filter(Boolean))];

  return {
    ...(seeded || {}),
    employeeUid: clean(seeded?.employeeUid || row.employeeUid || fallbackUid(effectiveCcmsId)),
    ccmsId: effectiveCcmsId,
    previousCcmsIds: [...new Set([...(seeded?.previousCcmsIds || [])].map(clean).filter(Boolean))],
    fullName: clean(seeded?.fullName || row.fullName || row.name || effectiveCcmsId),
    roleKey: canonicalRole(seeded?.roleKey || row.roleKey || row.role),
    projectId,
    projectIds,
    supervisorCcmsId,
    supervisorUid: clean(
      seeded?.supervisorUid ||
      row.supervisorUid ||
      supervisorSeed?.employeeUid ||
      directorySupervisor?.employeeUid ||
      fallbackUid(supervisorCcmsId)
    ),
    accountStatus: clean(seeded?.accountStatus || row.accountStatus || 'active') || 'active',
  };
}

export function runtimeEmployees(directoryRows = []) {
  const byCcms = new Map();

  for (const seed of CURRENT_EMPLOYEE_IDENTITY_SEED) {
    const row = runtimeEmployeeIdentity(seed, directoryRows);
    if (row) byCcms.set(row.ccmsId, row);
  }

  for (const directory of directoryRows || []) {
    const row = runtimeEmployeeIdentity(directory, directoryRows);
    if (!row) continue;
    const existing = byCcms.get(row.ccmsId) || {};
    byCcms.set(row.ccmsId, { ...directory, ...existing, ...row });
  }

  return [...byCcms.values()];
}

export function runtimeTicketActor(session = {}, directoryRows = []) {
  const requestedCcmsId = clean(session.ccmsId || session.id);
  if (!requestedCcmsId) return null;
  const employeeRows = runtimeEmployees(directoryRows);
  const seeded = seedIdentityByCcms(requestedCcmsId);
  const effectiveCcmsId = clean(seeded?.ccmsId || requestedCcmsId);
  const directory = (directoryRows || []).find((row) => clean(row.ccmsId || row.id) === requestedCcmsId) || {};
  const employee = employeeRows.find((row) => row.ccmsId === effectiveCcmsId);
  return runtimeEmployeeIdentity({
    ...directory,
    ...session,
    ...employee,
    ccmsId: effectiveCcmsId,
    roleKey: employee?.roleKey || session.roleKey || session.role,
  }, directoryRows);
}

export function runtimeTicketProjectId(session = {}, directoryRows = []) {
  const actor = runtimeTicketActor(session, directoryRows);
  return clean(actor?.projectId || 'ipro') || 'ipro';
}

export function runtimeCanOpenTickets(session = {}, directoryRows = []) {
  const actor = runtimeTicketActor(session, directoryRows);
  if (!actor || actor.accountStatus !== 'active') return false;
  return ['ceo', 'acm', 'supervisor', 'agent'].includes(actor.roleKey);
}

export function runtimeCanViewTicket(session, ticket, directoryRows = []) {
  const actor = runtimeTicketActor(session, directoryRows);
  if (!actor || actor.accountStatus !== 'active') return false;
  const projectId = ticketProjectId(ticket);
  if (actor.roleKey !== 'ceo' && projectId !== (actor.projectId || 'ipro')) return false;

  const assignedTo = clean(ticket?.assignedTo || ticket?.assignedCcmsId || ticket?.assignedEmployeeId);
  if (identityAliases(actor).includes(assignedTo)) return true;

  return canViewTicket(actor, ticket, runtimeEmployees(directoryRows));
}

export function runtimeTicketScope(session = {}, directoryRows = []) {
  const actor = runtimeTicketActor(session, directoryRows);
  const employees = runtimeEmployees(directoryRows);
  if (!actor || actor.accountStatus !== 'active' || actor.roleKey === 'hr') {
    return { mode: 'none', projectId: '', assignmentIds: [] };
  }
  if (actor.roleKey === 'ceo') return { mode: 'global', projectId: '', assignmentIds: [] };
  if (actor.roleKey === 'acm') {
    return { mode: 'project', projectId: actor.projectId || 'ipro', assignmentIds: [] };
  }
  if (actor.roleKey === 'supervisor') {
    const assignmentIds = employees
      .filter((employee) => employee.accountStatus === 'active')
      .filter((employee) => employee.projectId === actor.projectId)
      .filter((employee) => employee.ccmsId === actor.ccmsId || employee.supervisorCcmsId === actor.ccmsId)
      .flatMap((employee) => identityAliases(employee));
    return {
      mode: 'assignments',
      projectId: actor.projectId || 'ipro',
      assignmentIds: [...new Set([...assignmentIds, ...identityAliases(actor)])],
    };
  }
  return {
    mode: 'assignments',
    projectId: actor.projectId || 'ipro',
    assignmentIds: identityAliases(actor),
  };
}

export function runtimeAssignmentCandidates(session = {}, directoryRows = [], ticket = null) {
  const actor = runtimeTicketActor(session, directoryRows);
  const employees = runtimeEmployees(directoryRows)
    .filter((employee) => employee.accountStatus === 'active');
  if (!actor || actor.accountStatus !== 'active' || actor.roleKey === 'hr') return [];

  if (actor.roleKey === 'agent') {
    return employees.filter((employee) => employee.ccmsId === actor.ccmsId);
  }

  const ticketLike = ticket || { projectId: actor.projectId || 'ipro' };
  return employees.filter((employee) => canAssignTicket(actor, ticketLike, employee, employees));
}

export function runtimeCanSetTicketAssignment(session, ticket, targetCcmsId, directoryRows = []) {
  const actor = runtimeTicketActor(session, directoryRows);
  if (!actor || actor.accountStatus !== 'active' || actor.roleKey === 'hr') return false;
  const targetId = clean(targetCcmsId);

  if (!targetId) {
    return ['ceo', 'acm', 'supervisor'].includes(actor.roleKey);
  }

  if (actor.roleKey === 'agent') {
    return identityAliases(actor).includes(targetId) && runtimeCanViewTicket(session, ticket, directoryRows);
  }

  const employees = runtimeEmployees(directoryRows);
  const target = employees.find((employee) => identityAliases(employee).includes(targetId));
  return Boolean(target && target.accountStatus === 'active' && canAssignTicket(actor, ticket, target, employees));
}

export function runtimeEscalationTarget(session = {}, directoryRows = []) {
  const actor = runtimeTicketActor(session, directoryRows);
  if (!actor || actor.accountStatus !== 'active') return null;
  const employees = runtimeEmployees(directoryRows).filter((employee) => employee.accountStatus === 'active');

  if (actor.roleKey === 'agent') {
    return employees.find((employee) =>
      employee.roleKey === 'supervisor' &&
      employee.projectId === actor.projectId &&
      employee.employeeUid === actor.supervisorUid
    ) || null;
  }

  if (actor.roleKey === 'supervisor') {
    return employees.find((employee) => employee.roleKey === 'acm' && employee.projectId === actor.projectId) || null;
  }

  return null;
}

export function runtimeTicketProjectMatches(session, ticket, directoryRows = []) {
  const actor = runtimeTicketActor(session, directoryRows);
  if (!actor || actor.accountStatus !== 'active') return false;
  if (actor.roleKey === 'ceo') return true;
  return ticketProjectId(ticket) === (actor.projectId || 'ipro');
}
