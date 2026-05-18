# TeleSyriana Phase 2 — Ticket System

## Added

- New `Tickets` navigation tab.
- Firestore-backed `tickets` collection.
- Create ticket form with order number required.
- Ticket categories:
  - Address Change
  - Product Not Arrived
  - Item Not Genuine / Fake Claim
  - Return
  - Exchange
  - Angry Customer
  - Refund Request
  - Chargeback Risk
  - General Question
- Priority levels:
  - Emergency
  - High
  - Medium
  - Normal
- Status workflow:
  - Open
  - Waiting Customer
  - Waiting Courier
  - Waiting Supplier
  - Escalated
  - Resolved
  - Closed
- Emergency tickets shown with red styling.
- Ticket owner / assignment system.
- Ticket detail panel with internal notes, customer mood, resolution and escalation.
- Ticket filters by search, status, priority and owner.
- Ticket dashboard stats: open, emergency, escalated and resolved today.

## Role behaviour

- Agent sees tickets assigned to them or created by them.
- Supervisor sees tickets assigned to their agents, their own tickets and unassigned tickets.
- Manager/Admin sees all tickets.

## Shopify autofill

Current version is manual-first:
- The user enters order number.
- The system creates a structured ticket.
- The `Autofill from order #` button currently fills a handling note.

Next phase can connect Shopify API to auto-fill customer name, email, items, tracking and delivery status.

## Tested

JavaScript syntax checked with:

```bash
node --check app.js
node --check tickets.js
node --check tasks.js
node --check messages.js
node --check groups.js
node --check meetings.js
```
