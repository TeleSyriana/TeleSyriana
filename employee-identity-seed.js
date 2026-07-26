// employee-identity-seed.js — effective-dated identity seed for current staff
//
// No passwords are stored here. Permanent employeeUid values preserve person-level
// history when operational CCMS IDs or roles change.

import { DEFAULT_PROJECT_ID, validateEmployeeIdentity } from "./employee-model.js";

export const IPRO_ORG_CHANGE_EFFECTIVE_AT = "2026-07-27T00:00:00+03:00";
export const IPRO_ORG_CHANGE_EFFECTIVE_MS = Date.parse(IPRO_ORG_CHANGE_EFFECTIVE_AT);

const BASE_IDENTITY_SEED = [
  {
    employeeUid: "emp_legacy_0001",
    ccmsId: "0001",
    fullName: "Jack Smith",
    roleKey: "ceo",
    projectIds: ["*"],
    hourlyRate: 0,
    currency: "GBP",
    accountStatus: "active",
  },
  {
    employeeUid: "emp_legacy_1001",
    ccmsId: "1001",
    fullName: "Mohammad Safar",
    roleKey: "acm",
    projectId: DEFAULT_PROJECT_ID,
    hourlyRate: 5.8,
    currency: "GBP",
    accountStatus: "active",
  },
  {
    employeeUid: "emp_legacy_2001",
    ccmsId: "2001",
    fullName: "Dema Shabar",
    roleKey: "supervisor",
    projectId: DEFAULT_PROJECT_ID,
    hourlyRate: 5.8,
    currency: "GBP",
    accountStatus: "active",
  },
  {
    employeeUid: "emp_legacy_3001",
    ccmsId: "3001",
    fullName: "Fatima Kaka",
    roleKey: "hr",
    projectId: DEFAULT_PROJECT_ID,
    projectIds: [DEFAULT_PROJECT_ID],
    hourlyRate: 5.8,
    currency: "GBP",
    accountStatus: "active",
  },
  {
    employeeUid: "emp_legacy_9001",
    ccmsId: "9001",
    fullName: "Raghad Moussa",
    roleKey: "agent",
    projectId: DEFAULT_PROJECT_ID,
    supervisorUid: "emp_legacy_2001",
    supervisorCcmsId: "2001",
    hourlyRate: 1.15,
    currency: "USD",
    timezone: "Asia/Damascus",
    accountStatus: "active",
  },
  {
    employeeUid: "emp_legacy_9002",
    ccmsId: "9002",
    fullName: "Qamar Moussa",
    roleKey: "agent",
    projectId: DEFAULT_PROJECT_ID,
    supervisorUid: "emp_legacy_2001",
    supervisorCcmsId: "2001",
    hourlyRate: 1.15,
    currency: "USD",
    timezone: "Asia/Damascus",
    accountStatus: "active",
  },
  {
    employeeUid: "emp_legacy_9003",
    ccmsId: "9003",
    fullName: "Reema Obaid",
    roleKey: "agent",
    projectId: DEFAULT_PROJECT_ID,
    supervisorUid: "emp_legacy_2001",
    supervisorCcmsId: "2001",
    hourlyRate: 1.15,
    currency: "USD",
    timezone: "Asia/Damascus",
    accountStatus: "active",
  },
];

const MONDAY_IDENTITY_SEED = [
  BASE_IDENTITY_SEED[0],
  BASE_IDENTITY_SEED[1],
  {
    ...BASE_IDENTITY_SEED[2],
    accountStatus: "disabled",
    inactiveReason: "org_change",
    inactiveEffectiveAt: IPRO_ORG_CHANGE_EFFECTIVE_AT,
  },
  BASE_IDENTITY_SEED[3],
  {
    ...BASE_IDENTITY_SEED[4],
    supervisorUid: "emp_legacy_9003",
    supervisorCcmsId: "2002",
    employmentType: "part_time",
    shiftWindow: { start: "10:00", end: "14:00", timeZone: "Asia/Damascus" },
  },
  {
    ...BASE_IDENTITY_SEED[5],
    accountStatus: "disabled",
    inactiveReason: "resigned",
    inactiveEffectiveAt: IPRO_ORG_CHANGE_EFFECTIVE_AT,
  },
  {
    ...BASE_IDENTITY_SEED[6],
    ccmsId: "2002",
    roleKey: "supervisor",
    supervisorUid: "",
    supervisorCcmsId: "",
    previousCcmsIds: ["9003"],
    employmentType: "full_time",
    shiftWindow: { start: "10:00", end: "18:00", timeZone: "Asia/Damascus" },
    promotionEffectiveAt: IPRO_ORG_CHANGE_EFFECTIVE_AT,
  },
  {
    employeeUid: "emp_lana_safar_9004",
    ccmsId: "9004",
    fullName: "Lana Safar",
    roleKey: "agent",
    projectId: DEFAULT_PROJECT_ID,
    supervisorUid: "emp_legacy_9003",
    supervisorCcmsId: "2002",
    hourlyRate: 0,
    currency: "USD",
    timezone: "Asia/Damascus",
    accountStatus: "active",
    employmentType: "full_time",
    shiftWindow: { start: "10:00", end: "18:00", timeZone: "Asia/Damascus" },
    payrollRatePending: true,
    effectiveFrom: IPRO_ORG_CHANGE_EFFECTIVE_AT,
  },
];

function immutableMetadata(row, validated) {
  return Object.freeze({
    ...validated,
    previousCcmsIds: Object.freeze([...(row.previousCcmsIds || [])].map(String)),
    employmentType: String(row.employmentType || ""),
    shiftWindow: row.shiftWindow ? Object.freeze({ ...row.shiftWindow }) : null,
    inactiveReason: String(row.inactiveReason || ""),
    inactiveEffectiveAt: String(row.inactiveEffectiveAt || ""),
    promotionEffectiveAt: String(row.promotionEffectiveAt || ""),
    effectiveFrom: String(row.effectiveFrom || ""),
    payrollRatePending: row.payrollRatePending === true,
  });
}

function freezeSeed(rows) {
  return Object.freeze(rows.map((row) => immutableMetadata(row, validateEmployeeIdentity(row, { allowPendingSupervisor: true }))));
}

export function isIproMondayOrgChangeEffective(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(ms) && ms >= IPRO_ORG_CHANGE_EFFECTIVE_MS;
}

export function employeeIdentitySeedAt(now = Date.now()) {
  return freezeSeed(isIproMondayOrgChangeEffective(now) ? MONDAY_IDENTITY_SEED : BASE_IDENTITY_SEED);
}

export const CURRENT_EMPLOYEE_IDENTITY_SEED = employeeIdentitySeedAt(Date.now());

export function seedIdentityByCcms(ccmsId, rows = CURRENT_EMPLOYEE_IDENTITY_SEED) {
  const id = String(ccmsId || "").trim();
  return rows.find((row) => row.ccmsId === id || row.previousCcmsIds?.includes(id)) || null;
}

export function seedIdentityByUid(employeeUid, rows = CURRENT_EMPLOYEE_IDENTITY_SEED) {
  const uid = String(employeeUid || "").trim();
  return rows.find((row) => row.employeeUid === uid) || null;
}
