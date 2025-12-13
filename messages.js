// messages.js – TeleSyriana Firestore chat
// ✅ Limit + scroll up (if supported by firebase.js exports)
// ✅ Fallback mode if limit/getDocs not available (still renders last 50 + scroll up from cache)
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
} = fs;

// Optional (may be missing depending on your firebase.js)
const limitFn = fs.limit;
const startAfterFn = fs.startAfter;
const getDocsFn = fs.getDocs;

const USER_KEY = "telesyrianaUser";
const MESSAGES_COL = "globalMessages";
const AGENT_DAYS_COL = "agentDays";

const RECENTS_KEY_PREFIX = "telesyrianaChatRecents";

const PAGE_SIZE = 50;
const MAX_RENDER = 600;

let currentUser = null;
let activeChat = null;

let unsubscribeMain = null;
let unsubscribeStatus = null;

let roomCacheAsc = [];        // full cache ASC (old -> new) for fallback mode
let newestAsc = [];           // newest page ASC (old -> new) for limit mode
let olderAsc = [];            // loaded older pages ASC for limit mode
let oldestCursorDoc = null;   // cursor for loading older (limit mode)
let isLoadingOlder = false;
let noMoreOlder = false;

let renderedCount = 0;        // for fallback lazy render
let scrollBoundEl = null;

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
  const x = String(a);
  const y = String(b);
  return x < y ? `dm_${x}_${y}` : `dm_${y}_${x}`;
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

/* ---------------- Rendering ---------------- */

function getInitials(name = "") {
  const parts = String(name).trim().split(/\s+/).slice(0, 2);
  const initials = parts.map((p) => (p[0] || "").toUpperCase()).join("");
  return initials || "U";
}

function escapeHtml(str = "") {
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

function renderFresh(listEl, msgsAsc) {
  if (!listEl) return;

  const loader = ensureTopLoader(listEl);
  Array.from(listEl.children).forEach((ch) => {
    if (ch !== loader) ch.remove();
  });

  const frag = document.createDocumentFragment();
  (msgsAsc || []).forEach((m) => frag.appendChild(createMessageNode(m)));
  listEl.appendChild(frag);

  listEl.scrollTop = listEl.scrollHeight;
}

function renderChunkToTop(listEl, chunkAsc) {
  if (!listEl || !chunkAsc?.length) return;

  const loader = ensureTopLoader(listEl);

  const prevHeight = listEl.scrollHeight;
  const prevTop = listEl.scrollTop;

  const frag = document.createDocumentFragment();
  chunkAsc.forEach((m) => frag.appendChild(createMessageNode(m)));

  const afterLoader = loader.nextSibling;
  if (afterLoader) listEl.insertBefore(frag, afterLoader);
  else listEl.appendChild(frag);

  const newHeight = listEl.scrollHeight;
  listEl.scrollTop = prevTop + (newHeight - prevHeight);
}

/* ---------------- Subscriptions ---------------- */

function unsubscribeAllMain() {
  unsubscribeMain?.();
  unsubscribeMain = null;

  roomCacheAsc = [];
  newestAsc = [];
  olderAsc = [];
  oldestCursorDoc = null;

  renderedCount = 0;
  isLoadingOlder = false;
  noMoreOlder = false;
  scrollBoundEl = null;
}

function attachScrollLoaderFallback(listEl) {
  if (!listEl) return;
  if (scrollBoundEl === listEl) return;
  scrollBoundEl = listEl;

  const loader = ensureTopLoader(listEl);

  listEl.addEventListener("scroll", () => {
    if (listEl.scrollTop > 40) return;
    if (renderedCount >= Math.min(MAX_RENDER, roomCacheAsc.length)) return;

    loader.style.display = "block";

    const total = roomCacheAsc.length;
    const alreadyRenderedStartIndex = Math.max(0, total - renderedCount);
    if (alreadyRenderedStartIndex <= 0) {
      loader.style.display = "none";
      return;
    }

    const addCount = Math.min(PAGE_SIZE, alreadyRenderedStartIndex);
    const newStart = alreadyRenderedStartIndex - addCount;

    const chunk = roomCacheAsc.slice(newStart, alreadyRenderedStartIndex);
    renderedCount += chunk.length;

    renderChunkToTop(listEl, chunk);

    setTimeout(() => (loader.style.display = "none"), 120);
  });
}

function attachScrollLoaderLimitMode(listEl, roomId) {
  if (!listEl) return;
  if (scrollBoundEl === listEl) return;
  scrollBoundEl = listEl;

  const loader = ensureTopLoader(listEl);

  listEl.addEventListener("scroll", async () => {
    if (listEl.scrollTop > 40) return;
    if (isLoadingOlder || noMoreOlder) return;
    if (!oldestCursorDoc) return;

    // If firebase.js doesn't support getDocs/startAfter, stop here
    if (!getDocsFn || !startAfterFn || !limitFn) return;

    isLoadingOlder = true;
    loader.style.display = "block";

    try {
      const qOlder = query(
        collection(db, MESSAGES_COL),
        where("room", "==", roomId),
        orderBy("ts", "desc"),
        startAfterFn(oldestCursorDoc),
        limitFn(PAGE_SIZE)
      );

      const snap = await getDocsFn(qOlder);

      if (snap.empty) {
        noMoreOlder = true;
        loader.textContent = "No more messages";
        setTimeout(() => {
          loader.style.display = "none";
          loader.textContent = "Loading older messages…";
        }, 700);
        return;
      }

      const olderDesc = [];
      snap.forEach((d) => olderDesc.push({ id: d.id, ...d.data() }));

      oldestCursorDoc = snap.docs[snap.docs.length - 1] || oldestCursorDoc;

      const chunkAsc = olderDesc.slice().reverse();
      olderAsc = [...chunkAsc, ...olderAsc];

      // cap
      const combined = [...olderAsc, ...newestAsc];
      if (combined.length > MAX_RENDER) {
        const extra = combined.length - MAX_RENDER;
        olderAsc = olderAsc.slice(extra);
      }

      renderChunkToTop(listEl, chunkAsc);
    } catch (e) {
      console.error("Older load error:", e);
      alert("Error loading older messages: " + (e?.message || e));
    } finally {
      isLoadingOlder = false;
      loader.style.display = "none";
    }
  });
}

function subscribeMainToRoom(roomId, listEl) {
  if (!listEl || !roomId) return;
  unsubscribeAllMain();

  // ✅ LIMIT MODE (if supported)
  const canLimit = !!limitFn;

  if (canLimit) {
    const qNewest = query(
      collection(db, MESSAGES_COL),
      where("room", "==", roomId),
      orderBy("ts", "desc"),
      limitFn(PAGE_SIZE)
    );

    unsubscribeMain = onSnapshot(
      qNewest,
      (snap) => {
        setCurrentUser();

        const newestDesc = [];
        snap.forEach((d) => newestDesc.push({ id: d.id, ...d.data() }));

        newestAsc = newestDesc.slice().reverse();
        oldestCursorDoc = snap.docs[snap.docs.length - 1] || null;

        // Do not destroy already loaded olderAsc; keep it
        const combined = [...olderAsc, ...newestAsc];
        const capped = combined.length > MAX_RENDER ? combined.slice(combined.length - MAX_RENDER) : combined;

        renderFresh(listEl, capped);
        attachScrollLoaderLimitMode(listEl, roomId);
      },
      (err) => {
        console.error("Snapshot error:", err);
        alert("Firestore error: " + err.message);
      }
    );

    return;
  }

  // ✅ FALLBACK MODE (no limit available): listen all but render last PAGE_SIZE only
  const qAll = query(
    collection(db, MESSAGES_COL),
    where("room", "==", roomId),
    orderBy("ts", "desc")
  );

  unsubscribeMain = onSnapshot(
    qAll,
    (snap) => {
      setCurrentUser();

      const allDesc = [];
      snap.forEach((d) => allDesc.push({ id: d.id, ...d.data() }));
      roomCacheAsc = allDesc.slice().reverse(); // ASC

      renderedCount = Math.min(PAGE_SIZE, roomCacheAsc.length);
      const start = Math.max(0, roomCacheAsc.length - renderedCount);
      const initial = roomCacheAsc.slice(start);

      renderFresh(listEl, initial);
      attachScrollLoaderFallback(listEl);
    },
    (err) => {
      console.error("Snapshot error:", err);
      alert("Firestore error: " + err.message);
    }
  );
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
  localStorage.setItem(key, JSON.stringify(map || {}));
}

function bumpRecent(otherId) {
  if (!currentUser?.id || !otherId) return;
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
    // reset
    document.querySelectorAll("[data-status-dot]").forEach((dot) => {
      dot.classList.remove("dot-online", "dot-warn", "dot-offline");
      dot.classList.add("dot-offline");
    });

    snap.forEach((docu) => {
      const d = docu.data();
      const uid = String(d.userId || "");
      if (!uid) return;

      const dot = document.querySelector(`[data-status-dot="${uid}"]`);
      if (!dot) return;

      const cls = statusToDotClass(d.status || "unavailable");
      dot.classList.remove("dot-online", "dot-warn", "dot-offline");
      dot.classList.add(cls);

      const sub = document.querySelector(`[data-sub="${uid}"]`);
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
    document.querySelectorAll(".chat-room, .chat-dm").forEach((btn) => {
      const titleEl = btn.querySelector(".chat-room-title");
      const subEl = btn.querySelector(".chat-room-sub");
      const title = (titleEl?.textContent || btn.textContent || "").toLowerCase();
      const sub = (subEl?.textContent || "").toLowerCase();
      const hit = !q || title.includes(q) || sub.includes(q);
      btn.style.display = hit ? "" : "none";
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

  // default
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

      subscribeMainToRoom(room, listEl);
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

      // ✅ reorder only after sending (not on open)
      subscribeMainToRoom(roomId, listEl);
    });
  });

  // Send
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

    if (activeChat.type === "dm") bumpRecent(activeChat.otherId);

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
