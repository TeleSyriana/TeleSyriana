# TeleSyriana account security and IT Support

## Password lifecycle

- Temporary onboarding/reset passwords are supplied out-of-band at provisioning time and are never committed to source control.
- A temporary password always sets `mustChangePassword: true`.
- Permanent employee passwords expire every **90 days**.
- New passwords must contain at least 10 characters, including upper- and lowercase letters, a number and a symbol.
- The current password and the previous five credential hashes are protected against reuse.
- Existing legacy compatibility accounts remain on their existing authentication path until permanent hashed-credential migration is enabled. They are marked for password-policy migration rather than pretending 90-day enforcement already exists.

## IT Support role

The dedicated IT Support role uses the `4xxx` CCMS range. The first available ID is `4001`.

IT Support is deliberately **not** an administrator role. It has no operational project membership and no inherited CEO/ACM/HR permissions.

Allowed account-support data:
- permanent employee UID
- CCMS ID
- full name
- role
- account status
- project identifier(s) for diagnosis only
- whether a permanent credential exists
- first-login/password-expiry state
- password changed/expiry timestamps

Never exposed through IT support profiles:
- plaintext passwords
- password hashes
- salts
- password history
- payroll rate/currency
- Ticket data
- Chat/messages or detailed presence

IT Support may reset a non-CEO, non-archived employee credential only after permanent account provisioning is enabled. A reset creates a new temporary hashed credential and forces a password change at the employee's next login.

IT Support cannot:
- reset the CEO credential
- use the IT reset flow on its own account
- promote/demote employees
- create or edit general employee records
- access project dashboards as an operational member
- open operational Tickets
- discover or participate in operational Chat by default

## Current activation status

`EMPLOYEE_ACCOUNT_PROVISIONING_READY` remains `false` until the permanent directory/authentication migration is deliberately enabled and browser-tested. The policy and support service are therefore safe-by-default and cannot perform a live password reset yet.
