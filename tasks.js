// tasks.js — Phase 8 Apple-style Personal Notes
// Firestore collection: personalNotes. Each user sees only their own notes in the UI.

import { db, fs } from "./firebase.js";

const {
  collection,
  doc,
  setDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
} = fs;

const USER_KEY = "telesyrianaUser";
const NOTES_COL = "personalNotes";

let currentUser = null;
let notes = [];
let selectedId = null;
let unsubNotes = null;
let isHooked = false;
let autosaveTimer = null;
let isDirty = false;
function noteLang(){ return ((document.body?.dataset?.language || document.documentElement.lang || "en") === "ar") ? "ar" : "en"; }
function nt(ar, en){ return noteLang() === "ar" ? ar : en; }
function tsToMs(v){
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v?.toMillis === "function") return v.toMillis();
  if (typeof v?.seconds === "number") return v.seconds * 1000;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}


function el(id) { return document.getElementById(id); }
function uid() { return `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function escapeHtml(v) { return String(v || "").replace(/[&<>"']/g, (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[m])); }
function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { return null; }
}

function setالحالة(message, danger = false) {
  const box = el("note-save-status");
  if (!box) return;
  box.textContent = message;
  box.classList.toggle("danger", Boolean(danger));
}

function blankEditor() {
  if (el("note-title")) el("note-title").value = "";
  if (el("note-body")) el("note-body").value = "";
  selectedId = null;
  isDirty = false;
  setالحالة(nt("جاهز", "Ready"));
  renderNotesList();
}

function selectNote(id) {
  if (isDirty) saveCurrentNote();
  const note = notes.find((n) => n.id === id);
  if (!note) return blankEditor();
  selectedId = id;
  if (el("note-title")) el("note-title").value = note.title || "";
  if (el("note-body")) el("note-body").value = note.body || "";
  isDirty = false;
  setالحالة(nt("تم الحفظ", "Saved"));
  renderNotesList();
}

function renderNotesList() {
  const list = el("notes-list");
  if (!list) return;
  const q = (el("notes-search")?.value || "").trim().toLowerCase();
  const visible = notes.filter((n) => {
    if (!q) return true;
    return `${n.title || ""} ${n.body || ""}`.toLowerCase().includes(q);
  });
  if (!visible.length) {
    list.innerHTML = `<div class="notes-empty">${nt("لا توجد ملاحظات بعد.", "No notes yet.")}</div>`;
    return;
  }
  list.innerHTML = visible.map((n) => {
    const body = String(n.body || "").replace(/\s+/g, " ").trim();
    return `<button type="button" class="note-row ${n.id === selectedId ? "active" : ""}" data-note-id="${escapeHtml(n.id)}">
      <strong>${escapeHtml(n.title || "Untitled")}</strong>
      <span>${escapeHtml(body || "No additional text")}</span>
    </button>`;
  }).join("");
  list.querySelectorAll("[data-note-id]").forEach((btn) => {
    btn.addEventListener("click", () => selectNote(btn.dataset.noteId));
  });
}

async function saveCurrentNote() {
  if (!currentUser) return setالحالة(nt("يلزم تسجيل الدخول", "Login required"), true);
  const title = (el("note-title")?.value || "").trim() || "Untitled";
  const body = el("note-body")?.value || "";
  if (!selectedId) selectedId = uid();
  const ref = doc(collection(db, NOTES_COL), selectedId);
  const exists = notes.some((n) => n.id === selectedId);
  setالحالة(nt("جاري الحفظ...", "Saving..."));
  try {
    await setDoc(ref, {
      userId: currentUser.id,
      title,
      body,
      updatedAt: serverTimestamp(),
      ...(exists ? {} : { createdAt: serverTimestamp() }),
    }, { merge: true });
    isDirty = false;
    setالحالة(nt("تم الحفظ", "Saved"));
  } catch (err) {
    console.error("note save failed", err);
    setالحالة("Save failed — check Firebase rules/internet", true);
  }
}

function scheduleSave() {
  isDirty = true;
  setالحالة(nt("يكتب...", "Typing..."));
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveCurrentNote, 900);
}

async function deleteCurrentNote() {
  if (!selectedId) return;
  if (!confirm("Delete this note?")) return;
  try {
    await deleteDoc(doc(db, NOTES_COL, selectedId));
    blankEditor();
    setالحالة(nt("تم الحذف", "Deleted"));
  } catch (err) {
    console.error("delete note failed", err);
    setالحالة("Delete failed", true);
  }
}

function subscribeNotes() {
  if (unsubNotes) unsubNotes();
  if (!currentUser) return;

  const attachNotesListener = (useOrderedQuery = true) => {
    const baseQ = query(collection(db, NOTES_COL), where("userId", "==", currentUser.id));
    const q = useOrderedQuery ? query(baseQ, orderBy("updatedAt", "desc")) : baseQ;
    unsubNotes = onSnapshot(q, (snap) => {
      notes = [];
      snap.forEach((d) => notes.push({ id: d.id, ...d.data() }));
      notes.sort((a, b) => (tsToMs(b.updatedAt) || 0) - (tsToMs(a.updatedAt) || 0));
      renderNotesList();
      if (!selectedId && notes.length) selectNote(notes[0].id);
    }, (err) => {
      const msg = String(err?.message || err || "").toLowerCase();
      if (useOrderedQuery && (msg.includes("index") || msg.includes("failed-precondition"))) {
        console.warn("notes ordered query requires index. Falling back to unordered query.");
        try { unsubNotes?.(); } catch {}
        attachNotesListener(false);
        return;
      }
      console.error("notes listener failed", err);
      setالحالة("Could not load notes. Check Firestore rules/indexes.", true);
    });
  };

  attachNotesListener(true);
}

function newNote() {
  if (isDirty) saveCurrentNote();
  selectedId = uid();
  if (el("note-title")) el("note-title").value = "";
  if (el("note-body")) el("note-body").value = "";
  isDirty = false;
  setالحالة(nt("ملاحظة جديدة", "New note"));
  renderNotesList();
  el("note-title")?.focus();
}

function hookNotes() {
  if (isHooked) return;
  isHooked = true;
  el("note-new-btn")?.addEventListener("click", newNote);
  el("note-delete-btn")?.addEventListener("click", deleteCurrentNote);
  el("notes-search")?.addEventListener("input", renderNotesList);
  el("note-title")?.addEventListener("input", scheduleSave);
  el("note-body")?.addEventListener("input", scheduleSave);
  window.addEventListener("beforeunload", () => { if (isDirty) saveCurrentNote(); });
}

function initNotes() {
  currentUser = getUser();
  hookNotes();
  if (!currentUser) {
    notes = [];
    blankEditor();
    if (unsubNotes) unsubNotes();
    unsubNotes = null;
    return;
  }
  subscribeNotes();
}

document.addEventListener("DOMContentLoaded", initNotes);
window.addEventListener("telesyriana:user-changed", initNotes);
