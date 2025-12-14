// meetings.js — TeleSyriana Meetings (Firestore like chat)

import { db, fs } from "./firebase.js";

const {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  runTransaction,
} = fs;

// -------------------- Config / Helpers --------------------
const MEETINGS_COL = "meetings";
const META_DOC = "meta";
const COUNTER_DOC = "counters"; // meetings/meta/counters

function getCurrentUser() {
  // نفس أسلوبك الحالي
  try {
    return JSON.parse(localStorage.getItem("telesyrianaUser") || "null");
  } catch {
    return null;
  }
}

function pad(n, len = 4) {
  return String(n).padStart(len, "0");
}

function randPassword(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

function parseDateTime(dateStr, timeStr) {
  // date: YYYY-MM-DD, time: HH:MM
  if (!dateStr) return null;
  const t = timeStr || "09:00";
  const dt = new Date(`${dateStr}T${t}:00`);
  return isNaN(dt.getTime()) ? null : dt;
}

function fmtWhen(tsOrDate) {
  const d = tsOrDate?.toDate ? tsOrDate.toDate() : tsOrDate;
  if (!d) return "";
  return d.toLocaleString(undefined, { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

async function nextMeetingId() {
  // ✅ تسلسلي: transaction على meetings/meta/counters
  const ref = doc(db, MEETINGS_COL, META_DOC, "metaDocs", COUNTER_DOC);
  const newId = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() ? (snap.data().next || 1000) : 1000;
    tx.set(ref, { next: current + 1, updatedAt: serverTimestamp() }, { merge: true });
    return current;
  });
  return String(newId);
}

// -------------------- DOM --------------------
const listEl = document.getElementById("meetings-list");
const emptyEl = document.getElementById("meetings-empty");
const searchEl = document.getElementById("meeting-search");
const clearSearchBtn = document.getElementById("meeting-search-clear");

const openCreateBtn = document.getElementById("open-create-meeting");
const closeCreateBtn = document.getElementById("close-create-meeting");
const createBox = document.getElementById("create-meeting-box");

const createTitleEl = document.getElementById("create-title");
const createDateEl = document.getElementById("create-date");
const createTimeEl = document.getElementById("create-time");
const createIdEl = document.getElementById("create-id");
const createPassEl = document.getElementById("create-pass");
const regenPassBtn = document.getElementById("regen-pass-btn");
const createBtn = document.getElementById("create-meeting-btn");
const createHintEl = document.getElementById("create-hint");

const joinIdEl = document.getElementById("join-meeting-id");
const joinPassEl = document.getElementById("join-meeting-pass");
const joinBtn = document.getElementById("join-meeting-btn");

const stage = document.getElementById("meeting-stage");
const videoEl = document.getElementById("local-video");
const micBtn = document.getElementById("btn-mic");
const camBtn = document.getElementById("btn-cam");
const handBtn = document.getElementById("btn-hand");
const leaveBtn = document.getElementById("btn-leave");
const liveTitleEl = document.getElementById("meeting-live-title");
const liveMetaEl = document.getElementById("meeting-live-meta");

let unsubMeetings = null;
let meetingsCache = [];
let localStream = null;
let activeMeeting = null;

// -------------------- Init / Role UI --------------------
function applyRoleUI() {
  const user = getCurrentUser();
  const isSup = user?.role === "supervisor";

  // زر create
  if (openCreateBtn) openCreateBtn.classList.toggle("hidden", !isSup);

  // صندوق create مخفي افتراضياً
  if (!isSup && createBox) createBox.classList.add("hidden");
}

async function prepareCreateDefaults() {
  const user = getCurrentUser();
  if (!user || user.role !== "supervisor") return;

  // default: today + now+10min
  const now = new Date();
  const dt = new Date(now.getTime() + 10 * 60000);
  if (createDateEl) createDateEl.value = todayKey();
  if (createTimeEl) createTimeEl.value = `${pad(dt.getHours(), 2)}:${pad(dt.getMinutes(), 2)}`;

  // generate meeting id + pass
  const id = await nextMeetingId();
  if (createIdEl) createIdEl.value = id;
  if (createPassEl) createPassEl.value = randPassword(6);

  if (createHintEl) createHintEl.textContent = "";
}

// -------------------- Firestore subscribe --------------------
function subscribeMeetings() {
  if (!listEl) return;

  // Upcoming: اليوم و لقدّام (بس demo)
  const q = query(
    collection(db, MEETINGS_COL),
    orderBy("scheduledAt", "asc"),
    limit(50)
  );

  if (unsubMeetings) unsubMeetings();
  unsubMeetings = onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    meetingsCache = rows;
    renderMeetings();
  });
}

function renderMeetings() {
  if (!listEl || !emptyEl) return;

  const term = (searchEl?.value || "").trim().toLowerCase();

  const filtered = meetingsCache.filter((m) => {
    const id = String(m.meetingId || m.id || "").toLowerCase();
    const title = String(m.title || "").toLowerCase();
    const host = String(m.hostName || m.hostId || "").toLowerCase();
    return !term || id.includes(term) || title.includes(term) || host.includes(term);
  });

  listEl.innerHTML = "";

  if (!filtered.length) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  filtered.forEach((m) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "meeting-item";
    btn.innerHTML = `
      <div class="meeting-item-top">
        <div class="meeting-item-title">${m.title || "Meeting"}</div>
        <div class="meeting-item-id">#${m.meetingId || m.id}</div>
      </div>
      <div class="meeting-item-sub">
        <span>Host: ${m.hostName || m.hostId || "—"}</span>
        <span>•</span>
        <span>${m.scheduledAt ? fmtWhen(m.scheduledAt) : "No time"}</span>
      </div>
    `;

    btn.addEventListener("click", () => {
      // auto-fill join
      if (joinIdEl) joinIdEl.value = String(m.meetingId || m.id);
      joinPassEl?.focus();
    });

    listEl.appendChild(btn);
  });
}

// -------------------- Create meeting (Supervisor) --------------------
async function createMeeting() {
  const user = getCurrentUser();
  if (!user || user.role !== "supervisor") return alert("Supervisor only.");

  const title = (createTitleEl?.value || "").trim() || "Team meeting";
  const dateStr = createDateEl?.value || todayKey();
  const timeStr = createTimeEl?.value || "09:00";
  const scheduled = parseDateTime(dateStr, timeStr);
  if (!scheduled) return alert("Invalid date/time.");

  const meetingId = (createIdEl?.value || "").trim();
  const password = (createPassEl?.value || "").trim();

  if (!meetingId) return alert("Meeting ID missing.");
  if (!password || password.length < 4) return alert("Password too short.");

  // doc id = meetingId (أسهل)
  const ref = doc(db, MEETINGS_COL, meetingId);

  // prevent overwrite if exists
  const exists = await getDoc(ref);
  if (exists.exists()) {
    alert("Meeting ID already exists. Generating a new one…");
    const id = await nextMeetingId();
    createIdEl.value = id;
    return;
  }

  await setDoc(ref, {
    meetingId,
    title,
    password, // ✅ demo only
    hostId: user.id,
    hostName: user.name,
    scheduledAt: scheduled,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    status: "scheduled", // scheduled | live | ended
  });

  if (createHintEl) {
    createHintEl.textContent = `✅ Created: ID ${meetingId} • PASS ${password}`;
  }

  // refresh next defaults (for next meeting)
  const nextId = await nextMeetingId();
  createIdEl.value = nextId;
  createPassEl.value = randPassword(6);
  createTitleEl.value = "";
}

// -------------------- Join meeting (validate + local preview) --------------------
async function joinMeeting() {
  const user = getCurrentUser();
  if (!user) return alert("Please login first.");

  const id = (joinIdEl?.value || "").trim();
  const pass = (joinPassEl?.value || "").trim();
  if (!id || !pass) return alert("Enter Meeting ID + password.");

  const ref = doc(db, MEETINGS_COL, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return alert("Meeting not found.");

  const m = snap.data();
  if (String(m.password || "") !== pass) return alert("Wrong password.");

  // mark participation (optional)
  try {
    await setDoc(doc(db, MEETINGS_COL, id, "participants", user.id), {
      userId: user.id,
      name: user.name,
      role: user.role,
      joinedAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
    }, { merge: true });
  } catch {}

  // local camera preview
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    videoEl.srcObject = localStream;

    activeMeeting = { id, ...m };
    stage.classList.remove("hidden");

    if (liveTitleEl) liveTitleEl.textContent = m.title || "Meeting";
    if (liveMetaEl) liveMetaEl.textContent = `#${id} • ${user.name}`;

    // optional: update status
    try {
      await updateDoc(ref, { status: "live", updatedAt: serverTimestamp() });
    } catch {}
  } catch (e) {
    alert("Camera/Mic blocked. Please allow permissions.");
  }
}

function leaveMeeting() {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (videoEl) videoEl.srcObject = null;
  stage?.classList.add("hidden");

  activeMeeting = null;
}

// -------------------- Controls --------------------
function toggleMic() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  micBtn.textContent = track.enabled ? "🎤 Mute" : "🔇 Unmute";
  micBtn.classList.toggle("active", !track.enabled);
}

function toggleCam() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  camBtn.textContent = track.enabled ? "📷 Camera off" : "🚫 Camera on";
  camBtn.classList.toggle("active", !track.enabled);
}

async function raiseHand() {
  const user = getCurrentUser();
  if (!user || !activeMeeting) return;

  handBtn.textContent = "✋ Raised";
  handBtn.classList.add("active");

  // ✅ اكتب event للـ supervisor (مثل messages)
  try {
    await setDoc(doc(db, MEETINGS_COL, activeMeeting.id, "events", `${user.id}_${Date.now()}`), {
      type: "raise_hand",
      userId: user.id,
      name: user.name,
      createdAt: serverTimestamp(),
    });
  } catch {}

  setTimeout(() => {
    handBtn.textContent = "✋ Raise hand";
    handBtn.classList.remove("active");
  }, 1200);
}

// -------------------- Hook UI --------------------
function hookUI() {
  clearSearchBtn?.addEventListener("click", () => {
    if (searchEl) searchEl.value = "";
    renderMeetings();
    searchEl?.focus();
  });

  searchEl?.addEventListener("input", renderMeetings);

  openCreateBtn?.addEventListener("click", async () => {
    createBox?.classList.remove("hidden");
    openCreateBtn.classList.add("hidden");
    await prepareCreateDefaults();
  });

  closeCreateBtn?.addEventListener("click", () => {
    createBox?.classList.add("hidden");
    openCreateBtn?.classList.remove("hidden");
  });

  regenPassBtn?.addEventListener("click", () => {
    if (createPassEl) createPassEl.value = randPassword(6);
  });

  createBtn?.addEventListener("click", createMeeting);

  joinBtn?.addEventListener("click", joinMeeting);

  micBtn?.addEventListener("click", toggleMic);
  camBtn?.addEventListener("click", toggleCam);
  handBtn?.addEventListener("click", raiseHand);
  leaveBtn?.addEventListener("click", leaveMeeting);

  // لما يصير logout/login
  window.addEventListener("telesyriana:user-changed", () => {
    applyRoleUI();
  });
}

// -------------------- Boot --------------------
document.addEventListener("DOMContentLoaded", () => {
  applyRoleUI();
  hookUI();
  subscribeMeetings();
});

