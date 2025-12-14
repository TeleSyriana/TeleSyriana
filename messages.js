// messages.js – Firestore chat (NO limit()) + lazy render on scroll up + Rooms + DMs + status dots
// ✅ Recents (CLOUD, AFTER SEND ONLY) + Search by name/room/CCMS + Glass sidebar support
// ✅ Groups (CLOUD) + Groups open via events (telesyriana:open-group / telesyriana:open-room)
// ✅ Unread counters (true count + 99+) on each chat item + nav Messages badge
// ✅ Beep sound on new incoming messages (Sounds/Beep.mp3)
// ✅ NO alert() on firestore snapshot errors (console only)

import { db, fs } from "./firebase.js";

const {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  doc,
  setDoc,
} = fs;

const USER_KEY = "telesyrianaUser";

const MESSAGES_COL = "globalMessages";
const AGENT_DAYS_COL = "agentDays";
const GROUPS_COL = "groups";

// Cloud recents:
// userRecents/{userId}/items/{recentId}
const RECENTS_ROOT = "userRecents";

const PAGE_SIZE = 50;
const MAX_RENDER = 600;

let currentUser = null;
let activeChat = null;

let unsubscribeMain = null;
let unsubscribeFloat = null;
let unsubscribeStatus = null;
let unsubscribeGroups = null;
let unsubscribeRecents = null;

let roomCache = []; // ASC
let renderedCount = 0;
let scrollBoundEl = null;

// sidebar refs
let dmListEl = null;
let recentListEl = null;
let groupsListEl = null;

// caches
let groupsCache = [];  // [{id, name, rules, members, createdAt}]
let recentsCache = []; // [{id, type, roomId, title, desc, lastTs, otherId?}]

// ---------------- ✅ Beep (Sounds/Beep.mp3) ----------------

const BEEP_SRC = "Sounds/Beep.mp3";
let beepAudio = null;

// per-room last beep guard (ms)
const lastBeepMsByRoom = new Map();

function initBeep() {
  try {
    if (!beepAudio) {
      beepAudio = new Audio(BEEP_SRC);
      beepAudio.preload = "auto";
      beepAudio.volume = 1;
    }
  } catch (e) {
    console.warn("Beep init failed:", e);
  }
}

function playBeepOnce(roomId, ms) {
  try {
    initBeep();
    if (!beepAudio) return;

    const key = String(roomId || "");
    const t = Number(ms || Date.now());
    const last = Number(lastBeepMsByRoom.get(key) || 0);
    if (t && t <= last) return;

    lastBeepMsByRoom.set(key, t);

    beepAudio.currentTime = 0;
    const p = beepAudio.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        // autoplay restrictions ممكن تمنع أول مرة قبل أي تفاعل
      });
    }
  } catch (e) {
    console.warn("Beep play failed:", e);
  }
}

// ---------------- ✅ Unread counters ----------------

const LAST_SEEN_PREFIX = "telesyrianaLastSeen:";
const unreadByRoom = new Map();     // roomId -> count
const lastMsgTsByRoom = new Map();  // roomId -> ms
const unreadUnsubs = new Map();     // roomId -> unsubscribe()
const roomButtons = new Map();      // roomId -> Set(buttons)

let navMessagesBtn = null;
let navMessagesBadge = null;

function lastSeenKey(roomId) {
  return `${LAST_SEEN_PREFIX}${String(roomId || "")}`;
}
function getLastSeen(roomId) {
  try {
    const raw = localStorage.getItem(lastSeenKey(roomId));
    const n = Number(raw || 0);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
function setLastSeen(roomId, ms) {
  try {
    const v = Number(ms || Date.now());
    localStorage.setItem(lastSeenKey(roomId), String(v));
  } catch {}
}

function formatBadgeNumber(n) {
  const x = Number(n || 0);
  if (x <= 0) return "0";
  return x >= 100 ? "99+" : String(x);
}

function ensureNavBadge() {
  const btn = document.querySelector(`.nav-link[data-page="messages"]`);
  if (!btn) return;

  navMessagesBtn = btn;

  if (!navMessagesBtn.id) navMessagesBtn.id = "nav-messages";
  if (navMessagesBtn.id !== "nav-messages") navMessagesBtn.id = "nav-messages";

  navMessagesBadge = document.getElementById("nav-messages-badge");
  if (!navMessagesBadge) {
    navMessagesBadge = document.createElement("span");
    navMessagesBadge.id = "nav-messages-badge";
    navMessagesBadge.className = "hidden";
    navMessagesBadge.textContent = "0";
    navMessagesBtn.appendChild(navMessagesBadge);
  }
}

function ensureUnreadBadge(btnEl) {
  if (!btnEl) return null;
  let b = btnEl.querySelector(":scope > .unread-badge");
  if (!b) {
    b = document.createElement("span");
    b.className = "unread-badge hidden";
    b.textContent = "0";
    btnEl.appendChild(b);
  }
  return b;
}

function setBadgeCountOnButton(btnEl, count) {
  const b = ensureUnreadBadge(btnEl);
  if (!b) return;

  const n = Number(count || 0);
  if (n > 0) {
    b.textContent = formatBadgeNumber(n);
    b.classList.remove("hidden");
  } else {
    b.classList.add("hidden");
  }
}

function updateNavBadge() {
  ensureNavBadge();
  if (!navMessagesBadge) return;

  let total = 0;
  unreadByRoom.forEach((v) => (total += Number(v || 0)));

  if (total > 0) {
    navMessagesBadge.textContent = formatBadgeNumber(total);
    navMessagesBadge.classList.remove("hidden");
  } else {
    navMessagesBadge.classList.add("hidden");
  }
}

function updateBadgesForRoom(roomId) {
  const key = String(roomId);
  const count = Number(unreadByRoom.get(key) || 0);

  const btns = roomButtons.get(key);
  if (btns && btns.size) {
    btns.forEach((btn) => setBadgeCountOnButton(btn, count));
  }

  updateNavBadge();
}

function registerRoomButton(roomId, btnEl) {
  if (!roomId || !btnEl) return;
  const key = String(roomId);

  ensureUnreadBadge(btnEl);

  if (!roomButtons.has(key)) roomButtons.set(key, new Set());
  roomButtons.get(key).add(btnEl);

  updateBadgesForRoom(key);
  ensureUnreadWatcher(key);
}

function restartUnreadWatcher(roomId) {
  const key = String(roomId);
  const u = unreadUnsubs.get(key);
  if (u) {
    try { u(); } catch {}
  }
  unreadUnsubs.delete(key);
  ensureUnreadWatcher(key);
}

function markRoomRead(roomId) {
  const key = String(roomId);
  const lastTs = Number(lastMsgTsByRoom.get(key) || Date.now());
  setLastSeen(key, lastTs);
  unreadByRoom.set(key, 0);
  updateBadgesForRoom(key);
  restartUnreadWatcher(key);
}

function ensureUnreadWatcher(roomId) {
  const key = String(roomId);
  if (!key) return;
  if (unreadUnsubs.has(key)) return;

  const seen = getLastSeen(key);
  const seenDate = new Date(seen || 0);

  const qUnread = query(
    collection(db, MESSAGES_COL),
    where("room", "==", key),
    where("ts", ">", seenDate),
    orderBy("ts", "asc")
  );

  const unsub = onSnapshot(
    qUnread,
    (snap) => {
      setCurrentUser();

      let cnt = 0;
      let latest = 0;

      // ✅ Beep only on newly added docs (not every render)
      const changes = snap.docChanges ? snap.docChanges() : [];
      changes.forEach((ch) => {
        if (ch.type !== "added") return;
        const data = ch.doc?.data?.() || {};
        const ms = tsToNumber(data.ts) || 0;
        const from = String(data.userId || "");
        const me = String(currentUser?.id || "");

        if (ms && ms > latest) latest = ms;

        // ✅ Beep only if user is NOT inside this chat
        if (activeChat?.roomId && String(activeChat.roomId) === key) return;

        // beep on incoming only
        if (from && me && from !== me) {
          playBeepOnce(key, ms || Date.now());
        }
      });

      // count all unread (excluding my own)
      snap.forEach((d) => {
        const data = d.data() || {};
        const ms = tsToNumber(data.ts) || 0;
        if (ms > latest) latest = ms;

        const from = String(data.userId || "");
        const me = String(currentUser?.id || "");
        if (from && me && from === me) return;

        cnt += 1;
      });

      if (latest) lastMsgTsByRoom.set(key, latest);

      // if currently open => auto read
      if (activeChat?.roomId && String(activeChat.roomId) === key) {
        if (latest) setLastSeen(key, latest);
        unreadByRoom.set(key, 0);
        updateBadgesForRoom(key);

        if (latest) restartUnreadWatcher(key);
        return;
      }

      unreadByRoom.set(key, cnt);
      updateBadgesForRoom(key);
    },
    (err) => console.error("Unread watcher error:", err)
  );

  unreadUnsubs.set(key, unsub);
}

function stopAllUnreadWatchers() {
  unreadUnsubs.forEach((u) => {
    try { u?.(); } catch {}
  });
  unreadUnsubs.clear();
  unreadByRoom.clear();
  lastMsgTsByRoom.clear();
  roomButtons.clear();
  updateNavBadge();
}

// ---------------- helpers ----------------

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

function dmRoomId(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? `dm_${x}_${y}` : `dm_${y}_${x}`;
}
function getOtherIdFromDmRoom(roomId, myId) {
  const parts = String(roomId || "").split("_"); // dm_1001_2002
  if (parts.length !== 3) return null;
  const a = parts[1], b = parts[2];
  return String(myId) === a ? b : a;
}

function tsToNumber(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (ts.toMillis) return ts.toMillis();
  if (ts.toDate) return ts.toDate().getTime();
  return 0;
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

function statusToDotClass(status) {
  if (status === "in_operation" || status === "handling") return "dot-online";
  if (status === "meeting" || status === "break") return "dot-warn";
  return "dot-offline";
}

function getInitials(name = "") {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "U";
}

function ensureTopLoader(listEl) {
  if (!listEl) return null;
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
  const prevH = listEl.scrollHeight;
  const prevTop = listEl.scrollTop;

  const frag = document.createDocumentFragment();
  items.forEach((m) => frag.appendChild(createMessageNode(m, showRole)));

  const afterLoader = loader?.nextSibling;
  if (afterLoader) listEl.insertBefore(frag, afterLoader);
  else listEl.appendChild(frag);

  const newH = listEl.scrollHeight;
  listEl.scrollTop = prevTop + (newH - prevH);
}

function setHeader(title, desc) {
  const roomNameEl = document.getElementById("chat-room-name");
  const roomDescEl = document.getElementById("chat-room-desc");
  if (roomNameEl) roomNameEl.textContent = title || "Messages";
  if (roomDescEl) roomDescEl.textContent = desc || "Start chatting…";
}

function setEmpty(on) {
  const emptyEl = document.getElementById("chat-empty");
  const listEl = document.getElementById("chat-message-list");
  if (!emptyEl || !listEl) return;
  emptyEl.style.display = on ? "block" : "none";
  listEl.style.display = on ? "none" : "block";
}

function setInputEnabled(enabled) {
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");
  if (!formEl || !inputEl) return;
  const btn = formEl.querySelector("button[type='submit']");
  inputEl.disabled = !enabled;
  if (btn) btn.disabled = !enabled;
}

function clearActiveButtons() {
  document
    .querySelectorAll(".chat-room, .chat-dm, .chat-recent, .chat-group")
    .forEach((b) => b.classList.remove("active", "chat-item-active"));
}
function setActiveButton(el) {
  clearActiveButtons();
  if (el) el.classList.add("active", "chat-item-active");
}

// ---------------- lazy scroll ----------------

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

    if (loader) loader.style.display = "block";

    const addCount = Math.min(PAGE_SIZE, alreadyRenderedStartIndex);
    const newStart = alreadyRenderedStartIndex - addCount;
    const chunk = roomCache.slice(newStart, alreadyRenderedStartIndex);

    renderedCount += chunk.length;
    renderChunkToTop(listEl, chunk, true);

    setTimeout(() => {
      if (loader) loader.style.display = "none";
    }, 150);
  });
}

// ---------------- Firestore main chat ----------------

function unsubscribeAllMain() {
  unsubscribeMain?.();
  unsubscribeMain = null;
  roomCache = [];
  renderedCount = 0;
  scrollBoundEl = null;
}

function subscribeMainToRoom(roomId) {
  const listEl = document.getElementById("chat-message-list");
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
      renderFresh(listEl, roomCache.slice(startIndex), true);
      attachScrollLoader(listEl);

      const last = roomCache.length ? roomCache[roomCache.length - 1] : null;
      const lastTs = last ? tsToNumber(last.ts) : 0;
      if (activeChat?.roomId && String(activeChat.roomId) === String(roomId) && lastTs) {
        lastMsgTsByRoom.set(String(roomId), lastTs);
        setLastSeen(String(roomId), lastTs);
        unreadByRoom.set(String(roomId), 0);
        updateBadgesForRoom(String(roomId));
        restartUnreadWatcher(String(roomId));
      }
    },
    (err) => {
      console.error("Main snapshot error:", err);
    }
  );
}

// ---------------- Status dots ----------------

function subscribeStatusDots() {
  unsubscribeStatus?.();
  unsubscribeStatus = null;

  const qS = query(collection(db, AGENT_DAYS_COL), where("day", "==", getTodayKey()));

  unsubscribeStatus = onSnapshot(
    qS,
    (snap) => {
      document.querySelectorAll("[data-status-dot]").forEach((d) => {
        d.classList.remove("dot-online", "dot-warn", "dot-offline");
        d.classList.add("dot-offline");
      });

      snap.forEach((docu) => {
        const d = docu.data() || {};
        const userId = String(d.userId || "");
        if (!userId) return;

        const dot = document.querySelector(`[data-status-dot="${userId}"]`);
        if (!dot) return;

        const cls = statusToDotClass(d.status || "unavailable");
        dot.classList.remove("dot-online", "dot-warn", "dot-offline");
        dot.classList.add(cls);

        const sub = document.querySelector(`[data-sub="${userId}"]`);
        if (sub) sub.textContent = d.status ? String(d.status).replaceAll("_", " ") : "unavailable";
      });
    },
    (err) => console.error("Status snapshot error:", err)
  );
}

// ---------------- ✅ Cloud Groups sidebar (NO orderBy to avoid index) ----------------

function unsubscribeGroupsCloud() {
  unsubscribeGroups?.();
  unsubscribeGroups = null;
  groupsCache = [];
}

function renderGroupsList() {
  if (!groupsListEl) groupsListEl = document.getElementById("groups-list");
  if (!groupsListEl) return;

  groupsListEl.innerHTML = "";

  if (!groupsCache.length) {
    groupsListEl.innerHTML = `<div class="ms-empty" id="groups-empty">No groups yet</div>`;
    return;
  }

  const frag = document.createDocumentFragment();

  groupsCache.forEach((g) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-room chat-group";
    btn.dataset.groupId = g.id;

    const avatarLetter = String(g.name || "G").trim().slice(0, 1).toUpperCase();
    const membersCount = Array.isArray(g.members) ? g.members.length : 0;

    btn.innerHTML = `
      <div class="chat-row">
        <div class="chat-avatar role-room">${avatarLetter}</div>
        <div class="chat-row-text">
          <div class="chat-room-title">${g.name || "Group"}</div>
          <div class="chat-room-sub">${membersCount} members</div>
        </div>
      </div>
    `;

    btn.addEventListener("click", () => {
      openChat(
        { type: "group", roomId: g.id, title: g.name, desc: g.rules ? `Rules: ${g.rules}` : "Group chat" },
        btn
      );
    });

    registerRoomButton(String(g.id), btn);
    frag.appendChild(btn);
  });

  groupsListEl.appendChild(frag);
  applySearchFilter();
}

function subscribeGroupsCloud() {
  unsubscribeGroupsCloud();
  if (!currentUser?.id) return;

  const qG = query(
    collection(db, GROUPS_COL),
    where("members", "array-contains", String(currentUser.id))
  );

  unsubscribeGroups = onSnapshot(
    qG,
    (snap) => {
      const arr = [];
      snap.forEach((d) => {
        const data = d.data() || {};
        arr.push({ id: d.id, ...data });
      });

      arr.sort((a, b) => (tsToNumber(b.createdAt) || 0) - (tsToNumber(a.createdAt) || 0));
      groupsCache = arr;

      renderGroupsList();
    },
    (err) => {
      console.error("Groups snapshot error:", err);
      groupsCache = [];
      renderGroupsList();
    }
  );
}

// ---------------- ✅ Cloud Recents (AFTER SEND ONLY) ----------------

function recentsColRef(userId) {
  return collection(db, RECENTS_ROOT, String(userId), "items");
}

function unsubscribeRecentsCloud() {
  unsubscribeRecents?.();
  unsubscribeRecents = null;
  recentsCache = [];
}

function renderRecentsList() {
  if (!recentListEl) recentListEl = document.getElementById("recent-list");
  if (!recentListEl) return;

  recentListEl.innerHTML = "";

  if (!recentsCache.length) {
    recentListEl.innerHTML = `<div class="ms-empty" id="recent-empty">No recent chats yet</div>`;
    return;
  }

  const frag = document.createDocumentFragment();

  recentsCache.forEach((r) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-room chat-recent";
    btn.dataset.recentId = r.id;

    const badge = r.type === "dm" ? "DM" : (r.type === "group" ? "G" : "#");
    const avatarLetter = String(r.title || badge).trim().slice(0, 1).toUpperCase();

    btn.innerHTML = `
      <div class="chat-row">
        <div class="chat-avatar role-room">${avatarLetter}</div>
        <div class="chat-row-text">
          <div class="chat-room-title">${r.title || "Chat"}</div>
          <div class="chat-room-sub">${r.desc || ""}</div>
        </div>
      </div>
    `;

    btn.addEventListener("click", () => {
      openChat({ type: r.type, roomId: r.roomId, title: r.title, desc: r.desc }, btn);
    });

    if (r.roomId) registerRoomButton(String(r.roomId), btn);
    frag.appendChild(btn);
  });

  recentListEl.appendChild(frag);
  applySearchFilter();
}

function subscribeRecentsCloud() {
  unsubscribeRecentsCloud();
  if (!currentUser?.id) return;

  const qR = query(recentsColRef(currentUser.id), orderBy("lastTs", "desc"));

  unsubscribeRecents = onSnapshot(
    qR,
    (snap) => {
      const arr = [];
      snap.forEach((d) => {
        const data = d.data() || {};
        arr.push({
          id: d.id,
          type: data.type || "room",
          roomId: data.roomId || "",
          title: data.title || "",
          desc: data.desc || "",
          lastTs: data.lastTs || 0,
        });
      });
      recentsCache = arr;
      renderRecentsList();
    },
    (err) => {
      console.error("Recents snapshot error:", err);
    }
  );
}

async function bumpRecentAfterSendCloud() {
  if (!currentUser?.id || !activeChat?.roomId) return;

  const type = activeChat.type; // dm/room/group
  const roomId = activeChat.roomId;

  let recentId = "";
  let title = activeChat.title || "Chat";
  let desc = activeChat.desc || "";

  if (type === "dm") {
    const otherId = getOtherIdFromDmRoom(roomId, currentUser.id) || "";
    if (!otherId) return;
    recentId = `dm:${otherId}`;
    title = title || `CCMS ${otherId}`;
    desc = `Direct message • CCMS ${otherId}`;
  } else if (type === "group") {
    recentId = `group:${roomId}`;
    desc = desc || "Group chat";
  } else {
    recentId = `room:${roomId}`;
    desc = desc || "Room";
  }

  if (!recentId) return;

  const ref = doc(db, RECENTS_ROOT, String(currentUser.id), "items", recentId);

  try {
    await setDoc(
      ref,
      {
        type,
        roomId,
        title,
        desc,
        lastTs: Date.now(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (e) {
    console.error("bumpRecentAfterSendCloud error:", e);
  }
}

// ---------------- open chat ----------------

function openChat(chat, clickedEl = null) {
  setCurrentUser();
  if (!currentUser) return;

  if (!chat?.roomId) return;

  activeChat = {
    type: chat.type || "room",
    roomId: chat.roomId,
    title: chat.title || "Chat",
    desc: chat.desc || "",
  };

  setActiveButton(clickedEl);
  setHeader(activeChat.title, activeChat.desc);
  setEmpty(false);
  setInputEnabled(true);

  markRoomRead(String(activeChat.roomId));
  subscribeMainToRoom(activeChat.roomId);
}

// listen events from groups.js
window.addEventListener("telesyriana:open-group", (e) => {
  const d = e.detail || {};
  openChat({ type: "group", roomId: d.roomId, title: d.title, desc: d.desc }, null);
});
window.addEventListener("telesyriana:open-room", (e) => {
  const d = e.detail || {};
  openChat({ type: d.type || "room", roomId: d.roomId, title: d.title, desc: d.desc }, null);
});

// ---------------- collapsible sidebar sections ----------------

function makeCollapsible(headerText, listId) {
  const headers = Array.from(document.querySelectorAll(".messages-sidebar-header"));
  const h = headers.find((x) => x.textContent.trim().toLowerCase() === headerText.toLowerCase());
  const list = document.getElementById(listId);
  if (!h || !list) return;

  if (!h.querySelector(".caret")) {
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "▾";
    caret.style.marginLeft = "8px";
    caret.style.opacity = "0.7";
    h.appendChild(caret);
  }

  h.style.cursor = "pointer";
  h.style.userSelect = "none";
  h.dataset.open = "1";

  h.addEventListener("click", () => {
    const open = h.dataset.open === "1";
    h.dataset.open = open ? "0" : "1";
    list.style.display = open ? "none" : "";

    const caret = h.querySelector(".caret");
    if (caret) caret.textContent = open ? "▸" : "▾";
  });
}

// ---------------- ✅ Search (Rooms/Groups/Recent/DMs) ----------------

let searchQuery = "";

function normalizeText(s) {
  return String(s || "").toLowerCase().trim();
}

function matchesSearch(btn, q) {
  if (!btn) return false;
  if (!q) return true;

  const text = normalizeText(btn.textContent || "");

  const dm = normalizeText(btn.dataset.dm || "");
  const room = normalizeText(btn.dataset.room || "");
  const gid = normalizeText(btn.dataset.groupId || "");
  const rid = normalizeText(btn.dataset.recentId || "");

  const all = `${text} ${dm} ${room} ${gid} ${rid}`;
  return all.includes(q);
}

function filterList(listId, selector) {
  const list = document.getElementById(listId);
  if (!list) return;

  const items = Array.from(list.querySelectorAll(selector));
  let any = false;

  items.forEach((btn) => {
    const ok = matchesSearch(btn, searchQuery);
    btn.style.display = ok ? "" : "none";
    if (ok) any = true;
  });

  const empty = list.querySelector(".ms-empty");
  if (empty) empty.style.display = searchQuery ? (any ? "none" : "") : "";
}

function applySearchFilter() {
  filterList("rooms-list", ".chat-room[data-room]");
  filterList("groups-list", ".chat-group");
  filterList("recent-list", ".chat-recent");
  filterList("dm-list", ".chat-dm");
}

function hookSearch() {
  const input =
    document.querySelector(".ms-search input") ||
    document.getElementById("messages-search") ||
    document.getElementById("ms-search") ||
    document.querySelector("#page-messages input[type='search']");

  if (!input) return;

  input.addEventListener("input", () => {
    searchQuery = normalizeText(input.value || "");
    applySearchFilter();
  });

  const xBtn = document.querySelector(".ms-search-x");
  if (xBtn) {
    xBtn.addEventListener("click", () => {
      input.value = "";
      searchQuery = "";
      applySearchFilter();
      input.focus();
    });
  }
}

// ---------------- init ----------------

document.addEventListener("DOMContentLoaded", () => {
  dmListEl = document.getElementById("dm-list");
  recentListEl = document.getElementById("recent-list");
  groupsListEl = document.getElementById("groups-list");

  initBeep();

  ensureNavBadge();
  updateNavBadge();

  const backBtn = document.getElementById("chat-back");
  if (backBtn) backBtn.style.display = "none";

  setCurrentUser();

  makeCollapsible("Rooms", "rooms-list");
  makeCollapsible("Groups", "groups-list");
  makeCollapsible("Recent", "recent-list");
  makeCollapsible("Direct messages", "dm-list");

  setHeader("Messages", "Start chatting…");
  setEmpty(true);
  setInputEnabled(false);

  hookSearch();

  subscribeGroupsCloud();
  subscribeRecentsCloud();

  document.querySelectorAll(".chat-room[data-room]").forEach((btn) => {
    const r = btn.dataset.room;
    if (r && r !== "ai") registerRoomButton(String(r), btn);

    btn.addEventListener("click", () => {
      setCurrentUser();
      if (!currentUser) return;

      const room = btn.dataset.room;

      if (room === "ai") {
        activeChat = { type: "ai", roomId: "ai", title: "ChatGPT 5", desc: "Coming soon…" };
        setActiveButton(btn);
        unsubscribeAllMain();
        setHeader("ChatGPT 5", "Coming soon…");
        setEmpty(true);
        setInputEnabled(false);
        return;
      }

      if (room === "supervisors" && currentUser.role !== "supervisor") {
        console.warn("Supervisor only room");
        return;
      }

      const title = room === "general" ? "General chat" : "Supervisors";
      const desc =
        room === "general"
          ? "All agents & supervisors • Be respectful • No customer data."
          : "Supervisor-only space for internal notes and coordination.";

      openChat({ type: "room", roomId: room, title, desc }, btn);
    });
  });

  document.querySelectorAll(".chat-dm[data-dm]").forEach((btn) => {
    setCurrentUser();
    const otherId = btn.dataset.dm;
    if (otherId && currentUser?.id) {
      const rid = dmRoomId(currentUser.id, otherId);
      registerRoomButton(String(rid), btn);
    }

    btn.addEventListener("click", () => {
      setCurrentUser();
      if (!currentUser) return;

      const otherId = btn.dataset.dm;
      const roomId = dmRoomId(currentUser.id, otherId);

      const nameEl = btn.querySelector(".chat-room-title");
      const otherName = (nameEl?.textContent || `CCMS ${otherId}`).trim();

      openChat(
        { type: "dm", roomId, title: otherName, desc: `Direct message • CCMS ${otherId}` },
        btn
      );
    });
  });

  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");

  formEl?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const text = inputEl?.value?.trim();
    if (!text) return;

    setCurrentUser();
    if (!currentUser) return;
    if (!activeChat || activeChat.type === "ai") return;

    try {
      await addDoc(collection(db, MESSAGES_COL), {
        room: activeChat.roomId,
        text,
        userId: currentUser.id,
        name: currentUser.name,
        role: currentUser.role,
        ts: serverTimestamp(),
      });

      await bumpRecentAfterSendCloud();

      setLastSeen(String(activeChat.roomId), Date.now());
      unreadByRoom.set(String(activeChat.roomId), 0);
      updateBadgesForRoom(String(activeChat.roomId));
      restartUnreadWatcher(String(activeChat.roomId));
    } catch (err) {
      console.error("Send error:", err);
    }

    inputEl.value = "";
  });

  subscribeStatusDots();
});

// user change (login/logout) ✅ ONLY ONE listener
window.addEventListener("telesyriana:user-changed", () => {
  setCurrentUser();

  unsubscribeAllMain();
  unsubscribeGroupsCloud();
  unsubscribeRecentsCloud();

  clearActiveButtons();
  activeChat = null;

  setHeader("Messages", "Start chatting…");
  setEmpty(true);
  setInputEnabled(false);

  stopAllUnreadWatchers();
  ensureNavBadge();
  updateNavBadge();

  subscribeGroupsCloud();
  subscribeRecentsCloud();
  subscribeStatusDots();

  document.querySelectorAll(".chat-room[data-room]").forEach((btn) => {
    const r = btn.dataset.room;
    if (r && r !== "ai") registerRoomButton(String(r), btn);
  });

  document.querySelectorAll(".chat-dm[data-dm]").forEach((btn) => {
    setCurrentUser();
    const otherId = btn.dataset.dm;
    if (otherId && currentUser?.id) {
      const rid = dmRoomId(currentUser.id, otherId);
      registerRoomButton(String(rid), btn);
    }
  });

  applySearchFilter();
});

