// Demo users – later will be moved to Firebase / DB
const USERS = {
  "1001": { password: "1234", role: "agent", name: "Agent's Name" },
  "1002": { password: "1234", role: "agent", name: "Agent's Name" },
  "1003": { password: "1234", role: "agent", name: "Agent's Name" },
  "2001": { password: "sup123", role: "supervisor", name: "Dema" },
  "2002": { password: "sup123", role: "supervisor", name: "Moustafa" },
};

const USER_KEY = "telesyrianaUser";
const STATE_KEY = "telesyrianaState";
const LOGIN_LOG_KEY = "telesyrianaLoginLog";
const STATS_KEY = "telesyrianaDailyStats";
const BREAK_LIMIT_MIN = 45;

let currentUser = null;
let state = null;
let timerId = null;

document.addEventListener("DOMContentLoaded", () => {
  const loginForm = document.getElementById("login-form");
  const logoutBtn = document.getElementById("logout-btn");
  const statusSelect = document.getElementById("status-select");

  // Restore session if exists
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

/* Utility: date key per day */

function getTodayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`; // e.g. 2025-12-10
}

/* State init / persistence */

function initStateForUser() {
  const today = getTodayKey();
  const raw = localStorage.getItem(STATE_KEY);
  const now = Date.now();

  if (raw) {
    try {
      const saved = JSON.parse(raw);

      if (saved.userId === currentUser.id && saved.day === today) {
        state = saved;
        ensureStateFields();
        startTimer();
        updateStatsStore(); // save initial stats snapshot
        return;
      }
    } catch {
      // ignore and create new state below
    }
  }

  // New day / no state yet
  state = {
    userId: currentUser.id,
    day: today,
    status: "in_operation",
    lastStatusChange: now,
    breakUsedMinutes: 0,
    loginTime: now,
    operationMinutes: 0,
    meetingMinutes: 0,
    handlingMinutes: 0,
    unavailableMinutes: 0,
  };
  saveState();
  logLoginTime(); // for supervisor dashboard
  updateStatsStore();
  startTimer();
}

function ensureStateFields() {
  if (!state) return;
  if (state.operationMinutes == null) state.operationMinutes = 0;
  if (state.meetingMinutes == null) state.meetingMinutes = 0;
  if (state.handlingMinutes == null) state.handlingMinutes = 0;
  if (state.unavailableMinutes == null) state.unavailableMinutes = 0;
  if (state.breakUsedMinutes == null) state.breakUsedMinutes = 0;
  if (!state.loginTime) state.loginTime = Date.now();
}

function saveState() {
  if (!state) return;
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

/* Login log for supervisor */

function logLoginTime() {
  const raw = localStorage.getItem(LOGIN_LOG_KEY);
  let log = {};
  if (raw) {
    try {
      log = JSON.parse(raw) || {};
    } catch {
      log = {};
    }
  }

  log[currentUser.id] = {
    id: currentUser.id,
    name: currentUser.name,
    role: currentUser.role,
    lastLogin: new Date(state.loginTime || Date.now()).toISOString(),
    lastStatus: state.status,
  };

  localStorage.setItem(LOGIN_LOG_KEY, JSON.stringify(log));
}

/* Timer + live usage */

function startTimer() {
  if (timerId) clearInterval(timerId);
  timerId = setInterval(tick, 10000); // every 10 seconds
  tick(); // update immediately
}

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

  let breakUsed = state.breakUsedMinutes || 0;
  let op = state.operationMinutes || 0;
  let meet = state.meetingMinutes || 0;
  let hand = state.handlingMinutes || 0;
  let unavail = state.unavailableMinutes || 0;

  const elapsedMin = (now - state.lastStatusChange) / 60000;

  if (elapsedMin > 0) {
    switch (state.status) {
      case "break":
        breakUsed = Math.min(BREAK_LIMIT_MIN, breakUsed + elapsedMin);
        break;
      case "in_operation":
        op += elapsedMin;
        break;
      case "meeting":
        meet += elapsedMin;
        break;
      case "handling":
        hand += elapsedMin;
        break;
      case "unavailable":
        unavail += elapsedMin;
        break;
      default:
        break;
    }
  }

  return {
    breakUsed,
    operation: op,
    meeting: meet,
    handling: hand,
    unavailable: unavail,
  };
}

function tick() {
  if (!state) return;

  const now = Date.now();
  const live = recomputeLiveUsage(now);

  // If on break and reached limit → auto switch to Unavailable
  if (state.status === "break" && live.breakUsed >= BREAK_LIMIT_MIN) {
    state.breakUsedMinutes = BREAK_LIMIT_MIN;
    state.status = "unavailable";
    state.lastStatusChange = now;
    saveState();
    logLoginTime();
    updateStatsStore();
    updateDashboardUI();
    alert("Break limit (45 minutes) reached. Status set to Unavailable.");
    return;
  }

  updateBreakUI(live.breakUsed);
  updateStatusMinutesUI(live.operation, live.meeting, live.handling);
  updateStatsStore(live);
}

/* Stats store for supervisor (per day, per user) */

function updateStatsStore(liveUsage) {
  if (!currentUser || !state) return;

  const today = getTodayKey();
  const now = Date.now();
  const live = liveUsage || recomputeLiveUsage(now);

  const raw = localStorage.getItem(STATS_KEY);
  let store = { day: today, users: {} };

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.day === today) {
        store = parsed;
      }
    } catch {
      // ignore, use fresh store
    }
  }

  if (!store.users) store.users = {};

  store.users[currentUser.id] = {
    id: currentUser.id,
    name: currentUser.name,
    role: currentUser.role,
    in_operation: live.operation,
    break: live.breakUsed,
    meeting: live.meeting,
    handling: live.handling,
    unavailable: live.unavailable,
  };

  localStorage.setItem(STATS_KEY, JSON.stringify(store));
}

/* Screen switches */

function showLogin() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("dashboard-screen").classList.add("hidden");
}

function showDashboard() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("dashboard-screen").classList.remove("hidden");
  updateDashboardUI();
}

/* Login / logout handlers */

function handleLogin(event) {
  event.preventDefault();

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

function handleLogout() {
  localStorage.removeItem(USER_KEY);
  currentUser = null;
  state = null;
  if (timerId) clearInterval(timerId);
  showLogin();
}

function showError(message) {
  const errorBox = document.getElementById("login-error");
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

/* Status change handler */

function handleStatusChange(e) {
  if (!state || !currentUser) return;

  const newStatus = e.target.value;
  const now = Date.now();

  // // Restrict Meeting to supervisors only
  // if (newStatus === "meeting" && currentUser.role !== "supervisor") {
  //   alert("Only Supervisors can use the Meeting status.");
  //   e.target.value = state.status;
  //   return;
  // }

  // Prevent more break than limit
  if (newStatus === "break") {
    if (state.breakUsedMinutes >= BREAK_LIMIT_MIN - 0.01) {
      alert("Daily break limit (45 minutes) already reached.");
      e.target.value = state.status;
      return;
    }
  }

  // Commit time spent in the previous status
  const elapsedMin = (now - state.lastStatusChange) / 60000;

  if (elapsedMin > 0) {
    switch (state.status) {
      case "break":
        state.breakUsedMinutes = Math.min(
          BREAK_LIMIT_MIN,
          (state.breakUsedMinutes || 0) + elapsedMin
        );
        break;
      case "in_operation":
        state.operationMinutes =
          (state.operationMinutes || 0) + elapsedMin;
        break;
      case "meeting":
        state.meetingMinutes =
          (state.meetingMinutes || 0) + elapsedMin;
        break;
      case "handling":
        state.handlingMinutes =
          (state.handlingMinutes || 0) + elapsedMin;
        break;
      case "unavailable":
        state.unavailableMinutes =
          (state.unavailableMinutes || 0) + elapsedMin;
        break;
      default:
        break;
    }
  }

  state.status = newStatus;
  state.lastStatusChange = now;
  saveState();
  logLoginTime(); // update last status for supervisor
  updateStatsStore();
  updateDashboardUI();
}

/* Dashboard UI updates */

function updateDashboardUI() {
  if (!state || !currentUser) return;

  const welcomeTitle = document.getElementById("welcome-title");
  const welcomeSubtitle = document.getElementById("welcome-subtitle");
  const statusValue = document.getElementById("status-value");
  const statusSelect = document.getElementById("status-select");
  const supPanel = document.getElementById("supervisor-panel");

  welcomeTitle.textContent = `Welcome, ${currentUser.name}`;
  welcomeSubtitle.textContent = `Logged in as ${currentUser.role.toUpperCase()} (CCMS: ${currentUser.id})`;

  const label = statusLabel(state.status);
  statusValue.textContent = label;
  statusValue.className = "status-value " + "status-" + state.status;
  statusSelect.value = state.status;

  const live = recomputeLiveUsage(Date.now());
  updateBreakUI(live.breakUsed);
  updateStatusMinutesUI(live.operation, live.meeting, live.handling);

  // Show supervisor overview if role is supervisor
  if (currentUser.role === "supervisor") {
    supPanel.classList.remove("hidden");
    buildSupervisorTable();
  } else {
    supPanel.classList.add("hidden");
  }
}

function statusLabel(code) {
  switch (code) {
    case "in_operation":
      return "Operation";
    case "break":
      return "Break";
    case "unavailable":
      return "Unavailable";
    case "meeting":
      return "Meeting";
    case "handling":
      return "Handling";
    default:
      return code;
  }
}

function updateBreakUI(usedMinutes) {
  const usedElem = document.getElementById("break-used");
  const remainingElem = document.getElementById("break-remaining");

  const usedRounded = Math.floor(usedMinutes || 0);
  const remaining = Math.max(0, BREAK_LIMIT_MIN - usedRounded);

  usedElem.textContent = usedRounded;
  remainingElem.textContent = remaining;
}

function updateStatusMinutesUI(opMin, meetMin, handMin) {
  const opElem = document.getElementById("op-min");
  const meetElem = document.getElementById("meet-min");
  const handElem = document.getElementById("hand-min");

  if (opElem) opElem.textContent = Math.floor(opMin || 0);
  if (meetElem) meetElem.textContent = Math.floor(meetMin || 0);
  if (handElem) handElem.textContent = Math.floor(handMin || 0);
}

/* Supervisor dashboard */

function formatMinutes(m) {
  const total = Math.floor(m || 0);
  const h = Math.floor(total / 60);
  const min = total % 60;
  if (h > 0) {
    return `${h}h ${min}m`;
  }
  return `${min} min`;
}

function formatMinutesShort(m) {
  const total = Math.floor(m || 0);
  if (!total) return "0m";
  const h = Math.floor(total / 60);
  const min = total % 60;
  return h ? `${h}h ${min}m` : `${min}m`;
}

function buildSupervisorTable() {
  const body = document.getElementById("sup-table-body");
  body.innerHTML = "";

  // load login log
  const rawLog = localStorage.getItem(LOGIN_LOG_KEY);
  let log = {};
  if (rawLog) {
    try {
      log = JSON.parse(rawLog) || {};
    } catch {
      log = {};
    }
  }

  // load stats (per day, per user)
  const today = getTodayKey();
  const rawStats = localStorage.getItem(STATS_KEY);
  let statsStore = { day: today, users: {} };
  if (rawStats) {
    try {
      const parsed = JSON.parse(rawStats);
      if (parsed && parsed.day === today) {
        statsStore = parsed;
      }
    } catch {
      // ignore
    }
  }

  const totals = {
    in_operation: 0,
    break: 0,
    meeting: 0,
    unavailable: 0,
  };

  Object.entries(USERS).forEach(([id, user]) => {
    // show only agents (اخفي السوبرفايزر)
    if (user.role !== "agent") return;

    const record = log[id] || {
      id,
      name: user.name,
      role: user.role,
      lastLogin: null,
      lastStatus: "unavailable",
    };

    const statusCode = record.lastStatus || "unavailable";

    // count totals by status (للـ summary اللي فوق)
    if (totals[statusCode] != null) {
      totals[statusCode] += 1;
    }

    const stats =
      (statsStore.users && statsStore.users[id]) || {
        in_operation: 0,
        break: 0,
        meeting: 0,
        handling: 0,
        unavailable: 0,
      };

    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.textContent = record.name;

    const idTd = document.createElement("td");
    idTd.textContent = record.id;

    const roleTd = document.createElement("td");
    roleTd.textContent = record.role.toUpperCase();

    const statusTd = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "sup-status-pill " + (statusCode || "unavailable");
    pill.textContent = statusLabel(statusCode || "unavailable");
    statusTd.appendChild(pill);

    // NEW: كل حالة بعمود لوحده
    const opTd = document.createElement("td");
    opTd.textContent = formatMinutesShort(stats.in_operation);

    const breakTd = document.createElement("td");
    breakTd.textContent = formatMinutesShort(stats.break);

    const meetTd = document.createElement("td");
    meetTd.textContent = formatMinutesShort(stats.meeting);

    const unavailTd = document.createElement("td");
    unavailTd.textContent = formatMinutesShort(stats.unavailable);

    const loginTd = document.createElement("td");
    if (record.lastLogin) {
      const date = new Date(record.lastLogin);
      loginTd.textContent = date.toLocaleString();
    } else {
      loginTd.textContent = "Never";
      loginTd.style.opacity = "0.6";
    }

    tr.appendChild(nameTd);
    tr.appendChild(idTd);
    tr.appendChild(roleTd);
    tr.appendChild(statusTd);
    tr.appendChild(opTd);
    tr.appendChild(breakTd);
    tr.appendChild(meetTd);
    tr.appendChild(unavailTd);
    tr.appendChild(loginTd);

    body.appendChild(tr);
  });

  // update totals summary (In Operation / Break / Meeting / Unavailable)
  const opSpan = document.getElementById("sum-op");
  const breakSpan = document.getElementById("sum-break");
  const meetSpan = document.getElementById("sum-meet");
  const unavailSpan = document.getElementById("sum-unavail");

  if (opSpan) opSpan.textContent = totals.in_operation || 0;
  if (breakSpan) breakSpan.textContent = totals.break || 0;
  if (meetSpan) meetSpan.textContent = totals.meeting || 0;
  if (unavailSpan) unavailSpan.textContent = totals.unavailable || 0;
}
