// employee-it-support-service.js — IT password support facade
//
// Not auto-mounted. When the permanent account system is enabled, a 4xxx IT
// employee can inspect only safe account/security metadata and issue a temporary
// password reset. Temporary passwords are immediately marked change-required.

import {
  getEmployeeIdentityByUid,
  listEmployeeIdentities,
} from "./employee-identity-store.js";
import {
  getEmployeeCredentialState,
  provisionTemporaryEmployeeCredential,
} from "./employee-auth-v2.js";
import { validateEmployeePassword } from "./employee-password-policy.js";
import {
  accountSupportProfile,
  assertItPasswordResetAllowed,
  canViewAccountSupportProfile,
  isItSupportActor,
} from "./employee-it-support-policy.js";
import { EMPLOYEE_ACCOUNT_PROVISIONING_READY } from "./employee-management-service.js";

function clean(value) {
  return String(value ?? "").trim();
}

function assertIt(actor) {
  if (!isItSupportActor(actor)) throw new Error("IT Support permission is required.");
}

function assertProvisioningReady() {
  if (!EMPLOYEE_ACCOUNT_PROVISIONING_READY) {
    throw new Error("Password resets are locked until permanent account provisioning is enabled.");
  }
}

export async function listItAccountSupportProfiles(actor) {
  assertIt(actor);
  const identities = await listEmployeeIdentities({
    includeDisabled: true,
    includeArchived: false,
    includeSeedFallback: true,
  });

  const visible = identities.filter((row) => canViewAccountSupportProfile(actor, row));
  const profiles = await Promise.all(visible.map(async (row) => {
    const credential = await getEmployeeCredentialState(row.employeeUid);
    return accountSupportProfile(row, credential);
  }));

  return profiles.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function getItAccountSupportProfile(actor, employeeUid) {
  assertIt(actor);
  const target = await getEmployeeIdentityByUid(clean(employeeUid), { allowSeedFallback: true });
  if (!target || !canViewAccountSupportProfile(actor, target)) throw new Error("Employee is outside IT account-support access.");
  const credential = await getEmployeeCredentialState(target.employeeUid);
  return accountSupportProfile(target, credential);
}

export async function resetEmployeePasswordAsIt(actor, employeeUid, temporaryPassword) {
  assertIt(actor);
  assertProvisioningReady();
  validateEmployeePassword(temporaryPassword);

  const target = await getEmployeeIdentityByUid(clean(employeeUid), { allowSeedFallback: false });
  assertItPasswordResetAllowed(actor, target);

  const credential = await provisionTemporaryEmployeeCredential(target, temporaryPassword, actor);
  return {
    employee: accountSupportProfile(target, credential),
    reset: true,
    mustChangePassword: true,
  };
}
