// phase4a-inactivity-watch.js — client inactivity fallback for Phase 4A
//
// Applies only to the employee's effective Agent identity. A promoted employee
// using a legacy compatibility login must not continue receiving Agent inactivity
// enforcement after the promotion becomes effective.

import { INACTIVITY_UNAVAILABLE_MS, shouldAutoUnavailable } from "./inactivity-policy.js";
import { seedIdentityByCcms } from "./employee-identity-seed.js";

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

function effectiveIdentity() {
  const session = readSession();
  const id = String(session?.ccmsId || session?.id || "").trim();
  return id ? seedIdentityByCcms(id) : null;
}

function sessionEligible() {
  const session = readSession();
  if (!session?.id && !session?.ccmsId) return false;
  const identity = effectiveIdentity();
  if (!identity) return String(session?.roleKey || session?.role || "").toLowerCase() === "agent";
  return identity.accountStatus === "active" && identity.roleKey === "agent";
}

function readLastActivityMs() {
  const value = Number(localStorage.getItem(LAST_ACTIVITY_KEY) || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function writeLastActivityMs(now = Date.now(), force = false) {
  if (!sessionEligible()) return;
  const ms = Number(now) || Date.now();
  if (!force && ms - lastActivityWriteMs < 5_000) return;
  lastActivityWriteMs = ms;
  try { localStorage.setItem(LAST_ACTIVITY_KEY, String(ms)); } catch {}
}

function currentStatusSelect() {
  return document.getElementById("status-select");
}

export function evaluateInactivityNow(nowMs = Date.now()) {
  if (!sessionEligible()) return false;
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
  evaluateInactivityNow(Date.now());
  writeLastActivityMs(Date.now(), true);
}

function onUserChanged() {
  if (!sessionEligible()) {
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
  window.addEventListener("telesyriana:effective-identity-changed", onUserChanged);
  window.addEventListener("storage", (event) => {
    if (event.key === USER_KEY) onUserChanged();
  });
  onUserChanged();
  startTimer();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
