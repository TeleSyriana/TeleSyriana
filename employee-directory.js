// employee-directory.js — TeleSyriana Phase 1 central employee directory
//
// This module is the single compatibility layer for staff identity while the
// application migrates away from duplicated STAFF/USERS objects.
//
// Source priority:
//   1. Firestore employees/{ccmsId}
//   2. Legacy seed below (keeps current production accounts working)
//
// Password verification is intentionally kept compatible with the current
// client-side login during Phase 1. Moving authentication/server-side password
// handling is a separate migration and must not be mixed into this live-data
// change.

import { db, fs } from "./firebase.js";

const { doc, getDoc, collection, getDocs } = fs;

export const EMPLOYEES_COL = "employees";

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
  "9001": { password: "Welcome2026!", role: "agent", name: "Raghad Moussa", supervisorId: "2001", hourlyRate: 1.15, currency: "USD", accountStatus: "active" },
  "9002": { password: "Welcome2026!", role: "agent", name: "Qamar Moussa", supervisorId: "2001", hourlyRate: 1.15, currency: "USD", accountStatus: "active" },
  "9003": { password: "Reema2026!", role: "agent", name: "Reema Obaid", supervisorId: "2001", hourlyRate: 1.15, currency: "USD", accountStatus: "active" },
});

function cleanId(value) {
  return String(value || "").trim();
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
    currency: String(data.currency || "USD").trim().toUpperCase(),
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

export async function getEmployee(id, options = {}) {
  const employeeId = cleanId(id);
  if (!employeeId) return null;

  const allowLegacyFallback = options.allowLegacyFallback !== false;

  try {
    const snap = await getDoc(doc(db, EMPLOYEES_COL, employeeId));
    if (snap.exists()) return normaliseEmployee(employeeId, { ...snap.data(), source: "firestore" });
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
      const row = normaliseEmployee(item.id, { ...item.data(), source: "firestore" });
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
