// project-hierarchy-shadow.js — pure project/team hierarchy projection
//
// Builds the operational tree used later by Supervisor dashboards, project-aware
// tickets and Chat. No storage, DOM or network dependencies.

import {
  EMPLOYEE_ROLES,
  normaliseCanonicalRole,
  normaliseProjectId,
} from "./employee-model.js";
import {
  employeeProjectIds,
  validateAgentSupervisorProject,
} from "./project-access-policy.js";

function clean(value) {
  return String(value ?? "").trim();
}

function copy(row = {}) {
  return { ...row, projectIds: [...(row.projectIds || [])] };
}

function inProject(row, projectId) {
  return employeeProjectIds(row).includes(projectId);
}

export function buildProjectHierarchy(projectId, employees = []) {
  const project = normaliseProjectId(projectId);
  if (!project || project === "*") throw new Error("A specific project is required.");

  const rows = (employees || []).filter((row) => inProject(row, project));
  const acms = rows.filter((row) => normaliseCanonicalRole(row.roleKey || row.role) === EMPLOYEE_ROLES.ACM).map(copy);
  const hrs = rows.filter((row) => normaliseCanonicalRole(row.roleKey || row.role) === EMPLOYEE_ROLES.HR).map(copy);
  const supervisors = rows.filter((row) => normaliseCanonicalRole(row.roleKey || row.role) === EMPLOYEE_ROLES.SUPERVISOR);
  const agents = rows.filter((row) => normaliseCanonicalRole(row.roleKey || row.role) === EMPLOYEE_ROLES.AGENT);

  const warnings = [];
  const supervisorRows = supervisors.map((supervisor) => {
    const team = agents.filter((agent) =>
      clean(agent.supervisorUid) === clean(supervisor.employeeUid) ||
      (!clean(agent.supervisorUid) && clean(agent.supervisorCcmsId) === clean(supervisor.ccmsId))
    );

    return {
      supervisor: copy(supervisor),
      agents: team.map(copy),
      activeAgents: team.filter((row) => row.accountStatus === "active").length,
      disabledAgents: team.filter((row) => row.accountStatus === "disabled").length,
    };
  });

  const assignedAgentUids = new Set(supervisorRows.flatMap((group) => group.agents.map((row) => row.employeeUid)));
  const unassignedAgents = agents.filter((agent) => !assignedAgentUids.has(agent.employeeUid));

  for (const agent of agents) {
    const supervisor = supervisors.find((candidate) =>
      clean(candidate.employeeUid) === clean(agent.supervisorUid) ||
      (!clean(agent.supervisorUid) && clean(candidate.ccmsId) === clean(agent.supervisorCcmsId))
    );

    if (!supervisor) {
      warnings.push({
        type: "agent_missing_supervisor",
        employeeUid: agent.employeeUid,
        ccmsId: agent.ccmsId,
        projectId: project,
      });
      continue;
    }

    try {
      validateAgentSupervisorProject(agent, supervisor);
    } catch (error) {
      warnings.push({
        type: "agent_supervisor_project_mismatch",
        employeeUid: agent.employeeUid,
        ccmsId: agent.ccmsId,
        supervisorUid: supervisor.employeeUid,
        supervisorCcmsId: supervisor.ccmsId,
        message: String(error?.message || error),
      });
    }
  }

  if (acms.length > 1) {
    warnings.push({ type: "multiple_acm_accounts", projectId: project, count: acms.length });
  }

  return {
    projectId: project,
    acms,
    hrs,
    supervisors: supervisorRows,
    unassignedAgents: unassignedAgents.map(copy),
    warnings,
    totals: {
      employees: rows.length,
      acms: acms.length,
      hrs: hrs.length,
      supervisors: supervisors.length,
      agents: agents.length,
      activeAgents: agents.filter((row) => row.accountStatus === "active").length,
    },
  };
}

export function supervisorTeam(projectId, supervisorUid, employees = []) {
  const hierarchy = buildProjectHierarchy(projectId, employees);
  const group = hierarchy.supervisors.find((row) => clean(row.supervisor.employeeUid) === clean(supervisorUid));
  if (!group) throw new Error("Supervisor is not assigned to this project.");
  return group;
}
