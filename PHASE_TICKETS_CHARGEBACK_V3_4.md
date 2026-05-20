PHASE TICKETS CHARGEBACK V3.4

Frontend support added for Shopify dispute / chargeback data when the backend returns it with the order payload.

UI behaviour:
- If chargeback/dispute is active, the Shopify order card and ticket card get a red warning border/glow.
- A Chargeback / النزاع البنكي field appears in the order details.
- Statuses display as Needs response / Under review / Won / Lost / Prevented etc.
- Ticket risk becomes chargeback when active or lost dispute data exists.

Expected fields from backend inside the Shopify order payload:
- disputes: [{ id, type, status, reason, amount, currency, evidence_due_by, evidence_sent_on, finalized_on, initiated_at }]
OR
- dispute / chargeback / disputeSummary / orderDisputeSummary
OR
- chargebackStatus / disputeStatus

Backend requirement:
- Shopify app must have Shopify Payments dispute access: shopify_payments or shopify_payments_payouts.
- Backend should query Shopify Payments disputes and match disputes by Shopify order_id.
- Frontend will show chargeback UI automatically once backend returns those fields.
