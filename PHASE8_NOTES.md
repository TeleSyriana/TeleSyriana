# Phase 8 — Real Usability + Data Fixes

## Focus
This phase fixes the real staff-use problems found during review: save feedback, profile/theme persistence, online presence, ticket modal usability, report editing, Apple-style notes, issue calendar, and meeting link workflow.

## Changes

### Tickets
- Create Ticket remains a real popup and now has a clearer close button area.
- Save/create buttons show working states like `Saving...` / `Creating...`.
- Save/create errors now include Firebase error code/message where possible.
- Order autofill now gives clearer feedback when an order is not cached.
- Ticket modal/footer layout improved and scrolling tightened.

### Reports
- Report cards are now clickable.
- Added report view/edit modal.
- Manager/Supervisor/Agent can open visible reports and save edits.
- Report save now catches Firestore failures and shows clear feedback.

### Settings
- Full name is now editable.
- Name saves to Firestore + localStorage.
- Current session updates immediately after saving.
- Staff code and role are visible in Settings.
- Theme still updates immediately and saves with profile.

### Messages / Presence
- Added `userPresence` collection support.
- Home dashboard now shows Online now list.
- Direct messages now show online/away/offline and last seen text.
- Presence includes current page like Tickets, Reports, Home.

### Notes
- Replaced Trello-style notes with Apple Notes-style personal notes.
- Notes now have a sidebar list + editor.
- Auto-save after typing.
- Notes are saved per user in Firestore collection `personalNotes`.

### Payroll / Hours
- Existing payroll save feedback retained.
- Online and status data is now more visible from Home.
- Time tracking still writes to `agentDays` and payroll reads from it.

### Calendar
- Calendar now has issue-rate indicators based on tickets.
- Dots show days with tickets/risk issues.
- Summary shows today’s ticket count and risk issue count.
- Sales-based issue rate can be added later when Shopify data is connected.

### Meetings
- Reframed meetings from fake local video preview to real link scheduler.
- Manager/Supervisor can paste Google Meet / Zoom / Teams link.
- Joining opens the link and records attendance in Firestore under `meetings/{id}/attendance/{userId}`.
- Meeting expiry field is added: 1 hour after start time.

## Firebase Collections Used
- `tickets`
- `dailyReports`
- `agentDays`
- `staffSettings`
- `userProfiles`
- `userPresence`
- `personalNotes`
- `meetings`
- `meetings/{meetingId}/attendance`

## Still recommended for Phase 9
- Move hardcoded staff passwords to Firestore/Auth.
- Add Firestore security rules per role.
- Add SLA timers and overdue alerts.
- Add real Shopify API order autofill.
- Add manager dashboard for chargeback-risk tickets.
