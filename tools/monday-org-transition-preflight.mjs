import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-monday-org-'));

function copyModule(sourceName, targetName, replacements = []) {
  let source = fs.readFileSync(path.join(root, sourceName), 'utf8');
  for (const [from, to] of replacements) source = source.split(from).join(to);
  fs.writeFileSync(path.join(tmp, targetName), source);
}

copyModule('employee-model.js', 'employee-model.mjs');
copyModule('project-access-policy.js', 'project-access-policy.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
]);
copyModule('project-hierarchy-shadow.js', 'project-hierarchy-shadow.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
  ['./project-access-policy.js', './project-access-policy.mjs'],
]);
copyModule('ticket-access-policy.js', 'ticket-access-policy.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
  ['./project-access-policy.js', './project-access-policy.mjs'],
]);
copyModule('employee-identity-seed.js', 'employee-identity-seed.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
]);
copyModule('ticket-runtime-policy-adapter.js', 'ticket-runtime-policy-adapter.mjs', [
  ['./ticket-access-policy.js', './ticket-access-policy.mjs'],
  ['./employee-identity-seed.js', './employee-identity-seed.mjs'],
]);
copyModule('functions-phase4b/watchdog-policy.js', 'watchdog-policy.cjs');

const BEFORE = Date.parse('2026-07-26T20:59:59Z');
const MONDAY = Date.parse('2026-07-26T21:00:01Z'); // 00:00:01 Monday in Damascus
const originalDateNow = Date.now;
Date.now = () => MONDAY;

const seedModule = await import(pathToFileURL(path.join(tmp, 'employee-identity-seed.mjs')).href);
const hierarchyModule = await import(pathToFileURL(path.join(tmp, 'project-hierarchy-shadow.mjs')).href);
const runtime = await import(pathToFileURL(path.join(tmp, 'ticket-runtime-policy-adapter.mjs')).href);
const require = createRequire(import.meta.url);
const watchdog = require(path.join(tmp, 'watchdog-policy.cjs'));

const beforeRows = seedModule.employeeIdentitySeedAt(BEFORE);
assert.equal(beforeRows.length, 7);
assert.equal(seedModule.seedIdentityByCcms('9003', beforeRows)?.roleKey, 'agent');
assert.equal(seedModule.seedIdentityByCcms('2001', beforeRows)?.accountStatus, 'active');
assert.equal(seedModule.seedIdentityByCcms('9002', beforeRows)?.accountStatus, 'active');
assert.equal(seedModule.seedIdentityByCcms('9004', beforeRows), null);

const mondayRows = seedModule.employeeIdentitySeedAt(MONDAY);
assert.equal(mondayRows.length, 8);
const reema = seedModule.seedIdentityByCcms('2002', mondayRows);
const reemaViaOldCcms = seedModule.seedIdentityByCcms('9003', mondayRows);
const dema = seedModule.seedIdentityByCcms('2001', mondayRows);
const qamar = seedModule.seedIdentityByCcms('9002', mondayRows);
const raghad = seedModule.seedIdentityByCcms('9001', mondayRows);
const lana = seedModule.seedIdentityByCcms('9004', mondayRows);

assert.equal(reema.employeeUid, 'emp_legacy_9003');
assert.equal(reemaViaOldCcms.employeeUid, reema.employeeUid);
assert.equal(reemaViaOldCcms.ccmsId, '2002');
assert.equal(reema.roleKey, 'supervisor');
assert.deepEqual(reema.previousCcmsIds, ['9003']);
assert.equal(reema.accountStatus, 'active');
assert.equal(reema.employmentType, 'full_time');
assert.deepEqual(reema.shiftWindow, { start:'10:00', end:'18:00', timeZone:'Asia/Damascus' });
assert.equal(reema.payrollRatePending, true);
assert.equal(reema.hourlyRate, 0);

assert.equal(dema.accountStatus, 'disabled');
assert.equal(qamar.accountStatus, 'disabled');
assert.equal(qamar.inactiveReason, 'resigned');
assert.equal(raghad.supervisorUid, reema.employeeUid);
assert.equal(raghad.supervisorCcmsId, '2002');
assert.equal(raghad.employmentType, 'part_time');
assert.deepEqual(raghad.shiftWindow, { start:'10:00', end:'14:00', timeZone:'Asia/Damascus' });
assert.equal(lana.supervisorUid, reema.employeeUid);
assert.equal(lana.supervisorCcmsId, '2002');
assert.equal(lana.employmentType, 'full_time');
assert.deepEqual(lana.shiftWindow, { start:'10:00', end:'18:00', timeZone:'Asia/Damascus' });
assert.equal(lana.payrollRatePending, true);

const hierarchy = hierarchyModule.buildProjectHierarchy('ipro', mondayRows);
assert.equal(hierarchy.totals.supervisors, 1);
assert.equal(hierarchy.totals.agents, 2);
assert.equal(hierarchy.totals.inactiveEmployees, 2);
assert.equal(hierarchy.warnings.length, 0);
assert.deepEqual(
  hierarchy.supervisors[0].agents.map((row) => row.ccmsId).sort(),
  ['9001', '9004']
);
assert.equal(hierarchy.supervisors[0].supervisor.ccmsId, '2002');
assert.deepEqual(hierarchy.inactiveEmployees.map((row) => row.ccmsId).sort(), ['2001','9002']);

const legacyDirectory = [
  { id:'1001', role:'manager', name:'Mohammad Safar', accountStatus:'active' },
  { id:'2001', role:'supervisor', name:'Dema Shabar', accountStatus:'active' },
  { id:'9001', role:'agent', name:'Raghad Moussa', supervisorId:'2001', accountStatus:'active' },
  { id:'9002', role:'agent', name:'Qamar Moussa', supervisorId:'2001', accountStatus:'active' },
  { id:'9003', role:'agent', name:'Reema Obaid', supervisorId:'2001', accountStatus:'active' },
];

const reemaActor = runtime.runtimeTicketActor({ id:'9003', role:'agent' }, legacyDirectory);
assert.equal(reemaActor.employeeUid, 'emp_legacy_9003');
assert.equal(reemaActor.ccmsId, '2002');
assert.equal(reemaActor.roleKey, 'supervisor');
assert.equal(reemaActor.accountStatus, 'active');

const reemaScope = runtime.runtimeTicketScope({ id:'9003', role:'agent' }, legacyDirectory);
assert.equal(reemaScope.mode, 'assignments');
assert.deepEqual([...reemaScope.assignmentIds].sort(), ['2002','9001','9003','9004']);
assert.equal(runtime.runtimeCanViewTicket({ id:'9003', role:'agent' }, { assignedTo:'9001', projectId:'ipro' }, legacyDirectory), true);
assert.equal(runtime.runtimeCanViewTicket({ id:'9003', role:'agent' }, { assignedTo:'9004', projectId:'ipro' }, legacyDirectory), true);
assert.equal(runtime.runtimeCanViewTicket({ id:'9003', role:'agent' }, { assignedTo:'9003', projectId:'ipro' }, legacyDirectory), true);
assert.equal(runtime.runtimeCanViewTicket({ id:'9003', role:'agent' }, { assignedTo:'9002', projectId:'ipro' }, legacyDirectory), false);

assert.equal(runtime.runtimeCanOpenTickets({ id:'2001', role:'supervisor' }, legacyDirectory), false);
assert.equal(runtime.runtimeCanOpenTickets({ id:'9002', role:'agent' }, legacyDirectory), false);

const raghadTarget = runtime.runtimeEscalationTarget({ id:'9001', role:'agent' }, legacyDirectory);
const lanaTarget = runtime.runtimeEscalationTarget({ id:'9004', role:'agent' }, legacyDirectory);
assert.equal(raghadTarget?.ccmsId, '2002');
assert.equal(raghadTarget?.employeeUid, 'emp_legacy_9003');
assert.equal(lanaTarget?.ccmsId, '2002');
const supervisorTarget = runtime.runtimeEscalationTarget({ id:'9003', role:'agent' }, legacyDirectory);
assert.equal(supervisorTarget?.ccmsId, '1001');

const staleReemaActivity = {
  userId:'9003',
  role:'agent',
  lastActivityMs:MONDAY - 20 * 60 * 1000,
  watchdogDueMs:MONDAY - 5 * 60 * 1000,
};
const reemaWatchdog = watchdog.evaluateWatchdog({ activity:staleReemaActivity, dayRow:{ status:'in_operation' }, nowMs:MONDAY });
assert.equal(reemaWatchdog.shouldUnavailable, false);
assert.equal(reemaWatchdog.reason, 'not_agent');

const staleQamarActivity = {
  userId:'9002',
  role:'agent',
  lastActivityMs:MONDAY - 20 * 60 * 1000,
  watchdogDueMs:MONDAY - 5 * 60 * 1000,
};
const qamarWatchdog = watchdog.evaluateWatchdog({ activity:staleQamarActivity, dayRow:{ status:'in_operation' }, nowMs:MONDAY });
assert.equal(qamarWatchdog.shouldUnavailable, false);
assert.equal(qamarWatchdog.reason, 'inactive_employee');

Date.now = originalDateNow;

console.log(JSON.stringify({
  effectiveAt:seedModule.IPRO_ORG_CHANGE_EFFECTIVE_AT,
  activeSupervisor:{ ccmsId:reema.ccmsId, employeeUid:reema.employeeUid },
  activeAgents:hierarchy.supervisors[0].agents.map((row) => row.ccmsId),
  inactive:hierarchy.inactiveEmployees.map((row) => row.ccmsId),
  reemaTicketScope:reemaScope.assignmentIds,
  escalationTargetForRaghad:raghadTarget?.ccmsId,
  escalationTargetForLana:lanaTarget?.ccmsId,
  result:'PASS',
}, null, 2));
