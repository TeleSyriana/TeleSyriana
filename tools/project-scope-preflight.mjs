import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-project-scope-'));

function copy(sourcePath, targetName, replacements = []) {
  let source = fs.readFileSync(path.join(root, sourcePath), 'utf8');
  for (const [from, to] of replacements) source = source.split(from).join(to);
  const target = path.join(tmp, targetName);
  fs.writeFileSync(target, source);
  return target;
}

copy('employee-model.js', 'employee-model.mjs');
const accessPath = copy('project-access-policy.js', 'project-access-policy.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
]);
const hierarchyPath = copy('project-hierarchy-shadow.js', 'project-hierarchy-shadow.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
  ['./project-access-policy.js', './project-access-policy.mjs'],
]);

const access = await import(pathToFileURL(accessPath).href);
const hierarchy = await import(pathToFileURL(hierarchyPath).href);

const employees = [
  { employeeUid: 'emp_ceo001', ccmsId: '0001', fullName: 'CEO', roleKey: 'ceo', projectId: '*', projectIds: ['*'], accountStatus: 'active' },
  { employeeUid: 'emp_acm001', ccmsId: '1001', fullName: 'iPro ACM', roleKey: 'acm', projectId: 'ipro', projectIds: ['ipro'], accountStatus: 'active' },
  { employeeUid: 'emp_acm002', ccmsId: '1002', fullName: 'Happy ACM', roleKey: 'acm', projectId: 'happy-tails', projectIds: ['happy-tails'], accountStatus: 'active' },
  { employeeUid: 'emp_sup001', ccmsId: '2001', fullName: 'iPro Supervisor', roleKey: 'supervisor', projectId: 'ipro', projectIds: ['ipro'], accountStatus: 'active' },
  { employeeUid: 'emp_sup002', ccmsId: '2002', fullName: 'Happy Supervisor', roleKey: 'supervisor', projectId: 'happy-tails', projectIds: ['happy-tails'], accountStatus: 'active' },
  { employeeUid: 'emp_hr0001', ccmsId: '3001', fullName: 'Shared HR', roleKey: 'hr', projectId: 'ipro', projectIds: ['ipro', 'happy-tails'], accountStatus: 'active' },
  { employeeUid: 'emp_agent01', ccmsId: '9001', fullName: 'iPro Agent', roleKey: 'agent', projectId: 'ipro', projectIds: ['ipro'], supervisorUid: 'emp_sup001', supervisorCcmsId: '2001', accountStatus: 'active' },
  { employeeUid: 'emp_agent04', ccmsId: '9004', fullName: 'Happy Agent', roleKey: 'agent', projectId: 'happy-tails', projectIds: ['happy-tails'], supervisorUid: 'emp_sup002', supervisorCcmsId: '2002', accountStatus: 'active' },
];

const CEO = employees[0];
const IPRO_ACM = employees[1];
const IPRO_SUP = employees[3];
const HR = employees[5];
const IPRO_AGENT = employees[6];

assert.equal(access.actorCanAccessProject(CEO, 'ipro'), true);
assert.equal(access.actorCanAccessProject(CEO, 'happy-tails'), true);
assert.equal(access.actorCanAccessProject(IPRO_ACM, 'ipro'), true);
assert.equal(access.actorCanAccessProject(IPRO_ACM, 'happy-tails'), false);
assert.equal(access.actorCanAccessProject(HR, 'ipro'), true);
assert.equal(access.actorCanAccessProject(HR, 'happy-tails'), true);

assert.throws(() => access.resolveActorProject(CEO), /select a specific project/);
assert.equal(access.resolveActorProject(CEO, 'happy-tails'), 'happy-tails');
assert.equal(access.resolveActorProject(IPRO_ACM), 'ipro');
assert.throws(() => access.resolveActorProject(IPRO_ACM, 'happy-tails'), /cannot switch/);
assert.equal(access.resolveActorProject(HR, 'happy-tails'), 'happy-tails');

assert.equal(access.canManageProjectLifecycle(CEO), true);
assert.equal(access.canManageProjectLifecycle(IPRO_ACM), false);
assert.equal(access.canManageProjectOperations(IPRO_ACM, 'ipro'), true);
assert.equal(access.canManageProjectOperations(IPRO_ACM, 'happy-tails'), false);
assert.equal(access.canSupervisorManageAgent(IPRO_SUP, IPRO_AGENT), true);
assert.equal(access.canSupervisorManageAgent(IPRO_SUP, employees[7]), false);
assert.equal(access.validateAgentSupervisorProject(IPRO_AGENT, IPRO_SUP), true);
assert.throws(() => access.validateAgentSupervisorProject(IPRO_AGENT, employees[4]), /same project/);

const acmVisible = access.visibleProjectEmployees(IPRO_ACM, employees);
assert.deepEqual(acmVisible.map((row) => row.ccmsId).sort(), ['1001', '2001', '3001', '9001']);

const hrHappyVisible = access.visibleProjectEmployees(HR, employees, 'happy-tails');
assert.deepEqual(hrHappyVisible.map((row) => row.ccmsId).sort(), ['1002', '2002', '3001', '9004']);

const supervisorVisible = access.visibleProjectEmployees(IPRO_SUP, employees);
assert.deepEqual(supervisorVisible.map((row) => row.ccmsId).sort(), ['2001', '9001']);

const agentVisible = access.visibleProjectEmployees(IPRO_AGENT, employees);
assert.deepEqual(agentVisible.map((row) => row.ccmsId).sort(), ['2001', '9001']);

const iproHierarchy = hierarchy.buildProjectHierarchy('ipro', employees);
assert.equal(iproHierarchy.totals.employees, 4);
assert.equal(iproHierarchy.totals.acms, 1);
assert.equal(iproHierarchy.totals.hrs, 1);
assert.equal(iproHierarchy.totals.supervisors, 1);
assert.equal(iproHierarchy.totals.agents, 1);
assert.equal(iproHierarchy.supervisors[0].agents[0].ccmsId, '9001');
assert.equal(iproHierarchy.warnings.length, 0);

const happyHierarchy = hierarchy.buildProjectHierarchy('happy-tails', employees);
assert.equal(happyHierarchy.totals.employees, 4);
assert.equal(happyHierarchy.supervisors[0].agents[0].ccmsId, '9004');
assert.equal(happyHierarchy.warnings.length, 0);

const brokenEmployees = employees.map((row) => ({ ...row, projectIds: [...(row.projectIds || [])] }));
const broken = brokenEmployees.find((row) => row.ccmsId === '9001');
broken.supervisorUid = 'emp_sup002';
broken.supervisorCcmsId = '2002';
const brokenHierarchy = hierarchy.buildProjectHierarchy('ipro', brokenEmployees);
assert(brokenHierarchy.warnings.some((row) => row.type === 'agent_missing_supervisor'));

for (const file of ['project-access-policy.js', 'project-hierarchy-shadow.js']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  assert(!/from ["']\.\/firebase\.js|setDoc\(|addDoc\(|updateDoc\(|deleteDoc\(|runTransaction\(|onSnapshot\(/.test(source), `${file} must remain storage-free.`);
}

console.log(JSON.stringify({
  result: 'PASS',
  iproVisibleToAcm: acmVisible.map((row) => row.ccmsId),
  happyVisibleToHr: hrHappyVisible.map((row) => row.ccmsId),
  supervisorTeam: supervisorVisible.map((row) => row.ccmsId),
  agentScope: agentVisible.map((row) => row.ccmsId),
  iproHierarchy: iproHierarchy.totals,
  happyHierarchy: happyHierarchy.totals,
}, null, 2));
