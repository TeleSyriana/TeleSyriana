// messages.js – TeleSyriana chat (Firestore realtime)
// غرف: general + supervisors
// - إخفاء غرفة المشرفين عن الـ agents
// - استخدام currentUser من localStorage
// - تخزين الرسائل في Firestore (collection: chatMessages)
// - عرض الرسائل realtime في صفحة Messages + الشات العائم

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

const USER_KEY = "telesyrianaUser";
const CHAT_COL = "chatMessages";

let currentUser = null;
let currentRoom = "general";
let roomUnsubscribe = null;   // listener الرئيسي
let floatUnsubscribe = null;  // listener للشات العائم (general فقط)

document.addEventListener("DOMContentLoaded", () => {
  const pageMessages = document.getElementById("page-messages");
  if (!pageMessages) return;

  // عناصر صفحة المسجات
  const roomButtons = document.querySelectorAll(".chat-room");
  const roomNameEl = document.getElementById("chat-room-name");
  const roomDescEl = document.getElementById("chat-room-desc");
  const listEl = document.getElementById("chat-message-list");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");

  // عناصر الشات العائم
  const floatToggle = document.getElementById("float-chat-toggle");
  const floatPanel = document.getElementById("float-chat-panel");
  const floatClose = document.getElementById("float-chat-close");
  const floatList = document.getElementById("float-chat-messages");
  const floatForm = document.getElementById("float-chat-form");
  const floatInput = document.getElementById("float-chat-input");

  loadUserFromStorage();

  // إخفاء غرفة المشرفين عن الـ agents
  const supBtn = document.querySelector('.chat-room[data-room="supervisors"]');
  if (supBtn && (!currentUser || currentUser.role !== "supervisor")) {
    supBtn.classList.add("hidden");
  }

  // إظهار زر الشات العائم فقط لما يكون في مستخدم
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
      desc: "Supervisor-only space for internal notes.",
    },
  };

  // تبديل الغرفة
  roomButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const room = btn.dataset.room;
      switchRoom(room, ROOM_META, roomButtons, roomNameEl, roomDescEl, listEl);
    });
  });

  // إرسال رسالة من الشات الرئيسي
  if (formEl && inputEl) {
    formEl.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text || !currentUser) return;

      try {
        await addDoc(collection(db, CHAT_COL), {
          room: currentRoom,
          text,
          userId: currentUser.id,
          name: currentUser.name,
          role: currentUser.role,
          ts: serverTimestamp(),
        });
        inputEl.value = "";
      } catch (err) {
        console.error("Error sending message:", err);
        alert("Error sending message: " + (err.message || "Unknown error"));
      }
    });
  }

  // شات عائم – فتح/إغلاق
  if (floatToggle && floatPanel) {
    floatToggle.addEventListener("click", () => {
      floatPanel.classList.toggle("hidden");
    });
  }
  if (floatClose && floatPanel) {
    floatClose.addEventListener("click", () => {
      floatPanel.classList.add("hidden");
    });
  }

  // إرسال رسالة من الشات العائم (دائماً على general)
  if (floatForm && floatInput) {
    floatForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = floatInput.value.trim();
      if (!text || !currentUser) return;

      try {
        await addDoc(collection(db, CHAT_COL), {
          room: "general",
          text,
          userId: currentUser.id,
          name: currentUser.name,
          role: currentUser.role,
          ts: serverTimestamp(),
        });
        floatInput.value = "";
      } catch (err) {
        console.error("Error sending message (floating):", err);
        alert("Error sending message: " + (err.message || "Unknown error"));
      }
    });
  }

  // أول اشتراك على غرفة general
  applyRoomMeta(currentRoom, ROOM_META, roomNameEl, roomDescEl);
  setActiveRoomButton(currentRoom, roomButtons);
  subscribeToRoom(currentRoom, listEl);

  // اشتراك ثابت للشات العائم على general فقط
  subscribeFloatingChat(floatList);
});


// ----------------- Helpers -----------------

function loadUserFromStorage() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return;
    const u = JSON.parse(raw);
    if (u && u.id && u.name && u.role) {
      currentUser = u;
    }
  } catch (e) {
    console.error("Error loading user from localStorage", e);
  }
}

function switchRoom(room, ROOM_META, roomButtons, roomNameEl, roomDescEl, listEl) {
  if (!room || (room !== "general" && room !== "supervisors")) return;
  currentRoom = room;
  applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl);
  setActiveRoomButton(room, roomButtons);
  subscribeToRoom(room, listEl);
}

function applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl) {
  const meta = ROOM_META[room] || {};
  if (roomNameEl) roomNameEl.textContent = meta.name || room;
  if (roomDescEl) roomDescEl.textContent =
    meta.desc || "Internal chat room.";
}

function setActiveRoomButton(room, roomButtons) {
  roomButtons.forEach((btn) => {
    if (btn.dataset.room === room) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
}


// ----------------- Firestore subscriptions -----------------

function subscribeToRoom(room, listEl) {
  // فك الاشتراك القديم
  if (roomUnsubscribe) {
    roomUnsubscribe();
    roomUnsubscribe = null;
  }
  if (!listEl) return;

  const qRoom = query(
    collection(db, CHAT_COL),
    where("room", "==", room),
    orderBy("ts", "asc")
  );

  roomUnsubscribe = onSnapshot(
    qRoom,
    (snapshot) => {
      const msgs = [];
      snapshot.forEach((doc) => {
        const d = doc.data();
        msgs.push({
          id: doc.id,
          ...d,
        });
      });
      renderMessages(listEl, msgs);
    },
    (err) => {
      console.error("Error listening to room:", err);
    }
  );
}

function subscribeFloatingChat(floatList) {
  if (!floatList) return;

  if (floatUnsubscribe) {
    floatUnsubscribe();
    floatUnsubscribe = null;
  }

  const qGeneral = query(
    collection(db, CHAT_COL),
    where("room", "==", "general"),
    orderBy("ts", "asc")
  );

  floatUnsubscribe = onSnapshot(
    qGeneral,
    (snapshot) => {
      const msgs = [];
      snapshot.forEach((doc) => {
        const d = doc.data();
        msgs.push({
          id: doc.id,
          ...d,
        });
      });
      renderFloatingMessages(floatList, msgs);
    },
    (err) => {
      console.error("Error listening to floating chat:", err);
    }
  );
}


// ----------------- Rendering -----------------

function renderMessages(listEl, msgs) {
  if (!listEl) return;
  listEl.innerHTML = "";

  msgs.forEach((m) => {
    const wrapper = document.createElement("div");
    wrapper.className = "chat-message";
    if (currentUser && m.userId === currentUser.id) {
      wrapper.classList.add("me");
    }

    const meta = document.createElement("div");
    meta.className = "chat-message-meta";
    const timeStr = formatTime(m.ts);
    meta.textContent = `${m.name} (${m.role}) • ${timeStr}`;

    const text = document.createElement("div");
    text.className = "chat-message-text";
    text.textContent = m.text;

    wrapper.appendChild(meta);
    wrapper.appendChild(text);

    listEl.appendChild(wrapper);
  });

  listEl.scrollTop = listEl.scrollHeight;
}

function renderFloatingMessages(floatList, msgs) {
  if (!floatList) return;
  floatList.innerHTML = "";

  msgs.forEach((m) => {
    const wrapper = document.createElement("div");
    wrapper.className = "chat-message";
    if (currentUser && m.userId === currentUser.id) {
      wrapper.classList.add("me");
    }

    const meta = document.createElement("div");
    meta.className = "chat-message-meta";
    const timeStr = formatTime(m.ts);
    meta.textContent = `${m.name} • ${timeStr}`;

    const text = document.createElement("div");
    text.className = "chat-message-text";
    text.textContent = m.text;

    wrapper.appendChild(meta);
    wrapper.appendChild(text);

    floatList.appendChild(wrapper);
  });

  floatList.scrollTop = floatList.scrollHeight;
}

function formatTime(ts) {
  if (!ts) return "";
  // ts ممكن يكون Timestamp تبع Firestore
  if (ts.toDate) {
    ts = ts.toDate();
  }
  const d = ts instanceof Date ? ts : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}




