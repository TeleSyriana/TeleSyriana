// messages.js – Firestore chat (NO limit()) + lazy render on scroll up + Rooms + DMs + status dots
// ✅ + Recents UI (DM only) + Search filter + Glass sidebar support
import { db, fs } from "./firebase.js";

const { collection, addDoc, query, where, orderBy, onSnapshot, serverTimestamp } = fs;

const USER_KEY = "telesyrianaUser";
const MESSAGES_COL = "globalMessages";
const AGENT_DAYS_COL = "agentDays"; // status source (today docs)

// ✅ recents storage (per user)
const RECENTS_KEY_PREFIX = "telesyrianaChatRecents"; // `${prefix}:${userId}`
// structure: { [otherId]: lastTsNumber }

let currentUser = null;

// نوع المحادثة الحالية:
let activeChat = null; // { type: "room"|"dm"|"ai", roomId, title, desc }

let unsubscribeMain = null;
let unsubscribeFloat = null;
let unsubscribeStatus = null;

// "بديل limit": نعرض فقط آخر N بالواجهة
const PAGE_SIZE = 50;
const MAX_RENDER = 600;

// cache للغرفة الحالية (ASC: القديم -> الجديد)
let roomCache = [];
let renderedCount = 0;

// لمنع تكرار ربط السكرول على نفس list
let scrollBoundEl = null;

// refs for sidebar lists
let dmListEl = null;
let roomListEl = null;

// ✅ recent UI refs
let recentListEl = null;
let recentEmptyEl = null;

// ----------------------------- helpers -----------------------------

function getUserFromStorage() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    if (u?.id && u?.name && u?.role) return u;
  } catch {}
  return null;
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

function getInitials(name = "") {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "U";
}

function createMessageNode(m, showRole) {
  const wrapper = document.createElement("div");
  wrapper.className = "chat-message";
  if (currentUser && m.userId === currentUser.id) wrapper.classList.add("me");

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = getInitials(m.name || "User");

  const body = document.createElement("div");
  body.className = "msg-body";

  const meta = document.createElement("div");
  meta.className = "msg-meta";

  const nameEl = document.createElement("span");
  nameEl.className = "msg-name";
  nameEl.textContent = showRole ? `${m.name} (${m.role})` : (m.name || "User");

  const timeEl = document.createElement("span");
  timeEl.textContent = `• ${formatTime(m.ts)}`;

  meta.appendChild(nameEl);
  meta.appendChild(timeEl);

  const text = document.createElement("div");
  text.className = "chat-message-text";
  text.textContent = m.text || "";

  body.appendChild(meta);
  body.appendChild(text);

  wrapper.appendChild(avatar);
  wrapper.appendChild(body);

  return wrapper;
}

function renderFresh(listEl, msgs, showRole) {
  const loader = ensureTopLoader(listEl);

  Array.from(listEl.children).forEach((ch) => {
    if (ch !== loader) ch.remove();
  });

  const frag = document.createDocumentFragment();
  msgs.forEach((m) => frag.appendChild(createMessageNode(m, showRole)));
  listEl.appendChild(frag);

  listEl.scrollTop = listEl.scrollHeight;
}

function renderChunkToTop(listEl, items, showRole) {
  const loader = ensureTopLoader(listEl);

  const prevScrollHeight = listEl.scrollHeight;
  const prevScrollTop = listEl.scrollTop;

  const frag = document.createDocumentFragment();
  items.forEach((m) => frag.appendChild(createMessageNode(m, showRole)));

  const afterLoader = loader.nextSibling;
  if (afterLoader) listEl.insertBefore(frag, afterLoader);
  else listEl.appendChild(frag);

  const newScrollHeight = listEl.scrollHeight;
  listEl.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
}

function setHeader(roomNameEl, roomDescEl, title, desc) {
  if (roomNameEl) roomNameEl.textContent = title || "Messages";
  if (roomDescEl) roomDescEl.textContent = desc || "Start chatting…";
}

function setEmptyState(emptyEl, listEl, on) {
  if (!emptyEl || !listEl) return;
  emptyEl.style.display = on ? "block" : "none";
  listEl.style.display = on ? "none" : "block";
}

function setInputEnabled(formEl, inputEl, enabled) {
  if (!formEl || !inputEl) return;
  const btn = formEl.querySelector("button[type='submit']");
  inputEl.disabled = !enabled;
  if (btn) btn.disabled = !enabled;
}

// ----------------------- scroll lazy load -----------------------

function attachScrollLoader(listEl) {
  if (!listEl) return;

  if (scrollBoundEl === listEl) return;
  scrollBoundEl = listEl;

  const loader = ensureTopLoader(listEl);

  listEl.addEventListener("scroll", () => {
    if (listEl.scrollTop > 40) return;

    const total = roomCache.length;
    const alreadyRenderedStartIndex = Math.max(0, total - renderedCount);

    if (alreadyRenderedStartIndex <= 0) return;
    if (renderedCount >= MAX_RENDER) return;

    loader.style.display = "block";

    const addCount = Math.min(PAGE_SIZE, alreadyRenderedStartIndex);
    const newStart = alreadyRenderedStartIndex - addCount;
    const chunk = roomCache.slice(newStart, alreadyRenderedStartIndex);

    renderedCount += chunk.length;
    renderChunkToTop(listEl, chunk, true);

    setTimeout(() => (loader.style.display = "none"), 150);
  });
}

// ----------------------- Firestore subscriptions -----------------------

function unsubscribeAllMain() {
  unsubscribeMain?.();
  unsubscribeMain = null;
  roomCache = [];
  renderedCount = 0;
  scrollBoundEl = null;
}

function subscribeMainToRoom(roomId, listEl) {
  if (!listEl) return;
  unsubscribeAllMain();

  const qRoom = query(
    collection(db, MESSAGES_COL),
    where("room", "==", roomId),
    orderBy("ts", "desc")
  );

  unsubscribeMain = onSnapshot(
    qRoom,
    (snapshot) => {
      setCurrentUser();

      const all = [];
      snapshot.forEach((d) => all.push({ id: d.id, ...d.data() }));

      all.reverse(); // ASC
      roomCache = all;

      renderedCount = Math.min(PAGE_SIZE, roomCache.length);
      const startIndex = Math.max(0, roomCache.length - renderedCount);
      const initial = roomCache.slice(startIndex);

      renderFresh(listEl, initial, true);
      attachScrollLoader(listEl);

      // ✅ DM: update RECENT only if there is a NEWER message than saved
      if (activeChat?.type === "dm" && activeChat?.roomId === roomId && roomCache.length) {
        const last = roomCache[roomCache.length - 1];
        const otherId = getOtherIdFromDmRoom(roomId, currentUser?.id);
        if (otherId) bumpRecentIfNewer(otherId, last?.ts);
      }
    },
    (err) => {
      console.error("Main snapshot error:", err);
      alert("Firestore error: " + err.message);
    }
  );
}

function subscribeFloatToGeneral(floatList) {
  if (!floatList) return;
  unsubscribeFloat?.();

  const qGeneral = query(
    collection(db, MESSAGES_COL),
    where("room", "==", "general"),
    orderBy("ts", "desc")
  );

  unsubscribeFloat = onSnapshot(qGeneral, (snapshot) => {
    setCurrentUser();
    const all = [];
    snapshot.forEach((d) => all.push({ id: d.id, ...d.data() }));
    all.reverse();

    const last = all.slice(Math.max(0, all.length - 30));
    floatList.innerHTML = "";
    const frag = document.createDocumentFragment();
    last.forEach((m) => frag.appendChild(createMessageNode(m, false)));
    floatList.appendChild(frag);
    floatList.scrollTop = floatList.scrollHeight;
  });
}

// ----------------------- Status dots (sidebar) -----------------------

function subscribeStatusDots() {
  unsubscribeStatus?.();
  unsubscribeStatus = null;

  const q = query(
    collection(db, AGENT_DAYS_COL),
    where("day", "==", getTodayKey())
  );

  unsubscribeStatus = onSnapshot(q, (snap) => {
    const dots = document.querySelectorAll("[data-status-dot]");
    dots.forEach((d) => {
      d.classList.remove("dot-online", "dot-warn", "dot-offline");
      d.classList.add("dot-offline");
    });

    snap.forEach((docu) => {
      const d = docu.data();
      const userId = String(d.userId || "");
      if (!userId) return;
      const dot = document.querySelector(`[data-status-dot="${userId}"]`);
      if (!dot) return;

      const cls = statusToDotClass(d.status || "unavailable");
      dot.classList.remove("dot-online", "dot-warn", "dot-offline");
      dot.classList.add(cls);

      const sub = document.querySelector(`[data-sub="${userId}"]`);
      if (sub) sub.textContent = d.status ? d.status.replaceAll("_", " ") : "unavailable";
    });
  });
}

// ----------------------- Active selection UI -----------------------

function clearActiveButtons() {
  document.querySelectorAll(".chat-room, .chat-dm").forEach((b) => {
    b.classList.remove("active");
    b.classList.remove("chat-item-active");
  });
}

function setActiveButton(el) {
  clearActiveButtons();
  if (el) {
    el.classList.add("active");
    el.classList.add("chat-item-active");
  }
}

// ----------------------- ✅ Recents (DM only) -----------------------

function recentsKey() {
  if (!currentUser?.id) return null;
  return `${RECENTS_KEY_PREFIX}:${currentUser.id}`;
}

function loadRecentsMap() {
  const key = recentsKey();
  if (!key) return {};
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveRecentsMap(map) {
  const key = recentsKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(map || {}));
  } catch {}
}

function tsToNumber(ts) {
  if (!ts) return Date.now();
  if (typeof ts === "number") return ts;
  if (ts.toMillis) return ts.toMillis();
  if (ts.toDate) return ts.toDate().getTime();
  return Date.now();
}

function getOtherIdFromDmRoom(roomId, myId) {
  if (!roomId || !myId) return null;
  // dm_1001_2002
  const parts = String(roomId).split("_");
  if (parts.length !== 3) return null;
  const a = parts[1];
  const b = parts[2];
  return String(myId) === a ? b : a;
}

// ✅ update saved ts ONLY if newer (prevents "open chat" from changing recents)
function bumpRecentIfNewer(otherId, ts) {
  if (!currentUser?.id || !otherId) return;
  const map = loadRecentsMap();
  const newT = tsToNumber(ts);
  const oldT = Number(map[String(otherId)] || 0);
  if (newT <= oldT) return; // no change
  bumpRecent(otherId, newT);
}

// ✅ bumpRecent: called only on SEND DM or NEW incoming DM
function bumpRecent(otherId, ts) {
  if (!currentUser?.id) return;
  const map = loadRecentsMap();
  map[String(otherId)] = tsToNumber(ts);
  saveRecentsMap(map);

  // (Optional) if you still want DM list reorder, keep this:
  applyDmOrderFromRecents();

  // ✅ refresh RECENT UI
  renderRecentsList();
}

// OPTIONAL: DM reorder (you already had it)
function applyDmOrderFromRecents() {
  if (!dmListEl) dmListEl = document.getElementById("dm-list");
  if (!dmListEl) return;

  const map = loadRecentsMap();
  const buttons = Array.from(dmListEl.querySelectorAll(".chat-dm"));

  buttons.sort((a, b) => {
    const ida = String(a.dataset.dm || "");
    const idb = String(b.dataset.dm || "");
    const ta = map[ida] || 0;
    const tb = map[idb] || 0;
    if (tb !== ta) return tb - ta; // newer first
    return ida.localeCompare(idb);
  });

  buttons.forEach((btn) => dmListEl.appendChild(btn));
}

// ✅ RECENT UI renderer
function renderRecentsList() {
  setCurrentUser();

  if (!recentListEl) recentListEl = document.getElementById("recent-list");
  if (!recentEmptyEl) recentEmptyEl = document.getElementById("recent-empty");
  if (!recentListEl || !recentEmptyEl) return;

  const map = loadRecentsMap();
  const entries = Object.entries(map || {})
    .map(([id, t]) => ({ id: String(id), t: Number(t) || 0 }))
    .sort((a, b) => b.t - a.t);

  // clear old recent buttons (keep the empty div)
  Array.from(recentListEl.children).forEach((ch) => {
    if (ch.id !== "recent-empty") ch.remove();
  });

  if (!entries.length) {
    recentEmptyEl.style.display = "block";
    return;
  }
  recentEmptyEl.style.display = "block"; // will hide after append? no, fix:
  recentEmptyEl.style.display = "none";

  // show up to 6
  entries.slice(0, 6).forEach(({ id }) => {
    const orig = document.querySelector(`.chat-dm[data-dm="${id}"]`);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-dm";
    btn.dataset.dm = id;

    if (orig) btn.innerHTML = orig.innerHTML;
    else btn.textContent = `CCMS ${id}`;

    btn.addEventListener("click", () => {
      const target = document.querySelector(`.chat-dm[data-dm="${id}"]`);
      target?.click();
    });

    recentListEl.appendChild(btn);
  });
}

// ----------------------- ✅ Search filter -----------------------

function hookSearch() {
  const input = document.getElementById("chat-search");
  // ✅ FIX: in your HTML the button id is "chat-search-clear"
  const clearBtn = document.getElementById("chat-search-clear");

  if (!input) return;

  const run = () => {
    const q = input.value.trim().toLowerCase();

    const items = document.querySelectorAll(".chat-room, .chat-dm");
    items.forEach((btn) => {
      const titleEl = btn.querySelector(".chat-room-title");
      const subEl = btn.querySelector(".chat-room-sub");
      const title = (titleEl?.textContent || "").toLowerCase();
      const sub = (subEl?.textContent || "").toLowerCase();
      const hit = !q || title.includes(q) || sub.includes(q);
      btn.style.display = hit ? "" : "none";
    });
  };

  input.addEventListener("input", run);

  clearBtn?.addEventListener("click", () => {
    input.value = "";
    input.focus();
    run();
  });

  run();
}

// ----------------------------- init -----------------------------

document.addEventListener("DOMContentLoaded", () => {
  const hasMainChat = !!document.getElementById("chat-message-list");

  const roomButtons = document.querySelectorAll(".chat-room");
  const dmButtons = document.querySelectorAll(".chat-dm");

  // (not critical) rooms list id in HTML is "rooms-list"
  roomListEl = document.getElementById("rooms-list");
  dmListEl = document.getElementById("dm-list");

  const roomNameEl = document.getElementById("chat-room-name");
  const roomDescEl = document.getElementById("chat-room-desc");
  const emptyEl = document.getElementById("chat-empty");
  const listEl = document.getElementById("chat-message-list");

  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");

  const floatToggle = document.getElementById("float-chat-toggle");
  const floatPanel = document.getElementById("float-chat-panel");
  const floatClose = document.getElementById("float-chat-close");
  const floatList = document.getElementById("float-chat-messages");
  const floatForm = document.getElementById("float-chat-form");
  const floatInput = document.getElementById("float-chat-input");

  setCurrentUser();

  // styles
  if (listEl) {
    listEl.style.overflowY = "auto";
    listEl.style.maxHeight = "60vh";
  }
  if (floatList) {
    floatList.style.overflowY = "auto";
    floatList.style.maxHeight = "220px";
  }

  // ✅ search
  hookSearch();

  // ✅ apply recents order on load
  applyDmOrderFromRecents();

  // ✅ render recent list on load
  renderRecentsList();

  // ---------- Floating ----------
  floatToggle?.addEventListener("click", () => floatPanel?.classList.toggle("hidden"));
  floatClose?.addEventListener("click", () => floatPanel?.classList.add("hidden"));

  floatForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = floatInput?.value?.trim();
    if (!text) return;

    setCurrentUser();
    if (!currentUser) return alert("Please login first.");

    await addDoc(collection(db, MESSAGES_COL), {
      room: "general",
      text,
      userId: currentUser.id,
      name: currentUser.name,
      role: currentUser.role,
      ts: serverTimestamp(),
    });

    floatInput.value = "";
  });

  subscribeFloatToGeneral(floatList);

  // ---------- Main Messages page logic ----------
  if (hasMainChat && listEl) {
    activeChat = null;
    setHeader(roomNameEl, roomDescEl, "Messages", "Start chatting…");
    setEmptyState(emptyEl, listEl, true);
    setInputEnabled(formEl, inputEl, false);

    // Rooms
    roomButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        setCurrentUser();
        if (!currentUser) return alert("Please login first.");

        const room = btn.dataset.room;

        if (room === "ai") {
          activeChat = { type: "ai", roomId: "ai", title: "ChatGPT 5", desc: "Coming soon…" };
          setActiveButton(btn);
          unsubscribeAllMain();
          listEl.innerHTML = "";
          setHeader(roomNameEl, roomDescEl, "ChatGPT 5", "Coming soon…");
          setEmptyState(emptyEl, listEl, true);
          setInputEnabled(formEl, inputEl, false);
          return;
        }

        if (room === "supervisors" && currentUser.role !== "supervisor") {
          alert("Supervisor only room.");
          return;
        }

        activeChat = {
          type: "room",
          roomId: room,
          title: room === "general" ? "General chat" : "Supervisors",
          desc:
            room === "general"
              ? "All agents & supervisors • Be respectful • No customer data."
              : "Supervisor-only space for internal notes and coordination.",
        };

        setActiveButton(btn);
        setHeader(roomNameEl, roomDescEl, activeChat.title, activeChat.desc);
        setEmptyState(emptyEl, listEl, false);
        setInputEnabled(formEl, inputEl, true);

        subscribeMainToRoom(activeChat.roomId, listEl);
      });
    });

    // DMs
    dmButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        setCurrentUser();
        if (!currentUser) return alert("Please login first.");

        const otherId = btn.dataset.dm;
        if (!otherId) return;

        const roomId = dmRoomId(currentUser.id, otherId);

        const nameEl = btn.querySelector(".chat-room-title");
        const otherName = nameEl ? nameEl.textContent.trim() : `User ${otherId}`;

        activeChat = {
          type: "dm",
          roomId,
          title: otherName,
          desc: `Direct message • CCMS ${otherId}`,
        };

        setActiveButton(btn);
        setHeader(roomNameEl, roomDescEl, activeChat.title, activeChat.desc);
        setEmptyState(emptyEl, listEl, false);
        setInputEnabled(formEl, inputEl, true);

        // ❌ IMPORTANT: NO bump on open (as you requested)
        // bumpRecent(otherId, Date.now());

        subscribeMainToRoom(activeChat.roomId, listEl);
      });
    });

    // Send (main)
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

      // ✅ bump on send if DM (THIS is the only “after click” path)
      if (activeChat.type === "dm") {
        const otherId = getOtherIdFromDmRoom(activeChat.roomId, currentUser.id);
        if (otherId) bumpRecent(otherId, Date.now());
      }

      inputEl.value = "";
    });

    // Status dots
    subscribeStatusDots();
  }
});

// login/logout without refresh
window.addEventListener("telesyriana:user-changed", () => {
  setCurrentUser();

  subscribeStatusDots();
  applyDmOrderFromRecents();
  renderRecentsList();

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
    setEmptyState(emptyEl, listEl, true);
    setInputEnabled(formEl, inputEl, false);
  }
});
