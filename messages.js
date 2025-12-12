// messages.js – TeleSyriana (FULL FEATURES)

import { db, fs } from "./firebase.js";

const {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  limit,
} = fs;

const USER_KEY = "telesyrianaUser";
const MESSAGES_COL = "globalMessages";

let currentUser = null;
let currentRoom = "general";

let unsubscribeMain = null;
let unsubscribeFloat = null;

// limits (load more)
let mainLimit = 50;
let floatLimit = 30;

// unread
let unreadCount = 0;
let lastSeenFloatTs = 0;

// audio
let pingEnabled = true;
let pingAudio = null;

// typing (local UI)
let typingTimer = null;

/* ----------------- user ----------------- */
function loadUserFromStorage() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return;
    const u = JSON.parse(raw);
    if (u && u.id && u.name && u.role) currentUser = u;
  } catch (e) {
    console.error("Error loading user from localStorage", e);
  }
}

/* ----------------- time ----------------- */
function formatTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (ts.toMillis) return ts.toMillis();
  if (ts.toDate) return ts.toDate().getTime();
  return new Date(ts).getTime();
}

/* ----------------- dom ready ----------------- */
document.addEventListener("DOMContentLoaded", () => {
  const pageMessages = document.getElementById("page-messages");
  if (!pageMessages) return;

  // main elements
  const roomButtons = document.querySelectorAll(".chat-room");
  const roomNameEl = document.getElementById("chat-room-name");
  const roomDescEl = document.getElementById("chat-room-desc");
  const listEl = document.getElementById("chat-message-list");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");
  const loadMoreBtn = document.getElementById("chat-load-more"); // optional
  const scrollDownBtn = document.getElementById("chat-scroll-down"); // optional
  const typingEl = document.getElementById("chat-typing"); // optional

  // floating
  const floatToggle = document.getElementById("float-chat-toggle");
  const floatPanel = document.getElementById("float-chat-panel");
  const floatClose = document.getElementById("float-chat-close");
  const floatList = document.getElementById("float-chat-messages");
  const floatForm = document.getElementById("float-chat-form");
  const floatInput = document.getElementById("float-chat-input");
  const floatBadge = document.getElementById("float-chat-badge"); // optional

  loadUserFromStorage();

  // ping sound
  pingAudio = new Audio("./ping.mp3"); // حط ملف ping.mp3 بجانب index.html (أو عطّل pingEnabled=false)

  // hide supervisors room for agents
  const supBtn = document.querySelector('.chat-room[data-room="supervisors"]');
  if (supBtn && (!currentUser || currentUser.role !== "supervisor")) {
    supBtn.classList.add("hidden");
  }

  // room meta
  const ROOM_META = {
    general: { name: "General chat", desc: "All agents & supervisors • Be respectful • No customer data." },
    supervisors: { name: "Supervisors", desc: "Supervisor-only space for internal notes and coordination." },
  };

  // switch room
  roomButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const room = btn.dataset.room;
      currentRoom = room;
      applyRoomMeta(currentRoom, ROOM_META, roomNameEl, roomDescEl);
      setActiveRoomButton(currentRoom, roomButtons);
      subscribeMainToRoom(currentRoom, listEl);
    });
  });

  // send main
  formEl?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    if (!currentUser) return alert("Please login first.");

    try {
      await addDoc(collection(db, MESSAGES_COL), {
        room: currentRoom,
        text,
        userId: currentUser.id,
        name: currentUser.name,
        role: currentUser.role,
        ts: serverTimestamp(),
      });
      inputEl.value = "";
      showTyping(typingEl, false);
      scrollToBottom(listEl);
    } catch (err) {
      console.error("Error sending message", err);
      alert("Error sending message: " + err.message);
    }
  });

  // local typing indicator
  inputEl?.addEventListener("input", () => {
    showTyping(typingEl, true);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => showTyping(typingEl, false), 800);
  });

  // floating open/close
  floatToggle?.addEventListener("click", () => {
    floatPanel.classList.toggle("hidden");
    // reset unread when opened
    if (!floatPanel.classList.contains("hidden")) {
      unreadCount = 0;
      updateBadge(floatBadge, unreadCount);
      lastSeenFloatTs = Date.now();
    }
  });

  floatClose?.addEventListener("click", () => {
    floatPanel.classList.add("hidden");
  });

  // send floating
  floatForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = floatInput.value.trim();
    if (!text) return;
    if (!currentUser) return alert("Please login first.");

    try {
      await addDoc(collection(db, MESSAGES_COL), {
        room: "general",
        text,
        userId: currentUser.id,
        name: currentUser.name,
        role: currentUser.role,
        ts: serverTimestamp(),
      });
      floatInput.value = "";
      scrollToBottom(floatList);
    } catch (err) {
      console.error("Error sending message (float)", err);
      alert("Error sending message: " + err.message);
    }
  });

  // load more
  loadMoreBtn?.addEventListener("click", () => {
    mainLimit += 50;
    subscribeMainToRoom(currentRoom, listEl);
  });

  // scroll down button
  listEl?.addEventListener("scroll", () => {
    if (!scrollDownBtn) return;
    const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
    scrollDownBtn.classList.toggle("hidden", nearBottom);
  });

  scrollDownBtn?.addEventListener("click", () => scrollToBottom(listEl));

  // init
  applyRoomMeta(currentRoom, ROOM_META, roomNameEl, roomDescEl);
  setActiveRoomButton(currentRoom, roomButtons);

  subscribeMainToRoom(currentRoom, listEl);
  subscribeFloatToGeneral(floatList, floatPanel, floatBadge);
});

/* ----------------- subscriptions ----------------- */

function subscribeMainToRoom(room, listEl) {
  if (!listEl) return;
  if (unsubscribeMain) unsubscribeMain();

  const qRoom = query(
    collection(db, MESSAGES_COL),
    where("room", "==", room),
    orderBy("ts", "asc"),
    limit(mainLimit)
  );

  unsubscribeMain = onSnapshot(qRoom, (snapshot) => {
    const msgs = [];
    snapshot.forEach((d) => msgs.push({ id: d.id, ...d.data() }));
    renderMainMessages(listEl, msgs);
  });
}

function subscribeFloatToGeneral(floatList, floatPanel, badgeEl) {
  if (!floatList) return;
  if (unsubscribeFloat) unsubscribeFloat();

  const qGeneral = query(
    collection(db, MESSAGES_COL),
    where("room", "==", "general"),
    orderBy("ts", "asc"),
    limit(floatLimit)
  );

  unsubscribeFloat = onSnapshot(qGeneral, (snapshot) => {
    const msgs = [];
    snapshot.forEach((d) => msgs.push({ id: d.id, ...d.data() }));

    // unread + ping (only if panel closed)
    const last = msgs[msgs.length - 1];
    const lastMs = last ? tsToMs(last.ts) : 0;

    const panelClosed = floatPanel?.classList.contains("hidden");
    if (panelClosed && lastMs && lastMs > lastSeenFloatTs) {
      unreadCount += 1;
      updateBadge(badgeEl, unreadCount);

      if (pingEnabled && last?.userId !== currentUser?.id) {
        try { pingAudio?.play(); } catch {}
      }
      lastSeenFloatTs = lastMs;
    }

    renderFloatingMessages(floatList, msgs);
  });
}

/* ----------------- UI helpers ----------------- */

function applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl) {
  const meta = ROOM_META[room] || {};
  if (roomNameEl) roomNameEl.textContent = meta.name || room;
  if (roomDescEl) roomDescEl.textContent = meta.desc || "Internal chat room.";
}

function setActiveRoomButton(room, roomButtons) {
  roomButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.room === room);
  });
}

function scrollToBottom(el) {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

function updateBadge(badgeEl, count) {
  if (!badgeEl) return;
  if (count <= 0) {
    badgeEl.classList.add("hidden");
    badgeEl.textContent = "";
  } else {
    badgeEl.classList.remove("hidden");
    badgeEl.textContent = String(count);
  }
}

function showTyping(el, show) {
  if (!el) return;
  el.classList.toggle("hidden", !show);
}

/* ----------------- rendering ----------------- */

function renderMainMessages(listEl, msgs) {
  listEl.innerHTML = "";

  msgs.forEach((m) => {
    const wrap = document.createElement("div");
    wrap.className = "chat-message";
    if (currentUser && m.userId === currentUser.id) wrap.classList.add("me");

    const meta = document.createElement("div");
    meta.className = "chat-message-meta";
    meta.textContent = `${m.name} (${m.role}) • ${formatTime(m.ts)}`;

    const text = document.createElement("div");
    text.className = "chat-message-text";
    text.textContent = m.text;

    wrap.append(meta, text);
    listEl.appendChild(wrap);
  });

  scrollToBottom(listEl);
}

function renderFloatingMessages(floatList, msgs) {
  floatList.innerHTML = "";

  msgs.forEach((m) => {
    const wrap = document.createElement("div");
    wrap.className = "chat-message";
    if (currentUser && m.userId === currentUser.id) wrap.classList.add("me");

    const meta = document.createElement("div");
    meta.className = "chat-message-meta";
    meta.textContent = `${m.name} • ${formatTime(m.ts)}`;

    const text = document.createElement("div");
    text.className = "chat-message-text";
    text.textContent = m.text;

    wrap.append(meta, text);
    floatList.appendChild(wrap);
  });

  scrollToBottom(floatList);
}

