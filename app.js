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

const AGENT_DAYS_COL = "agentDays";
const USER_PROFILE_COL = "userProfiles";

let currentUser = null;
let state = null;
let timerId = null;
let supUnsub = null;

// -------------------------------- helpers --------------------------------

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
 * Rules:
 *  - < 60: "59 min"
 *  - 60: "1 hr"
 *  - 61: "1 hr 1 min"
 *  - 120: "2 hrs"
 *  - 121: "2 hrs 1 min"
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

function recomputeLiveUsage(now) {
  if (!state) {
    return { breakUsed: 0, operation: 0, meeting: 0, handling: 0, unavailable: 0 };
  }

  const elapsedMin = (now - state.lastStatusChange) / 60000;

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

function applyElapsedToState(now) {
  if (!state) return;

  const elapsedMin = (now - state.lastStatusChange) / 60000;
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

  state.lastStatusChange = now;
}

// --------------------------- Firestore sync -----------------------------

async function syncStateToFirestore(live) {
  if (!currentUser || !state) return;

  const today = state.day || getTodayKey();
  const id = `${today}_${currentUser.id}`;
  const usage = live || recomputeLiveUsage(Date.now());

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

// --------------------------- Local storage ------------------------------

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

// --------------------------- UI init -----------------------------------

document.addEventListener("DOMContentLoaded", () => {
  const navButtons = document.querySelectorAll(".nav-link[data-page]");

  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => switchPage(btn.dataset.page));
  });

  document.getElementById("login-form").addEventListener("submit", handleLogin);
  document.getElementById("logout-btn").addEventListener("click", handleLogout);
  document.getElementById("status-select").addEventListener("change", handleStatusChange);
  document.getElementById("settings-form").addEventListener("submit", handleSettingsSave);

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

// -------------------------- Pages switching -----------------------------

function switchPage(pageId) {
  // أخفي كل الصفحات
  document.querySelectorAll(".page-section").forEach((pg) => pg.classList.add("hidden"));
  document.getElementById(`page-${pageId}`).classList.remove("hidden");

  // فعل زر الـ nav
  document.querySelectorAll(".nav-link[data-page]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === pageId);
  });

  // تحكم بأيقونة الشات العائم
  const floatToggle = document.getElementById("float-chat-toggle");
  if (!floatToggle) return;

  if (!currentUser || pageId === "messages") {
    floatToggle.classList.add("hidden");
  } else {
    floatToggle.classList.remove("hidden");
  }
}

// -------------------------- Login / Logout ------------------------------

function handleLogin(e) {
  e.preventDefault();

  const id = document.getElementById("ccmsId").value.trim();
  const pw = document.getElementById("password").value;

  if (!USERS[id]) return showError("User not found.");
  if (USERS[id].password !== pw) return showError("Incorrect password.");

  currentUser = { id, name: USERS[id].name, role: USERS[id].role };
  localStorage.setItem(USER_KEY, JSON.stringify(currentUser));

  // ✅ خلي messages.js يعرف إنو في user جديد (بدون Refresh)
  window.dispatchEvent(new Event("telesyriana:user-changed"));

  document.getElementById("login-error").classList.add("hidden");

  initStateForUser();
  showDashboard();
}

async function handleLogout() {
  if (currentUser && state) {
    const now = Date.now();
    applyElapsedToState(now);
    state.status = "unavailable";
    state.lastStatusChange = now;
    saveState();
    await syncStateToFirestore(recomputeLiveUsage(now));
  }

  localStorage.removeItem(USER_KEY);

  // ✅ خلي messages.js يعرف إنو ما عاد في user
  window.dispatchEvent(new Event("telesyriana:user-changed"));

  if (timerId) clearInterval(timerId);
  if (supUnsub) supUnsub();

  currentUser = null;
  state = null;

  showLogin();
}

function showError(msg) {
  const box = document.getElementById("login-error");
  box.textContent = msg;
  box.classList.remove("hidden");
}

// --------------------- Status change (FIX) ------------------------------

async function handleStatusChange(e) {
  if (!state || !currentUser) return;

  const newStatus = e.target.value;
  const now = Date.now();

  // لو خلص البريك
  if (newStatus === "break" && state.breakUsedMinutes >= BREAK_LIMIT_MIN - 0.01) {
    alert("Daily break limit (45 minutes) already reached.");
    e.target.value = state.status;
    return;
  }

  // ثبّت الزمن على الحالة القديمة
  applyElapsedToState(now);

  // غيّر الحالة
  state.status = newStatus;
  state.lastStatusChange = now;
  saveState();

  const live = recomputeLiveUsage(now);
  await syncStateToFirestore(live);
  updateDashboardUI();
}

// ---------------------------- Init Session ------------------------------

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
  syncStateToFirestore(recomputeLiveUsage(now));
}

// ----------------------------- Timer -----------------------------------

function startTimer() {
  if (timerId) clearInterval(timerId);
  timerId = setInterval(tick, 10000);
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

    await syncStateToFirestore(recomputeLiveUsage(now));
    updateDashboardUI();
    return;
  }

  updateBreakUI(live.breakUsed);
  updateStatusMinutesUI(live);

  await syncStateToFirestore(live);
}

// ------------------------- Dashboard UI --------------------------------

function updateDashboardUI() {
  if (!currentUser || !state) return;

  const welcomeTitle = document.getElementById("welcome-title");
  const welcomeSubtitle = document.getElementById("welcome-subtitle");
  const statusValue = document.getElementById("status-value");
  const statusSelect = document.getElementById("status-select");

  welcomeTitle.textContent = `Welcome, ${currentUser.name}`;
  welcomeSubtitle.textContent = `Logged in as ${currentUser.role.toUpperCase()} (CCMS: ${currentUser.id})`;

  statusValue.textContent = statusLabel(state.status);
  statusValue.className = `status-value status-${state.status}`;

  statusSelect.value = state.status;

  const live = recomputeLiveUsage(Date.now());
  updateBreakUI(live.breakUsed);
  updateStatusMinutesUI(live);

  document.getElementById("supervisor-panel").classList.toggle(
    "hidden",
    currentUser.role !== "supervisor"
  );
}

function updateBreakUI(used) {
  // keep break counter as minutes (because limit is 45 and it's clearer)
  document.getElementById("break-used").textContent = Math.floor(used);
  document.getElementById("break-remaining").textContent = Math.max(
    0,
    BREAK_LIMIT_MIN - Math.floor(used)
  );
}

function updateStatusMinutesUI(live) {
  // ✅ NEW: show in hr/min format
  document.getElementById("op-min").textContent = formatDuration(live.operation);
  document.getElementById("meet-min").textContent = formatDuration(live.meeting);
  document.getElementById("hand-min").textContent = formatDuration(live.handling);
}

// -------------------------- Supervisor Table ----------------------------

function buildSupervisorTableFromFirestore(rows) {
  const body = document.getElementById("sup-table-body");
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
        <td>${r.role.toUpperCase()}</td>
        <td><span class="sup-status-pill status-${status}">${statusLabel(status)}</span></td>
        <td>${formatDuration(r.operationMinutes || 0)}</td>
        <td>${Math.floor(r.breakUsedMinutes || 0)} min</td>
        <td>${formatDuration(r.meetingMinutes || 0)}</td>
        <td>${formatDuration(r.unavailableMinutes || 0)}</td>
        <td>${r.loginTime ? new Date(r.loginTime).toLocaleString() : "Never"}</td>
      `;
      body.appendChild(tr);
    });

  document.getElementById("sum-op").textContent = totals.in_operation;
  document.getElementById("sum-break").textContent = totals.break;
  document.getElementById("sum-meet").textContent = totals.meeting;
  document.getElementById("sum-unavail").textContent = totals.unavailable;
}

// ----------------------------- Settings --------------------------------

async function loadUserProfile() {
  if (!currentUser) return;

  const ref = doc(collection(db, USER_PROFILE_COL), currentUser.id);
  const snap = await getDoc(ref);

  document.getElementById("set-name").value = currentUser.name;

  if (snap.exists()) {
    const d = snap.data();
    document.getElementById("set-birthday").value = d.birthday || "";
    document.getElementById("set-notes").value = d.notes || "";
  }
}

async function handleSettingsSave(e) {
  e.preventDefault();
  if (!currentUser) return;

  const birthday = document.getElementById("set-birthday").value;
  const notes = document.getElementById("set-notes").value;

  const ref = doc(collection(db, USER_PROFILE_COL), currentUser.id);

  await setDoc(
    ref,
    {
      userId: currentUser.id,
      name: currentUser.name,
      birthday,
      notes,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  alert("Settings saved successfully.");
}

// --------------------------- View switching ----------------------------

function showLogin() {
  document.getElementById("dashboard-screen").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("main-nav").classList.add("hidden");

  const floatToggle = document.getElementById("float-chat-toggle");
  if (floatToggle) floatToggle.classList.add("hidden");
}

function showDashboard() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("dashboard-screen").classList.remove("hidden");
  document.getElementById("main-nav").classList.remove("hidden");

  switchPage("home");
  updateDashboardUI();
}
