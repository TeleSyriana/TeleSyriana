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
const USERS = {
  "1001": { password: "1234", role: "agent", name: "Agent 01" },
  "1002": { password: "1234", role: "agent", name: "Agent 02" },
  "1003": { password: "1234", role: "agent", name: "Agent 03" },
  "2001": { password: "sup123", role: "supervisor", name: "Supervisor Dema" },
  "2002": { password: "sup123", role: "supervisor", name: "Supervisor Moustafa" },
};

const USER_KEY = "telesyrianaUser";
const STATE_KEY = "telesyrianaState";
const BREAK_LIMIT_MIN = 45;

// ✅ Work target (8 hours)
const WORK_TARGET_MIN = 8 * 60;

const AGENT_DAYS_COL = "agentDays";
const USER_PROFILE_COL = "userProfiles";

let currentUser = null;
let state = null;
let timerId = null;
let supUnsub = null;

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
  if (!currentUser || currentUser.role !== "supervisor") return;
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

/* --------------------------- UI init ------------------------------------ */

document.addEventListener("DOMContentLoaded", () => {
  // ✅ menu navigation
  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const page = btn.dataset.page;
      if (!page) return;
      e.preventDefault();
      switchPage(page);
    });
  });

  document.getElementById("login-form")?.addEventListener("submit", handleLogin);
  document.getElementById("logout-btn")?.addEventListener("click", handleLogout);
  document.getElementById("status-select")?.addEventListener("change", handleStatusChange);
  document.getElementById("settings-form")?.addEventListener("submit", handleSettingsSave);

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
  });

  const savedUser = localStorage.getItem(USER_KEY);
  if (savedUser) {
    const u = JSON.parse(savedUser);
    if (USERS[u.id]) {
      currentUser = u;
      initStateForUser();
      showDashboard();
      return;
    }
  }

  showLogin();
});

/* -------------------------- Pages switching ----------------------------- */

function switchPage(pageId) {
  document.querySelectorAll(".page-section").forEach((pg) => pg.classList.add("hidden"));

  const target = document.getElementById(`page-${pageId}`);
  if (!target) {
    console.warn(`Page not found: page-${pageId}. Check your HTML IDs.`);
    return;
  }
  target.classList.remove("hidden");

  document.querySelectorAll(".nav-link[data-page]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === pageId);
  });

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

function handleLogin(e) {
  e.preventDefault();

  const id = document.getElementById("ccmsId")?.value?.trim() || "";
  const pw = document.getElementById("password")?.value || "";

  if (!USERS[id]) return showError("User not found.");
  if (USERS[id].password !== pw) return showError("Incorrect password.");

  currentUser = { id, name: USERS[id].name, role: USERS[id].role };
  localStorage.setItem(USER_KEY, JSON.stringify(currentUser));

  // reset throttling for new session
  lastSyncMs = 0;
  lastSyncStatus = null;
  lastSyncPayloadHash = "";

  window.dispatchEvent(new Event("telesyriana:user-changed"));
  document.getElementById("login-error")?.classList.add("hidden");

  initStateForUser();
  showDashboard();
}

async function handleLogout() {
  closeFloatingChat();

  if (currentUser && state) {
    const now = Date.now();
    applyElapsedToState(now);
    state.status = "unavailable";
    state.lastStatusChange = now;
    saveState();

    try {
      await syncStateToFirestore(recomputeLiveUsage(now), true); // ✅ force
    } catch {}
  }

  localStorage.removeItem(USER_KEY);

  window.dispatchEvent(new Event("telesyriana:user-changed"));

  if (timerId) clearInterval(timerId);
  timerId = null;

  if (clockIntervalId) clearInterval(clockIntervalId);
  clockIntervalId = null;

  if (supUnsub) supUnsub();
  supUnsub = null;

  currentUser = null;
  state = null;

  showLogin();
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

async function initStateForUser() {
  const today = getTodayKey();
  const now = Date.now();

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
    state = {
      userId: currentUser.id,
      day: today,
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

  saveState();
  finishInit(now);
}

function finishInit(now) {
  if (currentUser.role === "supervisor") subscribeSupervisorDashboard();

  loadUserProfile();
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
  timerId = setInterval(tick, 60000); // ✅ every 1 minute (prevents 429)
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

  if (welcomeTitle) welcomeTitle.textContent = `Welcome, ${currentUser.name}`;
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
  if (supPanel) supPanel.classList.toggle("hidden", currentUser.role !== "supervisor");
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

  rows
    .filter((r) => r.role === "agent")
    .forEach((r) => {
      const status = r.status || "unavailable";
      totals[status]++;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.name}</td>
        <td>${r.userId}</td>
        <td>${String(r.role || "").toUpperCase()}</td>
        <td><span class="sup-status-pill status-${status}">${statusLabel(status)}</span></td>
        <td>${formatDuration(r.operationMinutes || 0)}</td>
        <td>${Math.floor(r.breakUsedMinutes || 0)} min</td>
        <td>${formatDuration(r.meetingMinutes || 0)}</td>
        <td>${formatDuration(r.unavailableMinutes || 0)}</td>
        <td>${r.loginTime ? new Date(r.loginTime).toLocaleString() : "Never"}</td>
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

function applyTheme(gender) {
  const g = String(gender || "").toLowerCase().trim();
  document.body.removeAttribute("data-theme");
  if (g === "male" || g === "female") {
    document.body.setAttribute("data-theme", g);
  }
}

async function loadUserProfile() {
  if (!currentUser) return;

  const ref = doc(collection(db, USER_PROFILE_COL), currentUser.id);
  const snap = await getDoc(ref);

  const nameEl = document.getElementById("set-name");
  if (nameEl) nameEl.value = currentUser.name;

  const bdayEl = document.getElementById("set-birthday");
  const notesEl = document.getElementById("set-notes");
  const genderEl = document.getElementById("set-gender");

  if (snap.exists()) {
    const d = snap.data();

    if (bdayEl) bdayEl.value = d.birthday || "";
    if (notesEl) notesEl.value = d.notes || "";
    if (genderEl) genderEl.value = d.gender || "";

    applyTheme(d.gender);
  } else {
    if (genderEl) genderEl.value = "";
    applyTheme("");
  }
}

async function handleSettingsSave(e) {
  e.preventDefault();
  if (!currentUser) return;

  const birthday = document.getElementById("set-birthday")?.value || "";
  const notes = document.getElementById("set-notes")?.value || "";
  const gender = document.getElementById("set-gender")?.value || "";

  const ref = doc(collection(db, USER_PROFILE_COL), currentUser.id);

  await setDoc(
    ref,
    {
      userId: currentUser.id,
      name: currentUser.name,
      birthday,
      notes,
      gender,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  applyTheme(gender);
  alert("Settings saved successfully.");
}

/* --------------------------- View switching ----------------------------- */

function showLogin() {
  document.getElementById("dashboard-screen")?.classList.add("hidden");
  document.getElementById("login-screen")?.classList.remove("hidden");
  document.getElementById("main-nav")?.classList.add("hidden");

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

  switchPage("home");
  updateDashboardUI();

  renderClockWidget();
  buildMiniCalendar();
  hookCalendarButtons();

  if (!clockIntervalId) {
    clockIntervalId = setInterval(renderClockWidget, 1000);
  }
}
