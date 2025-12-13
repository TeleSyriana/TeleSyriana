// messages.js – TeleSyriana Firestore chat
// ✅ Limit + scroll up (pagination)
// ✅ Rooms + DMs
// ✅ Status dots
// ✅ DM reorder ONLY after sending message
// ✅ Search filter
// ✅ Glass sidebar compatible

import { db, fs } from "./firebase.js";

const {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  getDocs,
  limit,
  startAfter,
} = fs;

const USER_KEY = "telesyrianaUser";
const MESSAGES_COL = "globalMessages";
const AGENT_DAYS_COL = "agentDays";

// recents per user
const RECENTS_KEY_PREFIX = "telesyrianaChatRecents";

const PAGE_SIZE = 50;
const MAX_RENDER = 600;

let currentUser = null;

// activeChat: { type: "room"|"dm"|"ai", roomId, otherId?, title?, desc? }
let activeChat = null;

let unsubscribeMain = null;
let unsubscribeStatus = null;

// For rendering / pagination
let newestAsc = [];          // newest PAGE_SIZE messages ASC (old->new)
let olderAsc = [];           // older loaded messages ASC (old->new)
let oldestCursorDoc = null;  // Firestore doc cursor for "older" pagination (desc query)
let isLoadingOlder = false;
let noMoreOlder = false;

// Prevent binding scroll twice
let scrollBoundEl = null;

// sidebar list refs
let dmListEl = null;

/* ---------------- helpers ---------------- */

function getUserFromStorage() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    return u?.id ? u : null;
  } catch {
    return null;
  }
}

function setCurrentUser() {
  currentUser = getUserFromStorage();
}

function formatTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function dmRoomId(a, b) {
  const x = String(a),
    y = String(b);
  return x < y ? `dm_${x}_${y}` : `dm_${y}_${x}`;
}

function getOtherIdFromDmRoom(roomId, myId) {
  const p = String(roomId || "").split("_");
  if (p.length !== 3) return null;
  return String(myId) === p[1] ? p[2] : p[1];
}

function statusToDotClass(status) {
  if (status === "in_operation" || status === "handling") return "dot-online";
  if (status === "meeting" || status === "break") return "dot-warn";
  return "dot-offline";
}

/* ---------------- UI helpers ---------------- */

function clearActiveButtons() {
  document.querySelectorAll(".chat-room, .chat-dm").forEach((b) => {
    b.classList.remove("active", "chat-item-active");
  });
}

function setActiveButton(el) {
  clearActiveButtons();
  el?.classList.add("active", "chat-item-active");
}

function setHeader(nameEl, descEl, title, desc) {
  if (nameEl) nameEl.textContent = title || "Messages";
  if (descEl) descEl.textContent = desc || "Start chatting…";
}

function setEmptyState(emptyEl, listEl, on) {
  if (!emptyEl || !listEl) return;
  emptyEl.style.display = on ? "block" : "none";
  listEl.style.display = on ? "none" : "flex";
}

function setInputEnabled(formEl, inputEl, enabled) {
  if (!formEl || !inputEl) return;
  const btn = formEl.querySelector("button[type='submit']");
  inputEl.disabled = !enabled;
  if (btn) btn.disabled = !enabled;
}

function ensureTopLoader(listEl) {
  let loader = listEl.querySelector("#chat-top-loader");
  if (!loader) {
    loader = document.createElement("div");
    loader.id = "chat-top-loader";
    loader.style.display = "none";
    loader.style.padding = "8px";
    loader.style.textAlign = "center";
    loader.style.fontSize = "12px";
    loader.style.color = "#777";
    loader.textContent = "Loading older messages…";
    listEl.prepend(loader);
  }
  return loader;
}

/* ---------------- Messages render ---------------- */

function getInitials(name = "") {
  const parts = String(name).trim().split(/\s+/).slice(0, 2);
  const initials = parts.map((p) => (p[0] || "").toUpperCase()).join("");
  return initials || "U";
}

function escapeHtml(str = "") {
  // prevent accidental HTML injection in message text
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createMessageNode(m) {
  const wrap = document.createElement("div");
  wrap.className = "chat-message";
  if (m.userId === currentUser?.id) wrap.classList.add("me");

  const name = escapeHtml(m.name || "User");
  const text = escapeHtml(m.text || "");

  wrap.innerHTML = `
    <div class="msg-avatar">${getInitials(m.name)}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-name">${name}</span>
        <span>• ${formatTime(m.ts)}</span>
      </div>
      <div class="chat-message-text">${text}</div>
    </div>
  `;
  return wrap;
}

function buildCombinedAsc() {
  // olderAsc is old->new, newestAsc is old->new
  // Combined should be old->new
  const combined = [...olderAsc, ...newestAsc];

  // Safety cap (keep newest MAX_RENDER)
  if (combined.length > MAX_RENDER) {
    return combined.slice(combined.length - MAX_RENDER);
  }
  return combined;
}

function renderFresh(listEl) {
  if (!listEl) return;

  const loader = ensureTopLoader(listEl);

  // wipe everything except loader
  Array.from(listEl.children).forEach((ch) => {
    if (ch !== loader) ch.remove();
  });

  const msgs = buildCombinedAsc();

  const frag = document.createDocumentFragment();
  msgs.forEach((m) => frag.appendChild(createMessageNode(m)));
  listEl.appendChild(frag);

  // scroll to bottom for fresh render
  listEl.scrollTop = listEl.scrollHeight;
}

function prependOlderChunk(listEl, chunkAsc) {
  if (!listEl || !chunkAsc?.length) return;

  const loader = ensureTopLoader(listEl);

  const prevHeight = listEl.scrollHeight;
  const prevTop = listEl.scrollTop;

  const frag = document.createDocumentFragment();
  chunkAsc.forEach((m) => frag.appendChild(createMessageNode(m)));

  const afterLoader = loader.nextSibling;
  if (afterLoader) listEl.insertBefore(frag, afterLoader);
  else listEl.appendChild(frag);

  // keep viewport stable
  const newHeight = listEl.scrollHeight;
  listEl.scrollTop = prevTop + (newHeight - prevHeight);
}

/* ---------------- Firestore (Main Chat) ---------------- */

function unsubscribeAllMain() {
  unsubscribeMain?.();
  unsubscribeMain = null;

  newestAsc = [];
  olderAsc = [];
  oldestCursorDoc = null;
  isLoadingOlder = false;
  noMoreOlder = false;
  scrollBoundEl = null;
}

function subscribeMainToRoom(roomId, listEl, headerNameEl, headerDescEl) {
  if (!roomId || !listEl) return;

  unsubscribeAllMain();

  // listen only to newest PAGE_SIZE, live
  const qNewest = query(
    collection(db, MESSAGES_COL),
    where("room", "==", roomId),
    orderBy("ts", "desc"),
    limit(PAGE_SIZE)
  );

  unsubscribeMain = onSnapshot(
    qNewest,
    (snap) => {
      setCurrentUser();

      // newest in DESC from firestore snapshot (because orderBy desc)
      const newestDesc = [];
      snap.forEach((d) => newestDesc.push({ id: d.id, ...d.data() }));

      // cursor for older pagination = last doc in desc list (oldest among newest)
      oldestCursorDoc = snap.docs[snap.docs.length - 1] || null;

      // store as ASC for UI
      newestAsc = newestDesc.slice().reverse();

      // if we have no messages at all (new room), show empty state message list but still keep input enabled
      renderFresh(listEl);

      // attach scroll loader only once
      attachScrollLoader(listEl, roomId);

      // If room has fewer than PAGE_SIZE messages, we may already be at the beginning
      // (Still allow older loading but it will quickly set noMoreOlder=true)
      if (snap.size < PAGE_SIZE) {
        // not necessarily no more, but often yes — leave it false and let first older load decide
      }

      // header: show subtitle if room empty
      if (headerDescEl && buildCombinedAsc().length === 0) {
        headerDescEl.textContent = "Start chatting…";
      }
    },
    (err) => {
      console.error("Main snapshot error:", err);
      alert("Firestore error: " + err.message);
    }
  );
}

async function loadOlderPage(roomId, listEl) {
  if (!roomId || !listEl) return;
  if (isLoadingOlder || noMoreOlder) return;
  if (!oldestCursorDoc) {
    // nothing loaded yet
    return;
  }

  isLoadingOlder = true;
  const loader = ensureTopLoader(listEl);
  loader.style.display = "block";

  try {
    const qOlder = query(
      collection(db, MESSAGES_COL),
      where("room", "==", roomId),
      orderBy("ts", "desc"),
      startAfter(oldestCursorDoc),
      limit(PAGE_SIZE)
    );

    const snap = await getDocs(qOlder);

    if (snap.empty) {
      noMoreOlder = true;
      loader.textContent = "No more messages";
      setTimeout(() => {
        loader.style.display = "none";
        loader.textContent = "Loading older messages…";
      }, 700);
      isLoadingOlder = false;
      return;
    }

    const olderDesc = [];
    snap.forEach((d) => olderDesc.push({ id: d.id, ...d.data() }));

    // update cursor for next pagination
    oldestCursorDoc = snap.docs[snap.docs.length - 1] || oldestCursorDoc;

    // convert to ASC and prepend to olderAsc
    const chunkAsc = olderDesc.slice().reverse();

    // Update store (olderAsc is ASC)
    olderAsc = [...chunkAsc, ...olderAsc];

    // Cap total render memory
    const combined = buildCombinedAsc();
    const extra = combined.length - MAX_RENDER;
    if (extra > 0) {
      // drop from very oldest side
      // remove from olderAsc first
      olderAsc = olderAsc.slice(extra);
    }

    // Prepend to DOM without re-render everything (keeps scroll position stable)
    prependOlderChunk(listEl, chunkAsc);
  } catch (e) {
    console.error("loadOlderPage error:", e);
    alert("Error loading older messages: " + (e?.message || e));
  } finally {
    isLoadingOlder = false;
    loader.style.display = "none";
  }
}

function attachScrollLoader(listEl, roomId) {
  if (!listEl) return;
  if (scrollBoundEl === listEl) return;
  scrollBoundEl = listEl;

  ensureTopLoader(listEl);

  listEl.addEventListener("scroll", async () => {
    // near top
    if (listEl.scrollTop > 40) return;
    await loadOlderPage(roomId, listEl);
  });
}

/* ---------------- Recents (ONLY on send) ---------------- */

function recentsKey() {
  if (!currentUser?.id) return null;
  return `${RECENTS_KEY_PREFIX}:${currentUser.id}`;
}

function loadRecents() {
  const key = recentsKey();
  if (!key) return {};
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch {
    return {};
  }
}

function saveRecents(map) {
  const key = recentsKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(map || {}));
  } catch {}
}

function bumpRecent(otherId) {
  if (!otherId || !currentUser?.id) return;
  const map = loadRecents();
  map[String(otherId)] = Date.now();
  saveRecents(map);
  applyDmOrder();
}

function applyDmOrder() {
  if (!dmListEl) dmListEl = document.getElementById("dm-list");
  if (!dmListEl) return;

  const map = loadRecents();
  const buttons = Array.from(dmListEl.querySelectorAll(".chat-dm"));

  buttons.sort((a, b) => {
    const ida = String(a.dataset.dm || "");
    const idb = String(b.dataset.dm || "");
    const ta = map[ida] || 0;
    const tb = map[idb] || 0;
    if (tb !== ta) return tb - ta;
    return ida.localeCompare(idb);
  });

  buttons.forEach((b) => dmListEl.appendChild(b));
}

/* ---------------- Status dots ---------------- */

function subscribeStatusDots() {
  unsubscribeStatus?.();
  unsubscribeStatus = null;

  const q = query(collection(db, AGENT_DAYS_COL), where("day", "==", getTodayKey()));

  unsubscribeStatus = onSnapshot(q, (snap) => {
    // reset all
    document.querySelectorAll("[data-status-dot]").forEach((dot) => {
      dot.classList.remove("dot-online", "dot-warn", "dot-offline");
      dot.classList.add("dot-offline");
    });

    snap.forEach((docu) => {
      const d = docu.data();
      const userId = String(d.userId || d.userId === 0 ? d.userId : d.userId || d.userId);
      const dot = document.querySelector(`[data-status-dot="${String(d.userId || "")}"]`);
      if (!dot) return;

      const cls = statusToDotClass(d.status || "unavailable");
      dot.classList.remove("dot-online", "dot-warn", "dot-offline");
      dot.classList.add(cls);

      // optional: update sub text if exists
      const sub = document.querySelector(`[data-sub="${String(d.userId || "")}"]`);
      if (sub) sub.textContent = d.status ? String(d.status).replaceAll("_", " ") : "unavailable";
    });
  });
}

/* ---------------- Search ---------------- */

function hookSearch() {
  const input = document.getElementById("chat-search");
  const clear = document.getElementById("chat-search-clear");
  if (!input) return;

  const run = () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll(".chat-room, .chat-dm").forEach((b) => {
      const titleEl = b.querySelector(".chat-room-title");
      const subEl = b.querySelector(".chat-room-sub");
      const t = (titleEl?.textContent || b.textContent || "").toLowerCase();
      const s = (subEl?.textContent || "").toLowerCase();
      const hit = !q || t.includes(q) || s.includes(q);
      b.style.display = hit ? "" : "none";
    });
  };

  input.addEventListener("input", run);

  clear?.addEventListener("click", () => {
    input.value = "";
    input.focus();
    run();
  });

  run();
}

/* ---------------- Init ---------------- */

document.addEventListener("DOMContentLoaded", () => {
  setCurrentUser();

  const listEl = document.getElementById("chat-message-list");
  const emptyEl = document.getElementById("chat-empty");
  const nameEl = document.getElementById("chat-room-name");
  const descEl = document.getElementById("chat-room-desc");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");

  dmListEl = document.getElementById("dm-list");

  hookSearch();
  applyDmOrder();
  subscribeStatusDots();

  // Default state
  activeChat = null;
  setHeader(nameEl, descEl, "Messages", "Start chatting…");
  if (listEl && emptyEl) setEmptyState(emptyEl, listEl, true);
  setInputEnabled(formEl, inputEl, false);

  // Rooms
  document.querySelectorAll(".chat-room").forEach((btn) => {
    btn.addEventListener("click", () => {
      setCurrentUser();
      if (!currentUser) return alert("Please login first.");

      const room = btn.dataset.room;
      if (!room) return;

      // AI room
      if (room === "ai") {
        activeChat = { type: "ai", roomId: "ai" };
        setActiveButton(btn);
        unsubscribeAllMain();
        if (listEl) listEl.innerHTML = "";
        setHeader(nameEl, descEl, "ChatGPT 5", "Coming soon…");
        if (listEl && emptyEl) setEmptyState(emptyEl, listEl, true);
        setInputEnabled(formEl, inputEl, false);
        return;
      }

      // supervisors room access
      if (room === "supervisors" && currentUser.role !== "supervisor") {
        alert("Supervisor only room.");
        return;
      }

      const title =
        room === "general" ? "General chat" : room === "supervisors" ? "Supervisors" : "Room";
      const desc =
        room === "general"
          ? "All agents & supervisors • Be respectful • No customer data."
          : "Supervisor-only space for internal notes and coordination.";

      activeChat = { type: "room", roomId: room };

      setActiveButton(btn);
      setHeader(nameEl, descEl, title, desc);
      if (listEl && emptyEl) setEmptyState(emptyEl, listEl, false);
      setInputEnabled(formEl, inputEl, true);

      subscribeMainToRoom(room, listEl, nameEl, descEl);
    });
  });

  // DMs
  document.querySelectorAll(".chat-dm").forEach((btn) => {
    btn.addEventListener("click", () => {
      setCurrentUser();
      if (!currentUser) return alert("Please login first.");

      const otherId = btn.dataset.dm;
      if (!otherId) return;

      const roomId = dmRoomId(currentUser.id, otherId);

      const titleEl = btn.querySelector(".chat-room-title");
      const otherName = titleEl ? titleEl.textContent.trim() : `User ${otherId}`;

      activeChat = { type: "dm", roomId, otherId };

      setActiveButton(btn);
      setHeader(nameEl, descEl, otherName, `Direct message • CCMS ${otherId}`);
      if (listEl && emptyEl) setEmptyState(emptyEl, listEl, false);
      setInputEnabled(formEl, inputEl, true);

      // ❌ IMPORTANT: do NOT reorder on open
      // ✅ reorder only after sending message

      subscribeMainToRoom(roomId, listEl, nameEl, descEl);
    });
  });

  // Send message
  formEl?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = inputEl?.value?.trim();
    if (!text) return;

    setCurrentUser();
    if (!currentUser) return alert("Please login first.");
    if (!activeChat || activeChat.type === "ai") return;

    await addDoc(collection(db, MESSAGES_COL), {
      room: activeChat.roomId,
      text,
      userId: currentUser.id,
      name: currentUser.name,
      role: currentUser.role,
      ts: serverTimestamp(),
    });

    // ✅ DM reorder only after send
    if (activeChat.type === "dm") {
      bumpRecent(activeChat.otherId);
    }

    inputEl.value = "";
  });
});

// login/logout without refresh
window.addEventListener("telesyriana:user-changed", () => {
  setCurrentUser();

  subscribeStatusDots();
  applyDmOrder();

  const listEl = document.getElementById("chat-message-list");
  const emptyEl = document.getElementById("chat-empty");
  const roomNameEl = document.getElementById("chat-room-name");
  const roomDescEl = document.getElementById("chat-room-desc");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");

  if (!currentUser) {
    unsubscribeAllMain();
    clearActiveButtons();
    activeChat = null;
    if (listEl) listEl.innerHTML = "";
    setHeader(roomNameEl, roomDescEl, "Messages", "Start chatting…");
    if (listEl && emptyEl) setEmptyState(emptyEl, listEl, true);
    setInputEnabled(formEl, inputEl, false);
  }
});
