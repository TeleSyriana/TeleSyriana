// messages.js – TeleSyriana chat UI (local demo)
// - غرف: General + Supervisors
// - إخفاء Supervisors عن الـ agents
// - استخدام currentUser من localStorage
// - شات أساسي + شات عائم (floating)

const USER_KEY = "telesyrianaUser";

// تخزين بسيط بالذاكرة (لسا بدون Firestore)
const MESSAGE_STORE = {
  general: [],
  supervisors: [],
};

let currentUser = null;
let currentRoom = "general";

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

  // ملاحظة: إظهار/إخفاء زر البالونة صار من app.js
  // هون بس نضيف الـ listeners لو العناصر موجودة

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
      switchRoom(room, ROOM_META, roomButtons, roomNameEl, roomDescEl, listEl, floatList);
    });
  });

  // إرسال رسالة من الشات الرئيسي
  if (formEl && inputEl) {
    formEl.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text) return;

      appendMessage(currentRoom, text);
      inputEl.value = "";
      renderMainMessages(listEl);
      renderFloatingMessages(floatList); // الشات العائم يعرض الـ general فقط
    });
  }

  // شات عائم – فتح/إغلاق (لو البالونة موجودة)
  if (floatToggle && floatPanel) {
    floatToggle.addEventListener("click", () => {
      floatPanel.classList.toggle("hidden");
      if (!floatPanel.classList.contains("hidden")) {
        renderFloatingMessages(floatList);
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
    floatForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = floatInput.value.trim();
      if (!text) return;

      appendMessage("general", text); // نثبّت إنها للغرفة العامة
      floatInput.value = "";
      renderMainMessages(listEl);      // لو فاتح صفحة Messages
      renderFloatingMessages(floatList);
    });
  }

  // أول رندر
  applyRoomMeta(currentRoom, ROOM_META, roomNameEl, roomDescEl);
  setActiveRoomButton(currentRoom, roomButtons);
  renderMainMessages(listEl);
  renderFloatingMessages(floatList);

  // رسالة ترحيبية واحدة بالـ General بأول مرة
  if (MESSAGE_STORE.general.length === 0) {
    MESSAGE_STORE.general.push({
      id: Date.now(),
      room: "general",
      userId: "system",
      name: "System",
      role: "system",
      text: "Welcome to the TeleSyriana general chat 👋",
      ts: new Date(),
    });
    renderMainMessages(listEl);
    renderFloatingMessages(floatList);
  }
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

function switchRoom(room, ROOM_META, roomButtons, roomNameEl, roomDescEl, listEl, floatList) {
  if (!MESSAGE_STORE[room]) return;
  currentRoom = room;
  applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl);
  setActiveRoomButton(room, roomButtons);
  renderMainMessages(listEl);
  if (room === "general") {
    renderFloatingMessages(floatList);
  }
}

function applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl) {
  const meta = ROOM_META[room] || {};
  if (roomNameEl) roomNameEl.textContent = meta.name || room;
  if (roomDescEl) {
    roomDescEl.textContent =
      meta.desc ||
      "Internal chat room.";
  }
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

function appendMessage(room, text) {
  const now = new Date();
  const msg = {
    id: now.getTime(),
    room,
    userId: currentUser ? currentUser.id : "guest",
    name: currentUser ? currentUser.name : "Unknown",
    role: currentUser ? currentUser.role : "agent",
    text,
    ts: now,
  };

  if (!MESSAGE_STORE[room]) {
    MESSAGE_STORE[room] = [];
  }
  MESSAGE_STORE[room].push(msg);
}

// ----------------- Rendering -----------------

function renderMainMessages(listEl) {
  if (!listEl) return;
  const msgs = MESSAGE_STORE[currentRoom] || [];

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

function renderFloatingMessages(floatList) {
  if (!floatList) return;
  const msgs = MESSAGE_STORE.general || [];

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
  const d = ts instanceof Date ? ts : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
