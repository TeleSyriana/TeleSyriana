// employee-auth-v2.js — controlled permanent authentication bridge
//
// New credentials are keyed by permanent employeeUid. Temporary credentials always
// require a first-login password change. Permanent passwords expire after 90 days.
// Password hashes/salts/history are never returned through account-support metadata.

import { db, fs } from "./firebase.js";
import { authenticateEmployee as authenticateLegacyEmployee } from "./employee-directory-core.js";
import { employeeIdentityToLegacySession } from "./employee-identity-compat.js";
import { seedIdentityByCcms } from "./employee-identity-seed.js";
import { getEmployeeIdentityByCcms } from "./employee-identity-store.js";
import {
  createPasswordCredential,
  verifyPasswordCredential,
} from "./employee-credential-crypto.js";
import {
  PASSWORD_HISTORY_LIMIT,
  PASSWORD_MAX_AGE_DAYS,
  credentialHistoryEntry,
  passwordLifecycleState,
  trimCredentialHistory,
  validateEmployeePassword,
} from "./employee-password-policy.js";

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

function safeCredentialMetadata(record = {}, nowMs = Date.now()) {
  const lifecycle = passwordLifecycleState(record, nowMs);
  return {
    employeeUid: clean(record.employeeUid),
    ccmsId: clean(record.ccmsId),
    credentialVersion: Number(record.credentialVersion) || 0,
    algorithm: String(record.algorithm || ""),
    iterations: Number(record.iterations) || 0,
    mustChangePassword: lifecycle.mustChangePassword,
    passwordExpired: lifecycle.passwordExpired,
    passwordChangeRequired: lifecycle.passwordChangeRequired,
    passwordChangedAtMs: lifecycle.changedAtMs,
    passwordExpiresAtMs: lifecycle.expiresAtMs,
    passwordMaxAgeDays: lifecycle.maxAgeDays,
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

async function candidateMatchesCredentialHistory(password, record = {}) {
  if (await verifyPasswordCredential(password, record)) return true;
  const history = trimCredentialHistory(record.passwordHistory, PASSWORD_HISTORY_LIMIT);
  for (const previous of history) {
    if (await verifyPasswordCredential(password, previous)) return true;
  }
  return false;
}

function nextPasswordHistory(record = {}) {
  const current = credentialHistoryEntry(record);
  return trimCredentialHistory([
    ...(current ? [current] : []),
    ...(Array.isArray(record.passwordHistory) ? record.passwordHistory : []),
  ], PASSWORD_HISTORY_LIMIT);
}

export async function provisionTemporaryEmployeeCredential(identity, temporaryPassword, actor = null) {
  assertProvisioningActor(actor);
  validateEmployeePassword(temporaryPassword);
  const employeeUid = clean(identity?.employeeUid);
  const ccmsId = clean(identity?.ccmsId);
  if (!employeeUid || !ccmsId) throw new Error("Permanent employeeUid and CCMS are required before provisioning credentials.");

  const ref = doc(db, EMPLOYEE_CREDENTIALS_COL, employeeUid);
  const existingSnap = await getDoc(ref);
  const existing = existingSnap.exists() ? { ...existingSnap.data(), employeeUid } : null;
  const credential = await createPasswordCredential(temporaryPassword);
  const payload = {
    employeeUid,
    ccmsId,
    ...credential,
    passwordHistory: existing ? nextPasswordHistory(existing) : [],
    passwordMaxAgeDays: PASSWORD_MAX_AGE_DAYS,
    mustChangePassword: true,
    passwordChangedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...actorFields(actor),
  };

  if (!existing) {
    payload.createdAt = serverTimestamp();
    payload.createdByUid = clean(actor?.employeeUid || actor?.uid);
    payload.createdByCcmsId = clean(actor?.ccmsId || actor?.id);
  }

  await setDoc(ref, payload, { merge: true });
  return safeCredentialMetadata(payload);
}

export async function changeEmployeePassword({
  employeeUid,
  currentPassword,
  newPassword,
  actor = null,
} = {}) {
  const uid = clean(employeeUid || actor?.employeeUid || actor?.uid);
  if (!uid) throw new Error("employeeUid is required.");
  validateEmployeePassword(newPassword);

  const record = await readCredentialRecord(uid);
  if (!record) throw new Error("Credential is not provisioned for this employee.");
  const currentOk = await verifyPasswordCredential(currentPassword, record);
  if (!currentOk) throw new Error("Current password is incorrect.");
  if (await candidateMatchesCredentialHistory(newPassword, record)) {
    throw new Error(`New password cannot match the current password or the last ${PASSWORD_HISTORY_LIMIT} passwords.`);
  }

  const credential = await createPasswordCredential(newPassword);
  const payload = {
    ...credential,
    passwordHistory: nextPasswordHistory(record),
    passwordMaxAgeDays: PASSWORD_MAX_AGE_DAYS,
    mustChangePassword: false,
    passwordChangedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...actorFields(actor || { employeeUid: uid }),
  };
  await setDoc(doc(db, EMPLOYEE_CREDENTIALS_COL, uid), payload, { merge: true });
  return safeCredentialMetadata({ ...record, ...payload, employeeUid: uid });
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
    (clean(legacyIdentity.ccmsId) === clean(identity?.ccmsId) || legacyIdentity.previousCcmsIds?.includes(clean(ccmsId)))
  );
}

async function authenticateThroughLegacyFallback(identity, ccmsId, password) {
  if (!legacyFallbackAllowed(identity, ccmsId)) return null;
  const authCcmsId = identity.previousCcmsIds?.includes(clean(ccmsId))
    ? clean(ccmsId)
    : clean(identity.previousCcmsIds?.[0] || ccmsId);
  const legacy = await authenticateLegacyEmployee(authCcmsId, password);
  if (!legacy?.ok) return legacy;

  return {
    ok: true,
    reason: "ok",
    employee: {
      ...employeeIdentityToLegacySession(identity),
      authSource: "legacy_compatibility",
      mustChangePassword: false,
      passwordExpired: false,
      passwordChangeRequired: false,
      passwordPolicyMigrationRequired: true,
    },
  };
}

function seedIdentityForAuth(ccmsId) {
  const seed = seedIdentityByCcms(ccmsId);
  return seed ? { ...seed, directorySource: "seed" } : null;
}

export async function authenticateEmployeeV2(ccmsId, password) {
  const id = clean(ccmsId);
  if (!id) return { ok: false, reason: "not_found", employee: null };

  // Known current/legacy staff should not wait on a Firestore identity lookup.
  // This is especially important during quota/network incidents. Managed users such
  // as Lana can still use the hashed employeeCredentials record keyed by employeeUid.
  const seededIdentity = seedIdentityForAuth(id);
  const identity = seededIdentity || await getEmployeeIdentityByCcms(id, { allowSeedFallback: false });
  if (!identity) return { ok: false, reason: "not_found", employee: null };
  if (identity.accountStatus !== "active") {
    return { ok: false, reason: identity.accountStatus || "disabled", employee: null };
  }

  // Existing legacy accounts authenticate immediately without touching the permanent
  // credential collection. Seeded accounts explicitly awaiting credential setup skip
  // this path and continue to the secure hashed credential lookup below.
  if (identity.directorySource === "seed" && identity.credentialSetupRequired !== true) {
    const legacy = await authenticateThroughLegacyFallback(identity, id, password);
    if (legacy) return legacy;
  }

  let credential = null;
  try {
    credential = await readCredentialRecord(identity.employeeUid);
  } catch (error) {
    if (identity.credentialSetupRequired !== true) {
      const legacy = await authenticateThroughLegacyFallback(identity, id, password);
      if (legacy) return legacy;
    }
    return {
      ok: false,
      reason: "credential_unavailable",
      employee: null,
      error: String(error?.message || error),
    };
  }

  if (credential && clean(credential.ccmsId) === identity.ccmsId) {
    const passwordOk = await verifyPasswordCredential(password, credential);
    if (!passwordOk) return { ok: false, reason: "incorrect_password", employee: null };
    const lifecycle = passwordLifecycleState(credential);

    return {
      ok: true,
      reason: lifecycle.passwordChangeRequired ? "password_change_required" : "ok",
      employee: {
        ...employeeIdentityToLegacySession(identity),
        authSource: "permanent_hashed_credential",
        mustChangePassword: lifecycle.mustChangePassword,
        passwordExpired: lifecycle.passwordExpired,
        passwordChangeRequired: lifecycle.passwordChangeRequired,
        passwordExpiresAtMs: lifecycle.expiresAtMs,
        passwordMaxAgeDays: lifecycle.maxAgeDays,
      },
    };
  }

  if (identity.credentialSetupRequired !== true) {
    const legacy = await authenticateThroughLegacyFallback(identity, id, password);
    if (legacy) return legacy;
  }

  return {
    ok: false,
    reason: credential ? "credential_ccms_mismatch" : "credential_not_provisioned",
    employee: null,
  };
}
