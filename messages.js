// messages.js – TeleSyriana chat UI with Firestore
import { db, fs } from "./firebase.js";

const {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp, // ✅ من firebase.js
} = fs;

const USER_KEY = "telesyrianaUser";
const MESSAGES_COL = "globalMessages";

let currentUser = null;
let currentRoom = "general";

let unsubscribeMain = null;
let unsubscribeFloat = null;

function loadUserFromStorage() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return;
    const u = JSON.parse(raw);
    if (u?.id && u?.name && u?.role) currentUser = u;
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

  // ✅ تأكد في scroll (حتى لو CSS ناقص)
  if (listEl) {
    listEl.style.overflowY = "auto";
    listEl.style.maxHeight = "60vh";
  }
  if (floatList) {
    floatList.style.overflowY = "auto";
    floatList.style.maxHeight = "220px";
  }

  // تبديل الغرف
  roomButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const room = btn.dataset.room;
      currentRoom = room;
      applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl);
      setActiveRoomButton(room, roomButtons);
      subscribeMainToRoom(room, listEl);
    });
  });

  // إرسال رسالة من الشات الرئيسي
  if (formEl && inputEl) {
    formEl.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text) return;

      if (!currentUser) return alert("Please login first.");

      try {
        await addDoc(collection(db, MESSAGES_COL), {
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

  // إرسال رسالة من الشات العائم (دائماً general)
  if (floatForm && floatInput) {
    floatForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = floatInput.value.trim();
      if (!text) return;

      if (!currentUser) return alert("Please login first.");

      try {
        await addDoc(collection(db, MESSAGES_COL), {
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

  // ✅ اشتراكات
  applyRoomMeta(currentRoom, ROOM_META, roomNameEl, roomDescEl);
  setActiveRoomButton(currentRoom, roomButtons);

  subscribeMainToRoom(currentRoom, listEl);
  subscribeFloatToGeneral(floatList);
});

/* ------------ Firestore subscriptions ------------ */

// ✅ مهم: نستخدم DESC ليتطابق مع الـ index الموجود عندك (room ASC + ts DESC)
// وبعدين نعكس بالعرض ليظهر من القديم للجديد
function subscribeMainToRoom(room, listEl) {
  if (!listEl) return;

  if (unsubscribeMain) unsubscribeMain();

  const qRoom = query(
    collection(db, MESSAGES_COL),
    where("room", "==", room),
    orderBy("ts", "desc"),
    limit(100)
  );

  unsubscribeMain = onSnapshot(
    qRoom,
    (snapshot) => {
      const msgs = [];
      snapshot.forEach((docSnap) => msgs.push({ id: docSnap.id, ...docSnap.data() }));
      msgs.reverse(); // ✅ يخلي القديم فوق
      renderMainMessages(listEl, msgs);
    },
    (err) => {
      console.error("Main snapshot error:", err);
      alert("Firestore error: " + err.message);
    }
  );
}

function subscribeFloatToGeneral(floatList) {
  if (!floatList) return;

  if (unsubscribeFloat) unsubscribeFloat();

  const qGeneral = query(
    collection(db, MESSAGES_COL),
    where("room", "==", "general"),
    orderBy("ts", "desc"),
    limit(50)
  );

  unsubscribeFloat = onSnapshot(
    qGeneral,
    (snapshot) => {
      const msgs = [];
      snapshot.forEach((docSnap) => msgs.push({ id: docSnap.id, ...docSnap.data() }));
      msgs.reverse();
      renderFloatingMessages(floatList, msgs);
    },
    (err) => {
      console.error("Float snapshot error:", err);
    }
  );
}

/* ----------------- Helpers ----------------- */

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

  // ✅ auto scroll للأسفل دائماً
  listEl.scrollTop = listEl.scrollHeight;
}

function renderFloatingMessages(floatList, msgs) {
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

  floatList.scrollTop = floatList.scrollHeight;
}

function formatTime(ts) {
  if (!ts) return "";
  const dateObj = ts.toDate ? ts.toDate() : new Date(ts);
  return dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}


