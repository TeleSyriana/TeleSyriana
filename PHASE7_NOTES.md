# Phase 7 — Workflow Polish & Bug Fixes

## Fixed
- Ticket **Save Changes** now has error handling and visible feedback if Firestore permissions/internet block saving.
- Ticket creation is now a **popup modal** instead of a large inline block that stretches the page.
- Ticket queue and ticket detail now have their own internal scrolling instead of loading as one huge page height.
- Reports history now scrolls separately instead of stretching the full page.
- Settings now shows a visible save message and keeps a local fallback if Firestore save fails.
- Theme preview now changes immediately when selecting Male/Female, and blue theme is more visible.
- Payroll rate saving now shows the saved rate immediately and refreshes table labels/calculation.
- Payroll rate selector now displays current saved rate next to staff name.
- Tasks has been softened/renamed in UI as **Personal Notepad** so it does not compete with the Tickets workflow.

## Still recommended for next phase
- Replace hardcoded demo users/passwords with secure Firestore/Firebase Auth staff records.
- Add Firestore security rules matching Agent/Supervisor/Manager/Admin permissions.
- Add true Shopify API order lookup when ready; current order autofill uses manual cache.
- After one week of real use, collect bugs from agents and do a Phase 8 production-hardening pass.
