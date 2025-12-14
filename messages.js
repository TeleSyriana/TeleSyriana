// meetings.js (module)

// ---------- Storage keys ----------
const KEY_USER_CANDIDATES = ["currentUser", "teleUser", "ts_user", "loggedInUser"];
const KEY_MEETINGS = "ts_meetings";
const KEY_SEQ = "ts_meeting_seq";

// ---------- Helpers ----------
function readUser() {
  // 1) global
  if (window.currentUser) return window.currentUser;

  // 2) try common localStorage keys
  for (const k of KEY_USER_CANDIDATES) {
    const raw = localStorage.getItem(k);
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw);
      if (obj && (obj.ccmsId || obj.id || obj.name)) return obj;
    } catch {}
  }

  // 3) fallback: if your login stores ccmsId separately
  const ccmsId = localStorage.getItem("ccmsId");
  if (ccmsId) return { ccmsId: String(ccmsId) };

  return null;
}

function isSupervisor(user) {
  if (!user) return false;
  if (user.role && String(user.role).toLowerCase().includes("super")) return true;
  const id = Number(user.ccmsId || user.id);
  return Number.isFinite(id) && id >= 2000; // your demo uses 2001/2002 supervisors
}

function loadMeetings() {
  try {
    return JSON.parse(localStorage.getItem(KEY_MEETINGS) || "[]") || [];
  } catch {
    return [];
  }
}

function saveMeetings(arr) {
  localStorage.setItem(KEY_MEETINGS, JSON.stringify(arr));
}

function nextMeetingId() {
  const cur = Number(localStorage.getItem(KEY_SEQ) || "0") || 0;
  const nxt = cur + 1;
  localStorage.setItem(KEY_SEQ, String(nxt));
  return String(nxt).padStart(4, "0");
}

function randomPassword(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing 0/O/1/I
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function nowLocalDefaultTimePlus(mins = 15) {
  const d = new Date(Date.now() + mins * 60000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${mi}` };
}

function sortMeetingsUpcoming(meetings) {
  return [...meetings].sort((a, b) => (a.whenTs || 0) - (b.whenTs || 0));
}

function makeWhenTs(dateStr, timeStr) {
  // safe parse as local time
  const dt = new Date(`${dateStr}T${timeStr}:00`);
  const ts = dt.getTime();
  return Number.isFinite(ts) ? ts : Date.now();
}

function fmtWhen(ts) {
  const d = new Date(ts);
  return d.toLocaleString([], { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ---------- Elements ----------
const createBox = document.getElementById("create-meeting-box");
const createTitle = document.getElementById("create-title");
const createDate = document.getElementById("create-date");
const createTime = document.getElementById("create-time");
const createId = document.getElementById("create-id");
const createPass = document.getElementById("create-pass");
const regenBtn = document.getElementById("regen-meeting-btn");
const createBtn = document.getElementById("create-meeting-btn");

const searchInput = document.getElementById("meeting-search");
const searchClear = document.getElementById("meeting-search-clear");
const listEl = document.getElementById("meetings-list");
const emptyEl = document.getElementById("meetings-empty");

const joinId = document.getElementById("join-meeting-id");
const joinPass = document.getElementById("join-meeting-pass");
const joinBtn = document.getElementById("join-meeting-btn");

const stage = document.getElementById("meeting-stage");
const videoEl = document.getElementById("local-video");
const liveTitle = document.getElementById("meeting-live-title");
const liveMeta = document.getElementById("meeting-live-meta");

const micBtn = document.getElementById("btn-mic");
const camBtn = document.getElementById("btn-cam");
const handBtn = document.getElementById("btn-hand");
const leaveBtn = document.getElementById("btn-leave");

// ---------- State ----------
let localStream = null;
let meetings = loadMeetings();
let user = readUser();
let userIsSupervisor = isSupervisor(user);

// ---------- UI init ----------
function fillCreateDefaults() {
  const { date, time } = nowLocalDefaultTimePlus(15);
  if (createDate) createDate.value = date;
  if (createTime) createTime.value = time;
  if (createId) createId.value = nextMeetingId();
  if (createPass) createPass.value = randomPassword(6);
}

function renderMeetings(filter = "") {
  if (!listEl || !emptyEl) return;

  const q = (filter || "").trim().toLowerCase();

  // show only upcoming (>= now - 2h)
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  const upcoming = sortMeetingsUpcoming(meetings).filter(m => (m.whenTs || 0) >= cutoff);

  const filtered = q
    ? upcoming.filter(m => {
        const hay = `${m.id} ${m.title} ${m.hostName} ${m.hostId}`.toLowerCase();
        return hay.includes(q);
      })
    : upcoming;

  listEl.innerHTML = "";

  if (!filtered.length) {
    emptyEl.style.display = "block";
    return;
  }

  emptyEl.style.display = "none";

  filtered.forEach(m => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "meeting-item";
    btn.dataset.mid = m.id;

    btn.innerHTML = `
      <div class="meeting-item-top">
        <div class="meeting-item-title">${escapeHtml(m.title || "Meeting")}</div>
        <div class="meeting-item-id">#${escapeHtml(m.id)}</div>
      </div>
      <div class="meeting-item-sub">
        <span class="meeting-pill">${escapeHtml(fmtWhen(m.whenTs))}</span>
        <span class="meeting-pill soft">Host: ${escapeHtml(m.hostName || m.hostId || "—")}</span>
      </div>
      <div class="meeting-item-actions">
        <span class="meeting-pass">Pass: <b>${escapeHtml(m.pass)}</b></span>
        <span class="meeting-quick">Click to fill join</span>
      </div>
    `;

    btn.addEventListener("click", () => {
      if (joinId) joinId.value = m.id;
      if (joinPass) joinPass.value = m.pass;
      // small UX: focus password if empty
      joinPass?.focus();
    });

    listEl.appendChild(btn);
  });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- Create meeting (Supervisor) ----------
function ensureSupervisorBox() {
  if (!createBox) return;
  if (userIsSupervisor) createBox.classList.remove("hidden");
  else createBox.classList.add("hidden");
}

regenBtn?.addEventListener("click", () => {
  if (!userIsSupervisor) return;
  // regenerate WITHOUT consuming sequence? — keep sequence for ID stable:
  // we want NEW ID, so consume sequence intentionally:
  if (createId) createId.value = nextMeetingId();
  if (createPass) createPass.value = randomPassword(6);
});

createBtn?.addEventListener("click", () => {
  if (!userIsSupervisor) return;

  const title = (createTitle?.value || "").trim() || "Team meeting";
  const date = createDate?.value;
  const time = createTime?.value;

  if (!date || !time) {
    alert("Please choose date & time");
    return;
  }

  const id = (createId?.value || "").trim() || nextMeetingId();
  const pass = (createPass?.value || "").trim() || randomPassword(6);

  const whenTs = makeWhenTs(date, time);

  const hostId = String(user?.ccmsId || user?.id || "2000");
  const hostName = String(user?.name || user?.fullName || user?.displayName || `Supervisor (${hostId})`);

  const meeting = {
    id,
    pass,
    title,
    date,
    time,
    whenTs,
    hostId,
    hostName,
    createdAt: Date.now()
  };

  meetings = loadMeetings();
  // prevent duplicates
  if (meetings.some(m => m.id === id)) {
    alert("Meeting ID already exists. Click Regenerate.");
    return;
  }

  meetings.push(meeting);
  saveMeetings(meetings);

  // reset fields
  if (createTitle) createTitle.value = "";
  // generate next ID/pass for next create
  if (createId) createId.value = nextMeetingId();
  if (createPass) createPass.value = randomPassword(6);

  renderMeetings(searchInput?.value || "");
  alert(`Meeting created ✅\nID: ${meeting.id}\nPass: ${meeting.pass}`);
});

// ---------- Search ----------
searchInput?.addEventListener("input", () => renderMeetings(searchInput.value));
searchClear?.addEventListener("click", () => {
  if (searchInput) searchInput.value = "";
  renderMeetings("");
});

// ---------- Join meeting (local preview + validation) ----------
joinBtn?.addEventListener("click", async () => {
  meetings = loadMeetings();

  const id = (joinId?.value || "").trim();
  const pass = (joinPass?.value || "").trim();

  if (!id || !pass) {
    alert("Enter Meeting ID and Password");
    return;
  }

  const m = meetings.find(x => x.id === id);
  if (!m) {
    alert("Meeting not found");
    return;
  }
  if (m.pass !== pass) {
    alert("Wrong password");
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (videoEl) videoEl.srcObject = localStream;

    liveTitle && (liveTitle.textContent = m.title || "In meeting");
    liveMeta && (liveMeta.textContent = `#${m.id} • ${fmtWhen(m.whenTs)} • Host: ${m.hostName || m.hostId}`);

    stage?.classList.remove("hidden");
  } catch (e) {
    alert("Camera/Mic blocked. Please allow permissions.");
  }
});

// ---------- Controls ----------
micBtn?.addEventListener("click", () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  micBtn.textContent = track.enabled ? "🎤 Mute" : "🔇 Unmute";
});

camBtn?.addEventListener("click", () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  camBtn.textContent = track.enabled ? "📷 Camera off" : "🚫 Camera on";
});

handBtn?.addEventListener("click", () => {
  handBtn.textContent = "✋ Raised";
  setTimeout(() => (handBtn.textContent = "✋ Raise hand"), 1200);
});

leaveBtn?.addEventListener("click", () => {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  stage?.classList.add("hidden");
  if (videoEl) videoEl.srcObject = null;

  // reset buttons text
  micBtn && (micBtn.textContent = "🎤 Mute");
  camBtn && (camBtn.textContent = "📷 Camera off");
});

// ---------- Boot ----------
function boot() {
  user = readUser();
  userIsSupervisor = isSupervisor(user);

  ensureSupervisorBox();
  fillCreateDefaults();
  renderMeetings("");
}

boot();



