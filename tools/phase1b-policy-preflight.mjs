import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-phase1b-policy-'));

fs.writeFileSync(path.join(tmp, 'employee-model.mjs'), fs.readFileSync(path.join(root, 'employee-model.js'), 'utf8'));
let policySource = fs.readFileSync(path.join(root, 'employee-management-policy.js'), 'utf8');
policySource = policySource.split('./employee-model.js').join('./employee-model.mjs');
fs.writeFileSync(path.join(tmp, 'employee-management-policy.mjs'), policySource);

const policy = await import(pathToFileURL(path.join(tmp, 'employee-management-policy.mjs')).href);

const ceo = { employeeUid: 'emp_legacy_0001', ccmsId: '0001', roleKey: 'ceo', projectIds: ['*'] };
const acmIPro = { employeeUid: 'emp_legacy_1001', ccmsId: '1001', roleKey: 'acm', projectId: 'ipro', projectIds: ['ipro'] };
const hrMulti = { employeeUid: 'emp_hr', ccmsId: '3002', roleKey: 'hr', projectId: 'ipro', projectIds: ['ipro', 'happy-tails'] };
const supervisorIPro = { employeeUid: 'emp_sup', ccmsId: '2002', roleKey: 'supervisor', projectId: 'ipro', projectIds: ['ipro'] };
const agentIPro = { employeeUid: 'emp_agent', ccmsId: '9004', roleKey: 'agent', projectId: 'ipro', projectIds: ['ipro'] };

const iProSupervisor = { employeeUid: 'emp_target_sup', ccmsId: '2003', roleKey: 'supervisor', projectId: 'ipro', projectIds: ['ipro'], directorySource: 'firestore' };
const iProAgent = { employeeUid: 'emp_target_agent', ccmsId: '9005', roleKey: 'agent', projectId: 'ipro', projectIds: ['ipro'], directorySource: 'firestore' };
const happyAgent = { employeeUid: 'emp_happy_agent', ccmsId: '9006', roleKey: 'agent', projectId: 'happy-tails', projectIds: ['happy-tails'], directorySource: 'firestore' };
const iProHr = { employeeUid: 'emp_target_hr', ccmsId: '3003', roleKey: 'hr', projectId: 'ipro', projectIds: ['ipro'], directorySource: 'firestore' };
const iProAcm = { employeeUid: 'emp_target_acm', ccmsId: '1002', roleKey: 'acm', projectId: 'ipro', projectIds: ['ipro'], directorySource: 'firestore' };
const otherCeo = { employeeUid: 'emp_other_ceo', ccmsId: '0002', roleKey: 'ceo', projectIds: ['*'], directorySource: 'firestore' };

assert.equal(policy.canOpenEmployeesAccounts(ceo), true);
assert.equal(policy.canOpenEmployeesAccounts(acmIPro), true);
assert.equal(policy.canOpenEmployeesAccounts(hrMulti), true);
assert.equal(policy.canOpenEmployeesAccounts(supervisorIPro), false);
assert.equal(policy.canOpenEmployeesAccounts(agentIPro), false);

assert.deepEqual(policy.allowedRolesForCreation(ceo), ['acm', 'supervisor', 'hr', 'agent']);
assert.deepEqual(policy.allowedRolesForCreation(acmIPro), ['supervisor', 'agent']);
assert.deepEqual(policy.allowedRolesForCreation(hrMulti), ['supervisor', 'hr', 'agent']);
assert.deepEqual(policy.allowedRolesForCreation(supervisorIPro), []);

assert.equal(policy.canManageEmployeeTarget(ceo, iProAcm), true);
assert.equal(policy.canManageEmployeeTarget(ceo, otherCeo), false);
assert.equal(policy.canManageEmployeeTarget(acmIPro, iProSupervisor), true);
assert.equal(policy.canManageEmployeeTarget(acmIPro, iProAgent), true);
assert.equal(policy.canManageEmployeeTarget(acmIPro, iProHr), false);
assert.equal(policy.canManageEmployeeTarget(acmIPro, happyAgent), false);
assert.equal(policy.canManageEmployeeTarget(hrMulti, iProHr), true);
assert.equal(policy.canManageEmployeeTarget(hrMulti, iProSupervisor), true);
assert.equal(policy.canManageEmployeeTarget(hrMulti, happyAgent), true);
assert.equal(policy.canManageEmployeeTarget(hrMulti, iProAcm), false);
assert.equal(policy.canManageEmployeeTarget(hrMulti, otherCeo), false);

assert.equal(policy.canManageEmployeeTarget(acmIPro, acmIPro), false, 'ACM cannot use employee management to modify self.');
assert.equal(policy.canManageEmployeeTarget(hrMulti, hrMulti), false, 'HR cannot use employee management to modify self.');

assert.equal(policy.canAssignRoleToTarget(acmIPro, iProAgent, 'supervisor'), true);
assert.equal(policy.canAssignRoleToTarget(acmIPro, iProAgent, 'hr'), false);
assert.equal(policy.canAssignRoleToTarget(hrMulti, iProAgent, 'supervisor'), true);
assert.equal(policy.canAssignRoleToTarget(hrMulti, iProAgent, 'acm'), false);
assert.equal(policy.canAssignRoleToTarget(ceo, iProAgent, 'acm'), true);

assert.doesNotThrow(() => policy.assertProjectAssignmentAllowed(acmIPro, 'agent', ['ipro']));
assert.throws(() => policy.assertProjectAssignmentAllowed(acmIPro, 'agent', ['happy-tails']), /outside your access/i);
assert.doesNotThrow(() => policy.assertProjectAssignmentAllowed(hrMulti, 'hr', ['ipro', 'happy-tails']));
assert.doesNotThrow(() => policy.assertProjectAssignmentAllowed(hrMulti, 'agent', ['happy-tails']));
assert.throws(() => policy.assertProjectAssignmentAllowed(hrMulti, 'agent', ['ipro', 'happy-tails']), /exactly one project/i);

assert.equal(policy.canModifyDirectoryRow(acmIPro, iProAgent), true);
assert.equal(policy.canModifyDirectoryRow(acmIPro, { ...iProAgent, directorySource: 'seed' }), false);

const projects = [
  { projectId: 'ipro', accountStatus: 'active' },
  { projectId: 'happy-tails', accountStatus: 'active' },
  { projectId: 'archived-project', accountStatus: 'archived' },
];
assert.deepEqual(policy.visibleProjectsForActor(acmIPro, projects).map((row) => row.projectId), ['ipro']);
assert.deepEqual(policy.visibleProjectsForActor(hrMulti, projects).map((row) => row.projectId), ['ipro', 'happy-tails']);
assert.deepEqual(policy.visibleProjectsForActor(ceo, projects).map((row) => row.projectId), ['ipro', 'happy-tails']);

console.log('Phase 1B employee management policy preflight: PASS');
console.log('Verified CEO global, ACM project-scoped, HR assigned-project, and Supervisor/Agent no-management rules.');
console.log('Verified seed-only rows remain read-only until permanent migration.');
