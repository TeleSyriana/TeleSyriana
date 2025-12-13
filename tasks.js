// tasks.js — Trello-like Tasks + Modal (title/desc/image upload) + LocalStorage + Firestore Sync per user/day

import { db, fs } from "./firebase.js";

// ✅ Firestore
const { doc, setDoc, getDoc, collection, serverTimestamp, onSnapshot } = fs;

// ✅ Firebase Storage (CDN module import)
import {
  getStorage,
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

const storage = getStorage();

const USER_KEY = "telesyrianaUser";
const TASKS_LOCAL_PREFIX = "telesyrianaTasks"; // per user/day
const TASK_BOARDS_COL = "taskBoards"; // Firestore collection

const COLS = ["todo", "doing", "done"];

let currentUser = null;
let board = null; // { todo:[], doing:[], done:[] }
let isReady = false;

let unsubBoard = null;
let lastBoardJson = ""; // prevent unnecessary re-render loops

// ---------------- helpers ----------------

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function getUserFromStorage() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    if (u?.id && u?.name && u?.role) return u;
  } catch {}
  return null;
}

function localKey(userId) {
  return `${TASKS_LOCAL_PREFIX}:${getTodayKey()}:${userId}`;
}

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeBoard(b) {
  const base = { todo: [], doing: [], done: [] };
  if (!b || typeof b !== "object") return base;
  for (const c of COLS) base[c] = Array.isArray(b[c]) ? b[c] : [];
  return base;
}

function findTask(taskId) {
  for (const col of COLS) {
    const idx = board[col].findIndex((t) => t.id === taskId);
    if (idx !== -1) return { col, idx, task: board[col][idx] };
  }
  return null;
}

function getDocIdForUserDay(userId) {
  return `${getTodayKey()}_${userId}`;
}

// ---------------- DOM refs ----------------

function el(id) {
  return document.getElementById(id);
}

function getListEl(col) {
  return document.querySelector(`.kanban-list[data-list="${col}"]`);
}

function getCountEl(col) {
  return document.querySelector(`.count[data-count="${col}"]`);
}

function toast(msg) {
  // simple alert for now (يمكن نبدلها لاحقاً بتوست UI)
  alert(msg);
}

// ---------------- Modal ----------------

function openModal(prefill = {}) {
  const modal = el("task-modal");
  if (!modal) {
    alert("Task modal not found. Please add the modal HTML block (task-modal).");
    return;
  }

  el("task-modal-title").value = (prefill.title || "").trim();
  el("task-modal-desc").value = "";
  el("task-modal-img").value = "";
  if (el("task-modal-file")) el("task-modal-file").value = "";
  el("task-modal-col").value = prefill.col || "todo";

  modal.classList.remove("hidden");
  setTimeout(() => el("task-modal-title")?.focus(), 0);
}

function closeModal() {
  el("task-modal")?.classList.add("hidden");
}

function hookModal() {
  // close on backdrop / X / Cancel
  document.querySelectorAll("[data-modal-close]").forEach((btn) => {
    btn.addEventListener("click", closeModal);
  });

  // submit modal -> add task (with upload)
  el("task-modal-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentUser) return toast("Please login first.");

    const title = el("task-modal-title")?.value?.trim();
    const desc = el("task-modal-desc")?.value?.trim() || "";
    const linkImg = el("task-modal-img")?.value?.trim() || "";
    const col = el("task-modal-col")?.value || "todo";

    const fileInput = el("task-modal-file");
    const file = fileInput?.files?.[0] || null;

    // ✅ create task id first (so storage path stable)
    const taskId = uid();

    let uploadedUrl = "";

    // ✅ Upload file if exists
    if (file) {
      try {
        uploadedUrl = await uploadTaskImage(file, taskId);
      } catch (err) {
        console.error("Upload failed:", err);
        toast("Image upload failed. Check Storage rules / internet.");
        return;
      }
    }

    // final image: prefer uploaded file, else link field
    const finalImg = uploadedUrl || linkImg;

    await addTask(
      {
        id: taskId,
        title,
        desc,
        img: finalImg,
      },
      col
    );

    // clear quick input
    const quickInput = el("task-title");
    if (quickInput) quickInput.value = "";

    closeModal();
  });

  // optional: close with ESC
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

// ---------------- Storage upload ----------------

async function uploadTaskImage(file, taskId) {
  if (!currentUser) throw new Error("No user");
  const today = getTodayKey();
  const safeName = (file.name || "image").replace(/[^\w.\-]+/g, "_");

  const path = `taskImages/${currentUser.id}/${today}/${taskId}_${safeName}`;
  const r = storageRef(storage, path);

  await uploadBytes(r, file, {
    contentType: file.type || "image/*",
  });

  return await getDownloadURL(r);
}

// ---------------- render ----------------

function render() {
  if (!isReady || !board) return;

  // avoid redundant
  const nowJson = JSON.stringify(board);
  if (nowJson === lastBoardJson) return;
  lastBoardJson = nowJson;

  for (const col of COLS) {
    const listEl = getListEl(col);
    if (!listEl) continue;

    listEl.innerHTML = "";
    const frag = document.createDocumentFragment();

    board[col].forEach((task) => {
      frag.appendChild(renderTaskCard(task));
    });

    listEl.appendChild(frag);

    const countEl = getCountEl(col);
    if (countEl) countEl.textContent = String(board[col].length);
  }
}

function renderTaskCard(task) {
  const card = document.createElement("div");
  card.className = "task-card";
  card.draggable = true;
  card.dataset.taskId = task.id;

  card.addEventListener("dragstart", onDragStart);
  card.addEventListener("dragend", onDragEnd);

  const row = document.createElement("div");
  row.className = "task-row";

  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = task.title || "Untitled";

  const actions = document.createElement("div");
  actions.className = "task-actions";

  const del = document.createElement("button");
  del.className = "task-btn";
  del.type = "button";
  del.title = "Delete";
  del.textContent = "🗑";
  del.addEventListener("click", () => deleteTask(task.id));

  actions.appendChild(del);
  row.appendChild(title);
  row.appendChild(actions);

  const meta = document.createElement("div");
  meta.className = "task-meta";
  meta.textContent = task.createdAt
    ? `Added ${new Date(task.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "—";

  card.appendChild(row);
  card.appendChild(meta);

  // description preview
  if (task.desc) {
    const d = document.createElement("div");
    d.className = "task-meta";
    d.textContent = task.desc.length > 90 ? task.desc.slice(0, 90) + "…" : task.desc;
    card.appendChild(d);
  }

  // image preview (URL from Storage or link)
  if (task.img) {
    const img = document.createElement("img");
    img.className = "task-thumb";
    img.src = task.img;
    img.alt = "Task image";
    img.loading = "lazy";
    img.onerror = () => (img.style.display = "none");
    card.appendChild(img);
  }

  return card;
}

// ---------------- Drag & Drop ----------------

let draggingTaskId = null;

function onDragStart(e) {
  const taskId = e.currentTarget?.dataset?.taskId;
  draggingTaskId = taskId || null;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", draggingTaskId);
  setTimeout(() => e.currentTarget.classList.add("dragging"), 0);
}

function onDragEnd(e) {
  e.currentTarget.classList.remove("dragging");
  draggingTaskId = null;
  document.querySelectorAll(".kanban-list.drag-over").forEach((x) => x.classList.remove("drag-over"));
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  e.currentTarget.classList.add("drag-over");
}

function onDragLeave(e) {
  e.currentTarget.classList.remove("drag-over");
}

async function onDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove("drag-over");

  const toCol = e.currentTarget?.dataset?.list;
  if (!COLS.includes(toCol)) return;

  const taskId = e.dataTransfer.getData("text/plain") || draggingTaskId;
  if (!taskId) return;

  const found = findTask(taskId);
  if (!found) return;

  const fromCol = found.col;
  if (fromCol === toCol) return;

  const [task] = board[fromCol].splice(found.idx, 1);
  board[toCol].unshift(task);

  render();
  await persist();
}

// ---------------- CRUD ----------------

async function addTask(data, col) {
  const t = String(data?.title || "").trim();
  if (!t) return;

  const c = COLS.includes(col) ? col : "todo";

  const task = {
    id: data?.id || uid(),
    title: t,
    desc: String(data?.desc || ""),
    img: String(data?.img || ""),
    createdAt: Date.now(),
  };

  board[c].unshift(task);
  lastBoardJson = ""; // force render
  render();
  await persist();
}

async function deleteTask(taskId) {
  const found = findTask(taskId);
  if (!found) return;

  board[found.col].splice(found.idx, 1);
  lastBoardJson = ""; // force render
  render();
  await persist();
}

// ---------------- persistence ----------------

async function loadBoard() {
  const userId = currentUser?.id;
  if (!userId) return safeBoard(null);

  // 1) local
  const raw = localStorage.getItem(localKey(userId));
  if (raw) {
    try {
      return safeBoard(JSON.parse(raw));
    } catch {}
  }

  // 2) Firestore
  try {
    const id = getDocIdForUserDay(userId);
    const ref = doc(collection(db, TASK_BOARDS_COL), id);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data();
      return safeBoard(data?.board);
    }
  } catch (err) {
    console.warn("Tasks Firestore load failed:", err?.message || err);
  }

  return safeBoard(null);
}

async function persist() {
  if (!currentUser) return;

  // local
  localStorage.setItem(localKey(currentUser.id), JSON.stringify(board));

  // Firestore
  try {
    const id = getDocIdForUserDay(currentUser.id);
    await setDoc(
      doc(collection(db, TASK_BOARDS_COL), id),
      {
        day: getTodayKey(),
        userId: currentUser.id,
        name: currentUser.name,
        role: currentUser.role,
        board,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    console.warn("Tasks Firestore save failed:", err?.message || err);
    toast("⚠️ Online save failed (Firestore rules). Tasks saved locally only.");
  }
}

// ---------------- Firestore live sync (between devices) ----------------

function subscribeBoardDoc() {
  unsubBoard?.();
  unsubBoard = null;

  if (!currentUser) return;

  const id = getDocIdForUserDay(currentUser.id);
  const ref = doc(collection(db, TASK_BOARDS_COL), id);

  unsubBoard = onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) return;

      const data = snap.data();
      const incoming = safeBoard(data?.board);
      const incomingJson = JSON.stringify(incoming);

      // if same ignore
      if (incomingJson === JSON.stringify(board)) return;

      board = incoming;
      lastBoardJson = "";
      render();

      // also refresh local
      localStorage.setItem(localKey(currentUser.id), JSON.stringify(board));
    },
    (err) => {
      console.warn("Tasks onSnapshot failed:", err?.message || err);
    }
  );
}

// ---------------- init / wiring ----------------

function hookDnD() {
  for (const col of COLS) {
    const listEl = getListEl(col);
    if (!listEl) continue;

    listEl.addEventListener("dragover", onDragOver);
    listEl.addEventListener("dragleave", onDragLeave);
    listEl.addEventListener("drop", onDrop);
  }
}

function hookAddForm() {
  const form = el("task-add-form");
  const input = el("task-title");
  const sel = el("task-col");

  if (!form || !input || !sel) return;

  // بدل الإضافة الفورية، افتح مودال
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!currentUser) return toast("Please login first.");

    openModal({
      title: input.value,
      col: sel.value,
    });
  });
}

async function bootstrap() {
  currentUser = getUserFromStorage();
  board = safeBoard(await loadBoard());
  isReady = true;

  hookDnD();
  hookAddForm();
  hookModal();

  lastBoardJson = "";
  render();

  subscribeBoardDoc();
}

// When user logs in/out in app.js, it fires this event
window.addEventListener("telesyriana:user-changed", async () => {
  currentUser = getUserFromStorage();
  board = safeBoard(await loadBoard());
  isReady = true;

  lastBoardJson = "";
  render();

  subscribeBoardDoc();
});

document.addEventListener("DOMContentLoaded", bootstrap);
