// employee-management-policy.js — Phase 1B pure authorization policy
//
// No Firestore/DOM dependencies. UI and service layers must both use these rules.

import {
  EMPLOYEE_ROLES,
  normaliseCanonicalRole,
  normaliseProjectId,
  normaliseProjectIds,
} from "./employee-model.js";

function clean(value) {
  return String(value ?? "").trim();
}

export function managementActorIdentity(actor = {}) {
  const roleKey = normaliseCanonicalRole(actor.roleKey || actor.role);
  const projectId = normaliseProjectId(actor.projectId || "");
  const projectIds = normaliseProjectIds(actor.projectIds || (projectId ? [projectId] : []));
  return {
    employeeUid: clean(actor.employeeUid || actor.uid),
    ccmsId: clean(actor.ccmsId || actor.id),
    roleKey,
    projectId,
    projectIds: roleKey === EMPLOYEE_ROLES.CEO ? ["*"] : projectIds,
  };
}

export function actorAssignedToProject(actor, projectId) {
  const row = managementActorIdentity(actor);
  const project = normaliseProjectId(projectId);
  if (!project) return false;
  if (row.roleKey === EMPLOYEE_ROLES.CEO) return true;
  return row.projectIds.includes(project);
}

export function canOpenEmployeesAccounts(actor) {
  const role = managementActorIdentity(actor).roleKey;
  return [EMPLOYEE_ROLES.CEO, EMPLOYEE_ROLES.ACM, EMPLOYEE_ROLES.HR].includes(role);
}

export function allowedRolesForCreation(actor) {
  const role = managementActorIdentity(actor).roleKey;
  if (role === EMPLOYEE_ROLES.CEO) {
    return [EMPLOYEE_ROLES.ACM, EMPLOYEE_ROLES.SUPERVISOR, EMPLOYEE_ROLES.HR, EMPLOYEE_ROLES.AGENT];
  }
  if (role === EMPLOYEE_ROLES.ACM) {
    return [EMPLOYEE_ROLES.SUPERVISOR, EMPLOYEE_ROLES.AGENT];
  }
  if (role === EMPLOYEE_ROLES.HR) {
    return [EMPLOYEE_ROLES.SUPERVISOR, EMPLOYEE_ROLES.HR, EMPLOYEE_ROLES.AGENT];
  }
  return [];
}

export function visibleProjectsForActor(actor, allProjects = []) {
  const row = managementActorIdentity(actor);
  const projects = (allProjects || []).filter((project) => project && project.accountStatus !== "archived");
  if (row.roleKey === EMPLOYEE_ROLES.CEO) return projects;
  return projects.filter((project) => row.projectIds.includes(normaliseProjectId(project.projectId)));
}

export function canManageEmployeeTarget(actor, target) {
  if (!target) return false;
  const a = managementActorIdentity(actor);
  const targetRole = normaliseCanonicalRole(target.roleKey || target.role);
  const targetProjects = normaliseProjectIds(target.projectIds || target.projectId || []);

  if (!a.ccmsId && !a.employeeUid) return false;
  if (a.employeeUid && clean(target.employeeUid) === a.employeeUid) return false;
  if (!a.employeeUid && a.ccmsId && clean(target.ccmsId || target.id) === a.ccmsId) return false;

  if (a.roleKey === EMPLOYEE_ROLES.CEO) return targetRole !== EMPLOYEE_ROLES.CEO;

  const sharesManagedProject = targetProjects.some((projectId) => a.projectIds.includes(projectId));
  if (!sharesManagedProject) return false;

  if (a.roleKey === EMPLOYEE_ROLES.ACM) {
    return [EMPLOYEE_ROLES.SUPERVISOR, EMPLOYEE_ROLES.AGENT].includes(targetRole);
  }

  if (a.roleKey === EMPLOYEE_ROLES.HR) {
    return [EMPLOYEE_ROLES.HR, EMPLOYEE_ROLES.SUPERVISOR, EMPLOYEE_ROLES.AGENT].includes(targetRole);
  }

  return false;
}

export function canAssignRoleToTarget(actor, target, nextRole) {
  if (!canManageEmployeeTarget(actor, target)) return false;
  const requested = normaliseCanonicalRole(nextRole);
  const actorRole = managementActorIdentity(actor).roleKey;

  if (actorRole === EMPLOYEE_ROLES.CEO) {
    return [EMPLOYEE_ROLES.ACM, EMPLOYEE_ROLES.SUPERVISOR, EMPLOYEE_ROLES.HR, EMPLOYEE_ROLES.AGENT].includes(requested);
  }
  if (actorRole === EMPLOYEE_ROLES.ACM) {
    return [EMPLOYEE_ROLES.SUPERVISOR, EMPLOYEE_ROLES.AGENT].includes(requested);
  }
  if (actorRole === EMPLOYEE_ROLES.HR) {
    return [EMPLOYEE_ROLES.HR, EMPLOYEE_ROLES.SUPERVISOR, EMPLOYEE_ROLES.AGENT].includes(requested);
  }
  return false;
}

export function assertProjectAssignmentAllowed(actor, role, projectIds) {
  const a = managementActorIdentity(actor);
  const requestedRole = normaliseCanonicalRole(role);
  const requestedProjects = normaliseProjectIds(projectIds);

  if (a.roleKey === EMPLOYEE_ROLES.CEO) return requestedProjects;
  if (!requestedProjects.length) throw new Error("At least one project is required.");

  const outsideScope = requestedProjects.filter((projectId) => !a.projectIds.includes(projectId));
  if (outsideScope.length) {
    throw new Error("You cannot assign an employee to a project outside your access.");
  }

  if (a.roleKey === EMPLOYEE_ROLES.ACM && requestedProjects.length !== 1) {
    throw new Error("ACM can create/manage employees only inside the ACM project.");
  }

  if (a.roleKey === EMPLOYEE_ROLES.HR && requestedRole !== EMPLOYEE_ROLES.HR && requestedProjects.length !== 1) {
    throw new Error("ACM, Supervisor and Agent accounts must belong to exactly one project.");
  }

  return requestedProjects;
}

export function canModifyDirectoryRow(actor, target) {
  return canManageEmployeeTarget(actor, target) && target?.directorySource === "firestore";
}
