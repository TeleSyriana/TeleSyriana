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
  // ملاحظة: ما عندك group-edit-id بالـ HTML، فعم نخزن editId على الفورم نفسه:
  const form = $("group-create-form");
  if (form) form.dataset.editId = "";

  const name = $("group-name");
  const rules = $("group-rules");
  if (name) name.value = "";
  if (rules) rules.value = "";

  // uncheck members
  document.querySelectorAll('input[name="group-members"]').forEach((cb) => (cb.checked = false));

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

  // إذا طلع لك index error، شيل orderBy وخليها بدون ترتيب.
  const q = query(
    collection(db, GROUPS_COL),
    where("members", "array-contains", myId),
    orderBy("createdAt", "desc")
  );

  unsubGroups = onSnapshot(
    q,
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
          if (norm(g.createdBy) !== norm(me2.id)) return; // only creator
          setFormToEdit({ ...g, id });
          openModal();
        });

        frag.appendChild(btn);
      });

      el.appendChild(frag);
    },
    (err) => {
      console.error("Groups snapshot error:", err);
      alert("Groups Firestore error: " + (err?.message || err));
    }
  );
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

  // OPTIONAL photo: فقط إذا ضفت input id="group-photo"
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
  hookUI();
  subscribeGroupsList();
});

window.addEventListener("telesyriana:user-changed", () => {
  applySupervisorVisibility();
  subscribeGroupsList();
});

