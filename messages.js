// messages.js – Firestore chat
// ✔ Lazy load
// ✔ Rooms + DMs
// ✔ Status dots
// ✔ DM reorder ONLY after sending message
// ✔ Search filter
// ✔ Glass sidebar compatible

import { db, fs } from "./firebase.js";

const { collection, addDoc, query, where, orderBy, onSnapshot, serverTimestamp } = fs;

const USER_KEY = "telesyrianaUser";
const MESSAGES_COL = "globalMessages";
const AGENT_DAYS_COL = "agentDays";

// recents per user
const RECENTS_KEY_PREFIX = "telesyrianaChatRecents";

const PAGE_SIZE = 50;
const MAX_RENDER = 600;

let currentUser = null;
let activeChat = null;

let unsubscribeMain = null;
let unsubscribeFloat = null;
let unsubscribeStatus = null;

let roomCache = [];
let renderedCount = 0;
let scrollBoundEl = null;

let dmListEl = null;

/* ---------------- helpers ---------------- */

function getUserFromStorage() {
  try {
    const raw = localStorage.getItem(USER_KEY);
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
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dmRoomId(a, b) {
  const x = String(a), y = String(b);
  return x < y ? `dm_${x}_${y}` : `dm_${y}_${x}`;
}

function getOtherIdFromDmRoom(roomId, myId) {
  const p = roomId.split("_");
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
  document.querySelectorAll(".chat-room, .chat-dm").forEach(b => {
    b.classList.remove("active", "chat-item-active");
  });
}

function setActiveButton(el) {
  clearActiveButtons();
  el?.classList.add("active", "chat-item-active");
}

function setHeader(nameEl, descEl, title, desc) {
  nameEl.textContent = title || "Messages";
  descEl.textContent = desc || "Start chatting…";
}

function setEmptyState(emptyEl, listEl, on) {
  emptyEl.style.display = on ? "block" : "none";
  listEl.style.display = on ? "none" : "flex";
}

function setInputEnabled(formEl, inputEl, enabled) {
  inputEl.disabled = !enabled;
  formEl.querySelector("button")?.toggleAttribute("disabled", !enabled);
}

/* ---------------- Messages render ---------------- */

function getInitials(name = "") {
  return name.split(" ").slice(0, 2).map(n => n[0]).join("").toUpperCase();
}

function createMessageNode(m) {
  const wrap = document.createElement("div");
  wrap.className = "chat-message";
  if (m.userId === currentUser?.id) wrap.classList.add("me");

  wrap.innerHTML = `
    <div class="msg-avatar">${getInitials(m.name)}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-name">${m.name}</span>
        <span>• ${formatTime(m.ts)}</span>
      </div>
      <div class="chat-message-text">${m.text}</div>
    </div>
  `;
  return wrap;
}

function renderFresh(listEl, msgs) {
  listEl.innerHTML = "";
  msgs.forEach(m => listEl.appendChild(createMessageNode(m)));
  listEl.scrollTop = listEl.scrollHeight;
}

/* ---------------- Firestore ---------------- */

function unsubscribeAllMain() {
  unsubscribeMain?.();
  unsubscribeMain = null;
  roomCache = [];
  renderedCount = 0;
  scrollBoundEl = null;
}

function subscribeMainToRoom(roomId, listEl) {
  unsubscribeAllMain();

  const q = query(
    collection(db, MESSAGES_COL),
    where("room", "==", roomId),
    orderBy("ts", "desc")
  );

  unsubscribeMain = onSnapshot(q, snap => {
    const all = [];
    snap.forEach(d => all.push({ id: d.id, ...d.data() }));
    all.reverse();

    roomCache = all;
    renderedCount = Math.min(PAGE_SIZE, roomCache.length);
    const start = Math.max(0, roomCache.length - renderedCount);
    renderFresh(listEl, roomCache.slice(start));
  });
}

/* ---------------- Recents (ONLY on send) ---------------- */

function recentsKey() {
  return `${RECENTS_KEY_PREFIX}:${currentUser.id}`;
}

function loadRecents() {
  try {
    return JSON.parse(localStorage.getItem(recentsKey())) || {};
  } catch {
    return {};
  }
}

function saveRecents(map) {
  localStorage.setItem(recentsKey(), JSON.stringify(map));
}

function bumpRecent(otherId) {
  const map = loadRecents();
  map[otherId] = Date.now();
  saveRecents(map);
  applyDmOrder();
}

function applyDmOrder() {
  if (!dmListEl) return;

  const map = loadRecents();
  const buttons = [...dmListEl.querySelectorAll(".chat-dm")];

  buttons.sort((a, b) => {
    const ta = map[a.dataset.dm] || 0;
    const tb = map[b.dataset.dm] || 0;
    return tb - ta;
  });

  buttons.forEach(b => dmListEl.appendChild(b));
}

/* ---------------- Status dots ---------------- */

function subscribeStatusDots() {
  unsubscribeStatus?.();

  const q = query(
    collection(db, AGENT_DAYS_COL),
    where("day", "==", getTodayKey())
  );

  unsubscribeStatus = onSnapshot(q, snap => {
    document.querySelectorAll("[data-status-dot]").forEach(dot => {
      dot.className = "status-dot dot-offline";
    });

    snap.forEach(doc => {
      const d = doc.data();
      const dot = document.querySelector(`[data-status-dot="${d.userId}"]`);
      if (dot) dot.classList.add(statusToDotClass(d.status));
    });
  });
}

/* ---------------- Search ---------------- */

function hookSearch() {
  const input = document.getElementById("chat-search");
  const clear = document.getElementById("chat-search-clear");

  const run = () => {
    const q = input.value.toLowerCase();
    document.querySelectorAll(".chat-room, .chat-dm").forEach(b => {
      const t = b.textContent.toLowerCase();
      b.style.display = t.includes(q) ? "" : "none";
    });
  };

  input.addEventListener("input", run);
  clear.addEventListener("click", () => {
    input.value = "";
    run();
  });
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

  document.querySelectorAll(".chat-room").forEach(btn => {
    btn.onclick = () => {
      const room = btn.dataset.room;
      setActiveButton(btn);

      activeChat = { type: "room", roomId: room };
      setHeader(nameEl, descEl, btn.innerText, "");
      setEmptyState(emptyEl, listEl, false);
      setInputEnabled(formEl, inputEl, true);

      subscribeMainToRoom(room, listEl);
    };
  });

  document.querySelectorAll(".chat-dm").forEach(btn => {
    btn.onclick = () => {
      const otherId = btn.dataset.dm;
      const roomId = dmRoomId(currentUser.id, otherId);

      setActiveButton(btn);

      activeChat = { type: "dm", roomId, otherId };
      setHeader(nameEl, descEl, btn.innerText, "Direct message");
      setEmptyState(emptyEl, listEl, false);
      setInputEnabled(formEl, inputEl, true);

      subscribeMainToRoom(roomId, listEl);
    };
  });

  formEl.onsubmit = async e => {
    e.preventDefault();
    if (!inputEl.value.trim()) return;

    await addDoc(collection(db, MESSAGES_COL), {
      room: activeChat.roomId,
      text: inputEl.value.trim(),
      userId: currentUser.id,
      name: currentUser.name,
      role: currentUser.role,
      ts: serverTimestamp(),
    });

    if (activeChat.type === "dm") {
      bumpRecent(activeChat.otherId);
    }

    inputEl.value = "";
  };
});
