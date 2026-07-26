// phase4b-activity-telemetry.js — server-visible activity heartbeat for Agents
//
// Writes a very small userActivity/{CCMS} document. Effective identity is resolved
// before publishing so a promoted employee is no longer treated as an Agent merely
// because their legacy compatibility login still uses an older CCMS number.

import { db, fs } from "./firebase.js";
import {
  ACTIVITY_TRAILING_PUBLISH_MS,
  buildActivityTelemetry,
  shouldPublishActivity,
} from "./activity-telemetry-policy.js";
import { seedIdentityByCcms } from "./employee-identity-seed.js";

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

function effectiveIdentity(session = readSession()) {
  const id = clean(session?.ccmsId || session?.id);
  return id ? seedIdentityByCcms(id) : null;
}

function isAgentSession(session = readSession()) {
  const identity = effectiveIdentity(session);
  if (identity) return identity.accountStatus === "active" && identity.roleKey === "agent";
  const role = clean(session?.roleKey || session?.role).toLowerCase();
  return Boolean(session && clean(session.ccmsId || session.id) && role === "agent");
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
  const identity = effectiveIdentity(session);
  const lastActivityMs = readLastActivityMs();
  if (!lastActivityMs) return false;
  if (!force && !shouldPublishActivity({
    lastPublishedMs: lastPublishedActivityMs,
    lastActivityMs,
    nowMs: Date.now(),
  })) return false;

  const userId = clean(identity?.ccmsId || session.ccmsId || session.id);
  const telemetry = buildActivityTelemetry({
    userId,
    role: "agent",
    projectId: clean(identity?.projectId || session.projectId || "ipro") || "ipro",
    timeZone: clean(identity?.timezone || browserTimeZone()) || "Asia/Damascus",
    lastActivityMs,
  });
  if (!telemetry) return false;

  try {
    await setDoc(doc(collection(db, USER_ACTIVITY_COL), userId), {
      ...telemetry,
      employeeUid: clean(identity?.employeeUid),
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
    publishActivity({ force: true }).catch(() => {});
    return;
  }
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
  window.addEventListener("telesyriana:effective-identity-changed", onUserChanged);
  window.addEventListener("storage", (event) => {
    if (event.key === USER_KEY) onUserChanged();
  });
  onUserChanged();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
