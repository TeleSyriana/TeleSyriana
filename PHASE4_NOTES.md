# Phase 4 — Hours & Payroll

Built on top of Phase 3.

## Added

- New **Payroll** navigation page.
- Reads daily work records from Firestore collection: `agentDays`.
- Calculates:
  - Operation time
  - Meeting time
  - Handling time
  - Break time
  - Unavailable time
  - Total worked time
  - Estimated pay
- 45-minute break rule indicator:
  - OK
  - Over break warning
- Date range filters.
- This Week quick filter.
- Staff filter based on role permissions.
- Manager/Admin rate settings:
  - hourly rate
  - currency USD/GBP
  - saved in Firestore collection: `staffSettings`

## Permissions

- Agent: sees own payroll/hours only.
- Supervisor: sees assigned agents and own record.
- Manager/Admin: sees all staff and can update rates.

## Firestore collections used

- `agentDays` — created by the existing time tracking system.
- `staffSettings` — new collection for manager/admin rate overrides.

## Notes

- Reserve/loan/business finance are not included here. This module is for staff hours/pay estimate only.
- The system still uses the existing local demo staff map. Later phase should move staff management fully into Firestore.
- Payroll is an estimate and should be reviewed before actual salary payments.
