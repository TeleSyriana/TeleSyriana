// reports.js — TeleSyriana Phase 3 Daily Reports
// Firestore collections: dailyReports + tickets (read-only summary)

import { db, fs } from "./firebase.js";

const {
  collection,
  addDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
} = fs;

const USER_KEY = "telesyrianaUser";
const REPORTS_COL = "dailyReports";
const TICKETS_COL = "tickets";

const ROLE_LEVELS = { agent: 1, supervisor: 2, manager: 3, admin: 4 };
const STAFF = {
  "0001": { id: "0001", name: "Agent Raghad", role: "agent", supervisorId: "1001" },
  "0002": { id: "0002", name: "Agent Qamar", role: "agent", supervisorId: "1001" },
  "0003": { id: "0003", name: "Agent", role: "agent", supervisorId: "1001" },
  "1001": { id: "1001", name: "Supervisor Dema", role: "supervisor" },
  "2001": { id: "2001", name: "Manager Mohammad", role: "manager" },
  "9001": { id: "9001", name: "Owner Admin", role: "admin" },
};

const REPORT_LABELS = {
  morning: "Morning Report",
  midday: "Midday Report",
  evening: "End of Shift Report",
};

const REPORT_HINTS = {
  morning: "Emergencies, fake claims, address changes, angry customers, and yesterday’s unresolved cases.",
  midday: "Solved tickets, pending emergencies, new issues, and anything that needs supervisor attention.",
  evening: "New tickets, solved tickets, delayed parcels, pending tomorrow, returns, exchanges, and sensitive cases.",
};

let currentUser = null;
let allReports = [];
let allTickets = [];
let unsubReports = null;
let unsubTickets = null;
let isHooked = false;

function el(id) { return document.getElementById(id); }
function roleLevel(u) { return ROLE_LEVELS[String(u?.role || "").toLowerCase()] || 0; }
function canSeeAll(u) { return roleLevel(u) >= ROLE_LEVELS.manager; }
function canSupervise(u) { return roleLevel(u) >= ROLE_LEVELS.supervisor; }

function getCurrentUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    return u?.id ? u : null;
  } catch {
    return null;
  }
}

function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function tsToMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v === "number") return v;
  if (typeof v === "string") return Date.parse(v) || 0;
  return 0;
}

function fmtDate(v) {
  const ms = tsToMs(v);
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

function staffName(id) {
  if (!id) return "Unassigned";
  return STAFF[id]?.name || id;
}

function visibleAgentIds() {
  if (!currentUser) return [];
  if (canSeeAll(currentUser)) return Object.keys(STAFF);
  if (currentUser.role === "supervisor") {
    return Object.values(STAFF)
      .filter((s) => s.id === currentUser.id || s.supervisorId === currentUser.id)
      .map((s) => s.id);
  }
  return [currentUser.id];
}

function canViewReport(report) {
  if (!currentUser) return false;
  if (canSeeAll(currentUser)) return true;
  if (currentUser.role === "supervisor") {
    if (report.createdBy === currentUser.id) return true;
    return STAFF[report.createdBy]?.supervisorId === currentUser.id;
  }
  return report.createdBy === currentUser.id;
}

function reportMatchesFilters(report) {
  const type = el("report-filter-type")?.value || "all";
  const owner = el("report-filter-owner")?.value || "all";
  const day = el("report-filter-day")?.value || "";
  const q = (el("report-search")?.value || "").trim().toLowerCase();

  if (type !== "all" && report.reportType !== type) return false;
  if (owner === "mine" && report.createdBy !== currentUser?.id) return false;
  if (day && report.day !== day) return false;

  if (q) {
    const hay = [
      report.title,
      report.createdByName,
      report.notes,
      report.emergencies,
      report.delayedShipments,
      report.solvedTickets,
      report.pendingTomorrow,
      report.returnsExchanges,
      report.angryCustomers,
      report.actions,
    ].join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }

  return true;
}

function ticketVisible(ticket) {
  if (!currentUser) return false;
  if (canSeeAll(currentUser)) return true;
  if (currentUser.role === "supervisor") {
    if (ticket.createdBy === currentUser.id || ticket.assignedTo === currentUser.id) return true;
    return STAFF[ticket.assignedTo]?.supervisorId === currentUser.id || !ticket.assignedTo;
  }
  return ticket.assignedTo === currentUser.id || ticket.createdBy === currentUser.id;
}

function renderTicketSnapshot() {
  const rows = allTickets.filter(ticketVisible);
  const open = rows.filter((t) => !["resolved", "closed"].includes(t.status)).length;
  const emergency = rows.filter((t) => t.priority === "emergency" && !["resolved", "closed"].includes(t.status)).length;
  const escalated = rows.filter((t) => t.status === "escalated").length;
  const delayed = rows.filter((t) => ["waiting_courier", "waiting_supplier"].includes(t.status)).length;
  const returns = rows.filter((t) => ["return", "exchange"].includes(t.type)).length;

  if (el("report-snap-open")) el("report-snap-open").textContent = String(open);
  if (el("report-snap-emergency")) el("report-snap-emergency").textContent = String(emergency);
  if (el("report-snap-escalated")) el("report-snap-escalated").textContent = String(escalated);
  if (el("report-snap-delayed")) el("report-snap-delayed").textContent = String(delayed);
  if (el("report-snap-returns")) el("report-snap-returns").textContent = String(returns);
}

function setTemplateForType(type) {
  const hint = el("report-type-hint");
  if (hint) hint.textContent = REPORT_HINTS[type] || "Daily support summary.";

  const title = el("report-title");
  if (title && !title.value.trim()) title.value = REPORT_LABELS[type] || "Daily Report";
}

function showReportAlert(message, danger = false) {
  const box = el("report-alert");
  if (!box) return;
  box.textContent = message;
  box.classList.remove("hidden");
  box.classList.toggle("danger", Boolean(danger));
  setTimeout(() => box.classList.add("hidden"), 3500);
}

function renderReports() {
  const list = el("reports-list");
  const empty = el("reports-empty");
  if (!list || !empty) return;

  const visible = allReports.filter(canViewReport).filter(reportMatchesFilters);
  list.innerHTML = "";
  empty.classList.toggle("hidden", visible.length > 0);

  visible.forEach((r) => {
    const card = document.createElement("article");
    card.className = `report-row report-${r.reportType || "general"}`;
    card.innerHTML = `
      <div class="report-row-head">
        <div>
          <strong>${REPORT_LABELS[r.reportType] || r.title || "Report"}</strong>
          <div class="report-row-sub">${r.day || "—"} • ${staffName(r.createdBy)} • ${fmtDate(r.createdAt)}</div>
        </div>
        <span class="report-pill ${r.reportType || "general"}">${r.reportType || "report"}</span>
      </div>
      <div class="report-grid-read">
        ${r.emergencies ? `<div><b>Emergencies:</b> ${escapeHtml(r.emergencies)}</div>` : ""}
        ${r.delayedShipments ? `<div><b>Delayed:</b> ${escapeHtml(r.delayedShipments)}</div>` : ""}
        ${r.solvedTickets ? `<div><b>Solved:</b> ${escapeHtml(r.solvedTickets)}</div>` : ""}
        ${r.pendingTomorrow ? `<div><b>Tomorrow:</b> ${escapeHtml(r.pendingTomorrow)}</div>` : ""}
        ${r.returnsExchanges ? `<div><b>Returns/Exchange:</b> ${escapeHtml(r.returnsExchanges)}</div>` : ""}
        ${r.angryCustomers ? `<div><b>Sensitive:</b> ${escapeHtml(r.angryCustomers)}</div>` : ""}
        ${r.actions ? `<div><b>Actions:</b> ${escapeHtml(r.actions)}</div>` : ""}
        ${r.notes ? `<div><b>Notes:</b> ${escapeHtml(r.notes)}</div>` : ""}
      </div>
    `;
    list.appendChild(card);
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function hookUI() {
  if (isHooked) return;
  isHooked = true;

  el("report-day")?.setAttribute("value", todayKey());
  el("report-filter-day")?.setAttribute("value", todayKey());
  setTemplateForType(el("report-type")?.value || "morning");

  el("report-type")?.addEventListener("change", (e) => setTemplateForType(e.target.value));
  el("report-form")?.addEventListener("submit", submitReport);
  el("report-clear-form")?.addEventListener("click", () => el("report-form")?.reset());
  el("report-template-btn")?.addEventListener("click", fillTemplate);

  ["report-filter-type", "report-filter-owner", "report-filter-day", "report-search"].forEach((id) => {
    el(id)?.addEventListener("input", renderReports);
    el(id)?.addEventListener("change", renderReports);
  });
}

function fillTemplate() {
  const type = el("report-type")?.value || "morning";
  if (type === "morning") {
    el("report-emergencies").value ||= "Emergency emails:\nFake claims:\nAddress changes:\nAngry customers:";
    el("report-pending").value ||= "Unresolved from yesterday:\nNeeds Mohammad/Supervisor:";
  } else if (type === "midday") {
    el("report-solved").value ||= "Solved so far:\nPending emergencies:\nNew issues:";
    el("report-actions").value ||= "Actions needed before end of shift:";
  } else {
    el("report-solved").value ||= "Tickets solved today:";
    el("report-delayed").value ||= "Delayed shipments:\nTracking not moving:";
    el("report-pending").value ||= "Cases for tomorrow:";
    el("report-returns").value ||= "Returns/exchanges:";
    el("report-angry").value ||= "Very angry/sensitive customers:";
  }
}

async function submitReport(e) {
  e.preventDefault();
  if (!currentUser) return showReportAlert("Please login first.", true);

  const type = el("report-type")?.value || "morning";
  const payload = {
    reportType: type,
    title: el("report-title")?.value?.trim() || REPORT_LABELS[type] || "Daily Report",
    day: el("report-day")?.value || todayKey(),
    createdBy: currentUser.id,
    createdByName: currentUser.name,
    role: currentUser.role,
    emergencies: el("report-emergencies")?.value?.trim() || "",
    delayedShipments: el("report-delayed")?.value?.trim() || "",
    solvedTickets: el("report-solved")?.value?.trim() || "",
    pendingTomorrow: el("report-pending")?.value?.trim() || "",
    returnsExchanges: el("report-returns")?.value?.trim() || "",
    angryCustomers: el("report-angry")?.value?.trim() || "",
    actions: el("report-actions")?.value?.trim() || "",
    notes: el("report-notes")?.value?.trim() || "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  await addDoc(collection(db, REPORTS_COL), payload);
  el("report-form")?.reset();
  el("report-day")?.setAttribute("value", todayKey());
  setTemplateForType(type);
  showReportAlert("Report saved successfully.");
}

function subscribeReports() {
  if (unsubReports) unsubReports();
  const q = query(collection(db, REPORTS_COL), orderBy("createdAt", "desc"));
  unsubReports = onSnapshot(q, (snapshot) => {
    allReports = [];
    snapshot.forEach((d) => allReports.push({ id: d.id, ...d.data() }));
    renderReports();
  }, (err) => {
    console.error("reports snapshot error", err);
    showReportAlert("Could not load reports. Check Firestore rules/indexes.", true);
  });
}

function subscribeTicketsSnapshot() {
  if (unsubTickets) unsubTickets();
  const q = query(collection(db, TICKETS_COL), orderBy("updatedAt", "desc"));
  unsubTickets = onSnapshot(q, (snapshot) => {
    allTickets = [];
    snapshot.forEach((d) => allTickets.push({ id: d.id, ...d.data() }));
    renderTicketSnapshot();
  }, (err) => {
    console.warn("reports ticket snapshot failed", err);
  });
}

function initReports() {
  currentUser = getCurrentUser();
  hookUI();
  renderTicketSnapshot();
  renderReports();

  if (!currentUser) {
    allReports = [];
    allTickets = [];
    if (unsubReports) unsubReports();
    if (unsubTickets) unsubTickets();
    unsubReports = null;
    unsubTickets = null;
    return;
  }

  subscribeReports();
  subscribeTicketsSnapshot();
}

document.addEventListener("DOMContentLoaded", initReports);
window.addEventListener("telesyriana:user-changed", initReports);
