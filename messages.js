// messages.js – TeleSyriana chat UI (Firestore realtime)
// - Rooms: general + supervisors
// - Hide supervisors room for non-supervisors
// - Uses currentUser from localStorage (same key as app.js)
// - Realtime sync عبر Firestore + floating mini chat

import { db, fs } from "./firebase.js";

const {
  collection,
  doc,
  setDoc,
  getDoc,
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
let unsubscribeChat = null;

// نخزّن آخر رسائل معمول لها render بالذاكرة بس (للسكرول وغيره)
let lastMessagesForRoom = {
  general: [],
  supervisors: [],
};

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

  // تعريف وصف الغرف
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

  // لو في مستخدم محفوظ من قبل (auto-login) فعّل الاشتراك فوراً
  if (currentUser) {
    subscribeToRoom(currentRoom, {
      roomNameEl,
      roomDescEl,
      listEl,
      floatList,
      ROOM_META,
    });
  } else {
    // ما في مستخدم → نعطّل الـ form بس (احتياط)
    if (formEl) formEl.classList.add("hidden");
    if (floatToggle) floatToggle.classList.add("hidden");
  }

  // تبديل الغرف من القائمة الجانبية
  roomButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!ensureUser()) return;
      const room = btn.dataset.room;
      switchRoom(room, {
        ROOM_META,
        roomButtons,
        roomNameEl,
        roomDescEl,
        listEl,
        floatList,
      });
    });
  });

  // إرسال رسالة من الشات الرئيسي
  if (formEl && inputEl) {
    formEl.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!ensureUser()) return;

      const text = inputEl.value.trim();
      if (!text) return;

      await sendMessage(currentRoom, text);
      inputEl.value = "";
      // ما في داعي نعمل render يدوي، onSnapshot رح يحدّث لوحده
    });
  }

  // شات عائم – فتح/إغلاق
  if (floatToggle && floatPanel) {
    floatToggle.addEventListener("click", () => {
      if (!ensureUser()) return;

      floatPanel.classList.toggle("hidden");

      // أول ما يفتح، نتأكد المشتركين بالغرفة العامة
      if (!floatPanel.classList.contains("hidden")) {
        subscribeToRoom("general", {
          ROOM_META,
          roomButtons,
          roomNameEl,
          roomDescEl,
          listEl,
          floatList,
        });
        // عرض آخر رسائل محفوظة
        renderFloatingMessages(floatList, lastMessagesForRoom.general);
      }
    });
  }

  if (floatClose && floatPanel) {
    floatClose.addEventListener("click", () => {
      floatPanel.classList.add("hidden");
    });
  }

  // إرسال رسالة من الشات العائم (دائماً general)
  if (floatForm && floatInput) {
    floatForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!ensureUser()) return;

      const text = floatInput.value.trim();
      if (!text) return;

      await sendMessage("general", text);
      floatInput.value = "";
    });
  }

  // أول meta
  applyRoomMeta(currentRoom, ROOM_META, roomNameEl, roomDescEl);
  setActiveRoomButton(currentRoom, roomButtons);
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

function ensureUser() {
  if (!currentUser) {
    loadUserFromStorage();
  }
  if (!currentUser) {
    alert("Please login first to use chat.");
    return false;
  }
  return true;
}

function switchRoom(room, ctx) {
  if (!room || currentRoom === room) return;
  currentRoom = room;

  applyRoomMeta(room, ctx.ROOM_META, ctx.roomNameEl, ctx.roomDescEl);
  setActiveRoomButton(room, ctx.roomButtons);

  subscribeToRoom(room, ctx);
}

// اشتراك Firestore بالغرفة الحالية
async function subscribeToRoom(
  room,
  { ROOM_META, roomButtons, roomNameEl, roomDescEl, listEl, floatList }
) {
  if (!ensureUser()) return;

  // أوقف الاشتراك القديم
  if (unsubscribeChat) {
    unsubscribeChat();
    unsubscribeChat = null;
  }

  const colRef = collection(db, CHAT_COL);
  const qRoom = query(
    colRef,
    where("room", "==", room),
    orderBy("ts", "asc")
  );

  // تأمين رسالة system welcome لكل غرفة (doc ثابت ID)
  await ensureSystemWelcome(room);

  unsubscribeChat = onSnapshot(qRoom, (snapshot) => {
    const msgs = [];
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      msgs.push({
        ...data,
        id: docSnap.id,
      });
    });

    lastMessagesForRoom[room] = msgs;

    // إذا هاي الغرفة هي المفتوحة في الصفحة الرئيسية
    if (room === currentRoom) {
      renderMainMessages(listEl, msgs);
    }

    // الشات العائم يقرأ دائماً general
    if (room === "general" && floatList) {
      renderFloatingMessages(floatList, msgs);
    }
  });

  // حدّث الهيدر للغرفة
  applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl);
  setActiveRoomButton(room, roomButtons);
}

async function ensureSystemWelcome(room) {
  const id = `system_welcome_${room}`;
  const ref = doc(collection(db, CHAT_COL), id);
  const snap = await getDoc(ref);
  if (snap.exists()) return;

  let text = "";
  if (room === "general") {
    text = "Welcome to the TeleSyriana general chat 👋";
  } else if (room === "supervisors") {
    text = "Supervisor room – internal coordination only.";
  } else {
    text = "Welcome to this chat room.";
  }

  await setDoc(ref, {
    room,
    userId: "system",
    name: "System",
    role: "system",
    text,
    ts: serverTimestamp(),
  });
}

function applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl) {
  const meta = ROOM_META[room] || {};
  if (roomNameEl) roomNameEl.textContent = meta.name || room;
  if (roomDescEl)
    roomDescEl.textContent =
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

async function sendMessage(room, text) {
  if (!currentUser) return;

  const colRef = collection(db, CHAT_COL);
  const ref = doc(colRef); // auto ID

  await setDoc(ref, {
    room,
    userId: currentUser.id,
    name: currentUser.name,
    role: currentUser.role,
    text,
    ts: serverTimestamp(),
  });
}

// ----------------- Rendering -----------------

function renderMainMessages(listEl, msgs) {
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
  let d;
  // Firestore Timestamp
  if (ts.toDate && typeof ts.toDate === "function") {
    d = ts.toDate();
  } else if (ts instanceof Date) {
    d = ts;
  } else {
    d = new Date(ts);
  }
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
