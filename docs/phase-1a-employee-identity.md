# TeleSyriana Phase 1A — Permanent Employee Identity

## Goal

Phase 1A creates a permanent employee identity model without changing the current production login or operational runtime.

The core rule is:

- `employeeUid` identifies the person permanently.
- `ccmsId` is the employee's current role-coded operational number and may change after promotion/demotion.

A promotion must never create a new person or disconnect ticket, payroll, attendance, message, or report history.

## Official CCMS hierarchy

| CCMS range | Canonical role | Project scope | Team rule |
| --- | --- | --- | --- |
| `0xxx` | CEO | Global | No Supervisor |
| `1xxx` | ACM | Exactly 1 project | No Supervisor |
| `2xxx` | Supervisor | Exactly 1 project | Can manage Agents in the same project |
| `3xxx` | HR | 1 or multiple projects | No Supervisor |
| `9xxx` | Agent | Exactly 1 project | Exactly 1 Supervisor in the same project |

`0000` is reserved/invalid.

Compatibility aliases during migration:

- existing `admin` => canonical `ceo`
- existing `manager` => canonical `acm`

## Permanent storage layout

### `employeeIdentities/{employeeUid}`

Permanent person record.

Example:

```json
{
  "employeeUid": "emp_legacy_9003",
  "ccmsId": "9003",
  "fullName": "Reema Obaid",
  "roleKey": "agent",
  "projectId": "ipro",
  "projectIds": ["ipro"],
  "supervisorUid": "emp_legacy_2001",
  "supervisorCcmsId": "2001",
  "accountStatus": "active"
}
```

### `employeeCcmsIndex/{ccmsId}`

Lookup document:

```json
{
  "ccmsId": "9003",
  "employeeUid": "emp_legacy_9003"
}
```

When Reema is promoted:

- `employeeUid` stays `emp_legacy_9003`
- `ccmsId` can change from `9003` to `2002`
- `roleKey` changes from `agent` to `supervisor`
- old CCMS index is removed
- new CCMS index points to the same permanent employee UID

## Projects

`iPro` is the default compatibility project:

```json
{
  "projectId": "ipro",
  "name": "iPro",
  "accountStatus": "active",
  "isDefault": true
}
```

Project documents are stored under `projects/{projectId}`.

Project removal is represented by `disabled` or `archived`, not destructive deletion, so historical records remain attributable.

## Current staff compatibility identity seed

Phase 1A defines identity-only seed rows for the seven current accounts. No passwords are duplicated into the new identity seed.

- `0001` Jack Smith — CEO — global
- `1001` Mohammad Safar — ACM — iPro
- `2001` Dema Shabar — Supervisor — iPro
- `3001` Fatima Kaka — HR — iPro
- `9001` Raghad Moussa — Agent — iPro — Supervisor `2001`
- `9002` Qamar Moussa — Agent — iPro — Supervisor `2001`
- `9003` Reema Obaid — Agent — iPro — Supervisor `2001`

## Production safety

Phase 1A deliberately does **not**:

- modify `app.js` or current login
- seed Firestore automatically at startup
- change Tickets, Payroll, Reports, Messages, Groups, Notes, or Meetings
- expose the new Employees & Accounts UI yet
- replace current passwords/authentication

The migration helpers must be called explicitly in a later controlled step after Firestore quota health is acceptable.

## Phase 1B dependency

The visible Employees & Accounts screen will use this foundation to:

- create employee identities
- allocate the next role-compatible CCMS number
- assign projects
- assign Agents to same-project Supervisors
- promote/demote while preserving `employeeUid`
- disable/reactivate/archive without deleting history
