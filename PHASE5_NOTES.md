# Phase 5 — Shopify / Order Autofill Foundation

## What was added

This phase adds the first version of order autofill without needing Shopify API keys yet.

### New Firestore collection

- `orderRecords`

Each document uses the Shopify order number as the document ID, for example:

```json
{
  "orderNumber": "2515",
  "customerName": "John Smith",
  "email": "john@example.com",
  "phone": "Optional",
  "items": "iPhone 14 Silicone Case - Olive + Screen Protector 2D",
  "totalPaid": "£42.49",
  "orderDate": "2026-05-18",
  "courier": "Royal Mail",
  "trackingNumber": "TRACK123",
  "orderStatus": "fulfilled",
  "deliveryStatus": "in_transit",
  "shippingAddress": "Optional",
  "notes": "Internal note"
}
```

## Order cache panel

Supervisors, managers, and admins now see an **Order Lookup / Shopify Cache** panel inside the Tickets page.

They can:

- Add an order record manually
- Update an existing order record
- Load an existing cached order by order number
- Store customer, items, tracking, courier, status, delivery status, address, and notes

## Ticket autofill

Inside **Create Ticket**, the agent enters only the order number and clicks:

- **Autofill from order #**

If the order exists in `orderRecords`, the ticket fills:

- Customer name
- Email
- Items
- Tracking
- Courier
- Order status
- Delivery status
- Notes block

If no cached order exists, the system still creates a manual checking template.

## Ticket detail improvements

The ticket detail page now shows:

- Order items
- Tracking number
- Courier
- Order status
- Delivery status
- Risk
- Customer history

Customer history finds previous tickets by matching email or customer name.

## Permissions

- Agents can use ticket autofill.
- Supervisors / Managers / Admins can manage the manual order cache.
- Agents cannot edit order cache records.

## Why this phase matters

This gives the support team a clean workflow today without exposing Shopify API keys or relying on WhatsApp.

Later, this can be upgraded to real Shopify API autofill by replacing/manual-feeding `orderRecords` automatically.

## Next recommended phase

Phase 6 should add:

- SLA timers for emergency tickets
- Overdue red warnings
- manager escalation dashboard
- notification badges for unresolved emergency tickets
