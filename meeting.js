// meetings.js (Local meetings + local camera preview)
// Storage keys
const MEETINGS_KEY = "tele_meetings_v1";
const USER_KEY     = "tele_current_user_v1";

// DOM
const meetingsListEl = document.getElementById("meetings-list");
const meetingsEmpty  = document.getElementById("meetings-empty");

const searchInput = document.getElementById("meeting-search");
const searchClear = document.getElementById("meeting-search-clear");

// Create (sup)
const createBox   = document.getElementById("create-meeting-box");
const createBtn   = document.getElementById("create-meeting-btn");
const createTitle = document.getElementById("create-title");
const createDate  = document.getElementById("create-date");
const createTime  = document.getElementById("create-time");
const createId    = document.getElementById("create-id");
const createPass  = document.getElementById("create-pass");

// Join + stage
let localStream = null;
let joinedMeeting = null;

const joinBtn = document.getElementById("join-meeting-btn");
const stage   = document.getElementById("meeting-stage");
const videoEl = document.getElementById("local-video");
const liveTitle = document.getElementById("meeting-live-title");
const liveMeta  = document.getElementById("meeting-live-meta");

const micBtn   = document.getElementById("btn-mic");
const camBtn   = document.getElementById("btn-cam");
const handBtn  = document.getElementById("btn-hand");
const leaveBtn = document.getElementById("btn-leave");

// -------------------- Helpers --------------------
function loadMeetings(){
  try { return JSON.parse(localStorage.getItem(MEETINGS_KEY) || "[]"); }
  catch { return []; }
}
function saveMeetings(list){
  localStorage.setItem(MEETINGS_KEY, JSON.stringify(list));
}

function genId(len=4){
  return String(Math.floor(Math.random() * (10 ** len))).padStart(len, "0");
}

function getCurrentUser(){
  // 1) if you already set window.currentUser in app.js, we use it
  if (window.currentUser) return window.currentUser;

  // 2) fallback to localStorage
  try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }
  catch { return null; }
}

function getCcms(){
  const u = getCurrentUser();
  const ccms = u?.ccmsId ?? u?.ccms ?? u?.id ?? "";
  return String(ccms || "");
}

function isSupervisor(){
  // Your demo: supervisors are 2001/2002 -> starts with "200"
  return getCcms().startsWith("200");
}

function formatWhen(iso){
  try{
    const d = new Date(iso);
    return d.toLocaleString();
  }catch{
    return iso;
  }
}

function validateJoin(id, pass){
  const list = loadMeetings();
  const m = list.find(x => String(x.id) === String(id));
  if(!m) return { ok:false, msg:"Meeting ID not found" };
  if(String(m.pass) !== String(pass)) return { ok:false, msg:"Wrong password" };
  return { ok:true, meeting:m };
}

// -------------------- UI --------------------
function initCreateBox(){
  if(!createBox) return;

  if(isSupervisor()){
    createBox.classList.remove("hidden");
    if(createId && !createId.value) createId.value = genId(4);
    if(createPass && !createPass.value) createPass.value = genId(4);

    // default date/time (next 10 minutes)
    const now = new Date(Date.now() + 10*60*1000);
    if(createDate && !createDate.value){
      createDate.value = now.toISOString().slice(0,10);
    }
    if(createTime && !createTime.value){
      const hh = String(now.getHours()).padStart(2,"0");
      const mm = String(now.getMinutes()).padStart(2,"0");
      createTime.value = `${hh}:${mm}`;
    }
  }else{
    createBox.classList.add("hidden");
  }
}

function renderMeetings(filterText = ""){
  if(!meetingsListEl) return;

  const list = loadMeetings();

  // show only upcoming (>= now - 2 hours) so ما تختفي لو تأخرت شوي
  const cutoff = Date.now() - (2 * 60 * 60 * 1000);

  const filtered = list
    .filter(m => {
      const t = `${m.id} ${m.title} ${m.hostCcms}`.toLowerCase();
      const okSearch = t.includes(filterText.toLowerCase());
      const okTime = new Date(m.when).getTime() >= cutoff;
      return okSearch && okTime;
    })
    .sort((a,b) => (a.when||"").localeCompare(b.when||""));

  meetingsListEl.innerHTML = "";

  if(filtered.length === 0){
    meetingsEmpty?.classList.remove("hidden");
    return;
  }
  meetingsEmpty?.classList.add("hidden");

  filtered.forEach(m=>{
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-room";

    btn.innerHTML = `
      <div class="chat-row">
        <div class="chat-avatar role-room">M</div>
        <div class="chat-row-text">
          <div class="chat-room-title">${escapeHtml(m.title || "Meeting")}</div>
          <div class="chat-room-sub">ID ${m.id} • ${formatWhen(m.when)}</div>
        </div>
      </div>
    `;

    btn.addEventListener("click", ()=>{
      const idEl = document.getElementById("join-meeting-id");
      const passEl = document.getElementById("join-meeting-pass");
      if(idEl) idEl.value = m.id;
      if(passEl) passEl.value = m.pass;
    });

    meetingsListEl.appendChild(btn);
  });
}

function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// -------------------- Events --------------------

// Search
searchInput?.addEventListener("input", (e)=>{
  renderMeetings(e.target.value || "");
});
searchClear?.addEventListener("click", ()=>{
  if(searchInput) searchInput.value = "";
  renderMeetings("");
});

// Create meeting (Supervisor only)
createBtn?.addEventListener("click", ()=>{
  if(!isSupervisor()) return alert("Supervisors only.");

  const title = createTitle?.value.trim() || "Meeting";
  const date  = createDate?.value;
  const time  = createTime?.value;

  if(!date || !time) return alert("Pick date & time.");

  const id   = (createId?.value || genId(4)).trim();
  const pass = (createPass?.value || genId(4)).trim();

  // Build ISO
  const when = new Date(`${date}T${time}`).toISOString();
  const hostCcms = getCcms() || "2001";

  const list = loadMeetings();
  if(list.some(m => String(m.id) === String(id))){
    return alert("Meeting ID already exists. Change it.");
  }

  list.push({ id, pass, title, when, hostCcms });
  saveMeetings(list);

  renderMeetings(searchInput?.value || "");

  // regenerate for next create
  if(createId) createId.value = genId(4);
  if(createPass) createPass.value = genId(4);

  alert(`Created ✅\nID: ${id}\nPass: ${pass}`);
});

// Join meeting -> validate -> open camera
joinBtn?.addEventListener("click", async ()=>{
  const id = document.getElementById("join-meeting-id")?.value.trim();
  const pass = document.getElementById("join-meeting-pass")?.value.trim();

  if(!id || !pass) return alert("Enter Meeting ID + Password.");

  const v = validateJoin(id, pass);
  if(!v.ok) return alert(v.msg);

  joinedMeeting = v.meeting;

  try{
    localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });

    if(videoEl) videoEl.srcObject = localStream;
    if(stage) stage.classList.remove("hidden");

    if(liveTitle) liveTitle.textContent = joinedMeeting.title || "In meeting";
    if(liveMeta)  liveMeta.textContent  = `ID ${joinedMeeting.id}`;

    // reset button labels
    if(micBtn) micBtn.textContent = "🎤 Mute";
    if(camBtn) camBtn.textContent = "📷 Camera off";
  }catch(e){
    alert("Camera/Mic blocked. Please allow permissions in browser.");
  }
});

// Mic toggle
micBtn?.addEventListener("click", ()=>{
  if(!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if(!track) return;
  track.enabled = !track.enabled;
  micBtn.textContent = track.enabled ? "🎤 Mute" : "🔇 Unmute";
});

// Cam toggle
camBtn?.addEventListener("click", ()=>{
  if(!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if(!track) return;
  track.enabled = !track.enabled;
  camBtn.textContent = track.enabled ? "📷 Camera off" : "🚫 Camera on";
});

// Raise hand (local)
handBtn?.addEventListener("click", ()=>{
  if(!joinedMeeting) return;
  const old = handBtn.textContent;
  handBtn.textContent = "✋ Raised";
  setTimeout(()=> handBtn.textContent = old, 1200);
});

// Leave
leaveBtn?.addEventListener("click", ()=>{
  if(localStream){
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  joinedMeeting = null;

  if(stage) stage.classList.add("hidden");
  if(videoEl) videoEl.srcObject = null;
  if(liveMeta) liveMeta.textContent = "";
});

// -------------------- Boot --------------------
initCreateBox();
renderMeetings("");
