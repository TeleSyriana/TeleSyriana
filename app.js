// app.js — TeleSyriana Agent Access Panel (Firestore + daily docs)

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

// Demo users – مؤقتاً هون (ممكن ننقلهم لـ Auth بعدين)
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
const AGENT_DAYS_COL = "agentDays"; // collection name في Firestore

let currentUser = null;
let state = null;
let timerId = null;
let supUnsub = null;

// ---------- Helpers ----------

function getTodayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`; // e.g. 2025-12-11
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

// يرجّع usage live بدون ما يغيّر state المخزّن
function recomputeLiveUsage(now) {
  if (!state) {
    return {
      breakUsed: 0,
      operation: 0,
      meeting: 0,
      handling: 0,
      unavailable: 0,
    };
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

  return {
    breakUsed: br,
    operation: op,
    meeting: meet,
    handling: hand,
    unavailable: unav,
  };
}

// يثبّت الزمن المنقضي في state عند تغيير الـ status
function applyElapsedToState(now) {
  if (!state) return;

  const elapsedMin = (now - state.lastStatusChange) / 60000;
  if (elapsedMin <= 0) return;

  switch (state.status) {
    case "in_operation":
      state.operationMinutes += elapsedMin;
      break;
    case "break":
      state.breakUsedMinutes = Math.min(
        BREAK_LIMIT_MIN,
        state.breakUsedMinutes + elapsedMin
      );
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

// ---------- Firestore sync ----------

async function syncStateToFirestore(liveUsage) {
  try {
    if (!currentUser || !state) return;

    const today = state.day || getTodayKey();
    const id = `${today}_${currentUser.id}`;
    const usage = liveUsage || recomputeLiveUsage(Date.now());

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
  } catch (err) {
    console.error("syncStateToFirestore error:", err);
  }
}

// ما عاد نفلتر role في Firestore، بس نفلتر اليوم، والباقي في JS
function subscribeSupervisorDashboard() {
  if (!currentUser || currentUser.role !== "supervisor") return;
  if (supUnsub) return;

  const today = getTodayKey();

  const q = query(
    collection(db, AGENT_DAYS_COL),
    where("day", "==", today)
  );

  supUnsub = onSnapshot(
    q,
    (snapshot) => {
      const rows = [];
      snapshot.forEach((d) => rows.push(d.data()));
      buildSupervisorTableFromFirestore(rows);
    },
    (err) => console.error("Supervisor snapshot error:", err)
  );
}

// ---------- Local storage state ----------

function saveState() {
  if (!state) return;
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function loadStateForToday(userId) {
  const today = getTodayKey();
  const raw = localStorage.getItem(STATE_KEY);
  if (!raw) return null;

  try {
    const s = JSON.parse(raw);
    if (s && s.userId === userId && s.day === today) return s;
  } catch {
    return null;
  }
  return null;
}

// ---------- Login / init ----------

document.addEventListener("DOMContentLoaded", () => {
  const loginForm = document.getElementById("login-form");
  const logoutBtn = document.getElementById("logout-btn");
  const statusSelect = document.getElementById("status-select");

  const savedUser = localStorage.getItem(USER_KEY);
  if (savedUser) {
    try {
      const parsed = JSON.parse(savedUser);
      if (parsed && USERS[parsed.id]) {
        currentUser = parsed;
        initStateForUser();
        showDashboard();
      } else {
        showLogin();
      }
    } catch {
      showLogin();
    }
  } else {
    showLogin();
  }

  loginForm.addEventListener("submit", handleLogin);
  logoutBtn.addEventListener("click", handleLogout);
  statusSelect.addEventListener("change", handleStatusChange);
});

// ✅ تحديث: initStateForUser تستخدم localStorage أولاً ثم Firestore
async function initStateForUser() {
  const today = getTodayKey();
  const now = Date.now();

  // 1) جرّب الـ localStorage لنفس اليوم
  const local = loadStateForToday(currentUser.id);
  if (local) {
    state = local;
    finishInit(now);
    return;
  }

  // 2) لو مافي لوكال، جرّب Firestore: agentDays/<today>_<CCMS>
  const docId = `${today}_${currentUser.id}`;
  const ref = doc(collection(db, AGENT_DAYS_COL), docId);

  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const d = snap.data();
      state = {
        userId: currentUser.id,
        day: today,
        status: d.status || "in_operation",
        lastStatusChange: now, // نبدأ من وقت الدخول الحالي
        breakUsedMinutes: d.breakUsedMinutes || 0,
        operationMinutes: d.operationMinutes || 0,
        meetingMinutes: d.meetingMinutes || 0,
        handlingMinutes: d.handlingMinutes || 0,
        unavailableMinutes: d.unavailableMinutes || 0,
        loginTime: d.loginTime || now,
      };
    } else {
      // 3) لا لوكال ولا Firestore → يوم جديد
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
  } catch (err) {
    console.error("Error loading from Firestore:", err);
    // لو صار خطأ برضو نبدأ يوم جديد
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

// دالة مساعدة تكمل الإقلاع بعد ما نحدد state
function finishInit(now) {
  if (currentUser.role === "supervisor") {
    subscribeSupervisorDashboard();
  }
  startTimer();
  const live = recomputeLiveUsage(now);
  syncStateToFirestore(live);
}

// ---------- Screen switching ----------

function showLogin() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("dashboard-screen").classList.add("hidden");
}

function showDashboard() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("dashboard-screen").classList.remove("hidden");
  updateDashboardUI();
}

// ---------- Login / logout handlers ----------

function handleLogin(e) {
  e.preventDefault();
  const idInput = document.getElementById("ccmsId");
  const pwInput = document.getElementById("password");
  const errorBox = document.getElementById("login-error");

  const id = idInput.value.trim();
  const pw = pwInput.value;

  if (!id || !pw) {
    showError("Please enter both CCMS ID and password.");
    return;
  }

  const user = USERS[id];
  if (!user) {
    showError("User not found. Please check your CCMS ID.");
    return;
  }
  if (user.password !== pw) {
    showError("Incorrect password. Please try again.");
    return;
  }

  errorBox.classList.add("hidden");

  currentUser = { id, name: user.name, role: user.role };
  localStorage.setItem(USER_KEY, JSON.stringify(currentUser));

  idInput.value = "";
  pwInput.value = "";

  initStateForUser();
  showDashboard();
}

// ✅ تحديث: Logout = يحوّل الحالة لـ Unavailable ويسجّلها
async function handleLogout() {
  if (currentUser && state) {
    const now = Date.now();

    // ثبّت الزمن المنقضي على الحالة الحالية
    applyElapsedToState(now);

    // غيّر الحالة لـ Unavailable
    state.status = "unavailable";
    state.lastStatusChange = now;
    saveState();

    // ارفع الأرقام النهائية لليوم
    const live = recomputeLiveUsage(now);
    await syncStateToFirestore(live);
  }

  // بعدها طلّع المستخدم
  localStorage.removeItem(USER_KEY);

  if (timerId) clearInterval(timerId);
  if (supUnsub) {
    supUnsub();
    supUnsub = null;
  }

  currentUser = null;
  state = null;
  showLogin();
}

function showError(message) {
  const errorBox = document.getElementById("login-error");
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

// ---------- Status change ----------

async function handleStatusChange(e) {
  if (!state || !currentUser) return;

  const newStatus = e.target.value;
  const now = Date.now();

  // Break limit check
  if (
    newStatus === "break" &&
    state.breakUsedMinutes >= BREAK_LIMIT_MIN - 0.01
  ) {
    alert("Daily break limit (45 minutes) already reached.");
    e.target.value = state.status;
    return;
  }

  applyElapsedToState(now);

  state.status = newStatus;
  state.lastStatusChange = now;
  saveState();

  const live = recomputeLiveUsage(now);
  await syncStateToFirestore(live);

  updateDashboardUI();
}

// ---------- Timer / tick ----------

function startTimer() {
  if (timerId) clearInterval(timerId);
  timerId = setInterval(tick, 10000); // كل 10 ثواني
  tick();
}

async function tick() {
  if (!state || !currentUser) return;

  const now = Date.now();
  const live = recomputeLiveUsage(now);

  // enforce break limit → auto Unavailable
  if (state.status === "break" && live.breakUsed >= BREAK_LIMIT_MIN) {
    applyElapsedToState(now);
    state.status = "unavailable";
    state.lastStatusChange = now;
    saveState();

    alert("Break limit (45 minutes) reached. Status set to Unavailable.");

    const newLive = recomputeLiveUsage(now);
    await syncStateToFirestore(newLive);
    updateDashboardUI();
    return;
  }

  updateBreakUI(live.breakUsed);
  updateStatusMinutesUI(live);
  await syncStateToFirestore(live);
}

// ---------- Dashboard UI ----------

function updateDashboardUI() {
  if (!state || !currentUser) return;

  const welcomeTitle = document.getElementById("welcome-title");
  const welcomeSubtitle = document.getElementById("welcome-subtitle");
  const statusValue = document.getElementById("status-value");
  const statusSelect = document.getElementById("status-select");
  const supPanel = document.getElementById("supervisor-panel");

  welcomeTitle.textContent = `Welcome, ${currentUser.name}`;
  welcomeSubtitle.textContent = `Logged in as ${currentUser.role.toUpperCase()} (CCMS: ${currentUser.id})`;

  statusValue.textContent = statusLabel(state.status);
  statusValue.className = "status-value status-" + state.status;

  statusSelect.value = state.status;

  const live = recomputeLiveUsage(Date.now());
  updateBreakUI(live.breakUsed);
  updateStatusMinutesUI(live);

  if (currentUser.role === "supervisor") {
    supPanel.classList.remove("hidden");
    subscribeSupervisorDashboard();
  } else {
    supPanel.classList.add("hidden");
  }
}

function updateBreakUI(usedMinutes) {
  const usedElem = document.getElementById("break-used");
  const remainingElem = document.getElementById("break-remaining");

  const usedRounded = Math.floor(usedMinutes || 0);
  const remaining = Math.max(0, BREAK_LIMIT_MIN - usedRounded);

  if (usedElem) usedElem.textContent = usedRounded;
  if (remainingElem) remainingElem.textContent = remaining;
}

// هنا استخدمنا IDs الموجودة فعلياً في الـ HTML:
// op-min, meet-min, hand-min
function updateStatusMinutesUI(live) {
  const opEl = document.getElementById("op-min");
  const meetEl = document.getElementById("meet-min");
  const handEl = document.getElementById("hand-min");

  if (opEl) opEl.textContent = Math.floor(live.operation || 0);
  if (meetEl) meetEl.textContent = Math.floor(live.meeting || 0);
  if (handEl) handEl.textContent = Math.floor(live.handling || 0);
}

// ---------- Supervisor table from Firestore ----------

function buildSupervisorTableFromFirestore(rows) {
  const body = document.getElementById("sup-table-body");
  const sumOp = document.getElementById("sum-op");
  const sumBreak = document.getElementById("sum-break");
  const sumMeet = document.getElementById("sum-meet");
  const sumUnavail = document.getElementById("sum-unavail");

  if (!body) return;
  body.innerHTML = "";

  const totals = {
    in_operation: 0,
    break: 0,
    meeting: 0,
    handling: 0,
    unavailable: 0,
  };

  // نفلتر هون بس الـ agents
  const agentRows = rows.filter((r) => (r.role || "") === "agent");

  agentRows.forEach((record) => {
    const status = record.status || "unavailable";
    if (totals[status] != null) totals[status] += 1;

    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.textContent = record.name || "";

    const idTd = document.createElement("td");
    idTd.textContent = record.userId || "";

    const roleTd = document.createElement("td");
    roleTd.textContent = (record.role || "").toUpperCase();

    const statusTd = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "sup-status-pill status-" + status;
    pill.textContent = statusLabel(status);
    statusTd.appendChild(pill);

    const opTd = document.createElement("td");
    opTd.textContent = `${Math.floor(record.operationMinutes || 0)} min`;

    const brTd = document.createElement("td");
    brTd.textContent = `${Math.floor(record.breakUsedMinutes || 0)} min`;

    const meetTd = document.createElement("td");
    meetTd.textContent = `${Math.floor(record.meetingMinutes || 0)} min`;

    const unTd = document.createElement("td");
    unTd.textContent = `${Math.floor(record.unavailableMinutes || 0)} min`;

    const loginTd = document.createElement("td");
    if (record.loginTime) {
      const d = new Date(record.loginTime);
      loginTd.textContent = d.toLocaleString();
    } else {
      loginTd.textContent = "Never";
      loginTd.style.opacity = "0.6";
    }

    tr.appendChild(nameTd);
    tr.appendChild(idTd);
    tr.appendChild(roleTd);
    tr.appendChild(statusTd);
    tr.appendChild(opTd);
    tr.appendChild(brTd);
    tr.appendChild(meetTd);
    tr.appendChild(unTd);
    tr.appendChild(loginTd);

    body.appendChild(tr);
  });

  if (sumOp) sumOp.textContent = totals.in_operation;
  if (sumBreak) sumBreak.textContent = totals.break;
  if (sumMeet) sumMeet.textContent = totals.meeting;
  if (sumUnavail) sumUnavail.textContent = totals.unavailable;
}


