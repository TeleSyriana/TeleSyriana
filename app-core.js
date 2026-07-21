// app.js — TeleSyriana Agent Access Panel (Firestore + daily docs + multi-page UI)

import { db, fs } from "./firebase.js";

const {
  doc,
  setDoc,
  getDoc,
  collection,
  query,
  where,
  onSnapshot,
  serverTimestamp,
} = fs;

// Demo users
// Phase 1 role model:
// - Agent codes start with 000x
// - Supervisor codes start with 100x
// - Manager codes start with 200x
// - Admin/Owner codes start with 900x
const USERS = {
  "0001": { password: "Aa095142332415!", role: "admin", name: "Jack Smith", hourlyRate: 0, currency: "GBP" },
  "1001": { password: "0951", role: "manager", name: "Mohammad Safar", hourlyRate: 5.8, currency: "GBP" },
  "2001": { password: "2411", role: "supervisor", name: "Dema Shabar", hourlyRate: 5.8, currency: "GBP" },
  "3001": { password: "2411", role: "hr", name: "Fatima Kaka", hourlyRate: 5.8, currency: "GBP" },
  "9001": { password: "Welcome2026!", role: "agent", name: "Raghad Moussa", supervisorId: "2001", hourlyRate: 1.15, currency: "USD" },
  "9002": { password: "Welcome2026!", role: "agent", name: "Qamar Moussa", supervisorId: "2001", hourlyRate: 1.15, currency: "USD" },
  "9003": { password: "Reema2026!", role: "agent", name: "Reema Obaid", supervisorId: "2001", hourlyRate: 1.15, currency: "USD" },
};

const ROLE_LEVELS = {
  agent: 1,
  supervisor: 2,
  hr: 3,
  manager: 3,
  admin: 4,
};

function normaliseRole(role) {
  return String(role || "agent").toLowerCase();
}

function roleLevel(userOrRole) {
  const role = typeof userOrRole === "string" ? userOrRole : userOrRole?.role;
  return ROLE_LEVELS[normaliseRole(role)] || 0;
}

function hasRoleAtLeast(user, role) {
  return roleLevel(user) >= roleLevel(role);
}

function canViewTeamDashboard(user) {
  return hasRoleAtLeast(user, "supervisor");
}

function canViewAllStaff(user) {
  return hasRoleAtLeast(user, "manager");
}


function roleLabel(role) {
  const isAr = typeof getLanguage === "function" ? getLanguage() === "ar" : (document.body?.dataset?.language || "ar") === "ar";
  const arMap = { agent: "موظف دعم", supervisor: "مشرف", manager: "مدير", hr: "الموارد البشرية", admin: "أدمن" };
  const enMap = { agent: "Agent", supervisor: "Supervisor", manager: "Manager", hr: "HR", admin: "Admin" };
  const key = String(role || "").toLowerCase();
  return (isAr ? arMap[key] : enMap[key]) || role || "—";
}

function safeUserPayload(id) {
  const u = USERS[id];
  if (!u) return null;
  const { password, ...safe } = u;
  return { id, ...safe };
}

const USER_KEY = "telesyrianaUser";
const PROFILE_CACHE_PREFIX = "telesyrianaProfile";
const STATE_KEY = "telesyrianaState";
const BREAK_LIMIT_MIN = 45;

// ✅ Work target (8 hours)
const DEFAULT_WORK_TARGET_MIN = 8 * 60;
let currentWorkTargetMin = DEFAULT_WORK_TARGET_MIN;
let currentStaffSettings = {};

const AGENT_DAYS_COL = "agentDays";
const USER_PROFILE_COL = "userProfiles";
const STAFF_SETTINGS_COL = "staffSettings";
const USER_PRESENCE_COL = "userPresence";

let currentUser = null;
let state = null;
let timerId = null;
let supUnsub = null;
let presenceUnsub = null;
let presenceTimerId = null;
let issueCalendarUnsub = null;
let staffSettingsUnsub = null;
let issueStatsByDay = {};

// widgets timers
let clockIntervalId = null;

// floating chat UI
let floatUIHooked = false;

// 🔥 Firestore sync throttle (prevents 429)
const SYNC_EVERY_MS = 60 * 1000; // 1 minute
let lastSyncMs = 0;
let lastSyncStatus = null;
let lastSyncPayloadHash = "";

// App startup diagnostics. This keeps slow staff devices informed instead of showing a frozen screen.
const APP_LOADING_TIMEOUT_MS = 10_000;
let appLoadingTimer = null;
let appLoadingVisible = false;

function loadingText(ar, en) {
  try { return getLanguage() === "ar" ? ar : en; } catch { return ar || en || ""; }
}

function ensureAppLoadingOverlay() {
  let overlay = document.getElementById("app-startup-loader");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "app-startup-loader";
  overlay.className = "startup-loader hidden";
  overlay.innerHTML = `
    <div class="startup-loader-card" role="status" aria-live="polite">
      <div class="startup-loader-logo">Tele<span>Syriana</span></div>
      <div id="startup-loader-title" class="startup-loader-title">Loading…</div>
      <div class="startup-progress-track"><div id="startup-progress-fill" class="startup-progress-fill" style="width:0%"></div></div>
      <div class="startup-progress-row">
        <span id="startup-loader-step">Starting…</span>
        <strong id="startup-loader-percent">0%</strong>
      </div>
      <button id="startup-loader-retry" type="button" class="btn-secondary startup-loader-retry hidden">Retry</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("#startup-loader-retry")?.addEventListener("click", () => window.location.reload());
  return overlay;
}

function setAppLoading(percent, title, step, options = {}) {
  const overlay = ensureAppLoadingOverlay();
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  appLoadingVisible = true;
  overlay.classList.remove("hidden", "slow", "danger");
  if (options.slow) overlay.classList.add("slow");
  if (options.danger) overlay.classList.add("danger");
  const fill = overlay.querySelector("#startup-progress-fill");
  const pctEl = overlay.querySelector("#startup-loader-percent");
  const titleEl = overlay.querySelector("#startup-loader-title");
  const stepEl = overlay.querySelector("#startup-loader-step");
  const retry = overlay.querySelector("#startup-loader-retry");
  if (fill) fill.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
  if (titleEl && title) titleEl.textContent = title;
  if (stepEl && step) stepEl.textContent = step;
  retry?.classList.toggle("hidden", !options.retry);

  if (appLoadingTimer) clearTimeout(appLoadingTimer);
  if (!options.noWatchdog && pct < 100) {
    appLoadingTimer = setTimeout(() => {
      if (!appLoadingVisible) return;
      setAppLoading(
        Math.max(pct, 88),
        loadingText("التحميل بطيء على هذا الجهاز", "This device is loading slowly"),
        loadingText("غالباً الاتصال أو صلاحيات البيانات تأخرت. اضغط Retry إذا بقيت الشاشة معلقة.", "Network/data permissions are taking longer than normal. Press Retry if it stays stuck."),
        { slow: true, retry: true, noWatchdog: true }
      );
    }, APP_LOADING_TIMEOUT_MS);
  }
}

function hideAppLoading(delay = 250) {
  if (appLoadingTimer) clearTimeout(appLoadingTimer);
  appLoadingTimer = null;
  window.setTimeout(() => {
    const overlay = document.getElementById("app-startup-loader");
    if (overlay) overlay.classList.add("hidden");
    appLoadingVisible = false;
  }, delay);
}

window.addEventListener("telesyriana:tickets-loading", (event) => {
  const d = event.detail || {};
  setAppLoading(
    d.percent || 82,
    loadingText("تحميل التذاكر", "Loading tickets"),
    d.message || loadingText("جاري تحميل قائمة التذاكر المناسبة لصلاحية المستخدم…", "Loading the ticket queue for this user…")
  );
});

window.addEventListener("telesyriana:tickets-ready", (event) => {
  const d = event.detail || {};
  setAppLoading(
    100,
    loadingText("جاهز", "Ready"),
    d.message || loadingText("تم تحميل البيانات.", "Data loaded."),
    { noWatchdog: true }
  );
  hideAppLoading(450);
});

window.addEventListener("telesyriana:tickets-error", (event) => {
  const d = event.detail || {};
  setAppLoading(
    d.percent || 92,
    loadingText("تعذر تحميل التذاكر", "Tickets failed to load"),
    d.message || loadingText("تحقق من الاتصال أو صلاحيات Firestore.", "Check the connection or Firestore permissions."),
    { danger: true, retry: true, noWatchdog: true }
  );
});

/* ------------------------------ helpers --------------------------------- */


function showToast(message, type = "info", timeout = 3500) {
  const text = String(message || "");
  let wrap = document.getElementById("toast-container");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "toast-container";
    wrap.style.position = "fixed";
    wrap.style.right = "18px";
    wrap.style.bottom = "18px";
    wrap.style.zIndex = "99999";
    wrap.style.display = "grid";
    wrap.style.gap = "10px";
    document.body.appendChild(wrap);
  }

  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = text;
  el.style.maxWidth = "420px";
  el.style.padding = "12px 14px";
  el.style.borderRadius = "14px";
  el.style.boxShadow = "0 10px 30px rgba(0,0,0,.18)";
  el.style.fontWeight = "700";
  el.style.background = type === "error" ? "#fee2e2" : type === "warning" ? "#fef3c7" : type === "success" ? "#dcfce7" : "#e0f2fe";
  el.style.color = type === "error" ? "#991b1b" : type === "warning" ? "#92400e" : type === "success" ? "#166534" : "#075985";
  el.style.border = "1px solid rgba(0,0,0,.08)";

  wrap.appendChild(el);
  window.setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    el.style.transition = "opacity .2s ease, transform .2s ease";
    window.setTimeout(() => el.remove(), 220);
  }, timeout);
}

function isFirestoreDatabaseMissingError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("database (default) does not exist") || msg.includes("cloud firestore database") || msg.includes("code=not-found");
}

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function statusLabel(code) {
  const ar = getLanguage && getLanguage() === "ar";
  const labels = ar
    ? { in_operation: "قيد التشغيل", break: "استراحة", meeting: "في اجتماع", handling: "متابعة حالة", unavailable: "غير متاح" }
    : { in_operation: "Operating", break: "Break", meeting: "Meeting", handling: "Handling", unavailable: "Unavailable" };
  return labels[code] || code;
}

/**
 * ✅ Minutes -> "xx min" OR "1 hr" OR "2 hrs 13 min"
 */
function formatDuration(mins) {
  const m = Math.max(0, Math.floor(Number(mins) || 0));
  if (m < 60) return `${m} min`;

  const h = Math.floor(m / 60);
  const r = m % 60;

  const hrLabel = h === 1 ? "1 hr" : `${h} hrs`;
  if (r === 0) return hrLabel;

  return `${hrLabel} ${r} min`;
}

// ✅ Worked minutes = operation + meeting + handling + break (NO unavailable)
function computeWorkedMinutes(live) {
  const op = Number(live.operation) || 0;
  const meet = Number(live.meeting) || 0;
  const hand = Number(live.handling) || 0;
  const br = Number(live.breakUsed) || 0;
  return op + meet + hand + br;
}

/* --------------------------- Widgets (Clock/Date) ------------------------ */

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Expects IDs in HTML:
 * - #widget-clock
 * - #widget-day
 * - #widget-date
 */
function renderClockWidget() {
  const clockEl = document.getElementById("widget-clock");
  const dayEl = document.getElementById("widget-day");
  const dateEl = document.getElementById("widget-date");
  if (!clockEl || !dayEl || !dateEl) return;

  const now = new Date();
  clockEl.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  dayEl.textContent = now.toLocaleDateString(undefined, { weekday: "long" });
  dateEl.textContent = now.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/* --------------------------- Widgets (Break Ring) ------------------------ */

/**
 * Expects:
 * - #ring-progress
 * - #ring-label
 */
function setRing(percent) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const ring = document.getElementById("ring-progress");
  const label = document.getElementById("ring-label");
  if (!ring || !label) return;

  ring.setAttribute("stroke-dasharray", `${p}, 100`);
  label.textContent = `${p}%`;
}

/* --------------------------- Widgets (Work target box) ------------------- */

function getCurrentWorkTargetMin() {
  const n = Number(currentStaffSettings?.shiftTargetMinutes ?? currentWorkTargetMin ?? DEFAULT_WORK_TARGET_MIN);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WORK_TARGET_MIN;
}

function updateWorkUI(workedMin) {
  const used = Math.max(0, Math.floor(workedMin));
  const targetMin = getCurrentWorkTargetMin();
  const remaining = Math.max(0, targetMin - used);

  // text
  const workText = document.getElementById("work-text");
  const targetText = document.getElementById("work-target-text");
  const remainingText = document.getElementById("work-remaining-text");

  if (workText) workText.textContent = formatDuration(used);
  if (targetText) targetText.textContent = formatDuration(targetMin);
  if (remainingText) remainingText.textContent = formatDuration(remaining);

  // ring
  const pct =
    targetMin > 0 ? Math.min(100, Math.round((used / targetMin) * 100)) : 0;
  const ring = document.getElementById("work-ring-progress");
  const label = document.getElementById("work-ring-label");

  if (ring) ring.setAttribute("stroke-dasharray", `${pct}, 100`);
  if (label) label.textContent = `${pct}%`;
}

/* --------------------------- Widgets (Mini Calendar) --------------------- */

/**
 * Expects:
 * - #cal-title
 * - #cal-grid
 * - #cal-prev
 * - #cal-next
 */
let calRef = new Date();

function monthTitle(d) {
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function dateKeyFromValue(v) {
  try {
    const d = v?.toDate ? v.toDate() : new Date(v || Date.now());
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  } catch { return getTodayKey(); }
}

function buildMiniCalendar() {
  const titleEl = document.getElementById("cal-title");
  const gridEl = document.getElementById("cal-grid");
  if (!titleEl || !gridEl) return;

  titleEl.textContent = monthTitle(calRef);
  gridEl.innerHTML = "";

  const year = calRef.getFullYear();
  const month = calRef.getMonth();

  // Monday-first calendar
  const first = new Date(year, month, 1);
  const startDay = (first.getDay() + 6) % 7; // 0=Mon ... 6=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();

  const today = new Date();
  const isThisMonth = today.getFullYear() === year && today.getMonth() === month;

  for (let i = 0; i < 42; i++) {
    const cell = document.createElement("div");
    cell.className = "mini-day";

    const dayNum = i - startDay + 1;

    if (dayNum <= 0) {
      cell.textContent = String(prevDays + dayNum);
      cell.classList.add("muted");
    } else if (dayNum > daysInMonth) {
      cell.textContent = String(dayNum - daysInMonth);
      cell.classList.add("muted");
    } else {
      cell.textContent = String(dayNum);
      const key = `${year}-${String(month+1).padStart(2,"0")}-${String(dayNum).padStart(2,"0")}`;
      const stats = issueStatsByDay[key];
      const isToday = isThisMonth && dayNum === today.getDate();
      if (isToday) {
        const todayStats = stats || { total: 0, risk: 0, emergency: 0 };
        cell.classList.add("today");
        if (todayStats.emergency >= 1 || todayStats.risk >= 2 || todayStats.total >= 3) {
          cell.classList.add("today-danger");
        } else if (todayStats.risk >= 1 || todayStats.total >= 1) {
          cell.classList.add("today-warning");
        } else {
          cell.classList.add("today-stable");
        }
        cell.title = `${todayStats.total} active tickets • ${todayStats.risk} risk issues`;
      }
    }

    gridEl.appendChild(cell);
  }
}

function hookCalendarButtons() {
  const prev = document.getElementById("cal-prev");
  const next = document.getElementById("cal-next");
  if (!prev || !next) return;

  prev.onclick = () => {
    calRef = new Date(calRef.getFullYear(), calRef.getMonth() - 1, 1);
    buildMiniCalendar();
  };

  next.onclick = () => {
    calRef = new Date(calRef.getFullYear(), calRef.getMonth() + 1, 1);
    buildMiniCalendar();
  };
}

/* --------------------------- Live usage math ---------------------------- */

function recomputeLiveUsage(nowMs) {
  if (!state) {
    return { breakUsed: 0, operation: 0, meeting: 0, handling: 0, unavailable: 0 };
  }

  const elapsedMin = (nowMs - state.lastStatusChange) / 60000;

  let op = state.operationMinutes || 0;
  let br = state.breakUsedMinutes || 0;
  let meet = state.meetingMinutes || 0;
  let hand = state.handlingMinutes || 0;
  let unav = state.unavailableMinutes || 0;

  switch (state.status) {
    case "in_operation":
      op += elapsedMin;
      break;
    case "break":
      br += elapsedMin;
      break;
    case "meeting":
      meet += elapsedMin;
      break;
    case "handling":
      hand += elapsedMin;
      break;
    case "unavailable":
      unav += elapsedMin;
      break;
  }

  if (br > BREAK_LIMIT_MIN) br = BREAK_LIMIT_MIN;

  return { breakUsed: br, operation: op, meeting: meet, handling: hand, unavailable: unav };
}

function applyElapsedToState(nowMs) {
  if (!state) return;

  const elapsedMin = (nowMs - state.lastStatusChange) / 60000;
  if (elapsedMin <= 0) return;

  switch (state.status) {
    case "in_operation":
      state.operationMinutes += elapsedMin;
      break;
    case "break":
      state.breakUsedMinutes = Math.min(BREAK_LIMIT_MIN, state.breakUsedMinutes + elapsedMin);
      break;
    case "meeting":
      state.meetingMinutes += elapsedMin;
      break;
    case "handling":
      state.handlingMinutes += elapsedMin;
      break;
    case "unavailable":
      state.unavailableMinutes += elapsedMin;
      break;
  }

  state.lastStatusChange = nowMs;
}

/* --------------------------- Firestore sync ----------------------------- */

async function syncStateToFirestore(live, force = false) {
  if (!currentUser || !state) return;

  const now = Date.now();

  // ✅ don't spam Firestore
  if (!force) {
    // if tab is hidden, skip periodic sync
    if (document.hidden) return;

    if (now - lastSyncMs < SYNC_EVERY_MS) return;
  }

  const today = state.day || getTodayKey();
  const id = `${today}_${currentUser.id}`;
  const usage = live || recomputeLiveUsage(now);

  // ✅ small hash to avoid writing same data repeatedly
  const payloadHash = [
    state.status,
    Math.floor(usage.breakUsed),
    Math.floor(usage.operation),
    Math.floor(usage.meeting),
    Math.floor(usage.handling),
    Math.floor(usage.unavailable),
    getCurrentWorkTargetMin(),
  ].join("|");

  if (!force && payloadHash === lastSyncPayloadHash && state.status === lastSyncStatus) {
    return; // no meaningful change
  }

  const payload = {
    userId: currentUser.id,
    name: currentUser.name,
    role: currentUser.role,
    supervisorId: currentUser.supervisorId || "",
    hourlyRate: Number(currentUser.hourlyRate) || 0,
    currency: currentUser.currency || "USD",
    shiftTargetMinutes: getCurrentWorkTargetMin(),
    shiftType: getCurrentWorkTargetMin() === 4 * 60 ? "part_time" : getCurrentWorkTargetMin() === 8 * 60 ? "full_time" : "custom",
    day: today,
    status: state.status,
    loginTime: state.loginTime,
    lastStatusChange: state.lastStatusChange,
    breakUsedMinutes: usage.breakUsed,
    operationMinutes: usage.operation,
    meetingMinutes: usage.meeting,
    handlingMinutes: usage.handling,
    unavailableMinutes: usage.unavailable,
    updatedAt: serverTimestamp(),
  };

  await setDoc(doc(collection(db, AGENT_DAYS_COL), id), payload, { merge: true });

  lastSyncMs = now;
  lastSyncStatus = state.status;
  lastSyncPayloadHash = payloadHash;
}

function subscribeCurrentStaffSettings() {
  if (!currentUser?.id) return;
  try { if (staffSettingsUnsub) staffSettingsUnsub(); } catch {}
  staffSettingsUnsub = null;

  const ref = doc(collection(db, STAFF_SETTINGS_COL), currentUser.id);
  staffSettingsUnsub = onSnapshot(ref, (snap) => {
    currentStaffSettings = snap.exists() ? (snap.data() || {}) : {};
    const target = Number(currentStaffSettings.shiftTargetMinutes || DEFAULT_WORK_TARGET_MIN);
    currentWorkTargetMin = Number.isFinite(target) && target > 0 ? target : DEFAULT_WORK_TARGET_MIN;
    updateDashboardUI();
  }, (err) => {
    console.warn("staff settings listener failed", err);
    currentStaffSettings = {};
    currentWorkTargetMin = DEFAULT_WORK_TARGET_MIN;
    updateDashboardUI();
  });
}

function subscribeSupervisorDashboard() {
  if (!currentUser || !canViewTeamDashboard(currentUser)) return;
  if (supUnsub) return;

  const q = query(collection(db, AGENT_DAYS_COL), where("day", "==", getTodayKey()));

  supUnsub = onSnapshot(q, (snapshot) => {
    const rows = [];
    snapshot.forEach((d) => rows.push(d.data()));
    buildSupervisorTableFromFirestore(rows);
  });
}

/* --------------------------- Local storage ------------------------------ */

function saveState() {
  if (!state) return;
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function loadStateForToday(userId) {
  const raw = localStorage.getItem(STATE_KEY);
  if (!raw) return null;

  try {
    const s = JSON.parse(raw);
    if (s && s.userId === userId && s.day === getTodayKey()) return s;
  } catch {}
  return null;
}

/* ------------------------- Floating Chat Shell -------------------------- */
/**
 * This file only handles open/close + visibility rules.
 * messages.js will handle Firestore + content.
 */
function closeFloatingChat() {
  const panel = document.getElementById("float-chat-panel");
  if (panel) panel.classList.add("hidden");
}

function openFloatingChat() {
  const panel = document.getElementById("float-chat-panel");
  if (!panel) return;
  panel.classList.remove("hidden");
}

function toggleFloatingChat() {
  if (!currentUser) return;
  const panel = document.getElementById("float-chat-panel");
  if (!panel) return;
  const isHidden = panel.classList.contains("hidden");
  if (isHidden) openFloatingChat();
  else closeFloatingChat();
}

function hookFloatingChatUI() {
  if (floatUIHooked) return;
  floatUIHooked = true;

  const toggleBtn = document.getElementById("float-chat-toggle");
  const closeBtn = document.getElementById("float-chat-close");
  const panel = document.getElementById("float-chat-panel");

  toggleBtn?.addEventListener("click", () => {
    if (!currentUser) return;
    toggleFloatingChat();
  });

  closeBtn?.addEventListener("click", () => closeFloatingChat());

  // Click outside panel closes it
  document.addEventListener("mousedown", (e) => {
    if (!panel || panel.classList.contains("hidden")) return;
    if (panel.contains(e.target)) return;

    if (toggleBtn && (e.target === toggleBtn || toggleBtn.contains(e.target))) return;

    closeFloatingChat();
  });

  // ESC closes it
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFloatingChat();
  });

  // user changes => close it
  window.addEventListener("telesyriana:user-changed", () => closeFloatingChat());
}


/* --------------------------- Presence / Online now ----------------------- */

function pageVisibleName() {
  const active = document.querySelector(".nav-link[data-page].active");
  return active?.dataset?.page || "home";
}

function onlineStatusFromRow(row) {
  const ms = Number(row?.lastSeenMs || 0);
  if (!ms) return "offline";
  const age = Date.now() - ms;
  if (age < 90_000) return "online";
  if (age < 10 * 60_000) return "away";
  return "offline";
}

function formatLastSeen(ms) {
  const n = Number(ms || 0);
  if (!n) return "Never";
  const diff = Math.max(0, Date.now() - n);
  if (diff < 90_000) return "Live now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `Last seen ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Last seen ${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  return new Date(n).toLocaleString();
}

async function updatePresence(force = false) {
  if (!currentUser) return;
  const now = Date.now();
  const payload = {
    userId: currentUser.id,
    name: currentUser.name,
    role: currentUser.role,
    status: document.hidden ? "away" : "online",
    page: pageVisibleName(),
    lastSeenMs: now,
    updatedAt: serverTimestamp(),
  };
  try {
    await setDoc(doc(collection(db, USER_PRESENCE_COL), currentUser.id), payload, { merge: true });
  } catch (err) {
    if (force) console.warn("Presence save failed", err);
  }
}

function subscribePresence() {
  if (presenceUnsub) return;
  presenceUnsub = onSnapshot(collection(db, USER_PRESENCE_COL), (snapshot) => {
    const rows = [];
    snapshot.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    renderOnlineNow(rows);
  }, (err) => console.warn("presence listener failed", err));
}

function canViewOnlineNow(user) {
  return ["admin", "manager", "hr", "supervisor"].includes(normaliseRole(user?.role));
}

function renderOnlineNow(rows) {
  const card = document.querySelector(".online-now-card");
  const list = document.getElementById("online-now-list");
  const count = document.getElementById("online-now-count");
  if (!list || !count) return;

  // Online-now is a management visibility widget only.
  // Agents still update their own presence, but they do not see this team list.
  if (!canViewOnlineNow(currentUser)) {
    if (card) card.classList.add("hidden");
    count.textContent = "0";
    list.innerHTML = "";
    return;
  }

  if (card) card.classList.remove("hidden");
  const visible = rows
    .filter((r) => onlineStatusFromRow(r) !== "offline")
    .sort((a, b) => Number(b.lastSeenMs || 0) - Number(a.lastSeenMs || 0));
  count.textContent = String(visible.length);
  if (!visible.length) {
    list.innerHTML = `<div class="online-empty">No one online now.</div>`;
    return;
  }
  list.innerHTML = visible.map((r) => {
    const st = onlineStatusFromRow(r);
    return `<div class="online-person">
      <span class="online-dot ${st}"></span>
      <div><strong>${escapeSmall(r.name || r.userId || "User")}</strong><small>${escapeSmall(r.role || "")} • ${escapeSmall(r.page || "home")} • ${escapeSmall(formatLastSeen(r.lastSeenMs))}</small></div>
    </div>`;
  }).join("");
}

function escapeSmall(v) {
  return String(v || "").replace(/[&<>"']/g, (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[m]));
}

function stopPresenceListener() {
  if (!presenceUnsub) return;
  try { presenceUnsub(); } catch {}
  presenceUnsub = null;
}

function syncHomeRealtimeListeners(pageId = pageVisibleName()) {
  const homeActive = pageId === "home";

  if (homeActive && canViewOnlineNow(currentUser)) subscribePresence();
  else stopPresenceListener();

  if (homeActive && canViewTeamDashboard(currentUser)) subscribeSupervisorDashboard();
  else if (supUnsub) {
    try { supUnsub(); } catch {}
    supUnsub = null;
  }

  if (homeActive) subscribeIssueCalendar();
  else if (issueCalendarUnsub) {
    try { issueCalendarUnsub(); } catch {}
    issueCalendarUnsub = null;
  }
}

function startPresence() {
  if (!currentUser) return;
  syncHomeRealtimeListeners();
  updatePresence(true);
  if (presenceTimerId) clearInterval(presenceTimerId);
  presenceTimerId = setInterval(() => updatePresence(false), 60_000);
}

async function stopPresence() {
  if (presenceTimerId) clearInterval(presenceTimerId);
  presenceTimerId = null;
  if (currentUser) {
    try {
      await setDoc(doc(collection(db, USER_PRESENCE_COL), currentUser.id), {
        status: "offline",
        lastSeenMs: Date.now(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
    } catch {}
  }
}


/* --------------------------- Issue rate calendar ------------------------- */
function ticketCalendarQueriesForUser(user) {
  if (!user) return [];
  const role = normaliseRole(user.role);
  const base = collection(db, "tickets");

  // Managers/admin/HR/supervisors still see the team view. Agents get scoped queries
  // so weaker devices do not download the full ticket collection on every login.
  if (role !== "agent") return [{ key: "team", source: query(base, where("status", "in", ["open", "waiting_customer", "waiting_courier", "waiting_supplier", "escalated", "urgent"])) }];

  return [
    { key: "assigned", source: query(base, where("assignedTo", "==", user.id)) },
    { key: "created", source: query(base, where("createdBy", "==", user.id)) },
  ];
}

function updateIssueCalendarFromRows(rows) {
  const stats = {};
  const todayKey = getTodayKey();
  rows.forEach((t) => {
    const status = String(t.status || "open").toLowerCase();
    if (["resolved", "closed", "done", "cancelled", "canceled"].includes(status)) return;

    // Active unresolved issues affect Today until they are solved.
    const key = todayKey;
    if (!stats[key]) stats[key] = { total: 0, risk: 0, emergency: 0 };
    stats[key].total += 1;

    const priority = String(t.priority || "").toLowerCase();
    const risk = String(t.risk || t.customerMood || "").toLowerCase();
    const type = String(t.type || "").toLowerCase();
    const isEmergency = priority === "emergency" || status === "escalated" || status === "urgent";
    const isRisk = isEmergency || priority === "high" || risk.includes("chargeback") || risk === "high" || type === "item_not_genuine";
    if (isRisk) stats[key].risk += 1;
    if (isEmergency) stats[key].emergency += 1;
  });

  issueStatsByDay = stats;
  buildMiniCalendar();
  const summary = document.getElementById("issue-calendar-summary");
  if (summary) {
    const s = stats[todayKey] || { total: 0, risk: 0, emergency: 0 };
    if (s.emergency >= 1 || s.risk >= 2 || s.total >= 3) {
      summary.textContent = `Today: ${s.total} active issues • ${s.risk} risk issues. Emergency/overload active.`;
    } else if (s.total >= 1) {
      summary.textContent = `Today: ${s.total} active issue${s.total === 1 ? "" : "s"} • manageable.`;
    } else {
      summary.textContent = "Today: stable. No active unresolved issues.";
    }
  }
}

function subscribeIssueCalendar() {
  if (issueCalendarUnsub) return;
  try {
    const sources = ticketCalendarQueriesForUser(currentUser);
    const scopeRows = new Map();
    const unsubs = sources.map(({ key, source }) => onSnapshot(source, (snapshot) => {
      const rows = [];
      snapshot.forEach((d) => rows.push({ id: d.id, ...d.data() }));
      scopeRows.set(key, rows);

      const merged = new Map();
      scopeRows.forEach((list) => list.forEach((row) => merged.set(row.id, row)));
      updateIssueCalendarFromRows([...merged.values()]);
    }, (err) => console.warn("issue calendar listener failed", err)));

    issueCalendarUnsub = () => unsubs.forEach((fn) => { try { fn(); } catch {} });
  } catch (err) {
    console.warn("issue calendar init failed", err);
  }
}

/* --------------------------- UI init ------------------------------------ */

document.addEventListener("DOMContentLoaded", async () => {
  ensureBackgroundRemoveControl();
  applyLanguage(localStorage.getItem(LANGUAGE_KEY) || "en");
  // ✅ menu navigation
  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const page = btn.dataset.page;
      if (!page) return;
      e.preventDefault();
      switchPage(page);
      closeMobileMenu();
    });
  });

  document.getElementById("mobile-menu-toggle")?.addEventListener("click", () => {
    if (document.body.classList.contains("auth-screen") || !document.body.classList.contains("dashboard-ready")) {
      closeMobileMenu();
      return;
    }
    document.body.classList.toggle("menu-open");
    document.getElementById("mobile-menu-backdrop")?.classList.toggle("hidden", !document.body.classList.contains("menu-open"));
  });
  document.getElementById("mobile-menu-backdrop")?.addEventListener("click", closeMobileMenu);

  document.getElementById("login-form")?.addEventListener("submit", handleLogin);
  document.getElementById("logout-btn")?.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); handleLogout(); });
  document.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("#logout-btn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    handleLogout();
  }, true);
  document.getElementById("status-select")?.addEventListener("change", handleStatusChange);
  document.getElementById("settings-form")?.addEventListener("submit", handleSettingsSave);
  ensureProfilePhotoControls();

  document.querySelectorAll("[data-quick-status]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const status = btn.dataset.quickStatus;
      const sel = document.getElementById("status-select");
      if (!sel || !status) return;
      sel.value = status;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });

  hookFloatingChatUI();

  // ✅ final sync when user leaves tab or hides it
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden && currentUser && state) {
      try {
        const now = Date.now();
        const live = recomputeLiveUsage(now);
        await syncStateToFirestore(live, true);
      } catch {}
    }
    updatePresence(false).catch(() => {});
  try { translateFeaturePages(getLanguage()); setTimeout(() => translateFeaturePages(getLanguage()), 60); } catch {}
  });

  try {
    const savedUser = localStorage.getItem(USER_KEY);
    if (savedUser) {
      setAppLoading(12, loadingText("استعادة الجلسة", "Restoring session"), loadingText("تم العثور على جلسة محفوظة…", "Saved session found…"));
      const u = JSON.parse(savedUser);
      if (USERS[u.id]) {
        // Refresh saved sessions from the current role map, so role changes apply after updates.
        setAppLoading(30, loadingText("تحميل الصلاحيات", "Loading permissions"), loadingText("تحديث دور المستخدم من النظام…", "Refreshing the user role from the local role map…"));
        currentUser = safeUserPayload(u.id);
        localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
        setAppLoading(48, loadingText("تحميل جلسة اليوم", "Loading today’s session"), loadingText("قراءة حالة الدوام الحالية…", "Reading the current work state…"));
        await initStateForUser();
        setAppLoading(72, loadingText("فتح لوحة التحكم", "Opening dashboard"), loadingText("تجهيز الصفحة الرئيسية…", "Preparing the home page…"));
        showDashboard();
        window.dispatchEvent(new Event("telesyriana:user-changed"));
        return;
      }
    }
  } catch (err) {
    console.warn("Saved session ignored:", err);
    localStorage.removeItem(USER_KEY);
    setAppLoading(90, loadingText("تعذر استعادة الجلسة", "Could not restore session"), String(err?.message || err || ""), { danger: true, retry: true, noWatchdog: true });
    hideAppLoading(1200);
  }

  showLogin();
});

function closeMobileMenu() {
  document.body.classList.remove("menu-open");
  document.getElementById("mobile-menu-backdrop")?.classList.add("hidden");
}

/* -------------------------- Pages switching ----------------------------- */

function switchPage(pageId) {
  document.querySelectorAll(".page-section").forEach((pg) => pg.classList.add("hidden"));

  const target = document.getElementById(`page-${pageId}`);
  if (!target) {
    console.warn(`الصفحة غير موجودة: page-${pageId}. تحقق من معرفات HTML.`);
    return;
  }
  target.classList.remove("hidden");

  document.querySelectorAll(".nav-link[data-page]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === pageId);
  });

  updatePresence(false).catch(() => {});
  syncHomeRealtimeListeners(pageId);
  try { translateFeaturePages(getLanguage()); applyPhase21LanguagePolish(getLanguage()); setTimeout(() => applyPhase21LanguagePolish(getLanguage()), 80); } catch {}

  // floating chat toggle visibility rules
  const floatToggle = document.getElementById("float-chat-toggle");
  if (floatToggle) {
    if (!currentUser || pageId === "messages") {
      floatToggle.classList.add("hidden");
      closeFloatingChat();
    } else {
      floatToggle.classList.remove("hidden");
    }
  }
}

/* -------------------------- Login / Logout ------------------------------ */

async function handleLogin(e) {
  e.preventDefault();

  const id = document.getElementById("ccmsId")?.value?.trim() || "";
  const pw = document.getElementById("password")?.value || "";
  const submitBtn = e?.target?.querySelector('button[type="submit"]');

  if (!USERS[id]) return showError("المستخدم غير موجود. جرّب 0001 أو 1001 أو 2001 أو 3001 أو 9001 أو 9002 أو 9003.");
  if (USERS[id].password !== pw) return showError(getLanguage() === "ar" ? "كلمة المرور غير صحيحة." : "Incorrect password.");

  try {
    setAppLoading(8, loadingText("بدء تسجيل الدخول", "Starting login"), loadingText("فحص بيانات الدخول…", "Checking login details…"));
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.dataset.originalText = submitBtn.textContent;
      submitBtn.textContent = loadingText("جاري الدخول...", "Signing in...");
    }

    setAppLoading(24, loadingText("تسجيل الدخول صحيح", "Login accepted"), loadingText("تحميل دور المستخدم والصلاحيات…", "Loading user role and permissions…"));
    currentUser = safeUserPayload(id);
    localStorage.setItem(USER_KEY, JSON.stringify(currentUser));

    // reset throttling for new session
    lastSyncMs = 0;
    lastSyncStatus = null;
    lastSyncPayloadHash = "";

    document.getElementById("login-error")?.classList.add("hidden");

    setAppLoading(42, loadingText("تحميل جلسة العمل", "Loading work session"), loadingText("جاري تحميل حالة الدوام لهذا اليوم…", "Loading today’s work state…"));
    await initStateForUser();
    setAppLoading(72, loadingText("فتح لوحة التحكم", "Opening dashboard"), loadingText("تجهيز الواجهة والتقويم…", "Preparing dashboard and calendar…"));
    showDashboard();
    window.dispatchEvent(new Event("telesyriana:user-changed"));
  } catch (err) {
    console.error("Login failed:", err);
    setAppLoading(92, loadingText("فشل تسجيل الدخول", "Login failed"), String(err?.message || err || loadingText("حدث خطأ غير معروف.", "Unknown error.")), { danger: true, retry: true, noWatchdog: true });
    showError(`فشل تسجيل الدخول: ${err?.message || err}`);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = submitBtn.dataset.originalText || "دخول";
    }
  }
}

async function handleLogout() {
  // Robust logout: never let Firebase/network errors block the user from leaving the session.
  try { closeFloatingChat(); } catch {}

  try {
    if (currentUser && state) {
      const now = Date.now();
      try { applyElapsedToState(now); } catch {}
      state.status = "unavailable";
      state.lastStatusChange = now;
      try { saveState(); } catch {}
      try { await syncStateToFirestore(recomputeLiveUsage(now), true); } catch (err) { console.warn("logout sync skipped", err); }
    }
  } catch (err) {
    console.warn("logout state cleanup skipped", err);
  }

  try { await stopPresence(); } catch (err) { console.warn("logout presence skipped", err); }

  try { localStorage.removeItem(USER_KEY); } catch {}
  try { localStorage.removeItem(STATE_KEY); } catch {}

  try { window.dispatchEvent(new Event("telesyriana:user-changed")); } catch {}

  try { if (timerId) clearInterval(timerId); } catch {}
  timerId = null;

  try { if (clockIntervalId) clearInterval(clockIntervalId); } catch {}
  clockIntervalId = null;

  try { if (supUnsub) supUnsub(); } catch {}
  supUnsub = null;
  try { if (presenceUnsub) presenceUnsub(); } catch {}
  presenceUnsub = null;
  try { if (issueCalendarUnsub) issueCalendarUnsub(); } catch {}
  issueCalendarUnsub = null;
  try { if (staffSettingsUnsub) staffSettingsUnsub(); } catch {}
  staffSettingsUnsub = null;
  currentStaffSettings = {};
  currentWorkTargetMin = DEFAULT_WORK_TARGET_MIN;

  currentUser = null;
  state = null;

  showLogin();
  showToast("تم تسجيل الخروج بنجاح", "success", 2200);
}

function showError(msg) {
  const box = document.getElementById("login-error");
  if (!box) return;
  box.textContent = msg;
  box.classList.remove("hidden");
}

/* --------------------- Status change (FIX) ------------------------------ */

async function handleStatusChange(e) {
  if (!state || !currentUser) return;

  const newStatus = e.target.value;
  const now = Date.now();

  // break limit reached
  if (newStatus === "break" && state.breakUsedMinutes >= BREAK_LIMIT_MIN - 0.01) {
    alert("Daily break limit (45 minutes) already reached.");
    e.target.value = state.status;
    return;
  }

  // apply elapsed to old status
  applyElapsedToState(now);

  // set new status
  state.status = newStatus;
  state.lastStatusChange = now;
  saveState();

  const live = recomputeLiveUsage(now);

  try {
    await syncStateToFirestore(live, true); // ✅ force on real change
  } catch (err) {
    console.error("sync failed:", err);
  }

  updateDashboardUI();
}

/* ---------------------------- Init Session ------------------------------ */

function buildDefaultDayState(now = Date.now()) {
  return {
    userId: currentUser?.id || "",
    day: getTodayKey(),
    status: "in_operation",
    lastStatusChange: now,
    breakUsedMinutes: 0,
    operationMinutes: 0,
    meetingMinutes: 0,
    handlingMinutes: 0,
    unavailableMinutes: 0,
    loginTime: now,
  };
}

async function initStateForUser() {
  const today = getTodayKey();
  const now = Date.now();

  try {
    const local = loadStateForToday(currentUser.id);
    if (local) {
      state = local;
      finishInit(now);
      return;
    }

    const docId = `${today}_${currentUser.id}`;
    const ref = doc(collection(db, AGENT_DAYS_COL), docId);
    const snap = await getDoc(ref);

    if (snap.exists()) {
      const d = snap.data();
      state = {
        userId: currentUser.id,
        day: today,
        status: d.status || "in_operation",
        lastStatusChange: now,
        breakUsedMinutes: d.breakUsedMinutes || 0,
        operationMinutes: d.operationMinutes || 0,
        meetingMinutes: d.meetingMinutes || 0,
        handlingMinutes: d.handlingMinutes || 0,
        unavailableMinutes: d.unavailableMinutes || 0,
        loginTime: d.loginTime || now,
      };
    } else {
      state = buildDefaultDayState(now);
    }
  } catch (err) {
    console.error("Login state init failed. Starting local session instead:", err);
    state = buildDefaultDayState(now);
    showToast(isFirestoreDatabaseMissingError(err) ? "تم الدخول محلياً. قاعدة Firestore غير منشأة بعد." : "تم الدخول محلياً. تعذّرت قراءة Firebase؛ تحقق من القواعد أو الاتصال.", "warning", 6000);
  }

  saveState();
  finishInit(now);
}

function finishInit(now) {
  if (canViewTeamDashboard(currentUser)) subscribeSupervisorDashboard();
  subscribeCurrentStaffSettings();

  loadUserProfile().then(() => { updateDashboardUI(); updatePresence(true).catch(() => {}); });
  startTimer();

  const live = recomputeLiveUsage(now);

  updateBreakUI(live.breakUsed);
  updateStatusMinutesUI(live);
  updateWorkUI(computeWorkedMinutes(live));

  renderClockWidget();
  buildMiniCalendar();
  hookCalendarButtons();

  // ✅ one forced sync at init
  syncStateToFirestore(live, true).catch(() => {});
}

/* ----------------------------- Timer ------------------------------------ */

function startTimer() {
  if (timerId) clearInterval(timerId);
  timerId = setInterval(tick, 5000); // UI updates every 5 sec; Firestore sync is still throttled
  tick();
}

async function tick() {
  if (!state) return;

  const now = Date.now();
  const live = recomputeLiveUsage(now);

  if (state.status === "break" && live.breakUsed >= BREAK_LIMIT_MIN) {
    applyElapsedToState(now);
    state.status = "unavailable";
    state.lastStatusChange = now;
    saveState();
    alert("Break limit reached. Status set to Unavailable.");

    try {
      await syncStateToFirestore(recomputeLiveUsage(now), true); // ✅ force
    } catch {}

    updateDashboardUI();
    return;
  }

  updateBreakUI(live.breakUsed);
  updateStatusMinutesUI(live);
  updateWorkUI(computeWorkedMinutes(live));

  // ✅ throttled sync (won't spam)
  try {
    await syncStateToFirestore(live, false);
  } catch (err) {
    console.error("tick sync error:", err);
  }
}

/* ------------------------- Dashboard UI --------------------------------- */

function updateDashboardUI() {
  if (!currentUser || !state) return;

  const welcomeTitle = document.getElementById("welcome-title");
  const welcomeSubtitle = document.getElementById("welcome-subtitle");
  const statusValue = document.getElementById("status-value");
  const statusSelect = document.getElementById("status-select");

  if (welcomeTitle) welcomeTitle.textContent = getLanguage() === "ar" ? `مرحباً، ${currentUser.name}` : `Welcome, ${currentUser.name}`;
  renderHomeProfilePhoto(currentProfileCache().profilePhoto || "");
  if (welcomeSubtitle) {
    welcomeSubtitle.textContent = getLanguage() === "ar" ? `مسجل الدخول بصفة ${roleLabel(currentUser.role)} (CCMS: ${currentUser.id})` : `Logged in as ${String(currentUser.role || "").toUpperCase()} (CCMS: ${currentUser.id})`;
  }

  if (statusValue) {
    statusValue.textContent = statusLabel(state.status);
    statusValue.className = `status-value status-${state.status}`;
  }

  if (statusSelect) statusSelect.value = state.status;

  const live = recomputeLiveUsage(Date.now());
  updateBreakUI(live.breakUsed);
  updateStatusMinutesUI(live);
  updateWorkUI(computeWorkedMinutes(live));

  const supPanel = document.getElementById("supervisor-panel");
  if (supPanel) supPanel.classList.toggle("hidden", !canViewTeamDashboard(currentUser));
}

function updateBreakUI(used) {
  const usedMin = Math.floor(used);
  const remaining = Math.max(0, BREAK_LIMIT_MIN - usedMin);

  const usedEl = document.getElementById("break-used");
  const remEl = document.getElementById("break-remaining");
  if (usedEl) usedEl.textContent = usedMin;
  if (remEl) remEl.textContent = remaining;

  const breakText = document.getElementById("break-text");
  if (breakText) breakText.textContent = `${usedMin} / ${BREAK_LIMIT_MIN}`;

  setRing((usedMin / BREAK_LIMIT_MIN) * 100);
}

function updateStatusMinutesUI(live) {
  const opEl = document.getElementById("op-min");
  const meetEl = document.getElementById("meet-min");
  const handEl = document.getElementById("hand-min");

  if (opEl) opEl.textContent = formatDuration(live.operation);
  if (meetEl) meetEl.textContent = formatDuration(live.meeting);
  if (handEl) handEl.textContent = formatDuration(live.handling);
}

/* -------------------------- Supervisor Table ---------------------------- */

function buildSupervisorTableFromFirestore(rows) {
  const body = document.getElementById("sup-table-body");
  if (!body) return;
  body.innerHTML = "";

  const totals = { in_operation: 0, break: 0, meeting: 0, handling: 0, unavailable: 0 };

  const visibleRows = rows.filter((r) => {
    if (!currentUser) return false;
    if (canViewAllStaff(currentUser)) return true;
    // Supervisors only see agents assigned to them.
    return r.role === "agent" && String(r.supervisorId || "") === String(currentUser.id);
  });

  visibleRows
    .forEach((r) => {
      const status = r.status || "unavailable";
      if (Object.prototype.hasOwnProperty.call(totals, status)) totals[status]++;

      const workedMinutes =
        (Number(r.operationMinutes) || 0) +
        (Number(r.meetingMinutes) || 0) +
        (Number(r.handlingMinutes) || 0) +
        (Number(r.breakUsedMinutes) || 0);
      const pay = ((workedMinutes / 60) * (Number(r.hourlyRate) || 0)).toFixed(2);

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.name}</td>
        <td>${r.userId}</td>
        <td>${roleLabel(r.role)}</td>
        <td><span class="sup-status-pill status-${status}">${statusLabel(status)}</span></td>
        <td>${formatDuration(r.operationMinutes || 0)}</td>
        <td>${Math.floor(r.breakUsedMinutes || 0)} min</td>
        <td>${formatDuration(r.meetingMinutes || 0)}</td>
        <td>${formatDuration(r.unavailableMinutes || 0)}</td>
        <td>${r.loginTime ? new Date(r.loginTime).toLocaleString("ar") : "لم يسجل"}</td>
        <td>${r.currency || "USD"} ${pay}</td>
      `;
      body.appendChild(tr);
    });

  const sumOp = document.getElementById("sum-op");
  const sumBreak = document.getElementById("sum-break");
  const sumMeet = document.getElementById("sum-meet");
  const sumUnavail = document.getElementById("sum-unavail");

  if (sumOp) sumOp.textContent = totals.in_operation;
  if (sumBreak) sumBreak.textContent = totals.break;
  if (sumMeet) sumMeet.textContent = totals.meeting;
  if (sumUnavail) sumUnavail.textContent = totals.unavailable;
}

/* ----------------------------- Settings --------------------------------- */

function profileCacheKey(userId) {
  return `${PROFILE_CACHE_PREFIX}:${userId}`;
}


function getProfileInitial(name) {
  const parts = String(name || currentUser?.name || currentUser?.id || "U").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "U";
}

function currentProfileCache() {
  if (!currentUser?.id) return {};
  try { return JSON.parse(localStorage.getItem(profileCacheKey(currentUser.id)) || "{}"); } catch { return {}; }
}

function saveCurrentProfileCache(patch = {}) {
  if (!currentUser?.id) return {};
  const merged = { ...currentProfileCache(), ...patch };
  localStorage.setItem(profileCacheKey(currentUser.id), JSON.stringify(merged));
  return merged;
}

function setRoundImageOrInitial(container, imgEl, initialEl, imageData, name) {
  if (initialEl) initialEl.textContent = getProfileInitial(name);
  if (imgEl) {
    if (imageData) {
      imgEl.src = imageData;
      imgEl.classList.remove("hidden");
    } else {
      imgEl.removeAttribute("src");
      imgEl.classList.add("hidden");
    }
  }
  if (container) container.classList.toggle("has-photo", Boolean(imageData));
}

function renderSettingsProfilePhoto(imageData = "", name = currentUser?.name) {
  const picker = document.getElementById("settings-photo-picker");
  const img = document.getElementById("settings-photo-img");
  const initial = document.getElementById("settings-photo-initial");
  const removeBtn = document.getElementById("remove-profile-photo-btn");
  setRoundImageOrInitial(picker, img, initial, imageData, name);
  if (removeBtn) removeBtn.classList.toggle("hidden", !imageData);
}

function renderHomeProfilePhoto(imageData = "") {
  const img = document.getElementById("home-profile-photo");
  if (!img) return;
  if (imageData) {
    img.src = imageData;
    img.classList.remove("hidden");
  } else {
    img.removeAttribute("src");
    img.classList.add("hidden");
  }
}

function renderProfilePhotosFromCache() {
  const cached = currentProfileCache();
  renderSettingsProfilePhoto(cached.profilePhoto || "", cached.name || currentUser?.name);
  renderHomeProfilePhoto(cached.profilePhoto || "");
}

function compressProfilePhoto(file, maxSize = 360, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve("");
    if (!String(file.type || "").startsWith("image/")) return reject(new Error("Please choose an image file."));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not load image."));
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width || maxSize, img.height || maxSize));
        const w = Math.max(1, Math.round((img.width || maxSize) * scale));
        const h = Math.max(1, Math.round((img.height || maxSize) * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handleProfilePhotoSelected(file) {
  if (!currentUser?.id || !file) return;
  try {
    const profilePhoto = await compressProfilePhoto(file);
    saveCurrentProfileCache({ profilePhoto });
    currentUser = { ...currentUser, profilePhoto };
    localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
    renderProfilePhotosFromCache();
    window.dispatchEvent(new CustomEvent("telesyriana:profile-photo-updated", { detail: { userId: currentUser.id, profilePhoto, name: currentUser.name } }));
    try {
      await setDoc(doc(collection(db, USER_PROFILE_COL), currentUser.id), { profilePhoto, updatedAt: serverTimestamp() }, { merge: true });
      showSettingsAlert(getLanguage() === "ar" ? "تم تحديث صورة الحساب." : "Profile photo updated.");
    } catch (err) {
      console.warn("profile photo saved locally only", err);
      showSettingsAlert(getLanguage() === "ar" ? "تم حفظ الصورة محلياً، لكن فشل حفظ Firestore." : "Photo saved locally, but Firestore save failed.", true);
    }
  } catch (err) {
    console.error("profile photo upload failed", err);
    showSettingsAlert(getLanguage() === "ar" ? "فشل رفع الصورة. جرّب صورة أصغر." : "Photo upload failed. Try a smaller image.", true);
  }
}

function showSettingsAlert(message, danger = false) {
  const box = document.getElementById("settings-alert");
  if (!box) {
    if (message) alert(message);
    return;
  }
  box.textContent = message;
  box.classList.remove("hidden");
  box.classList.toggle("danger", Boolean(danger));
  setTimeout(() => box.classList.add("hidden"), 3500);
}

function parseCssColorToRgb(value) {
  const v = String(value || "").trim();
  const rgb = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) return null;
  let h = hex[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

function brightnessFromRgb(rgb) {
  if (!rgb) return 255;
  return (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
}

function setBackgroundTone(tone) {
  document.body.dataset.bgTone = tone === "dark" ? "dark" : "light";
}

function detectToneFromThemeAndBackground() {
  const bg = document.body.dataset.bg || "default";
  const theme = document.body.dataset.theme || "female";
  if (bg === "night" || theme === "navy") return "dark";
  if (bg === "grid" || bg === "soft") return "light";

  const styles = getComputedStyle(document.body);
  const c1 = parseCssColorToRgb(styles.getPropertyValue("--bg1"));
  const c2 = parseCssColorToRgb(styles.getPropertyValue("--bg2"));
  const avg = ((brightnessFromRgb(c1) || 0) + (brightnessFromRgb(c2) || 0)) / 2;
  return avg < 132 ? "dark" : "light";
}

function detectToneFromImage(imageData) {
  if (!imageData) {
    setBackgroundTone(detectToneFromThemeAndBackground());
    return;
  }
  const img = new Image();
  img.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      const size = 24;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;
      let total = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3] / 255;
        if (alpha < 0.2) continue;
        total += brightnessFromRgb([data[i], data[i + 1], data[i + 2]]);
        count += 1;
      }
      const avg = count ? total / count : 255;
      setBackgroundTone(avg < 142 ? "dark" : "light");
    } catch (err) {
      console.warn("Background tone detection failed", err);
      setBackgroundTone("dark");
    }
  };
  img.onerror = () => setBackgroundTone(detectToneFromThemeAndBackground());
  img.src = imageData;
}

function applyTheme(gender) {
  const g = String(gender || "").toLowerCase().trim();
  document.body.removeAttribute("data-theme");
  if (["male", "female", "orange", "green", "navy", "red"].includes(g)) {
    document.body.setAttribute("data-theme", g);
  }
  setBackgroundTone(detectToneFromThemeAndBackground());
}

function applyBackground(background, imageData = "") {
  const bg = String(background || "default").toLowerCase().trim();
  document.body.dataset.bg = bg || "default";
  if (bg === "custom" && imageData) {
    document.body.style.backgroundImage = `linear-gradient(rgba(0,0,0,.18), rgba(0,0,0,.18)), url(${imageData})`;
    document.body.style.backgroundSize = "cover";
    document.body.style.backgroundPosition = "center";
    document.body.style.backgroundAttachment = "fixed";
    detectToneFromImage(imageData);
  } else {
    document.body.style.backgroundImage = "";
    document.body.style.backgroundSize = "";
    document.body.style.backgroundPosition = "";
    document.body.style.backgroundAttachment = "";
    setBackgroundTone(detectToneFromThemeAndBackground());
  }
}

const LANGUAGE_KEY = "telesyrianaLanguage";
const UI_TEXT = {
  ar: {
    nav: {
      home: "الرئيسية", tasks: "الملاحظات", tickets: "التذاكر", reports: "التقارير",
      payroll: "الرواتب", messages: "الرسائل", meetings: "الاجتماعات", settings: "الإعدادات",
    },
    logout: "تسجيل الخروج",
    tagline: "بوابة إدارة فريق الدعم",
    loginTitle: "تسجيل الدخول",
    loginSubtitle: "يرجى تسجيل الدخول باستخدام رقم الموظف وكلمة المرور.",
    ccms: "رقم الموظف CCMS",
    password: "كلمة المرور",
    loginBtn: "دخول",
    trialUsers: "حسابات التجربة:",
    settingsTitle: "الإعدادات",
    settingsSubtitle: "تحديث المعلومات الشخصية",
    fullName: "الاسم الكامل",
    language: "لغة النظام",
    languageHint: "تغيير اللغة يغيّر اتجاه الواجهة ويحفظ اختيارك لهذا الحساب.",
    theme: "لون الواجهة",
    background: "الخلفية",
    uploadBg: "رفع صورة خلفية (اختياري)",
    birthday: "تاريخ الميلاد",
    notes: "الملاحظات",
    save: "حفظ",
    menu: "القائمة",
    removeBg: "حذف الخلفية المرفوعة",
    bgHint: "يتم الحفظ محلياً أولاً للتجربة. المزامنة مع Firestore تعمل بعد إنشاء قاعدة البيانات.",
    profilePhoto: "صورة الحساب",
    removePhoto: "حذف الصورة",
  },
  en: {
    nav: {
      home: "Home", tasks: "Notes", tickets: "Tickets", reports: "Reports",
      payroll: "Payroll", messages: "Messages", meetings: "Meetings", settings: "Settings",
    },
    logout: "Logout",
    tagline: "Agent Access Portal",
    loginTitle: "Login",
    loginSubtitle: "Please sign in with your CCMS ID and password.",
    ccms: "CCMS ID",
    password: "Password",
    loginBtn: "Login",
    trialUsers: "Example users:",
    settingsTitle: "Settings",
    settingsSubtitle: "Update personal info",
    fullName: "Full Name",
    language: "System language",
    languageHint: "Changing language updates layout direction and saves your preference for this account.",
    theme: "Interface colour",
    background: "Background",
    uploadBg: "Upload background image (optional)",
    birthday: "Birthday",
    notes: "Notes",
    save: "Save",
    menu: "Menu",
    removeBg: "Remove uploaded background",
    bgHint: "Saved locally first for testing. Firestore sync works after the database is created.",
    profilePhoto: "Profile photo",
    removePhoto: "Remove photo",
  }
};

function getLanguage() {
  try {
    if (currentUser) {
      const cached = JSON.parse(localStorage.getItem(profileCacheKey(currentUser.id)) || "{}");
      if (["ar", "en"].includes(cached.language)) return cached.language;
    }
  } catch {}
  const stored = localStorage.getItem(LANGUAGE_KEY);
  return stored === "ar" ? "ar" : "en";
}

function setText(selector, value) {
  const el = document.querySelector(selector);
  if (el && value != null) el.textContent = value;
}

function setLabelFor(inputId, labelText, hintText) {
  const input = document.getElementById(inputId);
  const label = input?.closest("label");
  if (!label) return;
  const textNode = Array.from(label.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
  if (textNode) textNode.textContent = `\n              ${labelText}\n              `;
  const hint = label.querySelector(".hint");
  if (hint && hintText) hint.textContent = hintText;
}

function translateStaticUI(lang = "en") {
  const isAr = lang === "ar";
  const labels = isAr ? {
    homeTitlePrefix: "مرحباً،",
    currentStatus: "الحالة الحالية:",
    changeStatus: "تغيير الحالة:",
    clockIn: "بدء الدوام",
    startBreak: "بدء الاستراحة",
    handling: "متابعة حالة",
    meeting: "اجتماع",
    clockOut: "إنهاء الدوام",
    teamOverview: "نظرة عامة على الفريق",
    todaySnapshot: "ملخص اليوم",
    onlineNow: "المتواجدون الآن",
  } : {
    homeTitlePrefix: "Welcome,",
    currentStatus: "Current status:",
    changeStatus: "Change status:",
    clockIn: "Clock in",
    startBreak: "Start break",
    handling: "Handling",
    meeting: "Meeting",
    clockOut: "Clock out",
    teamOverview: "Team Overview",
    todaySnapshot: "Today’s Snapshot",
    onlineNow: "Online now",
  };

  // Keep this function intentionally defensive: different phases have slightly
  // different DOM structures, so missing elements must never block login.
  const safeSet = (selector, value) => {
    const el = document.querySelector(selector);
    if (el && value) el.textContent = value;
  };
  try {
    safeSet('#page-home .status-card label, #page-home label[for="status-select"]', labels.changeStatus);
    safeSet('#clock-in-btn', labels.clockIn);
    safeSet('#start-break-btn', labels.startBreak);
    safeSet('#handling-btn', labels.handling);
    safeSet('#meeting-btn', labels.meeting);
    safeSet('#clock-out-btn', labels.clockOut);
    safeSet('.team-overview-title', labels.teamOverview);
    safeSet('.today-snapshot-title', labels.todaySnapshot);
    safeSet('.online-now-title', labels.onlineNow);
  } catch (err) {
    console.warn('translateStaticUI skipped:', err);
  }
}

function applyLanguage(language = "ar") {
  const lang = language === "en" ? "en" : "ar";
  const dict = UI_TEXT[lang];
  localStorage.setItem(LANGUAGE_KEY, lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.body.dataset.language = lang;

  const langSelect = document.getElementById("set-language");
  if (langSelect) langSelect.value = lang;

  Object.entries(dict.nav).forEach(([page, label]) => {
    const btn = document.querySelector(`.nav-link[data-page="${page}"]`);
    if (!btn) return;
    const badge = btn.querySelector("#nav-messages-badge");
    Array.from(btn.childNodes).forEach((n) => { if (n.nodeType === Node.TEXT_NODE) n.remove(); });
    btn.prepend(document.createTextNode(label));
    if (badge && !btn.contains(badge)) btn.appendChild(badge);
  });

  const langOptions = document.querySelectorAll('#set-language option');
  langOptions.forEach((opt) => {
    if (opt.value === 'ar') opt.textContent = lang === 'ar' ? 'العربية' : 'Arabic';
    if (opt.value === 'en') opt.textContent = lang === 'ar' ? 'English' : 'English';
  });
  const themeOptions = document.querySelectorAll('#set-gender option');
  const themeText = lang === 'ar'
    ? { '': 'وردي افتراضي', female: 'وردي', male: 'أزرق', orange: 'برتقالي', green: 'أخضر', navy: 'كحلي', red: 'أحمر' }
    : { '': 'Default pink', female: 'Pink', male: 'Blue', orange: 'Orange', green: 'Green', navy: 'Navy blue', red: 'Red' };
  themeOptions.forEach((opt) => { if (themeText[opt.value] != null) opt.textContent = themeText[opt.value]; });
  const bgOptions = document.querySelectorAll('#set-background option');
  const bgText = lang === 'ar'
    ? { default: 'تدرج افتراضي', soft: 'زجاج ناعم', night: 'تركيز ليلي', grid: 'شبكة فاتحة', custom: 'صورة مرفوعة' }
    : { default: 'Default gradient', soft: 'Soft glass', night: 'Night focus', grid: 'Light grid', custom: 'Uploaded image' };
  bgOptions.forEach((opt) => { if (bgText[opt.value] != null) opt.textContent = bgText[opt.value]; });
  setText("#logout-btn", dict.logout);
  setText(".tagline", dict.tagline);
  setText(".login-card h1", dict.loginTitle);
  setText(".login-card .subtitle", dict.loginSubtitle);
  setLabelFor("ccmsId", dict.ccms);
  setLabelFor("password", dict.password);
  const ccmsInput = document.getElementById("ccmsId");
  if (ccmsInput) ccmsInput.placeholder = lang === "ar" ? "مثال: 1001" : "e.g. 1001";
  const passwordInput = document.getElementById("password");
  if (passwordInput) passwordInput.placeholder = lang === "ar" ? "كلمة المرور" : "Password";
  setText("#login-form .btn-primary", dict.loginBtn);
  const hint = document.querySelector(".login-card .hint");
  if (hint) {
    const html = hint.innerHTML;
    hint.innerHTML = html.replace(/حسابات التجربة:|Example users:/, dict.trialUsers);
  }

  setText("#page-settings h2", dict.settingsTitle);
  setText("#page-settings .subtitle", dict.settingsSubtitle);
  setLabelFor("set-name", dict.fullName);
  setLabelFor("set-language", dict.language, dict.languageHint);
  setLabelFor("set-gender", dict.theme);
  setLabelFor("set-background", dict.background);
  setLabelFor("set-bg-upload", dict.uploadBg, dict.bgHint);
  setText("#remove-bg-btn", dict.removeBg);
  setText("#remove-profile-photo-btn", dict.removePhoto);
  setText("#profile-photo-hint", dict.profilePhoto);
  setLabelFor("set-birthday", dict.birthday);
  setLabelFor("set-notes", dict.notes);
  setText('#settings-form button[type="submit"]', dict.save);
  const menuTitle = document.querySelector(".mobile-drawer-title");
  if (menuTitle) menuTitle.textContent = dict.menu;
  const mainNav = document.getElementById("main-nav");
  if (mainNav) mainNav.dataset.menuTitle = dict.menu;
  translateStaticUI(lang);
  try { translateFeaturePages(lang); } catch {}
  try { applyPhase21LanguagePolish(lang); setTimeout(() => applyPhase21LanguagePolish(lang), 120); } catch {}


  // Let feature modules translate their own static UI.
  try { window.dispatchEvent(new CustomEvent("telesyriana:language-changed", { detail: { language: lang } })); } catch {}
}

async function loadUserProfile() {
  if (!currentUser) return;

  const nameEl = document.getElementById("set-name");
  const bdayEl = document.getElementById("set-birthday");
  const notesEl = document.getElementById("set-notes");
  const genderEl = document.getElementById("set-gender");
  const bgEl = document.getElementById("set-background");
  const langEl = document.getElementById("set-language");

  if (nameEl) nameEl.value = currentUser.name || currentUser.id;
  const codeEl = document.getElementById("set-staff-code");
  const roleEl = document.getElementById("set-role");
  if (codeEl) codeEl.textContent = currentUser.id || "—";
  if (roleEl) roleEl.textContent = String(currentUser.role || "").toUpperCase();

  let cached = {};
  try {
    cached = JSON.parse(localStorage.getItem(profileCacheKey(currentUser.id)) || "{}");
  } catch {}

  if (cached.name) {
    currentUser = { ...currentUser, name: cached.name, profilePhoto: cached.profilePhoto || currentUser.profilePhoto || "" };
    localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
    if (nameEl) nameEl.value = cached.name;
  }
  if (bdayEl) bdayEl.value = cached.birthday || "";
  if (notesEl) notesEl.value = cached.notes || "";
  if (genderEl) genderEl.value = cached.gender || "";
  if (bgEl) bgEl.value = cached.background || "default";
  const cachedLanguage = cached.language || localStorage.getItem(LANGUAGE_KEY) || "ar";
  if (langEl) langEl.value = cachedLanguage;
  applyLanguage(cachedLanguage);
  applyTheme(cached.gender || "");
  applyBackground(cached.background || "default", cached.backgroundImage || "");
  renderSettingsProfilePhoto(cached.profilePhoto || "", cached.name || currentUser.name);
  renderHomeProfilePhoto(cached.profilePhoto || "");

  try {
    const ref = doc(collection(db, USER_PROFILE_COL), currentUser.id);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const d = snap.data();
      const savedName = d.name || currentUser.name || currentUser.id;
      const savedProfilePhoto = d.profilePhoto || cached.profilePhoto || "";
      currentUser = { ...currentUser, name: savedName, profilePhoto: savedProfilePhoto };
      localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
      if (nameEl) nameEl.value = savedName;
      if (bdayEl) bdayEl.value = d.birthday || "";
      if (notesEl) notesEl.value = d.notes || "";
      if (genderEl) genderEl.value = d.gender || "";
      if (bgEl) bgEl.value = d.background || "default";
      const savedLanguage = d.language || cachedLanguage || "ar";
      if (langEl) langEl.value = savedLanguage;
      applyLanguage(savedLanguage);
      applyTheme(d.gender || "");
      applyBackground(d.background || "default", d.backgroundImage || cached.backgroundImage || "");
      renderSettingsProfilePhoto(d.profilePhoto || cached.profilePhoto || "", savedName);
      renderHomeProfilePhoto(d.profilePhoto || cached.profilePhoto || "");
      localStorage.setItem(profileCacheKey(currentUser.id), JSON.stringify({
        name: d.name || currentUser.name || "",
        birthday: d.birthday || "",
        notes: d.notes || "",
        gender: d.gender || "",
        language: d.language || savedLanguage || "ar",
        background: d.background || "default",
        backgroundImage: d.backgroundImage || cached.backgroundImage || "",
        profilePhoto: d.profilePhoto || cached.profilePhoto || "",
      }));
    }
  } catch (err) {
    console.warn("Could not load profile from Firestore, using local profile cache.", err);
  }
}

async function handleSettingsSave(e) {
  e.preventDefault();
  if (!currentUser) return;
  const btn = e.submitter || document.querySelector('#settings-form button[type="submit"]');
  const oldText = btn?.textContent || "حفظ";
  if (btn) { btn.disabled = true; btn.textContent = "جاري الحفظ..."; }

  const name = document.getElementById("set-name")?.value?.trim() || currentUser.name || currentUser.id;
  const birthday = document.getElementById("set-birthday")?.value || "";
  const notes = document.getElementById("set-notes")?.value || "";
  const gender = document.getElementById("set-gender")?.value || "";
  const language = document.getElementById("set-language")?.value || getLanguage() || "ar";
  const background = document.getElementById("set-background")?.value || "default";
  let cachedProfileForBg = {};
  try { cachedProfileForBg = JSON.parse(localStorage.getItem(profileCacheKey(currentUser.id)) || "{}"); } catch {}
  const backgroundImage = background === "custom" ? (cachedProfileForBg.backgroundImage || "") : "";
  const profilePhoto = cachedProfileForBg.profilePhoto || "";

  applyLanguage(language);
  applyTheme(gender);
  applyBackground(background, backgroundImage);
  currentUser = { ...currentUser, name, profilePhoto };
  localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
  localStorage.setItem(profileCacheKey(currentUser.id), JSON.stringify({ name, birthday, notes, gender, language, background, backgroundImage, profilePhoto }));
  updateDashboardUI();
  renderSettingsProfilePhoto(profilePhoto, name);
  renderHomeProfilePhoto(profilePhoto);
  window.dispatchEvent(new CustomEvent("telesyriana:profile-photo-updated", { detail: { userId: currentUser.id, profilePhoto, name } }));
  updatePresence(true).catch(() => {});

  const ref = doc(collection(db, USER_PROFILE_COL), currentUser.id);

  try {
    await setDoc(
      ref,
      {
        userId: currentUser.id,
        name,
        birthday,
        notes,
        gender,
        language,
        background,
        backgroundImage,
        profilePhoto,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    showSettingsAlert(getLanguage() === "ar" ? "تم حفظ الإعدادات بنجاح." : "Settings saved successfully.");
  } catch (err) {
    console.error("settings save failed", err);
    showSettingsAlert(`تم الحفظ محلياً، لكن فشل حفظ Firestore: ${err?.code || err?.message || "تحقق من الصلاحيات أو الاتصال"}`, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
}

// Apply colour immediately when the user changes theme, even before saving.
document.addEventListener("change", (e) => {
  if (e.target?.id === "set-language") applyLanguage(e.target.value || "ar");
  if (e.target?.id === "set-gender") applyTheme(e.target.value || "");
  if (e.target?.id === "set-background") {
    const cached = currentUser ? JSON.parse(localStorage.getItem(profileCacheKey(currentUser.id)) || "{}") : {};
    applyBackground(e.target.value || "default", cached.backgroundImage || "");
  }
  if (e.target?.id === "set-bg-upload") {
    const file = e.target.files?.[0];
    if (!file || !currentUser) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = String(reader.result || "");
      let cached = {};
      try { cached = JSON.parse(localStorage.getItem(profileCacheKey(currentUser.id)) || "{}"); } catch {}
      cached.background = "custom";
      cached.backgroundImage = img;
      localStorage.setItem(profileCacheKey(currentUser.id), JSON.stringify(cached));
      const bgEl = document.getElementById("set-background");
      if (bgEl) bgEl.value = "custom";
      applyBackground("custom", img);
      showSettingsAlert(getLanguage() === "ar" ? "تم تحميل الخلفية محلياً. اضغط حفظ للمزامنة عندما تكون Firestore جاهزة." : "Background uploaded locally. Press Save to sync when Firestore is ready.");
    };
    reader.readAsDataURL(file);
  }
});

async function removeUploadedBackground() {
  if (!currentUser) return;
  let cached = {};
  try { cached = JSON.parse(localStorage.getItem(profileCacheKey(currentUser.id)) || "{}"); } catch {}
  delete cached.backgroundImage;
  cached.background = "default";
  localStorage.setItem(profileCacheKey(currentUser.id), JSON.stringify(cached));
  const bgEl = document.getElementById("set-background");
  const uploadEl = document.getElementById("set-bg-upload");
  if (bgEl) bgEl.value = "default";
  if (uploadEl) uploadEl.value = "";
  applyBackground("default", "");
  try {
    await setDoc(doc(collection(db, USER_PROFILE_COL), currentUser.id), { background: "default", backgroundImage: "", updatedAt: serverTimestamp() }, { merge: true });
    showSettingsAlert(getLanguage() === "ar" ? "تم حذف الخلفية المرفوعة." : "Uploaded background removed.");
  } catch (err) {
    console.warn("remove background saved locally only", err);
    showSettingsAlert(getLanguage() === "ar" ? "تم حذف الخلفية محلياً. المزامنة تحتاج Firestore." : "Background removed locally. Firestore sync needs the database.", true);
  }
}

function ensureBackgroundRemoveControl() {
  const btn = document.getElementById("remove-bg-btn");
  if (!btn || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", () => removeUploadedBackground());
}


function ensureProfilePhotoControls() {
  const picker = document.getElementById("settings-photo-picker");
  const input = document.getElementById("set-profile-photo");
  const removeBtn = document.getElementById("remove-profile-photo-btn");
  if (picker && input && picker.dataset.bound !== "1") {
    picker.dataset.bound = "1";
    picker.addEventListener("click", () => input.click());
  }
  if (input && input.dataset.bound !== "1") {
    input.dataset.bound = "1";
    input.addEventListener("change", () => handleProfilePhotoSelected(input.files?.[0]));
  }
  if (removeBtn && removeBtn.dataset.bound !== "1") {
    removeBtn.dataset.bound = "1";
    removeBtn.addEventListener("click", () => {
      if (!currentUser?.id) return;
      saveCurrentProfileCache({ profilePhoto: "" });
      if (currentUser) {
        currentUser = { ...currentUser, profilePhoto: "" };
        localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
      }
      renderProfilePhotosFromCache();
      window.dispatchEvent(new CustomEvent("telesyriana:profile-photo-updated", { detail: { userId: currentUser.id, profilePhoto: "", name: currentUser.name } }));
      try {
        setDoc(doc(collection(db, USER_PROFILE_COL), currentUser.id), { profilePhoto: "", updatedAt: serverTimestamp() }, { merge: true })
          .then(() => showSettingsAlert(getLanguage() === "ar" ? "تم حذف صورة الحساب." : "Profile photo removed."))
          .catch((err) => { console.warn("profile photo remove firestore failed", err); showSettingsAlert(getLanguage() === "ar" ? "تم الحذف محلياً، لكن فشل حفظ Firestore." : "Removed locally, but Firestore save failed.", true); });
      } catch (err) {
        console.warn("profile photo remove local only", err);
        showSettingsAlert(getLanguage() === "ar" ? "تم حذف الصورة محلياً." : "Photo removed locally.", true);
      }
    });
  }
}

/* --------------------------- View switching ----------------------------- */

function showLogin() {
  hideAppLoading(0);
  closeMobileMenu();
  document.body.classList.add("auth-screen");
  document.body.classList.remove("dashboard-ready");
  document.getElementById("dashboard-screen")?.classList.add("hidden");
  document.getElementById("login-screen")?.classList.remove("hidden");
  document.getElementById("main-nav")?.classList.add("hidden");
  document.getElementById("mobile-menu-toggle")?.classList.add("hidden");
  closeMobileMenu();

  const floatToggle = document.getElementById("float-chat-toggle");
  if (floatToggle) floatToggle.classList.add("hidden");

  closeFloatingChat();

  if (clockIntervalId) clearInterval(clockIntervalId);
  clockIntervalId = null;
}

function showDashboard() {
  setAppLoading(78, loadingText("تجهيز لوحة التحكم", "Preparing dashboard"), loadingText("فتح الصفحة الرئيسية وتشغيل الخدمات…", "Opening the home page and starting services…"));
  closeMobileMenu();
  document.body.classList.remove("auth-screen");
  document.body.classList.add("dashboard-ready");
  document.getElementById("login-screen")?.classList.add("hidden");
  document.getElementById("dashboard-screen")?.classList.remove("hidden");
  document.getElementById("main-nav")?.classList.remove("hidden");
  document.getElementById("mobile-menu-toggle")?.classList.remove("hidden");

  switchPage("home");
  updateDashboardUI();

  renderClockWidget();
  buildMiniCalendar();
  hookCalendarButtons();

  if (!clockIntervalId) {
    clockIntervalId = setInterval(renderClockWidget, 1000);
  }
  startPresence();
  subscribeIssueCalendar();
}

function setPlaceholder(selector, value) {
  const el = document.querySelector(selector);
  if (el && value != null) el.setAttribute('placeholder', value);
}

function setTitleAttr(selector, value) {
  const el = document.querySelector(selector);
  if (el && value != null) el.setAttribute('title', value);
}

function setLabelText(selector, value) {
  const el = document.querySelector(selector);
  if (!el || value == null) return;
  const node = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
  if (node) node.textContent = `${value} `;
  else el.insertBefore(document.createTextNode(`${value} `), el.firstChild || null);
}

function setSelectOptions(selectSelector, map) {
  const select = document.querySelector(selectSelector);
  if (!select) return;
  Array.from(select.options || []).forEach((opt) => {
    if (Object.prototype.hasOwnProperty.call(map, opt.value)) opt.textContent = map[opt.value];
  });
}

function translateFeaturePages(lang = 'en') {
  const isAr = lang === 'ar';
  const t = isAr ? {
    todaySnapshot: 'ملخص اليوم',
    quickReminders: 'تذكيرات سريعة:',
    reminder1: '✔ حدّث حالتك دائماً.',
    reminder2: '✔ استخدم وقت الاستراحة بانتظام.',
    reminder3: '✔ تعامل مع العملاء بهدوء واحترام.',
    onlineEmpty: 'لا يوجد أحد متصل حالياً.',
    clock: 'الساعة',
    today: 'اليوم',
    localDate: 'التاريخ المحلي',
    calendarSummary: 'سيظهر تقويم نسب المشاكل بعد استخدام التذاكر.',
    breakTitle: 'الاستراحة',
    breakUsed: 'دقيقة مستخدمة',
    workHours: 'ساعات العمل',
    remaining: 'المتبقي:',
    settingsMeta: 'الكود: ',
    settingsRole: 'الدور: ',
    notesTitle: 'الملاحظات',
    notesSubtitle: 'ملاحظات شخصية بأسلوب بسيط للمتابعة والأفكار.',
    newNote: '+ ملاحظة جديدة',
    notesSearch: 'البحث في الملاحظات...',
    noteTitle: 'عنوان الملاحظة',
    noteBody: 'ابدأ الكتابة...',
    delete: 'حذف',
    noNotes: 'لا توجد ملاحظات بعد.',
    ticketsTitle: 'تذاكر الدعم',
    ticketsSubtitle: 'الطوارئ • مشاكل الطلبات • الإرجاع • ملاحظات داخلية',
    refresh: 'تحديث',
    newTicket: '+ تذكرة جديدة',
    shopifyMemory: 'بيانات الطلب / ذاكرة Shopify',
    shopifyMemorySub: 'ابحث عن رقم الطلب أو البريد أو الهاتف أو اسم العميل لجلب بيانات Shopify وربطها بالتذكرة.',
    addUpdateOrder: 'إضافة / تحديث طلب',
    open: 'مفتوحة',
    emergency: 'طارئ',
    escalated: 'مصعّدة',
    resolvedToday: 'محلولة اليوم',
    createTicket: 'إنشاء التذكرة',
    ticketNote: 'رقم الطلب فقط مطلوب، والباقي اختياري.',
    autoFill: 'ملء تلقائي من رقم الطلب',
    create: 'إنشاء',
    ticketSearch: 'بحث برقم الطلب أو العميل أو الملاحظات…',
    allStates: 'كل الحالات',
    allPriorities: 'كل الأولويات',
    allOwners: 'All owners',
    escalate: 'تصعيد',
    saveChanges: 'حفظ التعديلات',
    reportsTitle: 'التقارير اليومية',
    reportsSubtitle: 'Morning • Midday • End of shift — support handover and emergency visibility',
    delayed: 'متأخر',
    returns: 'الإرجاع / الاستبدال',
    createReport: 'إنشاء تقرير',
    reportType: 'نوع التقرير',
    morning: 'تقرير صباحي',
    midday: 'تقرير منتصف اليوم',
    endShift: 'تقرير نهاية الدوام',
    useTemplate: 'استخدام القالب',
    clear: 'مسح',
    searchReports: 'بحث في التقارير...',
    meetingsTitle: 'الاجتماعات',
    meetingSearch: 'البحث برقم الاجتماع / العنوان / المضيف…',
    clearSearch: 'مسح',
    createSection: 'إنشاء',
    meetingTitle: 'العنوان (مثلاً: اجتماع يومي)',
    meetingLink: 'ضع رابط Google Meet / Zoom / Teams',
    meetingId: 'رقم الاجتماع',
    meetingPass: 'كود الدخول',
    newCode: 'كود جديد',
    upcomingMeetings: 'الاجتماعات القادمة',
    noMeetings: 'لا توجد اجتماعات قادمة',
    meetingLinkTitle: 'رابط الاجتماع',
    meetingLinkSub: 'أدخل رقم الاجتماع واضغط فتح الرابط. سيتم تسجيل الحضور تلقائياً.',
    openLink: 'فتح الرابط',
    meetingNote: 'يمكن للمدير أو المشرف لصق رابط Google Meet أو Zoom. الضغط على فتح الرابط يسجل الحضور. بعد ساعة يمكن اعتبار من لم يضغط الرابط غائباً.',
    homeLabel: 'الرئيسية',
    notesLabel: 'الملاحظات',
    ticketsLabel: 'التذاكر',
    reportsLabel: 'التقارير',
    payrollLabel: 'الرواتب',
    messagesLabel: 'الرسائل',
    meetingsLabel: 'الاجتماعات',
    settingsLabel: 'الإعدادات',
    logout: 'تسجيل الخروج'
  } : {
    todaySnapshot: "Today's Snapshot",
    quickReminders: 'Quick reminders:',
    reminder1: '✔ Always update your status.',
    reminder2: '✔ Use your break time properly.',
    reminder3: '✔ Treat customers calmly and respectfully.',
    onlineEmpty: 'No one is online right now.',
    clock: 'Clock',
    today: 'Today',
    localDate: 'Local date',
    calendarSummary: 'The issue-rate calendar will appear after using tickets.',
    breakTitle: 'Break',
    breakUsed: 'minutes used',
    workHours: 'Work hours',
    remaining: 'Remaining:',
    settingsMeta: 'Code: ',
    settingsRole: 'Role: ',
    notesTitle: 'Notes',
    notesSubtitle: 'Simple personal notes for follow-up and ideas.',
    newNote: '+ New note',
    notesSearch: 'Search notes...',
    noteTitle: 'Note title',
    noteBody: 'Start typing...',
    delete: 'Delete',
    noNotes: 'No notes yet.',
    ticketsTitle: 'Support tickets',
    ticketsSubtitle: 'Emergencies • order issues • returns • internal notes',
    refresh: 'Refresh',
    newTicket: '+ New ticket',
    shopifyMemory: 'Shopify order memory',
    shopifyMemorySub: 'Search by order number, email, phone, or customer name to load Shopify order details and link them to the ticket.',
    addUpdateOrder: 'Add / update order',
    open: 'Open',
    emergency: 'Emergency',
    escalated: 'Escalated',
    resolvedToday: 'Resolved today',
    createTicket: 'Create ticket',
    ticketNote: 'Only the order number is required. Everything else is optional.',
    autoFill: 'Autofill from order number',
    create: 'Create',
    ticketSearch: 'Search by order number, customer, or notes…',
    allStates: 'All statuses',
    allPriorities: 'All priorities',
    allOwners: 'All owners',
    escalate: 'Escalate',
    saveChanges: 'Save changes',
    reportsTitle: 'Daily reports',
    reportsSubtitle: 'Morning • Midday • End of shift — support handover and emergency visibility',
    delayed: 'Delayed',
    returns: 'Returns / Exchange',
    createReport: 'Create report',
    reportType: 'Report type',
    morning: 'Morning report',
    midday: 'Midday report',
    endShift: 'End of shift report',
    useTemplate: 'Use template',
    clear: 'Clear',
    searchReports: 'Search reports...',
    meetingsTitle: 'Meetings',
    meetingSearch: 'Search by meeting ID / title / host…',
    clearSearch: 'Clear',
    createSection: 'Create',
    meetingTitle: 'Title (e.g. Daily meeting)',
    meetingLink: 'Paste a Google Meet / Zoom / Teams link',
    meetingId: 'Meeting ID',
    meetingPass: 'Meeting passcode',
    newCode: 'New code',
    upcomingMeetings: 'Upcoming meetings',
    noMeetings: 'No upcoming meetings',
    meetingLinkTitle: 'Meeting link',
    meetingLinkSub: 'Enter the meeting ID and press Open link. Attendance will be recorded automatically.',
    openLink: 'Open link',
    meetingNote: 'Manager or supervisor can paste a Google Meet or Zoom link. Clicking Open link records attendance. After one hour, staff who did not click the link can be reviewed as missing.',
    homeLabel: 'Home',
    notesLabel: 'Notes',
    ticketsLabel: 'Tickets',
    reportsLabel: 'Reports',
    payrollLabel: 'Payroll',
    messagesLabel: 'Messages',
    meetingsLabel: 'Meetings',
    settingsLabel: 'Settings',
    logout: 'Logout'
  };

  setText('#page-home .dashboard-side h2', t.todaySnapshot);
  setText('#page-home .dashboard-side > .subtitle', t.quickReminders);
  const sideItems = Array.from(document.querySelectorAll('#page-home .side-list li'));
  if (sideItems[0]) sideItems[0].textContent = t.reminder1;
  if (sideItems[1]) sideItems[1].textContent = t.reminder2;
  if (sideItems[2]) sideItems[2].textContent = t.reminder3;
  const onlineEmpty = document.getElementById('online-now-list');
  if (onlineEmpty && !onlineEmpty.children.length) onlineEmpty.textContent = t.onlineEmpty;
  const widgetTitles = Array.from(document.querySelectorAll('#page-home .widget-card .widget-title'));
  if (widgetTitles[0]) widgetTitles[0].textContent = t.clock;
  if (widgetTitles[1]) widgetTitles[1].textContent = t.today;
  if (widgetTitles[3]) widgetTitles[3].textContent = t.breakTitle;
  if (widgetTitles[4]) widgetTitles[4].textContent = t.workHours;
  const widgetSubs = Array.from(document.querySelectorAll('#page-home .widget-card .widget-sub'));
  if (widgetSubs[1]) widgetSubs[1].textContent = t.localDate;
  if (widgetSubs[2]) widgetSubs[2].textContent = t.breakUsed;
  const workSub = document.querySelector('#page-home .widget-card:last-child .widget-sub');
  if (workSub) {
    const rem = document.getElementById('work-remaining-text')?.textContent || '';
    workSub.textContent = (t.remaining + ' ' + rem).trim();
  }
  const calSummary = document.getElementById('issue-calendar-summary');
  if (calSummary && /سيظهر تقويم نسب المشاكل|issue-rate calendar/i.test(calSummary.textContent || '')) calSummary.textContent = t.calendarSummary;
  setSelectOptions('#status-select', isAr ? { in_operation:'قيد التشغيل', break:'استراحة', handling:'متابعة حالة', meeting:'اجتماع', unavailable:'غير متاح' } : { in_operation:'Operating', break:'Break', handling:'Handling', meeting:'Meeting', unavailable:'Unavailable' });

  const metaHint = document.querySelector('#page-settings .hint');
  if (metaHint) {
    const code = document.getElementById('set-staff-code')?.textContent || '—';
    const role = document.getElementById('set-role')?.textContent || '—';
    metaHint.textContent = t.settingsMeta + code + ' • ' + t.settingsRole + role;
  }

  setText('#page-tasks .notes-head h2', t.notesTitle);
  setText('#page-tasks .notes-head .subtitle', t.notesSubtitle);
  setText('#note-new-btn', t.newNote);
  setPlaceholder('#notes-search', t.notesSearch);
  setPlaceholder('#note-title', t.noteTitle);
  setPlaceholder('#note-body', t.noteBody);
  setText('#note-delete-btn', t.delete);
  const noNotes = document.querySelector('#notes-list .notes-empty');
  if (noNotes) noNotes.textContent = t.noNotes;

  setText('#page-tickets .tickets-top h2', t.ticketsTitle);
  setText('#page-tickets .tickets-top .subtitle', t.ticketsSubtitle);
  setText('#ticket-refresh-btn', t.refresh);
  setText('#ticket-new-toggle', t.newTicket);
  setText('#order-admin-panel h3', t.shopifyMemory);
  setText('#order-admin-panel p', t.shopifyMemorySub);
  setText('#order-admin-toggle', t.addUpdateOrder);
  const ticketStats = Array.from(document.querySelectorAll('#page-tickets .ticket-stat span'));
  if (ticketStats[0]) ticketStats[0].textContent = t.open;
  if (ticketStats[1]) ticketStats[1].textContent = t.emergency;
  if (ticketStats[2]) ticketStats[2].textContent = t.escalated;
  if (ticketStats[3]) ticketStats[3].textContent = t.resolvedToday;
  setText('#ticket-form .ticket-form-head h3', t.createTicket);
  setText('#ticket-form .ticket-form-note', t.ticketNote);
  setText('#ticket-autofill-btn', t.autoFill);
  const ticketCreateBtn = document.querySelector('#ticket-form button[type="submit"]');
  if (ticketCreateBtn) ticketCreateBtn.textContent = t.create;
  setPlaceholder('#ticket-search', t.ticketSearch);
  setSelectOptions('#ticket-filter-status', { all: t.allStates, open:t.open, waiting_customer: isAr?'بانتظار العميل':'Waiting customer', waiting_courier:isAr?'بانتظار الشحن':'Waiting courier', waiting_supplier:isAr?'بانتظار المورد':'Waiting supplier', escalated:t.escalated, resolved:isAr?'محلولة':'Resolved', closed:isAr?'مغلقة':'Closed' });
  setSelectOptions('#ticket-filter-priority', { all: t.allPriorities, emergency:t.emergency, high:'High', medium:'Medium', normal:'Normal' });
  setSelectOptions('#ticket-filter-owner', { all: t.allOwners, mine: isAr ? 'تذاكري' : 'My tickets', unassigned: isAr ? 'غير مسندة' : 'Unassigned' });
  setText('#ticket-escalate-btn', t.escalate);
  setText('#ticket-save-btn', t.saveChanges);

  const reportTitle = document.querySelector('#page-reports h2');
  if (reportTitle) reportTitle.textContent = t.reportsTitle;
  const reportTopSubtitle = document.querySelector('#page-reports > .card > p.subtitle');
  if (reportTopSubtitle) reportTopSubtitle.textContent = t.reportsSubtitle;
  const reportStats = Array.from(document.querySelectorAll('#page-reports .report-snap span'));
  if (reportStats[0]) reportStats[0].textContent = isAr ? 'مفتوحة TICKETS' : 'Open tickets';
  if (reportStats[1]) reportStats[1].textContent = t.emergency;
  if (reportStats[2]) reportStats[2].textContent = t.escalated;
  if (reportStats[3]) reportStats[3].textContent = t.delayed;
  if (reportStats[4]) reportStats[4].textContent = t.returns;
  const reportCreate = document.querySelector('#report-form .report-form-head h3');
  if (reportCreate) reportCreate.textContent = t.createReport;
  setLabelText(document.querySelector('label[for="report-type"]') ? 'label[for="report-type"]' : '#report-form label', t.reportType);
  setSelectOptions('#report-type', { morning:t.morning, midday:t.midday, evening:t.endShift });
  setText('#report-template-btn', t.useTemplate);
  setText('#report-clear-form', t.clear);
  setPlaceholder('#report-search', t.searchReports);

  setText('#page-meetings .meetings-sidebar .ms-title', t.meetingsTitle);
  setPlaceholder('#meeting-search', t.meetingSearch);
  setTitleAttr('#meeting-search-clear', t.clearSearch);
  const meetHeaders = Array.from(document.querySelectorAll('#page-meetings .meetings-sidebar-header.small'));
  if (meetHeaders[0]) meetHeaders[0].textContent = t.createSection;
  if (meetHeaders[1]) meetHeaders[1].textContent = t.upcomingMeetings;
  setPlaceholder('#create-title', t.meetingTitle);
  setPlaceholder('#create-link', t.meetingLink);
  setPlaceholder('#create-id', t.meetingId);
  setPlaceholder('#create-pass', t.meetingPass);
  setText('#btn-new-pass', t.newCode);
  setText('#create-meeting-btn', t.create);
  setText('#meetings-empty', t.noMeetings);
  const createHint = document.querySelector('#create-meeting-box .create-hint');
  if (createHint) createHint.textContent = isAr ? 'الصق رابط الاجتماع. ينتهي الاجتماع بعد ساعة من وقت البدء. يمكن مراجعة الموظفين الغائبين.' : 'Paste the meeting link. The meeting expires 1 hour after the start time. Missing staff can be reviewed.';
  setText('#page-meetings .meetings-main .chat-room-name', t.meetingLinkTitle);
  setText('#page-meetings .meetings-main .chat-room-desc', t.meetingLinkSub);
  setPlaceholder('#join-meeting-id', t.meetingId);
  setPlaceholder('#join-meeting-pass', t.meetingPass);
  setText('#join-meeting-btn', t.openLink);
  const meetingNote = document.querySelector('#page-meetings .meeting-note');
  if (meetingNote) meetingNote.textContent = t.meetingNote;

  // Stronger static translations for Home / Notes / Tickets / Reports.
  const statusLabelBox = document.querySelector('#page-home .status-box .status-label');
  if (statusLabelBox) statusLabelBox.textContent = isAr ? 'الحالة الحالية:' : 'Current status:';
  const statusNote = document.querySelector('#page-home .status-note');
  if (statusNote) statusNote.innerHTML = isAr
    ? 'مدة الاستراحة المسموحة: <strong>45 دقيقة</strong>. يتم تحديث الوقت تلقائياً حسب حالة الموظف الحالية.'
    : 'Allowed break time: <strong>45 minutes</strong>. Time updates automatically based on the current staff status.';
  const breakBox = Array.from(document.querySelectorAll('#page-home .break-box > div'));
  if (breakBox[0]) breakBox[0].childNodes[0].nodeValue = isAr ? 'الاستراحة المستخدمة: ' : 'Break used: ';
  if (breakBox[1]) breakBox[1].childNodes[0].nodeValue = isAr ? 'المتبقي: ' : 'Remaining: ';
  const timeBox = Array.from(document.querySelectorAll('#page-home .time-box > div'));
  if (timeBox[0]) timeBox[0].childNodes[0].nodeValue = isAr ? 'التشغيل: ' : 'Operating: ';
  if (timeBox[1]) timeBox[1].childNodes[0].nodeValue = isAr ? 'الاجتماع: ' : 'Meeting: ';
  if (timeBox[2]) timeBox[2].childNodes[0].nodeValue = isAr ? 'متابعة الحالة: ' : 'Handling: ';
  const supTitle = document.querySelector('#supervisor-panel h2');
  if (supTitle) supTitle.textContent = isAr ? 'نظرة عامة على الفريق' : 'Team Overview';
  const supNote = document.querySelector('#supervisor-panel .sup-note');
  if (supNote) supNote.textContent = isAr ? 'المشرف يرى الموظفين التابعين له، والمدير/الأدمن يرى الفريق بالكامل.' : 'Supervisor sees assigned agents. Manager/Admin sees the full team.';
  const supSummary = Array.from(document.querySelectorAll('#supervisor-panel .sup-summary span'));
  if (supSummary[0]) supSummary[0].childNodes[0].nodeValue = isAr ? 'التشغيل: ' : 'Operating: ';
  if (supSummary[1]) supSummary[1].childNodes[0].nodeValue = isAr ? 'الاستراحة: ' : 'Break: ';
  if (supSummary[2]) supSummary[2].childNodes[0].nodeValue = isAr ? 'الاجتماع: ' : 'Meeting: ';
  if (supSummary[3]) supSummary[3].childNodes[0].nodeValue = isAr ? 'غير متاح: ' : 'Unavailable: ';

  const notesEmptyTitle = document.querySelector('#notes-empty-state h3');
  if (notesEmptyTitle) notesEmptyTitle.textContent = isAr ? 'اختر ملاحظة أو ابدأ واحدة جديدة' : 'Choose a note or start a new one';
  const notesEmptySub = document.querySelector('#notes-empty-state p');
  if (notesEmptySub) notesEmptySub.textContent = isAr ? 'الملاحظات محفوظة تلقائياً ومربوطة بحساب الموظف.' : 'Notes are saved automatically and linked to the agent account.';
  setText('#note-empty-new-btn', t.newNote);
  setText('#note-save-btn', isAr ? 'حفظ الآن' : 'Save now');
  setText('#notes-back-btn', isAr ? 'رجوع' : 'Back');

  setText('#shopify-live-search-btn', isAr ? 'بحث Shopify' : 'Search Shopify');
  setText('#shopify-live-use-btn', isAr ? 'استخدام في التذكرة' : 'Use in ticket');
  setText('#shopify-live-status', isAr ? 'لم يتم تحميل أي طلب Shopify بعد.' : 'No Shopify order has been loaded yet.');
  const ticketLabels = Array.from(document.querySelectorAll('#ticket-form .ticket-form-grid > label'));
  if (ticketLabels[0]) ticketLabels[0].childNodes[0].nodeValue = isAr ? 'رقم الطلب #' : 'Order number #';
  if (ticketLabels[1]) ticketLabels[1].childNodes[0].nodeValue = isAr ? 'الفئة' : 'Category';
  if (ticketLabels[2]) ticketLabels[2].childNodes[0].nodeValue = isAr ? 'الأولوية' : 'Priority';
  if (ticketLabels[3]) ticketLabels[3].childNodes[0].nodeValue = isAr ? 'تعيين إلى' : 'Assign to';
  if (ticketLabels[4]) ticketLabels[4].childNodes[0].nodeValue = isAr ? 'اسم العميل' : 'Customer name';
  if (ticketLabels[5]) ticketLabels[5].childNodes[0].nodeValue = isAr ? 'بريد العميل الإلكتروني' : 'Customer email';
  const ticketNotesLabel = document.querySelector('#ticket-notes')?.parentElement;
  if (ticketNotesLabel) ticketNotesLabel.childNodes[0].nodeValue = isAr ? 'ملاحظات داخلية' : 'Internal notes';
  setPlaceholder('#ticket-notes', isAr ? 'ما الذي حدث؟ وما الخطوة التالية المطلوبة؟' : 'What happened and what is the next required step?');
  const ticketFormClose = document.getElementById('ticket-form-close');
  if (ticketFormClose) ticketFormClose.setAttribute('aria-label', isAr ? 'إغلاق نموذج التذكرة' : 'Close ticket form');
  const ticketsListHead = document.querySelector('#page-tickets .tickets-list-head');
  if (ticketsListHead) ticketsListHead.textContent = isAr ? 'قائمة التذاكر' : 'Ticket Queue';
  setText('#ticket-detail-empty', isAr ? 'اختر تذكرة لعرض التفاصيل.' : 'Select a ticket to view details.');
  setText('#tickets-empty', isAr ? 'لا توجد تذاكر' : 'No tickets found');

  const reportFormLabels = Array.from(document.querySelectorAll('#report-form > label'));
  const rf = [
    isAr ? 'طارئ / مسائل عاجلة' : 'Emergency / urgent issues',
    isAr ? 'الشحنات المتأخرة' : 'Delayed shipments',
    isAr ? 'التذاكر المحلولة' : 'Solved tickets',
    isAr ? 'مؤجل للغد / للشفت التالي' : 'Pending tomorrow / next shift',
    isAr ? 'الإرجاع / الاستبدال' : 'Returns / exchange',
    isAr ? 'عملاء غاضبون أو حالات حساسة' : 'Angry customers or sensitive cases',
    isAr ? 'المهام المطلوبة' : 'Required actions',
    isAr ? 'ملاحظات عامة' : 'General notes',
  ];
  reportFormLabels.forEach((labelEl, i) => { if (rf[i]) labelEl.childNodes[0].nodeValue = rf[i]; });
  const reportGridLabels = Array.from(document.querySelectorAll('#report-form .report-form-grid > label'));
  if (reportGridLabels[0]) reportGridLabels[0].childNodes[0].nodeValue = isAr ? 'نوع التقرير' : 'Report type';
  if (reportGridLabels[1]) reportGridLabels[1].childNodes[0].nodeValue = isAr ? 'التاريخ' : 'Date';
  if (reportGridLabels[2]) reportGridLabels[2].childNodes[0].nodeValue = isAr ? 'العنوان' : 'Title';
  setPlaceholder('#report-title', isAr ? 'تقرير صباحي' : 'Morning report');
  const reportHint = document.getElementById('report-type-hint');
  if (reportHint) reportHint.textContent = isAr ? 'ملخص دعم يومي.' : 'Daily support summary.';
  const reportSaveBtn = document.querySelector('#report-form button[type="submit"]');
  if (reportSaveBtn) reportSaveBtn.textContent = isAr ? 'حفظ التقرير' : 'Save report';
  const histTitle = document.querySelector('#page-reports .reports-history-head h3');
  if (histTitle) histTitle.textContent = isAr ? 'سجل التقارير' : 'Reports log';
  const histSub = document.querySelector('#page-reports .reports-history-head .subtitle');
  if (histSub) histSub.textContent = isAr ? 'المدير يرى الكل، المشرف يرى فريقه، والموظف يرى تقاريره فقط.' : 'Manager sees everything, supervisor sees their team, and agents only see their own reports.';
  setText('#reports-empty', isAr ? 'لا توجد تقارير' : 'No reports found');
  setSelectOptions('#report-filter-type', { all: isAr ? 'كل الأنواع' : 'All types', morning:t.morning, midday:t.midday, evening:t.endShift });
  setSelectOptions('#report-filter-owner', { all: isAr ? 'كل الظاهرين' : 'All visible staff', mine: isAr ? 'تقاريري' : 'My reports' });
  const reportModalLabels = Array.from(document.querySelectorAll('#report-modal .modal-body > label'));
  reportModalLabels.forEach((labelEl, i) => { if (rf[i]) labelEl.childNodes[0].nodeValue = rf[i]; });
  const reportModalTitle = document.getElementById('report-modal-title');
  if (reportModalTitle && /^التقرير|Report$/i.test(reportModalTitle.textContent || '')) reportModalTitle.textContent = isAr ? 'التقرير' : 'Report';
  const reportModalBtns = Array.from(document.querySelectorAll('#report-modal .modal-actions button'));
  if (reportModalBtns[0]) reportModalBtns[0].textContent = isAr ? 'إغلاق' : 'Close';
  if (reportModalBtns[1]) reportModalBtns[1].textContent = isAr ? 'حفظ تعديلات التقرير' : 'Save report changes';

  const navMap = { home:t.homeLabel, tasks:t.notesLabel, tickets:t.ticketsLabel, reports:t.reportsLabel, payroll:t.payrollLabel, messages:t.messagesLabel, meetings:t.meetingsLabel, settings:t.settingsLabel };
  document.querySelectorAll('.nav-link[data-page]').forEach((btn) => {
    const page = btn.dataset.page;
    if (!page || !navMap[page]) return;
    const badge = btn.querySelector('#nav-messages-badge');
    Array.from(btn.childNodes).forEach((n) => { if (n.nodeType === Node.TEXT_NODE) n.remove(); });
    btn.prepend(document.createTextNode(navMap[page]));
    if (badge && !btn.contains(badge)) btn.appendChild(badge);
  });
  setText('#logout-btn', t.logout);
}


/* ------------------------------------------------------------------
   PHASE 21 — stronger language polish after dynamic page renders
   This avoids mixed Arabic/English labels when switching language/pages.
------------------------------------------------------------------- */
function phase21Set(selector, value) {
  const el = document.querySelector(selector);
  if (el && value != null) el.textContent = value;
}
function phase21All(selector, values) {
  const nodes = Array.from(document.querySelectorAll(selector));
  nodes.forEach((el, i) => { if (values[i] != null) el.textContent = values[i]; });
}
function phase21Ph(selector, value) {
  const el = document.querySelector(selector);
  if (el && value != null) el.setAttribute('placeholder', value);
}
function phase21Opt(selector, labels) {
  const el = document.querySelector(selector);
  if (!el) return;
  Array.from(el.options || []).forEach((o) => { if (Object.prototype.hasOwnProperty.call(labels, o.value)) o.textContent = labels[o.value]; });
}
function phase21ReplaceTextNodes(root, pairs) {
  if (!root) return;
  const skip = new Set(['SCRIPT','STYLE','TEXTAREA','INPUT','SELECT','OPTION']);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || skip.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      const txt = node.nodeValue || '';
      if (!txt.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((node) => {
    let txt = node.nodeValue;
    pairs.forEach(([a,b]) => { txt = txt.split(a).join(b); });
    node.nodeValue = txt;
  });
}
function applyPhase21LanguagePolish(lang = getLanguage()) {
  const isAr = lang === 'ar';
  document.body.dataset.language = isAr ? 'ar' : 'en';
  document.documentElement.dir = isAr ? 'rtl' : 'ltr';
  document.documentElement.lang = isAr ? 'ar' : 'en';

  if (!isAr) {
    phase21ReplaceTextNodes(document.getElementById('app') || document.body, [
      ['مرحباً،', 'Welcome,'], ['مرحباً', 'Welcome'], ['الحالة الحالية:', 'Current status:'], ['تغيير الحالة:', 'Change status:'],
      ['بدء الدوام', 'Clock in'], ['بدء الاستراحة', 'Start break'], ['إنهاء الدوام', 'Clock out'], ['متابعة حالة', 'Handling'],
      ['نظرة عامة على الفريق', 'Team Overview'], ['المشرف يرى الموظفين التابعين له، والمدير/الأدمن يرى الفريق بالكامل.', 'Supervisor sees assigned agents. Manager/Admin sees the full team.'],
      ['الموظف', 'Agent'], ['الدور', 'Role'], ['الحالة', 'Status'], ['تشغيل', 'Operating'], ['استراحة', 'Break'], ['غير متاح', 'Unavailable'], ['آخر دخول', 'Last login'], ['الأجر المتوقع', 'Estimated pay'],
      ['ملخص اليوم', "Today's Snapshot"], ['تذكيرات سريعة:', 'Quick reminders:'], ['المتواجدون الآن', 'Online now'], ['الساعة', 'Clock'], ['إلىday', 'Today'], ['اليوم', 'Today'], ['التاريخ المحلي', 'Local date'], ['دقيقة مستخدمة', 'minutes used'], ['ساعات العمل', 'Work hours'], ['المتبقي:', 'Remaining:'],
      ['الإعدادات', 'Settings'], ['تحديث المعلومات الشخصية', 'Update personal info'], ['الاسم الكامل', 'Full Name'], ['الكود:', 'Code:'], ['الدور:', 'Role:'], ['لغة النظام', 'System language'], ['لون الواجهة', 'Interface colour'], ['الخلفية', 'Background'], ['رفع صورة خلفية (اختياري)', 'Upload background image (optional)'], ['حذف الخلفية المرفوعة', 'Remove uploaded background'], ['تاريخ الميلاد', 'Birthday'], ['الملاحظات', 'Notes'], ['اكتب أي ملاحظة أو مشكلة...', 'Write any note or issue...'],
      ['تذاكر الدعم', 'Support tickets'], ['الطوارئ', 'Emergencies'], ['مشاكل الطلبات', 'order issues'], ['الإرجاع', 'returns'], ['ملاحظات داخلية', 'internal notes'], ['تحديث', 'Refresh'], ['تذكرة جديدة', 'New ticket'], ['مفتوحة', 'Open'], ['طارئ', 'Emergency'], ['مصعّدة', 'Escalated'], ['محلولة اليوم', 'Resolved today'], ['إنشاء التذكرة', 'Create ticket'], ['رقم الطلب فقط مطلوب، والباقي اختياري.', 'Only the order number is required. Everything else is optional.'], ['ملء تلقائي من رقم الطلب', 'Autofill from order number'], ['كل الحالات', 'All statuses'], ['كل الأولويات', 'All priorities'], ['حفظ التعديلات', 'Save changes'], ['تصعيد', 'Escalate'],
      ['التقارير اليومية', 'Daily reports'], ['إنشاء تقرير', 'Create report'], ['نوع التقرير', 'Report type'], ['تقرير صباحي', 'Morning report'], ['تقرير منتصف اليوم', 'Midday report'], ['تقرير نهاية الدوام', 'End of shift report'], ['استخدام القالب', 'Use template'], ['مسح', 'Clear'], ['التذاكر المحلولة', 'Solved tickets'], ['الشحنات المتأخرة', 'Delayed shipments'], ['مؤجل للغد', 'Pending tomorrow'], ['عملاء غاضبون أو حالات حساسة', 'Angry customers or sensitive cases'], ['المهام المطلوبة', 'Required actions'], ['ملاحظات عامة', 'General notes'],
      ['الاجتماعات', 'Meetings'], ['إنشاء', 'Create'], ['الاجتماعات القادمة', 'Upcoming meetings'], ['لا توجد اجتماعات قادمة', 'No upcoming meetings'], ['رابط الاجتماع', 'Meeting link'], ['رقم الاجتماع', 'Meeting ID'], ['كود الدخول', 'Passcode'], ['فتح الرابط', 'Open link'], ['كود جديد', 'New code'], ['حذف اجتماعي', 'Delete my meeting'], ['إظهار كلمة المرور', 'Show password'], ['إخفاء كلمة المرور', 'Hide password'], ['نسخ كلمة المرور', 'Copy Password'], ['نسخ رقم الاجتماع', 'Copy ID'], ['مشاركة', 'Share'], ['القائمة', 'Menu'], ['الرئيسية', 'Home'], ['التذاكر', 'Tickets'], ['التقارير', 'Reports'], ['الرواتب', 'Payroll'], ['الرسائل', 'Messages'], ['تسجيل الخروج', 'Logout']
    ]);
  }

  // Core controls and placeholders after broad text cleanup.
  phase21Set('#logout-btn', isAr ? 'تسجيل الخروج' : 'Logout');
  phase21Set('#ticket-refresh-btn', isAr ? 'تحديث' : 'Refresh');
  phase21Set('#ticket-new-toggle', isAr ? '+ تذكرة جديدة' : '+ New ticket');
  phase21Ph('#set-notes', isAr ? 'اكتب أي ملاحظة أو مشكلة...' : 'Write any note or issue...');
  phase21Ph('#ticket-search', isAr ? 'بحث برقم الطلب أو العميل أو الملاحظات…' : 'Search by order number, customer, or notes…');
  phase21Ph('#report-search', isAr ? 'بحث في التقارير...' : 'Search reports...');
  phase21Ph('#meeting-search', isAr ? 'البحث برقم الاجتماع / العنوان / المضيف…' : 'Search by meeting ID / title / host…');
  phase21Ph('#notes-search', isAr ? 'البحث في الملاحظات...' : 'Search notes...');
  phase21Ph('#note-title', isAr ? 'عنوان الملاحظة' : 'Note title');
  phase21Ph('#note-body', isAr ? 'ابدأ الكتابة...' : 'Start typing...');
  phase21Ph('#create-title', isAr ? 'العنوان (مثلاً: اجتماع يومي)' : 'Title (e.g. Daily meeting)');
  phase21Ph('#create-link', isAr ? 'ضع رابط Google Meet / Zoom / Teams' : 'Paste a Google Meet / Zoom / Teams link');
  phase21Ph('#join-meeting-id', isAr ? 'رقم الاجتماع' : 'Meeting ID');
  phase21Ph('#join-meeting-pass', isAr ? 'كود الدخول' : 'Passcode');

  phase21Opt('#status-select', isAr
    ? { in_operation:'قيد التشغيل', break:'استراحة', handling:'متابعة حالة', meeting:'اجتماع', unavailable:'غير متاح' }
    : { in_operation:'Operating', break:'Break', handling:'Handling', meeting:'Meeting', unavailable:'Unavailable' }
  );
  phase21Opt('#ticket-filter-status', isAr
    ? { all:'كل الحالات', open:'مفتوحة', waiting_customer:'بانتظار العميل', waiting_courier:'بانتظار الشحن', waiting_supplier:'بانتظار المورد', escalated:'مصعّدة', resolved:'محلولة', closed:'مغلقة' }
    : { all:'All statuses', open:'Open', waiting_customer:'Waiting customer', waiting_courier:'Waiting courier', waiting_supplier:'Waiting supplier', escalated:'Escalated', resolved:'Resolved', closed:'Closed' }
  );
  phase21Opt('#ticket-filter-priority', isAr
    ? { all:'كل الأولويات', emergency:'طارئ', high:'عالي', medium:'متوسط', normal:'عادي' }
    : { all:'All priorities', emergency:'Emergency', high:'High', medium:'Medium', normal:'Normal' }
  );
  phase21Opt('#report-type', isAr
    ? { morning:'تقرير صباحي', midday:'تقرير منتصف اليوم', evening:'تقرير نهاية الدوام' }
    : { morning:'Morning report', midday:'Midday report', evening:'End of shift report' }
  );

  phase21All('#page-home .sup-table th', isAr
    ? ['الموظف','CCMS','الدور','الحالة','تشغيل','استراحة','اجتماع','غير متاح','آخر دخول','الأجر المتوقع']
    : ['Agent','CCMS','Role','Status','Operating','Break','Meeting','Unavailable','Last login','Estimated pay']
  );
  const mainNav = document.getElementById('main-nav');
  if (mainNav) mainNav.dataset.menuTitle = isAr ? 'القائمة' : 'Menu';
}

try {
  window.addEventListener('telesyriana:language-changed', (e) => {
    const lang = e?.detail?.language || getLanguage();
    setTimeout(() => applyPhase21LanguagePolish(lang), 0);
    setTimeout(() => applyPhase21LanguagePolish(lang), 180);
  });
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => applyPhase21LanguagePolish(getLanguage()), 120);
    setTimeout(() => applyPhase21LanguagePolish(getLanguage()), 500);
  });
  document.addEventListener('click', (e) => {
    if (e.target?.closest?.('.nav-link,[data-page],#set-language')) {
      setTimeout(() => applyPhase21LanguagePolish(getLanguage()), 120);
    }
  });
} catch {}
