# Phase 12 — Mobile UX, Chat Cover, Theme Backgrounds

## Fixed / Improved
- Added mobile drawer navigation with hamburger button and backdrop.
- Mobile nav no longer overflows horizontally on small screens.
- Chat on mobile now opens as a full-screen cover with a Back button.
- Added theme colour options: Pink, Blue, Orange, Green, Navy Blue, Red.
- Added background presets: Default gradient, Soft glass, Night focus, Light grid.
- Added optional background image upload, stored locally and synced to Firestore when database is ready.
- Settings now stores background/theme fields in profile cache and Firestore profile document.

## Important
Firestore still must be created in Firebase Console for cloud sync:
Firebase → Firestore → Create database → Production mode → Europe region.
Without Firestore the app can work locally, but cross-device saving will not work.

## Test checklist
- Login on desktop and mobile.
- Open hamburger menu on mobile.
- Switch between pages from drawer.
- Open Messages on mobile, tap a person, confirm full-screen chat opens.
- Press Back inside chat.
- Save Settings with each colour.
- Upload a small background image and press Save.
