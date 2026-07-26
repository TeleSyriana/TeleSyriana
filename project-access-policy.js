// project-access-policy.js — reusable TeleSyriana project-scope rules
//
// Pure module: no DOM, Firebase or Firestore. Tickets, Chat, Teams and future
// dashboards should consume the same project-access decisions from here.

import {
  EMPLOYEE_ROLES,
  GLOBAL_PROJECT_ID,
  normaliseCanonicalRole,
  normaliseProjectId,
  normaliseProjectIds,
} from "./employee-model.js";

function clean(value) {
  return String(value ?? "").trim();
}

export function projectActor(actor = {}) {
  const roleKey = normaliseCanonicalRole(actor.roleKey || actor.role);
  const primary = normaliseProjectId(actor.projectId || actor.activeProjectId || "");
  const assigned = roleKey === EMPLOYEE_ROLES.CEO
    ? [GLOBAL_PROJECT_ID]
    : normaliseProjectIds(actor.projectIds || (primary ? [primary] : []));

  return {
    employeeUid: clean(actor.employeeUid || actor.uid),
    ccmsId: clean(actor.ccmsId || actor.id),
    roleKey,
    projectId: primary,
    projectIds: assigned,
  };
}

export function employeeProjectIds(employee = {}) {
  const role = normaliseCanonicalRole(employee.roleKey || employee.role);
  if (role === EMPLOYEE_ROLES.CEO) return [GLOBAL_PROJECT_ID];
  return normaliseProjectIds(employee.projectIds || employee.projectId || []);
}

export function actorCanAccessProject(actor, projectId) {
  const a = projectActor(actor);
  const project = normaliseProjectId(projectId);
  if (!project || project === GLOBAL_PROJECT_ID) return a.roleKey === EMPLOYEE_ROLES.CEO;
  if (a.roleKey === EMPLOYEE_ROLES.CEO) return true;
  return a.projectIds.includes(project);
}

export function assertActorProjectAccess(actor, projectId) {
  const project = normaliseProjectId(projectId);
  if (!actorCanAccessProject(actor, project)) {
    throw new Error("Project is outside this employee's access.");
  }
  return project;
}

export function resolveActorProject(actor, requestedProjectId = "") {
  const a = projectActor(actor);
  const requested = normaliseProjectId(requestedProjectId);

  if (a.roleKey === EMPLOYEE_ROLES.CEO) {
    if (!requested || requested === GLOBAL_PROJECT_ID) {
      throw new Error("CEO must select a specific project for project-scoped operations.");
    }
    return requested;
  }

  if (a.roleKey === EMPLOYEE_ROLES.HR) {
    const selected = requested || a.projectId || a.projectIds[0] || "";
    return assertActorProjectAccess(a, selected);
  }

  const fixed = a.projectId || a.projectIds[0] || "";
  if (!fixed) throw new Error("This role requires exactly one project.");
  if (requested && requested !== fixed) {
    throw new Error("This employee cannot switch to another project.");
  }
  return fixed;
}

export function canManageProjectLifecycle(actor) {
  return projectActor(actor).roleKey === EMPLOYEE_ROLES.CEO;
}

export function canManageProjectOperations(actor, projectId) {
  const a = projectActor(actor);
  if (!actorCanAccessProject(a, projectId)) return false;
  return [EMPLOYEE_ROLES.CEO, EMPLOYEE_ROLES.ACM].includes(a.roleKey);
}

export function sameSpecificProject(a, b, projectId = "") {
  const explicit = normaliseProjectId(projectId);
  const aProjects = employeeProjectIds(a);
  const bProjects = employeeProjectIds(b);
  if (aProjects.includes(GLOBAL_PROJECT_ID) || bProjects.includes(GLOBAL_PROJECT_ID)) return true;
  if (explicit) return aProjects.includes(explicit) && bProjects.includes(explicit);
  return aProjects.some((project) => bProjects.includes(project));
}

export function canSupervisorManageAgent(supervisor, agent) {
  const sup = projectActor(supervisor);
  const targetRole = normaliseCanonicalRole(agent?.roleKey || agent?.role);
  if (sup.roleKey !== EMPLOYEE_ROLES.SUPERVISOR || targetRole !== EMPLOYEE_ROLES.AGENT) return false;
  if (!sup.employeeUid || !clean(agent?.supervisorUid)) return false;
  if (clean(agent.supervisorUid) !== sup.employeeUid) return false;
  return sameSpecificProject(sup, agent, sup.projectId);
}

export function employeeVisibleInProject(actor, employee, projectId) {
  const a = projectActor(actor);
  const project = assertActorProjectAccess(a, projectId);
  const targetRole = normaliseCanonicalRole(employee?.roleKey || employee?.role);

  // CEO is an executive/global identity, not a normal project-directory member.
  if (targetRole === EMPLOYEE_ROLES.CEO) return a.roleKey === EMPLOYEE_ROLES.CEO;
  if (!employeeProjectIds(employee).includes(project)) return false;

  if ([EMPLOYEE_ROLES.CEO, EMPLOYEE_ROLES.ACM, EMPLOYEE_ROLES.HR].includes(a.roleKey)) return true;
  if (a.roleKey === EMPLOYEE_ROLES.SUPERVISOR) {
    if (clean(employee?.employeeUid) === a.employeeUid) return true;
    return canSupervisorManageAgent(a, employee);
  }
  if (a.roleKey === EMPLOYEE_ROLES.AGENT) {
    if (clean(employee?.employeeUid) === a.employeeUid) return true;
    return clean(employee?.employeeUid) === clean(a.supervisorUid) || clean(employee?.ccmsId) === clean(a.supervisorCcmsId);
  }
  return false;
}

export function visibleProjectEmployees(actor, employees = [], requestedProjectId = "") {
  const projectId = resolveActorProject(actor, requestedProjectId);
  return (employees || []).filter((employee) => employeeVisibleInProject(actor, employee, projectId));
}

export function validateAgentSupervisorProject(agent, supervisor) {
  const agentRole = normaliseCanonicalRole(agent?.roleKey || agent?.role);
  const supervisorRole = normaliseCanonicalRole(supervisor?.roleKey || supervisor?.role);
  if (agentRole !== EMPLOYEE_ROLES.AGENT) throw new Error("Target employee is not an Agent.");
  if (supervisorRole !== EMPLOYEE_ROLES.SUPERVISOR) throw new Error("Assigned employee is not a Supervisor.");
  if (!sameSpecificProject(agent, supervisor, agent.projectId)) {
    throw new Error("Agent and Supervisor must belong to the same project.");
  }
  return true;
}
