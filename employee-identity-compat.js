// employee-identity-compat.js — zero-Firestore bridge between current TeleSyriana
// session objects and the new permanent Phase 1A identity model.
//
// This module is not wired into production login yet. Phase 1B can use it to
// migrate one surface at a time without reintroducing the risky all-at-once loader.

import { seedIdentityByCcms } from "./employee-identity-seed.js";
import {
  normaliseCanonicalRole,
  normaliseEmployeeIdentity,
  validateEmployeeIdentity,
} from "./employee-model.js";

function clean(value) {
  return String(value ?? "").trim();
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function legacySessionToEmployeeIdentity(session = {}, options = {}) {
  const ccmsId = clean(session.ccmsId || session.employeeId || session.id);
  if (!ccmsId) return null;

  const seed = seedIdentityByCcms(ccmsId);
  const employeeUid = clean(session.employeeUid || options.employeeUid || seed?.employeeUid);
  if (!employeeUid) return null;

  const roleKey = seed?.roleKey || normaliseCanonicalRole(session.roleKey || session.role);
  const projectId = clean(session.projectId || seed?.projectId);
  const projectIds = Array.isArray(session.projectIds) && session.projectIds.length
    ? session.projectIds
    : seed?.projectIds || (projectId ? [projectId] : []);

  const identity = normaliseEmployeeIdentity({
    ...(seed || {}),
    employeeUid,
    ccmsId,
    fullName: clean(session.fullName || session.name || seed?.fullName || ccmsId),
    roleKey,
    accountStatus: clean(session.accountStatus || seed?.accountStatus || "active"),
    projectId,
    projectIds,
    supervisorUid: clean(session.supervisorUid || seed?.supervisorUid),
    supervisorCcmsId: clean(session.supervisorCcmsId || session.supervisorId || seed?.supervisorCcmsId),
    hourlyRate: numeric(session.hourlyRate, seed?.hourlyRate || 0),
    currency: clean(session.currency || seed?.currency || "USD"),
    timezone: clean(session.timezone || seed?.timezone),
    language: clean(session.language || seed?.language),
  });

  return validateEmployeeIdentity(identity, {
    allowPendingSupervisor: options.allowPendingSupervisor === true,
  });
}

export function employeeIdentityToLegacySession(identity = {}) {
  const row = validateEmployeeIdentity(identity);

  return {
    id: row.ccmsId,
    employeeId: row.ccmsId,
    ccmsId: row.ccmsId,
    employeeUid: row.employeeUid,
    name: row.fullName,
    fullName: row.fullName,
    role: row.legacyRole,
    roleKey: row.roleKey,
    accountStatus: row.accountStatus,
    projectId: row.projectId,
    projectIds: [...row.projectIds],
    supervisorId: row.supervisorCcmsId,
    supervisorUid: row.supervisorUid,
    supervisorCcmsId: row.supervisorCcmsId,
    hourlyRate: row.hourlyRate,
    currency: row.currency,
    timezone: row.timezone,
    language: row.language,
  };
}

export function mergeIdentityIntoLegacySession(session = {}, identity = {}) {
  // Never preserve a password if a caller accidentally passes a legacy USERS row.
  const { password, ...safeSession } = session || {};
  void password;
  return {
    ...safeSession,
    ...employeeIdentityToLegacySession(identity),
  };
}
