// messages.js — TeleSyriana Phase 1 employee-directory migration loader
// Preserves the current chat engine in messages-core.js and makes Direct
// Messages/role avatars come from the central employee directory.

const CORE_URL = new URL('./messages-core.js', import.meta.url);
const FIREBASE_URL = new URL('./firebase.js', import.meta.url).href;
const DIRECTORY_URL = new URL('./employee-directory.js', import.meta.url).href;

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`Messages directory marker missing: ${label}`);
  return source.replace(oldText, newText);
}

function replaceBetweenRequired(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Messages directory start marker missing: ${label}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Messages directory end marker missing: ${label}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function patchMessages(coreSource) {
  let source = String(coreSource || '');
  const imports = `import { db, fs } from ${JSON.stringify(FIREBASE_URL)};\nimport { listEmployees } from ${JSON.stringify(DIRECTORY_URL)};`;
  source = replaceRequired(source, 'import { db, fs } from "./firebase.js";', imports, 'firebase import');

  const dynamicRoleClass = `const employeeDirectoryCache = new Map();\n\nfunction roleClassForUser(userId = "") {\n  const role = String(employeeDirectoryCache.get(String(userId || ""))?.role || "").toLowerCase();\n  if (role === "admin") return "role-admin";\n  if (role === "manager") return "role-manager";\n  if (role === "supervisor") return "role-supervisor";\n  if (role === "hr") return "role-hr";\n  if (role === "agent") return "role-agent";\n  return "role-room";\n}\n\n`;
  source = replaceBetweenRequired(
    source,
    'function roleClassForUser(userId = "") {',
    'function getProfilePhoto(userId) {',
    dynamicRoleClass,
    'hard-coded chat role classes'
  );

  const oldDmDisplayName = `function getDmDisplayName(userId) {\n  const profileName = profileCache.get(String(userId))?.name;\n  const nameEl = document.querySelector(\`[data-name="\${CSS.escape(String(userId))}"]\`);\n  return String(profileName || nameEl?.dataset?.baseName || nameEl?.textContent || \`CCMS \${userId}\`).replace("🎂", "").trim();\n}`;
  const newDmDisplayName = `function getDmDisplayName(userId) {\n  const id = String(userId || "");\n  const directoryName = employeeDirectoryCache.get(id)?.name;\n  const profileName = profileCache.get(id)?.name;\n  const nameEl = document.querySelector(\`[data-name="\${CSS.escape(id)}"]\`);\n  return String(directoryName || profileName || nameEl?.dataset?.baseName || nameEl?.textContent || \`CCMS \${id}\`).replace("🎂", "").trim();\n}`;
  source = replaceRequired(source, oldDmDisplayName, newDmDisplayName, 'central DM display name');

  const directoryHelpers = `async function refreshMessageEmployeeDirectory() {\n  const rows = await listEmployees({ includeDisabled: false, includeArchived: false });\n  employeeDirectoryCache.clear();\n  rows.forEach((row) => employeeDirectoryCache.set(String(row.id), row));\n\n  if (!dmListEl) dmListEl = document.getElementById("dm-list");\n  if (!dmListEl) return;\n\n  dmListEl.innerHTML = rows.map((row) => {\n    const id = String(row.id || "");\n    const name = String(row.name || id || "User");\n    const initials = getInitials(name);\n    const cls = roleClassForUser(id);\n    return \`<button class="chat-dm" type="button" data-dm="\${id}">\n      <div class="chat-row">\n        <div class="dm-avatar-wrap">\n          <div class="chat-avatar \${cls}" data-avatar="\${id}" data-initial="\${initials}">\${initials}</div>\n          <span class="status-dot dot-offline" data-status-dot="\${id}"></span>\n        </div>\n        <div class="chat-row-text">\n          <div class="chat-room-title" data-name="\${id}">\${name}</div>\n          <div class="chat-room-sub" data-sub="\${id}">\${msgT("directChat")}</div>\n        </div>\n      </div>\n    </button>\`;\n  }).join("");\n}\n\nfunction bindDirectoryDmButtons() {\n  document.querySelectorAll(".chat-dm[data-dm]").forEach((btn) => {\n    setCurrentUser();\n    const otherId = btn.dataset.dm;\n    if (otherId && currentUser?.id) {\n      const rid = dmRoomId(currentUser.id, otherId);\n      registerRoomButton(String(rid), btn);\n    }\n\n    btn.addEventListener("click", () => {\n      setCurrentUser();\n      if (!currentUser) return;\n      const otherId = btn.dataset.dm;\n      const roomId = dmRoomId(currentUser.id, otherId);\n      const nameEl = btn.querySelector(".chat-room-title");\n      const otherName = getDmDisplayName(otherId) || (nameEl?.textContent || \`CCMS \${otherId}\`).replace("🎂", "").trim();\n      openChat({ type: "dm", roomId, title: otherName, desc: \`\${msgT("directChat")} • CCMS \${otherId}\` }, btn);\n    });\n  });\n}\n\nasync function refreshMessagesForEmployeeDirectory() {\n  await refreshMessageEmployeeDirectory();\n  bindDirectoryDmButtons();\n  applyBirthdayBadges();\n  applyProfileAvatars();\n  applySearchFilter();\n}\n\nwindow.addEventListener("telesyriana:employee-directory-changed", refreshMessagesForEmployeeDirectory);\n\n`;
  source = replaceRequired(source, '// ---------------- init ----------------\n', directoryHelpers + '// ---------------- init ----------------\n', 'chat directory helpers');

  source = replaceRequired(
    source,
    'document.addEventListener("DOMContentLoaded", () => {',
    'document.addEventListener("DOMContentLoaded", async () => {',
    'async chat init'
  );
  source = replaceRequired(
    source,
    '  setCurrentUser();\n  subscribePresenceSidebar();',
    '  setCurrentUser();\n  await refreshMessageEmployeeDirectory();\n  subscribePresenceSidebar();',
    'initial chat employee directory load'
  );

  source = replaceBetweenRequired(
    source,
    '  document.querySelectorAll(".chat-dm[data-dm]").forEach((btn) => {',
    '  const formEl = document.getElementById("chat-form");',
    '  bindDirectoryDmButtons();\n\n',
    'static DM binding block'
  );

  if (source.includes('if (id === "0001") return "role-admin";')) throw new Error('Messages directory validation failed: hard-coded roles remain.');
  if (!source.includes('const directoryName = employeeDirectoryCache.get(id)?.name;')) throw new Error('Messages directory validation failed: directory names are not authoritative.');
  if (!source.includes('await refreshMessageEmployeeDirectory()')) throw new Error('Messages directory validation failed: directory refresh missing.');
  return source;
}

async function loadMessages() {
  try {
    const response = await fetch(CORE_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load messages core (HTTP ${response.status}).`);
    const patchedSource = patchMessages(await response.text());
    const blobUrl = URL.createObjectURL(new Blob([patchedSource], { type: 'text/javascript' }));
    try { await import(blobUrl); }
    finally { URL.revokeObjectURL(blobUrl); }
  } catch (err) {
    console.error('Central chat employee-directory bridge failed. Falling back to untouched messages core.', err);
    await import(CORE_URL.href);
  }
}

await loadMessages();
