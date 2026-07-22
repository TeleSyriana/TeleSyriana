// employee-identity-migration.js — TeleSyriana Phase 1A controlled migration
//
// This module deliberately separates preview/inspection from writes.
// Nothing here is imported by the production app. The migration can only be
// applied when an explicit CEO actor and exact confirmation token are supplied.

import { db, fs } from "./firebase.js";
import { CURRENT_EMPLOYEE_IDENTITY_SEED } from "./employee-identity-seed.js";
import {
  EMPLOYEE_CCMS_INDEX_COL,
  EMPLOYEE_IDENTITIES_COL,
  seedCurrentEmployeeIdentities,
} from "./employee-identity-store.js";
import { EMPLOYEE_ROLES, normaliseCanonicalRole } from "./employee-model.js";
import { DEFAULT_PROJECT, DEFAULT_PROJECT_ID } from "./project-model.js";
import { PROJECTS_COL, ensureDefaultIProProject } from "./project-directory.js";

const { doc, getDoc } = fs;

export const PHASE1A_MIGRATION_CONFIRMATION = "APPLY_PHASE_1A_IDENTITY_MIGRATION";

function clean(value) {
  return String(value ?? "").trim();
}

function actorRole(actor = null) {
  return normaliseCanonicalRole(actor?.roleKey || actor?.role);
}

function assertMigrationActor(actor = null) {
  const actorId = clean(actor?.employeeUid || actor?.uid || actor?.ccmsId || actor?.id);
  if (!actorId || actorRole(actor) !== EMPLOYEE_ROLES.CEO) {
    throw new Error("CEO permission is required to apply the Phase 1A identity migration.");
  }
}

function assertMigrationConfirmation(confirmation) {
  if (clean(confirmation) !== PHASE1A_MIGRATION_CONFIRMATION) {
    throw new Error("Phase 1A identity migration confirmation token is required.");
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function buildPhase1AMigrationPlan() {
  const identities = CURRENT_EMPLOYEE_IDENTITY_SEED.map((employee) => ({
    collection: EMPLOYEE_IDENTITIES_COL,
    documentId: employee.employeeUid,
    employeeUid: employee.employeeUid,
    ccmsId: employee.ccmsId,
    fullName: employee.fullName,
    roleKey: employee.roleKey,
    projectId: employee.projectId,
    projectIds: [...employee.projectIds],
    supervisorUid: employee.supervisorUid || "",
    supervisorCcmsId: employee.supervisorCcmsId || "",
    accountStatus: employee.accountStatus,
  }));

  const ccmsIndexes = CURRENT_EMPLOYEE_IDENTITY_SEED.map((employee) => ({
    collection: EMPLOYEE_CCMS_INDEX_COL,
    documentId: employee.ccmsId,
    employeeUid: employee.employeeUid,
    ccmsId: employee.ccmsId,
  }));

  const projects = [{
    collection: PROJECTS_COL,
    documentId: DEFAULT_PROJECT_ID,
    projectId: DEFAULT_PROJECT.projectId,
    name: DEFAULT_PROJECT.name,
    accountStatus: DEFAULT_PROJECT.accountStatus,
    isDefault: DEFAULT_PROJECT.isDefault,
  }];

  return clone({
    mode: "preview",
    writesPerformed: false,
    employeeCount: identities.length,
    plannedDocumentCount: identities.length + ccmsIndexes.length + projects.length,
    collections: {
      identities,
      ccmsIndexes,
      projects,
    },
  });
}

async function inspectDocument(ref) {
  const snap = await getDoc(ref);
  return snap.exists() ? { exists: true, data: snap.data() || {} } : { exists: false, data: null };
}

// Explicit read-only inspection. This is intentionally NOT used by app startup.
// It performs at most 15 Firestore document reads for the current seven-person
// seed (7 identity docs + 7 CCMS index docs + the iPro project doc).
export async function inspectPhase1AMigrationState() {
  const plan = buildPhase1AMigrationPlan();
  const rows = [];
  const conflicts = [];

  for (const employee of CURRENT_EMPLOYEE_IDENTITY_SEED) {
    const identityState = await inspectDocument(doc(db, EMPLOYEE_IDENTITIES_COL, employee.employeeUid));
    const indexState = await inspectDocument(doc(db, EMPLOYEE_CCMS_INDEX_COL, employee.ccmsId));

    const identityCcms = clean(identityState.data?.ccmsId);
    const indexedUid = clean(indexState.data?.employeeUid);

    if (identityState.exists && identityCcms && identityCcms !== employee.ccmsId) {
      conflicts.push({
        type: "identity_ccms_mismatch",
        employeeUid: employee.employeeUid,
        expectedCcmsId: employee.ccmsId,
        actualCcmsId: identityCcms,
      });
    }

    if (indexState.exists && indexedUid && indexedUid !== employee.employeeUid) {
      conflicts.push({
        type: "ccms_index_conflict",
        ccmsId: employee.ccmsId,
        expectedEmployeeUid: employee.employeeUid,
        actualEmployeeUid: indexedUid,
      });
    }

    rows.push({
      employeeUid: employee.employeeUid,
      ccmsId: employee.ccmsId,
      identityExists: identityState.exists,
      ccmsIndexExists: indexState.exists,
      identityAction: identityState.exists ? "keep" : "create",
      ccmsIndexAction: indexState.exists ? "keep" : "create",
    });
  }

  const projectState = await inspectDocument(doc(db, PROJECTS_COL, DEFAULT_PROJECT_ID));

  return {
    mode: "read_only_inspection",
    writesPerformed: false,
    maximumReads: 15,
    plan,
    employees: rows,
    project: {
      projectId: DEFAULT_PROJECT_ID,
      exists: projectState.exists,
      action: projectState.exists ? "keep" : "create",
    },
    conflicts,
    safeToApply: conflicts.length === 0,
  };
}

export async function applyPhase1AIdentityMigration({ actor, confirmation } = {}) {
  assertMigrationActor(actor);
  assertMigrationConfirmation(confirmation);

  // Re-check for collisions immediately before the write stage. The inspection
  // itself is read-only and bounded; writes remain delegated to transactional
  // identity/index helpers so CCMS collisions cannot silently overwrite people.
  const inspection = await inspectPhase1AMigrationState();
  if (!inspection.safeToApply) {
    const error = new Error("Phase 1A migration has identity/CCMS conflicts and was not applied.");
    error.conflicts = inspection.conflicts;
    throw error;
  }

  const project = await ensureDefaultIProProject(actor, { confirmation });
  const employees = await seedCurrentEmployeeIdentities(actor, { confirmation });

  return {
    mode: "applied",
    writesPerformed: true,
    project,
    employees,
    employeeCount: employees.length,
  };
}
