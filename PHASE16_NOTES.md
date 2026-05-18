# Phase 16 — Messages, Mobile Drawer, Tickets Shopify Labels

## Fixed / Improved

- Improved mobile drawer layout so the menu button does not hide the first menu item.
- Drawer now has safer top spacing, full-height scrolling, and language-aware Arabic/English menu title.
- Improved Messages layout on desktop with a clearer two-column split.
- Improved Messages mobile flow: chat list stays efficient, selected chat opens as a full-screen cover with Back.
- Messages static labels now respond to the language switcher instead of staying Arabic in English mode.
- Improved message room labels, placeholders, back button, send button, empty state, room descriptions, and presence text for Arabic/English.
- Removed the ticket creation modal behaviour. Create Ticket now opens inline as a normal panel, better for mobile.
- Added Shopify/order cache status labels to tickets:
  - Synced with Shopify / متزامن مع Shopify
  - Failed to load from Shopify / لم يتم العثور في Shopify
  - Manual entry / إدخال يدوي
- Ticket creation now warns clearly when no cached Shopify/order data exists.
- Added safer UI feedback for required order number during ticket creation.

## Notes

- This version still needs Firestore database creation for real cloud save across devices.
- Shopify sync is still cache/manual-based, not a real Shopify API integration yet.
- The app can work locally, but staff/team sync needs Firestore active.
