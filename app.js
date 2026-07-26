// TeleSyriana emergency production-login recovery entry.
//
// Phase 1's asynchronous source-patching loader can boot after DOMContentLoaded
// and currently throws during startup before the login handlers are usable.
// The previous production application is preserved byte-for-byte in app-core.js.
// Use it directly until the Phase 1 bootstrap is repaired and browser-tested.
//
// The read-only Employees & Accounts preview and Phase 2 Projects & Teams surface
// are mounted separately. Ticket dashboard metrics reuse the existing Tickets
// engine snapshot. Phase 3 reuses today's existing agentDays data only while the
// Projects & Teams page is visible.

import './app-core.js';
import './employees-accounts-readonly.js';
import './phase2-projects-teams.js';
import './phase2-ticket-dashboard-live.js';
import './phase3-team-status-live.js';
