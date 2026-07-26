// TeleSyriana emergency production-login recovery entry.
//
// Phase 1's asynchronous source-patching loader can boot after DOMContentLoaded
// and currently throws during startup before the login handlers are usable.
// The previous production application is preserved byte-for-byte in app-core.js.
// Use it directly until the Phase 1 bootstrap is repaired and browser-tested.
//
// The Monday auth compatibility bridge must load before app-core.js so the stable
// legacy login engine can recognise effective CCMS 2002 and new Agent 9004 without
// changing the proven startup core. Remaining modules mount after the stable core.

import './monday-auth-compat.js';
import './app-core.js';
import './employees-accounts-readonly.js';
import './phase2-projects-teams.js';
import './phase2-ticket-dashboard-live.js';
import './phase3-team-status-live.js';
import './phase4a-inactivity-watch.js';
import './phase4b-activity-telemetry.js';
import './phase5-ticket-quick-filters.js';
import './monday-org-transition-runtime.js';
