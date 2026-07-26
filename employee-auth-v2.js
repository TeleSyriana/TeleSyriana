// employee-auth-v2.js — Phase 1B controlled dynamic authentication bridge
//
// Not wired into production app.js yet.
// Existing seven CCMS accounts continue to use the known-good legacy fallback.
// New/permanently reclassified identities can use hashed credentials keyed by the
// permanent employeeUid, so a future CCMS promotion does not create a new person.

import { db, fs } from "./firebase.js";
import { authenticateEmployee as authenticateLegacyEmployee } from "./employee-directory-core.js";
import { employeeIdentityToLegacySession } from "./employee-identity-compat.js";
import { seedIdentityByCcms } from "./employee-identity-seed.js";
import { getEmployeeIdentityByCcms } from "./employee-identity-store.js";
import {
  createPasswordCredential,
  verifyPasswordCredential,
} from "./employee-credential-crypto.js";

const { doc, getDoc, serverTimestamp, setDoc } = fs;

export const EMPLOYEE_CREDENTIALS_COL = "employeeCredentials";

function clean(value) {
  return String(value ?? "").trim();
}

function actorFields(actor = null) {
  return {
    updatedByUid: clean(actor?.employeeUid || actor?.uid),
    updatedByCcmsId: clean(actor?.ccmsId || actor?.id),
    updatedByName: clean(actor?.fullName || actor?.name),
  };
}

function assertProvisioningActor(actor = null) {
  if (!clean(actor?.employeeUid || actor?.uid || actor?.ccmsId || actor?.id)) {
    throw new Error("An authenticated management actor is required for credential provisioning.");
  }
}

function safeCredentialMetadata(record = {}) {
  return {
    employeeUid: clean(record.employeeUid),
    ccmsId: clean(record.ccmsId),
    credentialVersion: Number(record.credentialVersion) || 0,
    algorithm: String(record.algorithm || ""),
    iterations: Number(record.iterations) || 0,
    mustChangePassword: record.mustChangePassword !== false,
  };
}

async function readCredentialRecord(employeeUid) {
  const uid = clean(employeeUid);
  if (!uid) return null;
  const snap = await getDoc(doc(db, EMPLOYEE_CREDENTIALS_COL, uid));
  return snap.exists() ? { ...snap.data(), employeeUid: uid } : null;
}

export async function getEmployeeCredentialState(employeeUid) {
  try {
    const record = await readCredentialRecord(employeeUid);
    return record
      ? { exists: true, ...safeCredentialMetadata(record) }
      : { exists: false, employeeUid: clean(employeeUid) };
  } catch (error) {
    return {
      exists: false,
      employeeUid: clean(employeeUid),
      unavailable: true,
      error: String(error?.message || error),
    };
  }
}

export async function provisionTemporaryEmployeeCredential(identity, temporaryPassword, actor = null) {
  assertProvisioningActor(actor);
  const employeeUid = clean(identity?.employeeUid);
  const ccmsId = clean(identity?.ccmsId);
  if (!employeeUid || !ccmsId) throw new Error("Permanent employeeUid and CCMS are required before provisioning credentials.");

  const credential = await createPasswordCredential(temporaryPassword);
  const payload = {
    employeeUid,
    ccmsId,
    ...credential,
    mustChangePassword: true,
    updatedAt: serverTimestamp(),
    ...actorFields(actor),
  };

  const ref = doc(db, EMPLOYEE_CREDENTIALS_COL, employeeUid);
  const existing = await getDoc(ref);
  if (!existing.exists()) {
    payload.createdAt = serverTimestamp();
    payload.createdByUid = clean(actor?.employeeUid || actor?.uid);
    payload.createdByCcmsId = clean(actor?.ccmsId || actor?.id);
  }

  await setDoc(ref, payload, { merge: true });
  return safeCredentialMetadata(payload);
}

export async function syncEmployeeCredentialCcms(employeeUid, ccmsId, actor = null) {
  assertProvisioningActor(actor);
  const uid = clean(employeeUid);
  const nextCcms = clean(ccmsId);
  if (!uid || !nextCcms) throw new Error("employeeUid and CCMS are required.");

  const ref = doc(db, EMPLOYEE_CREDENTIALS_COL, uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return { updated: false, reason: "not_provisioned" };

  await setDoc(ref, {
    ccmsId: nextCcms,
    updatedAt: serverTimestamp(),
    ...actorFields(actor),
  }, { merge: true });
  return { updated: true, employeeUid: uid, ccmsId: nextCcms };
}

function legacyFallbackAllowed(identity, ccmsId) {
  const legacyIdentity = seedIdentityByCcms(ccmsId);
  return Boolean(
    legacyIdentity &&
    clean(legacyIdentity.employeeUid) === clean(identity?.employeeUid) &&
    clean(legacyIdentity.ccmsId) === clean(identity?.ccmsId)
  );
}

async function authenticateThroughLegacyFallback(identity, ccmsId, password) {
  if (!legacyFallbackAllowed(identity, ccmsId)) return null;
  const legacy = await authenticateLegacyEmployee(ccmsId, password);
  if (!legacy?.ok) return legacy;

  return {
    ok: true,
    reason: "ok",
    employee: {
      ...employeeIdentityToLegacySession(identity),
      authSource: "legacy_compatibility",
      mustChangePassword: false,
    },
  };
}

export async function authenticateEmployeeV2(ccmsId, password) {
  const id = clean(ccmsId);
  if (!id) return { ok: false, reason: "not_found", employee: null };

  const identity = await getEmployeeIdentityByCcms(id, { allowSeedFallback: true });
  if (!identity) return { ok: false, reason: "not_found", employee: null };
  if (identity.accountStatus !== "active") {
    return { ok: false, reason: identity.accountStatus || "disabled", employee: null };
  }

  // While Phase 1A Firestore is unavailable, seed identities intentionally go
  // straight to the proven legacy path instead of creating another failed read.
  if (identity.directorySource === "seed") {
    const legacy = await authenticateThroughLegacyFallback(identity, id, password);
    return legacy || { ok: false, reason: "credential_unavailable", employee: null };
  }

  let credential = null;
  try {
    credential = await readCredentialRecord(identity.employeeUid);
  } catch (error) {
    const legacy = await authenticateThroughLegacyFallback(identity, id, password);
    if (legacy) return legacy;
    return {
      ok: false,
      reason: "credential_unavailable",
      employee: null,
      error: String(error?.message || error),
    };
  }

  if (credential && clean(credential.ccmsId) === identity.ccmsId) {
    let passwordOk = false;
    try { passwordOk = await verifyPasswordCredential(password, credential); }
    catch { passwordOk = false; }
    if (!passwordOk) return { ok: false, reason: "incorrect_password", employee: null };

    return {
      ok: true,
      reason: "ok",
      employee: {
        ...employeeIdentityToLegacySession(identity),
        authSource: "permanent_hashed_credential",
        mustChangePassword: credential.mustChangePassword !== false,
      },
    };
  }

  // Migrated legacy staff may not yet have a hashed credential. As long as their
  // CCMS is still exactly the original seed CCMS, the old credential remains a
  // safe compatibility fallback. Once their CCMS changes, this fallback is no
  // longer allowed and a permanent credential is mandatory.
  const legacy = await authenticateThroughLegacyFallback(identity, id, password);
  if (legacy) return legacy;

  return {
    ok: false,
    reason: credential ? "credential_ccms_mismatch" : "credential_not_provisioned",
    employee: null,
  };
}
