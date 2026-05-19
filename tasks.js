// tasks.js — Phase 2 Notes Pro
// Personal notes with Firestore autosave, mobile editor, search, and index fallback.

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
let saveInFlight = false;

function el(id) { return document.getElementById(id); }
function uid() { return `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function noteLang(){ return ((document.body?.dataset?.language || document.documentElement.lang || "ar") === "ar") ? "ar" : "en"; }
function nt(ar, en){ return noteLang() === "ar" ? ar : en; }
function escapeHtml(v) { return String(v || "").replace(/[&<>"']/g, (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[m])); }
function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { return null; } }
function tsToMs(v){
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v?.toMillis === "function") return v.toMillis();
  if (typeof v?.seconds === "number") return v.seconds * 1000;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}
function formatWhen(v){
  const ms = tsToMs(v);
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleString(noteLang() === "ar" ? "ar-GB" : "en-GB", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
}

function setStatus(message, type = "neutral") {
  const box = el("note-save-status");
  const mobile = el("note-mobile-status");
  [box, mobile].forEach((node) => {
    if (!node) return;
    node.textContent = message;
    node.classList.remove("is-saving", "is-saved", "is-error", "is-typing");
    node.classList.add(`is-${type}`);
  });
}

function setEditorVisible(visible) {
  el("notes-editor-pane")?.classList.toggle("hidden", !visible);
  el("notes-empty-state")?.classList.toggle("hidden", visible);
  el("notes-app")?.classList.toggle("is-editing", visible);
}

function blankEditor(showEmpty = true) {
  if (el("note-title")) el("note-title").value = "";
  if (el("note-body")) el("note-body").value = "";
  if (el("note-updated-at")) el("note-updated-at").textContent = "—";
  selectedId = null;
  isDirty = false;
  setStatus(nt("جاهز", "Ready"), "saved");
  setEditorVisible(!showEmpty);
  renderNotesList();
}

function applyEditor(note) {
  if (el("note-title")) el("note-title").value = note?.title || "";
  if (el("note-body")) el("note-body").value = note?.body || "";
  if (el("note-updated-at")) el("note-updated-at").textContent = note?.updatedAt ? `${nt("آخر تعديل", "Updated")}: ${formatWhen(note.updatedAt)}` : nt("ملاحظة جديدة", "New note");
  setEditorVisible(true);
}

async function selectNote(id) {
  if (isDirty) await saveCurrentNote({ silent: true });
  const note = notes.find((n) => n.id === id);
  if (!note) return blankEditor(true);
  selectedId = id;
  applyEditor(note);
  isDirty = false;
  setStatus(nt("تم الحفظ", "Saved"), "saved");
  renderNotesList();
  if (window.matchMedia("(max-width: 760px)").matches) {
    el("notes-app")?.classList.add("mobile-editor-open");
  }
}

function notePreview(note) {
  const body = String(note.body || "").replace(/\s+/g, " ").trim();
  return body || nt("لا يوجد نص إضافي", "No additional text");
}

function renderNotesList() {
  const list = el("notes-list");
  const count = el("notes-count");
  if (!list) return;

  const q = (el("notes-search")?.value || "").trim().toLowerCase();
  const visible = notes.filter((n) => {
    if (!q) return true;
    return `${n.title || ""} ${n.body || ""}`.toLowerCase().includes(q);
  });
  if (count) count.textContent = String(visible.length);

  if (!visible.length) {
    list.innerHTML = `<div class="notes-empty-list"><strong>${q ? nt("لا توجد نتائج", "No results") : nt("لا توجد ملاحظات بعد", "No notes yet")}</strong><span>${nt("اضغط + ملاحظة جديدة للبدء.", "Tap + New note to start.")}</span></div>`;
    return;
  }

  list.innerHTML = visible.map((n) => {
    const title = n.title || nt("بدون عنوان", "Untitled");
    return `<button type="button" class="note-row note-pro-row ${n.id === selectedId ? "active" : ""}" data-note-id="${escapeHtml(n.id)}">
      <div class="note-row-top">
        <strong>${escapeHtml(title)}</strong>
        <time>${escapeHtml(formatWhen(n.updatedAt))}</time>
      </div>
      <span>${escapeHtml(notePreview(n))}</span>
    </button>`;
  }).join("");

  list.querySelectorAll("[data-note-id]").forEach((btn) => {
    btn.addEventListener("click", () => selectNote(btn.dataset.noteId));
  });
}

async function saveCurrentNote({ silent = false } = {}) {
  if (!currentUser) {
    setStatus(nt("يلزم تسجيل الدخول", "Login required"), "error");
    return false;
  }
  if (saveInFlight) return false;

  const titleRaw = (el("note-title")?.value || "").trim();
  const body = el("note-body")?.value || "";
  const hasContent = titleRaw || body.trim();
  if (!hasContent) {
    setStatus(nt("فارغة", "Empty"), "saved");
    return false;
  }

  if (!selectedId) selectedId = uid();
  const title = titleRaw || nt("بدون عنوان", "Untitled");
  const exists = notes.some((n) => n.id === selectedId);
  const now = Date.now();

  saveInFlight = true;
  if (!silent) setStatus(nt("جاري الحفظ...", "Saving..."), "saving");

  // Optimistic local update so the list feels instant.
  const localNote = { id: selectedId, userId: currentUser.id, title, body, updatedAt: now, ...(exists ? {} : { createdAt: now }) };
  const idx = notes.findIndex((n) => n.id === selectedId);
  if (idx >= 0) notes[idx] = { ...notes[idx], ...localNote };
  else notes.unshift(localNote);
  notes.sort((a, b) => (tsToMs(b.updatedAt) || 0) - (tsToMs(a.updatedAt) || 0));
  renderNotesList();

  try {
    await setDoc(doc(collection(db, NOTES_COL), selectedId), {
      userId: currentUser.id,
      title,
      body,
      updatedAt: serverTimestamp(),
      ...(exists ? {} : { createdAt: serverTimestamp() }),
    }, { merge: true });
    isDirty = false;
    setStatus(nt("تم الحفظ", "Saved"), "saved");
    return true;
  } catch (err) {
    console.error("note save failed", err);
    setStatus(nt("فشل الحفظ", "Save failed"), "error");
    return false;
  } finally {
    saveInFlight = false;
  }
}

function scheduleSave() {
  isDirty = true;
  setStatus(nt("يتم الكتابة...", "Typing..."), "typing");
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => saveCurrentNote(), 700);
}

async function deleteCurrentNote() {
  if (!selectedId) return;
  if (!confirm(nt("حذف هذه الملاحظة؟", "Delete this note?"))) return;
  const id = selectedId;
  try {
    await deleteDoc(doc(db, NOTES_COL, id));
    notes = notes.filter((n) => n.id !== id);
    blankEditor(true);
    setStatus(nt("تم الحذف", "Deleted"), "saved");
  } catch (err) {
    console.error("delete note failed", err);
    setStatus(nt("فشل الحذف", "Delete failed"), "error");
  }
}

function subscribeNotes() {
  if (unsubNotes) unsubNotes();
  if (!currentUser) return;

  const attach = (ordered = true) => {
    const baseQ = query(collection(db, NOTES_COL), where("userId", "==", currentUser.id));
    const q = ordered ? query(baseQ, orderBy("updatedAt", "desc")) : baseQ;
    unsubNotes = onSnapshot(q, (snap) => {
      notes = [];
      snap.forEach((d) => notes.push({ id: d.id, ...d.data() }));
      notes.sort((a, b) => (tsToMs(b.updatedAt) || 0) - (tsToMs(a.updatedAt) || 0));
      renderNotesList();
      if (selectedId) {
        const selected = notes.find((n) => n.id === selectedId);
        if (selected && !isDirty) applyEditor(selected);
      } else {
        blankEditor(true);
      }
    }, (err) => {
      const msg = String(err?.message || err || "").toLowerCase();
      if (ordered && (msg.includes("index") || msg.includes("failed-precondition"))) {
        console.warn("Notes ordered query requires index. Falling back to unordered query.");
        try { unsubNotes?.(); } catch {}
        attach(false);
        return;
      }
      console.error("notes listener failed", err);
      setStatus(nt("تعذر تحميل الملاحظات", "Could not load notes"), "error");
    });
  };
  attach(true);
}

async function newNote() {
  if (isDirty) await saveCurrentNote({ silent: true });
  selectedId = uid();
  applyEditor({ id: selectedId, title: "", body: "", updatedAt: null });
  isDirty = false;
  setStatus(nt("ملاحظة جديدة", "New note"), "saved");
  renderNotesList();
  el("note-title")?.focus();
  if (window.matchMedia("(max-width: 760px)").matches) {
    el("notes-app")?.classList.add("mobile-editor-open");
  }
}

function closeMobileEditor() {
  el("notes-app")?.classList.remove("mobile-editor-open");
}

function hookNotes() {
  if (isHooked) return;
  isHooked = true;
  el("note-new-btn")?.addEventListener("click", newNote);
  el("note-empty-new-btn")?.addEventListener("click", newNote);
  el("note-save-btn")?.addEventListener("click", () => saveCurrentNote());
  el("note-delete-btn")?.addEventListener("click", deleteCurrentNote);
  el("notes-back-btn")?.addEventListener("click", closeMobileEditor);
  el("notes-search")?.addEventListener("input", renderNotesList);
  el("note-title")?.addEventListener("input", scheduleSave);
  el("note-body")?.addEventListener("input", scheduleSave);
  window.addEventListener("beforeunload", () => { if (isDirty) saveCurrentNote({ silent: true }); });
}

function initNotes() {
  currentUser = getUser();
  hookNotes();
  if (!currentUser) {
    notes = [];
    blankEditor(true);
    if (unsubNotes) unsubNotes();
    unsubNotes = null;
    setStatus(nt("يلزم تسجيل الدخول", "Login required"), "error");
    return;
  }
  subscribeNotes();
}

document.addEventListener("DOMContentLoaded", initNotes);
window.addEventListener("telesyriana:user-changed", initNotes);
