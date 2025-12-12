// messages.js – TeleSyriana chat UI with Firestore
// Rooms: general + supervisors
// Floating chat always shows general only

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

// Firestore subscriptions
let unsubscribeMain = null;
let unsubscribeFloat = null;

// ---- Scroll helpers (ذكي) ----
function isNearBottom(el, px = 80) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < px;
}

function scrollToBottom(el) {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

// Load user from localStorage
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

document.addEventListener("DOMContentLoaded", () => {
  const pageMessages = document.getElementById("page-messages");
  if (!pageMessages) return;

  // Main chat elements
  const roomButtons = document.querySelectorAll(".chat-room");
  const roomNameEl = document.getElementById("chat-room-name");
  const roomDescEl = document.getElementById("chat-room-desc");
  const listEl = document.getElementById("chat-message-list");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");

  // Floating chat elements
  const floatToggle = document.getElementById("float-chat-toggle");
  const floatPanel = document.getElementById("float-chat-panel");
  const floatClose = document.getElementById("float-chat-close");
  const floatList = document.getElementById("float-chat-messages");
  const floatForm = document.getElementById("float-chat-form");
  const floatInput = document.getElementById("float-chat-input");

  loadUserFromStorage();

  // Hide supervisors room for agents
  const supBtn = document.querySelector('.chat-room[data-room="supervisors"]');
  if (supBtn && (!currentUser || currentUser.role !== "supervisor")) {
    supBtn.classList.add("hidden");
  }

  // Show floating toggle only if logged in
  if (floatToggle && currentUser) {
    floatToggle.classList.remove("hidden");
  }

  const ROOM_META = {
    general: {
      name: "General chat",
      desc: "All agents & supervisors • Be respectful • No customer data.",
    },
    supervisors: {
      name: "Supervisors",
      desc: "Supervisor-only space for internal notes and coordination.",
    },
  };

  // Switch room
  roomButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const room = btn.dataset.room;
      switchRoom(room, ROOM_META, roomButtons, roomNameEl, roomDescEl, listEl);
    });
  });

  // Send message (main)
  if (formEl && inputEl) {
    formEl.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text) return;

      if (!currentUser) {
        alert("Please login first.");
        return;
      }

      try {
        const colRef = collection(db, MESSAGES_COL);
        await addDoc(colRef, {
          room: currentRoom,
          text,
          userId: currentUser.id,
          name: currentUser.name,
          role: currentUser.role,
          ts: serverTimestamp(),
        });
        inputEl.value = "";
        // ما منعمل scroll هون، لأن onSnapshot رح يعمل render + scroll ذكي
      } catch (err) {
        console.error("Error sending message", err);
        alert("Error sending message: " + err.message);
      }
    });
  }

  // Floating toggle open/close
  if (floatToggle && floatPanel) {
    floatToggle.addEventListener("click", () => {
      floatPanel.classList.toggle("hidden");
      // إذا فتحناها، خلّيها تنزل للآخر
      if (!floatPanel.classList.contains("hidden")) {
        setTimeout(() => scrollToBottom(floatList), 0);
      }
    });
  }

  if (floatClose && floatPanel) {
    floatClose.addEventListener("click", () => {
      floatPanel.classList.add("hidden");
    });
  }

  // Send message (floating) always general
  if (floatForm && floatInput) {
    floatForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = floatInput.value.trim();
      if (!text) return;

      if (!currentUser) {
        alert("Please login first.");
        return;
      }

      try {
        const colRef = collection(db, MESSAGES_COL);
        await addDoc(colRef, {
          room: "general",
          text,
          userId: currentUser.id,
          name: currentUser.name,
          role: currentUser.role,
          ts: serverTimestamp(),
        });
        floatInput.value = "";
      } catch (err) {
        console.error("Error sending message (float)", err);
        alert("Error sending message: " + err.message);
      }
    });
  }

  // Subscriptions
  subscribeMainToRoom(currentRoom, listEl);
  subscribeFloatToGeneral(floatList);

  // Apply meta + active button
  applyRoomMeta(currentRoom, ROOM_META, roomNameEl, roomDescEl);
  setActiveRoomButton(currentRoom, roomButtons);
});

/* ------------ Firestore subscriptions ------------ */

function subscribeMainToRoom(room, listEl) {
  if (!listEl) return;
  if (unsubscribeMain) unsubscribeMain();

  const colRef = collection(db, MESSAGES_COL);

  // ✅ Asc = القديم فوق والجديد تحت
  // ✅ limit لتخفيف الحمل
  const qRoom = query(
    colRef,
    where("room", "==", room),
    orderBy("ts", "asc"),
    limit(200)
  );

  unsubscribeMain = onSnapshot(
    qRoom,
    (snapshot) => {
      const shouldStickToBottom = isNearBottom(listEl);

      const msgs = [];
      snapshot.forEach((docSnap) => {
        msgs.push({ id: docSnap.id, ...docSnap.data() });
      });

      renderMainMessages(listEl, msgs);

      // ✅ Scroll ذكي: بس ينزل للآخر إذا المستخدم قريب من آخر القائمة
      if (shouldStickToBottom) scrollToBottom(listEl);
    },
    (err) => {
      console.error("Error in room subscription", err);
    }
  );
}

function subscribeFloatToGeneral(floatList) {
  if (!floatList) return;
  if (unsubscribeFloat) unsubscribeFloat();

  const colRef = collection(db, MESSAGES_COL);
  const qGeneral = query(
    colRef,
    where("room", "==", "general"),
    orderBy("ts", "asc"),
    limit(200)
  );

  unsubscribeFloat = onSnapshot(
    qGeneral,
    (snapshot) => {
      const shouldStickToBottom = isNearBottom(floatList);

      const msgs = [];
      snapshot.forEach((docSnap) => {
        msgs.push({ id: docSnap.id, ...docSnap.data() });
      });

      renderFloatingMessages(floatList, msgs);

      if (shouldStickToBottom) scrollToBottom(floatList);
    },
    (err) => {
      console.error("Error in floating subscription", err);
    }
  );
}

/* ----------------- Helpers ----------------- */

function switchRoom(room, ROOM_META, roomButtons, roomNameEl, roomDescEl, listEl) {
  currentRoom = room;
  applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl);
  setActiveRoomButton(room, roomButtons);

  // لما تبدّل غرفة، نزّل للآخر بعد أول render
  subscribeMainToRoom(room, listEl);
  setTimeout(() => scrollToBottom(listEl), 0);
}

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

/* ----------------- Rendering ----------------- */

function renderMainMessages(listEl, msgs) {
  if (!listEl) return;

  listEl.innerHTML = "";

  msgs.forEach((m) => {
    const wrapper = document.createElement("div");
    wrapper.className = "chat-message";
    if (currentUser && m.userId === currentUser.id) wrapper.classList.add("me");

    const meta = document.createElement("div");
    meta.className = "chat-message-meta";
    meta.textContent = `${m.name} (${m.role}) • ${formatTime(m.ts)}`;

    const text = document.createElement("div");
    text.className = "chat-message-text";
    text.textContent = m.text || "";

    wrapper.appendChild(meta);
    wrapper.appendChild(text);

    listEl.appendChild(wrapper);
  });
}

function renderFloatingMessages(floatList, msgs) {
  if (!floatList) return;

  floatList.innerHTML = "";

  msgs.forEach((m) => {
    const wrapper = document.createElement("div");
    wrapper.className = "chat-message";
    if (currentUser && m.userId === currentUser.id) wrapper.classList.add("me");

    const meta = document.createElement("div");
    meta.className = "chat-message-meta";
    meta.textContent = `${m.name} • ${formatTime(m.ts)}`;

    const text = document.createElement("div");
    text.className = "chat-message-text";
    text.textContent = m.text || "";

    wrapper.appendChild(meta);
    wrapper.appendChild(text);

    floatList.appendChild(wrapper);
  });
}

function formatTime(ts) {
  if (!ts) return "";
  let dateObj;
  if (ts.toDate) dateObj = ts.toDate();
  else if (ts instanceof Date) dateObj = ts;
  else dateObj = new Date(ts);

  return dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}


