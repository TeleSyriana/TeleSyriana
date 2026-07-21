// groups.js — TeleSyriana Phase 1 employee-directory migration loader
// Preserves the existing cloud-group engine in groups-core.js and makes the
// group member picker come from the central employee directory.

const CORE_URL = new URL('./groups-core.js', import.meta.url);
const FIREBASE_URL = new URL('./firebase.js', import.meta.url).href;
const DIRECTORY_URL = new URL('./employee-directory.js', import.meta.url).href;

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`Groups directory marker missing: ${label}`);
  return source.replace(oldText, newText);
}

function patchGroups(coreSource) {
  let source = String(coreSource || '');
  const imports = `import { db, fs } from ${JSON.stringify(FIREBASE_URL)};\nimport { listEmployees } from ${JSON.stringify(DIRECTORY_URL)};`;
  source = replaceRequired(source, 'import { db, fs } from "./firebase.js";', imports, 'firebase import');

  const memberDirectory = `async function refreshGroupMemberDirectory() {\n  const list = $("group-members-list");\n  if (!list) return;\n\n  const selected = new Set(\n    Array.from(list.querySelectorAll('input[name="group-members"]:checked')).map((cb) => norm(cb.value))\n  );\n  const rows = await listEmployees({ includeDisabled: true, includeArchived: true });\n  list.innerHTML = "";\n\n  rows.forEach((row) => {\n    const id = norm(row.id);\n    if (!id) return;\n    const active = String(row.accountStatus || "active") === "active";\n    const label = document.createElement("label");\n    label.className = "group-member-item";\n\n    const checkbox = document.createElement("input");\n    checkbox.type = "checkbox";\n    checkbox.name = "group-members";\n    checkbox.value = id;\n    checkbox.checked = selected.has(id);\n    checkbox.disabled = !active;\n\n    const suffix = active ? "" : \` — \${String(row.accountStatus || "inactive")}\`;\n    label.appendChild(checkbox);\n    label.appendChild(document.createTextNode(\` \${row.name || id} (CCMS \${id})\${suffix}\`));\n    list.appendChild(label);\n  });\n}\n\nwindow.addEventListener("telesyriana:employee-directory-changed", () => {\n  refreshGroupMemberDirectory().catch((err) => console.warn("Group member directory refresh failed", err));\n});\n\n`;
  source = replaceRequired(
    source,
    '// --------- member search (works even if modal is opened later) ----------\n',
    memberDirectory + '// --------- member search (works even if modal is opened later) ----------\n',
    'group member directory helper'
  );

  source = replaceRequired(
    source,
    'document.addEventListener("DOMContentLoaded", () => {\n  hookMemberSearch();',
    'document.addEventListener("DOMContentLoaded", async () => {\n  await refreshGroupMemberDirectory();\n  hookMemberSearch();',
    'initial group member directory load'
  );

  if (!source.includes('await refreshGroupMemberDirectory()')) throw new Error('Groups directory validation failed: initial member refresh missing.');
  if (!source.includes('checkbox.disabled = !active;')) throw new Error('Groups directory validation failed: inactive-member protection missing.');
  return source;
}

async function loadGroups() {
  try {
    const response = await fetch(CORE_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load groups core (HTTP ${response.status}).`);
    const patchedSource = patchGroups(await response.text());
    const blobUrl = URL.createObjectURL(new Blob([patchedSource], { type: 'text/javascript' }));
    try { await import(blobUrl); }
    finally { URL.revokeObjectURL(blobUrl); }
  } catch (err) {
    console.error('Central group member-directory bridge failed. Falling back to untouched groups core.', err);
    await import(CORE_URL.href);
  }
}

await loadGroups();
