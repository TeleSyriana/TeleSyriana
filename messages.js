// messages.js – TeleSyriana chat UI with Firestore
// غرف: general + supervisors
// الشات العائم دائماً يعرض general فقط

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
const MESSAGES_COL = "globalMessages";

let currentUser = null;
let currentRoom = "general";

// اشتراكات Firestore
let unsubscribeMain = null;   // الشات الرئيسي
let unsubscribeFloat = null;  // الشات العائم (general)

// تحميل المستخدم من localStorage
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

  // إظهار زر البالونة فقط إذا في مستخدم داخل
  if (floatToggle && currentUser) {
    floatToggle.classList.remove("hidden");
  }

  // وصف الغرف
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

  // تبديل الغرف
  roomButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const room = btn.dataset.room;
      switchRoom(
        room,
        ROOM_META,
        roomButtons,
        roomNameEl,
        roomDescEl,
        listEl
      );
    });
  });

  // إرسال رسالة من الشات الرئيسي
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
      } catch (err) {
        console.error("Error sending message", err);
        alert("Error sending message: " + err.message);
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

  // إرسال رسالة من الشات العائم (دائماً للـ general)
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

  // أول اشتراك: الغرفة الحالية في الشات الرئيسي
  subscribeMainToRoom(currentRoom, listEl);
  // اشتراك ثابت للغرفة العامة في الشات العائم
  subscribeFloatToGeneral(floatList);

  // ضبط العناوين + الزر active
  applyRoomMeta(currentRoom, ROOM_META, roomNameEl, roomDescEl);
  setActiveRoomButton(currentRoom, roomButtons);
});

/* ------------ Firestore subscriptions ------------ */

function subscribeMainToRoom(room, listEl) {
  if (!listEl) return;

  if (unsubscribeMain) unsubscribeMain();

  const colRef = collection(db, MESSAGES_COL);
  const qRoom = query(
  colRef,
  where("room", "==", room),
  orderBy("ts", "desc")
);


  unsubscribeMain = onSnapshot(qRoom, (snapshot) => {
    const msgs = [];
    snapshot.forEach((docSnap) => {
      msgs.push({ id: docSnap.id, ...docSnap.data() });
    });
    renderMainMessages(listEl, msgs);
  });
}

function subscribeFloatToGeneral(floatList) {
  if (!floatList) return;

  if (unsubscribeFloat) unsubscribeFloat();

  const colRef = collection(db, MESSAGES_COL);
  const qGeneral = query(
  colRef,
  where("room", "==", "general"),
  orderBy("ts", "desc")
);


  unsubscribeFloat = onSnapshot(qGeneral, (snapshot) => {
    const msgs = [];
    snapshot.forEach((docSnap) => {
      msgs.push({ id: docSnap.id, ...docSnap.data() });
    });
    renderFloatingMessages(floatList, msgs);
  });
}

/* ----------------- Helpers ----------------- */

function switchRoom(
  room,
  ROOM_META,
  roomButtons,
  roomNameEl,
  roomDescEl,
  listEl
) {
  currentRoom = room;
  applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl);
  setActiveRoomButton(room, roomButtons);
  subscribeMainToRoom(room, listEl);
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

/* ----------------- Rendering ----------------- */

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
  // ts ممكن يكون Timestamp تبع Firestore أو Date عادي
  let dateObj;
  if (ts.toDate) {
    dateObj = ts.toDate();
  } else if (ts instanceof Date) {
    dateObj = ts;
  } else {
    dateObj = new Date(ts);
  }
  return dateObj.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}






