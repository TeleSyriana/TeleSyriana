# TeleSyriana Phase 1 — Employee Directory Test Plan

Status: **DRAFT / DO NOT MERGE TO PRODUCTION YET**

Phase 1 replaces duplicated hard-coded employee identity data with one Firestore-backed `employees/{ccmsId}` directory while preserving the existing iPro workflow and historical data.

## Implemented architecture

The branch now includes:

- central employee directory with legacy-account compatibility
- dynamic login and saved-session refresh from the employee directory
- real-time current-account watcher for promotion, demotion, disable and archive
- HR/Manager/Admin Employees & Accounts page
- Add / Edit / Promote / Demote / Disable / Reactivate / Archive
- duplicate CCMS creation protection
- self-role/self-disable/self-archive lockout protection
- active-team guard before demoting/disabling/archiving a Supervisor
- supervisor assignment, hourly rate, currency and timezone fields
- employee change audit records in `employeeAudit`
- central directory as the authoritative official employee name; personal Profile/Settings keeps photo, birthday, notes, language and appearance preferences
- Tickets staff/assignee/team lookup migration with inactive historical names preserved and active-only new assignment
- Payroll staff lookup migration with historical inactive employees retained but active-only shift/rate editing
- Reports staff lookup migration
- dynamic Chat Direct Messages from the employee directory
- dynamic Group member picker from the employee directory
- history-preserving account disable/archive behaviour
- Firestore quota/read-amplification mitigation: slower presence heartbeat, Home-only management presence subscription, active-only Home ticket calendar, hidden-page lazy subscriptions for Tickets/Reports/Payroll, Messages-only presence/profile/status listeners, and on-demand Deleted Tickets subscription

Large existing operational modules are retained byte-for-byte as `*-core.js` files. Small migration loaders apply only the Step-1 employee-directory/quota-safe changes and fall back to the untouched core module if an expected source marker does not match.

## Verified automated preflight

GitHub Actions now runs `node tools/phase1-static-preflight.mjs` for this phase. The deterministic preflight has passed after catching and fixing one real saved-session marker mismatch.

The preflight validates:

- ES-module syntax for all migration/core JavaScript files
- exact Git blob hashes for preserved rollback cores
- every required old-source marker used by the runtime loaders
- employee-management service guards
- untouched-core fallback paths
- quota-reduction guard markers for App, Tickets, Reports, Payroll and Messages

The Firestore network probe is intentionally a separate gate so a quota/rules problem cannot be confused with a code-loader problem.

## Current live Firestore finding

A read-only GitHub Actions probe reached the real `telesyriana-ccms` Firestore REST endpoint successfully but returned:

- HTTP `429`
- `RESOURCE_EXHAUSTED`
- `Quota exceeded.`

This is **not a permission-denied result**. It means the live Firestore permission smoke test is currently inconclusive because the project is refusing reads due to quota/resource exhaustion.

The existing code showed several read-amplification paths that can plausibly contribute to this:

- presence was written every 30 seconds
- Messages subscribed every logged-in browser to the full presence collection even while Messages was hidden
- the main App maintained another presence listener for management accounts
- Reports subscribed to reports + ticket snapshots at startup even while the page was hidden
- Payroll subscribed to `agentDays` at startup even while Payroll was hidden
- Tickets subscribed at startup even while Tickets was hidden
- Deleted Tickets subscribed for privileged users before the Deleted folder was opened
- the Home issue calendar downloaded the full historical ticket collection for non-Agent accounts

The Phase-1 loaders now reduce those reads without modifying the preserved core engines.

## Production invariants

These must remain true throughout Phase 1:

- Existing iPro tickets and ticket history are never rewritten or deleted by employee management.
- Existing attendance/payroll history remains attached to the original CCMS ID.
- Existing Shopify/iPro integration is untouched.
- Disabling or archiving an employee never deletes their tickets, comments, messages, attendance or payroll records.
- Existing production accounts remain usable through the compatibility seed unless explicitly disabled/archived in the directory.
- A Supervisor with active direct reports cannot be removed from supervision until those agents are reassigned.
- No Phase 1 change is merged without the regression checks below.

## Directory acceptance tests

### Existing employees

- [ ] All current accounts appear in Employees & Accounts.
- [ ] Existing name, role, supervisor, rate and currency are preserved.
- [ ] Legacy users remain usable when no Firestore employee override exists.
- [ ] A Firestore override takes precedence without erasing an unchanged legacy password.

### Add employee

- [ ] HR can add an employee with a unique CCMS ID.
- [ ] Manager can add an employee with a unique CCMS ID.
- [ ] Admin can add an employee with a unique CCMS ID.
- [ ] New employee requires a temporary password.
- [ ] CCMS accepts only 4–10 digits.
- [ ] Trying to Add an already-used CCMS is refused and does not edit the existing account.
- [ ] Employee appears immediately after a successful save.
- [ ] Employee survives browser refresh because Firestore is the source of truth.
- [ ] Newly-created employee can sign in without a source-code change.

### Edit employee

- [ ] Official employee name can be edited from Employees & Accounts by an authorised role.
- [ ] The employee cannot override the official name from their personal Settings/Profile page.
- [ ] Supervisor can be assigned/changed.
- [ ] Hourly rate can be edited by an authorised manager/HR/admin user.
- [ ] Currency can be edited.
- [ ] Timezone can be edited.
- [ ] Leaving password blank retains the current password.
- [ ] Entering a new temporary password replaces the current password.
- [ ] Logged-in manager/HR/admin cannot accidentally change their own role or account status from the Employees UI.

### Account lifecycle

- [ ] Active → Disabled works.
- [ ] Disabled employee is refused at login.
- [ ] An already-open Disabled account is logged out by the account watcher.
- [ ] Disabled → Active works.
- [ ] Active/Disabled → Archived works.
- [ ] Archived employee is refused at login.
- [ ] Archived employee historical tickets, reports, chats and attendance remain readable to authorised staff.
- [ ] Logged-in user cannot accidentally disable/archive their own account from the Employees UI.
- [ ] Supervisor with active direct reports cannot be disabled/archived until those agents are reassigned.

### Role lifecycle

- [ ] Agent → Supervisor promotion persists after reload.
- [ ] Supervisor → Agent demotion persists after reload.
- [ ] Promotion/demotion updates an already-open employee session without manual refresh.
- [ ] Supervisor team visibility follows the stored `supervisorId` relationship.
- [ ] Supervisor with active direct reports cannot be demoted until those agents are reassigned.
- [ ] Role changes do not change old ticket authorship, messages or attendance records.

## Login/session regression

- [ ] Admin existing login works.
- [ ] Manager existing login works.
- [ ] HR existing login works.
- [ ] Supervisor existing login works.
- [ ] Agent existing login works.
- [ ] Newly-created Firestore-only Agent can log in.
- [ ] Newly-created Firestore-only Supervisor can log in.
- [ ] Saved browser session reloads role/name/status from the directory instead of stale local data.
- [ ] Disabled/archived saved sessions return to Login.
- [ ] Wrong password is rejected without opening the dashboard.

## Cross-module regression

### Tickets

- [ ] Existing tickets load normally when the Tickets page is opened.
- [ ] Tickets does not keep its main Firestore listener active while another page is open.
- [ ] Existing Agent sees own/created ticket scope as before.
- [ ] Supervisor sees the intended team scope.
- [ ] HR/Manager/Admin ticket visibility remains intact.
- [ ] Newly-created active employee appears in assignment controls.
- [ ] Disabled/archived employee retains their name on historical ticket ownership but is not offered for new assignment.
- [ ] Promoting/demoting/changing supervisor refreshes staff/team lookups.
- [ ] Deleted Tickets are loaded only after the Deleted folder is opened and unsubscribed when it closes.
- [ ] Searching old tickets still works.
- [ ] Solved tickets remain searchable.
- [ ] Shopify order lookup works exactly as before.

### Payroll / attendance

- [ ] Today's `agentDays` record uses directory employee ID/name/role/rate/supervisor.
- [ ] Existing monthly payroll still loads when Payroll is opened.
- [ ] Payroll does not keep `agentDays`/staff-settings listeners active while another page is open.
- [ ] HR/Manager/Admin can see full payroll as intended.
- [ ] Supervisor sees their team rather than every employee.
- [ ] Historical disabled/archived employees remain available when reviewing old payroll.
- [ ] Disabled/archived employees are not offered as normal active shift/rate-setting targets.
- [ ] Directory refresh does not reset a manually-selected payroll date range.
- [ ] Historical days are not rewritten by a role/name change.
- [ ] New employee appears in payroll after creating attendance records.

### Reports

- [ ] Existing reports load when Reports is opened.
- [ ] Reports does not keep report/ticket listeners active while another page is open.
- [ ] Agent sees own reports.
- [ ] Supervisor sees intended team reports.
- [ ] HR/Manager/Admin visibility remains intact.
- [ ] Dynamic employee names resolve from the directory.
- [ ] Disabled/archived historical report authors still resolve by name.

### Chat & Groups

- [ ] Existing rooms/groups/DM histories load.
- [ ] Existing unread counters and read receipts still work.
- [ ] New active employee appears automatically in Direct Messages.
- [ ] Official DM display name follows the employee directory rather than an older profile-name cache.
- [ ] Disabled/archived employee is removed from the active DM contact list without deleting chat history.
- [ ] Avatar role styling follows the employee directory rather than hard-coded CCMS IDs.
- [ ] Presence/profile/agent-status realtime listeners activate when Messages opens and stop when the user leaves Messages.
- [ ] New active employee appears in the Group member picker.
- [ ] Inactive historical Group members remain visible when relevant but cannot be newly selected.

### Supervisor homepage / presence

- [ ] New agent's `agentDays.supervisorId` makes them appear in the correct Supervisor table.
- [ ] Promoted Supervisor can see agents assigned to their CCMS ID.
- [ ] Supervisor does not receive global team visibility.
- [ ] Presence heartbeat is approximately once per minute rather than every 30 seconds.
- [ ] Team presence listener is active only for management while Home is visible.
- [ ] Home issue calendar still shows active unresolved issue counts after switching to an active-status Firestore query.

## Device / UI checks

- [ ] Desktop Chrome/Edge basic flow.
- [ ] Mobile layout does not hide the Employees navigation incorrectly.
- [ ] English Employees page labels are readable.
- [ ] Arabic Employees page labels are readable and direction remains RTL.
- [ ] Employee modal can scroll on smaller displays.
- [ ] Personal Settings shows official employee name read-only while the other personal settings still save normally.

## Current remaining gates

### 1. Firestore quota must recover or be increased

The real Firestore endpoint currently returns `429 RESOURCE_EXHAUSTED / Quota exceeded`. Before production merge:

- check Firestore **Usage** and Google Cloud **Quotas** for project `telesyriana-ccms`
- confirm whether billing is enabled and whether the project is operating only on the free daily quota
- let the quota reset or increase/enable sufficient quota
- rerun the read-only Firestore probe until it returns a normal Firestore result (`200` or `404`) instead of `429`

Only after that can the employee permission/read path be meaningfully tested.

### 2. Real Firestore permission/write smoke test

Once quota is available, confirm authorised browser sessions can read/write:

- `employees`
- `employeeAudit`

and that the existing collections continue operating normally.

### 3. Browser runtime smoke test

The branch uses reversible migration loaders around the exact current production modules. The loaders have strict marker validation and untouched-core fallback, but the complete branch still needs browser testing before merge to verify module loading, Blob-module imports, page lifecycle subscriptions and Firestore behaviour in the actual TeleSyriana hosting environment.

The current execution environment cannot resolve the GitHub/raw.githack hosts required to open a non-production static preview, so this test has not been falsely marked as completed.

## Ready-to-merge gate

Phase 1 is ready only when:

1. Static preflight remains green on the final branch head.
2. Firestore no longer returns `RESOURCE_EXHAUSTED` and the read-only probe reaches a normal `200/404` result.
3. Existing and newly-created accounts pass login/session testing.
4. Add / Edit / Promote / Demote / Disable / Reactivate / Archive pass against the real Firestore environment.
5. Tickets, Payroll, Reports, Chat and Groups pass the cross-module regression checks above, including lazy-listener lifecycle checks.
6. Supervisor team behaviour and reassignment guard are verified with a real promoted Supervisor and assigned Agent.
7. Existing Shopify order lookup and ticket history are unchanged.
8. Personal profile settings still work without overriding the directory-owned official name.
9. The complete regression checklist passes on desktop and at least one staff/mobile device.
10. Draft PR #3 is reviewed against the current `main` immediately before merge.
