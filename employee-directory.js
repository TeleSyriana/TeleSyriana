// employee-directory.js — TeleSyriana Phase 1 central employee directory
//
// Single compatibility layer for staff identity while TeleSyriana migrates
// away from duplicated STAFF/USERS objects.
//
// Source priority:
//   1. Firestore employees/{ccmsId}
//   2. Legacy seed below (keeps current production accounts working)
//
// Phase 1 intentionally keeps the current password model compatible so this
// live migration does not break tomorrow's users. Authentication hardening is
// separate from the operational employee-directory migration.

import { db, fs } from "./firebase.js";

const { doc, getDoc, collection, getDocs, setDoc, addDoc, serverTimestamp } = fs;

export const EMPLOYEES_COL = "employees";
export const EMPLOYEE_AUDIT_COL = "employeeAudit";

export const ROLE_LEVELS = Object.freeze({
  agent: 1,
  supervisor: 2,
  hr: 3,
  manager: 3,
  admin: 4,
});

export const LEGACY_EMPLOYEE_SEED = Object.freeze({
  "0001": { password: "Aa095142332415!", role: "admin", name: "Jack Smith", hourlyRate: 0, currency: "GBP", accountStatus: "active" },
  "1001": { password: "0951", role: "manager", name: "Mohammad Safar", hourlyRate: 5.8, currency: "GBP", accountStatus: "active" },
  "2001": { password: "2411", role: "supervisor", name: "Dema Shabar", hourlyRate: 5.8, currency: "GBP", accountStatus: "active" },
  "3001": { password: "2411", role: "hr", name: "Fatima Kaka", hourlyRate: 5.8, currency: "GBP", accountStatus: "active" },
  "9001": { password: "Welcome2026!", role: "agent", name: "Raghad Moussa", supervisorId: "2001", hourlyRate: 1.15, currency: "USD", accountStatus: "active", timezone: "Asia/Damascus" },
  "9002": { password: "Welcome2026!", role: "agent", name: "Qamar Moussa", supervisorId: "2001", hourlyRate: 1.15, currency: "USD", accountStatus: "active", timezone: "Asia/Damascus" },
  "9003": { password: "Reema2026!", role: "agent", name: "Reema Obaid", supervisorId: "2001", hourlyRate: 1.15, currency: "USD", accountStatus: "active", timezone: "Asia/Damascus" },
});

function cleanId(value) {
  return String(value || "").trim();
}

function cleanCurrency(value) {
  const code = String(value || "USD").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "USD";
}

function auditActor(actor = null) {
  return {
    actorId: cleanId(actor?.id),
    actorName: String(actor?.name || "").trim(),
    actorRole: normaliseRole(actor?.role),
  };
}

async function writeEmployeeAudit(action, target, actor = null, changes = {}) {
  try {
    await addDoc(collection(db, EMPLOYEE_AUDIT_COL), {
      action: String(action || "employee_update"),
      targetId: cleanId(target?.id || target?.employeeId || target?.ccmsId),
      targetName: String(target?.name || target?.fullName || "").trim(),
      ...auditActor(actor),
      changes,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    // The employee operation itself remains authoritative. Audit logging should
    // never make HR repeat a successful staff action because of a separate log
    // permission/network issue.
    console.warn("Employee audit log write failed.", err);
  }
}

export function normaliseRole(role) {
  const value = String(role || "agent").trim().toLowerCase();
  return ROLE_LEVELS[value] ? value : "agent";
}

export function normaliseAccountStatus(status) {
  const value = String(status || "active").trim().toLowerCase();
  return ["active", "disabled", "archived"].includes(value) ? value : "active";
}

export function roleLevel(userOrRole) {
  const role = typeof userOrRole === "string" ? userOrRole : userOrRole?.role;
  return ROLE_LEVELS[normaliseRole(role)] || 0;
}

export function employeeIsActive(employee) {
  return normaliseAccountStatus(employee?.accountStatus) === "active";
}

export function normaliseEmployee(id, data = {}) {
  const employeeId = cleanId(data.id || data.employeeId || data.ccmsId || id);
  if (!employeeId) return null;

  return {
    id: employeeId,
    employeeId,
    ccmsId: employeeId,
    name: String(data.name || data.fullName || employeeId).trim(),
    role: normaliseRole(data.role),
    supervisorId: cleanId(data.supervisorId),
    hourlyRate: Math.max(0, Number(data.hourlyRate) || 0),
    currency: cleanCurrency(data.currency),
    accountStatus: normaliseAccountStatus(data.accountStatus),
    timezone: String(data.timezone || data.defaultTimezone || "").trim(),
    language: String(data.language || "").trim(),
    password: typeof data.password === "string" ? data.password : undefined,
    source: data.source || "directory",
  };
}

export function safeEmployeePayload(employee) {
  if (!employee) return null;
  const { password, source, ...safe } = employee;
  return safe;
}

export function getLegacyEmployee(id) {
  const employeeId = cleanId(id);
  const row = LEGACY_EMPLOYEE_SEED[employeeId];
  return row ? normaliseEmployee(employeeId, { ...row, source: "legacy" }) : null;
}

function mergeWithLegacy(employeeId, firestoreData = {}) {
  const legacy = LEGACY_EMPLOYEE_SEED[employeeId] || {};
  return { ...legacy, ...firestoreData };
}

export async function getEmployee(id, options = {}) {
  const employeeId = cleanId(id);
  if (!employeeId) return null;

  const allowLegacyFallback = options.allowLegacyFallback !== false;

  try {
    const snap = await getDoc(doc(db, EMPLOYEES_COL, employeeId));
    if (snap.exists()) {
      return normaliseEmployee(employeeId, {
        ...mergeWithLegacy(employeeId, snap.data()),
        source: "firestore",
      });
    }
  } catch (err) {
    console.warn("Employee directory lookup failed; using compatibility fallback.", err);
  }

  return allowLegacyFallback ? getLegacyEmployee(employeeId) : null;
}

export async function authenticateEmployee(id, password) {
  const employee = await getEmployee(id, { allowLegacyFallback: true });
  if (!employee) return { ok: false, reason: "not_found", employee: null };
  if (!employeeIsActive(employee)) return { ok: false, reason: employee.accountStatus, employee: null };
  if (employee.password !== String(password || "")) return { ok: false, reason: "incorrect_password", employee: null };
  return { ok: true, reason: "ok", employee: safeEmployeePayload(employee) };
}

export async function listEmployees(options = {}) {
  const includeDisabled = options.includeDisabled === true;
  const includeArchived = options.includeArchived === true;
  const merged = new Map();

  Object.keys(LEGACY_EMPLOYEE_SEED).forEach((id) => {
    const row = getLegacyEmployee(id);
    if (row) merged.set(id, row);
  });

  try {
    const snap = await getDocs(collection(db, EMPLOYEES_COL));
    snap.forEach((item) => {
      const row = normaliseEmployee(item.id, {
        ...mergeWithLegacy(item.id, item.data()),
        source: "firestore",
      });
      if (row) merged.set(row.id, row);
    });
  } catch (err) {
    console.warn("Employee directory list failed; using compatibility seed.", err);
  }

  return Array.from(merged.values())
    .filter((row) => includeDisabled || row.accountStatus !== "disabled")
    .filter((row) => includeArchived || row.accountStatus !== "archived")
    .map(safeEmployeePayload)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export async function saveEmployee(input = {}, actor = null) {
  const employeeId = cleanId(input.id || input.employeeId || input.ccmsId);
  if (!employeeId) throw new Error("CCMS ID is required.");
  if (!/^\d{4,10}$/.test(employeeId)) throw new Error("CCMS ID must contain 4–10 digits.");

  const name = String(input.name || input.fullName || "").trim();
  if (!name) throw new Error("Employee name is required.");

  const existing = await getEmployee(employeeId, { allowLegacyFallback: true });
  const password = typeof input.password === "string" ? input.password.trim() : "";
  if (!existing && !password) throw new Error("A temporary password is required for a new employee.");

  const payload = {
    employeeId,
    ccmsId: employeeId,
    name,
    fullName: name,
    role: normaliseRole(input.role),
    supervisorId: cleanId(input.supervisorId),
    hourlyRate: Math.max(0, Number(input.hourlyRate) || 0),
    currency: cleanCurrency(input.currency),
    accountStatus: normaliseAccountStatus(input.accountStatus),
    timezone: String(input.timezone || "").trim(),
    language: String(input.language || "").trim(),
    updatedAt: serverTimestamp(),
    updatedBy: cleanId(actor?.id),
    updatedByName: String(actor?.name || "").trim(),
  };

  if (!existing) {
    payload.createdAt = serverTimestamp();
    payload.createdBy = cleanId(actor?.id);
    payload.createdByName = String(actor?.name || "").trim();
  }
  if (password) payload.password = password;

  await setDoc(doc(db, EMPLOYEES_COL, employeeId), payload, { merge: true });

  const result = safeEmployeePayload(normaliseEmployee(employeeId, {
    ...mergeWithLegacy(employeeId, payload),
    source: "firestore",
  }));

  const changes = {
    name: { from: existing?.name || null, to: result?.name || name },
    role: { from: existing?.role || null, to: result?.role || payload.role },
    supervisorId: { from: existing?.supervisorId || "", to: result?.supervisorId || "" },
    hourlyRate: { from: existing?.hourlyRate ?? null, to: result?.hourlyRate ?? payload.hourlyRate },
    currency: { from: existing?.currency || null, to: result?.currency || payload.currency },
    accountStatus: { from: existing?.accountStatus || null, to: result?.accountStatus || payload.accountStatus },
    timezone: { from: existing?.timezone || "", to: result?.timezone || "" },
    passwordChanged: Boolean(password),
  };

  await writeEmployeeAudit(existing ? "employee_updated" : "employee_created", result || { id: employeeId, name }, actor, changes);
  return result;
}

export async function setEmployeeStatus(id, accountStatus, actor = null) {
  const employee = await getEmployee(id, { allowLegacyFallback: true });
  if (!employee) throw new Error("Employee not found.");
  const nextStatus = normaliseAccountStatus(accountStatus);
  await setDoc(doc(db, EMPLOYEES_COL, employee.id), {
    accountStatus: nextStatus,
    updatedAt: serverTimestamp(),
    updatedBy: cleanId(actor?.id),
    updatedByName: String(actor?.name || "").trim(),
  }, { merge: true });
  await writeEmployeeAudit("employee_status_changed", employee, actor, {
    accountStatus: { from: employee.accountStatus, to: nextStatus },
  });
}

export async function setEmployeeRole(id, role, actor = null) {
  const employee = await getEmployee(id, { allowLegacyFallback: true });
  if (!employee) throw new Error("Employee not found.");
  const nextRole = normaliseRole(role);
  await setDoc(doc(db, EMPLOYEES_COL, employee.id), {
    role: nextRole,
    updatedAt: serverTimestamp(),
    updatedBy: cleanId(actor?.id),
    updatedByName: String(actor?.name || "").trim(),
  }, { merge: true });
  await writeEmployeeAudit("employee_role_changed", employee, actor, {
    role: { from: employee.role, to: nextRole },
  });
}
