#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PRESERVED_BLOBS = Object.freeze({
  'app-core.js': '7332d1dcb36f0b84e4f9c48ffa59d0bcf17551d2',
  'employee-directory-core.js': '47e30399c9ddcc5786a8673deecdf6818cc1b3f9',
  'employees-ui-core.js': '77f6a5d69073e673be71d3f66aa135f4a70d363a',
  'tickets-core.js': '14d7fb79255962944c3a54f20c394122f909d290',
  'payroll-core.js': '51e6bd65e3f13e0addefc0dad8e40932352ed09c',
  'reports-core.js': '1687f8c185dece33ed6bae21dd863db2da4abe97',
  'messages-core.js': 'bcd3e9ce562054284b2dc4cb0eca6424d8a67956',
  'groups-core.js': '8c706449e5229dca0785317bcaebbf2697cceab4',
});

const JS_FILES = [
  'app.js',
  'app-core.js',
  'employee-directory.js',
  'employee-directory-core.js',
  'employees-ui.js',
  'employees-ui-core.js',
  'tickets.js',
  'tickets-core.js',
  'payroll.js',
  'payroll-core.js',
  'reports.js',
  'reports-core.js',
  'messages.js',
  'messages-core.js',
  'groups.js',
  'groups-core.js',
];

const CORE_MARKERS = Object.freeze({
  'app-core.js': [
    'import { db, fs } from "./firebase.js";',
    '// Demo users\n',
    'function hasRoleAtLeast(user, role) {',
    '        const u = JSON.parse(savedUser);\n        if (USERS[u.id]) {',
    '    currentUser = safeUserPayload(id);',
    'let staffSettingsUnsub = null;\nlet issueStatsByDay = {};',
    '/* --------------------------- Widgets (Clock/Date) ------------------------ */',
    'function finishInit(now) {\n  if (canViewTeamDashboard(currentUser)) subscribeSupervisorDashboard();',
    '  if (nameEl) nameEl.value = currentUser.name || currentUser.id;',
    '  if (cached.name) {\n    currentUser = { ...currentUser, name: cached.name, profilePhoto: cached.profilePhoto || currentUser.profilePhoto || "" };',
    '  const name = document.getElementById("set-name")?.value?.trim() || currentUser.name || currentUser.id;',
  ],
  'employees-ui-core.js': [
    '} from "./employee-directory.js";',
    'function canManageTarget(target, actor = currentUser()) {',
    '  fillRoleOptions(row?.role || "agent");',
    '  const password = String(document.getElementById("employee-password")?.value || "");',
    '  if (type === "edit") return openModal(row);',
  ],
  'tickets-core.js': [
    'import { db, fs } from "./firebase.js";',
    'const STAFF = {\n',
    'const EMERGENCY_TYPES = new Set([',
    'function visibleStaffForAssignment() {',
    'function initTickets() {\n  currentUser = getCurrentUser();',
    'window.addEventListener("telesyriana:user-changed", initTickets);',
  ],
  'payroll-core.js': [
    'import { db, fs } from "./firebase.js";',
    'const STAFF = {\n',
    'let currentUser = null;',
    '  return ["admin", "manager", "supervisor"].includes(role);',
    '    const editableIds = canSeeAll(currentUser) ? Object.keys(STAFF) : visibleIds;',
    'function init() {\n  translatePayrollStatic();\n  currentUser = getCurrentUser();',
    'window.addEventListener("telesyriana:user-changed", () => {',
  ],
  'reports-core.js': [
    'import { db, fs } from "./firebase.js";',
    'const STAFF = {\n',
    'const REPORT_LABELS = {',
    'function initReports() {\n  currentUser = getCurrentUser();',
    'window.addEventListener("telesyriana:user-changed", initReports);',
  ],
  'messages-core.js': [
    'import { db, fs } from "./firebase.js";',
    'function roleClassForUser(userId = "") {',
    'function getDmDisplayName(userId) {',
    '// ---------------- init ----------------\n',
    'document.addEventListener("DOMContentLoaded", () => {',
    '  setCurrentUser();\n  subscribePresenceSidebar();',
    '  document.querySelectorAll(".chat-dm[data-dm]").forEach((btn) => {',
    '  const formEl = document.getElementById("chat-form");',
  ],
  'groups-core.js': [
    'import { db, fs } from "./firebase.js";',
    '// --------- member search (works even if modal is opened later) ----------\n',
    'document.addEventListener("DOMContentLoaded", () => {\n  hookMemberSearch();',
  ],
});

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function gitBlobSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function verifySyntax() {
  for (const file of JS_FILES) {
    execFileSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'pipe' });
  }
}

function verifyPreservedBlobs() {
  for (const [file, expected] of Object.entries(PRESERVED_BLOBS)) {
    const actual = gitBlobSha(read(file));
    assert(actual === expected, `${file}: preserved blob changed. Expected ${expected}, got ${actual}`);
  }
}

function verifyCoreMarkers() {
  for (const [file, markers] of Object.entries(CORE_MARKERS)) {
    const source = read(file);
    for (const marker of markers) {
      assert(source.includes(marker), `${file}: required migration marker is missing: ${JSON.stringify(marker)}`);
    }
  }
}

function verifyFacadeAndLoaderGuards() {
  const directory = read('employee-directory.js');
  assert(directory.includes("export * from './employee-directory-core.js';"), 'employee-directory.js: core facade export missing');
  assert(directory.includes("telesyriana:employee-directory-changed"), 'employee-directory.js: directory change event missing');

  const loaders = {
    'app.js': ['legacy auth code remains', 'profile name can still override directory identity'],
    'employees-ui.js': ['duplicate CCMS protection missing', 'self-role lock missing', 'active-team protection missing'],
    'tickets.js': ['legacy STAFF remains', 'active assignment filter missing'],
    'payroll.js': ['legacy STAFF remains', 'inactive settings targets remain'],
    'reports.js': ['legacy STAFF remains', 'refresh missing'],
    'messages.js': ['hard-coded roles remain', 'directory names are not authoritative', 'directory refresh missing'],
    'groups.js': ['initial member refresh missing', 'inactive-member protection missing'],
  };

  for (const [file, guards] of Object.entries(loaders)) {
    const source = read(file);
    for (const guard of guards) {
      assert(source.includes(guard), `${file}: fail-fast validation guard missing: ${guard}`);
    }
    assert(source.includes('await import(CORE_URL.href)'), `${file}: untouched-core fallback import missing`);
  }
}

try {
  verifySyntax();
  verifyPreservedBlobs();
  verifyCoreMarkers();
  verifyFacadeAndLoaderGuards();
  console.log('Phase 1 static preflight: PASS');
  console.log(`Validated ${JS_FILES.length} JavaScript files and ${Object.keys(PRESERVED_BLOBS).length} preserved core blob hashes.`);
} catch (error) {
  console.error('Phase 1 static preflight: FAIL');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
