// messages.js – Firestore chat (NO limit()) + lazy render on scroll up
import { db, fs } from "./firebase.js";

const { collection, addDoc, query, where, orderBy, onSnapshot, serverTimestamp } = fs;

const USER_KEY = "telesyrianaUser";
const MESSAGES_COL = "globalMessages";

let currentUser = null;
let currentRoom = "general";

let unsubscribeMain = null;
let unsubscribeFloat = null;

// ====== "بديل limit": نحن منعرض فقط آخر N بالواجهة ======
const PAGE_SIZE = 50;      // عدد الرسائل اللي منعرضها بالدفعة
const MAX_RENDER = 600;    // حماية: ما نعرض أكتر من هيك بالواجهة

// مخزن محلي لرسائل الغرفة الحالية (مرتبة تصاعدي: القديم -> الجديد)
let roomCache = [];
let renderedCount = 0;     // كم رسالة معروضة حالياً

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

function renderChunkToTop(listEl, items, showRole) {
  // يضيف عناصر فوق بدون ما يضيع مكان السكرول
  const prevScrollHeight = listEl.scrollHeight;
  const prevScrollTop = listEl.scrollTop;

  const frag = document.createDocumentFragment();

  items.forEach((m) => {
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
    frag.appendChild(wrapper);
  });

  // حطهم بالبداية
  listEl.prepend(frag);

  // رجّع نفس مكان السكرول تقريباً
  const newScrollHeight = listEl.scrollHeight;
  listEl.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
}

function renderFresh(listEl, msgs, showRole) {
  listEl.innerHTML = "";
  const frag = document.createDocumentFragment();

  msgs.forEach((m) => {
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
    frag.appendChild(wrapper);
  });

  listEl.appendChild(frag);
  listEl.scrollTop = listEl.scrollHeight;
}

function applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl) {
  const meta = ROOM_META[room] || {};
  if (roomNameEl) roomNameEl.textContent = meta.name || room;
  if (roomDescEl) roomDescEl.textContent = meta.desc || "Internal chat room.";
}

function setActiveRoomButton(room, roomButtons) {
  roomButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.room === room));
}

// ====== الاشتراك الرئيسي ======
function subscribeMainToRoom(room, listEl) {
  if (!listEl) return;
  unsubscribeMain?.();

  // ✅ حتى ما يحتاج Index جديد عندك: room ASC + ts DESC كان ظاهر بالصور
  const qRoom = query(
    collection(db, MESSAGES_COL),
    where("room", "==", room),
    orderBy("ts", "desc")
  );

  unsubscribeMain = onSnapshot(
    qRoom,
    (snapshot) => {
      setCurrentUser();

      // جيب كل الرسائل من السيرفر (بدون limit) بس رح نتحكم بالعرض فقط
      const all = [];
      snapshot.forEach((d) => all.push({ id: d.id, ...d.data() }));

      // حالياً all مرتب DESC (الجديد -> القديم) بسبب orderBy desc
      // نحن بدنا cache ASC (القديم -> الجديد)
      all.reverse();
      roomCache = all;

      // نعرض آخر PAGE_SIZE فقط (أحدث)
      renderedCount = Math.min(PAGE_SIZE, roomCache.length);
      const startIndex = Math.max(0, roomCache.length - renderedCount);
      const initial = roomCache.slice(startIndex);

      renderFresh(listEl, initial, true);
      attachScrollLoader(listEl); // فعّل التحميل عند السكرول لفوق
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

  unsubscribeFloat = onSnapshot(qGeneral, (snapshot) => {
    setCurrentUser();
    const all = [];
    snapshot.forEach((d) => all.push({ id: d.id, ...d.data() }));
    all.reverse();

    // نعرض فقط آخر 30 بالـ floating (بدون limit)
    const last = all.slice(Math.max(0, all.length - 30));
    renderFresh(floatList, last, false);
  });
}

// ====== تحميل قديم عند scroll up (من الكاش، بدون أي query إضافي) ======
let scrollBound = false;
function attachScrollLoader(listEl) {
  if (scrollBound) return;
  scrollBound = true;

  // Loading indicator فوق
  const loader = document.createElement("div");
  loader.id = "chat-top-loader";
  loader.style.display = "none";
  loader.style.padding = "8px";
  loader.style.textAlign = "center";
  loader.style.fontSize = "12px";
  loader.style.color = "#777";
  loader.textContent = "Loading older messages…";
  listEl.prepend(loader);

  listEl.addEventListener("scroll", () => {
    // إذا وصل لفوق تقريباً
    if (listEl.scrollTop <= 40) {
      // إذا ما في شي أقدم
      const total = roomCache.length;
      const alreadyRenderedStartIndex = Math.max(0, total - renderedCount);
      if (alreadyRenderedStartIndex <= 0) return;

      // لا تخلّيها تكبر بلا حدود
      if (renderedCount >= MAX_RENDER) return;

      loader.style.display = "block";

      // حمّل دفعة أقدم من الكاش
      const addCount = Math.min(PAGE_SIZE, alreadyRenderedStartIndex);
      const newStart = alreadyRenderedStartIndex - addCount;
      const chunk = roomCache.slice(newStart, alreadyRenderedStartIndex);

      renderedCount += chunk.length;

      // أضفها فوق مع الحفاظ على مكان السكرول
      renderChunkToTop(listEl, chunk, true);

      // اخفي اللودر بسرعة
      setTimeout(() => (loader.style.display = "none"), 150);
    }
  });
}

// ====== init ======
document.addEventListener("DOMContentLoaded", () => {
  const pageMessages = document.getElementById("page-messages");
  if (!pageMessages) return;

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

  // scroll
  if (listEl) {
    listEl.style.overflowY = "auto";
    listEl.style.maxHeight = "60vh";
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

  const supBtn = document.querySelector('.chat-room[data-room="supervisors"]');
  if (supBtn && (!currentUser || currentUser.role !== "supervisor")) supBtn.classList.add("hidden");

  // Floating toggle (إذا بدك تخليه حسب app.js، خليه hidden وطلعوا من app.js)
  if (floatToggle && currentUser) floatToggle.classList.remove("hidden");

  roomButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const room = btn.dataset.room;
      currentRoom = room;
      applyRoomMeta(room, ROOM_META, roomNameEl, roomDescEl);
      setActiveRoomButton(room, roomButtons);

      // reset scroll binding for new list (بس نخليها مرة وحدة)
      scrollBound = false;
      subscribeMainToRoom(room, listEl);
    });
  });

  formEl?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;

    setCurrentUser();
    if (!currentUser) return alert("Please login first.");

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

  floatToggle?.addEventListener("click", () => floatPanel?.classList.toggle("hidden"));
  floatClose?.addEventListener("click", () => floatPanel?.classList.add("hidden"));

  floatForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = floatInput.value.trim();
    if (!text) return;

    setCurrentUser();
    if (!currentUser) return alert("Please login first.");

    await addDoc(collection(db, MESSAGES_COL), {
      room: "general",
      text,
      userId: currentUser.id,
      name: currentUser.name,
      role: currentUser.role,
      ts: serverTimestamp(),
    });

    floatInput.value = "";
  });

  applyRoomMeta(currentRoom, ROOM_META, roomNameEl, roomDescEl);
  setActiveRoomButton(currentRoom, roomButtons);

  subscribeMainToRoom(currentRoom, listEl);
  subscribeFloatToGeneral(floatList);
});
