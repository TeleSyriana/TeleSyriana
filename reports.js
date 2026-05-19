// reports.js — TeleSyriana Phase 3 Daily Reports
// Firestore collections: dailyReports + tickets (read-only summary)

import { db, fs } from "./firebase.js";

const {
  collection,
  addDoc,
  doc,
  updateDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
} = fs;

const USER_KEY = "telesyrianaUser";
const REPORTS_COL = "dailyReports";
const TICKETS_COL = "tickets";

const ROLE_LEVELS = { agent: 1, supervisor: 2, hr: 3, manager: 3, admin: 4 };
const STAFF = {
  "0001": { id: "0001", name: "Owner Jack Smith", role: "admin" },
  "1001": { id: "1001", name: "Manager Mohammad Safar", role: "manager" },
  "2001": { id: "2001", name: "Supervisor Dema Shabar", role: "supervisor" },
  "3001": { id: "3001", name: "HR Fatima Kaka", role: "hr" },
  "9001": { id: "9001", name: "Agent Raghad Moussa", role: "agent", supervisorId: "2001" },
  "9002": { id: "9002", name: "Agent Qamar Moussa", role: "agent", supervisorId: "2001" },
};

const REPORT_LABELS = {
  morning: { ar: "تقرير صباحي", en: "Morning report" },
  midday: { ar: "تقرير منتصف اليوم", en: "Midday report" },
  evening: { ar: "تقرير نهاية الدوام", en: "End of shift report" },
};

const REPORT_HINTS = {
  morning: { ar: "طوارئ، ادعاءات fake claims، تغييرات العنوان، عملاء غاضبون، وحالات الأمس غير المحلولة.", en: "Emergencies, fake claims, address changes, angry customers, and yesterday’s unresolved cases." },
  midday: { ar: "التذاكر المحلولة، الطوارئ المعلقة، المشاكل الجديدة، وكل ما يحتاج انتباه المشرف.", en: "Solved tickets, pending emergencies, new issues, and anything that needs supervisor attention." },
  evening: { ar: "التذاكر الجديدة، التذاكر المحلولة، الشحنات المتأخرة، مهام الغد، الإرجاع، والاستبدال، والحالات الحساسة.", en: "New tickets, solved tickets, delayed parcels, pending tomorrow, returns, exchanges, and sensitive cases." },
};

let currentUser = null;
let allReports = [];
let allTickets = [];
let unsubReports = null;
let unsubTickets = null;
let isHooked = false;
let selectedReportId = null;

function el(id) { return document.getElementById(id); }
function reportLang() { return ((document.body?.dataset?.language || document.documentElement.lang || 'ar') === 'ar') ? 'ar' : 'en'; }
function rt(ar, en) { return reportLang() === 'ar' ? ar : en; }
function reportTypeLabel(type) { const item = REPORT_LABELS[type]; return item ? (item[reportLang()] || item.en) : (reportLang() === 'ar' ? 'تقرير يومي' : 'Daily report'); }
function reportHintText(type) { const item = REPORT_HINTS[type]; return item ? (item[reportLang()] || item.en) : ''; }
function translateReportsStatic() {
  const title = document.querySelector('#page-reports h2'); if (title) title.textContent = rt('التقارير اليومية', 'Daily reports');
  const sub = document.querySelector('#page-reports > .card > .reports-top p.subtitle'); if (sub) sub.textContent = rt('Morning • Midday • End of shift — support handover and emergency visibility', 'Morning • Midday • End of shift — support handover and emergency visibility');
  const histTitle = document.querySelector('#page-reports .reports-history-head h3'); if (histTitle) histTitle.textContent = rt('سجل التقارير', 'Reports log');
}
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
      report.pendingغداً,
      report.returnsExchanges,
      report.angryالعميلs,
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
  if (title && !title.value.trim()) title.value = reportTypeLabel(type);
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
          <strong>${r.title || reportTypeLabel(r.reportType) || rt("تقرير", "Report")}</strong>
          <div class="report-row-sub">${r.day || "—"} • ${staffName(r.createdBy)} • ${fmtDate(r.createdAt)}</div>
        </div>
        <span class="report-pill ${r.reportType || "general"}">${r.reportType || "report"}</span>
      </div>
      <div class="report-grid-read">
        ${r.emergencies ? `<div><b>${rt("طوارئ", "Emergency")}:</b> ${escapeHtml(r.emergencies)}</div>` : ""}
        ${r.delayedShipments ? `<div><b>Delayed:</b> ${escapeHtml(r.delayedShipments)}</div>` : ""}
        ${r.solvedTickets ? `<div><b>${rt("محلول", "Solved") }:</b> ${escapeHtml(r.solvedTickets)}</div>` : ""}
        ${r.pendingغداً ? `<div><b>${rt("غداً", "Tomorrow")}:</b> ${escapeHtml(r.pendingغداً)}</div>` : ""}
        ${r.returnsExchanges ? `<div><b>Returns/Exchange:</b> ${escapeHtml(r.returnsExchanges)}</div>` : ""}
        ${r.angryالعميلs ? `<div><b>${rt("حساس", "Sensitive")}:</b> ${escapeHtml(r.angryالعميلs)}</div>` : ""}
        ${r.actions ? `<div><b>Actions:</b> ${escapeHtml(r.actions)}</div>` : ""}
        ${r.notes ? `<div><b>Notes:</b> ${escapeHtml(r.notes)}</div>` : ""}
      </div>
    `;
    card.addEventListener("click", () => openReportModal(r.id));
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


function closeReportModal() {
  document.getElementById("report-modal")?.classList.add("hidden");
  selectedReportId = null;
}

function openReportModal(id) {
  const r = allReports.find((x) => x.id === id);
  if (!r || !canViewReport(r)) return;
  selectedReportId = id;
  const modal = el("report-modal");
  if (!modal) return;
  if (el("report-modal-title")) el("report-modal-title").textContent = r.title || reportTypeLabel(r.reportType) || rt("تقرير", "Report");
  if (el("report-modal-sub")) el("report-modal-sub").textContent = `${r.day || "—"} • ${staffName(r.createdBy)} • ${fmtDate(r.createdAt)}`;
  const map = {
    "report-edit-emergencies": r.emergencies || "",
    "report-edit-delayed": r.delayedShipments || "",
    "report-edit-solved": r.solvedTickets || "",
    "report-edit-pending": r.pendingغداً || "",
    "report-edit-returns": r.returnsExchanges || "",
    "report-edit-angry": r.angryالعميلs || "",
    "report-edit-actions": r.actions || "",
    "report-edit-notes": r.notes || "",
  };
  Object.entries(map).forEach(([id, value]) => { if (el(id)) el(id).value = value; });
  modal.classList.remove("hidden");
}

async function saveReportEdit() {
  if (!selectedReportId) return;
  try {
    await updateDoc(doc(db, REPORTS_COL, selectedReportId), {
      emergencies: el("report-edit-emergencies")?.value?.trim() || "",
      delayedShipments: el("report-edit-delayed")?.value?.trim() || "",
      solvedTickets: el("report-edit-solved")?.value?.trim() || "",
      pendingغداً: el("report-edit-pending")?.value?.trim() || "",
      returnsExchanges: el("report-edit-returns")?.value?.trim() || "",
      angryالعميلs: el("report-edit-angry")?.value?.trim() || "",
      actions: el("report-edit-actions")?.value?.trim() || "",
      notes: el("report-edit-notes")?.value?.trim() || "",
      updatedAt: serverTimestamp(),
      updatedBy: currentUser?.id || "",
    });
    showReportAlert("تم تحديث التقرير.");
    closeReportModal();
  } catch (err) {
    console.error("save report edit failed", err);
    showReportAlert("لم يتم حفظ تعديلات التقرير. تحقق من صلاحيات Firestore أو الاتصال.", true);
  }
}

function hookUI() {
  if (isHooked) return;
  isHooked = true;

  if (el("report-day") && !el("report-day").value) el("report-day").value = todayKey();
  if (el("report-filter-day") && !el("report-filter-day").value) el("report-filter-day").value = todayKey();
  setTemplateForType(el("report-type")?.value || "morning");

  el("report-type")?.addEventListener("change", (e) => setTemplateForType(e.target.value));
  el("report-form")?.addEventListener("submit", submitReport);
  el("report-clear-form")?.addEventListener("click", () => {
    const type = el("report-type")?.value || "morning";
    el("report-form")?.reset();
    if (el("report-type")) el("report-type").value = type;
    if (el("report-day")) el("report-day").value = todayKey();
    setTemplateForType(type);
  });
  el("report-template-btn")?.addEventListener("click", fillTemplate);
  el("report-save-edit")?.addEventListener("click", saveReportEdit);
  document.querySelectorAll("[data-report-close]").forEach((btn) => btn.addEventListener("click", closeReportModal));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeReportModal(); });

  ["report-filter-type", "report-filter-owner", "report-filter-day", "report-search"].forEach((id) => {
    el(id)?.addEventListener("input", renderReports);
    el(id)?.addEventListener("change", renderReports);
  });
}

function fillTemplate() {
  const type = el("report-type")?.value || "morning";
  if (type === "morning") {
    el("report-emergencies").value ||= "طارئ emails:\nFake claims:\nAddress changes:\nAngry customers:";
    el("report-pending").value ||= "Unresolved from yesterday:\nNeeds Mohammad/Supervisor:";
  } else if (type === "midday") {
    el("report-solved").value ||= "محلول so far:\nPending emergencies:\nNew issues:";
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
  if (!currentUser) return showReportAlert(rt("يرجى تسجيل الدخول أولاً.", "Please log in first."), true);

  const type = el("report-type")?.value || "morning";
  const payload = {
    reportType: type,
    title: el("report-title")?.value?.trim() || reportTypeLabel(type),
    day: el("report-day")?.value || todayKey(),
    createdBy: currentUser.id,
    createdByName: currentUser.name,
    role: currentUser.role,
    emergencies: el("report-emergencies")?.value?.trim() || "",
    delayedShipments: el("report-delayed")?.value?.trim() || "",
    solvedTickets: el("report-solved")?.value?.trim() || "",
    pendingغداً: el("report-pending")?.value?.trim() || "",
    returnsExchanges: el("report-returns")?.value?.trim() || "",
    angryالعميلs: el("report-angry")?.value?.trim() || "",
    actions: el("report-actions")?.value?.trim() || "",
    notes: el("report-notes")?.value?.trim() || "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await addDoc(collection(db, REPORTS_COL), payload);
    el("report-form")?.reset();
    if (el("report-type")) el("report-type").value = type;
    if (el("report-day")) el("report-day").value = todayKey();
    setTemplateForType(type);
    showReportAlert(rt("تم حفظ التقرير بنجاح.", "Report saved successfully."));
  } catch (err) {
    console.error("report save failed", err);
    showReportAlert(rt("لم يتم حفظ التقرير. تحقق من صلاحيات Firestore أو الاتصال.", "Report could not be saved. Check Firestore permissions or connection."), true);
  }
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
    showReportAlert(rt("تعذر تحميل التقارير. تحقق من قواعد أو فهارس Firestore.", "Could not load reports. Check Firestore rules or indexes."), true);
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
  translateReportsStatic();
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

window.addEventListener("telesyriana:language-changed", () => { translateReportsStatic(); setTemplateForType(el("report-type")?.value || "morning"); renderTicketSnapshot(); renderReports(); });
