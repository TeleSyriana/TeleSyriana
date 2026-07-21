// meetings.js — Firestore meetings (list + create + delete + one-meeting-per-supervisor + easy share)
// ✅ fixed: prevents double-init, reduces counters reads, handles 429/quota gracefully

import { db, fs } from "./firebase.js";

const {
  collection,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  getDocs,
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

// ✅ guard against loading this module twice
if (window.__TS_MEETINGS_INIT__) {
  // do nothing
} else {
  window.__TS_MEETINGS_INIT__ = true;

  let unsubUpcoming = null;
  let localStream = null;
  let allUpcoming = [];

  // throttle for counters (prevents 429)
  let defaultsLoading = false;
  let defaultsLoadedOnce = false;
  let lastCounterFetchMs = 0;
  const COUNTER_MIN_GAP_MS = 10_000;

  // -------------------- DOM --------------------
  const elSearch = document.getElementById("meeting-search");
  const elSearchClear = document.getElementById("meeting-search-clear");

  const elCreateBox = document.getElementById("create-meeting-box");
  const elCreateTitle = document.getElementById("create-title");
  const elCreateLink = document.getElementById("create-link");
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

  const ROLE_LEVELS = { agent: 1, supervisor: 2, hr: 3, manager: 3, admin: 4 };
  function roleLevel(user) { return ROLE_LEVELS[String(user?.role || "").toLowerCase()] || 0; }
  function canManageاجتماعs(user) { return roleLevel(user) >= ROLE_LEVELS.supervisor; }

  function mt(ar, en) {
    try {
      const lang = document.body?.dataset?.language || localStorage.getItem("telesyrianaLang") || "ar";
      return String(lang).toLowerCase().startsWith("ar") ? ar : en;
    } catch {
      return ar;
    }
  }

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

  function fallbackاجتماعId() {
    return pad4((Date.now() % 10000) || 1);
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

  function isQuotaErr(e) {
    const msg = String(e?.message || e || "");
    return msg.includes("429") || msg.toLowerCase().includes("resource-exhausted") || msg.toLowerCase().includes("quota");
  }

  async function copyText(text) {
    const t = String(text || "");
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      alert("Copied ✅");
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      alert("Copied ✅");
    }
  }

  async function shareText(title, text) {
    const payload = { title: title || "TeleSyriana", text: text || "" };
    if (navigator.share) {
      try {
        await navigator.share(payload);
      } catch {}
    } else {
      await copyText(payload.text);
    }
  }

  // -------------------- supervisor: enforce ONE meeting --------------------
  async function findMyUpcomingاجتماع(userId) {
    // only check meetings in the future
    const now = Timestamp.fromDate(new Date());
    const qy = query(
      collection(db, MEETINGS_COL),
      where("hostId", "==", String(userId)),
      where("startAt", ">=", now),
      orderBy("startAt", "asc"),
      limit(1)
    );

    const snap = await getDocs(qy);
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { id: d.id, ...d.data() };
  }

  async function deleteاجتماعById(meetingId) {
    if (!meetingId) return;
    await deleteDoc(doc(db, MEETINGS_COL, String(meetingId)));
  }

  // -------------------- meeting ID transaction --------------------
  async function nextاجتماعId() {
    const now = Date.now();
    if (now - lastCounterFetchMs < COUNTER_MIN_GAP_MS) {
      const cur = (elCreateId?.value || "").trim();
      return cur || fallbackاجتماعId();
    }
    lastCounterFetchMs = now;

    const ref = doc(db, "meta", "counters");

    try {
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
    } catch (e) {
      console.warn("nextاجتماعId fallback:", e);
      return fallbackاجتماعId();
    }
  }

  // -------------------- UI: render upcoming --------------------
  function renderList(list) {
    if (!elList || !elEmpty) return;

    const user = getCurrentUser();

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

      const canDelete = user && canManageاجتماعs(user) && (String(m.hostId || "") === String(user.id || "") || roleLevel(user) >= ROLE_LEVELS.manager);

      btn.innerHTML = `
        <div class="meeting-row">
          <div class="meeting-badge">M</div>
          <div class="meeting-text">
            <div class="meeting-title">
              ${escapeHtml(m.title || "اجتماع")}
              <span class="meeting-id">#${escapeHtml(m.meetingId)}</span>
            </div>
            <div class="meeting-sub">
              ${escapeHtml(formatStartAt(m.startAt))} • Host: ${escapeHtml(m.hostName || m.hostId || "-")} • ${m.meetingLink ? "Link ready" : "No link"}
            </div>
            <div class="meeting-sub" style="margin-top:6px; display:flex; gap:8px; flex-wrap:wrap;">
              <span class="meeting-pill">ID: <b>${escapeHtml(m.meetingId)}</b></span>
              <button type="button" class="btn-secondary" data-act="copy-id" style="padding:6px 10px;">📋 Copy ID</button>
              <button type="button" class="btn-secondary" data-act="share" style="padding:6px 10px;">📤 Share</button>
              ${canDelete ? `<button type="button" class="btn-secondary danger" data-act="delete" style="padding:6px 10px;">🗑 Delete</button>` : ``}
            </div>
          </div>
        </div>
      `;

      // click on main item fills join (without password)
      btn.addEventListener("click", (e) => {
        const act = e.target?.getAttribute?.("data-act");
        if (act) return; // handled below
        if (joinId) joinId.value = m.meetingId || "";
        joinPass?.focus?.();
      });

      // button actions
      btn.querySelector('[data-act="copy-id"]')?.addEventListener("click", async (e) => {
        e.stopPropagation();
        await copyText(m.meetingId || "");
      });

      btn.querySelector('[data-act="share"]')?.addEventListener("click", async (e) => {
        e.stopPropagation();
        const txt = `TeleSyriana اجتماع\nID: ${m.meetingId}\nTime: ${formatStartAt(m.startAt)}\nHost: ${m.hostName || m.hostId || "-"}`;
        await shareText("اجتماع", txt);
      });

      btn.querySelector('[data-act="delete"]')?.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete meeting #${m.meetingId}?`)) return;
        try {
          await deleteاجتماعById(m.meetingId);
          alert("تم الحذف ✅");
        } catch (err) {
          console.error(err);
          alert(isQuotaErr(err) ? "Quota issue (wait a bit) ⚠️" : "Delete failed ⚠️");
        }
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

    const qy = query(
      collection(db, MEETINGS_COL),
      where("startAt", ">=", now),
      orderBy("startAt", "asc"),
      limit(50)
    );

    unsubUpcoming = onSnapshot(
      qy,
      (snap) => {
        allUpcoming = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        applySearch(elSearch?.value || "");
      },
      (err) => {
        console.error("اجتماعs snapshot error:", err);
        allUpcoming = [];
        renderList([]);
      }
    );
  }

  // -------------------- Create meeting (supervisor) --------------------
  async function prepareCreateDefaults(force = false) {
    if (!elCreateId || !elCreatePass || !elCreateDate || !elCreateTime) return;
    if (defaultsLoading) return;

    const user = getCurrentUser();
    const isSup = !!user && canManageاجتماعs(user);

    // ✅ nicer UX: show password as password field + ability to toggle
    // (HTML currently uses type="text" readonly; we turn it into password + readonly)
    try {
      elCreatePass.setAttribute("readonly", "readonly");
      elCreateId.setAttribute("readonly", "readonly");
      elCreatePass.type = "password";
    } catch {}

    const idFilled = (elCreateId.value || "").trim().length > 0;
    const passFilled = (elCreatePass.value || "").trim().length > 0;

    if (!force && defaultsLoadedOnce && idFilled && passFilled) return;

    defaultsLoading = true;
    try {
      // if supervisor already has an upcoming meeting → reuse it (ONE meeting rule)
      if (isSup) {
        try {
          const existing = await findMyUpcomingاجتماع(user.id);
          if (existing?.meetingId) {
            // fill from existing
            elCreateId.value = existing.meetingId || "";
            elCreatePass.value = existing.password || "";
            elCreateTitle && (elCreateTitle.value = existing.title || "");

            // set date/time inputs from startAt
            const d = existing.startAt?.toDate?.() || null;
            if (d) {
              elCreateDate.value = toLocalDateInput(d);
              elCreateTime.value = toLocalTimeInput(d);
            }

            defaultsLoadedOnce = true;
            return;
          }
        } catch (e) {
          console.warn("findMyUpcomingاجتماع skipped:", e);
        }
      }

      // else: normal defaults
      const d = new Date();
      d.setMinutes(d.getMinutes() + 15);

      elCreateDate.value = toLocalDateInput(d);
      elCreateTime.value = toLocalTimeInput(d);

      elCreateId.value = await nextاجتماعId();
      elCreatePass.value = randomPassword(6);

      defaultsLoadedOnce = true;
    } finally {
      defaultsLoading = false;
    }
  }

  async function createاجتماع() {
    const user = getCurrentUser();
    if (!user || !canManageاجتماعs(user)) return alert("Supervisor, Manager or Admin only.");

    // ✅ ONE meeting only: if there is already upcoming meeting, block creation
    try {
      const existing = await findMyUpcomingاجتماع(user.id);
      if (existing?.meetingId) {
        // fill UI + tell user
        if (elCreateId) elCreateId.value = existing.meetingId || "";
        if (elCreatePass) elCreatePass.value = existing.password || "";
        alert(`You already have an upcoming meeting ✅\nاجتماع ID: ${existing.meetingId}\n(You can delete it first if you want a new one)`);
        return;
      }
    } catch (e) {
      console.warn("existing meeting check failed:", e);
      // continue (don’t block) if check fails
    }

    const title = (elCreateTitle?.value || "").trim() || "اجتماع";
    const meetingLink = (elCreateLink?.value || "").trim();
    const startAt = parseStartAt(elCreateDate?.value, elCreateTime?.value);
    if (!startAt) return alert("Choose date & time.");
    if (!meetingLink) return alert("Paste the Google Meet / Zoom link first.");

    const meetingId = (elCreateId?.value || "").trim();
    const password = (elCreatePass?.value || "").trim();
    if (!meetingId || !password) return alert("غائب اجتماع ID or password.");

    const payload = {
      meetingId,
      password,
      title,
      meetingLink,
      expiresAt: Timestamp.fromDate(new Date(startAt.toDate().getTime() + 60 * 60 * 1000)),
      startAt,
      hostId: user.id,
      hostName: user.name,
      createdAt: serverTimestamp(),
      status: "scheduled",
    };

    await setDoc(doc(db, MEETINGS_COL, meetingId), payload, { merge: true });

    // next defaults (force) — BUT since one-only, we actually keep showing same meeting
    defaultsLoadedOnce = false;
    await prepareCreateDefaults(false);

    // ✅ quick share
    const msg = `TeleSyriana اجتماع\nID: ${meetingId}\nPassword: ${password}\nTime: ${formatStartAt(startAt)}\nHost: ${user.name}`;
    await copyText(`ID: ${meetingId}\nPassword: ${password}`);
    alert(`تم الإنشاء ✅\nاجتماع ID: ${meetingId}\nPassword: ${password}\n\nCopied to clipboard ✅`);
    // optional: share sheet
    // await shareText("اجتماع", msg);
  }

  // -------------------- انضمام meeting (local preview only) --------------------
  async function joinاجتماع() {
    const id = (joinId?.value || "").trim();
    const pass = (joinPass?.value || "").trim();
    if (!id) return alert("Enter اجتماع ID.");

    const snap = await getDoc(doc(db, MEETINGS_COL, id));
    if (!snap.exists()) return alert("اجتماع not found.");

    const data = snap.data();
    if ((data.password || "") && (data.password || "") !== pass) return alert("Wrong access code.");

    const link = String(data.meetingLink || "").trim();
    if (!link) return alert("No meeting link was added by the manager.");

    const user = getCurrentUser();
    if (user?.id) {
      try {
        await setDoc(doc(db, MEETINGS_COL, id, "attendance", user.id), {
          userId: user.id,
          name: user.name,
          role: user.role,
          joinedAt: serverTimestamp(),
          clickedLink: true,
        }, { merge: true });
      } catch (err) {
        console.warn("attendance save failed", err);
      }
    }

    window.open(link, "_blank", "noopener,noreferrer");
  }

  function leaveاجتماع() {
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

  // -------------------- Easy share buttons (auto-injected) --------------------
  function injectShareButtons() {
    if (!elCreateBox || elCreateBox.__shareInjected) return;
    elCreateBox.__shareInjected = true;

    // create a small tools row under create-actions
    const tools = document.createElement("div");
    tools.style.display = "flex";
    tools.style.gap = "8px";
    tools.style.flexWrap = "wrap";
    tools.style.marginTop = "10px";

    const btnShow = document.createElement("button");
    btnShow.type = "button";
    btnShow.className = "btn-secondary";
    btnShow.textContent = mt("👁 إظهار كلمة المرور", "👁 Show password");

    const btnCopyId = document.createElement("button");
    btnCopyId.type = "button";
    btnCopyId.className = "btn-secondary";
    btnCopyId.textContent = mt("📋 نسخ رقم الاجتماع", "📋 Copy ID");

    const btnCopyPass = document.createElement("button");
    btnCopyPass.type = "button";
    btnCopyPass.className = "btn-secondary";
    btnCopyPass.textContent = mt("📋 نسخ كلمة المرور", "📋 Copy Password");

    const btnShare = document.createElement("button");
    btnShare.type = "button";
    btnShare.className = "btn-secondary";
    btnShare.textContent = mt("📤 مشاركة", "📤 Share");

    const btnDeleteMine = document.createElement("button");
    btnDeleteMine.type = "button";
    btnDeleteMine.className = "btn-secondary danger";
    btnDeleteMine.textContent = mt("🗑 حذف اجتماعي", "🗑 Delete my meeting");

    tools.appendChild(btnShow);
    tools.appendChild(btnCopyId);
    tools.appendChild(btnCopyPass);
    tools.appendChild(btnShare);
    tools.appendChild(btnDeleteMine);

    elCreateBox.appendChild(tools);

    btnShow.addEventListener("click", () => {
      if (!elCreatePass) return;
      const isPwd = elCreatePass.type === "password";
      elCreatePass.type = isPwd ? "text" : "password";
      btnShow.textContent = isPwd ? mt("🙈 إخفاء كلمة المرور", "🙈 Hide password") : mt("👁 إظهار كلمة المرور", "👁 Show password");
    });

    btnCopyId.addEventListener("click", async () => {
      await copyText(elCreateId?.value || "");
    });

    btnCopyPass.addEventListener("click", async () => {
      await copyText(elCreatePass?.value || "");
    });

    btnShare.addEventListener("click", async () => {
      const id = (elCreateId?.value || "").trim();
      const pw = (elCreatePass?.value || "").trim();
      const t = (elCreateTitle?.value || "اجتماع").trim();
      const d = `${elCreateDate?.value || ""} ${elCreateTime?.value || ""}`.trim();
      const msg = `TeleSyriana اجتماع\nTitle: ${t}\nID: ${id}\nPassword: ${pw}\nTime: ${d}`;
      await shareText("اجتماع", msg);
    });

    btnDeleteMine.addEventListener("click", async () => {
      const user = getCurrentUser();
      if (!user || !canManageاجتماعs(user)) return;

      // try delete by current createId first
      const id = (elCreateId?.value || "").trim();
      if (!id) return alert("No meeting to delete.");

      if (!confirm(`Delete your meeting #${id}?`)) return;

      try {
        await deleteاجتماعById(id);
        // clear fields after delete
        if (elCreateTitle) elCreateTitle.value = "";
        if (elCreateId) elCreateId.value = "";
        if (elCreatePass) elCreatePass.value = "";
        defaultsLoadedOnce = false;
        await prepareCreateDefaults(false);
        alert("تم الحذف ✅");
      } catch (err) {
        console.error(err);
        alert(isQuotaErr(err) ? "Quota issue (wait a bit) ⚠️" : "Delete failed ⚠️");
      }
    });
  }

  function meetingsPageIsActive() {
    const page = document.getElementById("page-meetings");
    return Boolean(page && !page.classList.contains("hidden"));
  }

  function stopUpcomingSubscription() {
    if (unsubUpcoming) {
      try { unsubUpcoming(); } catch {}
    }
    unsubUpcoming = null;
  }

  function syncMeetingsPageRealtime() {
    const user = getCurrentUser();
    const active = meetingsPageIsActive();

    if (elCreateBox) {
      const show = active && !!user && canManageاجتماعs(user);
      elCreateBox.classList.toggle("hidden", !show);
      if (show) {
        injectShareButtons();
        prepareCreateDefaults(false).catch(console.error);
      }
    }

    if (!user || !active) {
      stopUpcomingSubscription();
      return;
    }

    subscribeUpcoming();
  }

  // -------------------- init --------------------
  function initاجتماعs() {
    syncMeetingsPageRealtime();

    document.querySelectorAll(".nav-link[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.page === "meetings") setTimeout(syncMeetingsPageRealtime, 0);
        else stopUpcomingSubscription();
      });
    });

    elSearch?.addEventListener("input", () => applySearch(elSearch.value));
    elSearchClear?.addEventListener("click", () => {
      if (elSearch) elSearch.value = "";
      applySearch("");
    });

    btnNewPass?.addEventListener("click", () => {
      // password only changes (doesn’t create extra reads)
      if (elCreatePass) elCreatePass.value = randomPassword(6);
    });

    btnCreate?.addEventListener("click", () => {
      createاجتماع().catch((e) => {
        console.error(e);
        alert(isQuotaErr(e) ? "Quota exceeded ⚠️ (wait 1-2 min)" : "Create failed (rules/quota) ⚠️");
      });
    });

    joinBtn?.addEventListener("click", () => {
      joinاجتماع().catch((e) => {
        console.error(e);
        alert(isQuotaErr(e) ? "Quota exceeded ⚠️ (wait 1-2 min)" : "انضمام failed ⚠️");
      });
    });

    micBtn?.addEventListener("click", toggleMic);
    camBtn?.addEventListener("click", toggleCam);
    handBtn?.addEventListener("click", raiseHand);
    leaveBtn?.addEventListener("click", leaveاجتماع);

    window.addEventListener("telesyriana:user-changed", () => {
      syncMeetingsPageRealtime();
    });
  }

  document.addEventListener("DOMContentLoaded", initاجتماعs);
}

try { window.addEventListener("telesyriana:language-changed", () => { try { injectShareButtons(); } catch {} }); } catch {}
