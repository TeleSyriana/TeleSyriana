// employee-password-policy.js — pure TeleSyriana credential lifecycle policy
//
// The actual onboarding/reset password is supplied out-of-band at provisioning time
// and MUST NOT be committed to source control. Temporary passwords always require a
// change on the next successful login.

export const PASSWORD_MAX_AGE_DAYS = 90;
export const PASSWORD_MAX_AGE_MS = PASSWORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
export const PASSWORD_HISTORY_LIMIT = 5;

function clean(value) {
  return String(value ?? "");
}

function timestampToMs(value) {
  if (!value) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === "function") return Number(value.toMillis()) || 0;
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function validateEmployeePassword(password) {
  const value = clean(password);
  if (value.length < 10) throw new Error("Password must contain at least 10 characters.");
  if (value.length > 128) throw new Error("Password is too long.");
  if (!/[a-z]/.test(value)) throw new Error("Password must include a lowercase letter.");
  if (!/[A-Z]/.test(value)) throw new Error("Password must include an uppercase letter.");
  if (!/[0-9]/.test(value)) throw new Error("Password must include a number.");
  if (!/[^A-Za-z0-9]/.test(value)) throw new Error("Password must include a symbol.");
  return value;
}

export function passwordLifecycleState(record = {}, nowMs = Date.now()) {
  const changedAtMs = timestampToMs(record.passwordChangedAt || record.updatedAt || record.createdAt);
  const maxAgeDays = Math.max(1, Number(record.passwordMaxAgeDays) || PASSWORD_MAX_AGE_DAYS);
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const expiresAtMs = changedAtMs ? changedAtMs + maxAgeMs : 0;
  const mustChangePassword = record.mustChangePassword !== false;
  const passwordExpired = Boolean(changedAtMs && Number(nowMs) >= expiresAtMs);
  return {
    changedAtMs,
    expiresAtMs,
    maxAgeDays,
    mustChangePassword,
    passwordExpired,
    passwordChangeRequired: mustChangePassword || passwordExpired,
  };
}

export function trimCredentialHistory(history = [], limit = PASSWORD_HISTORY_LIMIT) {
  return (Array.isArray(history) ? history : [])
    .filter((row) => row && typeof row === "object")
    .slice(0, Math.max(1, Number(limit) || PASSWORD_HISTORY_LIMIT))
    .map((row) => ({
      credentialVersion: Number(row.credentialVersion) || 0,
      algorithm: String(row.algorithm || ""),
      iterations: Number(row.iterations) || 0,
      salt: String(row.salt || ""),
      passwordHash: String(row.passwordHash || ""),
    }));
}

export function credentialHistoryEntry(record = {}) {
  if (!record.passwordHash || !record.salt) return null;
  return {
    credentialVersion: Number(record.credentialVersion) || 0,
    algorithm: String(record.algorithm || ""),
    iterations: Number(record.iterations) || 0,
    salt: String(record.salt || ""),
    passwordHash: String(record.passwordHash || ""),
  };
}
