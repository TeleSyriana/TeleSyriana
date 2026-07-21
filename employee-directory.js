// employee-directory.js — TeleSyriana Phase 1 synchronising facade
// The full directory implementation is preserved byte-for-byte in
// employee-directory-core.js. This facade adds operational permission guards
// plus a browser event after successful employee writes so dependent modules
// refresh immediately.
//
// These guards are defense-in-depth for the current custom-login model. They do
// not replace server-enforced authorization/Firebase Auth, which is a separate
// security migration.

export * from './employee-directory-core.js';

import {
  getEmployee as getEmployeeCore,
  listEmployees as listEmployeesCore,
  normaliseAccountStatus,
  normaliseRole,
  saveEmployee as saveEmployeeCore,
  setEmployeeRole as setEmployeeRoleCore,
  setEmployeeStatus as setEmployeeStatusCore,
} from './employee-directory-core.js';

const MANAGEMENT_ROLES = new Set(['admin', 'manager', 'hr']);

function cleanId(value) {
  return String(value || '').trim();
}

function actorRole(actor = null) {
  return normaliseRole(actor?.role);
}

function assertManagementActor(actor = null) {
  if (!cleanId(actor?.id) || !MANAGEMENT_ROLES.has(actorRole(actor))) {
    throw new Error('HR, Manager or Admin permission is required.');
  }
}

function allowedRolesForActor(actor = null) {
  const role = actorRole(actor);
  if (role === 'admin') return ['agent', 'supervisor', 'hr', 'manager', 'admin'];
  if (role === 'manager') return ['agent', 'supervisor', 'hr', 'manager'];
  if (role === 'hr') return ['agent', 'supervisor', 'hr'];
  return [];
}

function assertRoleAssignment(actor, role) {
  const requested = normaliseRole(role);
  if (!allowedRolesForActor(actor).includes(requested)) {
    throw new Error(`You do not have permission to assign the ${requested} role.`);
  }
  return requested;
}

function assertTargetPermission(target, actor = null) {
  assertManagementActor(actor);
  if (!target) return;

  const actingRole = actorRole(actor);
  const targetRole = normaliseRole(target.role);
  if (actingRole === 'admin') return;
  if (targetRole === 'admin') throw new Error('Only Admin can manage an Admin account.');
  if (actingRole === 'manager') return;
  if (!['agent', 'supervisor', 'hr'].includes(targetRole)) {
    throw new Error('HR cannot manage Manager/Admin accounts.');
  }
}

function isSelf(targetId, actor = null) {
  return Boolean(cleanId(targetId) && cleanId(targetId) === cleanId(actor?.id));
}

async function assertSupervisorTeamCanChange(target, nextRole = target?.role, nextStatus = target?.accountStatus) {
  if (!target || normaliseRole(target.role) !== 'supervisor') return;
  if (normaliseRole(nextRole) === 'supervisor' && normaliseAccountStatus(nextStatus) === 'active') return;

  const rows = await listEmployeesCore({ includeDisabled: true, includeArchived: true });
  const directReports = rows.filter((row) =>
    cleanId(row.id) !== cleanId(target.id) &&
    cleanId(row.supervisorId) === cleanId(target.id) &&
    normaliseAccountStatus(row.accountStatus) === 'active'
  );

  if (directReports.length) {
    const names = directReports.slice(0, 4).map((row) => row.name || row.id).join(', ');
    const extra = directReports.length > 4 ? ` +${directReports.length - 4}` : '';
    throw new Error(`Reassign ${directReports.length} active team member(s) before changing this Supervisor: ${names}${extra}`);
  }
}

function notifyDirectoryChanged(detail = {}) {
  try {
    window.dispatchEvent(new CustomEvent('telesyriana:employee-directory-changed', { detail }));
  } catch {}
}

export async function saveEmployee(input = {}, actor = null) {
  assertManagementActor(actor);

  const employeeId = cleanId(input.id || input.employeeId || input.ccmsId);
  const existing = employeeId
    ? await getEmployeeCore(employeeId, { allowLegacyFallback: true })
    : null;

  if (existing) assertTargetPermission(existing, actor);

  const nextInput = { ...input };
  if (existing) {
    if (!String(nextInput.role || '').trim()) nextInput.role = existing.role;
    if (!String(nextInput.accountStatus || '').trim()) nextInput.accountStatus = existing.accountStatus;
  }

  if (existing && isSelf(existing.id, actor)) {
    // Managers can edit their own normal profile fields, but may not use the
    // employee service to remove their own management access or disable self.
    nextInput.role = existing.role;
    nextInput.accountStatus = existing.accountStatus;
  }

  const requestedRole = assertRoleAssignment(actor, nextInput.role || existing?.role || 'agent');
  nextInput.role = requestedRole;
  nextInput.accountStatus = normaliseAccountStatus(nextInput.accountStatus || existing?.accountStatus || 'active');

  if (existing) {
    await assertSupervisorTeamCanChange(existing, nextInput.role, nextInput.accountStatus);
  }

  const result = await saveEmployeeCore(nextInput, actor);
  notifyDirectoryChanged({ action: 'save', employeeId: result?.id || employeeId });
  return result;
}

export async function setEmployeeStatus(id, status, actor = null) {
  assertManagementActor(actor);
  const employee = await getEmployeeCore(id, { allowLegacyFallback: true });
  if (!employee) throw new Error('Employee not found.');
  assertTargetPermission(employee, actor);

  const nextStatus = normaliseAccountStatus(status);
  if (isSelf(employee.id, actor) && nextStatus !== normaliseAccountStatus(employee.accountStatus)) {
    throw new Error('You cannot change your own account status.');
  }

  await assertSupervisorTeamCanChange(employee, employee.role, nextStatus);
  const result = await setEmployeeStatusCore(id, nextStatus, actor);
  notifyDirectoryChanged({ action: 'status', employeeId: String(id || ''), status: nextStatus });
  return result;
}

export async function setEmployeeRole(id, role, actor = null) {
  assertManagementActor(actor);
  const employee = await getEmployeeCore(id, { allowLegacyFallback: true });
  if (!employee) throw new Error('Employee not found.');
  assertTargetPermission(employee, actor);

  const nextRole = assertRoleAssignment(actor, role);
  if (isSelf(employee.id, actor) && nextRole !== normaliseRole(employee.role)) {
    throw new Error('You cannot change your own management role.');
  }

  await assertSupervisorTeamCanChange(employee, nextRole, employee.accountStatus);
  const result = await setEmployeeRoleCore(id, nextRole, actor);
  notifyDirectoryChanged({ action: 'role', employeeId: String(id || ''), role: nextRole });
  return result;
}
