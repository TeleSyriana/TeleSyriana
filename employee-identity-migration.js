// employee-identity-migration.js — TeleSyriana Phase 1A controlled migration
//
// This module deliberately separates preview/inspection from writes.
// Nothing here is imported by the production app. The migration can only be
// applied when an explicit CEO actor and exact confirmation token are supplied.

import { db, fs } from "./firebase.js";
import { CURRENT_EMPLOYEE_IDENTITY_SEED } from "./employee-identity-seed.js";
import { seedCurrentEmployeeIdentities } from "./employee-identity-store.js";
import { DEFAULT_PROJECT_ID } from "./project-model.js";
import { ensureDefaultIProProject } from "./project-directory.js";
import {
  EMPLOYEE_CCMS_INDEX_COL,
  EMPLOYEE_IDENTITIES_COL,
  PROJECTS_COL,
} from "./phase1a-collections.js";
import { buildPhase1AMigrationPlan } from "./phase1a-migration-plan.js";
import {
  PHASE1A_MIGRATION_CONFIRMATION,
  assertPhase1AMigrationWriteGate,
} from "./phase1a-migration-guard.js";

const { doc, getDoc } = fs;

export { PHASE1A_MIGRATION_CONFIRMATION, buildPhase1AMigrationPlan };

function clean(value) {
  return String(value ?? "").trim();
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
  assertPhase1AMigrationWriteGate({ actor, confirmation });

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
