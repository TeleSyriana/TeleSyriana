import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-chat-access-'));

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
const chatPath = copy('chat-access-policy.js', 'chat-access-policy.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
  ['./project-access-policy.js', './project-access-policy.mjs'],
]);

const chat = await import(pathToFileURL(chatPath).href);

const CEO = { employeeUid: 'emp_ceo001', ccmsId: '0001', roleKey: 'ceo', projectId: '*', projectIds: ['*'], accountStatus: 'active' };
const IPRO_ACM = { employeeUid: 'emp_acm001', ccmsId: '1001', roleKey: 'acm', projectId: 'ipro', projectIds: ['ipro'], accountStatus: 'active' };
const HAPPY_ACM = { employeeUid: 'emp_acm002', ccmsId: '1002', roleKey: 'acm', projectId: 'happy-tails', projectIds: ['happy-tails'], accountStatus: 'active' };
const IPRO_SUP = { employeeUid: 'emp_sup001', ccmsId: '2001', roleKey: 'supervisor', projectId: 'ipro', projectIds: ['ipro'], accountStatus: 'active' };
const HAPPY_SUP = { employeeUid: 'emp_sup002', ccmsId: '2002', roleKey: 'supervisor', projectId: 'happy-tails', projectIds: ['happy-tails'], accountStatus: 'active' };
const HR = { employeeUid: 'emp_hr0001', ccmsId: '3001', roleKey: 'hr', projectId: 'ipro', projectIds: ['ipro', 'happy-tails'], accountStatus: 'active' };
const IPRO_AGENT_1 = { employeeUid: 'emp_agent01', ccmsId: '9001', roleKey: 'agent', projectId: 'ipro', projectIds: ['ipro'], supervisorUid: 'emp_sup001', supervisorCcmsId: '2001', accountStatus: 'active' };
const IPRO_AGENT_2 = { employeeUid: 'emp_agent02', ccmsId: '9002', roleKey: 'agent', projectId: 'ipro', projectIds: ['ipro'], supervisorUid: 'emp_sup001', supervisorCcmsId: '2001', accountStatus: 'active' };
const HAPPY_AGENT = { employeeUid: 'emp_agent04', ccmsId: '9004', roleKey: 'agent', projectId: 'happy-tails', projectIds: ['happy-tails'], supervisorUid: 'emp_sup002', supervisorCcmsId: '2002', accountStatus: 'active' };

const employees = [CEO, IPRO_ACM, HAPPY_ACM, IPRO_SUP, HAPPY_SUP, HR, IPRO_AGENT_1, IPRO_AGENT_2, HAPPY_AGENT];

const agentContactsBefore = chat.visibleChatContacts(IPRO_AGENT_1, employees);
assert.deepEqual(agentContactsBefore.map((row) => row.ccmsId).sort(), ['1001', '2001', '3001', '9002']);
assert(!agentContactsBefore.some((row) => row.ccmsId === '0001'));
assert(!agentContactsBefore.some((row) => row.ccmsId === '9004'));

const hrIpro = chat.visibleChatContacts(HR, employees, 'ipro');
assert.deepEqual(hrIpro.map((row) => row.ccmsId).sort(), ['1001', '2001', '9001', '9002']);
const hrHappy = chat.visibleChatContacts(HR, employees, 'happy-tails');
assert.deepEqual(hrHappy.map((row) => row.ccmsId).sort(), ['1002', '2002', '9004']);

const ceoContacts = chat.visibleChatContacts(CEO, employees, '');
assert.deepEqual(ceoContacts.map((row) => row.ccmsId).sort(), ['1001', '1002', '2001', '2002', '3001', '9001', '9002', '9004']);

assert.equal(chat.canInitiateDirectChat(IPRO_AGENT_1, CEO), false);
assert.equal(chat.canInitiateDirectChat(IPRO_AGENT_1, IPRO_AGENT_2), true);
assert.equal(chat.canInitiateDirectChat(IPRO_AGENT_1, HAPPY_AGENT), false);
assert.equal(chat.canInitiateDirectChat(CEO, HAPPY_AGENT), true);

const normalDirect = chat.buildDirectConversationSpec(IPRO_AGENT_1, IPRO_AGENT_2);
assert.equal(normalDirect.type, 'direct');
assert.equal(normalDirect.projectId, 'ipro');
assert.deepEqual(normalDirect.members, ['emp_agent01', 'emp_agent02']);

const executive = chat.buildDirectConversationSpec(CEO, IPRO_AGENT_1, 'ipro');
assert.equal(executive.type, 'executive_direct');
assert.equal(executive.projectId, 'ipro');
assert.equal(executive.initiatedBy, 'emp_ceo001');
assert.equal(executive.ceoVisibilityScope, 'recipient_only');
assert.deepEqual(executive.members, ['emp_ceo001', 'emp_agent01']);

const conversations = [executive];
const agent1After = chat.visibleChatContacts(IPRO_AGENT_1, employees, '', conversations);
assert(agent1After.some((row) => row.ccmsId === '0001'), 'Recipient should see CEO after CEO initiates.');

const agent2After = chat.visibleChatContacts(IPRO_AGENT_2, employees, '', conversations);
assert(!agent2After.some((row) => row.ccmsId === '0001'), 'Other employees must not see CEO.');

assert.equal(chat.canInitiateDirectChat(IPRO_AGENT_1, CEO, '', conversations), true);
assert.equal(chat.canInitiateDirectChat(IPRO_AGENT_2, CEO, '', conversations), false);
const continued = chat.buildDirectConversationSpec(IPRO_AGENT_1, CEO, '', conversations);
assert.equal(continued.type, 'executive_direct');
assert.equal(continued.initiatedBy, 'emp_ceo001');

assert.equal(chat.canViewConversation(IPRO_AGENT_1, executive), true);
assert.equal(chat.canViewConversation(CEO, executive), true);
assert.equal(chat.canViewConversation(IPRO_AGENT_2, executive), false);
assert.equal(chat.canViewConversation(HR, executive), false);

assert.equal(chat.canSeeDetailedPresence(IPRO_AGENT_1, CEO), false);
assert.equal(chat.canSeeDetailedPresence(HR, CEO), false);
assert.equal(chat.canSeeDetailedPresence(CEO, IPRO_AGENT_1), true);
assert.equal(chat.canSeeDetailedPresence(IPRO_AGENT_1, IPRO_SUP), true);
assert.equal(chat.canSeeDetailedPresence(IPRO_AGENT_1, HAPPY_AGENT), false);

assert.equal(chat.canAddGroupMember(IPRO_ACM, IPRO_AGENT_1, 'ipro'), true);
assert.equal(chat.canAddGroupMember(IPRO_ACM, HAPPY_AGENT, 'ipro'), false);
assert.equal(chat.canAddGroupMember(IPRO_ACM, CEO, 'ipro'), false);
assert.equal(chat.canAddGroupMember(CEO, CEO, 'ipro'), true);

const source = fs.readFileSync(path.join(root, 'chat-access-policy.js'), 'utf8');
assert(!/from ["']\.\/firebase\.js|setDoc\(|addDoc\(|updateDoc\(|deleteDoc\(|runTransaction\(|onSnapshot\(/.test(source), 'Chat policy must remain storage-free.');

console.log(JSON.stringify({
  result: 'PASS',
  agentContactsBefore: agentContactsBefore.map((row) => row.ccmsId),
  hrIpro: hrIpro.map((row) => row.ccmsId),
  hrHappy: hrHappy.map((row) => row.ccmsId),
  ceoContactCount: ceoContacts.length,
  executiveDirect: executive,
  ceoVisibleToRecipientOnly: true,
}, null, 2));
