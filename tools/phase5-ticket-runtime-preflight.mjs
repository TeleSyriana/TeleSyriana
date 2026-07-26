import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-phase5-ticket-'));

function copyModule(sourceName, targetName, replacements = []) {
  let source = fs.readFileSync(path.join(root, sourceName), 'utf8');
  for (const [from, to] of replacements) source = source.split(from).join(to);
  fs.writeFileSync(path.join(tmp, targetName), source);
}

copyModule('employee-model.js', 'employee-model.mjs');
copyModule('project-access-policy.js', 'project-access-policy.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
]);
copyModule('employee-identity-seed.js', 'employee-identity-seed.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
]);
copyModule('ticket-access-policy.js', 'ticket-access-policy.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
  ['./project-access-policy.js', './project-access-policy.mjs'],
]);
copyModule('ticket-runtime-policy-adapter.js', 'ticket-runtime-policy-adapter.mjs', [
  ['./ticket-access-policy.js', './ticket-access-policy.mjs'],
  ['./employee-identity-seed.js', './employee-identity-seed.mjs'],
]);

const policy = await import(pathToFileURL(path.join(tmp, 'ticket-runtime-policy-adapter.mjs')).href);

const directory = [
  { id:'0001', name:'CEO', role:'admin', accountStatus:'active' },
  { id:'1001', name:'ACM', role:'manager', accountStatus:'active' },
  { id:'2001', name:'Supervisor', role:'supervisor', accountStatus:'active' },
  { id:'3001', name:'HR', role:'hr', accountStatus:'active' },
  { id:'9001', name:'Agent 1', role:'agent', supervisorId:'2001', accountStatus:'active' },
  { id:'9002', name:'Agent 2', role:'agent', supervisorId:'2001', accountStatus:'active' },
  { id:'9003', name:'Agent 3', role:'agent', supervisorId:'2001', accountStatus:'active' },
  { id:'2101', name:'Other Supervisor', role:'supervisor', projectId:'happy-tails', accountStatus:'active' },
  { id:'9101', name:'Other Agent', role:'agent', projectId:'happy-tails', supervisorId:'2101', accountStatus:'active' },
];

const ceo = { id:'0001', role:'admin' };
const acm = { id:'1001', role:'manager' };
const supervisor = { id:'2001', role:'supervisor' };
const hr = { id:'3001', role:'hr' };
const agent1 = { id:'9001', role:'agent' };

const legacyOwn = { id:'t-own', assignedTo:'9001', status:'open' }; // legacy => iPro
const legacyAgent2 = { id:'t-a2', assignedTo:'9002', status:'open' };
const legacySupervisor = { id:'t-sup', assignedTo:'2001', status:'open' };
const legacyAcm = { id:'t-acm', assignedTo:'1001', status:'open' };
const legacyUnassigned = { id:'t-none', assignedTo:'', status:'open' };
const otherProject = { id:'t-other', projectId:'happy-tails', assignedTo:'9101', status:'open' };
const resolvedOwn = { id:'t-resolved', assignedTo:'9001', status:'resolved' };

assert.equal(policy.runtimeTicketProjectId(agent1, directory), 'ipro');
assert.equal(policy.runtimeCanOpenTickets(hr, directory), false);
assert.equal(policy.runtimeCanOpenTickets(agent1, directory), true);

// Agent = own assigned tickets only. Historical/resolved stays visible to its owner.
assert.equal(policy.runtimeCanViewTicket(agent1, legacyOwn, directory), true);
assert.equal(policy.runtimeCanViewTicket(agent1, resolvedOwn, directory), true);
assert.equal(policy.runtimeCanViewTicket(agent1, legacyAgent2, directory), false);
assert.equal(policy.runtimeCanViewTicket(agent1, legacyUnassigned, directory), false);
assert.equal(policy.runtimeCanViewTicket(agent1, otherProject, directory), false);

// Supervisor = self + direct reports, never ACM-owned/unassigned/cross-project.
assert.equal(policy.runtimeCanViewTicket(supervisor, legacyOwn, directory), true);
assert.equal(policy.runtimeCanViewTicket(supervisor, legacyAgent2, directory), true);
assert.equal(policy.runtimeCanViewTicket(supervisor, legacySupervisor, directory), true);
assert.equal(policy.runtimeCanViewTicket(supervisor, legacyAcm, directory), false);
assert.equal(policy.runtimeCanViewTicket(supervisor, legacyUnassigned, directory), false);
assert.equal(policy.runtimeCanViewTicket(supervisor, otherProject, directory), false);

// ACM = project-wide; CEO = global; HR = no operational Ticket access.
assert.equal(policy.runtimeCanViewTicket(acm, legacyOwn, directory), true);
assert.equal(policy.runtimeCanViewTicket(acm, legacyUnassigned, directory), true);
assert.equal(policy.runtimeCanViewTicket(acm, otherProject, directory), false);
assert.equal(policy.runtimeCanViewTicket(ceo, legacyOwn, directory), true);
assert.equal(policy.runtimeCanViewTicket(ceo, otherProject, directory), true);
assert.equal(policy.runtimeCanViewTicket(hr, legacyOwn, directory), false);

assert.deepEqual(policy.runtimeTicketScope(agent1, directory), {
  mode:'assignments', projectId:'ipro', assignmentIds:['9001'],
});
assert.deepEqual(policy.runtimeTicketScope(supervisor, directory).assignmentIds.sort(), ['2001','9001','9002','9003']);
assert.equal(policy.runtimeTicketScope(acm, directory).mode, 'project');
assert.equal(policy.runtimeTicketScope(ceo, directory).mode, 'global');
assert.equal(policy.runtimeTicketScope(hr, directory).mode, 'none');

assert.deepEqual(
  policy.runtimeAssignmentCandidates(supervisor, directory, legacyOwn).map((row) => row.ccmsId).sort(),
  ['2001','9001','9002','9003']
);
assert.deepEqual(
  policy.runtimeAssignmentCandidates(agent1, directory, legacyOwn).map((row) => row.ccmsId),
  ['9001']
);
assert.equal(policy.runtimeCanSetTicketAssignment(supervisor, legacyOwn, '9002', directory), true);
assert.equal(policy.runtimeCanSetTicketAssignment(supervisor, legacyOwn, '1001', directory), false);
assert.equal(policy.runtimeCanSetTicketAssignment(supervisor, legacyOwn, '9101', directory), false);
assert.equal(policy.runtimeCanSetTicketAssignment(agent1, legacyOwn, '9001', directory), true);
assert.equal(policy.runtimeCanSetTicketAssignment(agent1, legacyOwn, '9002', directory), false);
assert.equal(policy.runtimeCanSetTicketAssignment(hr, legacyOwn, '9001', directory), false);

console.log(JSON.stringify({
  phase:'5-project-aware-ticket-engine',
  agentScope:policy.runtimeTicketScope(agent1, directory),
  supervisorScope:policy.runtimeTicketScope(supervisor, directory),
  acmScope:policy.runtimeTicketScope(acm, directory),
  hrCanOpen:policy.runtimeCanOpenTickets(hr, directory),
  legacyProjectFallback:policy.runtimeTicketProjectId(agent1, directory),
  result:'PASS',
}, null, 2));
