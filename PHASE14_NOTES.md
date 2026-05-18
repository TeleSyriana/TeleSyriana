# Phase 14 — Arabic RTL + Logout Fix

## Done
- Converted the app shell to Arabic and RTL (`lang="ar" dir="rtl"`).
- Translated the main navigation, login, dashboard, settings, tickets, reports, messages, payroll, meetings and common status labels.
- Added RTL styling for forms, cards, tables, messages, modals and mobile drawer.
- Kept technical fields like passwords, CCMS codes, emails, URLs, order numbers and tracking numbers LTR for readability.
- Fixed logout so it no longer depends on Firebase being available. It now clears the local session and returns to login even if Firestore is missing/offline.
- Added delegated logout handling so the logout button works reliably from the normal nav and mobile drawer.

## Important
- Firestore still needs to be created in Firebase for cross-device sync.
- Until Firestore exists, the app can work locally, but data will not sync between devices.
- Some internal console warnings from Firebase are expected until the Firestore database is created.
