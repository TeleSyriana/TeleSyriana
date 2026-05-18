# TeleSyriana — Phase 1 Roles Update

## Completed

### Role model added
- Agent: codes like `0001`
- Supervisor: codes like `1001`
- Manager: codes like `2001`
- Admin / Owner: codes like `9001`

### Demo users
- `0001 / Welcome 2026!` — Agent Raghad
- `0002 / Welcome 2026!` — Agent Qamar
- `0003 / Welcome 2026!` — Agent
- `1001 / 2411` — Supervisor Dema
- `2001 / 2411` — Manager Mohammad
- `9001 / 2411` — Owner Admin

### Permissions
- Agents keep basic access.
- Supervisor can see assigned agents in Team Overview.
- Manager/Admin can see the full team overview.
- Manager/Admin can create/delete meetings and use supervisor-level spaces.
- Groups creation is now allowed for Supervisor/Manager/Admin.

### Time/pay fields
- User records now include `hourlyRate` and `currency`.
- Firestore daily status records now save rate/currency for payroll estimates.
- Team Overview now shows estimated pay for the day.

### Chat/member cleanup
- Direct message targets for `0001` and `0002` were corrected.
- Old `1002` supervisor DM was replaced with `2001` Manager Mohammad.
- Group member list now includes Manager and Admin.

## Notes
- This is still a hardcoded staff-code login. The next phase should move staff users to Firestore so the admin can add/edit staff without editing code.
- Passwords/PINs are still plain text in code. This is OK only for internal demo/testing. It should be improved before serious deployment.

## Tested
- JavaScript syntax checked with `node --check` for all main JS files.
