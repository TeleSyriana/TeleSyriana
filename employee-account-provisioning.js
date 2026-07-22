// employee-account-provisioning.js — Phase 1B identity + credential coordinator
//
// This module is not wired into production. It prepares the safe write path that
// must exist before EMPLOYEE_ACCOUNT_PROVISIONING_READY can be enabled.

import { EMPLOYEE_ROLES } from "./employee-model.js";
import { reclassifyEmployee, updateEmployeeIdentity } from "./employee-identity-store.js";
import {
  createManagedEmployee,
  demoteSupervisorToAgent,
  getEmployeesAccountsContext,
  promoteAgentToSupervisor,
} from "./employee-management-service.js";
import { canManageEmployeeTarget, canModifyDirectoryRow } from "./employee-management-policy.js";
import {
  provisionTemporaryEmployeeCredential,
} from "./employee-auth-v2.js";
import { validateTemporaryPassword } from "./employee-credential-crypto.js";

function clean(value) {
  return String(value ?? "").trim();
}

function provisioningError(message, code, cause = null, detail = {}) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  Object.assign(error, detail);
  return error;
}

async function targetForActor(actor, employeeUid) {
  const context = await getEmployeesAccountsContext(actor);
  const target = context.employees.find((row) => clean(row.employeeUid) === clean(employeeUid));
  if (!target) throw new Error("Employee not found in your project scope.");
  if (!canManageEmployeeTarget(actor, target)) throw new Error("You do not have permission to manage this employee.");
  if (!canModifyDirectoryRow(actor, target)) {
    throw new Error("This employee is still using a compatibility identity and cannot be provisioned yet.");
  }
  return target;
}

export async function createManagedEmployeeAccount(actor, input = {}, { temporaryPassword } = {}) {
  validateTemporaryPassword(temporaryPassword);
  const identity = await createManagedEmployee(actor, input);

  try {
    const credential = await provisionTemporaryEmployeeCredential(identity, temporaryPassword, actor);
    return { identity, credential, provisioningState: "ready" };
  } catch (cause) {
    // The identity may already exist if the credential write fails after identity
    // creation. Disable it so no incomplete account can be treated as operational.
    try { await updateEmployeeIdentity(identity.employeeUid, { accountStatus: "disabled" }, actor); } catch {}
    throw provisioningError(
      "Employee identity was created but login credential provisioning failed. The identity was marked disabled and needs a password retry.",
      "credential_provisioning_failed_after_identity_create",
      cause,
      { employeeUid: identity.employeeUid, ccmsId: identity.ccmsId }
    );
  }
}

export async function resetManagedEmployeeTemporaryPassword(actor, employeeUid, temporaryPassword) {
  validateTemporaryPassword(temporaryPassword);
  const target = await targetForActor(actor, employeeUid);
  const credential = await provisionTemporaryEmployeeCredential(target, temporaryPassword, actor);
  return { identity: target, credential, provisioningState: "ready" };
}

export async function promoteManagedEmployeeAccount(actor, employeeUid, { temporaryPassword } = {}) {
  validateTemporaryPassword(temporaryPassword);
  const before = await targetForActor(actor, employeeUid);
  if (before.roleKey !== EMPLOYEE_ROLES.AGENT) throw new Error("Only an Agent can be promoted to Supervisor.");

  const promoted = await promoteAgentToSupervisor(actor, employeeUid);
  try {
    const credential = await provisionTemporaryEmployeeCredential(promoted, temporaryPassword, actor);
    return { before, identity: promoted, credential, provisioningState: "ready" };
  } catch (cause) {
    let rolledBack = false;
    try {
      await reclassifyEmployee(promoted.employeeUid, {
        roleKey: before.roleKey,
        ccmsId: before.ccmsId,
        projectId: before.projectId,
        projectIds: before.projectIds,
        supervisorUid: before.supervisorUid,
        supervisorCcmsId: before.supervisorCcmsId,
      }, actor);
      rolledBack = true;
    } catch {}

    throw provisioningError(
      rolledBack
        ? "Promotion was rolled back because the new login credential could not be provisioned."
        : "Promotion changed CCMS but credential provisioning failed and automatic rollback also failed. Manual recovery is required before this employee can work.",
      rolledBack ? "promotion_credential_failed_rolled_back" : "promotion_credential_failed_manual_recovery",
      cause,
      { employeeUid: promoted.employeeUid, oldCcmsId: before.ccmsId, attemptedCcmsId: promoted.ccmsId, rolledBack }
    );
  }
}

export async function demoteManagedEmployeeAccount(actor, employeeUid, { supervisorUid = "", supervisorCcmsId = "", temporaryPassword } = {}) {
  validateTemporaryPassword(temporaryPassword);
  const before = await targetForActor(actor, employeeUid);
  if (before.roleKey !== EMPLOYEE_ROLES.SUPERVISOR) throw new Error("Only a Supervisor can be demoted to Agent.");

  const demoted = await demoteSupervisorToAgent(actor, employeeUid, { supervisorUid, supervisorCcmsId });
  try {
    const credential = await provisionTemporaryEmployeeCredential(demoted, temporaryPassword, actor);
    return { before, identity: demoted, credential, provisioningState: "ready" };
  } catch (cause) {
    let rolledBack = false;
    try {
      await reclassifyEmployee(demoted.employeeUid, {
        roleKey: before.roleKey,
        ccmsId: before.ccmsId,
        projectId: before.projectId,
        projectIds: before.projectIds,
        supervisorUid: before.supervisorUid,
        supervisorCcmsId: before.supervisorCcmsId,
      }, actor);
      rolledBack = true;
    } catch {}

    throw provisioningError(
      rolledBack
        ? "Demotion was rolled back because the new login credential could not be provisioned."
        : "Demotion changed CCMS but credential provisioning failed and automatic rollback also failed. Manual recovery is required.",
      rolledBack ? "demotion_credential_failed_rolled_back" : "demotion_credential_failed_manual_recovery",
      cause,
      { employeeUid: demoted.employeeUid, oldCcmsId: before.ccmsId, attemptedCcmsId: demoted.ccmsId, rolledBack }
    );
  }
}
