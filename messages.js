// messages.js – Firestore chat (NO limit()) + lazy render on scroll up + Rooms + DMs + Status dots
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
const AGENT_DAYS_COL = "agentDays"; // ✅ status source (from app.js)
const PAGE_SIZE = 50;
const MAX_RENDER = 600;

let currentUser = null;

// selected conversation
let currentConversation = null; // { type:'room'|'dm'|'ai', roomId, title, desc, canSend }

// subscriptions
let unsubscribeMain = null;
let unsubscribeFloat = null;
let unsubscribeStatuses = null;

// cache for main list
let roomCache = [];
let renderedCount = 0;
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

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ====== Floating visibility rule ======
// hide always on messages page
function isMessagesPageActive() {
  const pg = document.querySelector(".page-section:not(.hidden)");
  return pg?.id === "page-messages";
}

function updateFloatingVisibility() {
  const floatToggle = document.getElementById("float-chat-toggle");
  if (!floatToggle) return;

  setCurrentUser();

  if (!currentUser) {
    floatToggle.classList.add("hidden");
    return;
  }

  if (isMessagesPageActive()) {
    floatToggle.classList.add("hidden");
    return;
  }

  floatToggle.classList.remove("hidden");
}

// ====== UI helpers ======
function setHeader(title, desc) {
  const roomNameEl = document.getElementById("chat-room-name");
  const roomDescEl = document.getElementById("chat-room-desc");
  if (roomNameEl) roomNameEl.textContent = title || "Messages";
  if (roomDescEl) roomDescEl.textContent = desc || "Start chatting…";
}

function setEmptyStateVisible(isVisible) {
  const empty = document.getElementById("chat-empty");
  const listEl = document.getElementById("chat-message-list");
  if (empty) empty.style.display = isVisible ? "block" : "none";
  if (listEl) listEl.style.display = isVisible ? "none" : "block";
}

function setInputEnabled(enabled) {
  const inputEl = document.getElementById("chat-input");
  const btn = document.querySelector("#chat-form button[type='submit']");
  if (inputEl) inputEl.disabled = !enabled;
  if (btn) btn.disabled = !enabled;
}

function clearActiveButtons() {
  document.querySelectorAll(".chat-room, .chat-dm").forEach((b) => b.classList.remove("active"));
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

  const afterLoader = loader.nextSibling;
  if (afterLoader) listEl.insertBefore(frag, afterLoader);
  else listEl.appendChild(frag);

  const newScrollHeight = listEl.scrollHeight;
  listEl.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
}

function attachScrollLoader(listEl) {
  if (!listEl) return;
  if (scrollBoundEl === listEl) return;
  scrollBoundEl = listEl;

  const loader = ensureTopLoader(listEl);

  listEl.addEventListener("scroll", () => {
    if (listEl.scrollTop > 40) return;

    const total = roomCache.length;
    const alreadyRenderedStartIndex = Math.max(0, total - renderedCount);

    if (alreadyRenderedStartIndex <= 0) return;
    if (renderedCount >= MAX_RENDER) return;

    loader.style.display = "block";

    const addCount = Math.min(PAGE_SIZE, alreadyRenderedStartIndex);
    const newStart = alreadyRenderedStartIndex - addCount;
    const chunk = roomCache.slice(newStart, alreadyRenderedStartIndex);

    renderedCount += chunk.length;
    renderChunkToTop(listEl, chunk, true);

    setTimeout(() => (loader.style.display = "none"), 150);
  });
}

// ====== RoomId builders ======
function makeDmRoomId(a, b) {
  const x = String(a);
  const y = String(b);
  const [min, max] = x < y ? [x, y] : [y, x];
  return `dm_${min}_${max}`;
}

// ====== Firestore subscriptions ======
function subscribeMainToRoom(roomId, listEl) {
  if (!listEl) return;
  unsubscribeMain?.();

  const qRoom = query(
    collection(db, MESSAGES_COL),
    where("room", "==", roomId),
    orderBy("ts", "desc")
  );

  unsubscribeMain = onSnapshot(
    qRoom,
    (snapshot) => {
      setCurrentUser();

      const all = [];
      snapshot.forEach((d) => all.push({ id: d.id, ...d.data() }));

      all.reverse();
      roomCache = all;

      renderedCount = Math.min(PAGE_SIZE, roomCache.length);
      const startIndex = Math.max(0, roomCache.length - renderedCount);
      const initial = roomCache.slice(startIndex);

      setEmptyStateVisible(false);
      renderFresh(listEl, initial, true);
      attachScrollLoader(listEl);
    },
    (err) => {
      console.error("Main snapshot error:", err);
      alert("Firestore error: " + err.message);
    }
  );
}

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
    (err) => console.error("Float snapshot error:", err)
  );
}

// ====== Status dots from agentDays ======
function mapStatusToDotClass(status) {
  // green: in_operation / handling
  if (status === "in_operation" || status === "handling") return "status-online";
  // orange: break / meeting
  if (status === "break" || status === "meeting") return "status-busy";
  // gray: unavailable / missing
  return "status-offline";
}

function subscribeTodayStatuses() {
  unsubscribeStatuses?.();

  const today = getTodayKey();
  const q = query(collection(db, AGENT_DAYS_COL), where("day", "==", today));

  unsubscribeStatuses = onSnapshot(
    q,
    (snap) => {
      const byId = {};
      snap.forEach((d) => {
        const row = d.data();
        if (row?.userId) byId[String(row.userId)] = row.status || "unavailable";
      });

      document.querySelectorAll("[data-status]").forEach((el) => {
        const uid = el.getAttribute("data-status");
        const st = byId[String(uid)] || "unavailable";

        el.classList.remove("status-online", "status-busy", "status-offline");
        el.classList.add(mapStatusToDotClass(st));
      });
    },
    (err) => console.error("Statuses snapshot error:", err)
  );
}

// ====== Selection logic ======
function selectConversation(conv, activeButtonEl) {
  const listEl = document.getElementById("chat-message-list");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");

  currentConversation = conv;

  clearActiveButtons();
  if (activeButtonEl) activeButtonEl.classList.add("active");

  // reset scroll binding when switching
  scrollBoundEl = null;

  if (conv.type === "ai") {
    unsubscribeMain?.();
    roomCache = [];
    renderedCount = 0;

    setHeader("ChatGPT 5", "Coming soon…");
    setEmptyStateVisible(false);

    if (listEl) {
      listEl.innerHTML = `
        <div style="padding:14px 4px; color:#777; font-size:13px;">
          🤖 ChatGPT assistant is coming soon.
        </div>
      `;
    }

    setInputEnabled(false);
    if (inputEl) inputEl.placeholder = "Coming soon…";
    return;
  }

  // normal rooms + dm
  setHeader(conv.title, conv.desc);
  setInputEnabled(conv.canSend);

  if (inputEl) inputEl.placeholder = "Type a message…";

  if (!currentUser) {
    setEmptyStateVisible(true);
    setInputEnabled(false);
    return;
  }

  subscribeMainToRoom(conv.roomId, listEl);
}

// ====== Init ======
document.addEventListener("DOMContentLoaded", () => {
  setCurrentUser();

  const hasMainChat = !!document.getElementById("page-messages");
  const listEl = document.getElementById("chat-message-list");

  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");

  const floatToggle = document.getElementById("float-chat-toggle");
  const floatPanel = document.getElementById("float-chat-panel");
  const floatClose = document.getElementById("float-chat-close");
  const floatList = document.getElementById("float-chat-messages");
  const floatForm = document.getElementById("float-chat-form");
  const floatInput = document.getElementById("float-chat-input");

  // styles
  if (listEl) {
    listEl.style.overflowY = "auto";
    listEl.style.maxHeight = "60vh";
  }
  if (floatList) {
    floatList.style.overflowY = "auto";
    floatList.style.maxHeight = "220px";
  }

  // Floating open/close
  floatToggle?.addEventListener("click", () => floatPanel?.classList.toggle("hidden"));
  floatClose?.addEventListener("click", () => floatPanel?.classList.add("hidden"));

  // Floating send (always general)
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

  // Main chat only on messages page
  if (hasMainChat) {
    // default empty
    setHeader("Messages", "Start chatting…");
    setEmptyStateVisible(true);
    setInputEnabled(false);

    // Rooms
    document.querySelectorAll(".chat-room").forEach((btn) => {
      btn.addEventListener("click", () => {
        const room = btn.dataset.room;

        // Supervisor room visibility rule (optional safeguard)
        setCurrentUser();
        if (room === "supervisors" && currentUser?.role !== "supervisor") {
          return alert("Supervisor only.");
        }

        if (room === "ai") {
          return selectConversation(
            { type: "ai", roomId: "ai", title: "ChatGPT 5", desc: "Coming soon…", canSend: false },
            btn
          );
        }

        const ROOM_META = {
          general: {
            title: "General chat",
            desc: "All agents & supervisors • Be respectful • No customer data.",
          },
          supervisors: {
            title: "Supervisors",
            desc: "Supervisor-only space for internal notes and coordination.",
          },
        };

        const meta = ROOM_META[room] || { title: room, desc: "" };

        selectConversation(
          { type: "room", roomId: room, title: meta.title, desc: meta.desc, canSend: true },
          btn
        );
      });
    });

    // DMs
    document.querySelectorAll(".chat-dm").forEach((btn) => {
      btn.addEventListener("click", () => {
        setCurrentUser();
        if (!currentUser) return alert("Please login first.");

        const otherId = btn.dataset.dm;
        if (!otherId) return;

        const otherName = btn.dataset.name || `User ${otherId}`;
        const roomId = makeDmRoomId(currentUser.id, otherId);

        selectConversation(
          {
            type: "dm",
            roomId,
            title: otherName,
            desc: "Direct message",
            canSend: true,
          },
          btn
        );
      });
    });

    // Send from main chat
    formEl?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text) return;

      setCurrentUser();
      if (!currentUser) return alert("Please login first.");

      if (!currentConversation || !currentConversation.roomId || !currentConversation.canSend) {
        return;
      }

      await addDoc(collection(db, MESSAGES_COL), {
        room: currentConversation.roomId,
        text,
        userId: currentUser.id,
        name: currentUser.name,
        role: currentUser.role,
        ts: serverTimestamp(),
      });

      inputEl.value = "";
    });

    // statuses
    subscribeTodayStatuses();
  }

  // Floating subscription always
  subscribeFloatToGeneral(floatList);

  // Initial visibility
  updateFloatingVisibility();
});

// app.js will dispatch page-changed; but we also handle user-changed
window.addEventListener("telesyriana:user-changed", () => {
  setCurrentUser();
  updateFloatingVisibility();
});

window.addEventListener("telesyriana:page-changed", () => {
  updateFloatingVisibility();
});

