// messages.js – TeleSyriana chat UI (Firestore realtime)
// - غرف: general + supervisors
// - إخفاء supervisors عن الـ agents
// - استخدام currentUser من localStorage
// - شات أساسي + شات عائم (floating) لنفس الـ collection

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

// unsub لكل غرفة
const roomUnsub = {
  general: null,
  supervisors: null,
};

// كاش للرسائل
const messagesCache = {
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

  // عناصر الشات العائم (floating)
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

  // بالونة الشات العائم تظهر فقط إذا في مستخدم
  if (floatToggle && currentUser) {
    floatToggle.classList.remove("hidden");
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

  // تبديل الغرف من القائمة الجانبية
  roomButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const room = btn.dataset.room;
      switchRoom(
        room,
        ROOM_META,
        roomButtons,
        roomNameEl,
        roomDescEl,
        listEl,
        floatList
      );
    });
  });

  // إرسال رسالة من الشات الرئيسي
  if (formEl && inputEl) {
    formEl.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text) return;

      await sendMessage(currentRoom, text);
      inputEl.value = "";
    });
  }

  // شات عائم – فتح/إغلاق
  if (floatToggle && floatPanel) {
    floatToggle.addEventListener("click", () => {
      floatPanel.classList.toggle("hidden");
      if (!floatPanel.classList.contains("hidden")) {
        renderFloatingMessages(floatList, messagesCache.general);
      }
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
      if (!text) return;

      await sendMessage("general", text);
      floatInput.value = "";
    });
  }

  // أول تشغيل: اشترك بغرفة general واعرضها
  subscribeRoom("general", listEl, floatList);
  switchRoom(
    "general",
    ROOM_META,
    roomButtons,
    roomNameEl,
    roomDescEl,
    listEl,
    floatList
  );
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

async function sendMessage(room, text) {
  const u = currentUser || {
    id: "guest",
    name: "Unknown",
    role: "agent",
  };

  try {
    await addDoc(collection(db, CHAT_COL), {
      room,
      userId: u.id,
      name: u.name,
      role: u.role,
      text,
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.error("Error sending message", e);
  }
}

function switchRoom(
  room,
  ROOM_META,
  roomButtons,
  roomNameEl,
  roomDescEl,
  listEl,
  floatList
) {
  if (!["general", "supervisors"].includes(room)) return;

  currentRoom = room;
  applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl);
  setActiveRoomButton(room, roomButtons);

  // تأكد إنو في subscription لها الغرفة
  subscribeRoom(room, listEl, floatList);

  // ارسم اللي موجود بالكاش
  renderMainMessages(listEl, messagesCache[room] || []);

  if (room === "general") {
    renderFloatingMessages(floatList, messagesCache.general || []);
  }
}

function applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl) {
  const meta = ROOM_META[room] || {};
  if (roomNameEl) roomNameEl.textContent = meta.name || room;
  if (roomDescEl)
    roomDescEl.textContent = meta.desc || "Internal chat room.";
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

function subscribeRoom(room, listEl, floatList) {
  if (roomUnsub[room]) {
    // already subscribed
    return;
  }

  const q = query(
    collection(db, CHAT_COL),
    where("room", "==", room),
    orderBy("createdAt", "asc")
  );

  roomUnsub[room] = onSnapshot(
    q,
    (snapshot) => {
      const arr = [];
      snapshot.forEach((doc) => {
        arr.push({ id: doc.id, ...doc.data() });
      });
      messagesCache[room] = arr;

      // إذا هاي الغرفة حالياً مفتوحة، ارسمها
      if (currentRoom === room) {
        renderMainMessages(listEl, arr);
      }

      // دائماً حدّث الشات العائم للـ general
      if (room === "general") {
        renderFloatingMessages(floatList, arr);
      }
    },
    (err) => {
      console.error("Error in room subscription", room, err);
    }
  );
}

// ----------------- Rendering -----------------

function renderMainMessages(listEl, msgs) {
  if (!listEl) return;
  listEl.innerHTML = "";

  (msgs || []).forEach((m) => {
    const wrapper = document.createElement("div");
    wrapper.className = "chat-message";
    if (currentUser && m.userId === currentUser.id) {
      wrapper.classList.add("me");
    }

    const meta = document.createElement("div");
    meta.className = "chat-message-meta";
    const timeStr = formatTime(m.createdAt);
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

  (msgs || []).forEach((m) => {
    const wrapper = document.createElement("div");
    wrapper.className = "chat-message";
    if (currentUser && m.userId === currentUser.id) {
      wrapper.classList.add("me");
    }

    const meta = document.createElement("div");
    meta.className = "chat-message-meta";
    const timeStr = formatTime(m.createdAt);
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

function formatTime(val) {
  if (!val) return "";
  let d;
  // Firestore Timestamp
  if (val.toDate) {
    d = val.toDate();
  } else if (val instanceof Date) {
    d = val;
  } else {
    d = new Date(val);
  }
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

