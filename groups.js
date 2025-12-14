// groups.js — Firestore Cloud Groups (Create + Edit + Optional Photo + Member search)
// Works with messages.js event listener: telesyriana:open-group
import { db, fs } from "./firebase.js";

const {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  updateDoc,
  doc,
} = fs;

const USER_KEY = "telesyrianaUser";
const GROUPS_COL = "groups";

const norm = (x) => String(x ?? "").trim();
const isSup = (u) => String(u?.role || "").toLowerCase() === "supervisor";

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

function $(id) {
  return document.getElementById(id);
}

function openModal() {
  $("group-modal")?.classList.remove("hidden");
}

function closeModal() {
  $("group-modal")?.classList.add("hidden");
}

async function fileToDataURL(file) {
  if (!file) return "";
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// --------- member search (works even if modal is opened later) ----------
function hookMemberSearch() {
  // delegate on document so it works even if modal DOM is created/changed later
  document.addEventListener("input", (e) => {
    if (!(e.target instanceof HTMLElement)) return;
    if (e.target.id !== "group-member-search") return;

    const input = /** @type {HTMLInputElement} */ (e.target);
    const q = input.value.toLowerCase().trim();

    const list = $("group-members-list");
    if (!list) return;

    list.querySelectorAll(".group-member-item").forEach((item) => {
      const text = (item.textContent || "").toLowerCase();
      item.style.display = text.includes(q) ? "" : "none";
    });
  });
}

// --------- state ----------
let unsubGroups = null;
let groupsCache = []; // latest visible groups

// --------- UI helpers ----------
function applySupervisorVisibility() {
  const me = getCurrentUser();
  const openBtn = $("group-open-modal");
  if (openBtn) openBtn.style.display = isSup(me) ? "" : "none";
}

function resetFormToCreate() {
  const form = $("group-create-form");
  if (form) form.dataset.editId = "";

  const name = $("group-name");
  const rules = $("group-rules");
  if (name) name.value = "";
  if (rules) rules.value = "";

  // reset member search and restore all visible items
  const search = $("group-member-search");
  if (search) search.value = "";
  const list = $("group-members-list");
  if (list) {
    list.querySelectorAll(".group-member-item").forEach((item) => (item.style.display = ""));
  }

  // uncheck members
  document
    .querySelectorAll('input[name="group-members"]')
    .forEach((cb) => (cb.checked = false));

  const btn = $("group-create-btn");
  if (btn) btn.textContent = "Create";
}

function setFormToEdit(group) {
  const form = $("group-create-form");
  if (form) form.dataset.editId = group.id || "";

  const name = $("group-name");
  const rules = $("group-rules");
  if (name) name.value = group.name || "";
  if (rules) rules.value = group.rules || "";

  // clear search and show all
  const search = $("group-member-search");
  if (search) search.value = "";
  const list = $("group-members-list");
  if (list) {
    list.querySelectorAll(".group-member-item").forEach((item) => (item.style.display = ""));
  }

  const members = Array.isArray(group.members) ? group.members.map(norm) : [];
  document.querySelectorAll('input[name="group-members"]').forEach((cb) => {
    cb.checked = members.includes(norm(cb.value));
  });

  const btn = $("group-create-btn");
  if (btn) btn.textContent = "Save";
}

// --------- Firestore subscribe list ----------
function subscribeGroupsList() {
  unsubGroups?.();
  unsubGroups = null;

  const el = $("groups-list");
  if (!el) return;

  const me = getCurrentUser();
  const myId = norm(me?.id);

  el.innerHTML = "";
  groupsCache = [];

  if (!myId) {
    el.innerHTML = `<div class="ms-empty">Please login to see groups</div>`;
    return;
  }

  const base = query(collection(db, GROUPS_COL), where("members", "array-contains", myId));

  // try ordered query first
  const ordered = query(
    collection(db, GROUPS_COL),
    where("members", "array-contains", myId),
    orderBy("createdAt", "desc")
  );

  const startSnapshot = (qRef) => {
    unsubGroups = onSnapshot(
      qRef,
      (snap) => {
        el.innerHTML = "";
        groupsCache = [];

        if (snap.empty) {
          el.innerHTML = `<div class="ms-empty">No groups yet</div>`;
          return;
        }

        const frag = document.createDocumentFragment();

        snap.forEach((d) => {
          const g = d.data() || {};
          const id = d.id;
          const group = { ...g, id };
          groupsCache.push(group);

          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "chat-room chat-group";
          btn.dataset.groupId = id;

          const avatarLetter = (g.name || "G").trim().slice(0, 1).toUpperCase();
          const membersCount = Array.isArray(g.members) ? g.members.length : 0;

          const hasPhoto = !!g.photoUrl;
          const avatarHtml = hasPhoto
            ? `<div class="chat-avatar role-room" style="padding:0; overflow:hidden;">
                 <img src="${g.photoUrl}" style="width:100%; height:100%; object-fit:cover; display:block;" />
               </div>`
            : `<div class="chat-avatar role-room">${avatarLetter}</div>`;

          btn.innerHTML = `
            <div class="chat-row">
              ${avatarHtml}
              <div class="chat-row-text">
                <div class="chat-room-title">${g.name || "Group"}</div>
                <div class="chat-room-sub">${membersCount} members</div>
              </div>
            </div>
          `;

          // open group chat
          btn.addEventListener("click", () => {
            window.dispatchEvent(
              new CustomEvent("telesyriana:open-group", {
                detail: {
                  roomId: id,
                  title: g.name || "Group",
                  desc: g.rules ? `Rules: ${g.rules}` : "Group chat",
                  type: "group",
                },
              })
            );
          });

          // edit (creator only) — dblclick
          btn.addEventListener("dblclick", () => {
            const me2 = getCurrentUser();
            if (!me2?.id) return;
            if (norm(g.createdBy) !== norm(me2.id)) return;
            setFormToEdit({ ...g, id });
            openModal();
          });

          frag.appendChild(btn);
        });

        el.appendChild(frag);
      },
      (err) => {
        // If it is an index error from orderBy, fallback to base query
        const msg = String(err?.message || err || "");
        if (msg.toLowerCase().includes("index") || msg.toLowerCase().includes("failed-precondition")) {
          console.warn("Groups ordered query requires index. Falling back to unordered query.");
          unsubGroups?.();
          startSnapshot(base);
          return;
        }

        console.error("Groups snapshot error:", err);
        alert("Groups Firestore error: " + (err?.message || err));
      }
    );
  };

  startSnapshot(ordered);
}

// --------- Create / Edit ----------
async function createOrEditFromForm() {
  const me = getCurrentUser();
  const myId = norm(me?.id);
  if (!myId) throw new Error("Please login first");

  const form = $("group-create-form");
  const editId = norm(form?.dataset?.editId);

  // create: supervisor only
  if (!editId && !isSup(me)) throw new Error("Only supervisors can create groups");

  const name = ($("group-name")?.value || "").trim();
  const rules = ($("group-rules")?.value || "").trim();
  if (!name) throw new Error("Group name required");

  const members = Array.from(document.querySelectorAll('input[name="group-members"]:checked'))
    .map((cb) => norm(cb.value))
    .filter(Boolean);

  // creator always included
  if (!members.includes(myId)) members.unshift(myId);

  // OPTIONAL photo: only if you add <input id="group-photo">
  let photoUrl = "";
  const photoInput = $("group-photo");
  const file = photoInput?.files?.[0] || null;
  if (file) photoUrl = await fileToDataURL(file);

  if (!editId) {
    await addDoc(collection(db, GROUPS_COL), {
      name,
      rules,
      members,
      createdBy: myId,
      createdByName: me?.name || "",
      photoUrl: photoUrl || "",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return;
  }

  // edit: creator only
  const existing = groupsCache.find((g) => norm(g.id) === editId);
  if (!existing) throw new Error("Group not found (refresh and try again)");
  if (norm(existing.createdBy) !== myId) throw new Error("Only the creator can edit this group");

  const patch = {
    name,
    rules,
    members,
    updatedAt: serverTimestamp(),
  };
  if (photoUrl) patch.photoUrl = photoUrl;

  await updateDoc(doc(db, GROUPS_COL, editId), patch);
}

// --------- Hook UI ----------
function hookUI() {
  const openBtn = $("group-open-modal");
  const closeBtn = $("group-modal-close");
  const cancelBtn = $("group-cancel");
  const form = $("group-create-form");
  const btnSave = $("group-create-btn");

  // open
  openBtn?.addEventListener("click", () => {
    resetFormToCreate();
    openModal();
  });

  // close/cancel
  closeBtn?.addEventListener("click", closeModal);
  cancelBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    closeModal();
  });

  // submit
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (btnSave) btnSave.disabled = true;

    try {
      await createOrEditFromForm();
      closeModal();
      form.reset();
      resetFormToCreate();
    } catch (err) {
      alert(err?.message || "Save failed");
    } finally {
      if (btnSave) btnSave.disabled = false;
    }
  });

  applySupervisorVisibility();
}

document.addEventListener("DOMContentLoaded", () => {
  hookMemberSearch();
  hookUI();
  subscribeGroupsList();
});

window.addEventListener("telesyriana:user-changed", () => {
  applySupervisorVisibility();
  subscribeGroupsList();
});
