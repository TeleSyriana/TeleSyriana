// messages.js – TeleSyriana Firestore chat (FIXED FULL)
// ✅ Main Messages: Rooms + DMs + Search + Recents + Status dots
// ✅ Chat-only mode + Back button behavior
// ✅ Lazy load (limit/startAfter/getDocs) if available, fallback if not
// ✅ Floating Chat: Toggle + Rooms + DMs + Search + Lazy load (same logic)
// ✅ Defensive selectors (if HTML got messy)

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

// Optional pagination (depends on your firebase.js exports)
const limitFn = fs.limit;
const startAfterFn = fs.startAfter;
const getDocsFn = fs.getDocs;

const USER_KEY = "telesyrianaUser";
const MESSAGES_COL = "globalMessages";
const AGENT_DAYS_COL = "agentDays";
const RECENTS_KEY_PREFIX = "telesyrianaChatRecents";

const PAGE_SIZE = 50;
const MAX_RENDER = 600;

// -------------------- shared state --------------------
let currentUser = null;

// main (page) ui refs
let main = {
  listEl: null,
  emptyEl: null,
  nameEl: null,
  descEl: null,
  formEl: null,
  inputEl: null,
  dmListEl: null,
  pageEl: null,
  sidebarEl: null,
  rootEl: null, // #page-messages
};

// floating ui refs (built/injected)
let floating = {
  toggleBtn: null,
  panelEl: null,
  closeBtn: null,
  built: false,

  searchEl: null,
  roomsEl: null,
  dmsEl: null,
  listEl: null,
  formEl: null,
  inputEl: null,
  titleEl: null,
  noteEl: null,
};

let unsubscribeStatus = null;

// main chat runtime
let mainChat = makeChatRuntime("main");
// floating chat runtime
let floatChat = makeChatRuntime("float");

/* ---------------- helpers ---------------- */

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

function isNearBottom(el, px = 80) {
  if (!el) return true;
  return el.scrollHeight - (el.scrollTop + el.clientHeight) < px;
}

/* ---------------- UI helpers ---------------- */

function clearActiveButtons(rootEl) {
  const scope = rootEl || document;
  scope.querySelectorAll(".chat-room, .chat-dm").forEach((b) => {
    b.classList.remove("active", "chat-item-active");
  });
}

function setActiveButton(rootEl, el) {
  clearActiveButtons(rootEl);
  el?.classList.add("active", "chat-item-active");
}

function setHeader(nameEl, descEl, title, desc) {
  if (nameEl) nameEl.textContent = title || "Messages";
  if (descEl) descEl.textContent = desc || "Start chatting…";
}

function setEmptyState(emptyEl, listEl, on) {
  if (!emptyEl || !listEl) return;
  emptyEl.style.display = on ? "block" : "none";
  listEl.style.display = on ? "none" : "flex";
}

function setInputEnabled(formEl, inputEl, enabled) {
  if (!formEl || !inputEl) return;

  const btn =
    formEl.querySelector(".chat-send-btn") ||
    formEl.querySelector("#float-send-btn");

  inputEl.disabled = !enabled;
  if (btn) btn.disabled = !enabled;
}

function ensureTopLoader(listEl, id = "chat-top-loader") {
  if (!listEl) return null;
  let loader = listEl.querySelector(`#${id}`);
  if (!loader) {
    loader = document.createElement("div");
    loader.id = id;
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

/* ---------------- Chat-only mode (Main Messages) ---------------- */

function setChatOnlyMode(on) {
  const page = document.getElementById("page-messages");
  if (!page) return;
  page.classList.toggle("chat-only", !!on);
}

/* ---------------- Rendering ---------------- */

function getInitials(name = "") {
  const parts = String(name).trim().split(/\s+/).slice(0, 2);
  const initials = parts.map((p) => (p[0] || "").toUpperCase()).join("");
  return initials || "U";
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createMessageNode(m) {
  const wrap = document.createElement("div");
  wrap.className = "chat-message";
  if (m.userId === currentUser?.id) wrap.classList.add("me");

  const name = escapeHtml(m.name || "User");
  const text = escapeHtml(m.text || "");

  wrap.innerHTML = `
    <div class="msg-avatar">${getInitials(m.name)}</div>
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

function renderFresh(listEl, msgsAsc, keepScroll = false) {
  if (!listEl) return;

  const loader = ensureTopLoader(listEl, `${listEl.id || "chat"}-top-loader`);
  const wasNearBottom = isNearBottom(listEl);

  // Remove all except loader
  Array.from(listEl.children).forEach((ch) => {
    if (ch !== loader) ch.remove();
  });

  const frag = document.createDocumentFragment();
  (msgsAsc || []).forEach((m) => frag.appendChild(createMessageNode(m)));
  listEl.appendChild(frag);

  // scroll behavior
  if (!keepScroll) {
    listEl.scrollTop = listEl.scrollHeight;
  } else {
    if (wasNearBottom) listEl.scrollTop = listEl.scrollHeight;
  }
}

function renderChunkToTop(listEl, chunkAsc) {
  if (!listEl || !chunkAsc?.length) return;

  const loader = ensureTopLoader(listEl, `${listEl.id || "chat"}-top-loader`);

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

/* ---------------- Runtime factory ---------------- */

function makeChatRuntime(tag) {
  return {
    tag,
    activeChat: null,
    unsubscribeMain: null,

    // fallback cache
    roomCacheAsc: [],
    renderedCount: 0,

    // limit mode cache
    newestAsc: [],
    olderAsc: [],
    oldestCursorDoc: null,
    isLoadingOlder: false,
    noMoreOlder: false,

    scrollBoundEl: null,
  };
}

function resetRuntime(rt) {
  rt.unsubscribeMain?.();
  rt.unsubscribeMain = null;

  rt.activeChat = null;

  rt.roomCacheAsc = [];
  rt.renderedCount = 0;

  rt.newestAsc = [];
  rt.olderAsc = [];
  rt.oldestCursorDoc = null;
  rt.isLoadingOlder = false;
  rt.noMoreOlder = false;

  rt.scrollBoundEl = null;
}

/* ---------------- Pagination attachers ---------------- */

function attachScrollLoaderFallback(rt, listEl) {
  if (!listEl) return;

  // prevent duplicate binding
  if (rt.scrollBoundEl === listEl) return;
  rt.scrollBoundEl = listEl;

  const loader = ensureTopLoader(listEl, `${rt.tag}-top-loader`);

  listEl.addEventListener("scroll", () => {
    if (listEl.scrollTop > 40) return;
    if (rt.renderedCount >= Math.min(MAX_RENDER, rt.roomCacheAsc.length)) return;

    loader.style.display = "block";

    const total = rt.roomCacheAsc.length;
    const alreadyRenderedStartIndex = Math.max(0, total - rt.renderedCount);
    if (alreadyRenderedStartIndex <= 0) {
      loader.style.display = "none";
      return;
    }

    const addCount = Math.min(PAGE_SIZE, alreadyRenderedStartIndex);
    const newStart = alreadyRenderedStartIndex - addCount;

    const chunk = rt.roomCacheAsc.slice(newStart, alreadyRenderedStartIndex);
    rt.renderedCount += chunk.length;

    renderChunkToTop(listEl, chunk);

    setTimeout(() => (loader.style.display = "none"), 120);
  });
}

function attachScrollLoaderLimitMode(rt, listEl, roomId) {
  if (!listEl) return;

  // prevent duplicate binding
  if (rt.scrollBoundEl === listEl) return;
  rt.scrollBoundEl = listEl;

  const loader = ensureTopLoader(listEl, `${rt.tag}-top-loader`);

  listEl.addEventListener("scroll", async () => {
    if (listEl.scrollTop > 40) return;
    if (rt.isLoadingOlder || rt.noMoreOlder) return;
    if (!rt.oldestCursorDoc) return;

    if (!getDocsFn || !startAfterFn || !limitFn) return;

    rt.isLoadingOlder = true;
    loader.style.display = "block";

    try {
      const qOlder = query(
        collection(db, MESSAGES_COL),
        where("room", "==", roomId),
        orderBy("ts", "desc"),
        startAfterFn(rt.oldestCursorDoc),
        limitFn(PAGE_SIZE)
      );

      const snap = await getDocsFn(qOlder);

      if (snap.empty) {
        rt.noMoreOlder = true;
        loader.textContent = "No more messages";
        setTimeout(() => {
          loader.style.display = "none";
          loader.textContent = "Loading older messages…";
        }, 700);
        return;
      }

      const olderDesc = [];
      snap.forEach((d) => olderDesc.push({ id: d.id, ...d.data() }));

      rt.oldestCursorDoc = snap.docs[snap.docs.length - 1] || rt.oldestCursorDoc;

      const chunkAsc = olderDesc.slice().reverse();
      rt.olderAsc = [...chunkAsc, ...rt.olderAsc];

      // cap overall
      const combined = [...rt.olderAsc, ...rt.newestAsc];
      if (combined.length > MAX_RENDER) {
        const extra = combined.length - MAX_RENDER;
        rt.olderAsc = rt.olderAsc.slice(extra);
      }

      renderChunkToTop(listEl, chunkAsc);
    } catch (e) {
      console.error("Older load error:", e);
      alert("Error loading older messages: " + (e?.message || e));
    } finally {
      rt.isLoadingOlder = false;
      loader.style.display = "none";
    }
  });
}

/* ---------------- Firestore subscribe ---------------- */

function subscribeToRoom(rt, roomId, listEl) {
  if (!listEl || !roomId) return;

  // IMPORTANT: do NOT clear UI here; just reset runtime so we don't double subscribe
  resetRuntime(rt);

  const canLimit = !!limitFn;

  // ✅ LIMIT MODE
  if (canLimit) {
    const qNewest = query(
      collection(db, MESSAGES_COL),
      where("room", "==", roomId),
      orderBy("ts", "desc"),
      limitFn(PAGE_SIZE)
    );

    rt.unsubscribeMain = onSnapshot(
      qNewest,
      (snap) => {
        setCurrentUser();

        const newestDesc = [];
        snap.forEach((d) => newestDesc.push({ id: d.id, ...d.data() }));

        rt.newestAsc = newestDesc.slice().reverse();
        rt.oldestCursorDoc = snap.docs[snap.docs.length - 1] || null;

        // keep already loaded olderAsc
        const combined = [...rt.olderAsc, ...rt.newestAsc];
        const capped =
          combined.length > MAX_RENDER
            ? combined.slice(combined.length - MAX_RENDER)
            : combined;

        // keepScroll=true => only autoscroll if user is near bottom
        renderFresh(listEl, capped, true);
        attachScrollLoaderLimitMode(rt, listEl, roomId);
      },
      (err) => {
        console.error("Snapshot error:", err);
        alert("Firestore error: " + err.message);
      }
    );

    return;
  }

  // ✅ FALLBACK MODE (listen all but render last PAGE_SIZE)
  const qAll = query(
    collection(db, MESSAGES_COL),
    where("room", "==", roomId),
    orderBy("ts", "desc")
  );

  rt.unsubscribeMain = onSnapshot(
    qAll,
    (snap) => {
      setCurrentUser();

      const allDesc = [];
      snap.forEach((d) => allDesc.push({ id: d.id, ...d.data() }));
      rt.roomCacheAsc = allDesc.slice().reverse();

      rt.renderedCount = Math.min(PAGE_SIZE, rt.roomCacheAsc.length);
      const start = Math.max(0, rt.roomCacheAsc.length - rt.renderedCount);
      const initial = rt.roomCacheAsc.slice(start);

      renderFresh(listEl, initial, false);
      attachScrollLoaderFallback(rt, listEl);
    },
    (err) => {
      console.error("Snapshot error:", err);
      alert("Firestore error: " + err.message);
    }
  );
}

/* ---------------- Recents (ONLY on send) ---------------- */

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
  applyDmOrderMain();
  applyDmOrderFloating();
}

function applyDmOrder(listEl) {
  if (!listEl) return;
  const map = loadRecents();
  const buttons = Array.from(listEl.querySelectorAll(".chat-dm"));

  buttons.sort((a, b) => {
    const ida = String(a.dataset.dm || "");
    const idb = String(b.dataset.dm || "");
    const ta = map[ida] || 0;
    const tb = map[idb] || 0;
    if (tb !== ta) return tb - ta;
    return ida.localeCompare(idb);
  });

  buttons.forEach((b) => listEl.appendChild(b));
}

function applyDmOrderMain() {
  if (!main.dmListEl) main.dmListEl = document.getElementById("dm-list");
  applyDmOrder(main.dmListEl);
}

function applyDmOrderFloating() {
  applyDmOrder(floating.dmsEl);
}

/* ---------------- Status dots ---------------- */

function subscribeStatusDots() {
  unsubscribeStatus?.();
  unsubscribeStatus = null;

  const q = query(collection(db, AGENT_DAYS_COL), where("day", "==", getTodayKey()));

  unsubscribeStatus = onSnapshot(q, (snap) => {
    // reset all dots everywhere
    document.querySelectorAll("[data-status-dot]").forEach((dot) => {
      dot.classList.remove("dot-online", "dot-warn", "dot-offline");
      dot.classList.add("dot-offline");
    });

    snap.forEach((docu) => {
      const d = docu.data();
      const uid = String(d.userId || "");
      if (!uid) return;

      const cls = statusToDotClass(d.status || "unavailable");

      const dots = document.querySelectorAll(`[data-status-dot="${uid}"]`);
      dots.forEach((dot) => {
        dot.classList.remove("dot-online", "dot-warn", "dot-offline");
        dot.classList.add(cls);
      });

      // Update subtitle text if exists
      const subs = document.querySelectorAll(`[data-sub="${uid}"]`);
      subs.forEach((sub) => {
        sub.textContent = d.status ? String(d.status).replaceAll("_", " ") : "unavailable";
      });
    });
  });
}

/* ---------------- Search ---------------- */

function hookSearch(inputEl, clearBtn, scopeRoot) {
  if (!inputEl || !scopeRoot) return;

  const run = () => {
    const q = inputEl.value.trim().toLowerCase();
    scopeRoot.querySelectorAll(".chat-room, .chat-dm").forEach((btn) => {
      const titleEl = btn.querySelector(".chat-room-title");
      const subEl = btn.querySelector(".chat-room-sub");
      const title = (titleEl?.textContent || btn.textContent || "").toLowerCase();
      const sub = (subEl?.textContent || "").toLowerCase();
      const hit = !q || title.includes(q) || sub.includes(q);
      btn.style.display = hit ? "" : "none";
    });
  };

  inputEl.addEventListener("input", run);
  clearBtn?.addEventListener("click", () => {
    inputEl.value = "";
    inputEl.focus();
    run();
  });

  run();
}

/* ---------------- Floating UI build (inject) ---------------- */

function buildFloatingUIIfNeeded() {
  floating.toggleBtn = document.getElementById("float-chat-toggle");
  floating.panelEl = document.getElementById("float-chat-panel");
  floating.closeBtn = document.getElementById("float-chat-close");

  if (!floating.panelEl) return;
  if (floating.built) return;

  // Keep existing header node if present
  const header = floating.panelEl.querySelector(".floating-chat-header");

  // Clear everything except header
  Array.from(floating.panelEl.children).forEach((ch) => {
    if (ch === header) return;
    ch.remove();
  });

  const body = document.createElement("div");
  body.className = "floating-mini";

  body.innerHTML = `
    <aside class="floating-mini-side">
      <div class="floating-mini-top">
        <input id="float-search" class="floating-mini-search" placeholder="Search…" autocomplete="off" />
        <button id="float-search-clear" class="floating-mini-search-x" type="button" title="Clear">×</button>
      </div>

      <div class="floating-mini-section">Rooms</div>
      <div class="floating-mini-list" id="float-rooms"></div>

      <div class="floating-mini-section">Direct messages</div>
      <div class="floating-mini-list" id="float-dms"></div>
    </aside>

    <section class="floating-mini-chat">
      <div class="floating-chat-body">
        <div id="float-room-name" class="floating-chat-room-name">Select chat</div>
        <div id="float-room-note" class="floating-chat-note">Choose a room or DM</div>
        <div id="float-chat-messages" class="floating-chat-messages"></div>
      </div>

      <form id="float-chat-form" class="floating-chat-input-row">
        <input id="float-chat-input" type="text" autocomplete="off" placeholder="Quick message…" disabled />
        <button id="float-send-btn" type="submit" disabled>Send</button>
      </form>
    </section>
  `;

  floating.panelEl.appendChild(body);

  floating.searchEl = floating.panelEl.querySelector("#float-search");
  floating.roomsEl = floating.panelEl.querySelector("#float-rooms");
  floating.dmsEl = floating.panelEl.querySelector("#float-dms");
  floating.listEl = floating.panelEl.querySelector("#float-chat-messages");
  floating.formEl = floating.panelEl.querySelector("#float-chat-form");
  floating.inputEl = floating.panelEl.querySelector("#float-chat-input");
  floating.titleEl = floating.panelEl.querySelector("#float-room-name");
  floating.noteEl = floating.panelEl.querySelector("#float-room-note");

  floating.built = true;
}

/* ---------------- Rooms & DMs for floating ---------------- */

function getStaticRooms() {
  return [
    {
      id: "general",
      title: "General chat",
      sub: "All agents & supervisors",
      className: "role-room",
      avatar: "#",
    },
    {
      id: "supervisors",
      title: "Supervisors",
      sub: "Supervisor only",
      className: "role-supervisor",
      avatar: "S",
    },
    {
      id: "ai",
      title: "ChatGPT 5",
      sub: "Coming soon",
      className: "role-ai",
      avatar: "AI",
    },
  ];
}

function getStaticDmUsers() {
  return [
    { id: "1001", name: "Agent 01", sub: "Direct chat", role: "agent" },
    { id: "1002", name: "Agent 02", sub: "Direct chat", role: "agent" },
    { id: "1003", name: "Agent 03", sub: "Direct chat", role: "agent" },
    { id: "2001", name: "Supervisor Dema", sub: "Direct chat", role: "supervisor" },
    { id: "2002", name: "Supervisor Moustafa", sub: "Direct chat", role: "supervisor" },
  ];
}

function renderFloatingSidebar() {
  if (!floating.roomsEl || !floating.dmsEl) return;

  floating.roomsEl.innerHTML = "";
  getStaticRooms().forEach((r) => {
    const btn = document.createElement("button");
    btn.className = "chat-room";
    btn.type = "button";
    btn.dataset.room = r.id;
    btn.innerHTML = `
      <div class="chat-row">
        <div class="chat-avatar ${r.className}">${escapeHtml(r.avatar)}</div>
        <div class="chat-row-text">
          <div class="chat-room-title">${escapeHtml(r.title)}</div>
          <div class="chat-room-sub">${escapeHtml(r.sub)}</div>
        </div>
      </div>
    `;
    floating.roomsEl.appendChild(btn);
  });

  floating.dmsEl.innerHTML = "";
  getStaticDmUsers().forEach((u) => {
    const btn = document.createElement("button");
    btn.className = "chat-dm";
    btn.type = "button";
    btn.dataset.dm = u.id;

    btn.innerHTML = `
      <div class="chat-row">
        <div class="dm-avatar-wrap">
          <div class="chat-avatar ${u.role === "supervisor" ? "role-supervisor" : "role-agent"}" data-avatar="${u.id}">
            ${escapeHtml(getInitials(u.name))}
          </div>
          <span class="status-dot dot-offline" data-status-dot="${u.id}"></span>
        </div>
        <div class="chat-row-text">
          <div class="chat-room-title" data-name="${u.id}">${escapeHtml(u.name)}</div>
          <div class="chat-room-sub" data-sub="${u.id}">${escapeHtml(u.sub)}</div>
        </div>
      </div>
    `;
    floating.dmsEl.appendChild(btn);
  });

  applyDmOrderFloating();
}

/* ---------------- Open chat (main/floating) ---------------- */

function openChat(rt, ui, rootForActive, chatType, roomId, otherId, title, desc, opts = {}) {
  rt.activeChat = chatType === "dm"
    ? { type: "dm", roomId, otherId }
    : { type: "room", roomId };

  setHeader(ui.nameEl || ui.titleEl, ui.descEl || ui.noteEl, title, desc);

  // main empty state only
  if (ui.listEl && ui.emptyEl) setEmptyState(ui.emptyEl, ui.listEl, false);

  setInputEnabled(ui.formEl, ui.inputEl, true);

  if (ui.listEl) {
    ui.listEl.innerHTML = "";
    ensureTopLoader(ui.listEl, `${rt.tag}-top-loader`);
  }

  subscribeToRoom(rt, roomId, ui.listEl);

  // active button
  if (rootForActive) {
    if (chatType === "room") {
      const btn = rootForActive.querySelector(`.chat-room[data-room="${roomId}"]`);
      setActiveButton(rootForActive, btn);
    } else {
      const btn = rootForActive.querySelector(`.chat-dm[data-dm="${otherId}"]`);
      setActiveButton(rootForActive, btn);
    }
  }

  // chat-only for main when opening chat
  if (opts.enableChatOnly) setChatOnlyMode(true);
}

/* ---------------- Main page init ---------------- */

function initMainMessagesPage() {
  main.rootEl = document.getElementById("page-messages");
  main.listEl = document.getElementById("chat-message-list");
  main.emptyEl = document.getElementById("chat-empty");
  main.nameEl = document.getElementById("chat-room-name");
  main.descEl = document.getElementById("chat-room-desc");
  main.formEl = document.getElementById("chat-form");
  main.inputEl = document.getElementById("chat-input");
  main.dmListEl = document.getElementById("dm-list");
  main.sidebarEl = main.rootEl?.querySelector(".messages-sidebar") || null;

  // Search (page)
  const searchInput = document.getElementById("chat-search");
  const searchClear = document.getElementById("chat-search-clear");
  if (searchInput && main.sidebarEl) hookSearch(searchInput, searchClear, main.sidebarEl);

  applyDmOrderMain();
  subscribeStatusDots();

  // default state
  resetRuntime(mainChat);
  setChatOnlyMode(false);
  setHeader(main.nameEl, main.descEl, "Messages", "Start chatting…");
  if (main.listEl && main.emptyEl) setEmptyState(main.emptyEl, main.listEl, true);
  setInputEnabled(main.formEl, main.inputEl, false);

  // Back button
  document.getElementById("chat-back")?.addEventListener("click", () => {
    // show sidebar
    setChatOnlyMode(false);

    // Reset chat (like you asked)
    resetRuntime(mainChat);
    clearActiveButtons(main.sidebarEl || document);

    if (main.listEl) main.listEl.innerHTML = "";
    setHeader(main.nameEl, main.descEl, "Messages", "Start chatting…");
    if (main.listEl && main.emptyEl) setEmptyState(main.emptyEl, main.listEl, true);
    setInputEnabled(main.formEl, main.inputEl, false);
  });

  // Rooms click (page)
  document.querySelectorAll("#page-messages .chat-room").forEach((btn) => {
    btn.addEventListener("click", () => {
      setCurrentUser();
      if (!currentUser) return alert("Please login first.");

      const room = btn.dataset.room;
      if (!room) return;

      if (room === "ai") {
        resetRuntime(mainChat);
        mainChat.activeChat = { type: "ai", roomId: "ai" };
        setActiveButton(main.sidebarEl || document, btn);

        if (main.listEl) main.listEl.innerHTML = "";
        setHeader(main.nameEl, main.descEl, "ChatGPT 5", "Coming soon…");
        if (main.listEl && main.emptyEl) setEmptyState(main.emptyEl, main.listEl, true);
        setInputEnabled(main.formEl, main.inputEl, false);

        // still go chat-only if you want
        setChatOnlyMode(true);
        return;
      }

      if (room === "supervisors" && currentUser.role !== "supervisor") {
        alert("Supervisor only room.");
        return;
      }

      const title =
        room === "general" ? "General chat" : room === "supervisors" ? "Supervisors" : "Room";

      const desc =
        room === "general"
          ? "All agents & supervisors • Be respectful • No customer data."
          : "Supervisor-only space for internal notes and coordination.";

      openChat(mainChat, main, main.sidebarEl || document, "room", room, null, title, desc, {
        enableChatOnly: true,
      });
    });
  });

  // DM click (page)
  document.querySelectorAll("#page-messages .chat-dm").forEach((btn) => {
    btn.addEventListener("click", () => {
      setCurrentUser();
      if (!currentUser) return alert("Please login first.");

      const otherId = btn.dataset.dm;
      if (!otherId) return;

      const roomId = dmRoomId(currentUser.id, otherId);

      const titleEl = btn.querySelector(".chat-room-title");
      const otherName = titleEl ? titleEl.textContent.trim() : `User ${otherId}`;

      openChat(
        mainChat,
        main,
        main.sidebarEl || document,
        "dm",
        roomId,
        otherId,
        otherName,
        `Direct message • CCMS ${otherId}`,
        { enableChatOnly: true }
      );
    });
  });

  // Send (page)
  main.formEl?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const text = main.inputEl?.value?.trim();
    if (!text) return;

    setCurrentUser();
    if (!currentUser) return alert("Please login first.");
    if (!mainChat.activeChat || mainChat.activeChat.type === "ai") return;

    await addDoc(collection(db, MESSAGES_COL), {
      room: mainChat.activeChat.roomId,
      text,
      userId: currentUser.id,
      name: currentUser.name,
      role: currentUser.role,
      ts: serverTimestamp(),
    });

    if (mainChat.activeChat.type === "dm") bumpRecent(mainChat.activeChat.otherId);

    main.inputEl.value = "";
  });
}

/* ---------------- Floating init + hooks ---------------- */

function toggleFloating(open) {
  if (!floating.panelEl || !floating.toggleBtn) return;
  const isOpen = open ?? !floating.panelEl.classList.contains("hidden");
  floating.panelEl.classList.toggle("hidden", !isOpen);
}

function initFloatingChat() {
  buildFloatingUIIfNeeded();
  if (!floating.panelEl) return;

  renderFloatingSidebar();

  // toggle button show/hide panel
  floating.toggleBtn?.addEventListener("click", () => toggleFloating(true));
  floating.closeBtn?.addEventListener("click", () => toggleFloating(false));

  // Floating search
  const clearBtn = floating.panelEl.querySelector("#float-search-clear");
  if (floating.searchEl && floating.panelEl) {
    hookSearch(floating.searchEl, clearBtn, floating.panelEl);
  }

  // click handlers (rooms)
  floating.roomsEl?.querySelectorAll(".chat-room").forEach((btn) => {
    btn.addEventListener("click", () => {
      setCurrentUser();
      if (!currentUser) return alert("Please login first.");

      const room = btn.dataset.room;
      if (!room) return;

      if (room === "ai") {
        resetRuntime(floatChat);
        floatChat.activeChat = { type: "ai", roomId: "ai" };
        setActiveButton(floating.panelEl, btn);

        if (floating.listEl) floating.listEl.innerHTML = "";
        setHeader(floating.titleEl, floating.noteEl, "ChatGPT 5", "Coming soon…");
        setInputEnabled(floating.formEl, floating.inputEl, false);
        return;
      }

      if (room === "supervisors" && currentUser.role !== "supervisor") {
        alert("Supervisor only room.");
        return;
      }

      const title =
        room === "general" ? "General chat" : room === "supervisors" ? "Supervisors" : "Room";

      const desc =
        room === "general" ? "All agents & supervisors" : "Supervisor-only notes";

      openChat(floatChat, floating, floating.panelEl, "room", room, null, title, desc);
    });
  });

  // click handlers (dms)
  floating.dmsEl?.querySelectorAll(".chat-dm").forEach((btn) => {
    btn.addEventListener("click", () => {
      setCurrentUser();
      if (!currentUser) return alert("Please login first.");

      const otherId = btn.dataset.dm;
      if (!otherId) return;

      const roomId = dmRoomId(currentUser.id, otherId);

      const titleEl = btn.querySelector(".chat-room-title");
      const otherName = titleEl ? titleEl.textContent.trim() : `User ${otherId}`;

      openChat(
        floatChat,
        floating,
        floating.panelEl,
        "dm",
        roomId,
        otherId,
        otherName,
        `Direct message • CCMS ${otherId}`
      );
    });
  });

  // Send (floating)
  floating.formEl?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = floating.inputEl?.value?.trim();
    if (!text) return;

    setCurrentUser();
    if (!currentUser) return alert("Please login first.");
    if (!floatChat.activeChat || floatChat.activeChat.type === "ai") return;

    await addDoc(collection(db, MESSAGES_COL), {
      room: floatChat.activeChat.roomId,
      text,
      userId: currentUser.id,
      name: currentUser.name,
      role: currentUser.role,
      ts: serverTimestamp(),
    });

    if (floatChat.activeChat.type === "dm") bumpRecent(floatChat.activeChat.otherId);

    floating.inputEl.value = "";
  });

  // default floating state
  resetRuntime(floatChat);
  setHeader(floating.titleEl, floating.noteEl, "TeleSyriana", "Select a room or DM");
  setInputEnabled(floating.formEl, floating.inputEl, false);
  toggleFloating(false);
}

/* ---------------- user changed / reset ---------------- */

function handleUserChanged() {
  setCurrentUser();
  subscribeStatusDots();
  applyDmOrderMain();
  applyDmOrderFloating();

  // If logged out: stop listeners, clear UIs
  if (!currentUser) {
    resetRuntime(mainChat);
    resetRuntime(floatChat);

    // main
    clearActiveButtons(main.sidebarEl || document);
    setChatOnlyMode(false);

    if (main.listEl) main.listEl.innerHTML = "";
    setHeader(main.nameEl, main.descEl, "Messages", "Start chatting…");
    if (main.listEl && main.emptyEl) setEmptyState(main.emptyEl, main.listEl, true);
    setInputEnabled(main.formEl, main.inputEl, false);

    // floating
    if (floating.panelEl) clearActiveButtons(floating.panelEl);
    if (floating.listEl) floating.listEl.innerHTML = "";
    setHeader(floating.titleEl, floating.noteEl, "TeleSyriana", "Select a room or DM");
    setInputEnabled(floating.formEl, floating.inputEl, false);
    toggleFloating(false);
  }
}

/* ---------------- Init ---------------- */

document.addEventListener("DOMContentLoaded", () => {
  setCurrentUser();

  // main init
  initMainMessagesPage();

  // floating init (only if exists)
  buildFloatingUIIfNeeded();
  if (document.getElementById("float-chat-panel")) {
    initFloatingChat();
  }

  // keep status + ordering alive
  subscribeStatusDots();
  applyDmOrderMain();
  applyDmOrderFloating();
});

// login/logout without refresh
window.addEventListener("telesyriana:user-changed", handleUserChanged);
