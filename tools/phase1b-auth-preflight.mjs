import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-phase1b-auth-'));
const cryptoTarget = path.join(tmp, 'employee-credential-crypto.mjs');
fs.writeFileSync(cryptoTarget, fs.readFileSync(path.join(root, 'employee-credential-crypto.js'), 'utf8'));
const credentialCrypto = await import(pathToFileURL(cryptoTarget).href);

const password = 'StrongTempPass-2026!';
const first = await credentialCrypto.createPasswordCredential(password, { iterations: 100_000 });
const second = await credentialCrypto.createPasswordCredential(password, { iterations: 100_000 });

assert.equal(first.algorithm, 'PBKDF2-SHA-256');
assert.equal(first.credentialVersion, 1);
assert.ok(first.iterations >= 100_000);
assert.ok(first.salt.length > 10);
assert.ok(first.passwordHash.length > 20);
assert.notEqual(first.salt, second.salt, 'Each credential must have a unique random salt.');
assert.notEqual(first.passwordHash, second.passwordHash, 'Same password with different salts must not produce identical stored hashes.');
assert.equal(JSON.stringify(first).includes(password), false, 'Credential record must not contain plaintext password.');
assert.equal(await credentialCrypto.verifyPasswordCredential(password, first), true);
assert.equal(await credentialCrypto.verifyPasswordCredential('WrongPassword-2026!', first), false);
assert.throws(() => credentialCrypto.validateTemporaryPassword('short'), /at least 8 characters/i);

const authSource = fs.readFileSync(path.join(root, 'employee-auth-v2.js'), 'utf8');
assert.match(authSource, /EMPLOYEE_CREDENTIALS_COL = "employeeCredentials"/);
assert.match(authSource, /doc\(db, EMPLOYEE_CREDENTIALS_COL, employeeUid\)/);
assert.match(authSource, /identity\.directorySource === "seed"/);
assert.match(authSource, /legacyFallbackAllowed\(identity, ccmsId\)/);
assert.match(authSource, /permanent_hashed_credential/);
assert.match(authSource, /credential_ccms_mismatch/);
assert.doesNotMatch(authSource, /password:\s*temporaryPassword/);

const serviceSource = fs.readFileSync(path.join(root, 'employee-management-service.js'), 'utf8');
assert.match(serviceSource, /EMPLOYEE_ACCOUNT_PROVISIONING_READY = false/);
assert.match(serviceSource, /Account provisioning is locked until the controlled login\/credential bridge is ready/);
const gateCalls = (serviceSource.match(/assertAccountProvisioningReady\(\);/g) || []).length;
assert.ok(gateCalls >= 5, `Expected write operations to be provisioning-gated; found ${gateCalls} gate calls.`);

console.log('Phase 1B credential/auth preflight: PASS');
console.log('Verified PBKDF2 hashing, random salts, wrong-password rejection, and no plaintext credential storage.');
console.log('Verified permanent-UID credential records, legacy-seed fallback rules, and provisioning write lock.');
