# Phase 9 — Real Staff UX Fixes

This phase focuses on the usability problems found during real testing.

## Fixed / Improved

### Tickets
- Create Ticket now behaves like a real modal with backdrop and a visible close button.
- Ticket list and ticket detail scroll independently.
- Save/Create buttons show saving/creating state.
- Runtime errors now show clearer Firestore/internet/permission feedback.
- Added ticket timeline/history for created, saved and escalated actions.
- Fixed an order-cache runtime bug where a missing order number could reference undefined button variables.

### Reports
- Report cards are easier to scan and open/edit in a modal.
- Report modal layout is clearer and scrollable.

### Settings
- Settings save button now shows a saving state.
- Profile name is persisted locally and back into the current user session after save/load.
- Firestore save failures now show the actual error code/message where possible.
- Theme is applied immediately and saved with the profile.

### Home / Payroll / Presence
- Login now waits for the daily state to initialise before the dashboard renders.
- Time tracking UI updates every 5 seconds while Firestore writes remain throttled.
- Added quick status buttons: Clock in, Start break, Handling, Meeting, Clock out.
- Online Now is clearer with live/away/offline status styling.

### Notes
- Notes are visually closer to Apple Notes: sidebar + paper editor + autosave feel.

### Messages
- Live/away/last seen indicators are styled more clearly.
- Floating mini chat is more prominent and easier to use while working.

### Meetings
- Hidden the unused video-meeting UI.
- Meetings now behave more like a link scheduler/attendance tracker.

### Calendar
- Issue calendar dots are visually clearer for low/mid/high risk days.

## Still recommended for Phase 10
- Move hardcoded staff passwords out of JavaScript.
- Proper Firestore security rules per role.
- Real Shopify API order lookup through a secure backend, not browser API keys.
- Add dashboard cards for overdue SLA and chargeback-risk tickets.
- Add manager attendance summary for meetings.
