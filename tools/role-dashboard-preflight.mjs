import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-role-dashboard-'));

function copy(sourcePath, targetName, replacements = []) {
  let source = fs.readFileSync(path.join(root, sourcePath), 'utf8');
  for (const [from, to] of replacements) source = source.split(from).join(to);
  const target = path.join(tmp, targetName);
  fs.writeFileSync(target, source);
  return target;
}

copy('employee-model.js', 'employee-model.mjs');
copy('project-access-policy.js', 'project-access-policy.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
]);
copy('project-hierarchy-shadow.js', 'project-hierarchy-shadow.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
  ['./project-access-policy.js', './project-access-policy.mjs'],
]);
copy('ticket-access-policy.js', 'ticket-access-policy.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
  ['./project-access-policy.js', './project-access-policy.mjs'],
]);
const dashboardPath = copy('role-dashboard-shadow.js', 'role-dashboard-shadow.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
  ['./project-hierarchy-shadow.js', './project-hierarchy-shadow.mjs'],
  ['./ticket-access-policy.js', './ticket-access-policy.mjs'],
]);

const dashboard = await import(pathToFileURL(dashboardPath).href);

const ACM = { employeeUid: 'emp_acm001', ccmsId: '1001', roleKey: 'acm', projectId: 'ipro', projectIds: ['ipro'], accountStatus: 'active' };
const SUP = { employeeUid: 'emp_sup001', ccmsId: '2001', roleKey: 'supervisor', projectId: 'ipro', projectIds: ['ipro'], accountStatus: 'active' };
const HR = { employeeUid: 'emp_hr0001', ccmsId: '3001', roleKey: 'hr', projectId: 'ipro', projectIds: ['ipro'], accountStatus: 'active' };
const AGENT1 = { employeeUid: 'emp_agent01', ccmsId: '9001', roleKey: 'agent', projectId: 'ipro', projectIds: ['ipro'], supervisorUid: 'emp_sup001', supervisorCcmsId: '2001', accountStatus: 'active' };
const AGENT2 = { employeeUid: 'emp_agent02', ccmsId: '9002', roleKey: 'agent', projectId: 'ipro', projectIds: ['ipro'], supervisorUid: 'emp_sup001', supervisorCcmsId: '2001', accountStatus: 'active' };
const OTHER_AGENT = { employeeUid: 'emp_agent04', ccmsId: '9004', roleKey: 'agent', projectId: 'happy-tails', projectIds: ['happy-tails'], supervisorUid: 'emp_sup002', supervisorCcmsId: '2002', accountStatus: 'active' };
const employees = [ACM, SUP, HR, AGENT1, AGENT2, OTHER_AGENT];

const now = new Date('2026-07-26T10:00:00Z');
const tickets = [
  { id: 't1', projectId: 'ipro', assignedTo: '9001', status: 'open', priority: 'emergency', updatedAt: '2026-07-26T08:00:00Z', dueAt: '2026-07-26T09:00:00Z' },
  { id: 't2', projectId: 'ipro', assignedTo: '9002', status: 'resolved', priority: 'normal', updatedAt: '2026-07-26T09:30:00Z' },
  { id: 't3', projectId: 'happy-tails', assignedTo: '9004', status: 'open', priority: 'normal', updatedAt: '2026-07-26T07:00:00Z' },
];
const presenceRows = [
  { employeeUid: 'emp_agent01', status: 'operating' },
  { employeeUid: 'emp_agent02', status: 'unavailable' },
];
const attendanceRows = [
  { employeeUid: 'emp_agent01', attendanceStatus: 'late' },
  { employeeUid: 'emp_agent02', attendanceStatus: 'present' },
];

const supervisor = dashboard.buildSupervisorDashboard(SUP, { employees, tickets, presenceRows, attendanceRows, now });
assert.equal(supervisor.projectId, 'ipro');
assert.equal(supervisor.teamSize, 2);
assert.deepEqual(supervisor.team.map((row) => row.ccmsId).sort(), ['9001', '9002']);
assert.equal(supervisor.status.operating, 1);
assert.equal(supervisor.status.unavailable, 1);
assert.equal(supervisor.status.late, 1);
assert.equal(supervisor.tickets.totalVisible, 2);
assert.equal(supervisor.tickets.active, 1);
assert.equal(supervisor.tickets.emergency, 1);
assert.equal(supervisor.tickets.resolvedToday, 1);
assert.equal(supervisor.tickets.overdue, 1);

const acm = dashboard.buildAcmDashboard(ACM, { employees, tickets, presenceRows, attendanceRows, now });
assert.equal(acm.projectId, 'ipro');
assert.equal(acm.supervisors, 1);
assert.equal(acm.agents, 2);
assert.equal(acm.employeeCount, 5);
assert.equal(acm.status.operating, 1);
assert.equal(acm.status.unavailable, 1);
assert.equal(acm.tickets.totalVisible, 2);
assert.equal(acm.tickets.active, 1);
assert.equal(acm.tickets.emergency, 1);
assert.equal(acm.tickets.resolvedToday, 1);
assert.equal(acm.tickets.overdue, 1);

assert.throws(() => dashboard.buildSupervisorDashboard(ACM, { employees }), /Supervisor actor/);
assert.throws(() => dashboard.buildAcmDashboard(SUP, { employees }), /ACM actor/);

const source = fs.readFileSync(path.join(root, 'role-dashboard-shadow.js'), 'utf8');
assert(!/from ["']\.\/firebase\.js|setDoc\(|addDoc\(|updateDoc\(|deleteDoc\(|runTransaction\(|onSnapshot\(/.test(source), 'Role dashboard projection must remain storage-free.');

console.log(JSON.stringify({
  result: 'PASS',
  supervisor: {
    teamSize: supervisor.teamSize,
    status: supervisor.status,
    tickets: supervisor.tickets,
  },
  acm: {
    employeeCount: acm.employeeCount,
    supervisors: acm.supervisors,
    agents: acm.agents,
    status: acm.status,
    tickets: acm.tickets,
  },
}, null, 2));
