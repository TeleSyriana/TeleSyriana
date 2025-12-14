// meetings.js — Firestore meetings + WebRTC Mesh (10 ppl demo)
// ✅ GitHub Pages compatible (no server), Firestore signaling
// ✅ delete meeting (soft cancel), one meeting per host (client-enforced), show/copy password
// ⚠️ For some networks you may need TURN later

import { db, fs } from "./firebase.js";

const {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  runTransaction,
} = fs;

const MEETINGS_COL = "meetings";

// guard
if (window.__TS_MEETINGS_INIT__) {
  // do nothing
} else {
  window.__TS_MEETINGS_INIT__ = true;

  let unsubUpcoming = null;

  // ---- WebRTC state ----
  let localStream = null;
  let activeMeetingId = null;
  let pcs = new Map(); // peerId -> RTCPeerConnection
  let remoteStreams = new Map(); // peerId -> MediaStream
  let unsubParticipants = null;
  let unsubsCalls = new Map(); // callId -> unsub
  let myUser = null;

  let allUpcoming = [];

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
  const btnShowPass = document.getElementById("btn-show-pass");
  const btnCopyPass = document.getElementById("btn-copy-pass");

  const elList = document.getElementById("meetings-list");
  const elEmpty = document.getElementById("meetings-empty");

  const joinId = document.getElementById("join-meeting-id");
  const joinPass = document.getElementById("join-meeting-pass");
  const joinBtn = document.getElementById("join-meeting-btn");

  const stage = document.getElementById("meeting-stage");
  const grid = document.getElementById("meeting-grid");
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
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
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
      const d = ts?.toDate?.();
      if (!d) return "";
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
      "'": "&#039;",
    }[m]));
  }

  function pairId(a, b) {
    const x = String(a), y = String(b);
    return x < y ? `${x}_${y}` : `${y}_${x}`;
  }

  function isInitiator(meId, otherId) {
    // smaller id is initiator to avoid double offers
    const x = String(meId), y = String(otherId);
    return x < y;
  }

  // -------------------- meeting ID transaction --------------------
  async function nextMeetingId() {
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

    const user = getCurrentUser();

    list.forEach((m) => {
      const wrap = document.createElement("div");
      wrap.style.display = "flex";
      wrap.style.gap = "8px";
      wrap.style.alignItems = "center";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "meeting-item";
      btn.style.flex = "1";

      btn.innerHTML = `
        <div class="meeting-row">
          <div class="meeting-badge">M</div>
          <div class="meeting-text">
            <div class="meeting-title">
              ${escapeHtml(m.title || "Meeting")} <span class="meeting-id">#${escapeHtml(m.meetingId)}</span>
            </div>
            <div class="meeting-sub">
              ${escapeHtml(formatStartAt(m.startAt))} • Host: ${escapeHtml(m.hostName || m.hostId || "-")}
              ${m.status === "cancelled" ? " • (cancelled)" : ""}
            </div>
          </div>
        </div>
      `;

      btn.addEventListener("click", () => {
        if (joinId) joinId.value = m.meetingId || "";
        joinPass?.focus?.();
      });

      wrap.appendChild(btn);

      // ✅ supervisor can cancel own meeting
      const canDelete = user?.role === "supervisor" && String(m.hostId || "") === String(user.id || "");
      if (canDelete) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "btn-secondary danger";
        del.textContent = "🗑";
        del.title = "Cancel meeting";
        del.addEventListener("click", async () => {
          if (!confirm(`Cancel meeting #${m.meetingId}?`)) return;
          try {
            await updateDoc(doc(db, MEETINGS_COL, String(m.meetingId)), {
              status: "cancelled",
              cancelledAt: serverTimestamp(),
            });
          } catch (e) {
            console.error(e);
            alert("Cancel failed (rules/quota).");
          }
        });
        wrap.appendChild(del);
      }

      elList.appendChild(wrap);
    });
  }

  function applySearch(q) {
    const s = String(q || "").trim().toLowerCase();
    const filtered = !s
      ? allUpcoming
      : allUpcoming.filter((m) => {
          const hay = `${m.meetingId || ""} ${m.title || ""} ${m.hostName || ""} ${m.hostId || ""}`.toLowerCase();
          return hay.includes(s);
        });

    renderList(filtered);
  }

  // -------------------- Firestore: subscribe upcoming --------------------
  function subscribeUpcoming() {
    if (unsubUpcoming) return;

    const now = Timestamp.fromDate(new Date());
    const qy = query(
      collection(db, MEETINGS_COL),
      where("startAt", ">=", now),
      orderBy("startAt", "asc"),
      limit(50)
    );

    unsubUpcoming = onSnapshot(
      qy,
      (snap) => {
        const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        // ✅ filter cancelled locally (avoid composite indexes)
        allUpcoming = arr.filter((m) => (m.status || "scheduled") !== "cancelled");
        applySearch(elSearch?.value || "");
      },
      (err) => {
        console.error("Meetings snapshot error:", err);
        allUpcoming = [];
        renderList([]);
      }
    );
  }

  // -------------------- Create meeting (supervisor) --------------------
  async function prepareCreateDefaults() {
    if (!elCreateId || !elCreatePass || !elCreateDate || !elCreateTime) return;

    const d = new Date();
    d.setMinutes(d.getMinutes() + 15);

    elCreateDate.value = toLocalDateInput(d);
    elCreateTime.value = toLocalTimeInput(d);

    elCreateId.value = await nextMeetingId();
    elCreatePass.value = randomPassword(6);
  }

  async function createMeeting() {
    const user = getCurrentUser();
    if (!user || user.role !== "supervisor") return alert("Supervisor only.");

    // ✅ one active meeting per host (client-enforced)
    // check if there is already a scheduled meeting by me in upcoming cache:
    const already = allUpcoming.find((m) => String(m.hostId || "") === String(user.id) && (m.status || "scheduled") === "scheduled");
    if (already) {
      return alert(`You already have one upcoming meeting (#${already.meetingId}). Cancel it first.`);
    }

    const title = (elCreateTitle?.value || "").trim() || "Meeting";
    const startAt = parseStartAt(elCreateDate?.value, elCreateTime?.value);
    if (!startAt) return alert("Choose date & time.");

    const meetingId = (elCreateId?.value || "").trim();
    const password = (elCreatePass?.value || "").trim();
    if (!meetingId || !password) return alert("Missing Meeting ID or password.");

    const payload = {
      meetingId,
      password, // demo only (later: hash or move to server)
      title,
      startAt,
      hostId: user.id,
      hostName: user.name,
      createdAt: serverTimestamp(),
      status: "scheduled",
    };

    await setDoc(doc(db, MEETINGS_COL, meetingId), payload, { merge: true });

    await prepareCreateDefaults();
    alert(`Created ✅\nMeeting ID: ${meetingId}\nPassword: ${password}`);
  }

  // -------------------- WebRTC: UI tiles --------------------
  function clearGrid() {
    if (!grid) return;
    grid.innerHTML = "";
  }

  function ensureTile(peerId, label, stream, isLocal = false) {
    if (!grid) return;

    const id = `tile_${String(peerId)}`;
    let tile = document.getElementById(id);
    if (!tile) {
      tile = document.createElement("div");
      tile.className = "video-tile";
      tile.id = id;

      const vid = document.createElement("video");
      vid.autoplay = true;
      vid.playsInline = true;
      vid.muted = !!isLocal; // local muted to prevent echo

      const bar = document.createElement("div");
      bar.className = "tile-bar";
      bar.innerHTML = `
        <span>${escapeHtml(label || peerId)}</span>
        <span style="display:flex; gap:8px; align-items:center;">
          <button class="tile-btn" data-full>⛶</button>
        </span>
      `;

      bar.querySelector("[data-full]")?.addEventListener("click", () => {
        try {
          const el = tile;
          if (el.requestFullscreen) el.requestFullscreen();
        } catch {}
      });

      tile.appendChild(vid);
      tile.appendChild(bar);
      grid.appendChild(tile);
    }

    const video = tile.querySelector("video");
    if (video && stream && video.srcObject !== stream) {
      video.srcObject = stream;
    }
  }

  // -------------------- WebRTC: create PC --------------------
  function createPeerConnection(otherId) {
    const iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ];

    const pc = new RTCPeerConnection({ iceServers });

    // send my tracks
    if (localStream) {
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    }

    // receive remote
    pc.ontrack = (ev) => {
      const [stream] = ev.streams;
      if (!stream) return;
      remoteStreams.set(otherId, stream);
      ensureTile(otherId, `CCMS ${otherId}`, stream, false);
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      // console.log("pc state", otherId, st);
      if (st === "failed" || st === "disconnected" || st === "closed") {
        // keep UI, but you can remove tile if you want
      }
    };

    pcs.set(otherId, pc);
    return pc;
  }

  function pcFor(otherId) {
    return pcs.get(otherId) || createPeerConnection(otherId);
  }

  // -------------------- WebRTC: signaling paths --------------------
  function callDocRef(meetingId, callId) {
    return doc(db, MEETINGS_COL, String(meetingId), "calls", String(callId));
  }
  function callCandidatesCol(meetingId, callId, side) {
    // side: "offerCandidates" | "answerCandidates"
    return collection(db, MEETINGS_COL, String(meetingId), "calls", String(callId), side);
  }
  function participantsCol(meetingId) {
    return collection(db, MEETINGS_COL, String(meetingId), "participants");
  }
  function participantRef(meetingId, userId) {
    return doc(db, MEETINGS_COL, String(meetingId), "participants", String(userId));
  }

  // initiator (smaller id) creates offer
  async function startCallAsInitiator(meetingId, otherId) {
    const callId = pairId(myUser.id, otherId);
    if (unsubsCalls.has(callId)) return; // already

    const pc = pcFor(otherId);
    const callRef = callDocRef(meetingId, callId);

    // ICE -> offerCandidates
    pc.onicecandidate = async (ev) => {
      if (!ev.candidate) return;
      try {
        const col = callCandidatesCol(meetingId, callId, "offerCandidates");
        await setDoc(doc(col), ev.candidate.toJSON());
      } catch (e) {
        console.warn("offerCandidates write failed", e);
      }
    };

    // create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await setDoc(callRef, {
      a: String(myUser.id),
      b: String(otherId),
      offer: { type: offer.type, sdp: offer.sdp },
      createdAt: serverTimestamp(),
    }, { merge: true });

    // listen for answer
    const unsub = onSnapshot(callRef, async (snap) => {
      const data = snap.data();
      if (!data) return;

      if (data.answer && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
    });
    unsubsCalls.set(callId, unsub);

    // listen answer candidates
    onSnapshot(callCandidatesCol(meetingId, callId, "answerCandidates"), (snap) => {
      snap.docChanges().forEach(async (ch) => {
        if (ch.type !== "added") return;
        try {
          await pc.addIceCandidate(new RTCIceCandidate(ch.doc.data()));
        } catch {}
      });
    });
  }

  // callee (bigger id) answers
  async function ensureAnsweringListener(meetingId, otherId) {
    const callId = pairId(myUser.id, otherId);
    if (unsubsCalls.has(callId)) return;

    const callRef = callDocRef(meetingId, callId);
    const pc = pcFor(otherId);

    // ICE -> answerCandidates
    pc.onicecandidate = async (ev) => {
      if (!ev.candidate) return;
      try {
        const col = callCandidatesCol(meetingId, callId, "answerCandidates");
        await setDoc(doc(col), ev.candidate.toJSON());
      } catch (e) {
        console.warn("answerCandidates write failed", e);
      }
    };

    const unsub = onSnapshot(callRef, async (snap) => {
      const data = snap.data();
      if (!data) return;

      // only if offer exists and answer not set
      if (data.offer && !data.answer) {
        if (!pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        await setDoc(callRef, {
          answer: { type: answer.type, sdp: answer.sdp },
          answeredAt: serverTimestamp(),
        }, { merge: true });
      }

      // if offer exists and we haven't set it yet, still set it
      if (data.offer && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      }
    });

    unsubsCalls.set(callId, unsub);

    // listen offer candidates
    onSnapshot(callCandidatesCol(meetingId, callId, "offerCandidates"), (snap) => {
      snap.docChanges().forEach(async (ch) => {
        if (ch.type !== "added") return;
        try {
          await pc.addIceCandidate(new RTCIceCandidate(ch.doc.data()));
        } catch {}
      });
    });
  }

  // -------------------- Join meeting (REAL WebRTC) --------------------
  async function joinMeeting() {
    const user = getCurrentUser();
    if (!user) return alert("Login first.");
    myUser = user;

    const id = (joinId?.value || "").trim();
    const pass = (joinPass?.value || "").trim();
    if (!id || !pass) return alert("Enter Meeting ID + password.");

    // validate
    const snap = await getDoc(doc(db, MEETINGS_COL, id));
    if (!snap.exists()) return alert("Meeting not found.");

    const data = snap.data();
    if ((data.password || "") !== pass) return alert("Wrong password.");
    if ((data.status || "scheduled") === "cancelled") return alert("Meeting cancelled.");

    activeMeetingId = String(id);

    // local media
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch {
      return alert("Camera/Mic blocked. Please allow permissions.");
    }

    // UI
    stage?.classList.remove("hidden");
    if (liveTitle) liveTitle.textContent = data.title || "In meeting";
    if (liveMeta) liveMeta.textContent = `#${data.meetingId} • ${formatStartAt(data.startAt)}`;
    clearGrid();
    ensureTile(myUser.id, `${myUser.name || "Me"} (You)`, localStream, true);

    // add me to participants
    try {
      await setDoc(participantRef(activeMeetingId, myUser.id), {
        userId: String(myUser.id),
        name: myUser.name || "",
        role: myUser.role || "",
        joinedAt: serverTimestamp(),
        lastSeen: serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      console.error(e);
      alert("Join failed (Firestore rules/quota).");
      return;
    }

    // subscribe participants (auto-manage 2..10)
    unsubParticipants?.();
    unsubParticipants = onSnapshot(participantsCol(activeMeetingId), async (psnap) => {
      const ids = [];
      psnap.forEach((d) => {
        const p = d.data() || {};
        if (p.userId) ids.push(String(p.userId));
      });

      const others = ids.filter((x) => x !== String(myUser.id));

      // create connections for everyone (mesh)
      for (const otherId of others.slice(0, 9)) { // allow up to 10 total (me + 9)
        if (!pcs.has(otherId)) {
          createPeerConnection(otherId);
        }

        if (isInitiator(myUser.id, otherId)) {
          startCallAsInitiator(activeMeetingId, otherId).catch(console.error);
        } else {
          ensureAnsweringListener(activeMeetingId, otherId).catch(console.error);
        }
      }
    });
  }

  // -------------------- Leave meeting --------------------
  async function leaveMeeting() {
    // stop listeners
    unsubParticipants?.();
    unsubParticipants = null;

    unsubsCalls.forEach((u) => {
      try { u?.(); } catch {}
    });
    unsubsCalls.clear();

    // close peer connections
    pcs.forEach((pc) => {
      try { pc.close(); } catch {}
    });
    pcs.clear();
    remoteStreams.clear();

    // stop local
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }

    // remove participant doc (best-effort)
    if (activeMeetingId && myUser?.id) {
      try {
        // Firestore client deleteDoc not imported; do soft "leftAt"
        await setDoc(participantRef(activeMeetingId, myUser.id), {
          leftAt: serverTimestamp(),
          active: false,
        }, { merge: true });
      } catch {}
    }

    activeMeetingId = null;
    clearGrid();
    stage?.classList.add("hidden");
  }

  // -------------------- controls --------------------
  function toggleMic() {
    if (!localStream) return;
    const t = localStream.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    if (micBtn) micBtn.textContent = t.enabled ? "🎤 Mute" : "🔇 Unmute";
  }

  function toggleCam() {
    if (!localStream) return;
    const t = localStream.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    if (camBtn) camBtn.textContent = t.enabled ? "📷 Camera off" : "🚫 Camera on";
  }

  function raiseHand() {
    if (!handBtn) return;
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
      if (show) prepareCreateDefaults().catch(console.error);
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
      if (elCreatePass) {
        elCreatePass.value = randomPassword(6);
      }
    });

    btnCreate?.addEventListener("click", () => {
      createMeeting().catch((e) => {
        console.error(e);
        alert("Create failed (check Firestore rules/quota).");
      });
    });

    // show/copy password
    btnShowPass?.addEventListener("click", () => {
      if (!elCreatePass) return;
      elCreatePass.type = elCreatePass.type === "password" ? "text" : "password";
      btnShowPass.textContent = elCreatePass.type === "password" ? "👁 Show" : "🙈 Hide";
    });

    btnCopyPass?.addEventListener("click", async () => {
      const v = (elCreatePass?.value || "").trim();
      if (!v) return;
      try {
        await navigator.clipboard.writeText(v);
        btnCopyPass.textContent = "✅ Copied";
        setTimeout(() => (btnCopyPass.textContent = "📋 Copy"), 900);
      } catch {
        alert("Copy failed (browser permissions).");
      }
    });

    // join
    joinBtn?.addEventListener("click", () => {
      joinMeeting().catch((e) => {
        console.error(e);
        alert("Join failed (rules / network).");
      });
    });

    micBtn?.addEventListener("click", toggleMic);
    camBtn?.addEventListener("click", toggleCam);
    handBtn?.addEventListener("click", raiseHand);
    leaveBtn?.addEventListener("click", () => {
      leaveMeeting().catch(console.error);
    });

    // user changed
    window.addEventListener("telesyriana:user-changed", () => {
      const u = getCurrentUser();
      const show = !!u && u.role === "supervisor";
      elCreateBox?.classList.toggle("hidden", !show);
      if (show) prepareCreateDefaults().catch(console.error);
    });
  }

  document.addEventListener("DOMContentLoaded", initMeetings);
}
