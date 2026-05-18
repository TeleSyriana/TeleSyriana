# Phase 6 — Layout & Reliability Polish

## What changed

- Reworked Tickets layout styling with a cleaner queue/detail split.
- Improved ticket cards, active states, emergency/high/medium/normal priority colours, and status dots.
- Improved ticket detail panel readability, order info boxes, customer history, and mobile behaviour.
- Improved Reports layout with stronger snapshot cards, cleaner form spacing, report cards, and two-column report summaries.
- Added responsive layouts for tablet/mobile so Tickets and Reports stack cleanly.
- Added safer HTML escaping for ticket-rendered customer/order fields.
- Fixed Daily Reports date reset behaviour after saving/clearing forms.
- Kept existing Firestore collections and functions unchanged: no data migration required.

## Tested

- JavaScript syntax check passed for all JS files.
- ZIP integrity verified.

## Notes

This phase is focused on CSS/UI polish and small reliability fixes. The app still uses the existing manual Shopify order cache from Phase 5. Shopify API connection should remain a later secure phase.
