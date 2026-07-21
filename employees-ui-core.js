// employees-ui.js — TeleSyriana Phase 1 employee management UI
// Central HR/Manager/Admin account management. Authentication itself is owned
// by app.js through employee-directory.js; this module never intercepts login.

import {
  listEmployees,
  saveEmployee,
  setEmployeeRole,
  setEmployeeStatus,
} from "./employee-directory.js";

const USER_KEY = "telesyrianaUser";
const MANAGEMENT_ROLES = new Set(["admin", "manager", "hr"]);

let employees = [];
let editingId = "";

function currentUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }
  catch { return null; }
}

function roleOf(user) { return String(user?.role || "").toLowerCase(); }
function canManage(user = currentUser()) { return Boolean(user?.id && MANAGEMENT_ROLES.has(roleOf(user))); }
function isSelf(row, actor = currentUser()) { return String(row?.id || "") === String(actor?.id || ""); }

function allowedRoles(actor = currentUser()) {
  const role = roleOf(actor);
  if (role === "admin") return ["agent", "supervisor", "hr", "manager", "admin"];
  if (role === "manager") return ["agent", "supervisor", "hr", "manager"];
  return ["agent", "supervisor", "hr"];
}

function canManageTarget(target, actor = currentUser()) {
  if (!actor?.id || !target) return false;
  const actorRole = roleOf(actor);
  const targetRole = roleOf(target);
  if (actorRole === "admin") return true;
  if (targetRole === "admin") return false;
  if (actorRole === "manager") return true;
  return ["agent", "supervisor", "hr"].includes(targetRole);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[m]));
}

function language() {
  return (document.body?.dataset?.language || document.documentElement.lang || "en") === "ar" ? "ar" : "en";
}
function t(ar, en) { return language() === "ar" ? ar : en; }

function roleLabel(role) {
  const ar = { agent: "موظف دعم", supervisor: "مشرف", hr: "الموارد البشرية", manager: "مدير", admin: "أدمن" };
  const en = { agent: "Agent", supervisor: "Supervisor", hr: "HR", manager: "Manager", admin: "Admin" };
  return (language() === "ar" ? ar : en)[String(role || "agent")] || role || "—";
}

function statusLabel(status) {
  const ar = { active: "نشط", disabled: "معطّل", archived: "مؤرشف" };
  const en = { active: "Active", disabled: "Disabled", archived: "Archived" };
  return (language() === "ar" ? ar : en)[String(status || "active")] || status || "—";
}

function injectStyles() {
  if (document.getElementById("employees-phase1-styles")) return;
  const style = document.createElement("style");
  style.id = "employees-phase1-styles";
  style.textContent = `
    #page-employees{padding:0 0 28px}.employees-shell{display:grid;gap:16px}
    .employees-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
    .employees-head h2{margin:0 0 4px}.employees-actions,.employee-row-actions,.employee-modal-actions{display:flex;gap:8px;flex-wrap:wrap}
    .employees-toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 180px 180px;gap:10px}
    .employees-toolbar input,.employees-toolbar select,.employee-form-grid input,.employee-form-grid select{width:100%;box-sizing:border-box}
    .employee-phase-note{padding:10px 12px;border-radius:12px;background:rgba(245,158,11,.10);font-size:12px;line-height:1.55}
    .employee-table-wrap{overflow:auto;border:1px solid rgba(100,116,139,.16);border-radius:16px}
    .employee-table{width:100%;border-collapse:collapse;min-width:980px}.employee-table th,.employee-table td{padding:12px 11px;text-align:start;border-bottom:1px solid rgba(100,116,139,.13);vertical-align:middle}
    .employee-table th{font-size:12px;opacity:.72;white-space:nowrap}.employee-name strong{display:block}.employee-name small{opacity:.65}
    .employee-status{display:inline-flex;padding:5px 9px;border-radius:999px;font-size:12px;font-weight:800;background:rgba(148,163,184,.18)}
    .employee-status.active{background:rgba(34,197,94,.14);color:#15803d}.employee-status.disabled{background:rgba(245,158,11,.16);color:#a16207}.employee-status.archived{color:#475569}
    .employee-row-actions button{padding:7px 9px;border-radius:9px;border:1px solid rgba(100,116,139,.24);background:var(--card,#fff);color:inherit;cursor:pointer;font:inherit;font-size:12px}
    .employee-row-actions button.danger{color:#b91c1c;border-color:rgba(185,28,28,.24)}.employee-empty{padding:28px;text-align:center;opacity:.7}
    .employee-modal{position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,.54);display:flex;align-items:center;justify-content:center;padding:18px}.employee-modal.hidden{display:none}
    .employee-modal-card{width:min(760px,100%);max-height:92vh;overflow:auto;background:var(--card,#fff);color:inherit;border-radius:20px;padding:20px;box-shadow:0 26px 80px rgba(15,23,42,.32)}
    .employee-modal-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}.employee-modal-head h3{margin:0}.employee-modal-close{border:0;background:transparent;color:inherit;font-size:24px;cursor:pointer}
    .employee-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.employee-form-grid label{display:grid;gap:6px;font-size:13px;font-weight:700}.employee-form-grid .span-2{grid-column:1/-1}
    .employee-form-note{font-size:12px;opacity:.7;margin-top:5px}.employee-modal-actions{justify-content:flex-end;margin-top:18px}
    .employee-alert{margin-bottom:14px;padding:10px 12px;border-radius:10px;background:rgba(59,130,246,.12)}.employee-alert.error{background:rgba(239,68,68,.12);color:#b91c1c}.employee-alert.hidden{display:none}
    @media(max-width:760px){.employees-toolbar,.employee-form-grid{grid-template-columns:1fr}.employee-form-grid .span-2{grid-column:auto}}
  `;
  document.head.appendChild(style);
}

function ensurePage() {
  let section = document.getElementById("page-employees");
  if (section) return section;
  const dashboard = document.getElementById("dashboard-screen");
  if (!dashboard) return null;
  section = document.createElement("section");
  section.id = "page-employees";
  section.className = "page-section hidden";
  section.innerHTML = `
    <div class="card employees-shell">
      <div class="employees-head"><div>
        <h2>${t("الموظفون والحسابات", "Employees & Accounts")}</h2>
        <p class="subtitle">${t("إدارة الحسابات والأدوار وحالة الموظف من دليل مركزي واحد.", "Manage accounts, roles and employee status from one central directory.")}</p>
      </div><div class="employees-actions">
        <button type="button" class="btn-secondary" id="employees-refresh">${t("تحديث", "Refresh")}</button>
        <button type="button" class="btn-primary" id="employees-add">${t("إضافة موظف", "Add employee")}</button>
      </div></div>
      <div class="employee-phase-note">${t("تعطيل أو أرشفة الموظف لا يحذف تذاكره أو رسائله أو سجل دوامه ورواتبه.", "Disabling or archiving an employee keeps their tickets, messages, attendance and payroll history.")}</div>
      <div class="employees-toolbar">
        <input id="employees-search" type="search" placeholder="${t("بحث بالاسم أو CCMS…", "Search name or CCMS…")}" />
        <select id="employees-role-filter"><option value="all">${t("كل الأدوار", "All roles")}</option><option value="agent">${t("موظف دعم", "Agent")}</option><option value="supervisor">${t("مشرف", "Supervisor")}</option><option value="hr">HR</option><option value="manager">${t("مدير", "Manager")}</option><option value="admin">Admin</option></select>
        <select id="employees-status-filter"><option value="all">${t("كل الحالات", "All statuses")}</option><option value="active">${t("نشط", "Active")}</option><option value="disabled">${t("معطّل", "Disabled")}</option><option value="archived">${t("مؤرشف", "Archived")}</option></select>
      </div>
      <div class="employee-table-wrap"><table class="employee-table"><thead><tr>
        <th>${t("الموظف", "Employee")}</th><th>CCMS</th><th>${t("الدور", "Role")}</th><th>${t("المشرف", "Supervisor")}</th><th>${t("الحالة", "Status")}</th><th>${t("الأجر", "Rate")}</th><th>${t("المنطقة الزمنية", "Timezone")}</th><th>${t("إجراءات", "Actions")}</th>
      </tr></thead><tbody id="employees-table-body"></tbody></table><div id="employees-empty" class="employee-empty hidden">${t("لا يوجد موظفون مطابقون.", "No matching employees.")}</div></div>
    </div>`;
  dashboard.appendChild(section);
  return section;
}

function ensureModal() {
  let modal = document.getElementById("employee-modal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "employee-modal";
  modal.className = "employee-modal hidden";
  modal.innerHTML = `
    <div class="employee-modal-card" role="dialog" aria-modal="true">
      <div class="employee-modal-head"><h3 id="employee-modal-title"></h3><button type="button" id="employee-modal-close" class="employee-modal-close">×</button></div>
      <div id="employee-modal-alert" class="employee-alert hidden"></div>
      <form id="employee-form"><div class="employee-form-grid">
        <label>${t("الاسم الكامل", "Full name")}<input id="employee-name" required /></label>
        <label>CCMS ID<input id="employee-id" inputmode="numeric" pattern="[0-9]{4,10}" required /></label>
        <label>${t("كلمة مرور مؤقتة", "Temporary password")}<input id="employee-password" type="password" autocomplete="new-password" /></label>
        <label>${t("الدور", "Role")}<select id="employee-role"></select></label>
        <label>${t("المشرف", "Supervisor")}<select id="employee-supervisor"></select></label>
        <label>${t("حالة الحساب", "Account status")}<select id="employee-status"><option value="active">${t("نشط", "Active")}</option><option value="disabled">${t("معطّل", "Disabled")}</option><option value="archived">${t("مؤرشف", "Archived")}</option></select></label>
        <label>${t("الأجر بالساعة", "Hourly rate")}<input id="employee-rate" type="number" min="0" step="0.01" value="1.15" /></label>
        <label>${t("العملة", "Currency")}<select id="employee-currency"><option>USD</option><option>GBP</option><option>EUR</option></select></label>
        <label class="span-2">${t("المنطقة الزمنية", "Timezone")}<input id="employee-timezone" value="Asia/Damascus" placeholder="Asia/Damascus" /></label>
      </div><div class="employee-form-note">${t("عند تعديل موظف موجود، اترك كلمة المرور فارغة للاحتفاظ بها كما هي.", "When editing an existing employee, leave password blank to keep it unchanged.")}</div>
      <div class="employee-modal-actions"><button type="button" class="btn-secondary" id="employee-cancel">${t("إلغاء", "Cancel")}</button><button type="submit" class="btn-primary" id="employee-save">${t("حفظ", "Save")}</button></div></form>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

function ensureNav() {
  const nav = document.getElementById("main-nav");
  if (!nav) return null;
  let button = document.getElementById("nav-employees");
  if (button) return button;
  button = document.createElement("button");
  button.type = "button";
  button.id = "nav-employees";
  button.className = "nav-link";
  button.dataset.page = "employees";
  button.textContent = t("الموظفون", "Employees");
  nav.insertBefore(button, nav.querySelector('[data-page="settings"]') || nav.querySelector(".actions") || null);
  button.addEventListener("click", (event) => { event.preventDefault(); openPage(); });
  return button;
}

function openPage() {
  if (!canManage()) return;
  document.querySelectorAll(".page-section").forEach((node) => node.classList.add("hidden"));
  document.getElementById("page-employees")?.classList.remove("hidden");
  document.querySelectorAll(".nav-link[data-page]").forEach((node) => node.classList.toggle("active", node.dataset.page === "employees"));
  refresh();
}

function supervisorName(id) {
  if (!id) return "—";
  return employees.find((row) => String(row.id) === String(id))?.name || id;
}

function filteredRows() {
  const q = String(document.getElementById("employees-search")?.value || "").trim().toLowerCase();
  const role = document.getElementById("employees-role-filter")?.value || "all";
  const status = document.getElementById("employees-status-filter")?.value || "all";
  return employees.filter((row) => (role === "all" || row.role === role) && (status === "all" || row.accountStatus === status) && (!q || `${row.name} ${row.id} ${row.role}`.toLowerCase().includes(q)));
}

function render() {
  const body = document.getElementById("employees-table-body");
  const empty = document.getElementById("employees-empty");
  if (!body || !empty) return;
  const rows = filteredRows();
  const actor = currentUser();
  body.innerHTML = "";
  empty.classList.toggle("hidden", rows.length > 0);
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const self = isSelf(row, actor);
    const manageable = canManageTarget(row, actor);
    const status = row.accountStatus || "active";
    tr.innerHTML = `<td class="employee-name"><strong>${esc(row.name)}</strong><small>${esc(row.timezone || "")}</small></td><td>${esc(row.id)}</td><td>${esc(roleLabel(row.role))}</td><td>${esc(supervisorName(row.supervisorId))}</td><td><span class="employee-status ${esc(status)}">${esc(statusLabel(status))}</span></td><td>${esc(row.currency || "USD")} ${Number(row.hourlyRate || 0).toFixed(2)}/h</td><td>${esc(row.timezone || "—")}</td><td><div class="employee-row-actions">
      ${manageable ? `<button type="button" data-act="edit" data-id="${esc(row.id)}">${t("تعديل", "Edit")}</button>` : ""}
      ${manageable && row.role === "agent" ? `<button type="button" data-act="promote" data-id="${esc(row.id)}">${t("ترقية لمشرف", "Promote")}</button>` : ""}
      ${manageable && row.role === "supervisor" ? `<button type="button" data-act="demote" data-id="${esc(row.id)}">${t("إرجاع لموظف", "Demote")}</button>` : ""}
      ${manageable && status === "active" && !self ? `<button type="button" data-act="disable" data-id="${esc(row.id)}">${t("تعطيل", "Disable")}</button>` : ""}
      ${manageable && status === "disabled" ? `<button type="button" data-act="reactivate" data-id="${esc(row.id)}">${t("إعادة تفعيل", "Reactivate")}</button>` : ""}
      ${manageable && status !== "archived" && !self ? `<button class="danger" type="button" data-act="archive" data-id="${esc(row.id)}">${t("أرشفة", "Archive")}</button>` : ""}
    </div></td>`;
    body.appendChild(tr);
  });
}

async function refresh() {
  if (!canManage()) return;
  const button = document.getElementById("employees-refresh");
  if (button) button.disabled = true;
  try { employees = await listEmployees({ includeDisabled: true, includeArchived: true }); render(); }
  catch (err) { console.error("Employee directory refresh failed", err); }
  finally { if (button) button.disabled = false; }
}

function fillRoleOptions(selected = "agent") {
  const select = document.getElementById("employee-role");
  if (!select) return;
  const roles = allowedRoles();
  select.innerHTML = roles.map((role) => `<option value="${role}">${esc(roleLabel(role))}</option>`).join("");
  select.value = roles.includes(selected) ? selected : roles[0];
}

function fillSupervisorOptions(selected = "") {
  const select = document.getElementById("employee-supervisor");
  if (!select) return;
  const rows = employees.filter((row) => ["supervisor", "manager", "admin"].includes(row.role) && row.accountStatus === "active");
  select.innerHTML = `<option value="">${t("بدون", "None")}</option>` + rows.map((row) => `<option value="${esc(row.id)}">${esc(row.name)} (${esc(row.id)})</option>`).join("");
  select.value = String(selected || "");
}

function modalAlert(message = "", error = false) {
  const box = document.getElementById("employee-modal-alert");
  if (!box) return;
  box.textContent = message;
  box.classList.toggle("hidden", !message);
  box.classList.toggle("error", Boolean(error));
}

function openModal(row = null) {
  if (row && !canManageTarget(row)) return;
  ensureModal();
  editingId = row?.id || "";
  document.getElementById("employee-modal-title").textContent = row ? t("تعديل الموظف", "Edit employee") : t("إضافة موظف", "Add employee");
  document.getElementById("employee-name").value = row?.name || "";
  document.getElementById("employee-id").value = row?.id || "";
  document.getElementById("employee-id").disabled = Boolean(row);
  document.getElementById("employee-password").value = "";
  fillRoleOptions(row?.role || "agent");
  fillSupervisorOptions(row?.supervisorId || "");
  const self = row && isSelf(row);
  document.getElementById("employee-status").value = row?.accountStatus || "active";
  document.getElementById("employee-status").disabled = Boolean(self);
  document.getElementById("employee-rate").value = Number(row?.hourlyRate ?? 1.15);
  document.getElementById("employee-currency").value = row?.currency || "USD";
  document.getElementById("employee-timezone").value = row?.timezone || "Asia/Damascus";
  modalAlert();
  document.getElementById("employee-modal").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("employee-modal")?.classList.add("hidden");
  editingId = "";
}

async function saveForm(event) {
  event.preventDefault();
  const actor = currentUser();
  if (!canManage(actor)) return;
  const existing = editingId ? employees.find((row) => String(row.id) === String(editingId)) : null;
  if (existing && !canManageTarget(existing, actor)) return modalAlert(t("لا يمكنك تعديل هذا الحساب.", "You cannot edit this account."), true);
  const id = editingId || String(document.getElementById("employee-id")?.value || "").trim();
  const password = String(document.getElementById("employee-password")?.value || "");
  if (!existing && !password.trim()) return modalAlert(t("كلمة المرور المؤقتة مطلوبة للموظف الجديد.", "Temporary password is required for a new employee."), true);
  const requestedRole = document.getElementById("employee-role")?.value || "agent";
  if (!allowedRoles(actor).includes(requestedRole)) return modalAlert(t("لا يمكنك تعيين هذا الدور.", "You cannot assign this role."), true);
  const self = existing && isSelf(existing, actor);
  const accountStatus = self ? "active" : (document.getElementById("employee-status")?.value || "active");
  const button = document.getElementById("employee-save");
  if (button) button.disabled = true;
  try {
    await saveEmployee({ id, name: document.getElementById("employee-name")?.value, password, role: requestedRole, supervisorId: document.getElementById("employee-supervisor")?.value, accountStatus, hourlyRate: document.getElementById("employee-rate")?.value, currency: document.getElementById("employee-currency")?.value, timezone: document.getElementById("employee-timezone")?.value }, actor);
    closeModal();
    await refresh();
  } catch (err) { modalAlert(String(err?.message || err || t("فشل الحفظ.", "Save failed.")), true); }
  finally { if (button) button.disabled = false; }
}

async function action(type, id) {
  const actor = currentUser();
  const row = employees.find((item) => String(item.id) === String(id));
  if (!row || !canManageTarget(row, actor)) return;
  if (type === "edit") return openModal(row);
  try {
    if (type === "promote") {
      if (!allowedRoles(actor).includes("supervisor") || !confirm(t(`ترقية ${row.name} إلى مشرف؟`, `Promote ${row.name} to Supervisor?`))) return;
      await setEmployeeRole(id, "supervisor", actor);
    } else if (type === "demote") {
      if (!confirm(t(`إرجاع ${row.name} إلى موظف دعم؟`, `Demote ${row.name} to Agent?`))) return;
      await setEmployeeRole(id, "agent", actor);
    } else if (type === "disable" && !isSelf(row, actor)) {
      if (!confirm(t(`تعطيل حساب ${row.name}؟ ستبقى كل سجلاته محفوظة.`, `Disable ${row.name}? All historical records will remain preserved.`))) return;
      await setEmployeeStatus(id, "disabled", actor);
    } else if (type === "reactivate") await setEmployeeStatus(id, "active", actor);
    else if (type === "archive" && !isSelf(row, actor)) {
      if (!confirm(t(`أرشفة ${row.name}؟ لن يتم حذف التذاكر أو الدوام.`, `Archive ${row.name}? Tickets and attendance will not be deleted.`))) return;
      await setEmployeeStatus(id, "archived", actor);
    }
    await refresh();
  } catch (err) { alert(String(err?.message || err || t("تعذر تنفيذ العملية.", "Action failed."))); }
}

function hook() {
  injectStyles(); ensurePage(); ensureModal();
  document.getElementById("employees-refresh")?.addEventListener("click", refresh);
  document.getElementById("employees-add")?.addEventListener("click", () => openModal());
  document.getElementById("employees-search")?.addEventListener("input", render);
  document.getElementById("employees-role-filter")?.addEventListener("change", render);
  document.getElementById("employees-status-filter")?.addEventListener("change", render);
  document.getElementById("employee-modal-close")?.addEventListener("click", closeModal);
  document.getElementById("employee-cancel")?.addEventListener("click", closeModal);
  document.getElementById("employee-form")?.addEventListener("submit", saveForm);
  document.getElementById("employee-modal")?.addEventListener("click", (event) => { if (event.target?.id === "employee-modal") closeModal(); });
  document.getElementById("employees-table-body")?.addEventListener("click", (event) => { const button = event.target?.closest?.("[data-act]"); if (button) action(button.dataset.act, button.dataset.id); });
}

function syncVisibility() {
  const allowed = canManage();
  const nav = allowed ? ensureNav() : document.getElementById("nav-employees");
  nav?.classList.toggle("hidden", !allowed);
  if (!allowed) document.getElementById("page-employees")?.classList.add("hidden");
  if (allowed) refresh();
}

function boot() {
  hook();
  syncVisibility();
  window.addEventListener("telesyriana:user-changed", syncVisibility);
  window.addEventListener("telesyriana:language-changed", () => { const nav = document.getElementById("nav-employees"); if (nav) nav.textContent = t("الموظفون", "Employees"); });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
