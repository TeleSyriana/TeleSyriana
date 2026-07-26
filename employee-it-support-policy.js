// employee-it-support-policy.js — least-privilege account support policy
//
// IT Support can diagnose login/account state and reset passwords for non-CEO
// employees. IT does not inherit project, payroll, Ticket, Chat or employee-role
// management permissions.

import { EMPLOYEE_ROLES, normaliseCanonicalRole } from "./employee-model.js";

function clean(value) {
  return String(value ?? "").trim();
}

function samePerson(actor = {}, target = {}) {
  const actorUid = clean(actor.employeeUid || actor.uid);
  const targetUid = clean(target.employeeUid || target.uid);
  if (actorUid && targetUid) return actorUid === targetUid;
  return clean(actor.ccmsId || actor.id) === clean(target.ccmsId || target.id);
}

export function isItSupportActor(actor = {}) {
  return normaliseCanonicalRole(actor.roleKey || actor.role) === EMPLOYEE_ROLES.IT;
}

export function canViewAccountSupportProfile(actor, target) {
  if (!target || !isItSupportActor(actor)) return false;
  return normaliseCanonicalRole(target.roleKey || target.role) !== EMPLOYEE_ROLES.CEO;
}

export function canResetEmployeePassword(actor, target) {
  if (!canViewAccountSupportProfile(actor, target)) return false;
  if (samePerson(actor, target)) return false;
  return clean(target.accountStatus || "active").toLowerCase() !== "archived";
}

export function accountSupportProfile(target = {}, credentialState = {}) {
  return Object.freeze({
    employeeUid: clean(target.employeeUid || target.uid),
    ccmsId: clean(target.ccmsId || target.id),
    fullName: clean(target.fullName || target.name),
    roleKey: normaliseCanonicalRole(target.roleKey || target.role),
    accountStatus: clean(target.accountStatus || "active") || "active",
    projectId: clean(target.projectId),
    projectIds: Object.freeze([...(target.projectIds || [])].map(clean).filter(Boolean)),
    credential: Object.freeze({
      exists: credentialState.exists === true,
      unavailable: credentialState.unavailable === true,
      mustChangePassword: credentialState.mustChangePassword === true,
      passwordExpired: credentialState.passwordExpired === true,
      passwordChangeRequired: credentialState.passwordChangeRequired === true,
      passwordChangedAtMs: Number(credentialState.passwordChangedAtMs) || 0,
      passwordExpiresAtMs: Number(credentialState.passwordExpiresAtMs) || 0,
      passwordMaxAgeDays: Number(credentialState.passwordMaxAgeDays) || 0,
    }),
  });
}

export function assertItPasswordResetAllowed(actor, target) {
  if (!isItSupportActor(actor)) throw new Error("IT Support permission is required for password reset.");
  if (!target) throw new Error("Employee not found.");
  if (normaliseCanonicalRole(target.roleKey || target.role) === EMPLOYEE_ROLES.CEO) {
    throw new Error("IT Support cannot reset the CEO credential.");
  }
  if (samePerson(actor, target)) throw new Error("IT Support cannot use the support reset flow on its own account.");
  if (clean(target.accountStatus || "active").toLowerCase() === "archived") {
    throw new Error("Archived employee credentials cannot be reset.");
  }
  return true;
}
