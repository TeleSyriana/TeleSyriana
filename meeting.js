// meetings.js
let localStream = null;

const stage = document.getElementById("meeting-stage");
const videoEl = document.getElementById("local-video");

const joinBtn = document.getElementById("join-meeting-btn");
const micBtn  = document.getElementById("btn-mic");
const camBtn  = document.getElementById("btn-cam");
const handBtn = document.getElementById("btn-hand");
const leaveBtn= document.getElementById("btn-leave");

joinBtn?.addEventListener("click", async () => {
  try{
    // ✅ TODO: validate meeting id + password from your meetings store
    localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    videoEl.srcObject = localStream;

    stage.classList.remove("hidden");
  }catch(e){
    alert("Camera/Mic blocked. Please allow permissions.");
  }
});

micBtn?.addEventListener("click", () => {
  if(!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if(!track) return;
  track.enabled = !track.enabled;
  micBtn.textContent = track.enabled ? "🎤 Mute" : "🔇 Unmute";
});

camBtn?.addEventListener("click", () => {
  if(!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if(!track) return;
  track.enabled = !track.enabled;
  camBtn.textContent = track.enabled ? "📷 Camera off" : "🚫 Camera on";
});

handBtn?.addEventListener("click", () => {
  // ✅ later: send event to supervisor via realtime
  handBtn.textContent = "✋ Raised";
  setTimeout(()=> handBtn.textContent="✋ Raise hand", 1500);
});

leaveBtn?.addEventListener("click", () => {
  if(localStream){
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  stage.classList.add("hidden");
  videoEl.srcObject = null;
});
