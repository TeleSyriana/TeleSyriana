// employee-directory.js — TeleSyriana Phase 1 synchronising facade
// The full directory implementation is preserved byte-for-byte in
// employee-directory-core.js. This facade only adds a browser event after
// successful employee writes so dependent modules refresh immediately.

export * from './employee-directory-core.js';

import {
  saveEmployee as saveEmployeeCore,
  setEmployeeRole as setEmployeeRoleCore,
  setEmployeeStatus as setEmployeeStatusCore,
} from './employee-directory-core.js';

function notifyDirectoryChanged(detail = {}) {
  try {
    window.dispatchEvent(new CustomEvent('telesyriana:employee-directory-changed', { detail }));
  } catch {}
}

export async function saveEmployee(input = {}, actor = null) {
  const result = await saveEmployeeCore(input, actor);
  notifyDirectoryChanged({ action: 'save', employeeId: result?.id || input?.id || input?.ccmsId || '' });
  return result;
}

export async function setEmployeeStatus(id, status, actor = null) {
  const result = await setEmployeeStatusCore(id, status, actor);
  notifyDirectoryChanged({ action: 'status', employeeId: String(id || ''), status: String(status || '') });
  return result;
}

export async function setEmployeeRole(id, role, actor = null) {
  const result = await setEmployeeRoleCore(id, role, actor);
  notifyDirectoryChanged({ action: 'role', employeeId: String(id || ''), role: String(role || '') });
  return result;
}
