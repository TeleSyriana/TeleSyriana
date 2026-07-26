// phase2-ticket-dashboard-live.js — live metric bridge without extra Firestore reads
//
// Consumes only the sanitized in-memory snapshot published by the existing Tickets
// engine. This module imports no Firebase code and starts no listeners of its own.

import { CURRENT_EMPLOYEE_IDENTITY_SEED, seedIdentityByCcms } from "./employee-identity-seed.js";
import { buildAcmDashboard, buildSupervisorDashboard } from "./role-dashboard-shadow.js";

const USER_KEY = "telesyrianaUser";
const PAGE_ID = "page-projects-teams-v2";
let latestRows = null;

function clean(value) {
  return String(value ?? "").trim();
}

function isArabic() {
  return clean(document.body?.dataset?.language || document.documentElement.lang || "en").toLowerCase() === "ar";
}

function t(ar, en) {
  return isArabic() ? ar : en;
}

function readSession() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }
  catch { return null; }
}

function actorIdentity() {
  const session = readSession();
  const id = clean(session?.ccmsId || session?.id);
  if (!id) return null;
  return seedIdentityByCcms(id) || null;
}

function readCurrentSnapshot() {
  try {
    const getter = window.__TS_TICKET_DASHBOARD_SNAPSHOT__;
    if (typeof getter !== "function") return null;
    const rows = getter();
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

function projectPageVisible() {
  const page = document.getElementById(PAGE_ID);
  return Boolean(page && !page.classList.contains("hidden"));
}

function metricCardValues(summary) {
  return [
    summary?.tickets?.active ?? 0,
    summary?.tickets?.emergency ?? 0,
    summary?.tickets?.resolvedToday ?? 0,
    summary?.tickets?.overdue ?? 0,
  ];
}

function setMetricState(values, message, mode = "loaded") {
  const page = document.getElementById(PAGE_ID);
  if (!page) return;
  const nodes = Array.from(page.querySelectorAll(".p2-live strong"));
  if (nodes.length < 4) return;
  nodes.slice(0, 4).forEach((node, index) => {
    node.textContent = values ? String(values[index] ?? 0) : "—";
    node.dataset.metricState = mode;
  });
  const note = page.querySelector(".p2-live-grid + .p2-muted");
  if (note) note.textContent = message;
}

function refreshDashboardMetrics() {
  if (!projectPageVisible()) return;
  const actor = actorIdentity();
  if (!actor) return;
  const role = clean(actor.roleKey).toLowerCase();
  if (!["acm", "supervisor"].includes(role)) return;

  const rows = latestRows || readCurrentSnapshot();
  if (!rows) {
    setMetricState(
      null,
      t(
        "افتح صفحة Tickets مرة واحدة لتحميل أحدث أرقام التذاكر. لن ننشئ مستمع Firestore إضافياً لهذه اللوحة.",
        "Open Tickets once to load the latest ticket metrics. This dashboard will not start an extra Firestore listener."
      ),
      "waiting"
    );
    return;
  }

  try {
    const summary = role === "acm"
      ? buildAcmDashboard(actor, { employees: CURRENT_EMPLOYEE_IDENTITY_SEED, tickets: rows, now: new Date() })
      : buildSupervisorDashboard(actor, { employees: CURRENT_EMPLOYEE_IDENTITY_SEED, tickets: rows, now: new Date() });
    setMetricState(
      metricCardValues(summary),
      t(
        `آخر لقطة من Tickets: ${rows.length} تذكرة ضمن المصدر المحمّل لهذا الحساب.`,
        `Latest Tickets snapshot: ${rows.length} ticket(s) loaded by this account's existing Ticket engine.`
      ),
      "loaded"
    );
  } catch (error) {
    setMetricState(null, String(error?.message || error || t("تعذر حساب أرقام التذاكر.", "Could not calculate ticket metrics.")), "error");
  }
}

function acceptSnapshot(rows) {
  latestRows = Array.isArray(rows) ? rows.map((row) => ({ ...row })) : null;
  refreshDashboardMetrics();
}

window.addEventListener("telesyriana:ticket-dashboard-snapshot", (event) => {
  acceptSnapshot(event?.detail?.rows);
});

window.addEventListener("telesyriana:user-changed", () => {
  latestRows = readCurrentSnapshot();
  setTimeout(refreshDashboardMetrics, 0);
});
window.addEventListener("telesyriana:language-changed", () => setTimeout(refreshDashboardMetrics, 0));

document.addEventListener("click", (event) => {
  const nav = event.target?.closest?.(".nav-link[data-page]");
  if (nav?.dataset?.page === "projects-teams-v2") setTimeout(refreshDashboardMetrics, 0);
});

latestRows = readCurrentSnapshot();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setTimeout(refreshDashboardMetrics, 0), { once: true });
} else {
  setTimeout(refreshDashboardMetrics, 0);
}
