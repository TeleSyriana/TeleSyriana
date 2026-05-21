# Tickets chargeback confirmation fix v3.8

This phase separates manual `Chargeback risk` from confirmed Shopify Payments disputes.

- Manual/customer-risk tickets stay orange.
- Confirmed Shopify dispute data shows red/green/dark-red depending on status.
- Confirmed detail text now says "Confirmed by Shopify" / "مؤكد من Shopify".
- Ticket title/type text alone no longer makes a ticket behave like a real chargeback.
