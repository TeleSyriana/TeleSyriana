// employee-management-service.js — Phase 1B employee/account management facade
//
// All future Employees & Accounts UI writes should go through this service.
// It combines the pure management policy with the permanent identity store.

import {
  EMPLOYEE_ROLES,
  nextAvailableCcmsId,
  normaliseCanonicalRole,
  normaliseProjectIds,
} from "./employee-model.js";
import {
  createEmployeeIdentity,
  listEmployeeIdentities,
  reclassifyEmployee,
  updateEmployeeIdentity,
} from "./employee-identity-store.js";
import { listProjects } from "./project-directory.js";
import {
  actorAssignedToProject,
  allowedRolesForCreation,
  assertProjectAssignmentAllowed,
  canManageEmployeeTarget,
  canModifyDirectoryRow,
  canOpenEmployeesAccounts,
  managementActorIdentity,
  visibleProjectsForActor,
} from "./employee-management-policy.js";

// Phase 1B deliberately remains false until the controlled dynamic login /
// credential provisioning bridge is implemented and browser-tested. This stops
// an accidentally mounted UI from creating an identity that cannot sign in.
export const EMPLOYEE_ACCOUNT_PROVISIONING_READY = false;

function clean(value) {
  return String(value ?? "").trim();
}

function assertManagementAccess(actor) {
  if (!canOpenEmployeesAccounts(actor)) {
    throw new Error("CEO, ACM or HR permission is required for Employees & Accounts.");
  }
}

function assertAccountProvisioningReady() {
  if (!EMPLOYEE_ACCOUNT_PROVISIONING_READY) {
    throw new Error("Account provisioning is locked until the controlled login/credential bridge is ready.");
  }
}

function assertWritableTarget(actor, target) {
  if (!target) throw new Error("Employee not found.");
  if (!canManageEmployeeTarget(actor, target)) {
    throw new Error("You do not have permission to manage this employee.");
  }
  if (!canModifyDirectoryRow(actor, target)) {
    throw new Error("This employee is still using the compatibility identity. Complete the permanent migration before editing this account.");
  }
}

function employeeProjects(row) {
  return normaliseProjectIds(row?.projectIds || row?.projectId || []);
}

function sharesActorProject(actor, row) {
  const a = managementActorIdentity(actor);
  if (a.roleKey === EMPLOYEE_ROLES.CEO) return true;
  return employeeProjects(row).some((projectId) => a.projectIds.includes(projectId));
}

export async function listEmployeesForManagement(actor, options = {}) {
  assertManagementAccess(actor);
  const rows = await listEmployeeIdentities({
    includeDisabled: options.includeDisabled !== false,
    includeArchived: options.includeArchived !== false,
    includeSeedFallback: true,
  });

  const visible = rows.filter((row) => sharesActorProject(actor, row));
  return visible.sort((a, b) => String(a.fullName || "").localeCompare(String(b.fullName || "")));
}

export async function getEmployeesAccountsContext(actor) {
  assertManagementAccess(actor);
  const [employees, projects] = await Promise.all([
    listEmployeesForManagement(actor),
    listProjects({ includeDisabled: true, includeArchived: false }),
  ]);

  const allowedProjects = visibleProjectsForActor(actor, projects);
  const firestoreCount = employees.filter((row) => row.directorySource === "firestore").length;
  const compatibilityCount = employees.filter((row) => row.directorySource !== "firestore").length;

  return {
    actor: managementActorIdentity(actor),
    employees,
    projects: allowedProjects,
    allowedCreationRoles: allowedRolesForCreation(actor),
    directoryHealth: {
      firestoreCount,
      compatibilityCount,
      migrationPending: compatibilityCount > 0,
      accountProvisioningReady: EMPLOYEE_ACCOUNT_PROVISIONING_READY,
    },
  };
}

async function allUsedCcmsIds() {
  const rows = await listEmployeeIdentities({ includeDisabled: true, includeArchived: true, includeSeedFallback: true });
  return rows.map((row) => row.ccmsId).filter(Boolean);
}

export async function nextManagedCcmsId(role) {
  return nextAvailableCcmsId(role, await allUsedCcmsIds());
}

function normaliseCreationProjects(input, role) {
  const roleKey = normaliseCanonicalRole(role);
  if (roleKey === EMPLOYEE_ROLES.HR) {
    return normaliseProjectIds(input.projectIds || input.projectId || []);
  }
  return normaliseProjectIds(input.projectId || input.projectIds || []);
}

export async function createManagedEmployee(actor, input = {}) {
  assertManagementAccess(actor);
  assertAccountProvisioningReady();
  const roleKey = normaliseCanonicalRole(input.roleKey || input.role);
  if (!allowedRolesForCreation(actor).includes(roleKey)) {
    throw new Error(`You do not have permission to create a ${roleKey} account.`);
  }

  const projectIds = normaliseCreationProjects(input, roleKey);
  assertProjectAssignmentAllowed(actor, roleKey, projectIds);

  const ccmsId = clean(input.ccmsId) || await nextManagedCcmsId(roleKey);
  const projectId = clean(input.projectId) || projectIds[0] || "";

  return createEmployeeIdentity({
    ...input,
    ccmsId,
    roleKey,
    projectId,
    projectIds,
    supervisorCcmsId: clean(input.supervisorCcmsId || input.supervisorId),
  }, actor);
}

export async function updateManagedEmployee(actor, employeeUid, patch = {}) {
  assertManagementAccess(actor);
  assertAccountProvisioningReady();
  const rows = await listEmployeeIdentities({ includeDisabled: true, includeArchived: true, includeSeedFallback: true });
  const target = rows.find((row) => clean(row.employeeUid) === clean(employeeUid));
  assertWritableTarget(actor, target);

  if (Object.prototype.hasOwnProperty.call(patch, "roleKey") || Object.prototype.hasOwnProperty.call(patch, "role")) {
    const requested = normaliseCanonicalRole(patch.roleKey || patch.role);
    if (requested !== target.roleKey) {
      throw new Error("Use the Promote/Demote action to change an employee role so CCMS is reclassified safely.");
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "ccmsId") && clean(patch.ccmsId) !== target.ccmsId) {
    throw new Error("CCMS changes are handled only through controlled role reclassification.");
  }

  const nextProjects = normaliseProjectIds(patch.projectIds || patch.projectId || target.projectIds);
  assertProjectAssignmentAllowed(actor, target.roleKey, nextProjects);

  return updateEmployeeIdentity(target.employeeUid, {
    fullName: Object.prototype.hasOwnProperty.call(patch, "fullName") ? patch.fullName : target.fullName,
    projectId: Object.prototype.hasOwnProperty.call(patch, "projectId") ? patch.projectId : target.projectId,
    projectIds: nextProjects,
    supervisorUid: Object.prototype.hasOwnProperty.call(patch, "supervisorUid") ? patch.supervisorUid : target.supervisorUid,
    supervisorCcmsId: Object.prototype.hasOwnProperty.call(patch, "supervisorCcmsId") ? patch.supervisorCcmsId : target.supervisorCcmsId,
    hourlyRate: Object.prototype.hasOwnProperty.call(patch, "hourlyRate") ? patch.hourlyRate : target.hourlyRate,
    currency: Object.prototype.hasOwnProperty.call(patch, "currency") ? patch.currency : target.currency,
    timezone: Object.prototype.hasOwnProperty.call(patch, "timezone") ? patch.timezone : target.timezone,
    language: Object.prototype.hasOwnProperty.call(patch, "language") ? patch.language : target.language,
  }, actor);
}

async function activeDirectReports(supervisorUid) {
  const rows = await listEmployeeIdentities({ includeDisabled: true, includeArchived: true, includeSeedFallback: true });
  return rows.filter((row) =>
    row.roleKey === EMPLOYEE_ROLES.AGENT &&
    row.accountStatus === "active" &&
    clean(row.supervisorUid) === clean(supervisorUid)
  );
}

async function assertSupervisorHasNoActiveTeam(target) {
  if (target?.roleKey !== EMPLOYEE_ROLES.SUPERVISOR) return;
  const reports = await activeDirectReports(target.employeeUid);
  if (!reports.length) return;
  const names = reports.slice(0, 5).map((row) => row.fullName || row.ccmsId).join(", ");
  const extra = reports.length > 5 ? ` +${reports.length - 5}` : "";
  throw new Error(`Reassign ${reports.length} active Agent(s) before changing this Supervisor: ${names}${extra}`);
}

export async function promoteAgentToSupervisor(actor, employeeUid) {
  assertManagementAccess(actor);
  assertAccountProvisioningReady();
  const rows = await listEmployeeIdentities({ includeDisabled: true, includeArchived: true, includeSeedFallback: true });
  const target = rows.find((row) => clean(row.employeeUid) === clean(employeeUid));
  assertWritableTarget(actor, target);
  if (target.roleKey !== EMPLOYEE_ROLES.AGENT) throw new Error("Only an Agent can be promoted to Supervisor.");

  const nextCcmsId = nextAvailableCcmsId(EMPLOYEE_ROLES.SUPERVISOR, rows.map((row) => row.ccmsId));
  return reclassifyEmployee(target.employeeUid, {
    roleKey: EMPLOYEE_ROLES.SUPERVISOR,
    ccmsId: nextCcmsId,
    projectId: target.projectId,
    projectIds: [target.projectId],
    supervisorUid: "",
    supervisorCcmsId: "",
  }, actor);
}

export async function demoteSupervisorToAgent(actor, employeeUid, { supervisorUid = "", supervisorCcmsId = "" } = {}) {
  assertManagementAccess(actor);
  assertAccountProvisioningReady();
  const rows = await listEmployeeIdentities({ includeDisabled: true, includeArchived: true, includeSeedFallback: true });
  const target = rows.find((row) => clean(row.employeeUid) === clean(employeeUid));
  assertWritableTarget(actor, target);
  if (target.roleKey !== EMPLOYEE_ROLES.SUPERVISOR) throw new Error("Only a Supervisor can be demoted to Agent.");

  await assertSupervisorHasNoActiveTeam(target);
  if (!clean(supervisorUid) && !clean(supervisorCcmsId)) {
    throw new Error("A new Supervisor is required when demoting a Supervisor to Agent.");
  }

  const nextCcmsId = nextAvailableCcmsId(EMPLOYEE_ROLES.AGENT, rows.map((row) => row.ccmsId));
  return reclassifyEmployee(target.employeeUid, {
    roleKey: EMPLOYEE_ROLES.AGENT,
    ccmsId: nextCcmsId,
    projectId: target.projectId,
    projectIds: [target.projectId],
    supervisorUid,
    supervisorCcmsId,
  }, actor);
}

export async function setManagedEmployeeStatus(actor, employeeUid, accountStatus) {
  assertManagementAccess(actor);
  assertAccountProvisioningReady();
  const status = clean(accountStatus).toLowerCase();
  if (!["active", "disabled", "archived"].includes(status)) throw new Error("Invalid account status.");

  const rows = await listEmployeeIdentities({ includeDisabled: true, includeArchived: true, includeSeedFallback: true });
  const target = rows.find((row) => clean(row.employeeUid) === clean(employeeUid));
  assertWritableTarget(actor, target);

  if (target.roleKey === EMPLOYEE_ROLES.SUPERVISOR && status !== "active") {
    await assertSupervisorHasNoActiveTeam(target);
  }

  return updateEmployeeIdentity(target.employeeUid, { accountStatus: status }, actor);
}

export async function listEligibleSupervisors(actor, projectId) {
  assertManagementAccess(actor);
  const project = clean(projectId);
  if (!actorAssignedToProject(actor, project)) throw new Error("Project is outside your access.");

  const rows = await listEmployeeIdentities({ includeDisabled: false, includeArchived: false, includeSeedFallback: true });
  return rows.filter((row) =>
    row.roleKey === EMPLOYEE_ROLES.SUPERVISOR &&
    row.accountStatus === "active" &&
    row.projectId === project
  );
}
