// messages.js – TeleSyriana chat UI with Firestore

import { db, fs } from "./firebase.js";
import {
  limit
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
} = fs;

const USER_KEY = "telesyrianaUser";
const MESSAGES_COL = "globalMessages";

let currentUser = null;
let currentRoom = "general";
let unsubscribeMain = null;

/* ---------------- USER ---------------- */

function loadUserFromStorage() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return;
    const u = JSON.parse(raw);
    if (u?.id && u?.name && u?.role) currentUser = u;
  } catch {}
}

/* ---------------- INIT ---------------- */

document.addEventListener("DOMContentLoaded", () => {
  loadUserFromStorage();

  const listEl = document.getElementById("chat-message-list");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");

  if (!listEl || !formEl || !inputEl) return;

  subscribeMainToRoom("general", listEl);

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentUser) return alert("Login first");

    const text = inputEl.value.trim();
    if (!text) return;

    await addDoc(collection(db, MESSAGES_COL), {
      room: "general",
      text,
      userId: currentUser.id,
      name: currentUser.name,
      role: currentUser.role,
      ts: serverTimestamp(),
    });

    inputEl.value = "";
  });
});

/* ---------------- FIRESTORE ---------------- */

function subscribeMainToRoom(room, listEl) {
  if (unsubscribeMain) unsubscribeMain();

  const q = query(
    collection(db, MESSAGES_COL),
    where("room", "==", room),
    orderBy("ts", "asc"),
    limit(100)
  );

  unsubscribeMain = onSnapshot(q, (snap) => {
    const msgs = [];
    snap.forEach(d => msgs.push(d.data()));
    renderMessages(listEl, msgs);
  });
}

/* ---------------- RENDER ---------------- */

function renderMessages(listEl, msgs) {
  listEl.innerHTML = "";

  msgs.forEach(m => {
    const div = document.createElement("div");
    div.className = "chat-message" + (m.userId === currentUser?.id ? " me" : "");

    div.innerHTML = `
      <div class="chat-message-meta">
        ${m.name} (${m.role}) • ${formatTime(m.ts)}
      </div>
      <div class="chat-message-text">${m.text}</div>
    `;

    listEl.appendChild(div);
  });

  listEl.scrollTop = listEl.scrollHeight;
}

function formatTime(ts) {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

