# Phase 3 — Team ticket search access

## Goal
Let agents keep a clean personal queue while still being able to find any active ticket by search when a customer asks for an update.

## Changes
- Agents still see their own/assigned tickets by default.
- When a non-manager searches with 2+ characters, search includes all active team tickets.
- Tickets found outside the agent queue get a “Team search” badge.
- A clear notice explains that the ticket was opened from team search.
- Agents can read the ticket details and add handling comments to a team-search ticket.
- Status, assignment, priority, resolution, escalation, and delete actions stay restricted to the ticket owner/assigned agent or supervisor/manager/admin.
- Search also checks comments/handling log text.

## Safety
- Deleted tickets remain restricted to Supervisor/Manager/Admin.
- No Firestore collection name changes.
- Existing ticket data is kept compatible.
