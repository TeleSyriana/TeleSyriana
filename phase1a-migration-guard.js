// phase1a-migration-guard.js — explicit write gate for Phase 1A migration helpers

import { EMPLOYEE_ROLES, normaliseCanonicalRole } from "./employee-model.js";

export const PHASE1A_MIGRATION_CONFIRMATION = "APPLY_PHASE_1A_IDENTITY_MIGRATION";

function clean(value) {
  return String(value ?? "").trim();
}

export function assertPhase1AMigrationActor(actor = null) {
  const actorId = clean(actor?.employeeUid || actor?.uid || actor?.ccmsId || actor?.id);
  const role = normaliseCanonicalRole(actor?.roleKey || actor?.role);

  if (!actorId || role !== EMPLOYEE_ROLES.CEO) {
    throw new Error("CEO permission is required to apply the Phase 1A identity migration.");
  }

  return actor;
}

export function assertPhase1AMigrationConfirmation(confirmation) {
  if (clean(confirmation) !== PHASE1A_MIGRATION_CONFIRMATION) {
    throw new Error("Phase 1A identity migration confirmation token is required.");
  }
  return true;
}

export function assertPhase1AMigrationWriteGate({ actor, confirmation } = {}) {
  assertPhase1AMigrationActor(actor);
  assertPhase1AMigrationConfirmation(confirmation);
  return true;
}
