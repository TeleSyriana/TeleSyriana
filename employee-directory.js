// employee-directory.js — TeleSyriana Step 1 central employee directory
// Compatibility-first migration layer. Existing production users remain available
// as fallbacks until every module has been moved away from its local STAFF/USERS map.

import { db, fs } from "./firebase.js";

const {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  serverTimestamp,
} = fs;

export const EMPLOYEES_COL = "employees";
export const DEFAULT_PROJECT_ID = "ipro";

export const EMPLOYEE_STATUS = Object.freeze({
  ACTIVE: "active",
  DISABLED: "disabled",
  ARCHIVED: "archived",
});

export const LEGACY_EMPLOYEES = Object.freeze({
  "0001": {
    id: "0001",
    name: "Jack Smith",
    password: "Aa095142332415!",
    role: "admin",
    hourlyRate: 0,
    currency: "GBP",
  },
  "1001": {
    id: "1001",
    name: "Mohammad Safar",
    password: "0951",
    role: "manager",
    hourlyRate: 5.8,
    currency: "GBP",
  },
  "2001": {
    id: "2001",
    name: "Dema Shabar",
    password: "2411",
    role: "supervisor",
    hourlyRate: 5.8,
    currency: "GBP",
  },
  "3001": {
    id: "3001",
    name: "Fatima Kaka",
    password: "2411",
    role: "hr",
    hourlyRate: 5.8,
    currency: "GBP",
  },
  "9001": {
    id: "9001",
    name: "Raghad Moussa",
    password: "Welcome2026!",
    role: "agent",
    supervisorId: "2001",
    hourlyRate: 1.15,
    currency: "USD",
  },
  "9002": {
    id: "9002",
    name: "Qamar Moussa",
    password: "Welcome2026!",
    role: "agent",
    supervisorId: "2001",
    hourlyRate: 1.15,
    currency: "USD",
  },
  "9003": {
    id: "9003",
    name: "Reema Obaid",
    password: "Reema2026!",
    role: "agent",
    supervisorId: "2001",
    hourlyRate: 1.15,
    currency: "USD",
  },
});

function cleanId(value) {
  return String(value || "").trim();
}

function normaliseStatus(value) {
  const status = String(value || EMPLOYEE_STATUS.ACTIVE).toLowerCase();
  return Object.values(EMPLOYEE_STATUS).includes(status) ? status : EMPLOYEE_STATUS.ACTIVE;
}

function normaliseEmployee(id, raw = {}) {
  const employeeId = cleanId(raw.id || id);
  return {
    id: employeeId,
    ccmsId: cleanId(raw.ccmsId || employeeId),
    name: String(raw.name || raw.fullName || employeeId || "Employee").trim(),
    fullName: String(raw.fullName || raw.name || employeeId || "Employee").trim(),
    role: String(raw.role || "agent").toLowerCase(),
    supervisorId: cleanId(raw.supervisorId),
    accountStatus: normaliseStatus(raw.accountStatus),
    hourlyRate: Number(raw.hourlyRate) || 0,
    currency: String(raw.currency || "USD").toUpperCase(),
    defaultProjectId: String(raw.defaultProjectId || DEFAULT_PROJECT_ID),
    timezone: String(raw.timezone || "Asia/Damascus"),
    language: String(raw.language || "en").toLowerCase() === "ar" ? "ar" : "en",
    shiftTargetMinutes: Number(raw.shiftTargetMinutes) || 8 * 60,
    // Temporary compatibility field. A later authentication phase should move
    // credentials entirely behind a server/auth provider before this is removed.
    password: raw.password == null ? "" : String(raw.password),
    source: raw.source || "directory",
  };
}

export function employeeSafePayload(employee) {
  if (!employee) return null;
  const { password, ...safe } = employee;
  return safe;
}

export function legacyEmployee(id) {
  const key = cleanId(id);
  const row = LEGACY_EMPLOYEES[key];
  return row ? normaliseEmployee(key, { ...row, source: "legacy-fallback" }) : null;
}

export async function getEmployee(id, { allowLegacyFallback = true } = {}) {
  const key = cleanId(id);
  if (!key) return null;

  try {
    const snap = await getDoc(doc(collection(db, EMPLOYEES_COL), key));
    if (snap.exists()) return normaliseEmployee(key, snap.data() || {});
  } catch (err) {
    console.warn("Employee directory lookup failed; using compatibility fallback when possible.", err);
  }

  return allowLegacyFallback ? legacyEmployee(key) : null;
}

export async function listEmployees({ includeDisabled = true, includeArchived = false } = {}) {
  const merged = new Map();

  // Compatibility guarantees that existing staff still render if Firestore is
  // temporarily unavailable during Step 1 rollout.
  Object.entries(LEGACY_EMPLOYEES).forEach(([id, row]) => {
    merged.set(id, normaliseEmployee(id, { ...row, source: "legacy-fallback" }));
  });

  try {
    const snap = await getDocs(collection(db, EMPLOYEES_COL));
    snap.forEach((item) => {
      const row = normaliseEmployee(item.id, item.data() || {});
      merged.set(row.id, row);
    });
  } catch (err) {
    console.warn("Employee directory list failed; returning compatibility staff.", err);
  }

  return [...merged.values()]
    .filter((row) => includeDisabled || row.accountStatus !== EMPLOYEE_STATUS.DISABLED)
    .filter((row) => includeArchived || row.accountStatus !== EMPLOYEE_STATUS.ARCHIVED)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function authenticateEmployee(id, password) {
  const employee = await getEmployee(id, { allowLegacyFallback: true });
  if (!employee) return { ok: false, reason: "not_found", employee: null };

  if (employee.accountStatus === EMPLOYEE_STATUS.DISABLED) {
    return { ok: false, reason: "disabled", employee };
  }
  if (employee.accountStatus === EMPLOYEE_STATUS.ARCHIVED) {
    return { ok: false, reason: "archived", employee };
  }
  if (String(employee.password || "") !== String(password || "")) {
    return { ok: false, reason: "bad_password", employee };
  }

  return { ok: true, reason: "ok", employee: employeeSafePayload(employee) };
}

export async function saveEmployee(employee, actorId = "system") {
  const id = cleanId(employee?.id || employee?.ccmsId);
  if (!id) throw new Error("Employee CCMS ID is required.");

  const current = await getEmployee(id, { allowLegacyFallback: false });
  const normalised = normaliseEmployee(id, employee);
  const payload = {
    ...normalised,
    updatedAt: serverTimestamp(),
    updatedBy: cleanId(actorId) || "system",
  };
  if (!current) payload.createdAt = serverTimestamp();

  await setDoc(doc(collection(db, EMPLOYEES_COL), id), payload, { merge: true });
  return employeeSafePayload(normalised);
}

export async function setEmployeeStatus(id, accountStatus, actorId = "system") {
  const employee = await getEmployee(id, { allowLegacyFallback: true });
  if (!employee) throw new Error("Employee not found.");
  return saveEmployee({ ...employee, accountStatus: normaliseStatus(accountStatus) }, actorId);
}

export async function seedLegacyEmployees(actorId = "system") {
  const results = [];
  for (const [id, legacy] of Object.entries(LEGACY_EMPLOYEES)) {
    try {
      const existing = await getEmployee(id, { allowLegacyFallback: false });
      if (existing) {
        results.push({ id, action: "kept" });
        continue;
      }

      await saveEmployee({
        ...legacy,
        id,
        ccmsId: id,
        fullName: legacy.name,
        accountStatus: EMPLOYEE_STATUS.ACTIVE,
        defaultProjectId: DEFAULT_PROJECT_ID,
        timezone: "Asia/Damascus",
        language: "en",
        shiftTargetMinutes: 8 * 60,
        source: "legacy-seed",
      }, actorId);
      results.push({ id, action: "created" });
    } catch (err) {
      console.warn(`Could not seed employee ${id}`, err);
      results.push({ id, action: "failed", error: String(err?.message || err) });
    }
  }
  return results;
}
