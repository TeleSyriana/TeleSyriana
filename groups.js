// import { db, fs } from "./firebase.js";

// const { doc, setDoc, serverTimestamp } = fs;

// const USER_KEY = "telesyrianaUser";
// const GROUPS_COL = "groups";

// function getCurrentUser() {
//   try {
//     const raw = localStorage.getItem(USER_KEY);
//     return raw ? JSON.parse(raw) : null;
//   } catch {
//     return null;
//   }
// }

// function isSupervisor(user) {
//   return String(user?.role || "").toLowerCase() === "supervisor";
// }

// function uid() {
//   // stable unique id for group doc
//   if (globalThis.crypto?.randomUUID) return `grp_${crypto.randomUUID()}`;
//   return "grp_" + Math.random().toString(16).slice(2) + "_" + Date.now();
// }

// function normalizeId(x) {
//   return String(x ?? "").trim();
// }

// function openModal() {
//   document.getElementById("group-modal")?.classList.remove("hidden");
// }

// function closeModal() {
//   document.getElementById("group-modal")?.classList.add("hidden");
// }

// function applySupervisorVisibility() {
//   const me = getCurrentUser();
//   const openBtn = document.getElementById("group-open-modal");
//   if (!openBtn) return;

//   // show only for supervisor
//   openBtn.style.display = isSupervisor(me) ? "" : "none";
// }

// async function createGroupFromForm() {
//   const me = getCurrentUser();
//   const myId = normalizeId(me?.id);
//   if (!myId) throw new Error("Please login first");

//   if (!isSupervisor(me)) {
//     throw new Error("Only supervisors can create groups");
//   }

//   const name = (document.getElementById("group-name")?.value || "").trim();
//   const rules = (document.getElementById("group-rules")?.value || "").trim();

//   const members = Array.from(
//     document.querySelectorAll('input[name="group-members"]:checked')
//   )
//     .map((cb) => normalizeId(cb.value))
//     .filter(Boolean);

//   if (!name) throw new Error("Group name required");

//   // ✅ always include creator
//   if (!members.includes(myId)) members.unshift(myId);

//   const groupId = uid();

//   const data = {
//     id: groupId,
//     name,
//     rules,
//     members,
//     createdBy: myId,
//     createdByName: me?.name || "",
//     createdAt: serverTimestamp(),
//     type: "group",
//   };

//   await setDoc(doc(db, GROUPS_COL, groupId), data, { merge: true });

//   // ✅ open the group immediately in messages.js
//   window.dispatchEvent(
//     new CustomEvent("telesyriana:open-group", {
//       detail: {
//         roomId: groupId,
//         title: name,
//         desc: rules ? `Rules: ${rules}` : "Group chat",
//         type: "group",
//       },
//     })
//   );

//   return groupId;
// }

// function hookUI() {
//   const openBtn = document.getElementById("group-open-modal");
//   const form = document.getElementById("group-create-form");
//   const btnCreate = document.getElementById("group-create-btn");

//   // modal close buttons
//   document.getElementById("group-modal-close")?.addEventListener("click", closeModal);
//   document.getElementById("group-cancel")?.addEventListener("click", (e) => {
//     e.preventDefault();
//     closeModal();
//   });

//   // open modal
//   if (openBtn) {
//     openBtn.type = "button";
//     openBtn.addEventListener("click", openModal);
//   }

//   // create group submit
//   if (form) {
//     form.addEventListener("submit", async (e) => {
//       e.preventDefault();

//       if (btnCreate) btnCreate.disabled = true;

//       try {
//         await createGroupFromForm();
//         closeModal();
//         form.reset();
//       } catch (err) {
//         alert(err?.message || "Create failed");
//       } finally {
//         if (btnCreate) btnCreate.disabled = false;
//       }
//     });
//   }

//   applySupervisorVisibility();
// }

// // init
// document.addEventListener("DOMContentLoaded", () => {
//   hookUI();
// });

// // if login changes without refresh
// window.addEventListener("telesyriana:user-changed", () => {
//   applySupervisorVisibility();
// });

//     modal?.classList.add("hidden");
//   });
// });
// groups.js — Firestore Cloud Groups (Create + Edit + Photo + Members visibility)
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
  doc
} = fs;

const USER_KEY = "telesyrianaUser";
const GROUPS_COL = "groups";

// -------- helpers --------
function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}
const norm = (x) => String(x ?? "").trim();
const isSupervisor = (u) => (u?.role || "").toLowerCase() === "supervisor";

async function fileToDataURL(file) {
  if (!file) return "";
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// -------- modal controls --------
function openModal() {
  document.getElementById("group-modal")?.classList.remove("hidden");
}
function closeModal() {
  document.getElementById("group-modal")?.classList.add("hidden");
}

function setCreateMode() {
  const editId = document.getElementById("group-edit-id");
  const btn = document.getElementById("group-create-btn");
  if (editId) editId.value = "";
  if (btn) btn.textContent = "Create";

  // clear fields
  const name = document.getElementById("group-name");
  const rules = document.getElementById("group-rules");
  const photo = document.getElementById("group-photo");
  if (name) name.value = "";
  if (rules) rules.value = "";
  if (photo) photo.value = "";

  // uncheck members
  document.querySelectorAll('input[name="group-members"]').forEach((cb) => {
    cb.checked = false;
  });
}

function setEditMode(group) {
  const editId = document.getElementById("group-edit-id");
  const btn = document.getElementById("group-create-btn");
  if (editId) editId.value = group.id || "";
  if (btn) btn.textContent = "Save";

  const name = document.getElementById("group-name");
  const rules = document.getElementById("group-rules");
  const photo = document.getElementById("group-photo");
  if (name) name.value = group.name || "";
  if (rules) rules.value = group.rules || "";
  if (photo) photo.value = ""; // ما فينا نعبّي file input برمجياً

  const members = Array.isArray(group.members) ? group.members.map(norm) : [];
  document.querySelectorAll('input[name="group-members"]').forEach((cb) => {
    cb.checked = members.includes(norm(cb.value));
  });
}

// -------- UI visibility --------
function applySupervisorVisibility() {
  const me = getCurrentUser();
  const openBtn = document.getElementById("group-open-modal");
  if (!openBtn) return;
  openBtn.style.display = isSupervisor(me) ? "" : "none";
}

// -------- subscribe groups list --------
let unsubGroups = null;
let groupsCache = []; // used for edit permission & quick lookup

function subscribeGroupsList() {
  unsubGroups?.();
  unsubGroups = null;

  const listEl = document.getElementById("groups-list");
  if (!listEl) return;

  const me = getCurrentUser();
  const myId = norm(me?.id);

  listEl.innerHTML = "";
  groupsCache = [];

  if (!myId) {
    listEl.innerHTML = `<div class="ms-empty">Please login to see groups</div>`;
    return;
  }

  // ✅ Cloud visibility: only groups where members contains myId
  // NOTE: orderBy may require index; if it errors, remove orderBy line.
  const q = query(
    collection(db, GROUPS_COL),
    where("members", "array-contains", myId),
    orderBy("createdAt", "desc")
  );

  unsubGroups = onSnapshot(
    q,
    (snap) => {
      listEl.innerHTML = "";
      groupsCache = [];

      if (snap.empty) {
        listEl.innerHTML = `<div class="ms-empty">No groups yet</div>`;
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

        const membersCount = Array.isArray(g.members) ? g.members.length : 0;
        const avatarLetter = (g.name || "G").trim().slice(0, 1).toUpperCase();
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

        // ✅ open group chat
        btn.addEventListener("click", () => {
          window.dispatchEvent(
            new CustomEvent("telesyriana:open-group", {
              detail: {
                roomId: id,
                title: g.name || "Group",
                desc: g.rules ? `Rules: ${g.rules}` : "Group chat",
                type: "group"
              }
            })
          );
        });

        // ✅ creator edit button (⋯) — works on mobile
        const isCreator = norm(g.createdBy) === myId;
        if (isCreator) {
          const kebab = document.createElement("button");
          kebab.type = "button";
          kebab.className = "kebab";
          kebab.textContent = "⋯";
          kebab.style.marginLeft = "auto";

          kebab.addEventListener("click", (ev) => {
            ev.stopPropagation();
            setEditMode({ ...g, id });
            openModal();
          });

          btn.querySelector(".chat-row")?.appendChild(kebab);
        }

        frag.appendChild(btn);
      });

      listEl.appendChild(frag);
    },
    (err) => {
      console.error("Groups snapshot error:", err);

      // إذا طلع index error، احذف orderBy من query فوق.
      alert("Groups Firestore error: " + (err?.message || "Unknown"));
    }
  );
}

// -------- create / edit --------
async function createOrEditFromForm() {
  const me = getCurrentUser();
  const myId = norm(me?.id);
  if (!myId) throw new Error("Please login first");

  const editId = norm(document.getElementById("group-edit-id")?.value);

  // Create: supervisor only
  if (!editId && !isSupervisor(me)) throw new Error("Only supervisors can create groups");

  const name = (document.getElementById("group-name")?.value || "").trim();
  const rules = (document.getElementById("group-rules")?.value || "").trim();
  if (!name) throw new Error("Group name required");

  const members = Array.from(document.querySelectorAll('input[name="group-members"]:checked'))
    .map((cb) => norm(cb.value))
    .filter(Boolean);

  // creator always included
  if (!members.includes(myId)) members.unshift(myId);

  // optional photo
  const file = document.getElementById("group-photo")?.files?.[0] || null;
  const photoUrl = file ? await fileToDataURL(file) : "";

  if (!editId) {
    // ✅ CREATE
    const ref = await addDoc(collection(db, GROUPS_COL), {
      name,
      rules,
      members,
      createdBy: myId,
      createdByName: me?.name || "",
      photoUrl: photoUrl || "",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    // ✅ open group immediately
    window.dispatchEvent(
      new CustomEvent("telesyriana:open-group", {
        detail: {
          roomId: ref.id,
          title: name,
          desc: rules ? `Rules: ${rules}` : "Group chat",
          type: "group"
        }
      })
    );

    return;
  }

  // ✅ EDIT — only creator
  const existing = groupsCache.find((g) => norm(g.id) === editId);
  if (!existing) throw new Error("Group not found (refresh and try again)");
  if (norm(existing.createdBy) !== myId) throw new Error("Only the creator can edit this group");

  const patch = {
    name,
    rules,
    members,
    updatedAt: serverTimestamp()
  };
  if (photoUrl) patch.photoUrl = photoUrl; // only if new selected

  await updateDoc(doc(db, GROUPS_COL, editId), patch);

  // optional: open after save
  window.dispatchEvent(
    new CustomEvent("telesyriana:open-group", {
      detail: {
        roomId: editId,
        title: name,
        desc: rules ? `Rules: ${rules}` : "Group chat",
        type: "group"
      }
    })
  );
}

// -------- hook UI --------
function hookUI() {
  const openBtn = document.getElementById("group-open-modal");
  const form = document.getElementById("group-create-form");
  const btnSave = document.getElementById("group-create-btn");
  const closeBtn = document.getElementById("group-modal-close");
  const cancelBtn = document.getElementById("group-cancel");

  // IMPORTANT: avoid duplicate listeners by replacing handlers safely
  openBtn?.addEventListener("click", () => {
    setCreateMode();
    openModal();
  });

  closeBtn?.addEventListener("click", closeModal);
  cancelBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    closeModal();
  });

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (btnSave) btnSave.disabled = true;

      try {
        await createOrEditFromForm();
        closeModal();
        form.reset();
        setCreateMode();
      } catch (err) {
        alert(err?.message || "Save failed");
      } finally {
        if (btnSave) btnSave.disabled = false;
      }
    });
  }

  applySupervisorVisibility();
}

// -------- init --------
document.addEventListener("DOMContentLoaded", () => {
  hookUI();
  subscribeGroupsList();
});

// when login changes
window.addEventListener("telesyriana:user-changed", () => {
  applySupervisorVisibility();
  subscribeGroupsList();
});
