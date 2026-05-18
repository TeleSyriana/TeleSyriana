# Phase 11 — Login Toast / Firestore Missing DB Hotfix

Fixed the login blocker reported in DevTools:

- Added a real `showToast()` function so login does not crash with `showToast is not defined`.
- Added Firestore missing database detection.
- If Firestore `(default)` database is not created, the app now allows a local/offline session instead of failing login.
- Shows a clear warning toast: Firestore database is not created yet.

Important: for real cloud sync, create Cloud Firestore in Firebase Console:
Firebase → Firestore → Create database → Production mode → choose Europe region.

Login test codes:
- 0001 / Welcome 2026!
- 0002 / Welcome 2026!
- 1001 / 2411
- 2001 / 2411
- 9001 / 2411
