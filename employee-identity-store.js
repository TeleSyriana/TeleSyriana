// employee-identity-store.js — TeleSyriana Phase 1A Firestore identity storage
//
// New architecture (not wired into production login yet):
//   employeeIdentities/{employeeUid}  -> permanent person record
//   employeeCcmsIndex/{ccmsId}        -> current CCMS -> employeeUid lookup
//
// This prevents promotion/demotion from creating a new person just because the
// employee's operational CCMS classification changes.

import { db, fs } from "./firebase.js";
import {
  EMPLOYEE_ROLES,
  cleanCcmsId,
  createEmployeeUid,
  normaliseEmployeeIdentity,
  validateEmployeeIdentity,
} from "./employee-model.js";
import {
  CURRENT_EMPLOYEE_IDENTITY_SEED,
  seedIdentityByCcms,
  seedIdentityByUid,
} from "./employee-identity-seed.js";

const {
  collection,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
  setDoc,
} = fs;

export const EMPLOYEE_IDENTITIES_COL = "employeeIdentities";
export const EMPLOYEE_CCMS_INDEX_COL = "employeeCcmsIndex";

function clean(value) {
  return String(value ?? "").trim();
}

function clone(row) {
  return row ? { ...row, projectIds: [...(row.projectIds || [])] } : null;
}

function identityPayload(employee, actor = null, { isCreate = false } = {}) {
  const row = validateEmployeeIdentity(employee);
  const payload = {
    employeeUid: row.employeeUid,
    ccmsId: row.ccmsId,
    fullName: row.fullName,
    name: row.fullName,
    roleKey: row.roleKey,
    legacyRole: row.legacyRole,
    accountStatus: row.accountStatus,
    projectId: row.projectId,
    projectIds: row.projectIds,
    supervisorUid: row.supervisorUid,
    supervisorCcmsId: row.supervisorCcmsId,
    hourlyRate: row.hourlyRate,
    currency: row.currency,
    timezone: row.timezone,
    language: row.language,
    updatedAt: serverTimestamp(),
    updatedByUid: clean(actor?.employeeUid || actor?.uid),
    updatedByCcmsId: cleanCcmsId(actor?.ccmsId || actor?.id),
    updatedByName: clean(actor?.fullName || actor?.name),
  };

  if (isCreate) {
    payload.createdAt = serverTimestamp();
    payload.createdByUid = clean(actor?.employeeUid || actor?.uid);
    payload.createdByCcmsId = cleanCcmsId(actor?.ccmsId || actor?.id);
    payload.createdByName = clean(actor?.fullName || actor?.name);
  }

  return payload;
}

function indexPayload(employeeUid, ccmsId, actor = null) {
  return {
    employeeUid: clean(employeeUid),
    ccmsId: cleanCcmsId(ccmsId),
    updatedAt: serverTimestamp(),
    updatedByUid: clean(actor?.employeeUid || actor?.uid),
    updatedByCcmsId: cleanCcmsId(actor?.ccmsId || actor?.id),
  };
}

export async function getEmployeeIdentityByUid(employeeUid, options = {}) {
  const uid = clean(employeeUid);
  if (!uid) return null;
  const allowSeedFallback = options.allowSeedFallback !== false;

  try {
    const snap = await getDoc(doc(db, EMPLOYEE_IDENTITIES_COL, uid));
    if (snap.exists()) {
      return clone(normaliseEmployeeIdentity({ ...snap.data(), employeeUid: uid }));
    }
  } catch (err) {
    console.warn("Employee identity UID lookup failed; using compatibility seed when available.", err);
  }

  return allowSeedFallback ? clone(seedIdentityByUid(uid)) : null;
}

export async function getEmployeeIdentityByCcms(ccmsId, options = {}) {
  const id = cleanCcmsId(ccmsId);
  if (!id) return null;
  const allowSeedFallback = options.allowSeedFallback !== false;

  try {
    const indexSnap = await getDoc(doc(db, EMPLOYEE_CCMS_INDEX_COL, id));
    if (indexSnap.exists()) {
      const uid = clean(indexSnap.data()?.employeeUid);
      if (uid) {
        const identity = await getEmployeeIdentityByUid(uid, { allowSeedFallback: false });
        if (identity) return identity;
      }
    }
  } catch (err) {
    console.warn("Employee CCMS index lookup failed; using compatibility seed when available.", err);
  }

  return allowSeedFallback ? clone(seedIdentityByCcms(id)) : null;
}

export async function listEmployeeIdentities(options = {}) {
  const includeDisabled = options.includeDisabled === true;
  const includeArchived = options.includeArchived === true;
  const includeSeedFallback = options.includeSeedFallback !== false;
  const rows = new Map();

  if (includeSeedFallback) {
    CURRENT_EMPLOYEE_IDENTITY_SEED.forEach((row) => rows.set(row.employeeUid, clone(row)));
  }

  try {
    const snap = await getDocs(collection(db, EMPLOYEE_IDENTITIES_COL));
    snap.forEach((item) => {
      const row = normaliseEmployeeIdentity({ ...item.data(), employeeUid: item.id });
      if (row.employeeUid) rows.set(row.employeeUid, row);
    });
  } catch (err) {
    console.warn("Employee identity list failed; using compatibility identity seed.", err);
  }

  return Array.from(rows.values())
    .filter((row) => includeDisabled || row.accountStatus !== "disabled")
    .filter((row) => includeArchived || row.accountStatus !== "archived")
    .map(clone)
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

async function resolveSupervisorForAgent(employee) {
  if (employee.roleKey !== EMPLOYEE_ROLES.AGENT) return null;

  let supervisor = null;
  if (employee.supervisorUid) {
    supervisor = await getEmployeeIdentityByUid(employee.supervisorUid, { allowSeedFallback: true });
  }
  if (!supervisor && employee.supervisorCcmsId) {
    supervisor = await getEmployeeIdentityByCcms(employee.supervisorCcmsId, { allowSeedFallback: true });
  }

  if (!supervisor) throw new Error("Assigned Supervisor does not exist.");
  if (supervisor.roleKey !== EMPLOYEE_ROLES.SUPERVISOR) {
    throw new Error("Agent can only be assigned to a Supervisor account.");
  }
  if (supervisor.accountStatus !== "active") {
    throw new Error("Agent cannot be assigned to an inactive Supervisor.");
  }
  if (supervisor.projectId !== employee.projectId) {
    throw new Error("Agent and Supervisor must belong to the same project.");
  }

  return supervisor;
}

export async function createEmployeeIdentity(input = {}, actor = null) {
  const initial = normaliseEmployeeIdentity({
    ...input,
    employeeUid: clean(input.employeeUid) || createEmployeeUid(),
  });
  const employee = validateEmployeeIdentity(initial);
  const supervisor = await resolveSupervisorForAgent(employee);

  if (supervisor) {
    employee.supervisorUid = supervisor.employeeUid;
    employee.supervisorCcmsId = supervisor.ccmsId;
  }

  const identityRef = doc(db, EMPLOYEE_IDENTITIES_COL, employee.employeeUid);
  const indexRef = doc(db, EMPLOYEE_CCMS_INDEX_COL, employee.ccmsId);

  await runTransaction(db, async (tx) => {
    const [identitySnap, indexSnap] = await Promise.all([
      tx.get(identityRef),
      tx.get(indexRef),
    ]);

    if (identitySnap.exists()) throw new Error("Employee UID already exists.");
    if (indexSnap.exists()) throw new Error(`CCMS ${employee.ccmsId} is already assigned.`);

    tx.set(identityRef, identityPayload(employee, actor, { isCreate: true }));
    tx.set(indexRef, indexPayload(employee.employeeUid, employee.ccmsId, actor));
  });

  return clone(employee);
}

export async function updateEmployeeIdentity(employeeUid, patch = {}, actor = null) {
  const uid = clean(employeeUid);
  if (!uid) throw new Error("employeeUid is required.");

  const existing = await getEmployeeIdentityByUid(uid, { allowSeedFallback: false });
  if (!existing) throw new Error("Employee identity not found in the permanent directory.");

  if (patch.employeeUid && clean(patch.employeeUid) !== uid) {
    throw new Error("employeeUid is permanent and cannot be changed.");
  }

  const next = validateEmployeeIdentity({
    ...existing,
    ...patch,
    employeeUid: uid,
  });
  const supervisor = await resolveSupervisorForAgent(next);
  if (supervisor) {
    next.supervisorUid = supervisor.employeeUid;
    next.supervisorCcmsId = supervisor.ccmsId;
  } else {
    next.supervisorUid = "";
    next.supervisorCcmsId = "";
  }

  const identityRef = doc(db, EMPLOYEE_IDENTITIES_COL, uid);
  const oldIndexRef = doc(db, EMPLOYEE_CCMS_INDEX_COL, existing.ccmsId);
  const newIndexRef = doc(db, EMPLOYEE_CCMS_INDEX_COL, next.ccmsId);

  await runTransaction(db, async (tx) => {
    const identitySnap = await tx.get(identityRef);
    if (!identitySnap.exists()) throw new Error("Employee identity no longer exists.");

    if (next.ccmsId !== existing.ccmsId) {
      const newIndexSnap = await tx.get(newIndexRef);
      if (newIndexSnap.exists() && clean(newIndexSnap.data()?.employeeUid) !== uid) {
        throw new Error(`CCMS ${next.ccmsId} is already assigned.`);
      }
      tx.delete(oldIndexRef);
      tx.set(newIndexRef, indexPayload(uid, next.ccmsId, actor));
    } else {
      tx.set(newIndexRef, indexPayload(uid, next.ccmsId, actor), { merge: true });
    }

    tx.set(identityRef, identityPayload(next, actor), { merge: true });
  });

  return clone(next);
}

export async function seedCurrentEmployeeIdentities(actor = null) {
  const results = [];

  for (const seed of CURRENT_EMPLOYEE_IDENTITY_SEED) {
    const identityRef = doc(db, EMPLOYEE_IDENTITIES_COL, seed.employeeUid);
    const indexRef = doc(db, EMPLOYEE_CCMS_INDEX_COL, seed.ccmsId);

    await runTransaction(db, async (tx) => {
      const [identitySnap, indexSnap] = await Promise.all([
        tx.get(identityRef),
        tx.get(indexRef),
      ]);

      if (indexSnap.exists() && clean(indexSnap.data()?.employeeUid) !== seed.employeeUid) {
        throw new Error(`Cannot seed ${seed.ccmsId}: CCMS is already assigned to another employee UID.`);
      }

      if (!identitySnap.exists()) {
        tx.set(identityRef, identityPayload(seed, actor, { isCreate: true }));
      }
      if (!indexSnap.exists()) {
        tx.set(indexRef, indexPayload(seed.employeeUid, seed.ccmsId, actor));
      }
    });

    results.push(clone(seed));
  }

  return results;
}

// Optional helper used by Phase 1B after HR/CEO/ACM chooses a new role and CCMS.
// updateEmployeeIdentity preserves employeeUid while moving the CCMS index.
export async function reclassifyEmployee(employeeUid, { roleKey, ccmsId, projectId, projectIds, supervisorUid, supervisorCcmsId } = {}, actor = null) {
  return updateEmployeeIdentity(employeeUid, {
    roleKey,
    ccmsId,
    projectId,
    projectIds,
    supervisorUid,
    supervisorCcmsId,
  }, actor);
}

// Intentionally explicit. Nothing in Phase 1A calls this automatically on app
// startup because production Firestore is currently quota-sensitive.
export async function ensureIdentityIndex(employee, actor = null) {
  const row = validateEmployeeIdentity(employee);
  await setDoc(doc(db, EMPLOYEE_CCMS_INDEX_COL, row.ccmsId), indexPayload(row.employeeUid, row.ccmsId, actor), { merge: true });
  return clone(row);
}
