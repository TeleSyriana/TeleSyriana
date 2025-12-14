// meetings.js — Firestore meetings (list + create for supervisors + join local preview)

import { db, fs } from "./firebase.js";

const {
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  runTransaction
} = fs;

const MEETINGS_COL = "meetings";
const META_DOC = "meta/counters"; // doc path: meta/counters (collection "meta", doc "counters")

let unsubUpcoming = null;
let localStream = null;
let allUpcoming = []; // cached for search

// -------------------- DOM --------------------
const elSearch = document.getElementById("meeting-search");
const elSearchClear = document.getElementById("meeting-search-clear");

const elCreateBox = document.getElementById("create-meeting-box");
const elCreateTitle = document.getElementById("create-title");
const elCreateDate = document.getElementById("create-date");
const elCreateTime = document.getElementById("create-time");
const elCreateId = document.getElementById("create-id");
const elCreatePass = document.getElementById("create-pass");
const btnNewPass = document.getElementById("btn-new-pass");
const btnCreate = document.getElementById("create-meeting-btn");

const elList = document.getElementById("meetings-list");
const elEmpty = document.getElementById("meetings-empty");

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

// -------------------- helpers --------------------
function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem("telesyrianaUser") || "null");
  } catch {
    return null;
  }
}

function pad4(n) {
  return String(n).padStart(4, "0");
}

function randomPassword(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing 0/O/1/I
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function toLocalDateInput(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function toLocalTimeInput(d) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function parseStartAt(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const local = new Date(y, m - 1, d, hh, mm, 0, 0);
  return Timestamp.fromDate(local);
}

function formatStartAt(ts) {
  try {
    const d = ts.toDate();
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "";
  }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[m]));
}

// -------------------- meeting ID transaction --------------------
async function nextMeetingId() {
  // meta/counters => { meetingNext: 1 }
  const ref = doc(db, "meta", "counters");

  const idNum = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    let next = 1;
    if (snap.exists()) {
      const d = snap.data();
      next = Number(d.meetingNext || 1);
    }
    tx.set(ref, { meetingNext: next + 1 }, { merge: true });
    return next;
  });

  return pad4(idNum);
}

// -------------------- UI: render upcoming --------------------
function renderList(list) {
  if (!elList || !elEmpty) return;

  elList.innerHTML = "";
  if (!list.length) {
    elEmpty.classList.remove("hidden");
    return;
  }
  elEmpty.classList.add("hidden");

  list.forEach((m) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "meeting-item";

    btn.innerHTML = `
      <div class="meeting-row">
        <div class="meeting-badge">M</div>
        <div class="meeting-text">
          <div class="meeting-title">
            ${escapeHtml(m.title || "Meeting")} <span class="meeting-id">#${escapeHtml(m.meetingId)}</span>
          </div>
          <div class="meeting-sub">
            ${escapeHtml(formatStartAt(m.startAt))} • Host: ${escapeHtml(m.hostName || m.hostId || "-")}
          </div>
        </div>
      </div>
    `;

    // quick fill join form on click (without password)
    btn.addEventListener("click", () => {
      if (joinId) joinId.value = m.meetingId || "";
      if (joinPass) joinPass.focus();
    });

    elList.appendChild(btn);
  });
}

function applySearch(q) {
  const s = String(q || "").trim().toLowerCase();
  if (!s) return renderList(allUpcoming);

  const filtered = allUpcoming.filter((m) => {
    const hay = `${m.meetingId || ""} ${m.title || ""} ${m.hostName || ""} ${m.hostId || ""}`.toLowerCase();
    return hay.includes(s);
  });

  renderList(filtered);
}

// -------------------- Firestore: subscribe upcoming --------------------
function subscribeUpcoming() {
  if (unsubUpcoming) return;

  const now = Timestamp.fromDate(new Date());

  const q = query(
    collection(db, MEETINGS_COL),
    where("startAt", ">=", now),
    orderBy("startAt", "asc"),
    limit(50)
  );

  unsubUpcoming = onSnapshot(
    q,
    (snap) => {
      allUpcoming = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      applySearch(elSearch?.value || "");
    },
    (err) => {
      console.error("Meetings snapshot error:", err);
      // لا تقتل الصفحة، بس خليها فاضية
      allUpcoming = [];
      renderList([]);
    }
  );
}

// -------------------- Create meeting (supervisor) --------------------
async function prepareCreateDefaults() {
  if (!elCreateId || !elCreatePass || !elCreateDate || !elCreateTime) return;

  // default date/time = next 15 minutes
  const d = new Date();
  d.setMinutes(d.getMinutes() + 15);

  elCreateDate.value = toLocalDateInput(d);
  elCreateTime.value = toLocalTimeInput(d);

  // sequential ID + random pass
  elCreateId.value = await nextMeetingId();
  elCreatePass.value = randomPassword(6);
}

async function createMeeting() {
  const user = getCurrentUser();
  if (!user || user.role !== "supervisor") return alert("Supervisor only.");

  const title = (elCreateTitle?.value || "").trim() || "Meeting";
  const startAt = parseStartAt(elCreateDate?.value, elCreateTime?.value);
  if (!startAt) return alert("Choose date & time.");

  const meetingId = (elCreateId?.value || "").trim();
  const password = (elCreatePass?.value || "").trim();
  if (!meetingId || !password) return alert("Missing Meeting ID or password.");

  const payload = {
    meetingId,
    password,              // لاحقاً بنعملها hashed (بس حالياً demo)
    title,
    startAt,
    hostId: user.id,
    hostName: user.name,
    createdAt: serverTimestamp(),
    status: "scheduled"
  };

  // store doc id = meetingId for easy lookup
  await setDoc(doc(db, MEETINGS_COL, meetingId), payload, { merge: true });

  // prepare next defaults (new ID + new pass)
  await prepareCreateDefaults();

  alert(`Created ✅\nMeeting ID: ${meetingId}\nPassword: ${password}`);
}

// -------------------- Join meeting (local preview only) --------------------
async function joinMeeting() {
  const id = (joinId?.value || "").trim();
  const pass = (joinPass?.value || "").trim();
  if (!id || !pass) return alert("Enter Meeting ID + password.");

  // validate against Firestore
  const snap = await getDoc(doc(db, MEETINGS_COL, id));
  if (!snap.exists()) return alert("Meeting not found.");

  const data = snap.data();
  if ((data.password || "") !== pass) return alert("Wrong password.");

  // show local camera/mic preview
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (videoEl) videoEl.srcObject = localStream;

    if (liveTitle) liveTitle.textContent = data.title || "In meeting";
    if (liveMeta) liveMeta.textContent = `#${data.meetingId} • ${formatStartAt(data.startAt)}`;

    stage?.classList.remove("hidden");
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
}

function toggleMic() {
  if (!localStream) return;
  const t = localStream.getAudioTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  micBtn.textContent = t.enabled ? "🎤 Mute" : "🔇 Unmute";
}

function toggleCam() {
  if (!localStream) return;
  const t = localStream.getVideoTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  camBtn.textContent = t.enabled ? "📷 Camera off" : "🚫 Camera on";
}

function raiseHand() {
  handBtn.textContent = "✋ Raised";
  setTimeout(() => (handBtn.textContent = "✋ Raise hand"), 1200);
}

// -------------------- init --------------------
function initMeetings() {
  const user = getCurrentUser();

  // supervisor create UI
  if (elCreateBox) {
    const show = !!user && user.role === "supervisor";
    elCreateBox.classList.toggle("hidden", !show);
    if (show) {
      // defaults once
      prepareCreateDefaults().catch(console.error);
    }
  }

  subscribeUpcoming();

  // search
  elSearch?.addEventListener("input", () => applySearch(elSearch.value));
  elSearchClear?.addEventListener("click", () => {
    if (elSearch) elSearch.value = "";
    applySearch("");
  });

  // create
  btnNewPass?.addEventListener("click", () => {
    if (elCreatePass) elCreatePass.value = randomPassword(6);
  });
  btnCreate?.addEventListener("click", () => {
    createMeeting().catch((e) => {
      console.error(e);
      alert("Create failed (check Firestore rules).");
    });
  });

  // join
  joinBtn?.addEventListener("click", () => {
    joinMeeting().catch((e) => {
      console.error(e);
      alert("Join failed (check meeting id/password + rules).");
    });
  });

  micBtn?.addEventListener("click", toggleMic);
  camBtn?.addEventListener("click", toggleCam);
  handBtn?.addEventListener("click", raiseHand);
  leaveBtn?.addEventListener("click", leaveMeeting);

  // when user changes (login/logout) re-init create visibility
  window.addEventListener("telesyriana:user-changed", () => {
    const u = getCurrentUser();
    const show = !!u && u.role === "supervisor";
    elCreateBox?.classList.toggle("hidden", !show);
    if (show) prepareCreateDefaults().catch(console.error);
  });
}

document.addEventListener("DOMContentLoaded", initMeetings);

