import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-phase1a-'));

function copyAsModule(sourcePath, targetName, replacements = []) {
  let source = fs.readFileSync(path.join(root, sourcePath), 'utf8');
  for (const [from, to] of replacements) source = source.split(from).join(to);
  const target = path.join(tmp, targetName);
  fs.writeFileSync(target, source);
  return target;
}

const modelPath = copyAsModule('employee-model.js', 'employee-model.mjs');
const projectModelPath = copyAsModule('project-model.js', 'project-model.mjs');
const collectionsPath = copyAsModule('phase1a-collections.js', 'phase1a-collections.mjs');
const seedPath = copyAsModule('employee-identity-seed.js', 'employee-identity-seed.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
]);
const guardPath = copyAsModule('phase1a-migration-guard.js', 'phase1a-migration-guard.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
]);
const migrationPlanPath = copyAsModule('phase1a-migration-plan.js', 'phase1a-migration-plan.mjs', [
  ['./employee-identity-seed.js', './employee-identity-seed.mjs'],
  ['./project-model.js', './project-model.mjs'],
  ['./phase1a-collections.js', './phase1a-collections.mjs'],
]);

const model = await import(pathToFileURL(modelPath).href);
const projectModel = await import(pathToFileURL(projectModelPath).href);
const collections = await import(pathToFileURL(collectionsPath).href);
const seed = await import(pathToFileURL(seedPath).href);
const guard = await import(pathToFileURL(guardPath).href);
const migrationPlanModule = await import(pathToFileURL(migrationPlanPath).href);

const {
  EMPLOYEE_ROLES,
  GLOBAL_PROJECT_ID,
  assertCcmsMatchesRole,
  legacyRoleForCanonical,
  nextAvailableCcmsId,
  normaliseCanonicalRole,
  reclassifyEmployeeIdentity,
  roleFromCcmsId,
  validateEmployeeIdentity,
} = model;

assert.equal(normaliseCanonicalRole('admin'), EMPLOYEE_ROLES.CEO);
assert.equal(normaliseCanonicalRole('manager'), EMPLOYEE_ROLES.ACM);
assert.equal(legacyRoleForCanonical('ceo'), 'admin');
assert.equal(legacyRoleForCanonical('acm'), 'manager');

assert.equal(roleFromCcmsId('0001'), 'ceo');
assert.equal(roleFromCcmsId('1001'), 'acm');
assert.equal(roleFromCcmsId('2001'), 'supervisor');
assert.equal(roleFromCcmsId('3001'), 'hr');
assert.equal(roleFromCcmsId('9001'), 'agent');
assert.equal(roleFromCcmsId('4001'), null);
assert.equal(roleFromCcmsId('0000'), null);

assert.equal(assertCcmsMatchesRole('0001', 'ceo'), '0001');
assert.equal(assertCcmsMatchesRole('1001', 'acm'), '1001');
assert.equal(assertCcmsMatchesRole('2001', 'supervisor'), '2001');
assert.equal(assertCcmsMatchesRole('3001', 'hr'), '3001');
assert.equal(assertCcmsMatchesRole('9001', 'agent'), '9001');
assert.throws(() => assertCcmsMatchesRole('9001', 'supervisor'));

assert.equal(nextAvailableCcmsId('ceo', ['0001']), '0002');
assert.equal(nextAvailableCcmsId('acm', ['1001']), '1002');
assert.equal(nextAvailableCcmsId('supervisor', ['2001']), '2002');
assert.equal(nextAvailableCcmsId('hr', ['3001']), '3002');
assert.equal(nextAvailableCcmsId('agent', ['9001', '9002', '9003']), '9004');

assert.equal(projectModel.DEFAULT_PROJECT_ID, 'ipro');
assert.equal(projectModel.DEFAULT_PROJECT.name, 'iPro');
assert.equal(projectModel.DEFAULT_PROJECT.accountStatus, 'active');
assert.equal(projectModel.DEFAULT_PROJECT.isDefault, true);

assert.equal(collections.EMPLOYEE_IDENTITIES_COL, 'employeeIdentities');
assert.equal(collections.EMPLOYEE_CCMS_INDEX_COL, 'employeeCcmsIndex');
assert.equal(collections.PROJECTS_COL, 'projects');

assert.equal(seed.CURRENT_EMPLOYEE_IDENTITY_SEED.length, 7);
for (const employee of seed.CURRENT_EMPLOYEE_IDENTITY_SEED) {
  assert.doesNotThrow(() => validateEmployeeIdentity(employee));
  assert.equal(Object.prototype.hasOwnProperty.call(employee, 'password'), false, 'Identity seed must never duplicate passwords.');
}

const ceo = seed.seedIdentityByCcms('0001');
assert.equal(ceo.roleKey, 'ceo');
assert.deepEqual(ceo.projectIds, [GLOBAL_PROJECT_ID]);

const acm = seed.seedIdentityByCcms('1001');
assert.equal(acm.roleKey, 'acm');
assert.equal(acm.projectId, 'ipro');
assert.deepEqual(acm.projectIds, ['ipro']);

const hrMultiProject = validateEmployeeIdentity({
  employeeUid: 'emp_test_hr_3002',
  ccmsId: '3002',
  fullName: 'Test HR',
  roleKey: 'hr',
  projectId: 'ipro',
  projectIds: ['ipro', 'happy-tails'],
  accountStatus: 'active',
});
assert.deepEqual(hrMultiProject.projectIds, ['ipro', 'happy-tails']);

assert.throws(() => validateEmployeeIdentity({
  employeeUid: 'emp_test_acm_1002',
  ccmsId: '1002',
  fullName: 'Invalid ACM',
  roleKey: 'acm',
  projectId: 'ipro',
  projectIds: ['ipro', 'happy-tails'],
  accountStatus: 'active',
}), /exactly one project/i);

assert.throws(() => validateEmployeeIdentity({
  employeeUid: 'emp_test_sup_2002',
  ccmsId: '2002',
  fullName: 'Invalid Supervisor',
  roleKey: 'supervisor',
  projectIds: ['ipro', 'happy-tails'],
  accountStatus: 'active',
}), /exactly one project/i);

assert.throws(() => validateEmployeeIdentity({
  employeeUid: 'emp_test_agent_9004',
  ccmsId: '9004',
  fullName: 'No Supervisor Agent',
  roleKey: 'agent',
  projectId: 'ipro',
  accountStatus: 'active',
}), /Supervisor/i);

assert.throws(() => validateEmployeeIdentity({
  employeeUid: 'emp_test_agent_9004',
  ccmsId: '9004',
  fullName: 'Multi Project Agent',
  roleKey: 'agent',
  projectId: 'ipro',
  projectIds: ['ipro', 'happy-tails'],
  supervisorUid: 'emp_test_sup_2002',
  supervisorCcmsId: '2002',
  accountStatus: 'active',
}), /exactly one project/i);

const reema = seed.seedIdentityByCcms('9003');
const promoted = reclassifyEmployeeIdentity(reema, {
  roleKey: 'supervisor',
  ccmsId: '2002',
  projectId: 'ipro',
  projectIds: ['ipro'],
  supervisorUid: '',
  supervisorCcmsId: '',
});
const promotedValidated = validateEmployeeIdentity(promoted);
assert.equal(promotedValidated.employeeUid, reema.employeeUid);
assert.equal(promotedValidated.ccmsId, '2002');
assert.equal(promotedValidated.roleKey, 'supervisor');
assert.equal(promotedValidated.projectId, 'ipro');
assert.equal(promotedValidated.supervisorUid, '');

const preview = migrationPlanModule.buildPhase1AMigrationPlan();
assert.equal(preview.mode, 'preview');
assert.equal(preview.writesPerformed, false);
assert.equal(preview.employeeCount, 7);
assert.equal(preview.plannedDocumentCount, 15);
assert.equal(preview.collections.identities.length, 7);
assert.equal(preview.collections.ccmsIndexes.length, 7);
assert.equal(preview.collections.projects.length, 1);
assert.equal(preview.collections.projects[0].projectId, 'ipro');
assert.equal(JSON.stringify(preview).includes('password'), false, 'Migration preview must never contain passwords.');

const migrationToken = guard.PHASE1A_MIGRATION_CONFIRMATION;
assert.equal(migrationToken, 'APPLY_PHASE_1A_IDENTITY_MIGRATION');
assert.doesNotThrow(() => guard.assertPhase1AMigrationWriteGate({
  actor: { employeeUid: ceo.employeeUid, ccmsId: '0001', roleKey: 'ceo' },
  confirmation: migrationToken,
}));
assert.throws(() => guard.assertPhase1AMigrationWriteGate({
  actor: { employeeUid: acm.employeeUid, ccmsId: '1001', roleKey: 'acm' },
  confirmation: migrationToken,
}), /CEO permission/i);
assert.throws(() => guard.assertPhase1AMigrationWriteGate({
  actor: { employeeUid: ceo.employeeUid, ccmsId: '0001', roleKey: 'ceo' },
  confirmation: 'wrong-token',
}), /confirmation token/i);
assert.throws(() => guard.assertPhase1AMigrationWriteGate({
  actor: { employeeUid: ceo.employeeUid, ccmsId: '0001', roleKey: 'ceo' },
}), /confirmation token/i);

// Firestore-facing modules are syntax checked without executing/importing Firebase.
const identityStoreSource = fs.readFileSync(path.join(root, 'employee-identity-store.js'), 'utf8');
assert.match(identityStoreSource, /from "\.\/firebase\.js"/);
assert.match(identityStoreSource, /EMPLOYEE_IDENTITIES_COL = "employeeIdentities"/);
assert.match(identityStoreSource, /EMPLOYEE_CCMS_INDEX_COL = "employeeCcmsIndex"/);
assert.match(identityStoreSource, /Agent and Supervisor must belong to the same project/);
assert.match(identityStoreSource, /Agent can only be assigned to a Supervisor account/);
assert.match(identityStoreSource, /employeeUid is permanent and cannot be changed/);
assert.match(identityStoreSource, /hasOwnProperty\.call\(options, key\)/);
assert.match(identityStoreSource, /assertPhase1AMigrationWriteGate\(\{ actor, confirmation: options\.confirmation \}\)/);

const projectDirectorySource = fs.readFileSync(path.join(root, 'project-directory.js'), 'utf8');
assert.match(projectDirectorySource, /from "\.\/firebase\.js"/);
assert.match(projectDirectorySource, /CEO permission is required to manage projects/);
assert.match(projectDirectorySource, /The default iPro project cannot be archived during Phase 1A migration/);
assert.match(projectDirectorySource, /assertPhase1AMigrationWriteGate\(\{ actor, confirmation: options\.confirmation \}\)/);

const migrationSource = fs.readFileSync(path.join(root, 'employee-identity-migration.js'), 'utf8');
assert.match(migrationSource, /maximumReads: 15/);
assert.match(migrationSource, /safeToApply: conflicts\.length === 0/);
assert.match(migrationSource, /assertPhase1AMigrationWriteGate\(\{ actor, confirmation \}\)/);

console.log('Phase 1A employee identity model preflight: PASS');
console.log(`Validated ${seed.CURRENT_EMPLOYEE_IDENTITY_SEED.length} current employee identity seed rows.`);
console.log('Verified CCMS roles: 0xxx CEO, 1xxx ACM, 2xxx Supervisor, 3xxx HR, 9xxx Agent.');
console.log('Verified migration preview: 15 planned documents, zero writes, no passwords.');
console.log('Verified migration write gate: CEO + exact confirmation token only.');
console.log('Verified HR multi-project, single-project ACM/Supervisor/Agent, Agent Supervisor requirement, same-project Supervisor guard, and permanent UID promotion behavior.');
