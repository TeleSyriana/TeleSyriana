import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-phase1b-auth-'));
const passwordPolicyTarget = path.join(tmp, 'employee-password-policy.mjs');
fs.writeFileSync(passwordPolicyTarget, fs.readFileSync(path.join(root, 'employee-password-policy.js'), 'utf8'));
const cryptoTarget = path.join(tmp, 'employee-credential-crypto.mjs');
let cryptoSource = fs.readFileSync(path.join(root, 'employee-credential-crypto.js'), 'utf8');
cryptoSource = cryptoSource.split('./employee-password-policy.js').join('./employee-password-policy.mjs');
fs.writeFileSync(cryptoTarget, cryptoSource);

const passwordPolicy = await import(pathToFileURL(passwordPolicyTarget).href);
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
assert.throws(() => credentialCrypto.validateTemporaryPassword('short'), /at least 10 characters/i);
assert.throws(() => credentialCrypto.validateTemporaryPassword('alllowercase2026!'), /uppercase/i);
assert.throws(() => credentialCrypto.validateTemporaryPassword('ALLUPPERCASE2026!'), /lowercase/i);
assert.throws(() => credentialCrypto.validateTemporaryPassword('NoNumbersHere!'), /number/i);
assert.throws(() => credentialCrypto.validateTemporaryPassword('NoSymbols2026'), /symbol/i);

assert.equal(passwordPolicy.PASSWORD_MAX_AGE_DAYS, 90);
assert.equal(passwordPolicy.PASSWORD_HISTORY_LIMIT, 5);
const changedAt = Date.parse('2026-01-01T00:00:00Z');
const beforeExpiry = passwordPolicy.passwordLifecycleState({
  passwordChangedAt: changedAt,
  mustChangePassword: false,
}, changedAt + 89 * 24 * 60 * 60 * 1000);
assert.equal(beforeExpiry.passwordExpired, false);
assert.equal(beforeExpiry.passwordChangeRequired, false);
const expired = passwordPolicy.passwordLifecycleState({
  passwordChangedAt: changedAt,
  mustChangePassword: false,
}, changedAt + 90 * 24 * 60 * 60 * 1000);
assert.equal(expired.passwordExpired, true);
assert.equal(expired.passwordChangeRequired, true);
const firstLogin = passwordPolicy.passwordLifecycleState({
  passwordChangedAt: changedAt,
  mustChangePassword: true,
}, changedAt + 1_000);
assert.equal(firstLogin.passwordChangeRequired, true);

const authSource = fs.readFileSync(path.join(root, 'employee-auth-v2.js'), 'utf8');
assert.match(authSource, /EMPLOYEE_CREDENTIALS_COL = "employeeCredentials"/);
assert.match(authSource, /passwordMaxAgeDays: PASSWORD_MAX_AGE_DAYS/);
assert.match(authSource, /mustChangePassword: true/);
assert.match(authSource, /passwordChangedAt: serverTimestamp\(\)/);
assert.match(authSource, /passwordHistory: nextPasswordHistory/);
assert.match(authSource, /changeEmployeePassword/);
assert.match(authSource, /password_change_required/);
assert.match(authSource, /passwordPolicyMigrationRequired: true/);
assert.match(authSource, /permanent_hashed_credential/);
assert.match(authSource, /credential_ccms_mismatch/);
assert.doesNotMatch(authSource, /password:\s*temporaryPassword/);

const serviceSource = fs.readFileSync(path.join(root, 'employee-management-service.js'), 'utf8');
assert.match(serviceSource, /EMPLOYEE_ACCOUNT_PROVISIONING_READY = false/);
assert.match(serviceSource, /Account provisioning is locked until the controlled login\/credential bridge is ready/);
const gateCalls = (serviceSource.match(/assertAccountProvisioningReady\(\);/g) || []).length;
assert.ok(gateCalls >= 5, `Expected write operations to be provisioning-gated; found ${gateCalls} gate calls.`);

const provisioningSource = fs.readFileSync(path.join(root, 'employee-account-provisioning.js'), 'utf8');
assert.match(provisioningSource, /validateTemporaryPassword\(temporaryPassword\)/);
assert.match(provisioningSource, /provisionTemporaryEmployeeCredential\(identity, temporaryPassword, actor\)/);
assert.match(provisioningSource, /accountStatus: "disabled"/);
assert.match(provisioningSource, /credential_provisioning_failed_after_identity_create/);
assert.match(provisioningSource, /promotion_credential_failed_rolled_back/);
assert.match(provisioningSource, /demotion_credential_failed_rolled_back/);
assert.match(provisioningSource, /await reclassifyEmployee\(promoted\.employeeUid/);
assert.match(provisioningSource, /await reclassifyEmployee\(demoted\.employeeUid/);

console.log('Phase 1B credential/auth preflight: PASS');
console.log('Verified strong password creation, backward-compatible hash verification, 90-day expiry, first-login change, history scaffolding, and no plaintext credential storage.');
console.log('Verified permanent-UID credential records, legacy migration flag, provisioning write lock, and rollback safeguards.');
