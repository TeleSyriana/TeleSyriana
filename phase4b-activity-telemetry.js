// phase4b-activity-telemetry.js — server-visible activity heartbeat for Agents
//
// Writes a very small userActivity/{CCMS} document. It is intentionally separate
// from userPresence so the server watchdog can query only due activity records.
// Continuous activity is throttled to at most one publish every 2 minutes, while
// a trailing publish captures the user's final activity shortly after they go idle.

import { db, fs } from "./firebase.js";
import {
  ACTIVITY_TRAILING_PUBLISH_MS,
  buildActivityTelemetry,
  shouldPublishActivity,
} from "./activity-telemetry-policy.js";

const { collection, doc, setDoc, serverTimestamp } = fs;
const USER_KEY = "telesyrianaUser";
const LAST_ACTIVITY_KEY = "telesyrianaLastActivityMs";
const USER_ACTIVITY_COL = "userActivity";
let lastPublishedActivityMs = 0;
let trailingTimer = null;
let hooked = false;

function clean(value) {
  return String(value ?? "").trim();
}

function readSession() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }
  catch { return null; }
}

function roleOf(session) {
  const role = clean(session?.roleKey || session?.role).toLowerCase();
  if (role === "agent") return "agent";
  return role;
}

function isAgentSession(session = readSession()) {
  return Boolean(session && clean(session.ccmsId || session.id) && roleOf(session) === "agent");
}

function readLastActivityMs() {
  const value = Number(localStorage.getItem(LAST_ACTIVITY_KEY) || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function writeLocalActivity(nowMs = Date.now()) {
  const ms = Number(nowMs) || Date.now();
  try { localStorage.setItem(LAST_ACTIVITY_KEY, String(ms)); } catch {}
  return ms;
}

function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Damascus"; }
  catch { return "Asia/Damascus"; }
}

async function publishActivity({ force = false } = {}) {
  const session = readSession();
  if (!isAgentSession(session)) return false;
  const lastActivityMs = readLastActivityMs();
  if (!lastActivityMs) return false;
  if (!force && !shouldPublishActivity({
    lastPublishedMs: lastPublishedActivityMs,
    lastActivityMs,
    nowMs: Date.now(),
  })) return false;

  const userId = clean(session.ccmsId || session.id);
  const telemetry = buildActivityTelemetry({
    userId,
    role: "agent",
    projectId: clean(session.projectId || "ipro") || "ipro",
    timeZone: browserTimeZone(),
    lastActivityMs,
  });
  if (!telemetry) return false;

  try {
    await setDoc(doc(collection(db, USER_ACTIVITY_COL), userId), {
      ...telemetry,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    lastPublishedActivityMs = telemetry.lastActivityMs;
    return true;
  } catch (error) {
    console.warn("Activity telemetry publish failed", error);
    return false;
  }
}

function scheduleTrailingPublish() {
  if (trailingTimer) clearTimeout(trailingTimer);
  trailingTimer = setTimeout(() => {
    trailingTimer = null;
    publishActivity({ force: true }).catch(() => {});
  }, ACTIVITY_TRAILING_PUBLISH_MS);
}

function onActivity() {
  if (!isAgentSession()) return;
  writeLocalActivity(Date.now());
  publishActivity().catch(() => {});
  scheduleTrailingPublish();
}

function onVisibilityChange() {
  if (!isAgentSession()) return;
  if (document.hidden) {
    // Publish the last real activity before browsers throttle background timers.
    publishActivity({ force: true }).catch(() => {});
    return;
  }
  // Returning to TeleSyriana is itself activity. Phase 4A evaluates the previous
  // idle duration first and may already have changed the status to Unavailable.
  writeLocalActivity(Date.now());
  publishActivity({ force: true }).catch(() => {});
}

function onUserChanged() {
  lastPublishedActivityMs = 0;
  if (trailingTimer) clearTimeout(trailingTimer);
  trailingTimer = null;
  if (!isAgentSession()) return;
  if (!readLastActivityMs()) writeLocalActivity(Date.now());
  publishActivity({ force: true }).catch(() => {});
}

function boot() {
  if (hooked) return;
  hooked = true;
  ["pointerdown", "keydown", "touchstart", "wheel"].forEach((name) => {
    document.addEventListener(name, onActivity, { passive: true, capture: true });
  });
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("telesyriana:user-changed", onUserChanged);
  window.addEventListener("storage", (event) => {
    if (event.key === USER_KEY) onUserChanged();
  });
  onUserChanged();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
