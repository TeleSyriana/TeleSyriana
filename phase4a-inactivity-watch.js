// phase4a-inactivity-watch.js — client inactivity fallback for Phase 4A
//
// This is intentionally not described as server enforcement. While TeleSyriana is
// open, 15 minutes without user activity changes active work states to Unavailable
// through the existing status-select change handler, so the existing app persists it.
// Break and Meeting are excluded by inactivity-policy.js.

import { INACTIVITY_UNAVAILABLE_MS, shouldAutoUnavailable } from "./inactivity-policy.js";

const USER_KEY = "telesyrianaUser";
const LAST_ACTIVITY_KEY = "telesyrianaLastActivityMs";
const CHECK_EVERY_MS = 30 * 1000;
let timerId = null;
let hooked = false;
let lastActivityWriteMs = 0;

function readSession() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }
  catch { return null; }
}

function sessionActive() {
  return Boolean(readSession()?.id || readSession()?.ccmsId);
}

function readLastActivityMs() {
  const value = Number(localStorage.getItem(LAST_ACTIVITY_KEY) || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function writeLastActivityMs(now = Date.now(), force = false) {
  if (!sessionActive()) return;
  const ms = Number(now) || Date.now();
  // Avoid hammering localStorage on repeated pointer/keyboard events.
  if (!force && ms - lastActivityWriteMs < 5_000) return;
  lastActivityWriteMs = ms;
  try { localStorage.setItem(LAST_ACTIVITY_KEY, String(ms)); } catch {}
}

function currentStatusSelect() {
  return document.getElementById("status-select");
}

export function evaluateInactivityNow(nowMs = Date.now()) {
  if (!sessionActive()) return false;
  const select = currentStatusSelect();
  if (!select) return false;
  const lastActivityMs = readLastActivityMs();
  if (!lastActivityMs) {
    writeLastActivityMs(nowMs, true);
    return false;
  }

  if (!shouldAutoUnavailable({
    status: select.value,
    lastActivityMs,
    nowMs,
    thresholdMs: INACTIVITY_UNAVAILABLE_MS,
  })) return false;

  select.value = "unavailable";
  select.dataset.inactivityAutoUnavailableAt = String(nowMs);
  select.dispatchEvent(new Event("change", { bubbles: true }));
  try {
    window.dispatchEvent(new CustomEvent("telesyriana:inactivity-auto-unavailable", {
      detail: { idleMs: Math.max(0, Number(nowMs) - lastActivityMs), atMs: Number(nowMs) },
    }));
  } catch {}
  return true;
}

function activityEvent() {
  writeLastActivityMs(Date.now());
}

function onVisibilityChange() {
  if (document.hidden) return;
  // Check the previous idle duration before treating the return-to-tab as activity.
  evaluateInactivityNow(Date.now());
  writeLastActivityMs(Date.now(), true);
}

function onUserChanged() {
  if (!sessionActive()) {
    try { localStorage.removeItem(LAST_ACTIVITY_KEY); } catch {}
    return;
  }
  if (!readLastActivityMs()) writeLastActivityMs(Date.now(), true);
}

function startTimer() {
  if (timerId) clearInterval(timerId);
  timerId = setInterval(() => evaluateInactivityNow(Date.now()), CHECK_EVERY_MS);
}

function boot() {
  if (hooked) return;
  hooked = true;
  ["pointerdown", "keydown", "touchstart", "wheel"].forEach((name) => {
    document.addEventListener(name, activityEvent, { passive: true, capture: true });
  });
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("telesyriana:user-changed", onUserChanged);
  window.addEventListener("storage", (event) => {
    if (event.key === USER_KEY) onUserChanged();
  });
  onUserChanged();
  startTimer();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
