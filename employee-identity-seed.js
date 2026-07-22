// employee-identity-seed.js — Phase 1A identity-only seed for current staff
//
// No passwords are stored here. Production authentication remains untouched until
// the later controlled login migration. These permanent UIDs are the bridge that
// lets CCMS change in the future without changing the person's identity/history.

import { DEFAULT_PROJECT_ID, validateEmployeeIdentity } from "./employee-model.js";

const RAW_IDENTITY_SEED = [
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

export const CURRENT_EMPLOYEE_IDENTITY_SEED = Object.freeze(
  RAW_IDENTITY_SEED.map((row) => Object.freeze(validateEmployeeIdentity(row)))
);

export function seedIdentityByCcms(ccmsId) {
  return CURRENT_EMPLOYEE_IDENTITY_SEED.find((row) => row.ccmsId === String(ccmsId || "").trim()) || null;
}

export function seedIdentityByUid(employeeUid) {
  return CURRENT_EMPLOYEE_IDENTITY_SEED.find((row) => row.employeeUid === String(employeeUid || "").trim()) || null;
}
