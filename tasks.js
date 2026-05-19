// tasks.js — TeleSyriana Notes Pro
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
let isSaving = false;

function noteLang(){ return ((document.body?.dataset?.language || document.documentElement.lang || "en") === "ar") ? "ar" : "en"; }
function nt(ar, en){ return noteLang() === "ar" ? ar : en; }
function el(id) { return document.getElementById(id); }
function uid() { return `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function escapeHtml(v) { return String(v || "").replace(/[&<>"']/g, (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[m])); }
function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { return null; } }
function nowMs(){ return Date.now(); }
function tsToMs(v){
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v?.toMillis === "function") return v.toMillis();
  if (typeof v?.seconds === "number") return v.seconds * 1000;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}
function formatUpdated(v){
  const ms = tsToMs(v);
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString(noteLang() === "ar" ? "ar" : "en-GB", { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" });
  } catch { return "—"; }
}
function wordsCount(body){
  const words = String(body || "").trim().split(/\s+/).filter(Boolean).length;
  return noteLang() === "ar" ? `${words} كلمة` : `${words} words`;
}
function setالحالة(message, danger = false, busy = false) {
  const box = el("note-save-status");
  if (!box) return;
  box.innerHTML = `${busy ? '<span class="note-status-spinner" aria-hidden="true"></span>' : ''}${escapeHtml(message)}`;
  box.classList.toggle("danger", Boolean(danger));
  box.classList.toggle("saving", Boolean(busy));
}
function setEditorOpen(open){
  document.getElementById("page-tasks")?.classList.toggle("note-editor-open", Boolean(open));
  el("note-empty-state")?.classList.toggle("hidden", Boolean(open));
  document.querySelector(".note-editor-fields")?.classList.toggle("hidden", !open);
  el("note-delete-btn")?.classList.toggle("hidden", !open);
  el("note-save-now-btn")?.classList.toggle("hidden", !open);
}
function updateEditorMeta(note){
  el("note-last-updated") && (el("note-last-updated").textContent = note?.updatedAt ? `${nt("آخر تحديث", "Updated")}: ${formatUpdated(note.updatedAt)}` : "—");
  el("note-word-count") && (el("note-word-count").textContent = wordsCount(el("note-body")?.value || note?.body || ""));
}
function updateCount(visibleCount = notes.length){
  const c = el("notes-count");
  if (c) c.textContent = String(visibleCount);
}

function blankEditor() {
  if (el("note-title")) el("note-title").value = "";
  if (el("note-body")) el("note-body").value = "";
  selectedId = null;
  isDirty = false;
  setEditorOpen(false);
  setالحالة(nt("جاهز", "Ready"));
  updateEditorMeta(null);
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
  setEditorOpen(true);
  setالحالة(nt("تم الحفظ", "Saved"));
  updateEditorMeta(note);
  renderNotesList();
  if (window.matchMedia?.("(max-width: 820px)").matches) {
    document.querySelector(".notes-pro-editor")?.scrollIntoView({ block:"start", behavior:"smooth" });
  }
}

function renderNotesList() {
  const list = el("notes-list");
  if (!list) return;
  const q = (el("notes-search")?.value || "").trim().toLowerCase();
  const visible = notes
    .filter((n) => !q || `${n.title || ""} ${n.body || ""}`.toLowerCase().includes(q))
    .sort((a,b) => (tsToMs(b.updatedAt) || 0) - (tsToMs(a.updatedAt) || 0));
  updateCount(visible.length);
  if (!visible.length) {
    list.innerHTML = `<div class="notes-empty">${q ? nt("لا توجد نتائج مطابقة.", "No matching notes.") : nt("لا توجد ملاحظات بعد.", "No notes yet.")}</div>`;
    return;
  }
  list.innerHTML = visible.map((n) => {
    const body = String(n.body || "").replace(/\s+/g, " ").trim();
    const title = (n.title || "").trim() || nt("بدون عنوان", "Untitled");
    return `<button type="button" class="note-row ${n.id === selectedId ? "active" : ""}" data-note-id="${escapeHtml(n.id)}">
      <div class="note-row-top">
        <strong>${escapeHtml(title)}</strong>
        <time>${escapeHtml(formatUpdated(n.updatedAt))}</time>
      </div>
      <span>${escapeHtml(body || nt("لا يوجد نص إضافي", "No additional text"))}</span>
    </button>`;
  }).join("");
  list.querySelectorAll("[data-note-id]").forEach((btn) => btn.addEventListener("click", () => selectNote(btn.dataset.noteId)));
}

async function saveCurrentNote() {
  if (!currentUser) return setالحالة(nt("يلزم تسجيل الدخول", "Login required"), true);
  if (!selectedId && !(el("note-title")?.value || el("note-body")?.value)) return;
  const title = (el("note-title")?.value || "").trim() || nt("بدون عنوان", "Untitled");
  const body = el("note-body")?.value || "";
  if (!selectedId) selectedId = uid();
  const ref = doc(collection(db, NOTES_COL), selectedId);
  const exists = notes.some((n) => n.id === selectedId);
  const optimistic = { id:selectedId, userId:currentUser.id, title, body, updatedAt:nowMs(), ...(exists ? {} : { createdAt:nowMs() }) };
  notes = exists ? notes.map((n) => n.id === selectedId ? { ...n, ...optimistic } : n) : [optimistic, ...notes];
  renderNotesList();
  updateEditorMeta(optimistic);
  isSaving = true;
  el("note-save-now-btn")?.setAttribute("disabled", "disabled");
  setالحالة(nt("جاري الحفظ...", "Saving..."), false, true);
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
    setالحالة(nt("فشل الحفظ — تحقق من Firebase أو الإنترنت", "Save failed — check Firebase/internet"), true);
  } finally {
    isSaving = false;
    el("note-save-now-btn")?.removeAttribute("disabled");
  }
}

function scheduleSave() {
  if (!selectedId) selectedId = uid();
  isDirty = true;
  setEditorOpen(true);
  setالحالة(nt("يكتب...", "Typing..."));
  updateEditorMeta({ body: el("note-body")?.value || "" });
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveCurrentNote, 700);
}

async function deleteCurrentNote() {
  if (!selectedId) return;
  if (!confirm(nt("حذف هذه الملاحظة؟", "Delete this note?"))) return;
  const id = selectedId;
  try {
    await deleteDoc(doc(db, NOTES_COL, id));
    notes = notes.filter((n) => n.id !== id);
    blankEditor();
    setالحالة(nt("تم الحذف", "Deleted"));
  } catch (err) {
    console.error("delete note failed", err);
    setالحالة(nt("فشل الحذف", "Delete failed"), true);
  }
}

function subscribeNotes() {
  if (unsubNotes) unsubNotes();
  if (!currentUser) return;
  const attach = (ordered = true) => {
    const baseQ = query(collection(db, NOTES_COL), where("userId", "==", currentUser.id));
    const q = ordered ? query(baseQ, orderBy("updatedAt", "desc")) : baseQ;
    unsubNotes = onSnapshot(q, (snap) => {
      const next = [];
      snap.forEach((d) => next.push({ id: d.id, ...d.data() }));
      notes = next.sort((a,b) => (tsToMs(b.updatedAt) || 0) - (tsToMs(a.updatedAt) || 0));
      renderNotesList();
      if (selectedId && !notes.some((n) => n.id === selectedId)) blankEditor();
      if (!selectedId && notes.length && !window.matchMedia?.("(max-width: 820px)").matches) selectNote(notes[0].id);
    }, (err) => {
      const msg = String(err?.message || err || "").toLowerCase();
      if (ordered && (msg.includes("index") || msg.includes("failed-precondition"))) {
        console.warn("notes ordered query requires index. Falling back to unordered query.");
        try { unsubNotes?.(); } catch {}
        attach(false);
        return;
      }
      console.error("notes listener failed", err);
      setالحالة(nt("تعذر تحميل الملاحظات. تحقق من Firebase.", "Could not load notes. Check Firebase."), true);
    });
  };
  attach(true);
}

function newNote() {
  if (isDirty) saveCurrentNote();
  selectedId = uid();
  if (el("note-title")) el("note-title").value = "";
  if (el("note-body")) el("note-body").value = "";
  isDirty = false;
  setEditorOpen(true);
  setالحالة(nt("ملاحظة جديدة", "New note"));
  updateEditorMeta(null);
  renderNotesList();
  setTimeout(() => el("note-title")?.focus(), 50);
}

function hookNotes() {
  if (isHooked) return;
  isHooked = true;
  el("note-new-btn")?.addEventListener("click", newNote);
  el("note-delete-btn")?.addEventListener("click", deleteCurrentNote);
  el("note-save-now-btn")?.addEventListener("click", saveCurrentNote);
  el("note-mobile-back")?.addEventListener("click", () => document.getElementById("page-tasks")?.classList.remove("note-editor-open"));
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
