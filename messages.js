// TeleSyriana emergency runtime recovery entry for Messages.
// The Phase 1 async loader currently throws during browser startup
// (`applyProfileAvatars is not defined`). Use the preserved stable chat core
// directly until the loader is repaired and browser-tested.

import './messages-core.js';
