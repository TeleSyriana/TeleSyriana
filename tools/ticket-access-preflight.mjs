import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-ticket-access-'));

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
const ticketPath = copy('ticket-access-policy.js', 'ticket-access-policy.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
  ['./project-access-policy.js', './project-access-policy.mjs'],
]);

const ticketsPolicy = await import(pathToFileURL(ticketPath).href);

const CEO = { employeeUid: 'emp_ceo001', ccmsId: '0001', roleKey: 'ceo', projectId: '*', projectIds: ['*'] };
const ACM = { employeeUid: 'emp_acm001', ccmsId: '1001', roleKey: 'acm', projectId: 'ipro', projectIds: ['ipro'] };
const SUP = { employeeUid: 'emp_sup001', ccmsId: '2001', roleKey: 'supervisor', projectId: 'ipro', projectIds: ['ipro'] };
const HR = { employeeUid: 'emp_hr0001', ccmsId: '3001', roleKey: 'hr', projectId: 'ipro', projectIds: ['ipro', 'happy-tails'] };
const AGENT1 = { employeeUid: 'emp_agent01', ccmsId: '9001', roleKey: 'agent', projectId: 'ipro', projectIds: ['ipro'], supervisorUid: 'emp_sup001', supervisorCcmsId: '2001' };
const AGENT2 = { employeeUid: 'emp_agent02', ccmsId: '9002', roleKey: 'agent', projectId: 'ipro', projectIds: ['ipro'], supervisorUid: 'emp_sup001', supervisorCcmsId: '2001' };
const OTHER_SUP = { employeeUid: 'emp_sup002', ccmsId: '2002', roleKey: 'supervisor', projectId: 'happy-tails', projectIds: ['happy-tails'] };
const OTHER_AGENT = { employeeUid: 'emp_agent04', ccmsId: '9004', roleKey: 'agent', projectId: 'happy-tails', projectIds: ['happy-tails'], supervisorUid: 'emp_sup002', supervisorCcmsId: '2002' };
const employees = [CEO, ACM, SUP, HR, AGENT1, AGENT2, OTHER_SUP, OTHER_AGENT];

const now = new Date('2026-07-26T10:00:00Z');
const tickets = [
  { id: 't1', projectId: 'ipro', assignedTo: '9001', status: 'open', priority: 'normal', createdAt: '2026-07-25T10:00:00Z', updatedAt: '2026-07-26T08:00:00Z' },
  { id: 't2', projectId: 'ipro', assignedTo: '9002', status: 'resolved', priority: 'normal', createdAt: '2026-07-20T10:00:00Z', updatedAt: '2026-07-26T09:00:00Z' },
  { id: 't3', projectId: 'ipro', assignedTo: '2001', status: 'escalated', priority: 'emergency', createdAt: '2026-07-24T10:00:00Z', updatedAt: '2026-07-25T09:00:00Z' },
  { id: 't4', projectId: 'happy-tails', assignedTo: '9004', status: 'open', priority: 'normal', createdAt: '2026-07-26T06:00:00Z', updatedAt: '2026-07-26T07:00:00Z' },
  { id: 't5', projectId: 'ipro', assignedTo: '9999', status: 'open', priority: 'normal', createdAt: '2026-07-26T05:00:00Z', updatedAt: '2026-07-26T05:00:00Z' },
];

assert.deepEqual(ticketsPolicy.searchableTickets(CEO, tickets, employees).map((row) => row.id).sort(), ['t1', 't2', 't3', 't4', 't5']);
assert.deepEqual(ticketsPolicy.searchableTickets(ACM, tickets, employees).map((row) => row.id).sort(), ['t1', 't2', 't3', 't5']);
assert.deepEqual(ticketsPolicy.searchableTickets(SUP, tickets, employees).map((row) => row.id).sort(), ['t1', 't2', 't3']);
assert.deepEqual(ticketsPolicy.searchableTickets(AGENT1, tickets, employees).map((row) => row.id), ['t1']);
assert.deepEqual(ticketsPolicy.searchableTickets(HR, tickets, employees), []);

const supervisorQueue = ticketsPolicy.defaultTicketQueue(SUP, tickets, employees);
assert.deepEqual(supervisorQueue.map((row) => row.id).sort(), ['t1', 't3']);
assert(!supervisorQueue.some((row) => row.id === 't2'), 'Resolved ticket must disappear from default queue.');
assert(ticketsPolicy.searchableTickets(SUP, tickets, employees).some((row) => row.id === 't2'), 'Resolved ticket must remain searchable.');

assert.equal(ticketsPolicy.ticketMatchesDateFilter(tickets[0], 'today', now), true, 'Old ticket modified today must appear under Today.');
assert.equal(ticketsPolicy.ticketMatchesDateFilter(tickets[1], 'today', now), true, 'Resolved ticket modified today must match Today activity.');
assert.equal(ticketsPolicy.ticketMatchesDateFilter(tickets[2], 'yesterday', now), true);
assert.equal(ticketsPolicy.ticketMatchesDateFilter(tickets[2], 'last_week', now), true);
assert.equal(ticketsPolicy.ticketMatchesDateFilter(tickets[2], 'last_month', now), true);

assert.equal(ticketsPolicy.canAssignTicket(CEO, tickets[0], OTHER_AGENT, employees), false, 'Cannot assign an iPro ticket to another project.');
assert.equal(ticketsPolicy.canAssignTicket(ACM, tickets[0], AGENT2, employees), true);
assert.equal(ticketsPolicy.canAssignTicket(SUP, tickets[0], AGENT2, employees), true);
assert.equal(ticketsPolicy.canAssignTicket(SUP, tickets[0], OTHER_AGENT, employees), false);
assert.equal(ticketsPolicy.canAssignTicket(AGENT1, tickets[0], AGENT2, employees), false);
assert.equal(ticketsPolicy.canAssignTicket(HR, tickets[0], AGENT2, employees), false);

const source = fs.readFileSync(path.join(root, 'ticket-access-policy.js'), 'utf8');
assert(!/from ["']\.\/firebase\.js|setDoc\(|addDoc\(|updateDoc\(|deleteDoc\(|runTransaction\(|onSnapshot\(/.test(source), 'Ticket policy must remain storage-free.');

console.log(JSON.stringify({
  result: 'PASS',
  ceoSearchable: ticketsPolicy.searchableTickets(CEO, tickets, employees).length,
  acmSearchable: ticketsPolicy.searchableTickets(ACM, tickets, employees).length,
  supervisorSearchable: ticketsPolicy.searchableTickets(SUP, tickets, employees).map((row) => row.id),
  supervisorDefaultQueue: supervisorQueue.map((row) => row.id),
  agentSearchable: ticketsPolicy.searchableTickets(AGENT1, tickets, employees).map((row) => row.id),
  resolvedRemainsSearchable: true,
  oldTicketModifiedTodayMatchesToday: true,
}, null, 2));
