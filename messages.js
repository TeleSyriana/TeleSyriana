// messages.js – TeleSyriana chat UI with Firestore

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

/* ------------------ helpers ------------------ */

function loadUserFromStorage() {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return;
  try {
    currentUser = JSON.parse(raw);
  } catch {}
}

function formatTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ------------------ Firestore ------------------ */

function subscribeMainToRoom(room, listEl) {
  if (unsubscribeMain) unsubscribeMain();

  const colRef = collection(db, MESSAGES_COL);

  const q = query(
    colRef,
    where("room", "==", room),
    orderBy("ts", "desc"),
    limit(50)
  );

  unsubscribeMain = onSnapshot(q, (snap) => {
    const msgs = [];
    snap.forEach((d) => msgs.push({ id: d.id, ...d.data() }));

    // 🔄 نقلبهم ليصير الأقدم فوق
    renderMessages(listEl, msgs.reverse());
  });
}

/* ------------------ UI ------------------ */

function renderMessages(listEl, msgs) {
  listEl.innerHTML = "";

  msgs.forEach((m) => {
    const wrap = document.createElement("div");
    wrap.className = "chat-message";
    if (currentUser && m.userId === currentUser.id) {
      wrap.classList.add("me");
    }

    wrap.innerHTML = `
      <div class="chat-message-meta">
        ${m.name} (${m.role}) • ${formatTime(m.ts)}
      </div>
      <div class="chat-message-text">${m.text}</div>
    `;

    listEl.appendChild(wrap);
  });

  // ⬇️ دايماً نزول لآخر رسالة
  listEl.scrollTop = listEl.scrollHeight;
}

/* ------------------ Init ------------------ */

document.addEventListener("DOMContentLoaded", () => {
  const page = document.getElementById("page-messages");
  if (!page) return;

  loadUserFromStorage();

  const listEl = document.getElementById("chat-message-list");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");

  // اشتراك أولي
  subscribeMainToRoom(currentRoom, listEl);

  // إرسال رسالة
  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text || !currentUser) return;

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
});


