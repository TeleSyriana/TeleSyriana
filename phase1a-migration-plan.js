// phase1a-migration-plan.js — pure, zero-write Phase 1A migration preview

import { CURRENT_EMPLOYEE_IDENTITY_SEED } from "./employee-identity-seed.js";
import { DEFAULT_PROJECT } from "./project-model.js";
import {
  EMPLOYEE_CCMS_INDEX_COL,
  EMPLOYEE_IDENTITIES_COL,
  PROJECTS_COL,
} from "./phase1a-collections.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function buildPhase1AMigrationPlan() {
  const identities = CURRENT_EMPLOYEE_IDENTITY_SEED.map((employee) => ({
    collection: EMPLOYEE_IDENTITIES_COL,
    documentId: employee.employeeUid,
    employeeUid: employee.employeeUid,
    ccmsId: employee.ccmsId,
    fullName: employee.fullName,
    roleKey: employee.roleKey,
    projectId: employee.projectId,
    projectIds: [...employee.projectIds],
    supervisorUid: employee.supervisorUid || "",
    supervisorCcmsId: employee.supervisorCcmsId || "",
    accountStatus: employee.accountStatus,
  }));

  const ccmsIndexes = CURRENT_EMPLOYEE_IDENTITY_SEED.map((employee) => ({
    collection: EMPLOYEE_CCMS_INDEX_COL,
    documentId: employee.ccmsId,
    employeeUid: employee.employeeUid,
    ccmsId: employee.ccmsId,
  }));

  const projects = [{
    collection: PROJECTS_COL,
    documentId: DEFAULT_PROJECT.projectId,
    projectId: DEFAULT_PROJECT.projectId,
    name: DEFAULT_PROJECT.name,
    accountStatus: DEFAULT_PROJECT.accountStatus,
    isDefault: DEFAULT_PROJECT.isDefault,
  }];

  return clone({
    mode: "preview",
    writesPerformed: false,
    employeeCount: identities.length,
    plannedDocumentCount: identities.length + ccmsIndexes.length + projects.length,
    collections: {
      identities,
      ccmsIndexes,
      projects,
    },
  });
}
