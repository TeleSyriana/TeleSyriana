#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PRESERVED_BLOBS = Object.freeze({
  // These are the stable cores currently present on main. The production entry
  // patches authentication around them instead of rewriting the cores themselves.
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
  // Only assert markers the current production auth loader actually patches.
  // The previous broad loader depended on unrelated quota/profile markers and
  // became fragile whenever app-core evolved.
  'app-core.js': [
    'import { db, fs } from "./firebase.js";',
    '// Demo users\n',
    'function safeUserPayload(id) {\n  const u = USERS[id];\n  if (!u) return null;\n  const { password, ...safe } = u;\n  return { id, ...safe };\n}\n',
    '      const u = JSON.parse(savedUser);\n      if (USERS[u.id]) {',
    '  if (!USERS[id]) return showError("المستخدم غير موجود. جرّب 0001 أو 1001 أو 2001 أو 3001 أو 9001 أو 9002 أو 9003.");',
    '    currentUser = safeUserPayload(id);',
    'document.addEventListener("DOMContentLoaded", async () => {',
    '  showLogin();\n});\n\nfunction closeMobileMenu() {',
  ],
  'employees-ui-core.js': [
    '} from "./employee-directory.js";',
    'function canManageTarget(target, actor = currentUser()) {',
    '  fillRoleOptions(row?.role || "agent");',
    '  const password = String(document.getElementById("employee-password")?.value || "");',
    '  if (type === "edit") return openModal(row);',
    'function syncVisibility() {',
    '  if (allowed) refresh();',
    'function boot() {\n  hook();\n  syncVisibility();',
  ],
  'tickets-core.js': [
    'import { db, fs } from "./firebase.js";',
    'const STAFF = {\n',
    'const EMERGENCY_TYPES = new Set([',
    'function visibleStaffForAssignment() {',
    'function initTickets() {\n  currentUser = getCurrentUser();',
    '  ensureDeletedTicketsUI();\n  subscribeTickets();\n  subscribeDeletedTickets();\n}',
    'function openDeletedTicketsFolder() {',
    'function closeDeletedTicketsFolder() { el(\'deleted-tickets-modal\')?.classList.add(\'hidden\'); }',
    'window.addEventListener("telesyriana:user-changed", initTickets);',
  ],
  'payroll-core.js': [
    'import { db, fs } from "./firebase.js";',
    'const STAFF = {\n',
    'let currentUser = null;',
    '  return ["admin", "manager", "supervisor"].includes(role);',
    '    const editableIds = canSeeAll(currentUser) ? Object.keys(STAFF) : visibleIds;',
    'function init() {\n  translatePayrollStatic();\n  currentUser = getCurrentUser();',
    '  if (currentUser) subscribePayroll();\n}',
    'window.addEventListener("telesyriana:user-changed", () => {\n  currentUser = getCurrentUser();\n  populateStaffFilters();\n  setThisWeekFilters();\n  setPermissionsUI();\n  renderPayroll();\n  if (currentUser) subscribePayroll();\n});',
  ],
  'reports-core.js': [
    'import { db, fs } from "./firebase.js";',
    'const STAFF = {\n',
    'const REPORT_LABELS = {',
    'function initReports() {\n  currentUser = getCurrentUser();',
    '  subscribeReports();\n  subscribeTicketsSnapshot();\n}',
    'window.addEventListener("telesyriana:user-changed", initReports);',
  ],
  'messages-core.js': [
    'import { db, fs } from "./firebase.js";',
    'function roleClassForUser(userId = "") {',
    'function getDmDisplayName(userId) {',
    '// ---------------- init ----------------\n',
    'document.addEventListener("DOMContentLoaded", () => {',
    '  setCurrentUser();\n  subscribePresenceSidebar();\n  subscribeProfilesSidebar();',
    '  document.querySelectorAll(".chat-dm[data-dm]").forEach((btn) => {',
    '  const formEl = document.getElementById("chat-form");',
    '  subscribeالحالةDots();\n});',
    '  subscribeGroupsCloud();\n  subscribeRecentsCloud();\n  subscribeالحالةDots();\n  subscribeProfilesSidebar();\n  applyProfileAvatars();',
  ],
  'groups-core.js': [
    'import { db, fs } from "./firebase.js";',
    '// --------- member search (works even if modal is opened later) ----------\n',
    '          btn.addEventListener("dblclick", () => {',
    '  openBtn?.addEventListener("click", () => {\n    resetFormToCreate();\n    openModal();\n  });',
    'document.addEventListener("DOMContentLoaded", () => {\n  hookMemberSearch();',
  ],
});

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
  assert(directory.includes('assertManagementActor(actor)'), 'employee-directory.js: management actor guard missing');
  assert(directory.includes('assertSupervisorTeamCanChange'), 'employee-directory.js: Supervisor team guard missing');
  assert(directory.includes('You cannot change your own management role.'), 'employee-directory.js: self-role service guard missing');
  assert(directory.includes('const DIRECTORY_CACHE_TTL_MS = 30_000;'), 'employee-directory.js: shared directory cache TTL missing');
  assert(directory.includes('let employeeListCachePromise = null;'), 'employee-directory.js: concurrent directory request coalescing missing');
  assert(directory.includes('export async function listEmployees(options = {})'), 'employee-directory.js: cached listEmployees facade missing');
  assert(directory.includes('function notifyDirectoryChanged(detail = {}) {\n  invalidateEmployeeListCache();'), 'employee-directory.js: write cache invalidation missing');
  assert(directory.includes('destructive-role/status safety decision'), 'employee-directory.js: fresh Supervisor safety-read marker missing');

  const loaders = {
    'app.js': [
      'authenticateEmployeeV2(id, pw)',
      'getEmployeeIdentityByCcms(savedId',
      'Production V2 auth loader failed',
      'window.__TS_APP_PRODUCTION_BOOTED__',
      'credential_not_provisioned',
    ],
    'employees-ui.js': ['duplicate CCMS protection missing', 'self-role lock missing', 'active-team protection missing', 'hidden-page directory refresh remains'],
    'tickets.js': ['legacy STAFF remains', 'active assignment filter missing', 'hidden-page subscriptions remain', 'deleted tickets are not on-demand', 'directory still loads before page/login need'],
    'payroll.js': ['legacy STAFF remains', 'inactive settings targets remain', 'hidden-page subscriptions remain', 'directory still loads before page/login need'],
    'reports.js': ['legacy STAFF remains', 'refresh missing', 'hidden-page subscriptions remain', 'directory still loads before page/login need'],
    'messages.js': ['hard-coded roles remain', 'directory names are not authoritative', 'directory refresh missing', 'hidden-page realtime listeners remain', 'directory still loads before login/page need'],
    'groups.js': ['on-demand member refresh missing', 'inactive-member protection missing', 'directory still loads on login screen'],
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
