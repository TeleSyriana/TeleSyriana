# Phase 17 — Glass UI + Auto Contrast

## Goal
Make the whole TeleSyriana interface feel like a consistent glass/blur operating system instead of mixed solid white cards.

## Changes
- Added global glass tokens for surfaces, borders, shadows, and text.
- Applied translucent glass styling to:
  - header menu
  - mobile drawer
  - cards
  - tickets panels
  - reports
  - payroll
  - messages
  - meetings
  - notes
  - dashboard cards
  - online cards
  - calendar cards
  - forms and table wrappers
- Added backdrop filters:
  - `backdrop-filter: blur(14px)`
  - `-webkit-backdrop-filter: blur(14px)`
- Added softer universal shadow:
  - `0 18px 40px rgba(0,0,0,.08)`
- Added automatic background tone detection:
  - light backgrounds use dark text
  - dark/custom backgrounds use light text
- Custom uploaded background images are sampled using a small canvas to estimate brightness.
- Kept inputs/selects readable by using a stronger translucent field background.

## Important
This phase is mainly visual/system polish. It does not solve the Firestore missing database warning. Create Firestore database in Firebase for real cloud sync.

## Tested
- JavaScript syntax checked with `node --check` on all JS files.
