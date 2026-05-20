# TeleSyriana Tickets Delete + Duplicate v1

Changes included:
- Active duplicate prevention by order number before creating a ticket.
- Deleted duplicate warning if the same order exists in Deleted tickets.
- Soft delete: tickets move from `tickets` to `deletedTickets` instead of being lost.
- Deleted tickets folder for Supervisor / Manager / Admin only.
- Restore deleted tickets back to the active queue.
- Delete forever from Deleted tickets for Supervisor / Manager / Admin only.
- Agents can search for tickets created by other agents using order number / customer / email / notes, while their normal queue remains focused on visible tickets.
- UI keeps the existing glass style and supports Arabic / English labels.

Firestore collections used:
- `tickets`
- `deletedTickets`
