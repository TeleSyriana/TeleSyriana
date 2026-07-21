// tickets.js — TeleSyriana Phase 1 staff-directory migration loader
// Preserves the current ticket engine byte-for-byte in tickets-core.js and
// replaces only its duplicated STAFF directory with the central employee list.

const CORE_URL = new URL('./tickets-core.js', import.meta.url);
const FIREBASE_URL = new URL('./firebase.js', import.meta.url).href;
const DIRECTORY_URL = new URL('./employee-directory.js', import.meta.url).href;

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`Ticket directory marker missing: ${label}`);
  return source.replace(oldText, newText);
}

function replaceBetweenRequired(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Ticket directory start marker missing: ${label}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Ticket directory end marker missing: ${label}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function patchTickets(coreSource) {
  let source = String(coreSource || '');
  const imports = `import { db, fs } from ${JSON.stringify(FIREBASE_URL)};\nimport { listEmployees } from ${JSON.stringify(DIRECTORY_URL)};`;
  source = replaceRequired(source, 'import { db, fs } from "./firebase.js";', imports, 'firebase import');

  const staffReplacement = `let STAFF = {};\n\nasync function refreshTicketStaffDirectory() {\n  // Keep disabled/archived employees in the lookup cache so historical tickets,\n  // comments and ownership continue showing the correct employee name.\n  const rows = await listEmployees({ includeDisabled: true, includeArchived: true });\n  STAFF = Object.fromEntries(rows.map((row) => [String(row.id), row]));\n}\n\n`;

  source = replaceBetweenRequired(
    source,
    'const STAFF = {\n',
    'const EMERGENCY_TYPES = new Set([',
    staffReplacement,
    'hard-coded ticket STAFF map'
  );

  const oldAssignmentScope = `function visibleStaffForAssignment() {\n  if (!currentUser) return [];\n  if (canSeeAll(currentUser)) return Object.values(STAFF);\n  if (currentUser.role === "supervisor") {\n    return Object.values(STAFF).filter((s) => s.id === currentUser.id || s.supervisorId === currentUser.id);\n  }\n  return [currentUser];\n}`;
  const newAssignmentScope = `function visibleStaffForAssignment() {\n  if (!currentUser) return [];\n  const activeStaff = Object.values(STAFF).filter((s) => String(s.accountStatus || "active") === "active");\n  if (canSeeAll(currentUser)) return activeStaff;\n  if (currentUser.role === "supervisor") {\n    return activeStaff.filter((s) => s.id === currentUser.id || s.supervisorId === currentUser.id);\n  }\n  return activeStaff.filter((s) => s.id === currentUser.id);\n}`;
  source = replaceRequired(source, oldAssignmentScope, newAssignmentScope, 'active assignment staff scope');

  source = replaceRequired(source, 'function initTickets() {\n  currentUser = getCurrentUser();', 'async function initTickets() {\n  currentUser = getCurrentUser();\n  await refreshTicketStaffDirectory();', 'ticket init directory refresh');

  source = replaceRequired(
    source,
    'window.addEventListener("telesyriana:user-changed", initTickets);',
    'window.addEventListener("telesyriana:user-changed", initTickets);\nwindow.addEventListener("telesyriana:employee-directory-changed", initTickets);',
    'ticket directory change listener'
  );

  if (source.includes('const STAFF = {')) throw new Error('Ticket directory validation failed: legacy STAFF remains.');
  if (!source.includes('await refreshTicketStaffDirectory()')) throw new Error('Ticket directory validation failed: refresh missing.');
  if (!source.includes('const activeStaff = Object.values(STAFF).filter')) throw new Error('Ticket directory validation failed: active assignment filter missing.');
  return source;
}

async function loadTickets() {
  try {
    const response = await fetch(CORE_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load ticket core (HTTP ${response.status}).`);
    const patchedSource = patchTickets(await response.text());
    const blobUrl = URL.createObjectURL(new Blob([patchedSource], { type: 'text/javascript' }));
    try { await import(blobUrl); }
    finally { URL.revokeObjectURL(blobUrl); }
  } catch (err) {
    console.error('Central ticket staff-directory bridge failed. Falling back to untouched ticket core.', err);
    await import(CORE_URL.href);
  }
}

await loadTickets();
