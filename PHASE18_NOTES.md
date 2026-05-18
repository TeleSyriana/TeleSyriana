# Phase 18 — Menu Restore, Chat Scroll, Background Remove, Language Cleanup

## Fixed
- Restored the English mobile drawer behavior and separated RTL Arabic drawer rules.
- Arabic drawer now opens from the right, English from the left, both full height with internal scrolling.
- Fixed menu button overlap by adding proper drawer padding and z-index.
- Restored Messages scroll on desktop and mobile.
- Added Remove uploaded background button in Settings.
- Default initial language is now English unless the user saved Arabic.
- Added more language cleanup for Home, Tickets, Reports, Settings and common controls.
- Improved ticket labels/options translation when switching language.

## Still required before production
- Create Firestore database in Firebase Console so cloud sync works between devices.
- Phase 19 should focus on security: Firestore rules, moving staff credentials out of code, and proper admin-managed users.
