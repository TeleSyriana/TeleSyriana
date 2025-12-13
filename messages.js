// messages.js – FINAL
import { db, fs } from "./firebase.js";

const { collection, addDoc, query, where, orderBy, onSnapshot, serverTimestamp } = fs;

const USER_KEY = "telesyrianaUser";
const MESSAGES_COL = "globalMessages";
const AGENT_DAYS_COL = "agentDays";

/* =========================
   State
========================= */
let currentUser = null;
let activeChat = null; // { type:"room"|"dm", roomId, otherId? }

let unsubscribeMain = null;
let unsubscribeStatus = null;

/* =========================
   Recents (LOCAL)
========================= */
const RECENTS_KEY = uid => `telesyriana-recents:${uid}`;

/* =========================
   Helpers
========================= */
function getUserFromStorage(){
  try{
    const u = JSON.parse(localStorage.getItem(USER_KEY));
    if(u?.id) return u;
  }catch{}
  return null;
}

function setCurrentUser(){
  currentUser = getUserFromStorage();
}

function dmRoomId(a,b){
  const x=String(a), y=String(b);
  return x<y ? `dm_${x}_${y}` : `dm_${y}_${x}`;
}

function getOtherId(roomId, myId){
  const p = roomId.split("_");
  if(p.length!==3) return null;
  return p[1]===String(myId) ? p[2] : p[1];
}

function formatTime(ts){
  if(!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
}

function setHeader(nameEl, descEl, title, desc){
  nameEl.textContent = title || "Messages";
  descEl.textContent = desc || "";
}

function setEmptyState(emptyEl, listEl, on){
  emptyEl.style.display = on ? "block" : "none";
  listEl.style.display = on ? "none" : "flex";
}

function setInputEnabled(formEl, inputEl, on){
  inputEl.disabled = !on;
  formEl.querySelector("button").disabled = !on;
}

/* =========================
   UI helpers
========================= */
function clearActive(){
  document.querySelectorAll(".chat-room,.chat-dm").forEach(b=>{
    b.classList.remove("active","chat-item-active");
  });
}

function setActive(btn){
  clearActive();
  btn.classList.add("active","chat-item-active");
}

/* =========================
   Messages render
========================= */
function createMsg(m){
  const wrap = document.createElement("div");
  wrap.className = "chat-message";
  if(m.userId===currentUser.id) wrap.classList.add("me");

  wrap.innerHTML = `
    <div class="msg-avatar">${(m.name||"U").slice(0,2).toUpperCase()}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-name">${m.name||""}</span>
        <span>• ${formatTime(m.ts)}</span>
      </div>
      <div class="chat-message-text"></div>
    </div>
  `;
  wrap.querySelector(".chat-message-text").textContent = m.text;
  return wrap;
}

/* =========================
   Firestore subscribe
========================= */
function unsubscribeMainChat(){
  unsubscribeMain?.();
  unsubscribeMain = null;
}

function subscribeMain(roomId, listEl){
  unsubscribeMainChat();

  const q = query(
    collection(db, MESSAGES_COL),
    where("room","==",roomId),
    orderBy("ts","asc")
  );

  unsubscribeMain = onSnapshot(q,snap=>{
    listEl.innerHTML="";
    const frag=document.createDocumentFragment();
    let lastMsg=null;

    snap.forEach(d=>{
      const m={id:d.id,...d.data()};
      lastMsg=m;
      frag.appendChild(createMsg(m));
    });

    listEl.appendChild(frag);
    listEl.scrollTop=listEl.scrollHeight;

    // ✅ bump ONLY when message exists (send OR receive)
    if(activeChat?.type==="dm" && lastMsg){
      const otherId = getOtherId(roomId, currentUser.id);
      if(otherId) bumpRecent(otherId, lastMsg.ts);
    }
  });
}

/* =========================
   Recents reorder (DMs)
========================= */
function loadRecents(){
  try{
    return JSON.parse(localStorage.getItem(RECENTS_KEY(currentUser.id))) || {};
  }catch{
    return {};
  }
}

function saveRecents(map){
  localStorage.setItem(RECENTS_KEY(currentUser.id), JSON.stringify(map));
}

function bumpRecent(otherId, ts){
  if(!otherId) return;
  const map = loadRecents();
  map[otherId] = ts?.toMillis ? ts.toMillis() : Date.now();
  saveRecents(map);
  applyDmOrder();
}

function applyDmOrder(){
  const dmList=document.getElementById("dm-list");
  if(!dmList || !currentUser) return;

  const map=loadRecents();
  const items=[...dmList.querySelectorAll(".chat-dm")];

  items.sort((a,b)=>{
    const ta=map[a.dataset.dm]||0;
    const tb=map[b.dataset.dm]||0;
    return tb-ta;
  });

  items.forEach(i=>dmList.appendChild(i));
}

/* =========================
   Search
========================= */
function hookSearch(){
  const input=document.getElementById("chat-search");
  if(!input) return;

  input.oninput=()=>{
    const q=input.value.toLowerCase();
    document.querySelectorAll(".chat-room,.chat-dm").forEach(b=>{
      const t=b.innerText.toLowerCase();
      b.style.display = (!q||t.includes(q)) ? "" : "none";
    });
  };
}

/* =========================
   Status dots
========================= */
function subscribeStatusDots(){
  unsubscribeStatus?.();

  const today = new Date().toISOString().slice(0,10);
  const q=query(
    collection(db,AGENT_DAYS_COL),
    where("day","==",today)
  );

  unsubscribeStatus=onSnapshot(q,snap=>{
    document.querySelectorAll("[data-status-dot]").forEach(d=>{
      d.className="status-dot dot-offline";
    });

    snap.forEach(doc=>{
      const d=doc.data();
      const dot=document.querySelector(`[data-status-dot="${d.userId}"]`);
      if(!dot) return;

      if(d.status==="in_operation"||d.status==="handling")
        dot.classList.replace("dot-offline","dot-online");
      else if(d.status==="break"||d.status==="meeting")
        dot.classList.replace("dot-offline","dot-warn");
    });
  });
}

/* =========================
   INIT
========================= */
document.addEventListener("DOMContentLoaded",()=>{
  setCurrentUser();
  if(!currentUser) return;

  const listEl=document.getElementById("chat-message-list");
  const emptyEl=document.getElementById("chat-empty");
  const nameEl=document.getElementById("chat-room-name");
  const descEl=document.getElementById("chat-room-desc");
  const formEl=document.getElementById("chat-form");
  const inputEl=document.getElementById("chat-input");

  hookSearch();
  applyDmOrder();
  subscribeStatusDots();

  // Rooms
  document.querySelectorAll(".chat-room").forEach(btn=>{
    btn.onclick=()=>{
      setActive(btn);
      activeChat={type:"room", roomId:btn.dataset.room};
      setHeader(nameEl,descEl,btn.innerText,"");
      setEmptyState(emptyEl,listEl,false);
      setInputEnabled(formEl,inputEl,true);
      subscribeMain(activeChat.roomId,listEl);
    };
  });

  // DMs
  document.querySelectorAll(".chat-dm").forEach(btn=>{
    btn.onclick=()=>{
      const otherId=btn.dataset.dm;
      const roomId=dmRoomId(currentUser.id,otherId);

      setActive(btn);
      activeChat={type:"dm", roomId, otherId};
      setHeader(nameEl,descEl,btn.innerText,"Direct message");
      setEmptyState(emptyEl,listEl,false);
      setInputEnabled(formEl,inputEl,true);

      // ❌ NO bump here
      subscribeMain(roomId,listEl);
    };
  });

  // Send
  formEl.onsubmit=async e=>{
    e.preventDefault();
    if(!inputEl.value.trim()||!activeChat) return;

    await addDoc(collection(db,MESSAGES_COL),{
      room:activeChat.roomId,
      text:inputEl.value.trim(),
      userId:currentUser.id,
      name:currentUser.name,
      role:currentUser.role,
      ts:serverTimestamp()
    });

    inputEl.value="";
  };
});
