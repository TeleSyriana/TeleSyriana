// reports.js — TeleSyriana Phase 1 employee-directory migration loader
// Keeps the report/ticket-summary engine in reports-core.js, swaps its staff
// directory, and keeps Firestore listeners off while Reports is hidden.

const CORE_URL = new URL('./reports-core.js', import.meta.url);
const FIREBASE_URL = new URL('./firebase.js', import.meta.url).href;
const DIRECTORY_URL = new URL('./employee-directory.js', import.meta.url).href;

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`Reports directory marker missing: ${label}`);
  return source.replace(oldText, newText);
}

function replaceBetweenRequired(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Reports directory start marker missing: ${label}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Reports directory end marker missing: ${label}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function patchReports(coreSource) {
  let source = String(coreSource || '');
  const imports = `import { db, fs } from ${JSON.stringify(FIREBASE_URL)};\nimport { listEmployees } from ${JSON.stringify(DIRECTORY_URL)};`;
  source = replaceRequired(source, 'import { db, fs } from "./firebase.js";', imports, 'firebase import');

  const staffReplacement = `let STAFF = {};\n\nasync function refreshReportsStaffDirectory() {\n  const rows = await listEmployees({ includeDisabled: true, includeArchived: true });\n  STAFF = Object.fromEntries(rows.map((row) => [String(row.id), row]));\n}\n\n`;
  source = replaceBetweenRequired(source, 'const STAFF = {\n', 'const REPORT_LABELS = {', staffReplacement, 'hard-coded reports STAFF map');

  const reportsLifecycleHelpers = `function reportsPageIsActive() {\n  const page = el("page-reports");\n  return Boolean(page && !page.classList.contains("hidden"));\n}\n\nfunction stopReportsPageSubscriptions() {\n  if (unsubReports) { try { unsubReports(); } catch {} }\n  if (unsubTickets) { try { unsubTickets(); } catch {} }\n  unsubReports = null;\n  unsubTickets = null;\n}\n\nfunction bindReportsPageLifecycle() {\n  if (window.__TS_REPORTS_PAGE_LIFECYCLE__) return;\n  window.__TS_REPORTS_PAGE_LIFECYCLE__ = true;\n  document.addEventListener("click", (event) => {\n    const nav = event.target?.closest?.(".nav-link[data-page]");\n    if (!nav) return;\n    if (nav.dataset.page === "reports") setTimeout(() => initReports(), 0);\n    else stopReportsPageSubscriptions();\n  });\n}\n\n`;

  source = replaceRequired(
    source,
    'function initReports() {\n  currentUser = getCurrentUser();',
    `${reportsLifecycleHelpers}async function initReports() {\n  currentUser = getCurrentUser();\n  bindReportsPageLifecycle();`,
    'reports init lifecycle'
  );

  source = replaceRequired(
    source,
    '  subscribeReports();\n  subscribeTicketsSnapshot();\n}',
    '  if (!reportsPageIsActive()) {\n    stopReportsPageSubscriptions();\n    return;\n  }\n  await refreshReportsStaffDirectory();\n  renderTicketSnapshot();\n  renderReports();\n  subscribeReports();\n  subscribeTicketsSnapshot();\n}',
    'lazy reports page subscriptions'
  );

  source = replaceRequired(
    source,
    'window.addEventListener("telesyriana:user-changed", initReports);',
    'window.addEventListener("telesyriana:user-changed", initReports);\nwindow.addEventListener("telesyriana:employee-directory-changed", () => { if (currentUser && reportsPageIsActive()) initReports(); });',
    'reports directory change listener'
  );

  if (source.includes('const STAFF = {')) throw new Error('Reports directory validation failed: legacy STAFF remains.');
  if (!source.includes('await refreshReportsStaffDirectory()')) throw new Error('Reports directory validation failed: refresh missing.');
  if (!source.includes('function reportsPageIsActive()') || !source.includes('stopReportsPageSubscriptions()')) throw new Error('Reports quota validation failed: hidden-page subscriptions remain.');
  if (source.includes('currentUser = getCurrentUser();\n  await refreshReportsStaffDirectory();')) throw new Error('Reports quota validation failed: directory still loads before page/login need.');
  return source;
}

async function loadReports() {
  try {
    const response = await fetch(CORE_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load reports core (HTTP ${response.status}).`);
    const patchedSource = patchReports(await response.text());
    const blobUrl = URL.createObjectURL(new Blob([patchedSource], { type: 'text/javascript' }));
    try { await import(blobUrl); }
    finally { URL.revokeObjectURL(blobUrl); }
  } catch (err) {
    console.error('Central reports staff-directory bridge failed. Falling back to untouched reports core.', err);
    await import(CORE_URL.href);
  }
}

await loadReports();
