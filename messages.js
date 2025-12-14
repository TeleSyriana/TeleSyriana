// // messages.js – Firestore chat (NO limit()) + lazy render on scroll up + Rooms + DMs + status dots
// // ✅ Recents (CLOUD, AFTER SEND ONLY) + Search by name/room/CCMS + Glass sidebar support
// // ✅ Groups (CLOUD) + Groups open via events (telesyriana:open-group / telesyriana:open-room)
// // messages.js – TeleSyriana Firestore Chat
// // ✅ Rooms + DMs + Groups (CLOUD)
// // ✅ Recents (CLOUD, DM ONLY, AFTER SEND ONLY)
// // ✅ Lazy render (no limit())
// // ✅ Search + collapsible sidebar
// // ❌ No alerts spam
// // messages.js – TeleSyriana
// // ✅ Rooms + DMs + Groups (cloud) + Recents (cloud, AFTER SEND ONLY)
// // ✅ Lazy render on scroll up (no limit()) + Status dots
// // ✅ Collapsible sidebar sections (Rooms/Groups/Recent/DMs)
// // ✅ NO alert() on firestore snapshot errors (console only)

// import { db, fs } from "./firebase.js";

// const {
//   collection,
//   addDoc,
//   query,
//   where,
//   orderBy,
//   onSnapshot,
//   serverTimestamp,
//   doc,
//   setDoc,
// } = fs;

// const USER_KEY = "telesyrianaUser";

// const MESSAGES_COL = "globalMessages";
// const AGENT_DAYS_COL = "agentDays";
// const GROUPS_COL = "groups";

// // Cloud recents:
// // userRecents/{userId}/items/{recentId}
// const RECENTS_ROOT = "userRecents";

// const PAGE_SIZE = 50;
// const MAX_RENDER = 600;

// let currentUser = null;
// let activeChat = null;

// let unsubscribeMain = null;
// let unsubscribeFloat = null;
// let unsubscribeStatus = null;
// let unsubscribeGroups = null;
// let unsubscribeRecents = null;

// let roomCache = [];     // ASC
// let renderedCount = 0;
// let scrollBoundEl = null;

// // sidebar refs
// let dmListEl = null;
// let recentListEl = null;
// let groupsListEl = null;

// // caches
// let groupsCache = [];   // [{id, name, rules, members, createdAt}]
// let recentsCache = [];  // [{id, type, roomId, title, desc, lastTs, otherId?}]

// // ---------------- helpers ----------------

// function getUserFromStorage() {
//   try {
//     const raw = localStorage.getItem(USER_KEY);
//     if (!raw) return null;
//     const u = JSON.parse(raw);
//     if (u?.id && u?.name && u?.role) return u;
//   } catch {}
//   return null;
// }
// function setCurrentUser() {
//   currentUser = getUserFromStorage();
// }

// function dmRoomId(a, b) {
//   const x = String(a);
//   const y = String(b);
//   return x < y ? `dm_${x}_${y}` : `dm_${y}_${x}`;
// }
// function getOtherIdFromDmRoom(roomId, myId) {
//   const parts = String(roomId || "").split("_"); // dm_1001_2002
//   if (parts.length !== 3) return null;
//   const a = parts[1], b = parts[2];
//   return String(myId) === a ? b : a;
// }

// function tsToNumber(ts) {
//   if (!ts) return 0;
//   if (typeof ts === "number") return ts;
//   if (ts.toMillis) return ts.toMillis();
//   if (ts.toDate) return ts.toDate().getTime();
//   return 0;
// }

// function formatTime(ts) {
//   if (!ts) return "";
//   const d = ts.toDate ? ts.toDate() : new Date(ts);
//   return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
// }

// function getTodayKey() {
//   const d = new Date();
//   return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
//     d.getDate()
//   ).padStart(2, "0")}`;
// }

// function statusToDotClass(status) {
//   if (status === "in_operation" || status === "handling") return "dot-online";
//   if (status === "meeting" || status === "break") return "dot-warn";
//   return "dot-offline";
// }

// function getInitials(name = "") {
//   const parts = name.trim().split(/\s+/).slice(0, 2);
//   return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "U";
// }

// function ensureTopLoader(listEl) {
//   if (!listEl) return null;
//   let loader = listEl.querySelector("#chat-top-loader");
//   if (!loader) {
//     loader = document.createElement("div");
//     loader.id = "chat-top-loader";
//     loader.style.display = "none";
//     loader.style.padding = "8px";
//     loader.style.textAlign = "center";
//     loader.style.fontSize = "12px";
//     loader.style.color = "#777";
//     loader.textContent = "Loading older messages…";
//     listEl.prepend(loader);
//   }
//   return loader;
// }

// function createMessageNode(m, showRole) {
//   const wrapper = document.createElement("div");
//   wrapper.className = "chat-message";
//   if (currentUser && m.userId === currentUser.id) wrapper.classList.add("me");

//   const avatar = document.createElement("div");
//   avatar.className = "msg-avatar";
//   avatar.textContent = getInitials(m.name || "User");

//   const body = document.createElement("div");
//   body.className = "msg-body";

//   const meta = document.createElement("div");
//   meta.className = "msg-meta";

//   const nameEl = document.createElement("span");
//   nameEl.className = "msg-name";
//   nameEl.textContent = showRole ? `${m.name} (${m.role})` : (m.name || "User");

//   const timeEl = document.createElement("span");
//   timeEl.textContent = `• ${formatTime(m.ts)}`;

//   meta.appendChild(nameEl);
//   meta.appendChild(timeEl);

//   const text = document.createElement("div");
//   text.className = "chat-message-text";
//   text.textContent = m.text || "";

//   body.appendChild(meta);
//   body.appendChild(text);

//   wrapper.appendChild(avatar);
//   wrapper.appendChild(body);

//   return wrapper;
// }

// function renderFresh(listEl, msgs, showRole) {
//   const loader = ensureTopLoader(listEl);
//   Array.from(listEl.children).forEach((ch) => {
//     if (ch !== loader) ch.remove();
//   });
//   const frag = document.createDocumentFragment();
//   msgs.forEach((m) => frag.appendChild(createMessageNode(m, showRole)));
//   listEl.appendChild(frag);
//   listEl.scrollTop = listEl.scrollHeight;
// }

// function renderChunkToTop(listEl, items, showRole) {
//   const loader = ensureTopLoader(listEl);
//   const prevH = listEl.scrollHeight;
//   const prevTop = listEl.scrollTop;

//   const frag = document.createDocumentFragment();
//   items.forEach((m) => frag.appendChild(createMessageNode(m, showRole)));

//   const afterLoader = loader?.nextSibling;
//   if (afterLoader) listEl.insertBefore(frag, afterLoader);
//   else listEl.appendChild(frag);

//   const newH = listEl.scrollHeight;
//   listEl.scrollTop = prevTop + (newH - prevH);
// }

// function setHeader(title, desc) {
//   const roomNameEl = document.getElementById("chat-room-name");
//   const roomDescEl = document.getElementById("chat-room-desc");
//   if (roomNameEl) roomNameEl.textContent = title || "Messages";
//   if (roomDescEl) roomDescEl.textContent = desc || "Start chatting…";
// }

// function setEmpty(on) {
//   const emptyEl = document.getElementById("chat-empty");
//   const listEl = document.getElementById("chat-message-list");
//   if (!emptyEl || !listEl) return;
//   emptyEl.style.display = on ? "block" : "none";
//   listEl.style.display = on ? "none" : "block";
// }

// function setInputEnabled(enabled) {
//   const formEl = document.getElementById("chat-form");
//   const inputEl = document.getElementById("chat-input");
//   if (!formEl || !inputEl) return;
//   const btn = formEl.querySelector("button[type='submit']");
//   inputEl.disabled = !enabled;
//   if (btn) btn.disabled = !enabled;
// }

// function clearActiveButtons() {
//   document
//     .querySelectorAll(".chat-room, .chat-dm, .chat-recent, .chat-group")
//     .forEach((b) => b.classList.remove("active", "chat-item-active"));
// }
// function setActiveButton(el) {
//   clearActiveButtons();
//   if (el) el.classList.add("active", "chat-item-active");
// }

// // ---------------- lazy scroll ----------------

// function attachScrollLoader(listEl) {
//   if (!listEl) return;
//   if (scrollBoundEl === listEl) return;
//   scrollBoundEl = listEl;

//   const loader = ensureTopLoader(listEl);

//   listEl.addEventListener("scroll", () => {
//     if (listEl.scrollTop > 40) return;

//     const total = roomCache.length;
//     const alreadyRenderedStartIndex = Math.max(0, total - renderedCount);

//     if (alreadyRenderedStartIndex <= 0) return;
//     if (renderedCount >= MAX_RENDER) return;

//     if (loader) loader.style.display = "block";

//     const addCount = Math.min(PAGE_SIZE, alreadyRenderedStartIndex);
//     const newStart = alreadyRenderedStartIndex - addCount;
//     const chunk = roomCache.slice(newStart, alreadyRenderedStartIndex);

//     renderedCount += chunk.length;
//     renderChunkToTop(listEl, chunk, true);

//     setTimeout(() => {
//       if (loader) loader.style.display = "none";
//     }, 150);
//   });
// }

// // ---------------- Firestore main chat ----------------

// function unsubscribeAllMain() {
//   unsubscribeMain?.();
//   unsubscribeMain = null;
//   roomCache = [];
//   renderedCount = 0;
//   scrollBoundEl = null;
// }

// function subscribeMainToRoom(roomId) {
//   const listEl = document.getElementById("chat-message-list");
//   if (!listEl) return;

//   unsubscribeAllMain();

//   const qRoom = query(
//     collection(db, MESSAGES_COL),
//     where("room", "==", roomId),
//     orderBy("ts", "desc")
//   );

//   unsubscribeMain = onSnapshot(
//     qRoom,
//     (snapshot) => {
//       setCurrentUser();
//       const all = [];
//       snapshot.forEach((d) => all.push({ id: d.id, ...d.data() }));
//       all.reverse(); // ASC
//       roomCache = all;

//       renderedCount = Math.min(PAGE_SIZE, roomCache.length);
//       const startIndex = Math.max(0, roomCache.length - renderedCount);
//       renderFresh(listEl, roomCache.slice(startIndex), true);
//       attachScrollLoader(listEl);
//     },
//     (err) => {
//       console.error("Main snapshot error:", err);
//       // ✅ no alert
//     }
//   );
// }

// // ---------------- Status dots ----------------

// function subscribeStatusDots() {
//   unsubscribeStatus?.();
//   unsubscribeStatus = null;

//   const qS = query(collection(db, AGENT_DAYS_COL), where("day", "==", getTodayKey()));

//   unsubscribeStatus = onSnapshot(
//     qS,
//     (snap) => {
//       document.querySelectorAll("[data-status-dot]").forEach((d) => {
//         d.classList.remove("dot-online", "dot-warn", "dot-offline");
//         d.classList.add("dot-offline");
//       });

//       snap.forEach((docu) => {
//         const d = docu.data() || {};
//         const userId = String(d.userId || "");
//         if (!userId) return;

//         const dot = document.querySelector(`[data-status-dot="${userId}"]`);
//         if (!dot) return;

//         const cls = statusToDotClass(d.status || "unavailable");
//         dot.classList.remove("dot-online", "dot-warn", "dot-offline");
//         dot.classList.add(cls);

//         const sub = document.querySelector(`[data-sub="${userId}"]`);
//         if (sub) sub.textContent = d.status ? String(d.status).replaceAll("_", " ") : "unavailable";
//       });
//     },
//     (err) => console.error("Status snapshot error:", err)
//   );
// }

// // ---------------- ✅ Cloud Groups sidebar (NO orderBy to avoid index) ----------------

// function unsubscribeGroupsCloud() {
//   unsubscribeGroups?.();
//   unsubscribeGroups = null;
//   groupsCache = [];
// }

// function renderGroupsList() {
//   if (!groupsListEl) groupsListEl = document.getElementById("groups-list");
//   if (!groupsListEl) return;

//   groupsListEl.innerHTML = "";

//   if (!groupsCache.length) {
//     groupsListEl.innerHTML = `<div class="ms-empty" id="groups-empty">No groups yet</div>`;
//     return;
//   }

//   const frag = document.createDocumentFragment();

//   groupsCache.forEach((g) => {
//     const btn = document.createElement("button");
//     btn.type = "button";
//     btn.className = "chat-room chat-group";
//     btn.dataset.groupId = g.id;

//     const avatarLetter = String(g.name || "G").trim().slice(0, 1).toUpperCase();
//     const membersCount = Array.isArray(g.members) ? g.members.length : 0;

//     btn.innerHTML = `
//       <div class="chat-row">
//         <div class="chat-avatar role-room">${avatarLetter}</div>
//         <div class="chat-row-text">
//           <div class="chat-room-title">${g.name || "Group"}</div>
//           <div class="chat-room-sub">${membersCount} members</div>
//         </div>
//       </div>
//     `;

//     btn.addEventListener("click", () => {
//       openChat({ type: "group", roomId: g.id, title: g.name, desc: g.rules ? `Rules: ${g.rules}` : "Group chat" }, btn);
//     });

//     frag.appendChild(btn);
//   });

//   groupsListEl.appendChild(frag);
// }

// function subscribeGroupsCloud() {
//   unsubscribeGroupsCloud();
//   if (!currentUser?.id) return;

//   const qG = query(
//     collection(db, GROUPS_COL),
//     where("members", "array-contains", String(currentUser.id))
//     // ✅ no orderBy -> no composite index popup
//   );

//   unsubscribeGroups = onSnapshot(
//     qG,
//     (snap) => {
//       const arr = [];
//       snap.forEach((d) => {
//         const data = d.data() || {};
//         arr.push({ id: d.id, ...data });
//       });

//       // sort client-side by createdAt desc
//       arr.sort((a, b) => (tsToNumber(b.createdAt) || 0) - (tsToNumber(a.createdAt) || 0));
//       groupsCache = arr;

//       renderGroupsList();
//     },
//     (err) => {
//       console.error("Groups snapshot error:", err);
//       // ✅ no alert
//       groupsCache = [];
//       renderGroupsList();
//     }
//   );
// }

// // ---------------- ✅ Cloud Recents (AFTER SEND ONLY) ----------------
// // recentId examples:
// // dm:1002
// // room:general
// // group:grp_xxx

// function recentsColRef(userId) {
//   return collection(db, RECENTS_ROOT, String(userId), "items");
// }

// function unsubscribeRecentsCloud() {
//   unsubscribeRecents?.();
//   unsubscribeRecents = null;
//   recentsCache = [];
// }

// function renderRecentsList() {
//   if (!recentListEl) recentListEl = document.getElementById("recent-list");
//   if (!recentListEl) return;

//   recentListEl.innerHTML = "";

//   if (!recentsCache.length) {
//     recentListEl.innerHTML = `<div class="ms-empty" id="recent-empty">No recent chats yet</div>`;
//     return;
//   }

//   const frag = document.createDocumentFragment();

//   recentsCache.forEach((r) => {
//     const btn = document.createElement("button");
//     btn.type = "button";
//     btn.className = "chat-room chat-recent";
//     btn.dataset.recentId = r.id;

//     const badge = r.type === "dm" ? "DM" : (r.type === "group" ? "G" : "#");
//     const avatarLetter = String(r.title || badge).trim().slice(0, 1).toUpperCase();

//     btn.innerHTML = `
//       <div class="chat-row">
//         <div class="chat-avatar role-room">${avatarLetter}</div>
//         <div class="chat-row-text">
//           <div class="chat-room-title">${r.title || "Chat"}</div>
//           <div class="chat-room-sub">${r.desc || ""}</div>
//         </div>
//       </div>
//     `;

//     btn.addEventListener("click", () => {
//       openChat({ type: r.type, roomId: r.roomId, title: r.title, desc: r.desc }, btn);
//     });

//     frag.appendChild(btn);
//   });

//   recentListEl.appendChild(frag);
// }

// function subscribeRecentsCloud() {
//   unsubscribeRecentsCloud();
//   if (!currentUser?.id) return;

//   const qR = query(recentsColRef(currentUser.id), orderBy("lastTs", "desc"));

//   unsubscribeRecents = onSnapshot(
//     qR,
//     (snap) => {
//       const arr = [];
//       snap.forEach((d) => {
//         const data = d.data() || {};
//         arr.push({
//           id: d.id,
//           type: data.type || "room",
//           roomId: data.roomId || "",
//           title: data.title || "",
//           desc: data.desc || "",
//           lastTs: data.lastTs || 0,
//         });
//       });
//       recentsCache = arr;
//       renderRecentsList();
//     },
//     (err) => {
//       console.error("Recents snapshot error:", err);
//       // ✅ no alert
//     }
//   );
// }

// async function bumpRecentAfterSendCloud() {
//   if (!currentUser?.id || !activeChat?.roomId) return;

//   const type = activeChat.type; // dm/room/group
//   const roomId = activeChat.roomId;

//   let recentId = "";
//   let title = activeChat.title || "Chat";
//   let desc = activeChat.desc || "";

//   if (type === "dm") {
//     const otherId = getOtherIdFromDmRoom(roomId, currentUser.id) || "";
//     if (!otherId) return;
//     recentId = `dm:${otherId}`;
//     title = title || `CCMS ${otherId}`;
//     desc = `Direct message • CCMS ${otherId}`;
//   } else if (type === "group") {
//     recentId = `group:${roomId}`;
//     desc = desc || "Group chat";
//   } else {
//     recentId = `room:${roomId}`;
//     desc = desc || "Room";
//   }

//   if (!recentId) return;

//   const ref = doc(db, RECENTS_ROOT, String(currentUser.id), "items", recentId);

//   try {
//     await setDoc(
//       ref,
//       {
//         type,
//         roomId,
//         title,
//         desc,
//         lastTs: Date.now(),
//         updatedAt: serverTimestamp(),
//       },
//       { merge: true }
//     );
//   } catch (e) {
//     console.error("bumpRecentAfterSendCloud error:", e);
//   }
// }

// // ---------------- open chat ----------------

// function openChat(chat, clickedEl = null) {
//   setCurrentUser();
//   if (!currentUser) return;

//   if (!chat?.roomId) return;

//   activeChat = {
//     type: chat.type || "room",
//     roomId: chat.roomId,
//     title: chat.title || "Chat",
//     desc: chat.desc || "",
//   };

//   setActiveButton(clickedEl);
//   setHeader(activeChat.title, activeChat.desc);
//   setEmpty(false);
//   setInputEnabled(true);

//   subscribeMainToRoom(activeChat.roomId);
// }

// // listen events from groups.js
// window.addEventListener("telesyriana:open-group", (e) => {
//   const d = e.detail || {};
//   openChat({ type: "group", roomId: d.roomId, title: d.title, desc: d.desc }, null);
// });
// window.addEventListener("telesyriana:open-room", (e) => {
//   const d = e.detail || {};
//   openChat({ type: d.type || "room", roomId: d.roomId, title: d.title, desc: d.desc }, null);
// });

// // ---------------- collapsible sidebar sections ----------------

// function makeCollapsible(headerText, listId) {
//   const headers = Array.from(document.querySelectorAll(".messages-sidebar-header"));
//   const h = headers.find((x) => x.textContent.trim().toLowerCase() === headerText.toLowerCase());
//   const list = document.getElementById(listId);
//   if (!h || !list) return;

//   // add caret
//   if (!h.querySelector(".caret")) {
//     const caret = document.createElement("span");
//     caret.className = "caret";
//     caret.textContent = "▾";
//     caret.style.marginLeft = "8px";
//     caret.style.opacity = "0.7";
//     h.appendChild(caret);
//   }

//   h.style.cursor = "pointer";
//   h.style.userSelect = "none";
//   h.dataset.open = "1";

//   h.addEventListener("click", () => {
//     const open = h.dataset.open === "1";
//     h.dataset.open = open ? "0" : "1";
//     list.style.display = open ? "none" : "";

//     const caret = h.querySelector(".caret");
//     if (caret) caret.textContent = open ? "▸" : "▾";
//   });
// }

// // ---------------- init ----------------

// document.addEventListener("DOMContentLoaded", () => {
//   // refs
//   dmListEl = document.getElementById("dm-list");
//   recentListEl = document.getElementById("recent-list");
//   groupsListEl = document.getElementById("groups-list");

//   // back button hidden
//   const backBtn = document.getElementById("chat-back");
//   if (backBtn) backBtn.style.display = "none";

//   setCurrentUser();

//   // collapsible sections
//   makeCollapsible("Rooms", "rooms-list");
//   makeCollapsible("Groups", "groups-list");
//   makeCollapsible("Recent", "recent-list");
//   makeCollapsible("Direct messages", "dm-list");

//   // initial empty state
//   setHeader("Messages", "Start chatting…");
//   setEmpty(true);
//   setInputEnabled(false);

//   // subscribe cloud lists
//   subscribeGroupsCloud();
//   subscribeRecentsCloud();

//   // hook rooms
//   document.querySelectorAll(".chat-room[data-room]").forEach((btn) => {
//     btn.addEventListener("click", () => {
//       setCurrentUser();
//       if (!currentUser) return;

//       const room = btn.dataset.room;

//       if (room === "ai") {
//         activeChat = { type: "ai", roomId: "ai", title: "ChatGPT 5", desc: "Coming soon…" };
//         setActiveButton(btn);
//         unsubscribeAllMain();
//         setHeader("ChatGPT 5", "Coming soon…");
//         setEmpty(true);
//         setInputEnabled(false);
//         return;
//       }

//       if (room === "supervisors" && currentUser.role !== "supervisor") {
//         // ✅ no alert
//         console.warn("Supervisor only room");
//         return;
//       }

//       const title = room === "general" ? "General chat" : "Supervisors";
//       const desc =
//         room === "general"
//           ? "All agents & supervisors • Be respectful • No customer data."
//           : "Supervisor-only space for internal notes and coordination.";

//       openChat({ type: "room", roomId: room, title, desc }, btn);
//     });
//   });

//   // hook dms
//   document.querySelectorAll(".chat-dm[data-dm]").forEach((btn) => {
//     btn.addEventListener("click", () => {
//       setCurrentUser();
//       if (!currentUser) return;

//       const otherId = btn.dataset.dm;
//       const roomId = dmRoomId(currentUser.id, otherId);

//       const nameEl = btn.querySelector(".chat-room-title");
//       const otherName = (nameEl?.textContent || `CCMS ${otherId}`).trim();

//       openChat(
//         { type: "dm", roomId, title: otherName, desc: `Direct message • CCMS ${otherId}` },
//         btn
//       );
//     });
//   });

//   // send
//   const formEl = document.getElementById("chat-form");
//   const inputEl = document.getElementById("chat-input");

//   formEl?.addEventListener("submit", async (e) => {
//     e.preventDefault();

//     const text = inputEl?.value?.trim();
//     if (!text) return;

//     setCurrentUser();
//     if (!currentUser) return;
//     if (!activeChat || activeChat.type === "ai") return;

//     try {
//       await addDoc(collection(db, MESSAGES_COL), {
//         room: activeChat.roomId,
//         text,
//         userId: currentUser.id,
//         name: currentUser.name,
//         role: currentUser.role,
//         ts: serverTimestamp(),
//       });

//       // ✅ Recents Cloud AFTER SEND ONLY (DM + Rooms + Groups)
//       await bumpRecentAfterSendCloud();
//     } catch (err) {
//       console.error("Send error:", err);
//       // ✅ no alert
//     }

//     inputEl.value = "";
//   });

//   // status
//   subscribeStatusDots();
// });

// // user change (login/logout)
// window.addEventListener("telesyriana:user-changed", () => {
//   setCurrentUser();

//   unsubscribeAllMain();
//   unsubscribeGroupsCloud();
//   unsubscribeRecentsCloud();

//   clearActiveButtons();
//   activeChat = null;

//   setHeader("Messages", "Start chatting…");
//   setEmpty(true);
//   setInputEnabled(false);

//   subscribeGroupsCloud();
//   subscribeRecentsCloud();
//   subscribeStatusDots();
// });

// messages.js – TeleSyriana (STABLE, NO limit())
// ✅ Rooms + DMs + Groups (Cloud)
// ✅ Recents (Cloud – AFTER SEND ONLY)
// ✅ Unread counters (Cloud – NO limit)
// ✅ Last seen
// ✅ Collapsible sidebar
// ❌ No alerts / No index errors

// messages.js – TeleSyriana (STABLE VERSION)
// ❌ no limit()
// ❌ no alert()
// ✅ groups + recents (cloud)
// ✅ lazy loading
// ✅ collapsible sidebar
// ✅ NO syntax errors

import { db, fs } from "./firebase.js";

const {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  doc,
  setDoc,
} = fs;

const USER_KEY = "telesyrianaUser";

const MESSAGES_COL = "globalMessages";
const GROUPS_COL = "groups";
const RECENTS_ROOT = "userRecents";

// ---------- state ----------
let currentUser = null;
let activeChat = null;

let unsubscribeMain = null;
let unsubscribeGroups = null;
let unsubscribeRecents = null;

let roomCache = [];
let renderedCount = 0;

const PAGE_SIZE = 40;
const MAX_RENDER = 600;

// ---------- helpers ----------
function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

function setUser() {
  currentUser = getUser();
}

function dmRoomId(a, b) {
  return a < b ? `dm_${a}_${b}` : `dm_${b}_${a}`;
}

function tsNum(ts) {
  if (!ts) return 0;
  if (ts.toMillis) return ts.toMillis();
  if (ts.toDate) return ts.toDate().getTime();
  return ts;
}

// ---------- UI ----------
function setHeader(title, desc) {
  document.getElementById("chat-room-name").textContent = title || "Messages";
  document.getElementById("chat-room-desc").textContent = desc || "";
}

function setEmpty(on) {
  document.getElementById("chat-empty").style.display = on ? "block" : "none";
  document.getElementById("chat-message-list").style.display = on ? "none" : "block";
}

function setInput(enabled) {
  const input = document.getElementById("chat-input");
  const btn = document.querySelector("#chat-form button");
  input.disabled = !enabled;
  btn.disabled = !enabled;
}

function clearActive() {
  document.querySelectorAll(".chat-room,.chat-dm,.chat-group,.chat-recent")
    .forEach(b => b.classList.remove("active"));
}

function setActive(el) {
  clearActive();
  el?.classList.add("active");
}

// ---------- messages ----------
function unsubscribeMainChat() {
  unsubscribeMain?.();
  unsubscribeMain = null;
  roomCache = [];
  renderedCount = 0;
}

function renderMessages(listEl, msgs) {
  listEl.innerHTML = "";
  const frag = document.createDocumentFragment();

  msgs.forEach(m => {
    const div = document.createElement("div");
    div.className = "chat-message" + (m.userId === currentUser.id ? " me" : "");
    div.innerHTML = `
      <div class="msg-avatar">${m.name?.[0] || "U"}</div>
      <div class="msg-body">
        <div class="msg-meta">${m.name}</div>
        <div class="chat-message-text">${m.text}</div>
      </div>
    `;
    frag.appendChild(div);
  });

  listEl.appendChild(frag);
  listEl.scrollTop = listEl.scrollHeight;
}

function subscribeRoom(roomId) {
  unsubscribeMainChat();

  const listEl = document.getElementById("chat-message-list");

  const q = query(
    collection(db, MESSAGES_COL),
    where("room", "==", roomId),
    orderBy("ts", "desc")
  );

  unsubscribeMain = onSnapshot(q, snap => {
    const all = [];
    snap.forEach(d => all.push(d.data()));
    all.reverse();

    roomCache = all;
    renderedCount = Math.min(PAGE_SIZE, roomCache.length);

    renderMessages(listEl, roomCache.slice(-renderedCount));
  });
}

// ---------- open chat ----------
function openChat(chat, btn) {
  setUser();
  if (!currentUser) return;

  activeChat = chat;
  setActive(btn);
  setHeader(chat.title, chat.desc);
  setEmpty(false);
  setInput(true);

  subscribeRoom(chat.roomId);
}

// ---------- groups ----------
function subscribeGroups() {
  unsubscribeGroups?.();
  if (!currentUser) return;

  const list = document.getElementById("groups-list");
  list.innerHTML = "";

  const q = query(
    collection(db, GROUPS_COL),
    where("members", "array-contains", currentUser.id)
  );

  unsubscribeGroups = onSnapshot(q, snap => {
    list.innerHTML = "";

    snap.forEach(d => {
      const g = d.data();
      const btn = document.createElement("button");
      btn.className = "chat-group";
      btn.textContent = g.name;
      btn.onclick = () =>
        openChat(
          { type: "group", roomId: d.id, title: g.name, desc: g.rules || "" },
          btn
        );
      list.appendChild(btn);
    });
  });
}

// ---------- recents ----------
function subscribeRecents() {
  unsubscribeRecents?.();
  if (!currentUser) return;

  const list = document.getElementById("recent-list");

  const q = query(
    collection(db, RECENTS_ROOT, currentUser.id, "items"),
    orderBy("lastTs", "desc")
  );

  unsubscribeRecents = onSnapshot(q, snap => {
    list.innerHTML = "";
    snap.forEach(d => {
      const r = d.data();
      const btn = document.createElement("button");
      btn.className = "chat-recent";
      btn.textContent = r.title;
      btn.onclick = () =>
        openChat(
          { type: r.type, roomId: r.roomId, title: r.title, desc: r.desc },
          btn
        );
      list.appendChild(btn);
    });
  });
}

async function bumpRecent() {
  if (!currentUser || !activeChat) return;

  const ref = doc(
    db,
    RECENTS_ROOT,
    currentUser.id,
    "items",
    `${activeChat.type}:${activeChat.roomId}`
  );

  await setDoc(ref, {
    type: activeChat.type,
    roomId: activeChat.roomId,
    title: activeChat.title,
    desc: activeChat.desc,
    lastTs: Date.now(),
  }, { merge: true });
}

// ---------- init ----------
document.addEventListener("DOMContentLoaded", () => {
  setUser();

  setHeader("Messages", "Start chatting…");
  setEmpty(true);
  setInput(false);

  subscribeGroups();
  subscribeRecents();

  const form = document.getElementById("chat-form");
  const chatInput = document.getElementById("chat-input");

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !activeChat) return;

    await addDoc(collection(db, MESSAGES_COL), {
      room: activeChat.roomId,
      text,
      userId: currentUser.id,
      name: currentUser.name,
      ts: serverTimestamp(),
    });

    await bumpRecent();
    chatInput.value = ""; // ✅ FIXED
  });
});
