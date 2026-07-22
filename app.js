// TeleSyriana emergency production-login recovery entry.
//
// Phase 1's asynchronous source-patching loader can boot after DOMContentLoaded
// and currently throws during startup before the login handlers are usable.
// The previous production application is preserved byte-for-byte in app-core.js.
// Use it directly until the Phase 1 bootstrap is repaired and browser-tested.
//
// The read-only Employees & Accounts preview is mounted separately. It uses only
// the approved local Phase 1A identity seed, performs no Firestore operations,
// and does not change login or account-management behaviour.

import './app-core.js';
import './employees-accounts-readonly.js';
