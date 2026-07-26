import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-phase1c-shadow-'));

function copy(sourcePath, targetName, replacements = []) {
  let source = fs.readFileSync(path.join(root, sourcePath), 'utf8');
  for (const [from, to] of replacements) source = source.split(from).join(to);
  const target = path.join(tmp, targetName);
  fs.writeFileSync(target, source);
  return target;
}

copy('employee-model.js', 'employee-model.mjs');
copy('project-model.js', 'project-model.mjs');
copy('employee-identity-seed.js', 'employee-identity-seed.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
]);
copy('employee-management-policy.js', 'employee-management-policy.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
]);
const shadowPath = copy('employee-management-shadow.js', 'employee-management-shadow.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
  ['./employee-identity-seed.js', './employee-identity-seed.mjs'],
  ['./project-model.js', './project-model.mjs'],
  ['./employee-management-policy.js', './employee-management-policy.mjs'],
]);

const shadow = await import(pathToFileURL(shadowPath).href);

const CEO = { employeeUid: 'emp_legacy_0001', ccmsId: '0001', roleKey: 'ceo', projectIds: ['*'] };
const ACM = { employeeUid: 'emp_legacy_1001', ccmsId: '1001', roleKey: 'acm', projectId: 'ipro', projectIds: ['ipro'] };
const HR = { employeeUid: 'emp_legacy_3001', ccmsId: '3001', roleKey: 'hr', projectId: 'ipro', projectIds: ['ipro'] };
const AGENT = { employeeUid: 'emp_legacy_9001', ccmsId: '9001', roleKey: 'agent', projectId: 'ipro', projectIds: ['ipro'] };

const state = shadow.createPhase1CShadowState();
assert.equal(state.writesPerformed, false);
assert.equal(state.employees.length, 7);
assert.equal(state.projects.length, 1);

const ceoContext = shadow.getPhase1CShadowContext(CEO, state);
assert.equal(ceoContext.employees.length, 7);
assert.equal(ceoContext.directoryHealth.shadowMode, true);
assert.equal(ceoContext.directoryHealth.accountProvisioningReady, false);
assert.equal(ceoContext.directoryHealth.migrationPending, true);

const acmContext = shadow.getPhase1CShadowContext(ACM, state);
assert.equal(acmContext.employees.length, 6);
assert(!acmContext.employees.some((row) => row.roleKey === 'ceo'));
assert.deepEqual(acmContext.allowedCreationRoles, ['supervisor', 'agent']);

const hrContext = shadow.getPhase1CShadowContext(HR, state);
assert.equal(hrContext.employees.length, 6);
assert(hrContext.allowedCreationRoles.includes('hr'));

assert.throws(() => shadow.getPhase1CShadowContext(AGENT, state), /CEO, ACM or HR/);

const createAgent = shadow.previewCreateEmployee(ACM, {
  fullName: 'Preview Agent',
  roleKey: 'agent',
  projectId: 'ipro',
  supervisorUid: 'emp_legacy_2001',
  hourlyRate: 1.15,
  currency: 'USD',
  timezone: 'Asia/Damascus',
}, state);
assert.equal(createAgent.operation, 'create_employee');
assert.equal(createAgent.writesPerformed, false);
assert.equal(createAgent.after.ccmsId, '9004');
assert.equal(createAgent.after.supervisorCcmsId, '2001');
assert.equal(createAgent.detail.temporaryPasswordRequiredOnActivation, true);
assert.equal(state.employees.length, 7, 'Preview must not mutate original state.');

assert.throws(() => shadow.previewCreateEmployee(ACM, {
  fullName: 'No Supervisor Agent',
  roleKey: 'agent',
  projectId: 'ipro',
}, state), /same project/);

assert.throws(() => shadow.previewCreateEmployee(ACM, {
  fullName: 'Forbidden HR',
  roleKey: 'hr',
  projectIds: ['ipro'],
}, state), /permission/);

const promote = shadow.previewPromoteAgent(ACM, 'emp_legacy_9003', state);
assert.equal(promote.operation, 'promote_agent_to_supervisor');
assert.equal(promote.before.ccmsId, '9003');
assert.equal(promote.after.ccmsId, '2002');
assert.equal(promote.after.roleKey, 'supervisor');
assert.equal(promote.employeeUidPreserved, true);
assert.equal(promote.after.employeeUid, 'emp_legacy_9003');
assert.equal(promote.writesPerformed, false);

const afterPromotion = shadow.applyShadowPreview(state, promote);
assert.equal(afterPromotion.employees.find((row) => row.employeeUid === 'emp_legacy_9003').roleKey, 'supervisor');
assert.equal(state.employees.find((row) => row.employeeUid === 'emp_legacy_9003').roleKey, 'agent');

const demote = shadow.previewDemoteSupervisor(ACM, 'emp_legacy_9003', {
  supervisorUid: 'emp_legacy_2001',
}, afterPromotion);
assert.equal(demote.operation, 'demote_supervisor_to_agent');
assert.equal(demote.after.roleKey, 'agent');
assert.equal(demote.after.ccmsId, '9003');
assert.equal(demote.after.supervisorCcmsId, '2001');
assert.equal(demote.employeeUidPreserved, true);

assert.throws(() => shadow.previewDemoteSupervisor(ACM, 'emp_legacy_2001', {
  supervisorUid: 'emp_legacy_9003',
}, state), /Reassign 3 active Agent/);

assert.throws(() => shadow.previewEmployeeStatus(ACM, 'emp_legacy_2001', 'disabled', state), /Reassign 3 active Agent/);

const disableAgent = shadow.previewEmployeeStatus(ACM, 'emp_legacy_9001', 'disabled', state);
assert.equal(disableAgent.after.accountStatus, 'disabled');
assert.equal(disableAgent.writesPerformed, false);
assert.equal(disableAgent.employeeUidPreserved, true);

const updateAgent = shadow.previewUpdateEmployee(ACM, 'emp_legacy_9001', {
  fullName: 'Raghad Moussa Updated',
  hourlyRate: 1.25,
  projectId: 'ipro',
}, state);
assert.equal(updateAgent.after.fullName, 'Raghad Moussa Updated');
assert.equal(updateAgent.after.hourlyRate, 1.25);
assert.equal(updateAgent.after.ccmsId, '9001');
assert.equal(updateAgent.after.employeeUid, 'emp_legacy_9001');

const moduleSource = fs.readFileSync(path.join(root, 'employee-management-shadow.js'), 'utf8');
assert(!/firebase|firestore|setDoc\(|addDoc\(|updateDoc\(|deleteDoc\(|onSnapshot\(/i.test(moduleSource.replace(/Firestore/gi, '')),
  'Shadow simulator must not contain Firebase/Firestore APIs.');

console.log(JSON.stringify({
  result: 'PASS',
  employees: state.employees.length,
  ceoVisible: ceoContext.employees.length,
  acmVisible: acmContext.employees.length,
  nextAgentCcms: createAgent.after.ccmsId,
  promotedCcms: promote.after.ccmsId,
  demotedCcms: demote.after.ccmsId,
  writesPerformed: false,
}, null, 2));
