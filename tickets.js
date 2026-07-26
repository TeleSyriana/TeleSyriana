// tickets.js — TeleSyriana live Ticket compatibility loader
//
// Preserves tickets-core.js, swaps the central staff directory, keeps Ticket
// listeners page-scoped, publishes sanitized dashboard rows, and applies the
// project/team Ticket policy before live rows reach the UI.

const CORE_URL = new URL('./tickets-core.js', import.meta.url);
const FIREBASE_URL = new URL('./firebase.js', import.meta.url).href;
const DIRECTORY_URL = new URL('./employee-directory.js', import.meta.url).href;
const POLICY_URL = new URL('./ticket-runtime-policy-adapter.js', import.meta.url).href;

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`Ticket compatibility marker missing: ${label}`);
  return source.replace(oldText, newText);
}

function replaceBetweenRequired(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Ticket compatibility start marker missing: ${label}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Ticket compatibility end marker missing: ${label}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function patchTickets(coreSource) {
  let source = String(coreSource || '');
  const imports = `import { db, fs } from ${JSON.stringify(FIREBASE_URL)};\nimport { listEmployees } from ${JSON.stringify(DIRECTORY_URL)};\nimport { runtimeAssignmentCandidates, runtimeCanOpenTickets, runtimeCanSetTicketAssignment, runtimeCanViewTicket, runtimeTicketProjectId, runtimeTicketScope } from ${JSON.stringify(POLICY_URL)};`;
  source = replaceRequired(source, 'import { db, fs } from "./firebase.js";', imports, 'runtime imports');

  const staffReplacement = `let STAFF = {};\n\nasync function refreshTicketStaffDirectory() {\n  const rows = await listEmployees({ includeDisabled: true, includeArchived: true });\n  STAFF = Object.fromEntries(rows.map((row) => [String(row.id), row]));\n}\n\n`;
  source = replaceBetweenRequired(source, 'const STAFF = {\n', 'const EMERGENCY_TYPES = new Set([', staffReplacement, 'hard-coded ticket STAFF map');

  source = replaceRequired(
    source,
    'function canSeeAll(u) { return roleLevel(u) >= ROLE_LEVELS.manager; }',
    'function canSeeAll(u) { return ["admin", "manager"].includes(String(u?.role || "").toLowerCase()); }',
    'HR cannot see all tickets'
  );
  source = replaceRequired(
    source,
    'function canSupervise(u) { return roleLevel(u) >= ROLE_LEVELS.supervisor; }',
    'function canSupervise(u) { return ["admin", "manager", "supervisor"].includes(String(u?.role || "").toLowerCase()); }',
    'HR cannot supervise tickets'
  );
  source = replaceRequired(
    source,
    'function canEditAll(u) { return roleLevel(u) >= ROLE_LEVELS.supervisor; }',
    'function canEditAll(u) { return ["admin", "manager", "supervisor"].includes(String(u?.role || "").toLowerCase()); }',
    'HR cannot edit ticket fields'
  );

  const oldAssignmentScope = `function visibleStaffForAssignment() {\n  if (!currentUser) return [];\n  if (canSeeAll(currentUser)) return Object.values(STAFF);\n  if (currentUser.role === "supervisor") {\n    return Object.values(STAFF).filter((s) => s.id === currentUser.id || s.supervisorId === currentUser.id);\n  }\n  return [currentUser];\n}`;
  const newAssignmentScope = `function visibleStaffForAssignment() {\n  if (!currentUser) return [];\n  const selectedTicket = selectedTicketId ? allTickets.find((ticket) => ticket.id === selectedTicketId) : null;\n  const allowed = runtimeAssignmentCandidates(currentUser, Object.values(STAFF), selectedTicket);\n  return allowed.map((employee) => STAFF[employee.ccmsId]).filter(Boolean);\n}`;
  source = replaceRequired(source, oldAssignmentScope, newAssignmentScope, 'project-aware assignment staff scope');

  const oldVisibility = `function canViewTicketBase(ticket) {\n  if (!currentUser) return false;\n  if (canSeeAll(currentUser)) return true;\n  if (currentUser.role === "supervisor") {\n    if (ticket.assignedTo === currentUser.id || ticket.createdBy === currentUser.id) return true;\n    const assigned = STAFF[ticket.assignedTo];\n    return assigned?.supervisorId === currentUser.id || !ticket.assignedTo;\n  }\n  return ticket.assignedTo === currentUser.id || ticket.createdBy === currentUser.id;\n}\nfunction canViewTicket(ticket) {\n  if (canViewTicketBase(ticket)) return true;\n  const q = currentTicketSearchTerm();\n  // Agents keep a clean queue, but search can find an existing ticket by order/customer/email/notes.\n  return Boolean(q && q.length >= 2 && ticketSearchText(ticket).includes(q));\n}\nfunction isTicketGlobalSearchActive() {\n  const q = currentTicketSearchTerm();\n  return Boolean(currentUser && !canSeeAll(currentUser) && q && q.length >= 2);\n}\nfunction isTicketGlobalSearchHit(ticket) {\n  const q = currentTicketSearchTerm();\n  return Boolean(isTicketGlobalSearchActive() && !canViewTicketBase(ticket) && ticketSearchText(ticket).includes(q));\n}`;
  const newVisibility = `function canViewTicketBase(ticket) {\n  return Boolean(currentUser && runtimeCanViewTicket(currentUser, ticket, Object.values(STAFF)));\n}\nfunction canViewTicket(ticket) {\n  return canViewTicketBase(ticket);\n}\nfunction isTicketGlobalSearchActive() { return false; }\nfunction isTicketGlobalSearchHit() { return false; }`;
  source = replaceRequired(source, oldVisibility, newVisibility, 'project/team Ticket visibility');

  const oldListenScope = `function ticketListenSourcesForUser(user) {\n  const base = collection(db, TICKETS_COL);\n  if (!user) return [];\n  const role = String(user.role || '').toLowerCase();\n\n  // Managers/admins keep the full operational queue. Agents get only their scoped tickets.\n  // This is the important performance fix for staff devices.\n  if (canSeeAll(user) || role === 'supervisor') return [{ key: 'team', source: base }];\n\n  return [\n    { key: 'assigned', source: query(base, where('assignedTo', '==', user.id)) },\n    { key: 'created', source: query(base, where('createdBy', '==', user.id)) },\n  ];\n}`;
  const newListenScope = `function ticketListenSourcesForUser(user) {\n  const base = collection(db, TICKETS_COL);\n  if (!user) return [];\n  const scope = runtimeTicketScope(user, Object.values(STAFF));\n  if (scope.mode === "none") return [];\n  if (scope.mode === "global") return [{ key: "global", source: base }];\n  if (scope.mode === "project") {\n    // Existing TeleSyriana tickets predate projectId and are compatibility-iPro.\n    // Keep the single-project iPro collection readable for ACM while the runtime\n    // policy filters every row. New non-iPro projects use an indexed project query.\n    if (scope.projectId === "ipro") return [{ key: "project-ipro-compat", source: base }];\n    return [{ key: `project-${scope.projectId}`, source: query(base, where("projectId", "==", scope.projectId)) }];\n  }\n\n  const ids = [...new Set((scope.assignmentIds || []).map(String).filter(Boolean))];\n  const chunks = [];\n  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));\n  return chunks.map((chunk, index) => ({\n    key: `assignments-${index}`,\n    source: chunk.length === 1\n      ? query(base, where("assignedTo", "==", chunk[0]))\n      : query(base, where("assignedTo", "in", chunk)),\n  }));\n}`;
  source = replaceRequired(source, oldListenScope, newListenScope, 'project/team Firestore listener scope');

  source = replaceRequired(
    source,
    `function shouldUseTeamSearchIndex() {\n  return Boolean(currentUser && !canSeeAll(currentUser));\n}`,
    `function shouldUseTeamSearchIndex() {\n  // Phase 5 search is intentionally limited to the actor's already-authorized\n  // listener scope. Never download the full Tickets collection for staff search.\n  return false;\n}`,
    'disable full-collection staff search index'
  );

  source = replaceRequired(
    source,
    `function canManageTicketFields(ticket) {\n  if (!currentUser || !ticket) return false;\n  return canEditAll(currentUser) || ticket.assignedTo === currentUser.id || ticket.createdBy === currentUser.id;\n}`,
    `function canManageTicketFields(ticket) {\n  return Boolean(currentUser && ticket && runtimeCanViewTicket(currentUser, ticket, Object.values(STAFF)));\n}`,
    'project-aware Ticket field management'
  );

  source = replaceRequired(
    source,
    `  const matches = allTickets\n    .filter((x) => x.id !== ticket.id)`,
    `  const matches = allTickets\n    .filter(canViewTicketBase)\n    .filter((x) => x.id !== ticket.id)`,
    'customer history permission filter'
  );

  source = replaceRequired(
    source,
    `    if (!snap.empty) {\n      const d = snap.docs[0];\n      return { id: d.id, ...d.data() };\n    }`,
    `    if (!snap.empty) {\n      const match = snap.docs\n        .map((d) => ({ id: d.id, ...d.data() }))\n        .find((row) => runtimeCanViewTicket(currentUser, row, Object.values(STAFF)));\n      return match || null;\n    }`,
    'active duplicate visibility'
  );

  // Apply the same guard to the deleted duplicate lookup; the source contains the
  // same small block a second time after the active-duplicate function.
  source = replaceRequired(
    source,
    `    if (!snap.empty) {\n      const d = snap.docs[0];\n      return { id: d.id, ...d.data() };\n    }`,
    `    if (!snap.empty) {\n      const match = snap.docs\n        .map((d) => ({ id: d.id, ...d.data() }))\n        .find((row) => runtimeCanViewTicket(currentUser, row, Object.values(STAFF)));\n      return match || null;\n    }`,
    'deleted duplicate visibility'
  );

  source = replaceRequired(
    source,
    `  const rows = deletedTickets.slice().sort((a,b) => tsToMs(b.deletedAt || b.updatedAt) - tsToMs(a.deletedAt || a.updatedAt));`,
    `  const rows = deletedTickets.filter(canViewTicketBase).slice().sort((a,b) => tsToMs(b.deletedAt || b.updatedAt) - tsToMs(a.deletedAt || a.updatedAt));`,
    'deleted Ticket render scope'
  );

  const oldDeletedSubscription = `function subscribeDeletedTickets() {\n  if (unsubDeletedTickets) unsubDeletedTickets();\n  if (!canAccessDeletedTickets(currentUser)) {\n    deletedTickets = [];\n    renderDeletedTicketsList();\n    return;\n  }\n  const q = query(collection(db, DELETED_TICKETS_COL), orderBy("deletedAt", "desc"));\n  unsubDeletedTickets = onSnapshot(q, (snapshot) => {\n    deletedTickets = [];\n    snapshot.forEach((d) => deletedTickets.push({ id: d.id, ...d.data() }));\n    renderDeletedTicketsList();\n  }, (err) => {\n    console.error("deleted tickets snapshot error", err);\n    showTicketAlert(tt("تعذر تحميل المحذوفات. تحقق من صلاحيات Firestore.", "Could not load deleted tickets. Check Firestore permissions."), true);\n  });\n}`;
  const newDeletedSubscription = `function subscribeDeletedTickets() {\n  if (unsubDeletedTickets) { try { unsubDeletedTickets(); } catch {} }\n  unsubDeletedTickets = null;\n  if (!canAccessDeletedTickets(currentUser) || !runtimeCanOpenTickets(currentUser, Object.values(STAFF))) {\n    deletedTickets = [];\n    renderDeletedTicketsList();\n    return;\n  }\n\n  const base = collection(db, DELETED_TICKETS_COL);\n  const scope = runtimeTicketScope(currentUser, Object.values(STAFF));\n  let sources = [];\n  if (scope.mode === "global") {\n    sources = [{ key: "global", source: query(base, orderBy("deletedAt", "desc")) }];\n  } else if (scope.mode === "project") {\n    sources = scope.projectId === "ipro"\n      ? [{ key: "project-ipro-compat", source: query(base, orderBy("deletedAt", "desc")) }]\n      : [{ key: `project-${scope.projectId}`, source: query(base, where("projectId", "==", scope.projectId)) }];\n  } else if (scope.mode === "assignments") {\n    const ids = [...new Set((scope.assignmentIds || []).map(String).filter(Boolean))];\n    const chunks = [];\n    for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));\n    sources = chunks.map((chunk, index) => ({\n      key: `assignments-${index}`,\n      source: chunk.length === 1\n        ? query(base, where("assignedTo", "==", chunk[0]))\n        : query(base, where("assignedTo", "in", chunk)),\n    }));\n  }\n\n  if (!sources.length) {\n    deletedTickets = [];\n    renderDeletedTicketsList();\n    return;\n  }\n\n  const maps = new Map();\n  const unsubs = sources.map(({ key, source: listenSource }) => onSnapshot(listenSource, (snapshot) => {\n    const map = new Map();\n    snapshot.forEach((d) => {\n      const row = { id: d.id, ...d.data() };\n      if (runtimeCanViewTicket(currentUser, row, Object.values(STAFF))) map.set(row.id, row);\n    });\n    maps.set(key, map);\n    const merged = new Map();\n    maps.forEach((part) => part.forEach((row, id) => merged.set(id, row)));\n    deletedTickets = [...merged.values()].sort((a,b) => tsToMs(b.deletedAt || b.updatedAt) - tsToMs(a.deletedAt || a.updatedAt));\n    renderDeletedTicketsList();\n  }, (err) => {\n    console.error("deleted tickets snapshot error", err);\n    showTicketAlert(tt("تعذر تحميل المحذوفات. تحقق من صلاحيات Firestore.", "Could not load deleted tickets. Check Firestore permissions."), true);\n  }));\n\n  unsubDeletedTickets = () => unsubs.forEach((fn) => { try { fn(); } catch {} });\n}`;
  source = replaceRequired(source, oldDeletedSubscription, newDeletedSubscription, 'deleted Ticket listener scope');

  source = replaceRequired(
    source,
    `  const payload = {\n    orderNumber,`,
    `  const payload = {\n    projectId: runtimeTicketProjectId(currentUser, Object.values(STAFF)),\n    orderNumber,`,
    'new Ticket projectId'
  );

  source = replaceRequired(
    source,
    `  const resolution = el("ticket-detail-resolution")?.value || "";\n  const update = {`,
    `  const resolution = el("ticket-detail-resolution")?.value || "";\n  if (!runtimeCanSetTicketAssignment(currentUser, t, assignedTo, Object.values(STAFF))) {\n    showTicketAlert(tt("لا يمكنك تعيين هذه التذكرة لهذا الموظف.", "You cannot assign this ticket to that employee."), true);\n    restoreSaveBtn();\n    return;\n  }\n  const update = {`,
    'assignment validation before save'
  );

  const ticketLifecycleHelpers = `function ticketPageIsActive() {\n  const page = el("page-tickets");\n  return Boolean(page && !page.classList.contains("hidden"));\n}\n\nfunction syncTicketNavAccess() {\n  const allowed = Boolean(currentUser && runtimeCanOpenTickets(currentUser, Object.values(STAFF)));\n  const nav = document.querySelector('.nav-link[data-page="tickets"]');\n  if (nav) nav.classList.toggle("hidden", !allowed);\n  return allowed;\n}\n\nfunction stopTicketPageSubscriptions() {\n  if (unsubTickets) { try { unsubTickets(); } catch {} }\n  unsubTickets = null;\n  if (unsubDeletedTickets) { try { unsubDeletedTickets(); } catch {} }\n  unsubDeletedTickets = null;\n  deletedTickets = [];\n  clearTicketSlowTimer();\n}\n\nfunction bindTicketPageLifecycle() {\n  if (window.__TS_TICKET_PAGE_LIFECYCLE__) return;\n  window.__TS_TICKET_PAGE_LIFECYCLE__ = true;\n  document.addEventListener("click", (event) => {\n    const nav = event.target?.closest?.(".nav-link[data-page]");\n    if (!nav) return;\n    if (nav.dataset.page === "tickets") setTimeout(() => initTickets(), 0);\n    else stopTicketPageSubscriptions();\n  });\n}\n\n`;
  source = replaceRequired(source, 'function initTickets() {\n  currentUser = getCurrentUser();', `${ticketLifecycleHelpers}async function initTickets() {\n  currentUser = getCurrentUser();\n  bindTicketPageLifecycle();\n  syncTicketNavAccess();`, 'ticket init lifecycle');

  const dashboardBridge = `function safeTicketDashboardRows() {\n  return allTickets.filter(canViewTicketBase).map((ticket) => ({\n    id: String(ticket.id || ""),\n    projectId: String(ticket.projectId || ticket.project || "ipro"),\n    status: String(ticket.status || "open"),\n    priority: String(ticket.priority || "normal"),\n    assignedTo: String(ticket.assignedTo || ticket.assignedCcmsId || ticket.assignedEmployeeId || ""),\n    assignedEmployeeUid: String(ticket.assignedEmployeeUid || ticket.assignedUid || ""),\n    createdBy: String(ticket.createdBy || ""),\n    createdAt: tsToMs(ticket.createdAt) || 0,\n    updatedAt: tsToMs(ticket.updatedAt) || tsToMs(ticket.resolvedAt) || tsToMs(ticket.createdAt) || 0,\n    resolvedAt: tsToMs(ticket.resolvedAt) || 0,\n    dueAt: tsToMs(ticket.dueAt || ticket.slaDueAt) || 0,\n  }));\n}\n\nfunction publishTicketDashboardSnapshot() {\n  const rows = safeTicketDashboardRows();\n  window.__TS_TICKET_DASHBOARD_SNAPSHOT__ = () => rows.map((row) => ({ ...row }));\n  try {\n    window.dispatchEvent(new CustomEvent("telesyriana:ticket-dashboard-snapshot", { detail: { rows: rows.map((row) => ({ ...row })) } }));\n  } catch {}\n}\n\n`;
  source = replaceRequired(source, 'function ticketPageIsActive() {', `${dashboardBridge}function ticketPageIsActive() {`, 'ticket dashboard snapshot bridge');

  source = replaceRequired(
    source,
    '  ticketTeamSearchMap = new Map();\n  teamSearchIndexLoaded = false;',
    '  ticketTeamSearchMap = new Map();\n  teamSearchIndexLoaded = false;',
    'ticket snapshot stable marker'
  );
  source = replaceRequired(
    source,
    '  mergeTicketMaps();\n\n  const sources = ticketListenSourcesForUser(currentUser);',
    '  mergeTicketMaps();\n  publishTicketDashboardSnapshot();\n\n  const sources = ticketListenSourcesForUser(currentUser);',
    'publish initial ticket dashboard snapshot'
  );
  source = replaceRequired(
    source,
    '    mergeTicketMaps();\n    if (selectedTicketId && !allTickets.some((t) => t.id === selectedTicketId)) selectedTicketId = null;',
    '    mergeTicketMaps();\n    publishTicketDashboardSnapshot();\n    if (selectedTicketId && !allTickets.some((t) => t.id === selectedTicketId)) selectedTicketId = null;',
    'publish live ticket dashboard snapshot'
  );

  source = replaceRequired(
    source,
    '  ensureDeletedTicketsUI();\n  subscribeTickets();\n  subscribeDeletedTickets();\n}',
    '  ensureDeletedTicketsUI();\n  if (!ticketPageIsActive()) {\n    stopTicketPageSubscriptions();\n    return;\n  }\n  await refreshTicketStaffDirectory();\n  if (!syncTicketNavAccess()) {\n    stopTicketPageSubscriptions();\n    setTicketsInlineLoading(false);\n    showTicketAlert(tt("لا تملك صلاحية تشغيل التذاكر لهذا الحساب.", "This account does not have operational Ticket access."), true);\n    renderTicketList();\n    renderTicketDetail();\n    return;\n  }\n  fillAssigneeSelect(el("ticket-assigned"), true);\n  fillAssigneeSelect(el("ticket-detail-assigned"), true);\n  subscribeTickets();\n}',
    'lazy project-aware ticket subscriptions'
  );

  source = replaceRequired(
    source,
    `function openDeletedTicketsFolder() {\n  if (!canAccessDeletedTickets(currentUser)) return showTicketAlert(tt('المحذوفات متاحة فقط للمشرف أو المدير أو الأدمن.', 'Deleted tickets are only available to supervisor, manager, or admin.'), true);\n  ensureDeletedTicketsUI();\n  renderDeletedTicketsList();\n  el('deleted-tickets-modal')?.classList.remove('hidden');\n}\nfunction closeDeletedTicketsFolder() { el('deleted-tickets-modal')?.classList.add('hidden'); }`,
    `function openDeletedTicketsFolder() {\n  if (!canAccessDeletedTickets(currentUser)) return showTicketAlert(tt('المحذوفات متاحة فقط للمشرف أو المدير أو الأدمن.', 'Deleted tickets are only available to supervisor, manager, or admin.'), true);\n  ensureDeletedTicketsUI();\n  subscribeDeletedTickets();\n  renderDeletedTicketsList();\n  el('deleted-tickets-modal')?.classList.remove('hidden');\n}\nfunction closeDeletedTicketsFolder() {\n  el('deleted-tickets-modal')?.classList.add('hidden');\n  if (unsubDeletedTickets) { try { unsubDeletedTickets(); } catch {} }\n  unsubDeletedTickets = null;\n  deletedTickets = [];\n}`,
    'on-demand deleted tickets subscription'
  );

  source = replaceRequired(
    source,
    'document.addEventListener("DOMContentLoaded", initTickets);',
    'if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initTickets);\nelse initTickets();',
    'ticket ready-state boot'
  );
  source = replaceRequired(
    source,
    'window.addEventListener("telesyriana:user-changed", initTickets);',
    'window.addEventListener("telesyriana:user-changed", initTickets);\nwindow.addEventListener("telesyriana:employee-directory-changed", () => { if (currentUser && ticketPageIsActive()) initTickets(); });',
    'ticket directory change listener'
  );

  if (source.includes('const STAFF = {')) throw new Error('Ticket directory validation failed: legacy STAFF remains.');
  if (!source.includes('await refreshTicketStaffDirectory()')) throw new Error('Ticket directory validation failed: refresh missing.');
  if (!source.includes('runtimeCanViewTicket(currentUser, ticket, Object.values(STAFF))')) throw new Error('Ticket policy validation failed: live visibility adapter missing.');
  if (!source.includes('runtimeTicketScope(user, Object.values(STAFF))')) throw new Error('Ticket policy validation failed: listener scope missing.');
  if (!source.includes('return false;\n}')) throw new Error('Ticket search validation failed: scoped index guard missing.');
  if (!source.includes('projectId: runtimeTicketProjectId(currentUser, Object.values(STAFF))')) throw new Error('Ticket project validation failed: new tickets are not project tagged.');
  if (!source.includes('runtimeCanSetTicketAssignment(currentUser, t, assignedTo, Object.values(STAFF))')) throw new Error('Ticket assignment validation failed.');
  if (!source.includes('function ticketPageIsActive()') || !source.includes('stopTicketPageSubscriptions()')) throw new Error('Ticket quota validation failed: hidden-page subscriptions remain.');
  if (!source.includes('subscribeDeletedTickets();\n  renderDeletedTicketsList();')) throw new Error('Ticket quota validation failed: deleted tickets are not on-demand.');
  if (source.includes('currentUser = getCurrentUser();\n  await refreshTicketStaffDirectory();')) throw new Error('Ticket quota validation failed: directory still loads before page/login need.');
  if (!source.includes('document.readyState === "loading"')) throw new Error('Ticket boot validation failed: ready-state boot missing.');
  if (!source.includes('window.__TS_TICKET_DASHBOARD_SNAPSHOT__')) throw new Error('Ticket dashboard bridge validation failed: snapshot getter missing.');
  if (!source.includes('telesyriana:ticket-dashboard-snapshot')) throw new Error('Ticket dashboard bridge validation failed: event missing.');
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
