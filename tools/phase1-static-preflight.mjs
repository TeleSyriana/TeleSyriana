#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Stable core baselines from current main. Entry/facade modules may evolve, but these
// preserved cores must not be silently rewritten by a compatibility loader change.
const PRESERVED_BLOBS = Object.freeze({
  'app-core.js': '41c4776ed73f188c99992af657c85ac75cf2a5ed',
  'employee-directory-core.js': '47e30399c9ddcc5786a8673deecdf6818cc1b3f9',
  'employees-ui-core.js': '77f6a5d69073e673be71d3f66aa135f4a70d363a',
  'tickets-core.js': '14d7fb79255962944c3a54f20c394122f909d290',
  'payroll-core.js': '51e6bd65e3f13e0addefc0dad8e40932352ed09c',
  'reports-core.js': '1687f8c185dece33ed6bae21dd863db2da4abe97',
  'messages-core.js': 'b1b439fb74a635371caf6f6beba9ed9d6f764779',
  'groups-core.js': '09d2e323b60adb30e583dcf4c7bc707bdb4f6ad2',
});

const JS_FILES = [
  'app.js', 'app-core.js',
  'employee-directory.js', 'employee-directory-core.js',
  'employees-ui.js', 'employees-ui-core.js',
  'tickets.js', 'tickets-core.js',
  'payroll.js', 'payroll-core.js',
  'reports.js', 'reports-core.js',
  'messages.js', 'messages-core.js',
  'groups.js', 'groups-core.js',
  'employee-auth-v2.js', 'employee-identity-store.js', 'employee-identity-compat.js',
];

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function readBytes(relativePath) {
  return readFileSync(join(ROOT, relativePath));
}

function gitBlobSha(bytes) {
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function verifySyntax() {
  const scratch = mkdtempSync(join(tmpdir(), 'telesyriana-phase1-'));
  try {
    for (const file of JS_FILES) {
      const tempFile = join(scratch, `${basename(file, '.js')}.mjs`);
      writeFileSync(tempFile, readBytes(file));
      execFileSync(process.execPath, ['--check', tempFile], { stdio: 'pipe' });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function verifyPreservedBlobs() {
  for (const [file, expected] of Object.entries(PRESERVED_BLOBS)) {
    const actual = gitBlobSha(readBytes(file));
    assert(actual === expected, `${file}: preserved blob changed. Expected ${expected}, got ${actual}`);
  }
}

function verifyProductionAuthContract() {
  const app = read('app.js');
  const core = read('app-core.js');
  const auth = read('employee-auth-v2.js');

  const corePatchMarkers = [
    'import { db, fs } from "./firebase.js";',
    '      const u = JSON.parse(savedUser);\n      if (USERS[u.id]) {',
    '    currentUser = safeUserPayload(id);',
    'document.addEventListener("DOMContentLoaded", async () => {',
    '  showLogin();\n});\n\nfunction closeMobileMenu() {',
  ];
  for (const marker of corePatchMarkers) {
    assert(core.includes(marker), `app-core.js: required narrow-auth patch marker missing: ${JSON.stringify(marker)}`);
  }

  const appMarkers = [
    'authenticateEmployeeV2(id, pw)',
    'getEmployeeIdentityByCcms(savedId',
    'employeeIdentityToLegacySession(identity)',
    'window.__TS_APP_PRODUCTION_BOOTED__',
    'credential_not_provisioned',
    'Production V2 auth loader failed; falling back to stable legacy core.',
    'await import(CORE_URL.href)',
  ];
  for (const marker of appMarkers) {
    assert(app.includes(marker), `app.js: production auth contract missing: ${marker}`);
  }

  const authMarkers = [
    'const seededIdentity = seedIdentityForAuth(id);',
    'identity.credentialSetupRequired !== true',
    'reason: "credential_not_provisioned"',
    'authSource: "permanent_hashed_credential"',
    'authSource: "legacy_compatibility"',
  ];
  for (const marker of authMarkers) {
    assert(auth.includes(marker), `employee-auth-v2.js: authentication contract missing: ${marker}`);
  }
}

function verifyFacadeFallbacks() {
  for (const file of ['employees-ui.js', 'tickets.js', 'payroll.js', 'reports.js', 'messages.js', 'groups.js']) {
    const source = read(file);
    assert(source.includes('await import(CORE_URL.href)'), `${file}: untouched-core fallback import missing`);
  }

  const directory = read('employee-directory.js');
  assert(directory.includes("export * from './employee-directory-core.js';"), 'employee-directory.js: core facade export missing');
  assert(directory.includes('assertManagementActor(actor)'), 'employee-directory.js: management actor guard missing');
  assert(directory.includes('assertSupervisorTeamCanChange'), 'employee-directory.js: Supervisor team guard missing');
}

try {
  verifySyntax();
  verifyPreservedBlobs();
  verifyProductionAuthContract();
  verifyFacadeFallbacks();
  console.log('Phase 1 static preflight: PASS');
  console.log(`Validated ${JS_FILES.length} JavaScript files, ${Object.keys(PRESERVED_BLOBS).length} stable core blobs, and the production V2 auth contract.`);
} catch (error) {
  console.error('Phase 1 static preflight: FAIL');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
