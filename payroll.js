// payroll.js — TeleSyriana Phase 4 Hours & Payroll
// Firestore collections: agentDays + staffSettings
// Uses Phase 1 time tracking data and adds payroll/rate visibility.

import { db, fs } from "./firebase.js";

const {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  setDoc,
  serverTimestamp,
} = fs;

const USER_KEY = "telesyrianaUser";
const AGENT_DAYS_COL = "agentDays";
const STAFF_SETTINGS_COL = "staffSettings";
const BREAK_LIMIT_MIN = 45;

const ROLE_LEVELS = { agent: 1, supervisor: 2, manager: 3, admin: 4 };
const STAFF = {
  "0001": { id: "0001", name: "Agent Raghad", role: "agent", supervisorId: "1001", hourlyRate: 1.25, currency: "USD" },
  "0002": { id: "0002", name: "Agent Qamar", role: "agent", supervisorId: "1001", hourlyRate: 1.25, currency: "USD" },
  "0003": { id: "0003", name: "Agent", role: "agent", supervisorId: "1001", hourlyRate: 1.25, currency: "USD" },
  "1001": { id: "1001", name: "Supervisor Dema", role: "supervisor", hourlyRate: 1.75, currency: "USD" },
  "2001": { id: "2001", name: "Manager Mohammad", role: "manager", hourlyRate: 0, currency: "GBP" },
  "9001": { id: "9001", name: "Owner Admin", role: "admin", hourlyRate: 0, currency: "GBP" },
};

let currentUser = null;
let allDays = [];
let staffSettings = {};
let unsubDays = null;
let unsubSettings = null;
let isHooked = false;

function el(id) { return document.getElementById(id); }
function roleLevel(u) { return ROLE_LEVELS[String(u?.role || "").toLowerCase()] || 0; }
function canSeeAll(u) { return roleLevel(u) >= ROLE_LEVELS.manager; }
function canManageRates(u) { return roleLevel(u) >= ROLE_LEVELS.manager; }
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

function startOfWeek(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay(); // Sunday 0
  const diff = day === 0 ? -6 : 1 - day; // Monday first
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfWeek(date = new Date()) {
  const d = startOfWeek(date);
  d.setDate(d.getDate() + 6);
  return d;
}

function formatDuration(mins) {
  const m = Math.max(0, Math.floor(Number(mins) || 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function money(currency, amount) {
  const value = Number(amount) || 0;
  const code = currency || "USD";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(value);
  } catch {
    return `${code} ${value.toFixed(2)}`;
  }
}

function getStaffBase(id) {
  return STAFF[id] || { id, name: id || "Unknown", role: "agent", hourlyRate: 0, currency: "USD" };
}

function getStaffRate(id, row = {}) {
  const base = getStaffBase(id);
  const override = staffSettings[id] || {};
  const rate = override.hourlyRate ?? row.hourlyRate ?? base.hourlyRate ?? 0;
  const currency = override.currency || row.currency || base.currency || "USD";
  return { hourlyRate: Number(rate) || 0, currency };
}

function visibleStaffIds() {
  if (!currentUser) return [];
  if (canSeeAll(currentUser)) return Object.keys(STAFF);
  if (currentUser.role === "supervisor") {
    return Object.values(STAFF)
      .filter((s) => s.id === currentUser.id || s.supervisorId === currentUser.id)
      .map((s) => s.id);
  }
  return [currentUser.id];
}

function canViewRow(row) {
  if (!currentUser) return false;
  if (canSeeAll(currentUser)) return true;
  if (currentUser.role === "supervisor") {
    if (row.userId === currentUser.id) return true;
    return getStaffBase(row.userId).supervisorId === currentUser.id || row.supervisorId === currentUser.id;
  }
  return row.userId === currentUser.id;
}

function staffLabel(id) {
  const s = getStaffBase(id);
  const rate = getStaffRate(id);
  return `${s.name} (${id}) — ${rate.currency} ${Number(rate.hourlyRate || 0).toFixed(2)}/hr`;
}

function populateStaffFilters() {
  const filter = el("payroll-staff-filter");
  const rateStaff = el("payroll-rate-staff");
  const visibleIds = visibleStaffIds();

  if (filter) {
    const existing = filter.value || "all";
    filter.innerHTML = `<option value="all">All visible staff</option>` + visibleIds.map((id) => {
      return `<option value="${id}">${staffLabel(id)}</option>`;
    }).join("");
    filter.value = visibleIds.includes(existing) ? existing : "all";
  }

  if (rateStaff) {
    const existing = rateStaff.value || "";
    const allIds = Object.keys(STAFF);
    rateStaff.innerHTML = allIds.map((id) => `<option value="${id}">${staffLabel(id)}</option>`).join("");
    if (allIds.includes(existing)) rateStaff.value = existing;
    syncRateEditor();
  }
}

function setThisWeekFilters() {
  const from = startOfWeek();
  const to = endOfWeek();
  if (el("payroll-from")) el("payroll-from").value = todayKey(from);
  if (el("payroll-to")) el("payroll-to").value = todayKey(to);
}

function getFilteredRows() {
  const from = el("payroll-from")?.value || "";
  const to = el("payroll-to")?.value || "";
  const staff = el("payroll-staff-filter")?.value || "all";

  return allDays
    .filter(canViewRow)
    .filter((row) => !from || String(row.day || "") >= from)
    .filter((row) => !to || String(row.day || "") <= to)
    .filter((row) => staff === "all" || row.userId === staff)
    .sort((a, b) => String(b.day || "").localeCompare(String(a.day || "")) || String(a.name || "").localeCompare(String(b.name || "")));
}

function workedMinutes(row) {
  return (Number(row.operationMinutes) || 0)
    + (Number(row.meetingMinutes) || 0)
    + (Number(row.handlingMinutes) || 0)
    + (Number(row.breakUsedMinutes) || 0);
}

function renderPayroll() {
  const body = el("payroll-table-body");
  const empty = el("payroll-empty");
  if (!body || !empty) return;

  const rows = getFilteredRows();
  body.innerHTML = "";
  empty.classList.toggle("hidden", rows.length > 0);

  let totalWorked = 0;
  let totalOperation = 0;
  let totalBreak = 0;
  let lateBreaks = 0;
  const payByCurrency = {};

  rows.forEach((row) => {
    const staff = getStaffBase(row.userId);
    const rate = getStaffRate(row.userId, row);
    const worked = workedMinutes(row);
    const op = Number(row.operationMinutes) || 0;
    const br = Number(row.breakUsedMinutes) || 0;
    const pay = (worked / 60) * rate.hourlyRate;

    totalWorked += worked;
    totalOperation += op;
    totalBreak += br;
    if (br > BREAK_LIMIT_MIN) lateBreaks += 1;
    payByCurrency[rate.currency] = (payByCurrency[rate.currency] || 0) + pay;

    const breakNote = br > BREAK_LIMIT_MIN
      ? `<span class="payroll-pill danger">Over by ${formatDuration(br - BREAK_LIMIT_MIN)}</span>`
      : `<span class="payroll-pill ok">OK</span>`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.day || "—"}</td>
      <td>${row.name || staff.name}<div class="payroll-sub">${row.userId || "—"}</div></td>
      <td>${String(row.role || staff.role || "agent").toUpperCase()}</td>
      <td><span class="sup-status-pill status-${row.status || "unavailable"}">${row.status || "unavailable"}</span></td>
      <td>${formatDuration(row.operationMinutes)}</td>
      <td>${formatDuration(row.meetingMinutes)}</td>
      <td>${formatDuration(row.handlingMinutes)}</td>
      <td>${formatDuration(row.breakUsedMinutes)}</td>
      <td>${formatDuration(row.unavailableMinutes)}</td>
      <td><strong>${formatDuration(worked)}</strong></td>
      <td>${rate.currency} ${rate.hourlyRate.toFixed(2)}/h</td>
      <td><strong>${money(rate.currency, pay)}</strong></td>
      <td>${breakNote}</td>
    `;
    body.appendChild(tr);
  });

  if (el("payroll-sum-worked")) el("payroll-sum-worked").textContent = formatDuration(totalWorked);
  if (el("payroll-sum-operation")) el("payroll-sum-operation").textContent = formatDuration(totalOperation);
  if (el("payroll-sum-break")) el("payroll-sum-break").textContent = formatDuration(totalBreak);
  if (el("payroll-sum-late")) el("payroll-sum-late").textContent = String(lateBreaks);
  if (el("payroll-sum-pay")) {
    const parts = Object.entries(payByCurrency).map(([currency, amount]) => money(currency, amount));
    el("payroll-sum-pay").textContent = parts.length ? parts.join(" + ") : "—";
  }
}

function syncRateEditor() {
  const id = el("payroll-rate-staff")?.value;
  if (!id) return;
  const rate = getStaffRate(id);
  if (el("payroll-rate-value")) el("payroll-rate-value").value = String(rate.hourlyRate || 0);
  if (el("payroll-rate-currency")) el("payroll-rate-currency").value = rate.currency || "USD";
  const status = el("payroll-rate-status");
  if (status) status.textContent = `Current saved rate: ${rate.currency || "USD"} ${Number(rate.hourlyRate || 0).toFixed(2)} / hour`;
}


function showAlert(message, danger = false) {
  const box = el("payroll-alert");
  if (!box) return;
  box.textContent = message;
  box.classList.remove("hidden");
  box.classList.toggle("danger", Boolean(danger));
  setTimeout(() => box.classList.add("hidden"), 3500);
}

async function saveRate() {
  if (!currentUser || !canManageRates(currentUser)) return showAlert("Only Manager/Admin can update rates.", true);
  const id = el("payroll-rate-staff")?.value;
  const hourlyRate = Number(el("payroll-rate-value")?.value || 0);
  const currency = el("payroll-rate-currency")?.value || "USD";
  if (!id) return showAlert("Select staff member first.", true);
  if (Number.isNaN(hourlyRate) || hourlyRate < 0) return showAlert("Hourly rate must be 0 or higher.", true);

  try {
    await setDoc(doc(collection(db, STAFF_SETTINGS_COL), id), {
      userId: id,
      hourlyRate,
      currency,
      updatedBy: currentUser.id,
      updatedByName: currentUser.name,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    staffSettings[id] = { ...(staffSettings[id] || {}), hourlyRate, currency };
    populateStaffFilters();
    renderPayroll();
    syncRateEditor();
    showAlert(`Rate saved: ${currency} ${hourlyRate.toFixed(2)} / hour.`);
  } catch (err) {
    console.error("saveRate failed", err);
    showAlert("Rate was not saved. Check Firestore permissions or internet.", true);
  }
}

function subscribePayroll() {
  if (unsubDays) unsubDays();
  if (unsubSettings) unsubSettings();

  unsubDays = onSnapshot(query(collection(db, AGENT_DAYS_COL), orderBy("day", "desc")), (snap) => {
    allDays = [];
    snap.forEach((d) => allDays.push({ id: d.id, ...d.data() }));
    renderPayroll();
  }, (err) => {
    console.error("Payroll agentDays listener failed", err);
    showAlert("Could not load hours. Check Firestore rules/indexes.", true);
  });

  unsubSettings = onSnapshot(collection(db, STAFF_SETTINGS_COL), (snap) => {
    staffSettings = {};
    snap.forEach((d) => { staffSettings[d.id] = d.data(); });
    populateStaffFilters();
    renderPayroll();
  }, (err) => {
    console.error("Payroll staffSettings listener failed", err);
  });
}

function setPermissionsUI() {
  const panel = el("payroll-rate-panel");
  if (panel) panel.classList.toggle("hidden", !canManageRates(currentUser));
}

function hookPayroll() {
  if (isHooked) return;
  isHooked = true;

  el("payroll-this-week")?.addEventListener("click", () => { setThisWeekFilters(); renderPayroll(); });
  el("payroll-refresh")?.addEventListener("click", () => renderPayroll());
  el("payroll-staff-filter")?.addEventListener("change", renderPayroll);
  el("payroll-from")?.addEventListener("change", renderPayroll);
  el("payroll-to")?.addEventListener("change", renderPayroll);
  el("payroll-rate-staff")?.addEventListener("change", syncRateEditor);
  el("payroll-save-rate")?.addEventListener("click", saveRate);
}

function init() {
  currentUser = getCurrentUser();
  populateStaffFilters();
  setThisWeekFilters();
  setPermissionsUI();
  if (currentUser) subscribePayroll();
}

window.addEventListener("telesyriana:user-changed", () => {
  currentUser = getCurrentUser();
  populateStaffFilters();
  setThisWeekFilters();
  setPermissionsUI();
  renderPayroll();
  if (currentUser) subscribePayroll();
});

document.addEventListener("DOMContentLoaded", () => {
  hookPayroll();
  init();
});
