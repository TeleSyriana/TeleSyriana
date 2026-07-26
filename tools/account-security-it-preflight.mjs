import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-account-security-'));

function copyModule(sourceName, targetName, replacements = []) {
  let source = fs.readFileSync(path.join(root, sourceName), 'utf8');
  for (const [from, to] of replacements) source = source.split(from).join(to);
  fs.writeFileSync(path.join(tmp, targetName), source);
}

copyModule('employee-model.js', 'employee-model.mjs');
copyModule('employee-password-policy.js', 'employee-password-policy.mjs');
copyModule('employee-credential-crypto.js', 'employee-credential-crypto.mjs', [
  ['./employee-password-policy.js', './employee-password-policy.mjs'],
]);
copyModule('employee-it-support-policy.js', 'employee-it-support-policy.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
]);
copyModule('project-access-policy.js', 'project-access-policy.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
]);
copyModule('ticket-access-policy.js', 'ticket-access-policy.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
  ['./project-access-policy.js', './project-access-policy.mjs'],
]);
copyModule('chat-access-policy.js', 'chat-access-policy.mjs', [
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

const model = await import(pathToFileURL(path.join(tmp, 'employee-model.mjs')).href);
const passwordPolicy = await import(pathToFileURL(path.join(tmp, 'employee-password-policy.mjs')).href);
const crypto = await import(pathToFileURL(path.join(tmp, 'employee-credential-crypto.mjs')).href);
const itPolicy = await import(pathToFileURL(path.join(tmp, 'employee-it-support-policy.mjs')).href);
const projectPolicy = await import(pathToFileURL(path.join(tmp, 'project-access-policy.mjs')).href);
const ticketPolicy = await import(pathToFileURL(path.join(tmp, 'ticket-access-policy.mjs')).href);
const chatPolicy = await import(pathToFileURL(path.join(tmp, 'chat-access-policy.mjs')).href);
const ticketRuntime = await import(pathToFileURL(path.join(tmp, 'ticket-runtime-policy-adapter.mjs')).href);

const it = {
  employeeUid: 'emp_it_support_4001',
  ccmsId: '4001',
  fullName: 'IT Support',
  roleKey: 'it',
  accountStatus: 'active',
  projectId: '',
  projectIds: [],
};
const ceo = {
  employeeUid: 'emp_ceo_0001', ccmsId:'0001', fullName:'CEO', roleKey:'ceo', accountStatus:'active', projectIds:['*'],
};
const agent = {
  employeeUid: 'emp_agent_9001', ccmsId:'9001', fullName:'Agent', roleKey:'agent', accountStatus:'active', projectId:'ipro', projectIds:['ipro'], supervisorUid:'emp_sup_2001', supervisorCcmsId:'2001', hourlyRate:99, currency:'USD',
};
const archivedAgent = { ...agent, employeeUid:'emp_agent_9009', ccmsId:'9009', accountStatus:'archived' };

assert.equal(model.roleFromCcmsId('4001'), 'it');
assert.equal(model.nextAvailableCcmsId('it', []), '4001');
assert.equal(model.normaliseCanonicalRole('it'), 'it');
assert.doesNotThrow(() => model.validateEmployeeIdentity(it));
assert.throws(() => model.validateEmployeeIdentity({ ...it, projectId:'ipro', projectIds:['ipro'] }), /must not be assigned operational projects/i);

assert.equal(itPolicy.isItSupportActor(it), true);
assert.equal(itPolicy.canViewAccountSupportProfile(it, agent), true);
assert.equal(itPolicy.canViewAccountSupportProfile(it, ceo), false);
assert.equal(itPolicy.canResetEmployeePassword(it, agent), true);
assert.equal(itPolicy.canResetEmployeePassword(it, it), false);
assert.equal(itPolicy.canResetEmployeePassword(it, archivedAgent), false);
assert.throws(() => itPolicy.assertItPasswordResetAllowed(it, ceo), /cannot reset the CEO/i);
assert.throws(() => itPolicy.assertItPasswordResetAllowed(it, it), /own account/i);

const supportProfile = itPolicy.accountSupportProfile(agent, {
  exists:true,
  mustChangePassword:true,
  passwordExpired:false,
  passwordChangeRequired:true,
  passwordChangedAtMs:1_000,
  passwordExpiresAtMs:2_000,
  passwordMaxAgeDays:90,
  salt:'must-not-leak',
  passwordHash:'must-not-leak',
  passwordHistory:[{ passwordHash:'must-not-leak' }],
});
assert.equal(supportProfile.ccmsId, '9001');
assert.equal(supportProfile.credential.passwordMaxAgeDays, 90);
assert.equal('hourlyRate' in supportProfile, false);
assert.equal('currency' in supportProfile, false);
const safeJson = JSON.stringify(supportProfile);
assert.equal(safeJson.includes('must-not-leak'), false);
assert.equal(safeJson.includes('passwordHash'), false);
assert.equal(safeJson.includes('passwordHistory'), false);
assert.equal(safeJson.includes('salt'), false);

assert.equal(projectPolicy.actorCanAccessProject(it, 'ipro'), false);
assert.equal(ticketPolicy.canViewTicket(it, { projectId:'ipro', assignedTo:'9001', status:'open' }, [agent]), false);
assert.equal(chatPolicy.visibleChatContacts(it, [agent, ceo]).length, 0);
assert.equal(chatPolicy.canInitiateDirectChat(it, agent), false);
assert.equal(chatPolicy.canSeeDetailedPresence(it, agent), false);
assert.equal(chatPolicy.canAddGroupMember(it, agent, 'ipro'), false);

const runtimeDirectory = [
  { id:'4001', employeeUid:it.employeeUid, name:'IT Support', role:'it', accountStatus:'active' },
  { id:'9001', employeeUid:agent.employeeUid, name:'Agent', role:'agent', projectId:'ipro', supervisorId:'2001', accountStatus:'active' },
];
const runtimeIt = ticketRuntime.runtimeTicketActor({ id:'4001', role:'it' }, runtimeDirectory);
assert.equal(runtimeIt.roleKey, 'it');
assert.equal(runtimeIt.projectId, '');
assert.deepEqual(runtimeIt.projectIds, []);
assert.equal(ticketRuntime.runtimeCanOpenTickets({ id:'4001', role:'it' }, runtimeDirectory), false);
assert.equal(ticketRuntime.runtimeCanViewTicket({ id:'4001', role:'it' }, { assignedTo:'9001', projectId:'ipro' }, runtimeDirectory), false);
assert.deepEqual(ticketRuntime.runtimeTicketScope({ id:'4001', role:'it' }, runtimeDirectory), { mode:'none', projectId:'', assignmentIds:[] });
assert.deepEqual(ticketRuntime.runtimeAssignmentCandidates({ id:'4001', role:'it' }, runtimeDirectory), []);

const compliantPassword = 'ExampleStart2026!';
assert.equal(passwordPolicy.validateEmployeePassword(compliantPassword), compliantPassword);
assert.throws(() => passwordPolicy.validateEmployeePassword('weakpassword'), /uppercase|number|symbol/i);
const credential = await crypto.createPasswordCredential(compliantPassword, { iterations:100_000 });
assert.equal(await crypto.verifyPasswordCredential(compliantPassword, credential), true);
assert.equal(JSON.stringify(credential).includes(compliantPassword), false);

const changedAtMs = Date.parse('2026-01-01T00:00:00Z');
const day = 24 * 60 * 60 * 1000;
const day89 = passwordPolicy.passwordLifecycleState({ passwordChangedAt:changedAtMs, mustChangePassword:false }, changedAtMs + 89 * day);
const day90 = passwordPolicy.passwordLifecycleState({ passwordChangedAt:changedAtMs, mustChangePassword:false }, changedAtMs + 90 * day);
const temporary = passwordPolicy.passwordLifecycleState({ passwordChangedAt:changedAtMs, mustChangePassword:true }, changedAtMs + day);
assert.equal(day89.passwordChangeRequired, false);
assert.equal(day90.passwordExpired, true);
assert.equal(day90.passwordChangeRequired, true);
assert.equal(temporary.passwordChangeRequired, true);
assert.equal(passwordPolicy.PASSWORD_MAX_AGE_DAYS, 90);
assert.equal(passwordPolicy.PASSWORD_HISTORY_LIMIT, 5);

const serviceSource = fs.readFileSync(path.join(root, 'employee-it-support-service.js'), 'utf8');
assert.match(serviceSource, /EMPLOYEE_ACCOUNT_PROVISIONING_READY/);
assert.match(serviceSource, /Password resets are locked until permanent account provisioning is enabled/);
assert.match(serviceSource, /provisionTemporaryEmployeeCredential\(target, temporaryPassword, actor\)/);
assert.doesNotMatch(serviceSource, /hourlyRate|payroll|tickets|messages|chat/i);

const authSource = fs.readFileSync(path.join(root, 'employee-auth-v2.js'), 'utf8');
assert.match(authSource, /passwordMaxAgeDays: PASSWORD_MAX_AGE_DAYS/);
assert.match(authSource, /mustChangePassword: true/);
assert.match(authSource, /password_change_required/);
assert.match(authSource, /PASSWORD_HISTORY_LIMIT/);
assert.doesNotMatch(authSource, /Welcome2026!/i, 'Operational temporary password must never be committed to source.');

console.log(JSON.stringify({
  itRange:'4xxx',
  firstItCcms:model.nextAvailableCcmsId('it', []),
  passwordMaxAgeDays:passwordPolicy.PASSWORD_MAX_AGE_DAYS,
  passwordHistoryLimit:passwordPolicy.PASSWORD_HISTORY_LIMIT,
  itTicketAccess:false,
  itChatAccess:false,
  ceoResetBlocked:true,
  plaintextCommitted:false,
  result:'PASS',
}, null, 2));
