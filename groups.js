// // groups.js (DEMO localStorage) — visible only to creator + selected members
// // Requires messages.js listener: telesyriana:open-group

// const GROUPS_KEY = "telesyrianaGroupsDemo";
// const USER_KEY = "telesyrianaUser"; // same as messages.js

// function getCurrentUser() {
//   try {
//     const raw = localStorage.getItem(USER_KEY);
//     return raw ? JSON.parse(raw) : null;
//   } catch {
//     return null;
//   }
// }

// function loadGroups() {
//   try {
//     return JSON.parse(localStorage.getItem(GROUPS_KEY) || "[]");
//   } catch {
//     return [];
//   }
// }

// function saveGroups(groups) {
//   localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
// }

// function uid() {
//   return "grp_" + Math.random().toString(16).slice(2) + "_" + Date.now();
// }

// function normalizeId(x) {
//   return String(x ?? "").trim();
// }

// function groupVisibleToUser(group, userId) {
//   const uid = normalizeId(userId);
//   if (!uid) return false;
//   const createdBy = normalizeId(group.createdBy);
//   const members = Array.isArray(group.members) ? group.members.map(normalizeId) : [];
//   return createdBy === uid || members.includes(uid);
// }

// function openModal() {
//   document.getElementById("group-modal")?.classList.remove("hidden");
// }

// function closeModal() {
//   document.getElementById("group-modal")?.classList.add("hidden");
// }

// function renderGroups() {
//   const elGroupsList = document.getElementById("groups-list");
//   if (!elGroupsList) return;

//   const me = getCurrentUser();
//   const myId = normalizeId(me?.id);

//   // ✅ clear first (prevents duplicates)
//   elGroupsList.innerHTML = "";

//   if (!myId) {
//     elGroupsList.innerHTML = `<div class="ms-empty">Please login to see groups</div>`;
//     return;
//   }

//   const groupsAll = loadGroups();
//   const groups = groupsAll.filter((g) => groupVisibleToUser(g, myId));

//   if (!groups.length) {
//     elGroupsList.innerHTML = `<div class="ms-empty">No groups yet</div>`;
//     return;
//   }

//   const frag = document.createDocumentFragment();

//   groups.forEach((g) => {
//     const btn = document.createElement("button");
//     btn.type = "button";
//     btn.className = "chat-room chat-group";
//     btn.dataset.groupId = g.id;

//     const avatarLetter = (g.name || "G").trim().slice(0, 1).toUpperCase();
//     const membersCount = Array.isArray(g.members) ? g.members.length : 0;

//     btn.innerHTML = `
//       <div class="chat-row">
//         <div class="chat-avatar role-room">${avatarLetter}</div>
//         <div class="chat-row-text">
//           <div class="chat-room-title">${g.name || "Group"}</div>
//           <div class="chat-room-sub">${membersCount} members</div>
//         </div>
//       </div>
//     `;

//     btn.addEventListener("click", () => {
//       window.dispatchEvent(
//         new CustomEvent("telesyriana:open-group", {
//           detail: {
//             roomId: g.id,
//             title: g.name,
//             desc: g.rules ? `Rules: ${g.rules}` : "Group chat",
//             type: "group",
//           },
//         })
//       );
//     });

//     frag.appendChild(btn);
//   });

//   elGroupsList.appendChild(frag);
// }

// function createGroupFromForm() {
//   const me = getCurrentUser();
//   const myId = normalizeId(me?.id);
//   if (!myId) throw new Error("Please login first");

//   // ✅ only supervisor can create
//   if ((me?.role || "").toLowerCase() !== "supervisor") {
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

//   // ✅ Always include creator
//   if (!members.includes(myId)) members.unshift(myId);

//   const groups = loadGroups();

//   const newGroup = {
//     id: uid(),
//     name,
//     rules,
//     members,
//     createdBy: myId,
//     createdByName: me?.name || "",
//     createdAt: Date.now(),
//   };

//   groups.unshift(newGroup);
//   saveGroups(groups);
// }

// function hookCreateForm() {
//   const form = document.getElementById("group-create-form");
//   const btnCreate = document.getElementById("group-create-btn");
//   if (!form) return;

//   form.addEventListener("submit", (e) => {
//     e.preventDefault();

//     if (btnCreate) btnCreate.disabled = true;

//     try {
//       createGroupFromForm();
//       renderGroups();
//       closeModal();
//       form.reset();
//     } catch (err) {
//       alert(err?.message || "Create failed");
//     } finally {
//       if (btnCreate) btnCreate.disabled = false;
//     }
//   });
// }

// function hookOpenButton() {
//   const me = getCurrentUser();
//   const openBtn = document.getElementById("group-open-modal");
//   if (!openBtn) return;

//   // ✅ show only for supervisor
//   const isSup = (me?.role || "").toLowerCase() === "supervisor";
//   openBtn.style.display = isSup ? "" : "none";

//   openBtn.type = "button"; // important
//   openBtn.addEventListener("click", openModal);
// }

// // ✅ init
// document.addEventListener("DOMContentLoaded", () => {
//   hookOpenButton();
//   hookCreateForm();
//   renderGroups();
// });

// // Optional: reset demo
// window.resetGroupsDemo = function () {
//   localStorage.removeItem(GROUPS_KEY);
//   renderGroups();
// };

// // If login changes without refresh
// window.addEventListener("telesyriana:user-changed", () => {
//   hookOpenButton();
//   renderGroups();
// });

// document.addEventListener("DOMContentLoaded", () => {
//   const raw = localStorage.getItem("telesyrianaUser");
//   const user = raw ? JSON.parse(raw) : null;

//   const openBtn = document.getElementById("group-open-modal");
//   const modal = document.getElementById("group-modal");

//   // show only for supervisor
//   if (openBtn) openBtn.style.display = user?.role === "supervisor" ? "block" : "none";

//   openBtn?.addEventListener("click", () => modal?.classList.remove("hidden"));

//   document.getElementById("group-modal-close")?.addEventListener("click", () => {
//     modal?.classList.add("hidden");
//   });

//   document.getElementById("group-cancel")?.addEventListener("click", () => {

// groups.js — Firestore (CLOUD) create group + modal open/close
// Works with messages.js (subscribeGroupsCloud + telesyriana:open-group)

import { db, fs } from "./firebase.js";

const { doc, setDoc, serverTimestamp } = fs;

const USER_KEY = "telesyrianaUser";
const GROUPS_COL = "groups";

function getCurrentUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function isSupervisor(user) {
  return String(user?.role || "").toLowerCase() === "supervisor";
}

function uid() {
  // stable unique id for group doc
  if (globalThis.crypto?.randomUUID) return `grp_${crypto.randomUUID()}`;
  return "grp_" + Math.random().toString(16).slice(2) + "_" + Date.now();
}

function normalizeId(x) {
  return String(x ?? "").trim();
}

function openModal() {
  document.getElementById("group-modal")?.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("group-modal")?.classList.add("hidden");
}

function applySupervisorVisibility() {
  const me = getCurrentUser();
  const openBtn = document.getElementById("group-open-modal");
  if (!openBtn) return;

  // show only for supervisor
  openBtn.style.display = isSupervisor(me) ? "" : "none";
}

async function createGroupFromForm() {
  const me = getCurrentUser();
  const myId = normalizeId(me?.id);
  if (!myId) throw new Error("Please login first");

  if (!isSupervisor(me)) {
    throw new Error("Only supervisors can create groups");
  }

  const name = (document.getElementById("group-name")?.value || "").trim();
  const rules = (document.getElementById("group-rules")?.value || "").trim();

  const members = Array.from(
    document.querySelectorAll('input[name="group-members"]:checked')
  )
    .map((cb) => normalizeId(cb.value))
    .filter(Boolean);

  if (!name) throw new Error("Group name required");

  // ✅ always include creator
  if (!members.includes(myId)) members.unshift(myId);

  const groupId = uid();

  const data = {
    id: groupId,
    name,
    rules,
    members,
    createdBy: myId,
    createdByName: me?.name || "",
    createdAt: serverTimestamp(),
    type: "group",
  };

  await setDoc(doc(db, GROUPS_COL, groupId), data, { merge: true });

  // ✅ open the group immediately in messages.js
  window.dispatchEvent(
    new CustomEvent("telesyriana:open-group", {
      detail: {
        roomId: groupId,
        title: name,
        desc: rules ? `Rules: ${rules}` : "Group chat",
        type: "group",
      },
    })
  );

  return groupId;
}

function hookUI() {
  const openBtn = document.getElementById("group-open-modal");
  const form = document.getElementById("group-create-form");
  const btnCreate = document.getElementById("group-create-btn");

  // modal close buttons
  document.getElementById("group-modal-close")?.addEventListener("click", closeModal);
  document.getElementById("group-cancel")?.addEventListener("click", (e) => {
    e.preventDefault();
    closeModal();
  });

  // open modal
  if (openBtn) {
    openBtn.type = "button";
    openBtn.addEventListener("click", openModal);
  }

  // create group submit
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      if (btnCreate) btnCreate.disabled = true;

      try {
        await createGroupFromForm();
        closeModal();
        form.reset();
      } catch (err) {
        alert(err?.message || "Create failed");
      } finally {
        if (btnCreate) btnCreate.disabled = false;
      }
    });
  }

  applySupervisorVisibility();
}

// init
document.addEventListener("DOMContentLoaded", () => {
  hookUI();
});

// if login changes without refresh
window.addEventListener("telesyriana:user-changed", () => {
  applySupervisorVisibility();
});

    modal?.classList.add("hidden");
  });
});
