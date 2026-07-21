// tickets.js — TeleSyriana Phase 1 staff-directory migration loader
// Preserves the current ticket engine byte-for-byte in tickets-core.js, swaps
// the staff directory, and avoids Firestore subscriptions while Tickets is hidden.

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

  const ticketLifecycleHelpers = `function ticketPageIsActive() {\n  const page = el("page-tickets");\n  return Boolean(page && !page.classList.contains("hidden"));\n}\n\nfunction stopTicketPageSubscriptions() {\n  if (unsubTickets) { try { unsubTickets(); } catch {} }\n  unsubTickets = null;\n  if (unsubDeletedTickets) { try { unsubDeletedTickets(); } catch {} }\n  unsubDeletedTickets = null;\n  deletedTickets = [];\n  clearTicketSlowTimer();\n}\n\nfunction bindTicketPageLifecycle() {\n  if (window.__TS_TICKET_PAGE_LIFECYCLE__) return;\n  window.__TS_TICKET_PAGE_LIFECYCLE__ = true;\n  document.addEventListener("click", (event) => {\n    const nav = event.target?.closest?.(".nav-link[data-page]");\n    if (!nav) return;\n    if (nav.dataset.page === "tickets") setTimeout(() => initTickets(), 0);\n    else stopTicketPageSubscriptions();\n  });\n}\n\n`;

  source = replaceRequired(
    source,
    'function initTickets() {\n  currentUser = getCurrentUser();',
    `${ticketLifecycleHelpers}async function initTickets() {\n  currentUser = getCurrentUser();\n  await refreshTicketStaffDirectory();\n  bindTicketPageLifecycle();`,
    'ticket init directory/lifecycle refresh'
  );

  source = replaceRequired(
    source,
    '  ensureDeletedTicketsUI();\n  subscribeTickets();\n  subscribeDeletedTickets();\n}',
    '  ensureDeletedTicketsUI();\n  if (!ticketPageIsActive()) {\n    stopTicketPageSubscriptions();\n    return;\n  }\n  subscribeTickets();\n}',
    'lazy ticket page subscriptions'
  );

  source = replaceRequired(
    source,
    `function openDeletedTicketsFolder() {\n  if (!canAccessDeletedTickets(currentUser)) return showTicketAlert(tt('المحذوفات متاحة فقط للمشرف أو المدير أو الأدمن.', 'Deleted tickets are only available to supervisor, manager, or admin.'), true);\n  ensureDeletedTicketsUI();\n  renderDeletedTicketsList();\n  el('deleted-tickets-modal')?.classList.remove('hidden');\n}\nfunction closeDeletedTicketsFolder() { el('deleted-tickets-modal')?.classList.add('hidden'); }`,
    `function openDeletedTicketsFolder() {\n  if (!canAccessDeletedTickets(currentUser)) return showTicketAlert(tt('المحذوفات متاحة فقط للمشرف أو المدير أو الأدمن.', 'Deleted tickets are only available to supervisor, manager, or admin.'), true);\n  ensureDeletedTicketsUI();\n  subscribeDeletedTickets();\n  renderDeletedTicketsList();\n  el('deleted-tickets-modal')?.classList.remove('hidden');\n}\nfunction closeDeletedTicketsFolder() {\n  el('deleted-tickets-modal')?.classList.add('hidden');\n  if (unsubDeletedTickets) { try { unsubDeletedTickets(); } catch {} }\n  unsubDeletedTickets = null;\n  deletedTickets = [];\n}`,
    'on-demand deleted tickets subscription'
  );

  source = replaceRequired(
    source,
    'window.addEventListener("telesyriana:user-changed", initTickets);',
    'window.addEventListener("telesyriana:user-changed", initTickets);\nwindow.addEventListener("telesyriana:employee-directory-changed", initTickets);',
    'ticket directory change listener'
  );

  if (source.includes('const STAFF = {')) throw new Error('Ticket directory validation failed: legacy STAFF remains.');
  if (!source.includes('await refreshTicketStaffDirectory()')) throw new Error('Ticket directory validation failed: refresh missing.');
  if (!source.includes('const activeStaff = Object.values(STAFF).filter')) throw new Error('Ticket directory validation failed: active assignment filter missing.');
  if (!source.includes('function ticketPageIsActive()') || !source.includes('stopTicketPageSubscriptions()')) throw new Error('Ticket quota validation failed: hidden-page subscriptions remain.');
  if (!source.includes('subscribeDeletedTickets();\n  renderDeletedTicketsList();')) throw new Error('Ticket quota validation failed: deleted tickets are not on-demand.');
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
