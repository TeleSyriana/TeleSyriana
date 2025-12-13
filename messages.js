// messages.js – TeleSyriana Firestore chat (MAIN + FLOATING)
// ✅ Limit + scroll up (if supported by firebase.js exports)
// ✅ Fallback mode if limit/getDocs not available
// ✅ Rooms + DMs + Status dots
// ✅ DM reorder ONLY after sending message
// ✅ Search filter (main + floating)
// ✅ Floating chat = same logic as messages page

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

// Optional (may be missing depending on your firebase.js)
const limitFn = fs.limit;
const startAfterFn = fs.startAfter;
const getDocsFn = fs.getDocs;

const USER_KEY = "telesyrianaUser";
const MESSAGES_COL = "globalMessages";
const AGENT_DAYS_COL = "agentDays";

// recents per user
const RECENTS_KEY_PREFIX = "telesyrianaChatRecents";

const PAGE_SIZE = 50;
const MAX_RENDER = 600;

let currentUser = null;

// subscriptions
let unsubscribeStatus = null;

// ---------------- helpers ----------------

function getUserFromStorage() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    return u?.id ? u : null;
  } catch {
    return null;
  }
}

function setCurrentUser() {
  currentUser = getUserFromStorage();
}

function formatTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function dmRoomId(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? `dm_${x}_${y}` : `dm_${y}_${x}`;
}

function statusToDotClass(status) {
  if (status === "in_operation" || status === "handling") return "dot-online";
  if (status === "meeting" || status === "break") return "dot-warn";
  return "dot-offline";
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getInitials(name = "") {
  const parts = String(name).trim().split(/\s+/).slice(0, 2);
  const initials = parts.map((p) => (p[0] || "").toUpperCase()).join("");
  return initials || "U";
}

// ---------------- Recents (ONLY on send) ----------------

function recentsKey() {
  if (!currentUser?.id) return null;
  return `${RECENTS_KEY_PREFIX}:${currentUser.id}`;
}

function loadRecents() {
  const key = recentsKey();
  if (!key) return {};
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch {
    return {};
  }
}

function saveRecents(map) {
  const key = recentsKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(map || {}));
}

function bumpRecent(otherId) {
  if (!currentUser?.id || !otherId) return;
  const map = loadRecents();
  map[String(otherId)] = Date.now();
  saveRecents(map);
}

function applyDmOrder(dmListEl) {
  if (!dmListEl) return;

  const map = loadRecents();
  const buttons = Array.from(dmListEl.querySelectorAll(".chat-dm"));

  buttons.sort((a, b) => {
    const ida = String(a.dataset.dm || "");
    const idb = String(b.dataset.dm || "");
    const ta = map[ida] || 0;
    const tb = map[idb] || 0;
    if (tb !== ta) return tb - ta;
    return ida.localeCompare(idb);
  });

  buttons.forEach((b) => dmListEl.appendChild(b));
}

// ---------------- Status dots (updates ALL dots with same data-status-dot) ----------------

function subscribeStatusDots() {
  unsubscribeStatus?.();
  unsubscribeStatus = null;

  const q = query(collection(db, AGENT_DAYS_COL), where("day", "==", getTodayKey()));

  unsubscribeStatus = onSnapshot(q, (snap) => {
    // reset all dots everywhere (main + floating)
    document.querySelectorAll("[data-status-dot]").forEach((dot) => {
      dot.classList.remove("dot-online", "dot-warn", "dot-offline");
      dot.classList.add("dot-offline");
    });

    snap.forEach((docu) => {
      const d = docu.data();
      const uid = String(d.userId || "");
      if (!uid) return;

      const cls = statusToDotClass(d.status || "unavailable");

      // update ALL dots matching uid
      document.querySelectorAll(`[data-status-dot="${uid}"]`).forEach((dot) => {
        dot.classList.remove("dot-online", "dot-warn", "dot-offline");
        dot.classList.add(cls);
      });

      // optional: update subtitle labels (main list)
      document.querySelectorAll(`[data-sub="${uid}"]`).forEach((sub) => {
        sub.textContent = d.status ? String(d.status).replaceAll("_", " ") : "unavailable";
      });
    });
  });
}

// ---------------- Chat renderer ----------------

function createMessageNode(m) {
  const wrap = document.createElement("div");
  wrap.className = "chat-message";
  if (m.userId === currentUser?.id) wrap.classList.add("me");

  const name = escapeHtml(m.name || "User");
  const text = escapeHtml(m.text || "");

  wrap.innerHTML = `
    <div class="msg-avatar">${getInitials(m.name || "User")}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-name">${name}</span>
        <span>• ${formatTime(m.ts)}</span>
      </div>
      <div class="chat-message-text">${text}</div>
    </div>
  `;
  return wrap;
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

function renderFresh(listEl, msgsAsc) {
  if (!listEl) return;

  const loader = ensureTopLoader(listEl);

  Array.from(listEl.children).forEach((ch) => {
    if (ch !== loader) ch.remove();
  });

  const frag = document.createDocumentFragment();
  (msgsAsc || []).forEach((m) => frag.appendChild(createMessageNode(m)));
  listEl.appendChild(frag);

  listEl.scrollTop = listEl.scrollHeight;
}

function renderChunkToTop(listEl, chunkAsc) {
  if (!listEl || !chunkAsc?.length) return;

  const loader = ensureTopLoader(listEl);

  const prevHeight = listEl.scrollHeight;
  const prevTop = listEl.scrollTop;

  const frag = document.createDocumentFragment();
  chunkAsc.forEach((m) => frag.appendChild(createMessageNode(m)));

  const afterLoader = loader.nextSibling;
  if (afterLoader) listEl.insertBefore(frag, afterLoader);
  else listEl.appendChild(frag);

  const newHeight = listEl.scrollHeight;
  listEl.scrollTop = prevTop + (newHeight - prevHeight);
}

// ---------------- Chat controller (works for MAIN and FLOAT) ----------------

function createChatController(opts) {
  const state = {
    activeChat: null,
    unsubscribeMain: null,

    // fallback cache
    roomCacheAsc: [],
    renderedCount: 0,
    scrollBoundEl: null,

    // limit mode cache
    newestAsc: [],
    olderAsc: [],
    oldestCursorDoc: null,
    isLoadingOlder: false,
    noMoreOlder: false,
  };

  const canLimit = !!limitFn;

  function setHeader(title, desc) {
    if (opts.nameEl) opts.nameEl.textContent = title || "Messages";
    if (opts.descEl) opts.descEl.textContent = desc || "Start chatting…";
  }

  function setEmpty(on) {
    if (!opts.emptyEl || !opts.listEl) return;
    opts.emptyEl.style.display = on ? "block" : "none";
    opts.listEl.style.display = on ? "none" : "flex";
  }

  function setInputEnabled(enabled) {
    if (!opts.formEl || !opts.inputEl) return;
    const btn = opts.formEl.querySelector("button[type='submit']") || opts.formEl.querySelector("button");
    opts.inputEl.disabled = !enabled;
    if (btn) btn.disabled = !enabled;
  }

  function unsubscribeAllMain() {
    state.unsubscribeMain?.();
    state.unsubscribeMain = null;

    state.roomCacheAsc = [];
    state.renderedCount = 0;

    state.newestAsc = [];
    state.olderAsc = [];
    state.oldestCursorDoc = null;

    state.isLoadingOlder = false;
    state.noMoreOlder = false;
    state.scrollBoundEl = null;
  }

  function attachScrollLoaderFallback() {
    const listEl = opts.listEl;
    if (!listEl) return;
    if (state.scrollBoundEl === listEl) return;
    state.scrollBoundEl = listEl;

    const loader = ensureTopLoader(listEl);

    listEl.addEventListener("scroll", () => {
      if (listEl.scrollTop > 40) return;
      if (state.renderedCount >= Math.min(MAX_RENDER, state.roomCacheAsc.length)) return;

      loader.style.display = "block";

      const total = state.roomCacheAsc.length;
      const alreadyRenderedStartIndex = Math.max(0, total - state.renderedCount);
      if (alreadyRenderedStartIndex <= 0) {
        loader.style.display = "none";
        return;
      }

      const addCount = Math.min(PAGE_SIZE, alreadyRenderedStartIndex);
      const newStart = alreadyRenderedStartIndex - addCount;

      const chunk = state.roomCacheAsc.slice(newStart, alreadyRenderedStartIndex);
      state.renderedCount += chunk.length;

      renderChunkToTop(listEl, chunk);

      setTimeout(() => (loader.style.display = "none"), 120);
    });
  }

  function attachScrollLoaderLimitMode(roomId) {
    const listEl = opts.listEl;
    if (!listEl) return;
    if (state.scrollBoundEl === listEl) return;
    state.scrollBoundEl = listEl;

    const loader = ensureTopLoader(listEl);

    listEl.addEventListener("scroll", async () => {
      if (listEl.scrollTop > 40) return;
      if (state.isLoadingOlder || state.noMoreOlder) return;
      if (!state.oldestCursorDoc) return;

      // if missing optional functions, cannot load older
      if (!getDocsFn || !startAfterFn || !limitFn) return;

      state.isLoadingOlder = true;
      loader.style.display = "block";

      try {
        const qOlder = query(
          collection(db, MESSAGES_COL),
          where("room", "==", roomId),
          orderBy("ts", "desc"),
          startAfterFn(state.oldestCursorDoc),
          limitFn(PAGE_SIZE)
        );

        const snap = await getDocsFn(qOlder);

        if (snap.empty) {
          state.noMoreOlder = true;
          loader.textContent = "No more messages";
          setTimeout(() => {
            loader.style.display = "none";
            loader.textContent = "Loading older messages…";
          }, 700);
          return;
        }

        const olderDesc = [];
        snap.forEach((d) => olderDesc.push({ id: d.id, ...d.data() }));

        state.oldestCursorDoc = snap.docs[snap.docs.length - 1] || state.oldestCursorDoc;

        const chunkAsc = olderDesc.slice().reverse();
        state.olderAsc = [...chunkAsc, ...state.olderAsc];

        // cap
        const combined = [...state.olderAsc, ...state.newestAsc];
        if (combined.length > MAX_RENDER) {
          const extra = combined.length - MAX_RENDER;
          state.olderAsc = state.olderAsc.slice(extra);
        }

        renderChunkToTop(listEl, chunkAsc);
      } catch (e) {
        console.error("Older load error:", e);
        alert("Error loading older messages: " + (e?.message || e));
      } finally {
        state.isLoadingOlder = false;
        loader.style.display = "none";
      }
    });
  }

  function subscribeToRoom(roomId) {
    if (!opts.listEl || !roomId) return;
    unsubscribeAllMain();

    if (canLimit) {
      const qNewest = query(
        collection(db, MESSAGES_COL),
        where("room", "==", roomId),
        orderBy("ts", "desc"),
        limitFn(PAGE_SIZE)
      );

      state.unsubscribeMain = onSnapshot(
        qNewest,
        (snap) => {
          setCurrentUser();

          const newestDesc = [];
          snap.forEach((d) => newestDesc.push({ id: d.id, ...d.data() }));

          state.newestAsc = newestDesc.slice().reverse();
          state.oldestCursorDoc = snap.docs[snap.docs.length - 1] || null;

          const combined = [...state.olderAsc, ...state.newestAsc];
          const capped =
            combined.length > MAX_RENDER ? combined.slice(combined.length - MAX_RENDER) : combined;

          renderFresh(opts.listEl, capped);
          attachScrollLoaderLimitMode(roomId);
        },
        (err) => {
          console.error("Snapshot error:", err);
          alert("Firestore error: " + err.message);
        }
      );

      return;
    }

    // fallback: listen ALL but render last PAGE_SIZE only
    const qAll = query(
      collection(db, MESSAGES_COL),
      where("room", "==", roomId),
      orderBy("ts", "desc")
    );

    state.unsubscribeMain = onSnapshot(
      qAll,
      (snap) => {
        setCurrentUser();

        const allDesc = [];
        snap.forEach((d) => allDesc.push({ id: d.id, ...d.data() }));

        state.roomCacheAsc = allDesc.slice().reverse(); // ASC

        state.renderedCount = Math.min(PAGE_SIZE, state.roomCacheAsc.length);
        const start = Math.max(0, state.roomCacheAsc.length - state.renderedCount);
        const initial = state.roomCacheAsc.slice(start);

        renderFresh(opts.listEl, initial);
        attachScrollLoaderFallback();
      },
      (err) => {
        console.error("Snapshot error:", err);
        alert("Firestore error: " + err.message);
      }
    );
  }

  function openRoom(roomId, title, desc, enforceRules = true) {
    setCurrentUser();
    if (!currentUser) return alert("Please login first.");

    // rules
    if (enforceRules) {
      if (roomId === "ai") {
        state.activeChat = { type: "ai", roomId: "ai" };
        unsubscribeAllMain();
        if (opts.listEl) opts.listEl.innerHTML = "";
        setHeader("ChatGPT 5", "Coming soon…");
        setEmpty(true);
        setInputEnabled(false);
        return;
      }
      if (roomId === "supervisors" && currentUser.role !== "supervisor") {
        alert("Supervisor only room.");
        return;
      }
    }

    state.activeChat = { type: "room", roomId };
    setHeader(title, desc);
    setEmpty(false);
    setInputEnabled(true);
    subscribeToRoom(roomId);
  }

  function openDm(otherId, otherName) {
    setCurrentUser();
    if (!currentUser) return alert("Please login first.");

    const roomId = dmRoomId(currentUser.id, otherId);
    state.activeChat = { type: "dm", roomId, otherId };

    setHeader(otherName || `User ${otherId}`, `Direct message • CCMS ${otherId}`);
    setEmpty(false);
    setInputEnabled(true);

    subscribeToRoom(roomId);
  }

  async function sendMessage() {
    const inputEl = opts.inputEl;
    if (!inputEl) return;

    const text = inputEl.value.trim();
    if (!text) return;

    setCurrentUser();
    if (!currentUser) return alert("Please login first.");
    if (!state.activeChat || state.activeChat.type === "ai") return;

    await addDoc(collection(db, MESSAGES_COL), {
      room: state.activeChat.roomId,
      text,
      userId: currentUser.id,
      name: currentUser.name,
      role: currentUser.role,
      ts: serverTimestamp(),
    });

    if (state.activeChat.type === "dm") {
      bumpRecent(state.activeChat.otherId);
      // reorder DMs only after sending
      if (opts.dmListEl) applyDmOrder(opts.dmListEl);
    }

    inputEl.value = "";
  }

  function resetIfLoggedOut() {
    setCurrentUser();
    if (currentUser) return;

    unsubscribeAllMain();
    state.activeChat = null;

    if (opts.listEl) opts.listEl.innerHTML = "";
    setHeader("Messages", "Start chatting…");
    setEmpty(true);
    setInputEnabled(false);

    // clear active highlights for this UI container
    opts.clearActive?.();
  }

  return {
    openRoom,
    openDm,
    sendMessage,
    resetIfLoggedOut,
    unsubscribeAllMain,
    setHeader,
    setEmpty,
    setInputEnabled,
    getState: () => state,
  };
}

// ---------------- MAIN UI (Messages Page) ----------------

let mainController = null;

function initMainMessagesUI() {
  const listEl = document.getElementById("chat-message-list");
  const emptyEl = document.getElementById("chat-empty");
  const nameEl = document.getElementById("chat-room-name");
  const descEl = document.getElementById("chat-room-desc");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");
  const dmListEl = document.getElementById("dm-list");

  const clearActiveButtons = () => {
    document.querySelectorAll(".chat-room, .chat-dm").forEach((b) => {
      b.classList.remove("active", "chat-item-active");
    });
  };

  const setActiveButton = (el) => {
    clearActiveButtons();
    el?.classList.add("active", "chat-item-active");
  };

  // Search (main)
  const searchInput = document.getElementById("chat-search");
  const searchClear = document.getElementById("chat-search-clear");
  if (searchInput) {
    const run = () => {
      const q = searchInput.value.trim().toLowerCase();
      document.querySelectorAll(".chat-room, .chat-dm").forEach((btn) => {
        const titleEl = btn.querySelector(".chat-room-title");
        const subEl = btn.querySelector(".chat-room-sub");
        const title = (titleEl?.textContent || btn.textContent || "").toLowerCase();
        const sub = (subEl?.textContent || "").toLowerCase();
        const hit = !q || title.includes(q) || sub.includes(q);
        btn.style.display = hit ? "" : "none";
      });
    };
    searchInput.addEventListener("input", run);
    searchClear?.addEventListener("click", () => {
      searchInput.value = "";
      searchInput.focus();
      run();
    });
    run();
  }

  // controller
  mainController = createChatController({
    listEl,
    emptyEl,
    nameEl,
    descEl,
    formEl,
    inputEl,
    dmListEl,
    clearActive: clearActiveButtons,
  });

  // default state
  mainController.setHeader("Messages", "Start chatting…");
  mainController.setEmpty(true);
  mainController.setInputEnabled(false);

  // DM ordering initial
  applyDmOrder(dmListEl);

  // Rooms handlers
  document.querySelectorAll(".chat-room").forEach((btn) => {
    btn.addEventListener("click", () => {
      const room = btn.dataset.room;
      if (!room) return;

      setActiveButton(btn);

      const title =
        room === "general" ? "General chat" : room === "supervisors" ? "Supervisors" : "ChatGPT 5";

      const desc =
        room === "general"
          ? "All agents & supervisors • Be respectful • No customer data."
          : room === "supervisors"
          ? "Supervisor-only space for internal notes and coordination."
          : "Coming soon…";

      mainController.openRoom(room, title, desc, true);
    });
  });

  // DM handlers
  document.querySelectorAll(".chat-dm").forEach((btn) => {
    btn.addEventListener("click", () => {
      const otherId = btn.dataset.dm;
      if (!otherId) return;

      setActiveButton(btn);

      const titleEl = btn.querySelector(".chat-room-title");
      const otherName = titleEl ? titleEl.textContent.trim() : `User ${otherId}`;

      mainController.openDm(otherId, otherName);
    });
  });

  // Send
  formEl?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await mainController.sendMessage();
  });
}

// ---------------- FLOATING UI (Injected) ----------------

let floatController = null;

function buildFloatingUIFromMainLists() {
  const panel = document.getElementById("float-chat-panel");
  if (!panel) return;

  // If already built, skip
  if (panel.querySelector(".floating-mini")) return;

  // Find main room + dm buttons to clone
  const mainRoomBtns = Array.from(document.querySelectorAll("#rooms-list .chat-room"));
  const mainDmBtns = Array.from(document.querySelectorAll("#dm-list .chat-dm"));

  // Existing elements in your HTML
  const messagesHost = document.getElementById("float-chat-messages");
  const formEl = document.getElementById("float-chat-form");
  const inputEl = document.getElementById("float-chat-input");

  // Create new structure
  const mini = document.createElement("div");
  mini.className = "floating-mini";

  const side = document.createElement("aside");
  side.className = "floating-mini-side";

  const top = document.createElement("div");
  top.className = "floating-mini-top";
  top.innerHTML = `
    <input id="float-search" class="floating-mini-search" placeholder="Search…" autocomplete="off" />
    <button id="float-search-clear" type="button" class="floating-mini-search-x" title="Clear">×</button>
  `;

  const roomsTitle = document.createElement("div");
  roomsTitle.className = "floating-mini-section";
  roomsTitle.textContent = "Rooms";

  const roomsList = document.createElement("div");
  roomsList.className = "floating-mini-list";
  roomsList.id = "float-rooms";

  const dmTitle = document.createElement("div");
  dmTitle.className = "floating-mini-section";
  dmTitle.textContent = "DM";

  const dmList = document.createElement("div");
  dmList.className = "floating-mini-list";
  dmList.id = "float-dms";

  side.appendChild(top);
  side.appendChild(roomsTitle);
  side.appendChild(roomsList);
  side.appendChild(dmTitle);
  side.appendChild(dmList);

  const chat = document.createElement("section");
  chat.className = "floating-mini-chat";

  const body = document.createElement("div");
  body.className = "floating-chat-body";

  body.innerHTML = `
    <div id="float-room-name" class="floating-chat-room-name">Select chat</div>
    <div id="float-room-note" class="floating-chat-note">Choose a room or DM</div>
  `;

  // Move existing messages container into the new body
  if (messagesHost) body.appendChild(messagesHost);

  chat.appendChild(body);

  // Move existing form into new chat section (keep same IDs)
  if (formEl) chat.appendChild(formEl);

  mini.appendChild(side);
  mini.appendChild(chat);

  // Replace old floating body wrapper content (but keep header intact)
  // We insert mini right after header
  const header = panel.querySelector(".floating-chat-header");
  if (header) header.insertAdjacentElement("afterend", mini);
}

function cloneChatButton(btn, type) {
  // type: "room" | "dm"
  const clone = btn.cloneNode(true);
  clone.classList.remove("active", "chat-item-active");
  // ensure dataset stays
  if (type === "room") {
    clone.classList.remove("chat-dm");
    clone.classList.add("chat-room");
  } else {
    clone.classList.remove("chat-room");
    clone.classList.add("chat-dm");
  }
  return clone;
}

function initFloatingChatUI() {
  buildFloatingUIFromMainLists();

  const roomsList = document.getElementById("float-rooms");
  const dmListEl = document.getElementById("float-dms");

  const listEl = document.getElementById("float-chat-messages");
  const formEl = document.getElementById("float-chat-form");
  const inputEl = document.getElementById("float-chat-input");

  const nameEl = document.getElementById("float-room-name");
  const descEl = document.getElementById("float-room-note");

  // we don't have an "empty" element for floating; use note text only
  const emptyEl = null;

  if (!roomsList || !dmListEl || !listEl || !formEl || !inputEl || !nameEl || !descEl) return;

  // Fill rooms/dms from main lists (clone)
  roomsList.innerHTML = "";
  dmListEl.innerHTML = "";

  const mainRoomBtns = Array.from(document.querySelectorAll("#rooms-list .chat-room"));
  const mainDmBtns = Array.from(document.querySelectorAll("#dm-list .chat-dm"));

  mainRoomBtns.forEach((b) => roomsList.appendChild(cloneChatButton(b, "room")));
  mainDmBtns.forEach((b) => dmListEl.appendChild(cloneChatButton(b, "dm")));

  // Apply DM order (same recents)
  applyDmOrder(dmListEl);

  // active style (floating only)
  const clearActive = () => {
    roomsList.querySelectorAll(".chat-room, .chat-dm").forEach((b) => b.classList.remove("active", "chat-item-active"));
    dmListEl.querySelectorAll(".chat-room, .chat-dm").forEach((b) => b.classList.remove("active", "chat-item-active"));
  };

  const setActive = (el) => {
    clearActive();
    el?.classList.add("active", "chat-item-active");
  };

  // controller
  floatController = createChatController({
    listEl,
    emptyEl, // none
    nameEl,
    descEl,
    formEl,
    inputEl,
    dmListEl,
    clearActive,
  });

  floatController.setHeader("Select chat", "Choose a room or DM");
  floatController.setInputEnabled(false);

  // Floating search
  const sInput = document.getElementById("float-search");
  const sClear = document.getElementById("float-search-clear");
  const runSearch = () => {
    const q = (sInput?.value || "").trim().toLowerCase();
    const allBtns = panelButtons();
    allBtns.forEach((btn) => {
      const titleEl = btn.querySelector(".chat-room-title");
      const subEl = btn.querySelector(".chat-room-sub");
      const title = (titleEl?.textContent || btn.textContent || "").toLowerCase();
      const sub = (subEl?.textContent || "").toLowerCase();
      const hit = !q || title.includes(q) || sub.includes(q);
      btn.style.display = hit ? "" : "none";
    });
  };

  function panelButtons() {
    return [
      ...Array.from(roomsList.querySelectorAll(".chat-room")),
      ...Array.from(dmListEl.querySelectorAll(".chat-dm")),
    ];
  }

  sInput?.addEventListener("input", runSearch);
  sClear?.addEventListener("click", () => {
    if (!sInput) return;
    sInput.value = "";
    sInput.focus();
    runSearch();
  });
  runSearch();

  // Room click handlers (floating)
  roomsList.querySelectorAll(".chat-room").forEach((btn) => {
    btn.addEventListener("click", () => {
      const room = btn.dataset.room;
      if (!room) return;

      setActive(btn);

      const title =
        room === "general" ? "General chat" : room === "supervisors" ? "Supervisors" : "ChatGPT 5";

      const desc =
        room === "general"
          ? "Compact mode • Be respectful."
          : room === "supervisors"
          ? "Supervisor-only compact room."
          : "Coming soon…";

      floatController.openRoom(room, title, desc, true);
    });
  });

  // DM click handlers (floating)
  dmListEl.querySelectorAll(".chat-dm").forEach((btn) => {
    btn.addEventListener("click", () => {
      const otherId = btn.dataset.dm;
      if (!otherId) return;

      setActive(btn);

      const titleEl = btn.querySelector(".chat-room-title");
      const otherName = titleEl ? titleEl.textContent.trim() : `User ${otherId}`;

      floatController.openDm(otherId, otherName);
    });
  });

  // Send (floating)
  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    await floatController.sendMessage();

    // keep DM order in floating list too
    applyDmOrder(dmListEl);
  });
}

// ---------------- Floating toggle open/close ----------------

function initFloatingToggle() {
  const toggle = document.getElementById("float-chat-toggle");
  const panel = document.getElementById("float-chat-panel");
  const close = document.getElementById("float-chat-close");

  if (!toggle || !panel) return;

  toggle.addEventListener("click", () => {
    panel.classList.toggle("hidden");

    // build floating UI when opened first time
    if (!panel.classList.contains("hidden")) {
      initFloatingChatUI();
    }
  });

  close?.addEventListener("click", () => {
    panel.classList.add("hidden");
  });
}

// ---------------- Init ----------------

document.addEventListener("DOMContentLoaded", () => {
  setCurrentUser();

  // main messages UI
  initMainMessagesUI();

  // status dots (main + floating)
  subscribeStatusDots();

  // floating toggle
  initFloatingToggle();
});

// login/logout without refresh
window.addEventListener("telesyriana:user-changed", () => {
  setCurrentUser();
  subscribeStatusDots();

  // MAIN reset
  mainController?.resetIfLoggedOut();
  const mainDmList = document.getElementById("dm-list");
  applyDmOrder(mainDmList);

  // FLOAT reset (if opened)
  floatController?.resetIfLoggedOut();
  const floatDmList = document.getElementById("float-dms");
  applyDmOrder(floatDmList);
});


