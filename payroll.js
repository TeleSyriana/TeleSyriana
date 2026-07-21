// payroll.js — TeleSyriana Phase 1 employee-directory migration loader
// Preserves the payroll engine in payroll-core.js, replaces its staff source,
// and avoids historical payroll listeners while the Payroll page is hidden.

const CORE_URL = new URL('./payroll-core.js', import.meta.url);
const FIREBASE_URL = new URL('./firebase.js', import.meta.url).href;
const DIRECTORY_URL = new URL('./employee-directory.js', import.meta.url).href;

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`Payroll directory marker missing: ${label}`);
  return source.replace(oldText, newText);
}

function replaceBetweenRequired(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Payroll directory start marker missing: ${label}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Payroll directory end marker missing: ${label}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function patchPayroll(coreSource) {
  let source = String(coreSource || '');
  const imports = `import { db, fs } from ${JSON.stringify(FIREBASE_URL)};\nimport { listEmployees } from ${JSON.stringify(DIRECTORY_URL)};`;
  source = replaceRequired(source, 'import { db, fs } from "./firebase.js";', imports, 'firebase import');

  const staffReplacement = `let STAFF = {};\n\nasync function refreshPayrollStaffDirectory() {\n  // Keep inactive employees for historical payroll/reporting labels.\n  const rows = await listEmployees({ includeDisabled: true, includeArchived: true });\n  STAFF = Object.fromEntries(rows.map((row) => [String(row.id), row]));\n}\n\n`;
  source = replaceBetweenRequired(
    source,
    'const STAFF = {\n',
    'let currentUser = null;',
    staffReplacement,
    'hard-coded payroll STAFF map'
  );

  source = replaceRequired(
    source,
    '  return ["admin", "manager", "supervisor"].includes(role);',
    '  return ["admin", "manager", "hr"].includes(role);',
    'payroll management visibility'
  );

  source = replaceRequired(
    source,
    '    const editableIds = canSeeAll(currentUser) ? Object.keys(STAFF) : visibleIds;',
    '    const editableIds = (canSeeAll(currentUser) ? Object.keys(STAFF) : visibleIds)\n      .filter((id) => String(STAFF[id]?.accountStatus || "active") === "active");',
    'active payroll settings targets'
  );

  const payrollLifecycleHelpers = `function payrollPageIsActive() {\n  const page = el("page-payroll");\n  return Boolean(page && !page.classList.contains("hidden"));\n}\n\nfunction stopPayrollPageSubscriptions() {\n  if (unsubDays) { try { unsubDays(); } catch {} }\n  if (unsubSettings) { try { unsubSettings(); } catch {} }\n  unsubDays = null;\n  unsubSettings = null;\n}\n\nfunction bindPayrollPageLifecycle() {\n  if (window.__TS_PAYROLL_PAGE_LIFECYCLE__) return;\n  window.__TS_PAYROLL_PAGE_LIFECYCLE__ = true;\n  document.addEventListener("click", (event) => {\n    const nav = event.target?.closest?.(".nav-link[data-page]");\n    if (!nav) return;\n    if (nav.dataset.page === "payroll") {\n      setTimeout(() => refreshPayrollForCurrentDirectory({ resetRange: false }), 0);\n    } else {\n      stopPayrollPageSubscriptions();\n    }\n  });\n}\n\n`;

  source = replaceRequired(
    source,
    'function init() {\n  translatePayrollStatic();\n  currentUser = getCurrentUser();',
    `${payrollLifecycleHelpers}async function init() {\n  translatePayrollStatic();\n  currentUser = getCurrentUser();\n  bindPayrollPageLifecycle();\n  if (currentUser && payrollPageIsActive()) await refreshPayrollStaffDirectory();`,
    'payroll init lifecycle'
  );

  source = replaceRequired(
    source,
    '  if (currentUser) subscribePayroll();\n}',
    '  if (currentUser && payrollPageIsActive()) subscribePayroll();\n  else stopPayrollPageSubscriptions();\n}',
    'lazy initial payroll subscriptions'
  );

  const oldUserChanged = `window.addEventListener("telesyriana:user-changed", () => {\n  currentUser = getCurrentUser();\n  populateStaffFilters();\n  setThisWeekFilters();\n  setPermissionsUI();\n  renderPayroll();\n  if (currentUser) subscribePayroll();\n});`;
  const newUserChanged = `async function refreshPayrollForCurrentDirectory({ resetRange = false } = {}) {\n  currentUser = getCurrentUser();\n  if (resetRange) setThisWeekFilters();\n\n  if (!currentUser || !payrollPageIsActive()) {\n    stopPayrollPageSubscriptions();\n    setPermissionsUI();\n    renderPayroll();\n    return;\n  }\n\n  await refreshPayrollStaffDirectory();\n  populateStaffFilters();\n  setPermissionsUI();\n  renderPayroll();\n  subscribePayroll();\n}\n\nwindow.addEventListener("telesyriana:user-changed", () => refreshPayrollForCurrentDirectory({ resetRange: true }));\nwindow.addEventListener("telesyriana:employee-directory-changed", () => refreshPayrollForCurrentDirectory({ resetRange: false }));`;
  source = replaceRequired(source, oldUserChanged, newUserChanged, 'payroll user/directory refresh');

  if (source.includes('const STAFF = {')) throw new Error('Payroll directory validation failed: legacy STAFF remains.');
  if (!source.includes('await refreshPayrollStaffDirectory()')) throw new Error('Payroll directory validation failed: refresh missing.');
  if (source.includes('["admin", "manager", "supervisor"].includes(role)')) throw new Error('Payroll visibility validation failed.');
  if (!source.includes('.filter((id) => String(STAFF[id]?.accountStatus || "active") === "active")')) throw new Error('Payroll directory validation failed: inactive settings targets remain.');
  if (!source.includes('function payrollPageIsActive()') || !source.includes('stopPayrollPageSubscriptions()')) throw new Error('Payroll quota validation failed: hidden-page subscriptions remain.');
  if (source.includes('currentUser = getCurrentUser();\n  await refreshPayrollStaffDirectory();')) throw new Error('Payroll quota validation failed: directory still loads before page/login need.');
  return source;
}

async function loadPayroll() {
  try {
    const response = await fetch(CORE_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load payroll core (HTTP ${response.status}).`);
    const patchedSource = patchPayroll(await response.text());
    const blobUrl = URL.createObjectURL(new Blob([patchedSource], { type: 'text/javascript' }));
    try { await import(blobUrl); }
    finally { URL.revokeObjectURL(blobUrl); }
  } catch (err) {
    console.error('Central payroll staff-directory bridge failed. Falling back to untouched payroll core.', err);
    await import(CORE_URL.href);
  }
}

await loadPayroll();
