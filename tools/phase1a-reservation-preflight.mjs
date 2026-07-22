import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-phase1a-reservations-'));

let modelSource = fs.readFileSync(path.join(root, 'employee-model.js'), 'utf8');
fs.writeFileSync(path.join(tmp, 'employee-model.mjs'), modelSource);

let seedSource = fs.readFileSync(path.join(root, 'employee-identity-seed.js'), 'utf8');
seedSource = seedSource.split('./employee-model.js').join('./employee-model.mjs');
fs.writeFileSync(path.join(tmp, 'employee-identity-seed.mjs'), seedSource);

const seed = await import(pathToFileURL(path.join(tmp, 'employee-identity-seed.mjs')).href);
const expectedCcms = ['0001', '1001', '2001', '3001', '9001', '9002', '9003'];
const expectedUids = expectedCcms.map((ccmsId) => `emp_legacy_${ccmsId}`);

assert.deepEqual(
  seed.CURRENT_EMPLOYEE_IDENTITY_SEED.map((row) => row.ccmsId).sort(),
  [...expectedCcms].sort(),
  'Current legacy CCMS reservations changed unexpectedly.'
);
assert.deepEqual(
  seed.CURRENT_EMPLOYEE_IDENTITY_SEED.map((row) => row.employeeUid).sort(),
  [...expectedUids].sort(),
  'Current permanent legacy UIDs changed unexpectedly.'
);

const store = fs.readFileSync(path.join(root, 'employee-identity-store.js'), 'utf8');

assert.match(store, /function assertNotReservedLegacyIdentity\(employee\)/);
assert.match(store, /const reservedByCcms = seedIdentityByCcms\(employee\?\.ccmsId\)/);
assert.match(store, /const reservedByUid = seedIdentityByUid\(employee\?\.employeeUid\)/);
assert.match(store, /assertNotReservedLegacyIdentity\(employee\);/);
assert.match(store, /CCMS or employee UID is reserved for an existing TeleSyriana employee/);

assert.match(store, /const reserved = seedIdentityByCcms\(next\.ccmsId\)/);
assert.match(store, /reserved\.employeeUid !== uid/);
assert.match(store, /is reserved for an existing TeleSyriana employee/);

assert.match(store, /withDirectorySource\([\s\S]*?"firestore"/);
assert.match(store, /withDirectorySource\(seedIdentityByUid\(uid\), "seed"\)/);
assert.match(store, /withDirectorySource\(seedIdentityByCcms\(id\), "seed"\)/);
assert.match(store, /directorySource/);

assert.match(
  store,
  /export async function ensureIdentityIndex\(employee, actor = null, options = \{\}\)[\s\S]*?assertPhase1AMigrationWriteGate\(\{ actor, confirmation: options\.confirmation \}\)/
);

console.log('Phase 1A legacy identity reservation preflight: PASS');
console.log(`Reserved CCMS IDs: ${expectedCcms.join(', ')}`);
console.log('Verified seed/firestore directory source markers and gated index repair path.');
