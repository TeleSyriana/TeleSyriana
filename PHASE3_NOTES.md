# TeleSyriana Phase 3 — Daily Reports

## Added

- New Reports page in the main navigation.
- Morning / Midday / End of Shift report types.
- Daily report form for support handovers.
- Firestore collection: `dailyReports`.
- Ticket snapshot panel showing:
  - open tickets
  - emergency tickets
  - escalated tickets
  - delayed tickets
  - return/exchange tickets
- Report history with filters:
  - report type
  - owner/mine
  - date
  - text search
- Role visibility:
  - Agent sees own reports.
  - Supervisor sees own reports and assigned agents' reports.
  - Manager/Admin sees all reports.
- Template button for quick morning/midday/evening report structure.

## Collections Used

- `dailyReports`
- `tickets` read-only summary for the report snapshot.

## Important

Phase 3 does not yet include full payroll approval or leave requests. Those can be Phase 4.

Suggested Phase 4:
- Leave requests
- Payroll/hours approval
- Manager performance dashboard
- SLA timers for reports and emergency tickets
