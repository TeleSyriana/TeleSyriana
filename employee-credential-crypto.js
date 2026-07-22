// employee-credential-crypto.js — Phase 1B browser-safe password hashing helpers
//
// New permanent credentials use PBKDF2-SHA-256 and never store plaintext.
// This is still a client-side custom-auth bridge; Firebase Auth/server-enforced
// authorization remains a later security upgrade.

export const CREDENTIAL_ALGORITHM = "PBKDF2-SHA-256";
export const CREDENTIAL_VERSION = 1;
export const DEFAULT_PBKDF2_ITERATIONS = 210_000;

function clean(value) {
  return String(value ?? "");
}

function bytesToBase64(bytes) {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  throw new Error("Base64 encoder is unavailable.");
}

function base64ToBytes(value) {
  if (typeof atob === "function") {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  throw new Error("Base64 decoder is unavailable.");
}

function cryptoApi() {
  const api = globalThis.crypto;
  if (!api?.subtle || typeof api.getRandomValues !== "function") {
    throw new Error("Web Crypto is unavailable on this device.");
  }
  return api;
}

export function validateTemporaryPassword(password) {
  const value = clean(password);
  if (value.length < 8) throw new Error("Temporary password must contain at least 8 characters.");
  if (value.length > 128) throw new Error("Password is too long.");
  return value;
}

export function createCredentialSalt(size = 16) {
  const length = Math.max(16, Math.min(32, Number(size) || 16));
  const bytes = new Uint8Array(length);
  cryptoApi().getRandomValues(bytes);
  return bytesToBase64(bytes);
}

export async function deriveCredentialHash(password, saltBase64, iterations = DEFAULT_PBKDF2_ITERATIONS) {
  const value = validateTemporaryPassword(password);
  const rounds = Math.max(100_000, Number(iterations) || DEFAULT_PBKDF2_ITERATIONS);
  const salt = base64ToBytes(String(saltBase64 || ""));
  if (salt.length < 16) throw new Error("Credential salt is invalid.");

  const api = cryptoApi();
  const key = await api.subtle.importKey(
    "raw",
    new TextEncoder().encode(value),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await api.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds },
    key,
    256
  );
  return bytesToBase64(new Uint8Array(bits));
}

export async function createPasswordCredential(password, options = {}) {
  const iterations = Math.max(100_000, Number(options.iterations) || DEFAULT_PBKDF2_ITERATIONS);
  const salt = createCredentialSalt();
  const passwordHash = await deriveCredentialHash(password, salt, iterations);
  return {
    credentialVersion: CREDENTIAL_VERSION,
    algorithm: CREDENTIAL_ALGORITHM,
    iterations,
    salt,
    passwordHash,
  };
}

function constantTimeEqualBase64(left, right) {
  const a = base64ToBytes(String(left || ""));
  const b = base64ToBytes(String(right || ""));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

export async function verifyPasswordCredential(password, credential = {}) {
  if (credential.algorithm !== CREDENTIAL_ALGORITHM || Number(credential.credentialVersion) !== CREDENTIAL_VERSION) {
    return false;
  }
  const derived = await deriveCredentialHash(password, credential.salt, credential.iterations);
  return constantTimeEqualBase64(derived, credential.passwordHash);
}
