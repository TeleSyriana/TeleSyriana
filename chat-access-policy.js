// chat-access-policy.js — project-aware Chat visibility and CEO privacy rules
//
// Pure policy only: no DOM, Firebase or Firestore. Chat UI/storage will consume
// these decisions later so project isolation and CEO visibility are consistent.

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
  return resolveActorProject(viewer, requestedProjectId);
}

export function canListChatContact(viewer, target, requestedProjectId = "", conversations = []) {
  if (!viewer || !target || sameEmployee(viewer, target) || !activeEmployee(target)) return false;

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
  return (employees || []).filter((target) => canListChatContact(viewer, target, requestedProjectId, conversations));
}

export function canInitiateDirectChat(viewer, target, requestedProjectId = "", conversations = []) {
  if (!viewer || !target || sameEmployee(viewer, target) || !activeEmployee(viewer) || !activeEmployee(target)) return false;

  const v = projectActor(viewer);
  const targetRole = normaliseCanonicalRole(target.roleKey || target.role);
  const viewerRole = v.roleKey;

  if (viewerRole === EMPLOYEE_ROLES.CEO) {
    return targetRole !== EMPLOYEE_ROLES.CEO && employeeProjectIds(target).some((project) => project && project !== "*");
  }

  if (targetRole === EMPLOYEE_ROLES.CEO) {
    // Employees cannot discover/initiate a new CEO conversation. They can only
    // continue one that CEO already initiated with that exact employee.
    return Boolean(existingExecutiveDirect(v, target, conversations));
  }

  const projectId = chatProjectForViewer(v, requestedProjectId);
  return employeeProjectIds(target).includes(projectId);
}

export function buildDirectConversationSpec(initiator, target, requestedProjectId = "", conversations = []) {
  if (!canInitiateDirectChat(initiator, target, requestedProjectId, conversations)) {
    throw new Error("Direct conversation is not allowed by project/CEO visibility rules.");
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
  const v = projectActor(viewer);
  const viewerKeys = new Set([employeeId(v), v.ccmsId].filter(Boolean));
  const members = memberIds(conversation);
  if (!members.some((id) => viewerKeys.has(id))) return false;

  if (isExecutiveDirect(conversation)) {
    // Executive DMs are visible only to the exact two members.
    return members.length === 2;
  }

  const projectId = normaliseProjectId(conversation.projectId);
  if (!projectId) return false;
  return actorCanAccessProject(v, projectId);
}

export function canSeeDetailedPresence(viewer, target) {
  const viewerRole = normaliseCanonicalRole(viewer?.roleKey || viewer?.role);
  const targetRole = normaliseCanonicalRole(target?.roleKey || target?.role);
  if (targetRole === EMPLOYEE_ROLES.CEO && viewerRole !== EMPLOYEE_ROLES.CEO) return false;
  if (viewerRole === EMPLOYEE_ROLES.CEO) return true;
  if (sameEmployee(viewer, target)) return true;
  return employeeProjectIds(viewer).some((project) => employeeProjectIds(target).includes(project));
}

export function canAddGroupMember(actor, target, projectId) {
  const a = projectActor(actor);
  const targetRole = normaliseCanonicalRole(target?.roleKey || target?.role);
  const project = normaliseProjectId(projectId);
  if (!project || !actorCanAccessProject(a, project)) return false;

  if (targetRole === EMPLOYEE_ROLES.CEO) {
    // CEO is never auto-included. CEO may explicitly join as the acting account.
    return a.roleKey === EMPLOYEE_ROLES.CEO && sameEmployee(a, target);
  }

  return employeeProjectIds(target).includes(project);
}
