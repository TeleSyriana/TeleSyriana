# Phase 13 — Mobile Drawer Viewport Fix

Fixed the mobile drawer height problem.

## Issue
The mobile drawer was visually clipped because `.main-nav` was inside `.app-header`, and `.app-header` had `transform: translateX(-50%)`. A transformed parent can cause `position: fixed` children to behave like they are constrained by that parent instead of the full viewport.

## Fix
- Removed header transform on mobile.
- Made header use `left/right` instead of `left:50% + transform`.
- Forced mobile drawer to `height: 100dvh`.
- Added full viewport backdrop.
- Added mobile drawer internal vertical scrolling.
- Added iOS-friendly `-webkit-overflow-scrolling: touch`.
- Increased drawer/header/backdrop z-index layering.

## Test
Open on mobile width, tap menu, scroll the drawer. The full menu should load and scroll independently from the page.
