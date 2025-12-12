// messages.js — TeleSyriana Chat (Rooms + DM + Floating)
// ✅ No default open
// ✅ Input disabled until selection
// ✅ AI room "Coming soon"
// ✅ DM uses roomId: dm_<small>_<big>

import { db, fs } from "./firebase.js";
const { collection, addDoc, query, where, orderBy, onSnapshot, serverTimestamp } = fs;

const USER_KEY = "telesyrianaUser";
const MESSAGES_COL = "globalMessages";

let currentUser = null;
let currentRoom = null;
let unsubscribeMain = null;
let unsubscribeFloat = null;

function getUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function setInputEnabled(on) {
  const input = document.getElementById("chat-input");
  const btn = document.querySelector(".chat-send-btn");
  if (input) input.disabled = !on;
  if (btn) btn.disabled = !on;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderMessages(listEl, docs, showRole = true) {
  listEl.innerHTML = "";
  const frag = document.createDocumentFragment();

  docs.forEach((m) => {
    const wrap = document.createElement("div");
    wrap.className = "chat-message";
    if (currentUser && m.userId === currentUser.id) wrap.classList.add("me");

    const meta = document.createElement("div");
    meta.className = "chat-message-meta";
    meta.textContent = showRole
      ? `${m.name} (${m.role}) • ${formatTime(m.ts)}`
      : `${m.name} • ${formatTime(m.ts)}`;

    const text = document.createElement("div");
    text.className = "chat-message-text";
    text.textContent = m.text || "";

    wrap.appendChild(meta);
    wrap.appendChild(text);
    frag.appendChild(wrap);
  });

  listEl.appendChild(frag);
  listEl.scrollTop = listEl.scrollHeight;
}

function subscribeRoom(roomId, listEl, showRole = true) {
  unsubscribeMain?.();
  const q = query(
    collection(db, MESSAGES_COL),
    where("room", "==", roomId),
    orderBy("ts", "asc")
  );

  unsubscribeMain = onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach((d) => rows.push(d.data()));
    renderMessages(listEl, rows, showRole);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  currentUser = getUser();

  // Main chat elements
  const listEl = document.getElementById("chat-message-list");
  const emptyEl = document.getElementById("chat-empty");
  const roomNameEl = document.getElementById("chat-room-name");
  const roomDescEl = document.getElementById("chat-room-desc");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");

  // Floating
  const floatToggle = document.getElementById("float-chat-toggle");
  const floatPanel = document.getElementById("float-chat-panel");
  const floatClose = document.getElementById("float-chat-close");
  const floatList = document.getElementById("float-chat-messages");
  const floatForm = document.getElementById("float-chat-form");
  const floatInput = document.getElementById("float-chat-input");

  // Initial state: nothing selected
  if (listEl) listEl.innerHTML = "";
  if (emptyEl) emptyEl.style.display = "block";
  setInputEnabled(false);

  // Rooms
  document.querySelectorAll(".chat-room").forEach((btn) => {
    btn.addEventListener("click", () => {
      const room = btn.dataset.room;

      // active UI
      document.querySelectorAll(".chat-room, .chat-dm").forEach((x) => x.classList.remove("active"));
      btn.classList.add("active");

      if (emptyEl) emptyEl.style.display = "none";

      // AI room
      if (room === "ai") {
        unsubscribeMain?.();
        currentRoom = null;
        setInputEnabled(false);
        roomNameEl.textContent = "ChatGPT 5";
        roomDescEl.textContent = "Coming soon…";
        listEl.innerHTML = `<div style="padding:12px;color:#777;">🤖 ChatGPT assistant is coming soon.</div>`;
        return;
      }

      currentRoom = room;
      setInputEnabled(true);

      roomNameEl.textContent = btn.querySelector(".chat-room-title")?.textContent || room;
      roomDescEl.textContent = btn.querySelector(".chat-room-sub")?.textContent || "";

      subscribeRoom(room, listEl, true);
    });
  });

  // Direct Messages
  document.querySelectorAll(".chat-dm").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!currentUser) return alert("Please login first.");

      document.querySelectorAll(".chat-room, .chat-dm").forEach((x) => x.classList.remove("active"));
      btn.classList.add("active");

      if (emptyEl) emptyEl.style.display = "none";

      const otherId = btn.dataset.dm;
      const ids = [currentUser.id, otherId].sort();
      const roomId = `dm_${ids[0]}_${ids[1]}`;

      currentRoom = roomId;
      setInputEnabled(true);

      roomNameEl.textContent = btn.querySelector(".chat-room-title")?.textContent || "Direct message";
      roomDescEl.textContent = "Direct chat";

      subscribeRoom(roomId, listEl, false);
    });
  });

  // Send (main chat)
  formEl?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentUser) return alert("Please login first.");
    if (!currentRoom) return;

    const text = inputEl.value.trim();
    if (!text) return;

    await addDoc(collection(db, MESSAGES_COL), {
      room: currentRoom,
      text,
      userId: currentUser.id,
      name: currentUser.name,
      role: currentUser.role,
      ts: serverTimestamp(),
    });

    inputEl.value = "";
  });

  // Floating open/close (app.js هو اللي بيخفيه بصفحة messages)
  floatToggle?.addEventListener("click", () => floatPanel?.classList.toggle("hidden"));
  floatClose?.addEventListener("click", () => floatPanel?.classList.add("hidden"));

  // Floating subscription (General only)
  if (floatList) {
    const q = query(
      collection(db, MESSAGES_COL),
      where("room", "==", "general"),
      orderBy("ts", "asc")
    );

    unsubscribeFloat = onSnapshot(q, (snap) => {
      const rows = [];
      snap.forEach((d) => rows.push(d.data()));
      renderMessages(floatList, rows.slice(-30), false);
    });
  }

  // Floating send
  floatForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentUser) return alert("Please login first.");

    const text = floatInput.value.trim();
    if (!text) return;

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
});

// Update user without refresh
window.addEventListener("telesyriana:user-changed", () => {
  currentUser = getUser();
});

