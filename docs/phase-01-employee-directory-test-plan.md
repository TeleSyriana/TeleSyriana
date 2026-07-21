# TeleSyriana Phase 1 — Employee Directory Test Plan

Status: **DRAFT / DO NOT MERGE TO PRODUCTION YET**

This phase replaces duplicated hard-coded employee identity data with a central Firestore `employees/{ccmsId}` directory while preserving the current iPro workflow during migration.

## Production invariants

These must remain true throughout Phase 1:

- Existing iPro tickets and ticket history are never rewritten or deleted by employee management.
- Existing attendance/payroll history remains attached to the original CCMS ID.
- Existing Shopify/iPro integration is untouched.
- Disabling or archiving an employee never deletes their tickets, comments, messages, attendance or payroll records.
- Existing production users remain able to log in until the central login migration is proven.
- No Phase 1 change is merged directly without the regression checks below.

## Directory acceptance tests

### Existing employees

- [ ] All current accounts appear in Employees & Accounts.
- [ ] Existing name, role, supervisor, rate and currency are preserved.
- [ ] Legacy users remain usable when no Firestore employee override exists.
- [ ] A Firestore override takes precedence over the legacy seed without erasing an unchanged legacy password.

### Add employee

- [ ] HR can add an employee with a unique CCMS ID.
- [ ] Manager can add an employee with a unique CCMS ID.
- [ ] Admin can add an employee with a unique CCMS ID.
- [ ] New employee requires a temporary password.
- [ ] CCMS accepts only 4–10 digits.
- [ ] Employee appears immediately after a successful save.
- [ ] Employee survives browser refresh because the source is Firestore, not local storage.

### Edit employee

- [ ] Name can be edited.
- [ ] Supervisor can be assigned/changed.
- [ ] Hourly rate can be edited by an authorised manager/HR/admin user.
- [ ] Currency can be edited.
- [ ] Timezone can be edited.
- [ ] Leaving password blank retains the current password.
- [ ] Entering a new temporary password replaces the current password for that account.

### Account lifecycle

- [ ] Active → Disabled works.
- [ ] Disabled employee is refused at login after the central login migration.
- [ ] Disabled → Active works.
- [ ] Active/Disabled → Archived works.
- [ ] Archived employee is refused at login.
- [ ] Archived employee historical tickets and attendance remain readable.
- [ ] Logged-in user cannot accidentally disable/archive their own account from quick actions.

### Role lifecycle

- [ ] Agent → Supervisor promotion persists after reload.
- [ ] Supervisor → Agent demotion persists after reload.
- [ ] Promotion changes the employee session role after the next session refresh/login.
- [ ] Supervisor team visibility follows the stored supervisor relationship.
- [ ] Role changes do not change old ticket authorship or old attendance records.

## Login/session regression

- [ ] Admin existing login works.
- [ ] Manager existing login works.
- [ ] HR existing login works.
- [ ] Supervisor existing login works.
- [ ] Agent existing login works.
- [ ] Newly-created Firestore-only Agent can log in after `app.js` central-login patch is applied.
- [ ] Newly-created Firestore-only Supervisor can log in after `app.js` central-login patch is applied.
- [ ] Saved browser session reloads role/name/status from the directory instead of stale local data.
- [ ] Disabled/archived saved sessions are rejected and returned to Login.
- [ ] Wrong password is rejected without opening the dashboard.

## Cross-module regression

### Tickets

- [ ] Existing tickets load normally.
- [ ] Existing Agent sees own/created ticket scope as before.
- [ ] Supervisor sees the intended team scope.
- [ ] Manager/Admin ticket visibility is unchanged.
- [ ] New dynamic employee appears in assignment controls after Tickets is migrated to directory lookups.
- [ ] Searching old tickets still works.
- [ ] Solved tickets remain searchable.
- [ ] Shopify order lookup works exactly as before.

### Payroll / attendance

- [ ] Today's `agentDays` record uses the directory employee ID/name/role/rate.
- [ ] Existing monthly payroll still loads.
- [ ] Historical days are not rewritten by a role/name change.
- [ ] New employee appears in payroll after creating attendance records.

### Reports

- [ ] Existing reports load.
- [ ] Agent sees own reports.
- [ ] Supervisor sees intended team reports.
- [ ] Manager/Admin visibility remains intact.
- [ ] Dynamic employee names resolve from the directory.

### Chat

- [ ] Existing DMs/rooms load.
- [ ] Existing unread counters still work.
- [ ] New employee appears as a valid chat user after chat directory migration.

## Device / UI checks

- [ ] Desktop Chrome/Edge basic flow.
- [ ] Mobile layout does not hide the Employees navigation incorrectly.
- [ ] English Employees page labels are readable.
- [ ] Arabic Employees page labels are readable and direction remains RTL.
- [ ] Employee modal can scroll on smaller displays.

## Current known blocker

`app.js` still owns login/session state through its hard-coded `USERS` object. The exact migration is documented in `phase1-app-login.patch`, but it must be applied and reviewed as a real source-code change before this Phase is production-ready.

The repository currently does not contain `firestore.rules`/`firebase.json`, so the deployed Firestore permission for the new `employees` collection must be smoke-tested against the real environment before merge.

## Ready-to-merge gate

Phase 1 is ready only when:

1. `app.js` authenticates and restores sessions through the central employee directory.
2. The temporary legacy-login guard is removed.
3. Tickets, Payroll and Reports resolve staff from the directory or a proven compatibility adapter.
4. Add / Edit / Promote / Demote / Disable / Reactivate / Archive pass against the real Firestore environment.
5. The complete login and cross-module regression checklist above passes.
6. The draft PR is reviewed one final time against `main` immediately before merge.
