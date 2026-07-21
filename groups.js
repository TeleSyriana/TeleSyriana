// TeleSyriana emergency runtime recovery entry for Groups.
// The Phase 1 async loader can miss DOMContentLoaded after its Blob import.
// Use the preserved stable groups core directly until the loader is repaired
// and browser-tested.

import './groups-core.js';
