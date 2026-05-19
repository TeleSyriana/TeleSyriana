# Phase 3 — Payroll Shift Hours

Baseline: Phase 2 Notes Pro.

Changes:
- Added staff shift target settings in Payroll.
- Supervisor, Manager, and Admin can set 4h part-time, 8h full-time, or custom shift hours.
- Manager/Admin can also edit hourly rate and currency.
- Supervisor can edit shift targets only; rate controls are disabled.
- Payroll summary now shows Total worked, Shift target, Difference, Operation, Break, Late breaks, and Expected pay.
- Payroll table now shows shift target and shift difference per row.
- Dashboard work-hours ring reads the logged-in user's saved staffSettings.shiftTargetMinutes instead of a fixed 8h target.
- Current agentDays sync writes shiftTargetMinutes and shiftType.

Firestore:
- staffSettings/{userId}.shiftTargetMinutes
- staffSettings/{userId}.shiftType
- staffSettings/{userId}.hourlyRate and currency remain Manager/Admin controlled.
