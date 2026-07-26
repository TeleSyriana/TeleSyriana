// employee-management-shadow.js — Phase 1C pure management simulator
//
// Purpose: let TeleSyriana develop and test the full employee-management rules
// without reading or writing Firestore. Every operation returns a preview plan and
// a simulated next state only. Nothing in this module persists data or touches auth.

import {
  EMPLOYEE_ROLES,
  createEmployeeUid,
  nextAvailableCcmsId,
  normaliseCanonicalRole,
  normaliseProjectIds,
  reclassifyEmployeeIdentity,
  validateEmployeeIdentity,
} from "./employee-model.js";
import { CURRENT_EMPLOYEE_IDENTITY_SEED } from "./employee-identity-seed.js";
import { DEFAULT_PROJECT } from "./project-model.js";
import {
  allowedRolesForCreation,
  assertProjectAssignmentAllowed,
  canManageEmployeeTarget,
  canOpenEmployeesAccounts,
  managementActorIdentity,
  visibleProjectsForActor,
} from "./employee-management-policy.js";

function clean(value) {
  return String(value ?? "").trim();
}

function cloneEmployee(row = {}) {
  return {
    ...row,
    projectIds: [...(row.projectIds || [])],
    directorySource: row.directorySource || "compatibility",
  };
}

function cloneProject(row = {}) {
  return { ...row };
}

function employeeProjects(row = {}) {
  return normaliseProjectIds(row.projectIds || row.projectId || []);
}

function actorSharesEmployeeProject(actor, employee) {
  const a = managementActorIdentity(actor);
  if (a.roleKey === EMPLOYEE_ROLES.CEO) return true;
  return employeeProjects(employee).some((projectId) => a.projectIds.includes(projectId));
}

function requireManagementActor(actor) {
  if (!canOpenEmployeesAccounts(actor)) {
    throw new Error("CEO, ACM or HR permission is required for Employees & Accounts.");
  }
  return managementActorIdentity(actor);
}

function requireTarget(state, actor, employeeUid) {
  const target = state.employees.find((row) => clean(row.employeeUid) === clean(employeeUid));
  if (!target) throw new Error("Employee not found.");
  if (!canManageEmployeeTarget(actor, target)) {
    throw new Error("You do not have permission to manage this employee.");
  }
  return target;
}

function activeDirectReports(state, supervisorUid) {
  return state.employees.filter((row) =>
    row.roleKey === EMPLOYEE_ROLES.AGENT &&
    row.accountStatus === "active" &&
    clean(row.supervisorUid) === clean(supervisorUid)
  );
}

function eligibleSupervisor(state, projectId, supervisorUid = "", supervisorCcmsId = "") {
  const project = clean(projectId);
  const uid = clean(supervisorUid);
  const ccms = clean(supervisorCcmsId);
  return state.employees.find((row) =>
    row.roleKey === EMPLOYEE_ROLES.SUPERVISOR &&
    row.accountStatus === "active" &&
    row.projectId === project &&
    ((uid && row.employeeUid === uid) || (ccms && row.ccmsId === ccms))
  ) || null;
}

function operationPlan(operation, before, after, detail = {}) {
  return Object.freeze({
    mode: "phase1c_shadow_preview",
    operation,
    writesPerformed: false,
    authChanged: false,
    employeeUidPreserved: before && after ? before.employeeUid === after.employeeUid : true,
    before: before ? cloneEmployee(before) : null,
    after: after ? cloneEmployee(after) : null,
    detail: Object.freeze({ ...detail }),
  });
}

export function createPhase1CShadowState({ employees, projects } = {}) {
  const seededEmployees = employees || CURRENT_EMPLOYEE_IDENTITY_SEED;
  const seededProjects = projects || [DEFAULT_PROJECT];
  return {
    mode: "phase1c_shadow",
    writesPerformed: false,
    employees: seededEmployees.map(cloneEmployee),
    projects: seededProjects.map(cloneProject),
  };
}

export function getPhase1CShadowContext(actor, state = createPhase1CShadowState()) {
  const resolvedActor = requireManagementActor(actor);
  const employees = state.employees
    .filter((row) => actorSharesEmployeeProject(resolvedActor, row))
    .sort((a, b) => String(a.ccmsId).localeCompare(String(b.ccmsId)));
  const projects = visibleProjectsForActor(resolvedActor, state.projects);

  return {
    actor: resolvedActor,
    employees: employees.map(cloneEmployee),
    projects: projects.map(cloneProject),
    allowedCreationRoles: allowedRolesForCreation(resolvedActor),
    directoryHealth: {
      firestoreCount: 0,
      compatibilityCount: employees.length,
      migrationPending: true,
      accountProvisioningReady: false,
      shadowMode: true,
      writesPerformed: false,
    },
  };
}

export function previewCreateEmployee(actor, input = {}, state = createPhase1CShadowState()) {
  const resolvedActor = requireManagementActor(actor);
  const roleKey = normaliseCanonicalRole(input.roleKey || input.role);
  if (!allowedRolesForCreation(resolvedActor).includes(roleKey)) {
    throw new Error(`You do not have permission to create a ${roleKey} account.`);
  }

  const projectIds = roleKey === EMPLOYEE_ROLES.HR
    ? normaliseProjectIds(input.projectIds || input.projectId || [])
    : normaliseProjectIds(input.projectId || input.projectIds || []);
  assertProjectAssignmentAllowed(resolvedActor, roleKey, projectIds);

  const projectId = roleKey === EMPLOYEE_ROLES.CEO ? "*" : clean(input.projectId) || projectIds[0] || "";
  let supervisorUid = "";
  let supervisorCcmsId = "";

  if (roleKey === EMPLOYEE_ROLES.AGENT) {
    const supervisor = eligibleSupervisor(
      state,
      projectId,
      input.supervisorUid,
      input.supervisorCcmsId || input.supervisorId
    );
    if (!supervisor) throw new Error("Agent requires an active Supervisor from the same project.");
    supervisorUid = supervisor.employeeUid;
    supervisorCcmsId = supervisor.ccmsId;
  }

  const ccmsId = clean(input.ccmsId) || nextAvailableCcmsId(roleKey, state.employees.map((row) => row.ccmsId));
  const employeeUid = clean(input.employeeUid) || createEmployeeUid();
  const after = validateEmployeeIdentity({
    ...input,
    employeeUid,
    ccmsId,
    roleKey,
    projectId,
    projectIds,
    supervisorUid,
    supervisorCcmsId,
    accountStatus: input.accountStatus || "active",
  });

  return operationPlan("create_employee", null, after, {
    nextCcmsId: ccmsId,
    temporaryPasswordRequiredOnActivation: true,
  });
}

export function previewUpdateEmployee(actor, employeeUid, patch = {}, state = createPhase1CShadowState()) {
  const resolvedActor = requireManagementActor(actor);
  const before = requireTarget(state, resolvedActor, employeeUid);

  if (patch.roleKey || patch.role || (patch.ccmsId && clean(patch.ccmsId) !== before.ccmsId)) {
    throw new Error("Role and CCMS changes must use Promote/Demote preview actions.");
  }

  const projectIds = normaliseProjectIds(patch.projectIds || patch.projectId || before.projectIds);
  assertProjectAssignmentAllowed(resolvedActor, before.roleKey, projectIds);
  const projectId = clean(patch.projectId) || projectIds[0] || before.projectId;

  let supervisorUid = Object.prototype.hasOwnProperty.call(patch, "supervisorUid") ? clean(patch.supervisorUid) : before.supervisorUid;
  let supervisorCcmsId = Object.prototype.hasOwnProperty.call(patch, "supervisorCcmsId") ? clean(patch.supervisorCcmsId) : before.supervisorCcmsId;

  if (before.roleKey === EMPLOYEE_ROLES.AGENT) {
    const supervisor = eligibleSupervisor(state, projectId, supervisorUid, supervisorCcmsId);
    if (!supervisor) throw new Error("Agent requires an active Supervisor from the same project.");
    supervisorUid = supervisor.employeeUid;
    supervisorCcmsId = supervisor.ccmsId;
  } else {
    supervisorUid = "";
    supervisorCcmsId = "";
  }

  const after = validateEmployeeIdentity({
    ...before,
    ...patch,
    employeeUid: before.employeeUid,
    ccmsId: before.ccmsId,
    roleKey: before.roleKey,
    projectId,
    projectIds,
    supervisorUid,
    supervisorCcmsId,
  });

  return operationPlan("update_employee", before, after);
}

export function previewPromoteAgent(actor, employeeUid, state = createPhase1CShadowState()) {
  const resolvedActor = requireManagementActor(actor);
  const before = requireTarget(state, resolvedActor, employeeUid);
  if (before.roleKey !== EMPLOYEE_ROLES.AGENT) throw new Error("Only an Agent can be promoted to Supervisor.");

  const nextCcmsId = nextAvailableCcmsId(EMPLOYEE_ROLES.SUPERVISOR, state.employees.map((row) => row.ccmsId));
  const after = validateEmployeeIdentity(reclassifyEmployeeIdentity(before, {
    roleKey: EMPLOYEE_ROLES.SUPERVISOR,
    ccmsId: nextCcmsId,
    projectId: before.projectId,
    projectIds: [before.projectId],
    supervisorUid: "",
    supervisorCcmsId: "",
  }));

  return operationPlan("promote_agent_to_supervisor", before, after, {
    oldCcmsId: before.ccmsId,
    nextCcmsId,
    temporaryPasswordRequiredOnActivation: true,
  });
}

export function previewDemoteSupervisor(actor, employeeUid, assignment = {}, state = createPhase1CShadowState()) {
  const resolvedActor = requireManagementActor(actor);
  const before = requireTarget(state, resolvedActor, employeeUid);
  if (before.roleKey !== EMPLOYEE_ROLES.SUPERVISOR) throw new Error("Only a Supervisor can be demoted to Agent.");

  const reports = activeDirectReports(state, before.employeeUid);
  if (reports.length) {
    throw new Error(`Reassign ${reports.length} active Agent(s) before demoting this Supervisor.`);
  }

  const supervisor = eligibleSupervisor(
    state,
    before.projectId,
    assignment.supervisorUid,
    assignment.supervisorCcmsId
  );
  if (!supervisor || supervisor.employeeUid === before.employeeUid) {
    throw new Error("A different active Supervisor from the same project is required for demotion.");
  }

  const nextCcmsId = nextAvailableCcmsId(EMPLOYEE_ROLES.AGENT, state.employees.map((row) => row.ccmsId));
  const after = validateEmployeeIdentity(reclassifyEmployeeIdentity(before, {
    roleKey: EMPLOYEE_ROLES.AGENT,
    ccmsId: nextCcmsId,
    projectId: before.projectId,
    projectIds: [before.projectId],
    supervisorUid: supervisor.employeeUid,
    supervisorCcmsId: supervisor.ccmsId,
  }));

  return operationPlan("demote_supervisor_to_agent", before, after, {
    oldCcmsId: before.ccmsId,
    nextCcmsId,
    assignedSupervisorUid: supervisor.employeeUid,
    assignedSupervisorCcmsId: supervisor.ccmsId,
    temporaryPasswordRequiredOnActivation: true,
  });
}

export function previewEmployeeStatus(actor, employeeUid, accountStatus, state = createPhase1CShadowState()) {
  const resolvedActor = requireManagementActor(actor);
  const before = requireTarget(state, resolvedActor, employeeUid);
  const status = clean(accountStatus).toLowerCase();
  if (!["active", "disabled", "archived"].includes(status)) throw new Error("Invalid account status.");

  if (before.roleKey === EMPLOYEE_ROLES.SUPERVISOR && status !== "active") {
    const reports = activeDirectReports(state, before.employeeUid);
    if (reports.length) throw new Error(`Reassign ${reports.length} active Agent(s) before changing this Supervisor status.`);
  }

  const after = validateEmployeeIdentity({ ...before, accountStatus: status });
  return operationPlan("change_account_status", before, after, { accountStatus: status });
}

export function applyShadowPreview(state, plan) {
  if (!plan || plan.mode !== "phase1c_shadow_preview" || plan.writesPerformed !== false) {
    throw new Error("Only a Phase 1C shadow preview plan can be simulated.");
  }

  const next = createPhase1CShadowState({ employees: state.employees, projects: state.projects });
  if (!plan.after) return next;

  const index = next.employees.findIndex((row) => row.employeeUid === plan.after.employeeUid);
  if (index >= 0) next.employees[index] = cloneEmployee(plan.after);
  else next.employees.push(cloneEmployee(plan.after));
  return next;
}
