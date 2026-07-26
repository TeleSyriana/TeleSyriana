// chat-access-policy.js — project-aware Chat visibility and CEO privacy rules
//
// Pure policy only: no DOM, Firebase or Firestore. IT Support is an account-security
// role and has no operational Chat scope unless a separate future permission is added.

import {
  EMPLOYEE_ROLES,
  normaliseCanonicalRole,
  normaliseProjectId,
} from "./employee-model.js";
import {
  actorCanAccessProject,
  employeeProjectIds,
  projectActor,
  resolveActorProject,
} from "./project-access-policy.js";

function clean(value) {
  return String(value ?? "").trim();
}

function activeEmployee(employee) {
  return clean(employee?.accountStatus || "active").toLowerCase() === "active";
}

function memberIds(conversation = {}) {
  return Array.isArray(conversation.members) ? conversation.members.map(clean).filter(Boolean) : [];
}

function employeeId(employee = {}) {
  return clean(employee.employeeUid || employee.uid || employee.ccmsId || employee.id);
}

function sameEmployee(a, b) {
  const aid = employeeId(a);
  const bid = employeeId(b);
  if (aid && bid && aid === bid) return true;
  const accms = clean(a?.ccmsId || a?.id);
  const bccms = clean(b?.ccmsId || b?.id);
  return Boolean(accms && bccms && accms === bccms);
}

function isIt(employee = {}) {
  return normaliseCanonicalRole(employee.roleKey || employee.role) === EMPLOYEE_ROLES.IT;
}

export function isExecutiveDirect(conversation = {}) {
  return clean(conversation.type).toLowerCase() === "executive_direct";
}

export function existingExecutiveDirect(viewer, ceo, conversations = []) {
  const viewerIds = new Set([employeeId(viewer), clean(viewer?.ccmsId || viewer?.id)].filter(Boolean));
  const ceoIds = new Set([employeeId(ceo), clean(ceo?.ccmsId || ceo?.id)].filter(Boolean));

  return (conversations || []).find((conversation) => {
    if (!isExecutiveDirect(conversation)) return false;
    const members = memberIds(conversation);
    const hasViewer = members.some((id) => viewerIds.has(id));
    const hasCeo = members.some((id) => ceoIds.has(id));
    const initiatedBy = clean(conversation.initiatedBy);
    return hasViewer && hasCeo && ceoIds.has(initiatedBy);
  }) || null;
}

export function chatProjectForViewer(viewer, requestedProjectId = "") {
  if (isIt(viewer)) throw new Error("IT Support has no operational Chat project.");
  return resolveActorProject(viewer, requestedProjectId);
}

export function canListChatContact(viewer, target, requestedProjectId = "", conversations = []) {
  if (!viewer || !target || sameEmployee(viewer, target) || !activeEmployee(target)) return false;
  if (isIt(viewer) || isIt(target)) return false;

  const v = projectActor(viewer);
  const targetRole = normaliseCanonicalRole(target.roleKey || target.role);

  if (v.roleKey === EMPLOYEE_ROLES.CEO) {
    return targetRole !== EMPLOYEE_ROLES.CEO;
  }

  if (targetRole === EMPLOYEE_ROLES.CEO) {
    return Boolean(existingExecutiveDirect(v, target, conversations));
  }

  const projectId = chatProjectForViewer(v, requestedProjectId);
  return employeeProjectIds(target).includes(projectId);
}

export function visibleChatContacts(viewer, employees = [], requestedProjectId = "", conversations = []) {
  if (isIt(viewer)) return [];
  return (employees || []).filter((target) => canListChatContact(viewer, target, requestedProjectId, conversations));
}

export function canInitiateDirectChat(viewer, target, requestedProjectId = "", conversations = []) {
  if (!viewer || !target || sameEmployee(viewer, target) || !activeEmployee(viewer) || !activeEmployee(target)) return false;
  if (isIt(viewer) || isIt(target)) return false;

  const v = projectActor(viewer);
  const targetRole = normaliseCanonicalRole(target.roleKey || target.role);
  const viewerRole = v.roleKey;

  if (viewerRole === EMPLOYEE_ROLES.CEO) {
    return targetRole !== EMPLOYEE_ROLES.CEO && employeeProjectIds(target).some((project) => project && project !== "*");
  }

  if (targetRole === EMPLOYEE_ROLES.CEO) {
    return Boolean(existingExecutiveDirect(v, target, conversations));
  }

  const projectId = chatProjectForViewer(v, requestedProjectId);
  return employeeProjectIds(target).includes(projectId);
}

export function buildDirectConversationSpec(initiator, target, requestedProjectId = "", conversations = []) {
  if (!canInitiateDirectChat(initiator, target, requestedProjectId, conversations)) {
    throw new Error("Direct conversation is not allowed by project/CEO/IT visibility rules.");
  }

  const initiatorRole = normaliseCanonicalRole(initiator.roleKey || initiator.role);
  const targetRole = normaliseCanonicalRole(target.roleKey || target.role);
  const initiatorId = employeeId(initiator);
  const targetId = employeeId(target);

  if (initiatorRole === EMPLOYEE_ROLES.CEO) {
    const targetProjects = employeeProjectIds(target).filter((project) => project !== "*");
    const projectId = normaliseProjectId(requestedProjectId) || target.projectId || targetProjects[0] || "";
    if (!projectId || !targetProjects.includes(projectId)) {
      throw new Error("CEO direct conversation must be attached to one of the recipient's projects.");
    }
    return {
      type: "executive_direct",
      projectId,
      members: [initiatorId, targetId],
      initiatedBy: initiatorId,
      ceoVisibilityScope: "recipient_only",
    };
  }

  if (targetRole === EMPLOYEE_ROLES.CEO) {
    const existing = existingExecutiveDirect(initiator, target, conversations);
    if (!existing) throw new Error("CEO must initiate the executive conversation first.");
    return { ...existing };
  }

  const projectId = chatProjectForViewer(initiator, requestedProjectId);
  return {
    type: "direct",
    projectId,
    members: [initiatorId, targetId],
    initiatedBy: initiatorId,
  };
}

export function canViewConversation(viewer, conversation = {}) {
  if (isIt(viewer)) return false;
  const v = projectActor(viewer);
  const viewerKeys = new Set([employeeId(v), v.ccmsId].filter(Boolean));
  const members = memberIds(conversation);
  if (!members.some((id) => viewerKeys.has(id))) return false;

  if (isExecutiveDirect(conversation)) {
    return members.length === 2;
  }

  const projectId = normaliseProjectId(conversation.projectId);
  if (!projectId) return false;
  return actorCanAccessProject(v, projectId);
}

export function canSeeDetailedPresence(viewer, target) {
  if (isIt(viewer) || isIt(target)) return false;
  const viewerRole = normaliseCanonicalRole(viewer?.roleKey || viewer?.role);
  const targetRole = normaliseCanonicalRole(target?.roleKey || target?.role);
  if (targetRole === EMPLOYEE_ROLES.CEO && viewerRole !== EMPLOYEE_ROLES.CEO) return false;
  if (viewerRole === EMPLOYEE_ROLES.CEO) return true;
  if (sameEmployee(viewer, target)) return true;
  return employeeProjectIds(viewer).some((project) => employeeProjectIds(target).includes(project));
}

export function canAddGroupMember(actor, target, projectId) {
  if (isIt(actor) || isIt(target)) return false;
  const a = projectActor(actor);
  const targetRole = normaliseCanonicalRole(target?.roleKey || target?.role);
  const project = normaliseProjectId(projectId);
  if (!project || !actorCanAccessProject(a, project)) return false;

  if (targetRole === EMPLOYEE_ROLES.CEO) {
    return a.roleKey === EMPLOYEE_ROLES.CEO && sameEmployee(a, target);
  }

  return employeeProjectIds(target).includes(project);
}
