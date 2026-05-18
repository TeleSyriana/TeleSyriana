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
  "0001": { password: "Welcome 2026!", role: "agent", name: "Agent Raghad", supervisorId: "1001", hourlyRate: 1.25, currency: "USD" },
  "0002": { password: "Welcome 2026!", role: "agent", name: "Agent Qamar", supervisorId: "1001", hourlyRate: 1.25, currency: "USD" },
  "0003": { password: "Welcome 2026!", role: "agent", name: "Agent", supervisorId: "1001", hourlyRate: 1.25, currency: "USD" },
  "1001": { password: "2411", role: "supervisor", name: "Supervisor Dema", hourlyRate: 1.75, currency: "USD" },
  "2001": { password: "2411", role: "manager", name: "Manager Mohammad", hourlyRate: 0, currency: "GBP" },
  "9001": { password: "2411", role: "admin", name: "Owner Admin", hourlyRate: 0, currency: "GBP" },
};

const ROLE_LEVELS = {
  agent: 1,
  supervisor: 2,
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
  switch (String(role || "").toLowerCase()) {
    case "agent": return "موظف دعم";
    case "supervisor": return "مشرف";
    case "manager": return "مدير";
    case "admin": return "أدمن";
    default: return role || "—";
  }
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
const WORK_TARGET_MIN = 8 * 60;

const AGENT_DAYS_COL = "agentDays";
const USER_PROFILE_COL = "userProfiles";
const USER_PRESENCE_COL = "userPresence";

let currentUser = null;
let state = null;
let timerId = null;
let supUnsub = null;
let presenceUnsub = null;
let presenceTimerId = null;
let issueCalendarUnsub = null;
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
  switch (code) {
    case "in_operation":
      return "Operating";
    case "break":
      return "Break";
    case "meeting":
      return "Meeting";
    case "handling":
      return "Handling";
    case "unavailable":
      return "Unavailable";
    default:
      return code;
  }
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

function updateWorkUI(workedMin) {
  const used = Math.max(0, Math.floor(workedMin));
  const remaining = Math.max(0, WORK_TARGET_MIN - used);

  // text
  const workText = document.getElementById("work-text");
  const targetText = document.getElementById("work-target-text");
  const remainingText = document.getElementById("work-remaining-text");

  if (workText) workText.textContent = formatDuration(used);
  if (targetText) targetText.textContent = formatDuration(WORK_TARGET_MIN);
  if (remainingText) remainingText.textContent = formatDuration(remaining);

  // ring
  const pct =
    WORK_TARGET_MIN > 0 ? Math.min(100, Math.round((used / WORK_TARGET_MIN) * 100)) : 0;
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
      if (stats) {
        if (stats.risk >= 3) cell.classList.add("issue-high");
        else if (stats.risk >= 1) cell.classList.add("issue-mid");
        else if (stats.total >= 1) cell.classList.add("issue-low");
        cell.title = `${stats.total} tickets • ${stats.risk} risk issues`;
      }
      if (isThisMonth && dayNum === today.getDate()) cell.classList.add("today");
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

function renderOnlineNow(rows) {
  const list = document.getElementById("online-now-list");
  const count = document.getElementById("online-now-count");
  if (!list || !count) return;
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

function startPresence() {
  if (!currentUser) return;
  subscribePresence();
  updatePresence(true);
  if (presenceTimerId) clearInterval(presenceTimerId);
  presenceTimerId = setInterval(() => updatePresence(false), 30_000);
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
function subscribeIssueCalendar() {
  if (issueCalendarUnsub) return;
  try {
    issueCalendarUnsub = onSnapshot(collection(db, "tickets"), (snapshot) => {
      const stats = {};
      snapshot.forEach((d) => {
        const t = d.data();
        const key = dateKeyFromValue(t.createdAt || t.updatedAt);
        if (!stats[key]) stats[key] = { total: 0, risk: 0 };
        stats[key].total += 1;
        if (["emergency", "high"].includes(t.priority) || ["chargeback", "high"].includes(t.risk) || t.type === "item_not_genuine") {
          stats[key].risk += 1;
        }
      });
      issueStatsByDay = stats;
      buildMiniCalendar();
      const summary = document.getElementById("issue-calendar-summary");
      if (summary) {
        const today = getTodayKey();
        const s = stats[today] || { total: 0, risk: 0 };
        summary.textContent = `Today: ${s.total} tickets • ${s.risk} risk issues. Add daily sales later for real issue-rate %.`;
      }
    }, (err) => console.warn("issue calendar listener failed", err));
  } catch (err) {
    console.warn("issue calendar init failed", err);
  }
}

/* --------------------------- UI init ------------------------------------ */

document.addEventListener("DOMContentLoaded", async () => {
  applyLanguage(localStorage.getItem(LANGUAGE_KEY) || "ar");
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
  });

  try {
    const savedUser = localStorage.getItem(USER_KEY);
    if (savedUser) {
      const u = JSON.parse(savedUser);
      if (USERS[u.id]) {
        // Refresh saved sessions from the current role map, so role changes apply after updates.
        currentUser = safeUserPayload(u.id);
        localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
        await initStateForUser();
        showDashboard();
        return;
      }
    }
  } catch (err) {
    console.warn("Saved session ignored:", err);
    localStorage.removeItem(USER_KEY);
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

  if (!USERS[id]) return showError("المستخدم غير موجود. جرّب 0001 أو 0002 أو 1001 أو 2001 أو 9001.");
  if (USERS[id].password !== pw) return showError("كلمة المرور غير صحيحة.");

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.dataset.originalText = submitBtn.textContent;
      submitBtn.textContent = "جاري الدخول...";
    }

    currentUser = safeUserPayload(id);
    localStorage.setItem(USER_KEY, JSON.stringify(currentUser));

    // reset throttling for new session
    lastSyncMs = 0;
    lastSyncStatus = null;
    lastSyncPayloadHash = "";

    document.getElementById("login-error")?.classList.add("hidden");

    await initStateForUser();
    showDashboard();
    window.dispatchEvent(new Event("telesyriana:user-changed"));
  } catch (err) {
    console.error("Login failed:", err);
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

  if (welcomeTitle) welcomeTitle.textContent = `مرحباً، ${currentUser.name}`;
  if (welcomeSubtitle) {
    welcomeSubtitle.textContent = `Logged in as ${currentUser.role.toUpperCase()} (CCMS: ${currentUser.id})`;
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
  return stored === "en" ? "en" : "ar";
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
  setLabelFor("set-bg-upload", dict.uploadBg);
  setLabelFor("set-birthday", dict.birthday);
  setLabelFor("set-notes", dict.notes);
  setText('#settings-form button[type="submit"]', dict.save);
  const menuTitle = document.querySelector(".mobile-drawer-title");
  if (menuTitle) menuTitle.textContent = dict.menu;

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
    currentUser = { ...currentUser, name: cached.name };
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

  try {
    const ref = doc(collection(db, USER_PROFILE_COL), currentUser.id);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const d = snap.data();
      const savedName = d.name || currentUser.name || currentUser.id;
      currentUser = { ...currentUser, name: savedName };
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
      localStorage.setItem(profileCacheKey(currentUser.id), JSON.stringify({
        name: d.name || currentUser.name || "",
        birthday: d.birthday || "",
        notes: d.notes || "",
        gender: d.gender || "",
        language: d.language || savedLanguage || "ar",
        background: d.background || "default",
        backgroundImage: d.backgroundImage || cached.backgroundImage || "",
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

  applyLanguage(language);
  applyTheme(gender);
  applyBackground(background, backgroundImage);
  currentUser = { ...currentUser, name };
  localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
  localStorage.setItem(profileCacheKey(currentUser.id), JSON.stringify({ name, birthday, notes, gender, language, background, backgroundImage }));
  updateDashboardUI();
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
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    showSettingsAlert("تم حفظ الإعدادات بنجاح.");
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
      showSettingsAlert("تم تحميل الخلفية محلياً. اضغط حفظ للمزامنة عندما تكون Firestore جاهزة.");
    };
    reader.readAsDataURL(file);
  }
});

/* --------------------------- View switching ----------------------------- */

function showLogin() {
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
