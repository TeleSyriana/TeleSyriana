// messages.js – Firestore chat (NO limit()) + lazy render on scroll up
import { db, fs } from "./firebase.js";

const { collection, addDoc, query, where, orderBy, onSnapshot, serverTimestamp } = fs;

const USER_KEY = "telesyrianaUser";
const MESSAGES_COL = "globalMessages";

let currentUser = null;
let currentRoom = "general";

let unsubscribeMain = null;
let unsubscribeFloat = null;

// ====== "بديل limit": نعرض فقط آخر N بالواجهة ======
const PAGE_SIZE = 50;
const MAX_RENDER = 600;

// cache للغرفة الحالية (ASC: القديم -> الجديد)
let roomCache = [];
let renderedCount = 0;

// لمنع تكرار ربط السكرول على نفس list
let scrollBoundEl = null;

function getUserFromStorage() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    if (u?.id && u?.name && u?.role) return u;
  } catch {}
  return null;
}

function setCurrentUser() {
  currentUser = getUserFromStorage();
}

function formatTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ensureTopLoader(listEl) {
  let loader = listEl.querySelector("#chat-top-loader");
  if (!loader) {
    loader = document.createElement("div");
    loader.id = "chat-top-loader";
    loader.style.display = "none";
    loader.style.padding = "8px";
    loader.style.textAlign = "center";
    loader.style.fontSize = "12px";
    loader.style.color = "#777";
    loader.textContent = "Loading older messages…";
    listEl.prepend(loader);
  }
  return loader;
}

function createMessageNode(m, showRole) {
  const wrapper = document.createElement("div");
  wrapper.className = "chat-message";
  if (currentUser && m.userId === currentUser.id) wrapper.classList.add("me");

  const meta = document.createElement("div");
  meta.className = "chat-message-meta";
  meta.textContent = showRole
    ? `${m.name} (${m.role}) • ${formatTime(m.ts)}`
    : `${m.name} • ${formatTime(m.ts)}`;

  const text = document.createElement("div");
  text.className = "chat-message-text";
  text.textContent = m.text || "";

  wrapper.appendChild(meta);
  wrapper.appendChild(text);
  return wrapper;
}

function renderFresh(listEl, msgs, showRole) {
  const loader = ensureTopLoader(listEl);

  // امسح كلشي ما عدا اللودر
  Array.from(listEl.children).forEach((ch) => {
    if (ch !== loader) ch.remove();
  });

  const frag = document.createDocumentFragment();
  msgs.forEach((m) => frag.appendChild(createMessageNode(m, showRole)));
  listEl.appendChild(frag);

  listEl.scrollTop = listEl.scrollHeight;
}

function renderChunkToTop(listEl, items, showRole) {
  const loader = ensureTopLoader(listEl);

  const prevScrollHeight = listEl.scrollHeight;
  const prevScrollTop = listEl.scrollTop;

  const frag = document.createDocumentFragment();
  items.forEach((m) => frag.appendChild(createMessageNode(m, showRole)));

  // ✅ حط الرسائل بعد اللودر مباشرة
  const afterLoader = loader.nextSibling;
  if (afterLoader) listEl.insertBefore(frag, afterLoader);
  else listEl.appendChild(frag);

  const newScrollHeight = listEl.scrollHeight;
  listEl.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
}

function applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl) {
  const meta = ROOM_META[room] || {};
  if (roomNameEl) roomNameEl.textContent = meta.name || room;
  if (roomDescEl) roomDescEl.textContent = meta.desc || "Internal chat room.";
}

function setActiveRoomButton(room, roomButtons) {
  roomButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.room === room));
}

// ====== تحميل قديم عند scroll up (من الكاش فقط) ======
function attachScrollLoader(listEl) {
  if (!listEl) return;

  // ✅ لا تربطه مرتين على نفس الـ element
  if (scrollBoundEl === listEl) return;
  scrollBoundEl = listEl;

  const loader = ensureTopLoader(listEl);

  listEl.addEventListener("scroll", () => {
    if (listEl.scrollTop > 40) return;

    const total = roomCache.length;
    const alreadyRenderedStartIndex = Math.max(0, total - renderedCount);

    if (alreadyRenderedStartIndex <= 0) return; // ما في أقدم
    if (renderedCount >= MAX_RENDER) return; // حماية

    loader.style.display = "block";

    const addCount = Math.min(PAGE_SIZE, alreadyRenderedStartIndex);
    const newStart = alreadyRenderedStartIndex - addCount;
    const chunk = roomCache.slice(newStart, alreadyRenderedStartIndex);

    renderedCount += chunk.length;
    renderChunkToTop(listEl, chunk, true);

    setTimeout(() => (loader.style.display = "none"), 150);
  });
}

// ====== الاشتراك الرئيسي ======
function subscribeMainToRoom(room, listEl) {
  if (!listEl) return;
  unsubscribeMain?.();

  // ✅ متوافق مع index: room + ts DESC
  const qRoom = query(
    collection(db, MESSAGES_COL),
    where("room", "==", room),
    orderBy("ts", "desc")
  );

  unsubscribeMain = onSnapshot(
    qRoom,
    (snapshot) => {
      setCurrentUser();

      const all = [];
      snapshot.forEach((d) => all.push({ id: d.id, ...d.data() }));

      // DESC => نخليه cache ASC
      all.reverse();
      roomCache = all;

      renderedCount = Math.min(PAGE_SIZE, roomCache.length);
      const startIndex = Math.max(0, roomCache.length - renderedCount);
      const initial = roomCache.slice(startIndex);

      renderFresh(listEl, initial, true);
      attachScrollLoader(listEl);
    },
    (err) => {
      console.error("Main snapshot error:", err);
      alert("Firestore error: " + err.message);
    }
  );
}

// ====== الشات العائم (general فقط) ======
function subscribeFloatToGeneral(floatList) {
  if (!floatList) return;
  unsubscribeFloat?.();

  const qGeneral = query(
    collection(db, MESSAGES_COL),
    where("room", "==", "general"),
    orderBy("ts", "desc")
  );

  unsubscribeFloat = onSnapshot(
    qGeneral,
    (snapshot) => {
      setCurrentUser();

      const all = [];
      snapshot.forEach((d) => all.push({ id: d.id, ...d.data() }));
      all.reverse();

      const last = all.slice(Math.max(0, all.length - 30));

      floatList.innerHTML = "";
      const frag = document.createDocumentFragment();
      last.forEach((m) => frag.appendChild(createMessageNode(m, false)));
      floatList.appendChild(frag);
      floatList.scrollTop = floatList.scrollHeight;
    },
    (err) => {
      console.error("Float snapshot error:", err);
    }
  );
}

// ====== init ======
document.addEventListener("DOMContentLoaded", () => {
  // ✅ تصحيح: getElementById (مو ByID)
  const hasMainChat = !!document.getElementById("chat-message-list");

  const roomButtons = document.querySelectorAll(".chat-room");
  const roomNameEl = document.getElementById("chat-room-name");
  const roomDescEl = document.getElementById("chat-room-desc");
  const listEl = document.getElementById("chat-message-list");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");

  const floatToggle = document.getElementById("float-chat-toggle");
  const floatPanel = document.getElementById("float-chat-panel");
  const floatClose = document.getElementById("float-chat-close");
  const floatList = document.getElementById("float-chat-messages");
  const floatForm = document.getElementById("float-chat-form");
  const floatInput = document.getElementById("float-chat-input");

  setCurrentUser();

  // scroll styles
  if (listEl) {
    listEl.style.overflowY = "auto";
    listEl.style.maxHeight = "60vh";
  }
  if (floatList) {
    floatList.style.overflowY = "auto";
    floatList.style.maxHeight = "220px";
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

  // اخفاء supervisors عن agent
  const supBtn = document.querySelector('.chat-room[data-room="supervisors"]');
  if (supBtn && (!currentUser || currentUser.role !== "supervisor")) supBtn.classList.add("hidden");

  // ✅ pop chat: شغّله بكل الصفحات إذا المستخدم موجود
  if (floatToggle && currentUser) floatToggle.classList.remove("hidden");

  // floating open/close
  floatToggle?.addEventListener("click", () => floatPanel?.classList.toggle("hidden"));
  floatClose?.addEventListener("click", () => floatPanel?.classList.add("hidden"));

  // floating send
  floatForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = floatInput.value.trim();
    if (!text) return;

    setCurrentUser();
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

  // ✅ main chat: فقط إذا الصفحة فيها عناصر المسجات
  if (hasMainChat && listEl) {
    applyRoomMeta(currentRoom, ROOM_META, roomNameEl, roomDescEl);
    setActiveRoomButton(currentRoom, roomButtons);

    roomButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const room = btn.dataset.room;
        currentRoom = room;

        applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl);
        setActiveRoomButton(room, roomButtons);

        // reset binding when switching room
        scrollBoundEl = null;

        subscribeMainToRoom(room, listEl);
      });
    });

    formEl?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text) return;

      setCurrentUser();
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

    subscribeMainToRoom(currentRoom, listEl);
  }

  // ✅ floating subscription دائماً
  subscribeFloatToGeneral(floatList);
});

// ✅ إذا بتعمل login بدون refresh: نقدر نحدّث زر 💬
window.addEventListener("telesyriana:user-changed", () => {
  setCurrentUser();
  const floatToggle = document.getElementById("float-chat-toggle");
  if (floatToggle && currentUser) floatToggle.classList.remove("hidden");
});
