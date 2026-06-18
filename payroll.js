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
const DEFAULT_SHIFT_TARGET_MIN = 8 * 60;
const SHIFT_PRESETS = { part_time: 4 * 60, full_time: 8 * 60, custom: null };

const PAYROLL_I18N = {
  ar: {
    title: "الساعات والرواتب",
    subtitle: "متابعة ساعات العمل، الاستراحة 45 دقيقة، التأخير، والأجر المتوقع.",
    from: "من",
    to: "إلى",
    staff: "الموظف",
    allVisibleStaff: "كل الموظفين الظاهرين",
    thisWeek: "هذا الأسبوع",
    refresh: "تحديث",
    pressReview: "عرض المراجعة",
    hideReview: "إخفاء المراجعة",
    reviewTitle: "مراجعة الأيام",
    reviewSubtitle: "اعرض كل يوم عمل في التقويم مع ساعات العمل والأجر المتوقع لذلك اليوم.",
    totalWorked: "إجمالي العمل",
    shiftTarget: "هدف الدوام",
    difference: "فرق الدوام",
    operation: "وقت التشغيل",
    breakUsed: "الاستراحة المستخدمة",
    lateBreaks: "الاستراحات المتأخرة",
    estimatedPay: "الأجر المتوقع",
    settingsTitle: "إعدادات دوام الفريق",
    settingsSubtitle: "يمكن للمشرف أو المدير أو الأدمن تحديد دوام 4 ساعات، 8 ساعات، أو دوام مخصص. تعديل الأجر للمدير والأدمن فقط.",
    staffMember: "الموظف",
    shiftType: "نوع الدوام",
    partTime: "دوام جزئي — 4 ساعات",
    fullTime: "دوام كامل — 8 ساعات",
    custom: "مخصص",
    customHours: "ساعات مخصصة",
    hourlyRate: "الأجر بالساعة",
    currency: "العملة",
    saveStaffSettings: "حفظ إعدادات الموظف",
    selectStaffStatus: "اختر موظفاً لعرض الإعدادات الحالية.",
    date: "التاريخ",
    agent: "الموظف",
    role: "الدور",
    status: "الحالة",
    operating: "تشغيل",
    meeting: "اجتماع",
    handling: "متابعة",
    break: "استراحة",
    unavailable: "غير متاح",
    work: "العمل",
    wage: "الأجر",
    breakNote: "ملاحظة الاستراحة",
    noRows: "لا توجد سجلات رواتب لهذه الفترة.",
    remaining: "متبقي",
    over: "زيادة",
    ok: "جيد",
    overBy: "تجاوز بـ",
    shift: "دوام",
    hour: "ساعة",
    current: "الحالي",
    selected: "المختار",
    rateLocked: "الأجر مقفل للمشرف",
    saved: "تم الحفظ",
    onlyManagers: "فقط المشرف أو المدير أو الأدمن يمكنه تعديل الدوام.",
    selectStaffFirst: "اختر الموظف أولاً.",
    invalidShift: "هدف الدوام يجب أن يكون بين 1 و 24 ساعة.",
    invalidRate: "الأجر بالساعة يجب أن يكون 0 أو أكثر.",
    saveFailed: "لم يتم حفظ الإعدادات. تحقق من صلاحيات Firestore أو الاتصال.",
    couldNotLoad: "تعذر تحميل الساعات. تحقق من الصلاحيات أو الفهارس.",
  },
  en: {
    title: "Payroll & Hours",
    subtitle: "Track working hours, 45-minute breaks, delays, and estimated pay.",
    from: "From",
    to: "To",
    staff: "Staff",
    allVisibleStaff: "All visible staff",
    thisWeek: "This week",
    refresh: "Refresh",
    pressReview: "Press review",
    hideReview: "Hide review",
    reviewTitle: "Daily calendar review",
    reviewSubtitle: "See every calendar day worked with the worked hours and estimated earning for that day.",
    totalWorked: "Total worked",
    shiftTarget: "Shift target",
    difference: "Difference",
    operation: "Operation",
    breakUsed: "Break used",
    lateBreaks: "Late breaks",
    estimatedPay: "Estimated pay",
    settingsTitle: "Staff shift settings",
    settingsSubtitle: "Supervisors, Managers, and Admins can set 4h part-time, 8h full-time, or custom shift targets. Only Managers/Admins can edit hourly rates.",
    staffMember: "Staff member",
    shiftType: "Shift type",
    partTime: "Part time — 4 hours",
    fullTime: "Full time — 8 hours",
    custom: "Custom",
    customHours: "Custom hours",
    hourlyRate: "Hourly rate",
    currency: "Currency",
    saveStaffSettings: "Save staff settings",
    selectStaffStatus: "Select a staff member to view current settings.",
    date: "Date",
    agent: "Agent",
    role: "Role",
    status: "Status",
    operating: "Operating",
    meeting: "Meeting",
    handling: "Handling",
    break: "Break",
    unavailable: "Unavailable",
    work: "Work",
    wage: "Wage",
    breakNote: "Break note",
    noRows: "No payroll records for this period.",
    remaining: "remaining",
    over: "over",
    ok: "OK",
    overBy: "Over by",
    shift: "shift",
    hour: "hour",
    current: "Current",
    selected: "Selected",
    rateLocked: "rate locked for supervisor",
    saved: "Saved",
    onlyManagers: "Only Supervisor, Manager, or Admin can update shift settings.",
    selectStaffFirst: "Select staff member first.",
    invalidShift: "Shift target must be between 1 and 24 hours.",
    invalidRate: "Hourly rate must be 0 or higher.",
    saveFailed: "Staff settings were not saved. Check Firestore permissions or internet.",
    couldNotLoad: "Could not load hours. Check Firestore rules/indexes.",
  }
};

function lang() {
  try {
    const bodyLang = document.body?.dataset?.language;
    const saved = localStorage.getItem("telesyrianaLanguage") || localStorage.getItem("telesyrianaLang");
    const value = bodyLang || saved || document.documentElement.lang || "ar";
    return String(value).toLowerCase().startsWith("en") ? "en" : "ar";
  } catch { return "ar"; }
}
function tr(key) { return PAYROLL_I18N[lang()]?.[key] || PAYROLL_I18N.en[key] || key; }


const ROLE_LEVELS = { agent: 1, supervisor: 2, hr: 3, manager: 3, admin: 4 };
const STAFF = {
  "0001": { id: "0001", name: "Owner Jack Smith", role: "admin", hourlyRate: 0, currency: "GBP" },
  "1001": { id: "1001", name: "Manager Mohammad Safar", role: "manager", hourlyRate: 5.8, currency: "GBP" },
  "2001": { id: "2001", name: "Supervisor Dema Shabar", role: "supervisor", hourlyRate: 5.8, currency: "GBP" },
  "3001": { id: "3001", name: "HR Fatima Kaka", role: "hr", hourlyRate: 5.8, currency: "GBP" },
  "9001": { id: "9001", name: "Agent Raghad Moussa", role: "agent", supervisorId: "2001", hourlyRate: 1.15, currency: "USD" },
  "9002": { id: "9002", name: "Agent Qamar Moussa", role: "agent", supervisorId: "2001", hourlyRate: 1.15, currency: "USD" },
};

let currentUser = null;
let allDays = [];
let staffSettings = {};
let unsubDays = null;
let unsubSettings = null;
let isHooked = false;
let payrollReviewOpen = false;

function el(id) { return document.getElementById(id); }
function roleLevel(u) { return ROLE_LEVELS[String(u?.role || "").toLowerCase()] || 0; }
function canSeeAll(u) { return roleLevel(u) >= ROLE_LEVELS.manager; }
function canManageRates(u) { return roleLevel(u) >= ROLE_LEVELS.manager; }
function canManageShifts(u) { return roleLevel(u) >= ROLE_LEVELS.supervisor; }
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

function formatCalendarDay(dayKey) {
  const raw = String(dayKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "—";
  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(lang() === "ar" ? "ar" : "en-GB", {
      weekday: "long",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(date);
  } catch {
    return date.toDateString();
  }
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
  const isAr = lang() === "ar";
  if (m < 60) return isAr ? `${m} د` : `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (isAr) return r ? `${h}س ${r}د` : `${h}س`;
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

function getStaffShift(id, row = {}) {
  const override = staffSettings[id] || {};
  const minutes = Number(override.shiftTargetMinutes ?? row.shiftTargetMinutes ?? DEFAULT_SHIFT_TARGET_MIN);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_SHIFT_TARGET_MIN;
}

function shiftModeForMinutes(minutes) {
  const m = Number(minutes) || DEFAULT_SHIFT_TARGET_MIN;
  if (m === SHIFT_PRESETS.part_time) return "part_time";
  if (m === SHIFT_PRESETS.full_time) return "full_time";
  return "custom";
}

function shiftDifferenceHtml(diffMin) {
  const diff = Math.round(Number(diffMin) || 0);
  if (diff >= 0) return `<span class="payroll-pill warn">${formatDuration(diff)} ${tr("remaining")}</span>`;
  return `<span class="payroll-pill ok">${formatDuration(Math.abs(diff))} ${tr("over")}</span>`;
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
  const rateSuffix = lang() === "ar" ? "ساعة" : "hr";
  return `${s.name} (${id}) — ${formatDuration(getStaffShift(id))} ${tr("shift")} • ${rate.currency} ${Number(rate.hourlyRate || 0).toFixed(2)}/${rateSuffix}`;
}

function populateStaffFilters() {
  const filter = el("payroll-staff-filter");
  const rateStaff = el("payroll-rate-staff");
  const visibleIds = visibleStaffIds();

  if (filter) {
    const existing = filter.value || "all";
    filter.innerHTML = `<option value="all">${tr("allVisibleStaff")}</option>` + visibleIds.map((id) => {
      return `<option value="${id}">${staffLabel(id)}</option>`;
    }).join("");
    filter.value = visibleIds.includes(existing) ? existing : "all";
  }

  if (rateStaff) {
    const existing = rateStaff.value || "";
    const editableIds = canSeeAll(currentUser) ? Object.keys(STAFF) : visibleIds;
    rateStaff.innerHTML = editableIds.map((id) => `<option value="${id}">${staffLabel(id)}</option>`).join("");
    if (editableIds.includes(existing)) rateStaff.value = existing;
    else if (editableIds.length) rateStaff.value = editableIds[0];
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

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value;
}

function translatePayrollStatic() {
  const isAr = lang() === "ar";
  const page = el("page-payroll");
  if (page) page.dataset.payrollLang = isAr ? "ar" : "en";
  setText("payroll-title", tr("title"));
  setText("payroll-subtitle", tr("subtitle"));
  setText("payroll-label-from", tr("from"));
  setText("payroll-label-to", tr("to"));
  setText("payroll-label-staff-filter", tr("staff"));
  setText("payroll-this-week", tr("thisWeek"));
  setText("payroll-refresh", tr("refresh"));
  setText("payroll-review-toggle", payrollReviewOpen ? tr("hideReview") : tr("pressReview"));
  setText("payroll-review-title", tr("reviewTitle"));
  setText("payroll-review-subtitle", tr("reviewSubtitle"));
  setText("payroll-snap-worked-label", tr("totalWorked"));
  setText("payroll-snap-target-label", tr("shiftTarget"));
  setText("payroll-snap-diff-label", tr("difference"));
  setText("payroll-snap-operation-label", tr("operation"));
  setText("payroll-snap-break-label", tr("breakUsed"));
  setText("payroll-snap-late-label", tr("lateBreaks"));
  setText("payroll-snap-pay-label", tr("estimatedPay"));
  setText("payroll-settings-title", tr("settingsTitle"));
  setText("payroll-settings-subtitle", tr("settingsSubtitle"));
  setText("payroll-label-rate-staff", tr("staffMember"));
  setText("payroll-label-shift-mode", tr("shiftType"));
  setText("payroll-label-custom-hours", tr("customHours"));
  setText("payroll-label-hourly-rate", tr("hourlyRate"));
  setText("payroll-label-currency", tr("currency"));
  setText("payroll-save-rate", tr("saveStaffSettings"));
  const mode = el("payroll-shift-mode");
  if (mode) {
    const selected = mode.value;
    const labels = { part_time: tr("partTime"), full_time: tr("fullTime"), custom: tr("custom") };
    Array.from(mode.options || []).forEach((opt) => { opt.textContent = labels[opt.value] || opt.textContent; });
    mode.value = selected || "full_time";
  }
  const head = el("payroll-table-head-row");
  if (head) {
    head.innerHTML = [tr("date"), tr("agent"), tr("role"), tr("status"), tr("operating"), tr("meeting"), tr("handling"), tr("break"), tr("unavailable"), tr("work"), tr("shiftTarget"), tr("difference"), tr("wage"), tr("estimatedPay"), tr("breakNote")]
      .map((label) => `<th>${label}</th>`).join("");
  }
  const empty = el("payroll-empty");
  if (empty) empty.textContent = tr("noRows");
}

function renderPayroll() {
  translatePayrollStatic();
  const body = el("payroll-table-body");
  const empty = el("payroll-empty");
  const reviewSection = el("payroll-review-section");
  if (reviewSection) reviewSection.classList.toggle("hidden", !payrollReviewOpen);
  if (!body || !empty) return;

  const rows = getFilteredRows();
  body.innerHTML = "";
  empty.classList.toggle("hidden", rows.length > 0);

  let totalWorked = 0;
  let totalتشغيل = 0;
  let totalاستراحة = 0;
  let totalShiftTarget = 0;
  let lateاستراحةs = 0;
  const payByCurrency = {};

  rows.forEach((row) => {
    const staff = getStaffBase(row.userId);
    const rate = getStaffRate(row.userId, row);
    const worked = workedMinutes(row);
    const shiftTarget = getStaffShift(row.userId, row);
    const shiftDiff = shiftTarget - worked;
    const op = Number(row.operationMinutes) || 0;
    const br = Number(row.breakUsedMinutes) || 0;
    const pay = (worked / 60) * rate.hourlyRate;

    totalWorked += worked;
    totalShiftTarget += shiftTarget;
    totalتشغيل += op;
    totalاستراحة += br;
    if (br > BREAK_LIMIT_MIN) lateاستراحةs += 1;
    payByCurrency[rate.currency] = (payByCurrency[rate.currency] || 0) + pay;

    const breakNote = br > BREAK_LIMIT_MIN
      ? `<span class="payroll-pill danger">${tr("overBy")} ${formatDuration(br - BREAK_LIMIT_MIN)}</span>`
      : `<span class="payroll-pill ok">${tr("ok")}</span>`;

    const rowEl = document.createElement("tr");
    rowEl.innerHTML = `
      <td><strong>${row.day || "—"}</strong><div class="payroll-sub">${formatCalendarDay(row.day)}</div></td>
      <td>${row.name || staff.name}<div class="payroll-sub">${row.userId || "—"}</div></td>
      <td>${String(row.role || staff.role || "agent").toUpperCase()}</td>
      <td><span class="sup-status-pill status-${row.status || "unavailable"}">${row.status || "unavailable"}</span></td>
      <td>${formatDuration(row.operationMinutes)}</td>
      <td>${formatDuration(row.meetingMinutes)}</td>
      <td>${formatDuration(row.handlingMinutes)}</td>
      <td>${formatDuration(row.breakUsedMinutes)}</td>
      <td>${formatDuration(row.unavailableMinutes)}</td>
      <td><strong>${formatDuration(worked)}</strong></td>
      <td>${formatDuration(shiftTarget)}</td>
      <td>${shiftDifferenceHtml(shiftDiff)}</td>
      <td>${rate.currency} ${rate.hourlyRate.toFixed(2)}/h</td>
      <td><strong>${money(rate.currency, pay)}</strong></td>
      <td>${breakNote}</td>
    `;
    body.appendChild(rowEl);
  });

  if (el("payroll-sum-worked")) el("payroll-sum-worked").textContent = formatDuration(totalWorked);
  if (el("payroll-sum-target")) el("payroll-sum-target").textContent = formatDuration(totalShiftTarget);
  if (el("payroll-sum-diff")) el("payroll-sum-diff").textContent = totalShiftTarget ? (totalShiftTarget - totalWorked >= 0 ? `${formatDuration(totalShiftTarget - totalWorked)} ${tr("remaining")}` : `${formatDuration(totalWorked - totalShiftTarget)} ${tr("over")}`) : "—";
  if (el("payroll-sum-operation")) el("payroll-sum-operation").textContent = formatDuration(totalتشغيل);
  if (el("payroll-sum-break")) el("payroll-sum-break").textContent = formatDuration(totalاستراحة);
  if (el("payroll-sum-late")) el("payroll-sum-late").textContent = String(lateاستراحةs);
  if (el("payroll-sum-pay")) {
    const parts = Object.entries(payByCurrency).map(([currency, amount]) => money(currency, amount));
    el("payroll-sum-pay").textContent = parts.length ? parts.join(" + ") : "—";
  }
}

function syncRateEditor() {
  const id = el("payroll-rate-staff")?.value;
  if (!id) return;
  const rate = getStaffRate(id);
  const shiftTarget = getStaffShift(id);
  const shiftMode = shiftModeForMinutes(shiftTarget);
  const canEditRate = canManageRates(currentUser);

  if (el("payroll-rate-value")) {
    el("payroll-rate-value").value = String(rate.hourlyRate || 0);
    el("payroll-rate-value").disabled = !canEditRate;
  }
  if (el("payroll-rate-currency")) {
    el("payroll-rate-currency").value = rate.currency || "USD";
    el("payroll-rate-currency").disabled = !canEditRate;
  }
  if (el("payroll-shift-mode")) el("payroll-shift-mode").value = shiftMode;
  if (el("payroll-shift-custom")) {
    el("payroll-shift-custom").value = String((shiftTarget / 60).toFixed(shiftTarget % 60 ? 2 : 0));
    el("payroll-shift-custom").disabled = shiftMode !== "custom";
  }
  const status = el("payroll-rate-status");
  if (status) {
    const rateText = canEditRate ? `${rate.currency || "USD"} ${Number(rate.hourlyRate || 0).toFixed(2)} / ${tr("hour")}` : tr("rateLocked");
    status.textContent = `${tr("current")}: ${formatDuration(shiftTarget)} ${tr("shift")} • ${rateText}`;
  }
}

function previewShiftEditor() {
  const mode = el("payroll-shift-mode")?.value || "full_time";
  const custom = el("payroll-shift-custom");
  if (custom) {
    custom.disabled = mode !== "custom";
    if (mode === "part_time") custom.value = "4";
    else if (mode === "full_time") custom.value = "8";
    else if (!custom.value || Number(custom.value) <= 0) custom.value = "8";
  }
  const id = el("payroll-rate-staff")?.value;
  const status = el("payroll-rate-status");
  if (status && id) {
    const draftMinutes = selectedShiftTargetMinutes();
    const rate = getStaffRate(id);
    const canEditRate = canManageRates(currentUser);
    const rateText = canEditRate ? `${el("payroll-rate-currency")?.value || rate.currency || "USD"} ${Number(el("payroll-rate-value")?.value || rate.hourlyRate || 0).toFixed(2)} / ${tr("hour")}` : tr("rateLocked");
    status.textContent = `${tr("selected")}: ${draftMinutes ? formatDuration(draftMinutes) : tr("custom")} ${tr("shift")} • ${rateText}`;
  }
}

function showAlert(message, danger = false) {
  const box = el("payroll-alert");
  if (!box) return;
  box.textContent = message;
  box.classList.remove("hidden");
  box.classList.toggle("danger", Boolean(danger));
  setTimeout(() => box.classList.add("hidden"), 3500);
}

function selectedShiftTargetMinutes() {
  const mode = el("payroll-shift-mode")?.value || "full_time";
  if (mode === "part_time") return SHIFT_PRESETS.part_time;
  if (mode === "full_time") return SHIFT_PRESETS.full_time;
  const hours = Number(el("payroll-shift-custom")?.value || 0);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return null;
  return Math.round(hours * 60);
}

async function saveStaffSettings() {
  if (!currentUser || !canManageShifts(currentUser)) return showAlert(tr("onlyManagers"), true);
  const id = el("payroll-rate-staff")?.value;
  const shiftTargetMinutes = selectedShiftTargetMinutes();
  const canEditRate = canManageRates(currentUser);
  const hourlyRate = Number(el("payroll-rate-value")?.value || 0);
  const currency = el("payroll-rate-currency")?.value || "USD";
  if (!id) return showAlert(tr("selectStaffFirst"), true);
  if (!shiftTargetMinutes) return showAlert(tr("invalidShift"), true);
  if (canEditRate && (Number.isNaN(hourlyRate) || hourlyRate < 0)) return showAlert(tr("invalidRate"), true);

  const payload = {
    userId: id,
    shiftTargetMinutes,
    shiftType: shiftModeForMinutes(shiftTargetMinutes),
    updatedBy: currentUser.id,
    updatedByName: currentUser.name,
    updatedAt: serverTimestamp(),
  };
  if (canEditRate) {
    payload.hourlyRate = hourlyRate;
    payload.currency = currency;
  }

  try {
    await setDoc(doc(collection(db, STAFF_SETTINGS_COL), id), payload, { merge: true });

    staffSettings[id] = { ...(staffSettings[id] || {}), ...payload };
    populateStaffFilters();
    renderPayroll();
    syncRateEditor();
    showAlert(`${tr("saved")}: ${formatDuration(shiftTargetMinutes)} ${tr("shift")}${canEditRate ? ` • ${currency} ${hourlyRate.toFixed(2)} / ${tr("hour")}` : ""}.`);
  } catch (err) {
    console.error("saveStaffSettings failed", err);
    showAlert(tr("saveFailed"), true);
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
    showAlert(tr("couldNotLoad"), true);
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
  if (panel) panel.classList.toggle("hidden", !canManageShifts(currentUser));
  const rateOnlyEls = document.querySelectorAll("[data-rate-only]");
  rateOnlyEls.forEach((node) => node.classList.toggle("is-disabled", !canManageRates(currentUser)));
}

function hookPayroll() {
  if (isHooked) return;
  isHooked = true;

  el("payroll-this-week")?.addEventListener("click", () => { setThisWeekFilters(); renderPayroll(); });
  el("payroll-refresh")?.addEventListener("click", () => renderPayroll());
  el("payroll-review-toggle")?.addEventListener("click", () => {
    payrollReviewOpen = !payrollReviewOpen;
    renderPayroll();
  });
  el("payroll-staff-filter")?.addEventListener("change", renderPayroll);
  el("payroll-from")?.addEventListener("change", renderPayroll);
  el("payroll-to")?.addEventListener("change", renderPayroll);
  el("payroll-rate-staff")?.addEventListener("change", syncRateEditor);
  el("payroll-shift-mode")?.addEventListener("change", previewShiftEditor);
  el("payroll-shift-custom")?.addEventListener("input", previewShiftEditor);
  el("payroll-rate-value")?.addEventListener("input", previewShiftEditor);
  el("payroll-rate-currency")?.addEventListener("change", previewShiftEditor);
  el("payroll-save-rate")?.addEventListener("click", saveStaffSettings);
}

function init() {
  translatePayrollStatic();
  currentUser = getCurrentUser();
  populateStaffFilters();
  setThisWeekFilters();
  setPermissionsUI();
  if (currentUser) subscribePayroll();
}

window.addEventListener("telesyriana:language-changed", () => {
  translatePayrollStatic();
  populateStaffFilters();
  renderPayroll();
  syncRateEditor();
});

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
