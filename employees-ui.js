// employees-ui.js — TeleSyriana Phase 1 employee management UI
// Loaded defensively from firebase.js so it can be introduced without rewriting
// the large production index/app modules during the directory migration.

import {
  LEGACY_EMPLOYEE_SEED,
  getEmployee,
  listEmployees,
  saveEmployee,
  setEmployeeRole,
  setEmployeeStatus,
} from "./employee-directory.js";

const USER_KEY = "telesyrianaUser";
const MANAGER_ROLES = new Set(["admin", "manager", "hr"]);

let employees = [];
let currentEditId = "";
let loginGuardBypass = false;

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

function roleOf(user) {
  return String(user?.role || "").toLowerCase();
}

function canManageEmployees(user = getCurrentUser()) {
  return Boolean(user?.id && MANAGER_ROLES.has(roleOf(user)));
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[m]));
}

function lang() {
  return (document.body?.dataset?.language || document.documentElement.lang || "en") === "ar" ? "ar" : "en";
}

function t(ar, en) {
  return lang() === "ar" ? ar : en;
}

function statusLabel(status) {
  const map = {
    active: t("نشط", "Active"),
    disabled: t("معطّل", "Disabled"),
    archived: t("مؤرشف", "Archived"),
  };
  return map[String(status || "active")] || status || "—";
}

function roleLabel(role) {
  const ar = { agent: "موظف دعم", supervisor: "مشرف", hr: "الموارد البشرية", manager: "مدير", admin: "أدمن" };
  const en = { agent: "Agent", supervisor: "Supervisor", hr: "HR", manager: "Manager", admin: "Admin" };
  return (lang() === "ar" ? ar : en)[String(role || "agent")] || role || "—";
}

function injectStyles() {
  if (document.getElementById("employees-phase1-styles")) return;
  const style = document.createElement("style");
  style.id = "employees-phase1-styles";
  style.textContent = `
    #page-employees{padding:0 0 28px}
    .employees-shell{display:grid;gap:16px}
    .employees-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap}
    .employees-head h2{margin:0 0 4px}
    .employees-actions{display:flex;gap:8px;flex-wrap:wrap}
    .employees-toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 180px 180px;gap:10px}
    .employees-toolbar input,.employees-toolbar select,.employee-form-grid input,.employee-form-grid select{width:100%;box-sizing:border-box}
    .employee-table-wrap{overflow:auto;border:1px solid rgba(100,116,139,.16);border-radius:16px}
    .employee-table{width:100%;border-collapse:collapse;min-width:980px}
    .employee-table th,.employee-table td{padding:12px 11px;text-align:start;border-bottom:1px solid rgba(100,116,139,.13);vertical-align:middle}
    .employee-table th{font-size:12px;opacity:.75;white-space:nowrap}
    .employee-name strong{display:block}.employee-name small{opacity:.68}
    .employee-status{display:inline-flex;padding:5px 9px;border-radius:999px;font-size:12px;font-weight:800;background:rgba(148,163,184,.18)}
    .employee-status.active{background:rgba(34,197,94,.14);color:#15803d}
    .employee-status.disabled{background:rgba(245,158,11,.16);color:#a16207}
    .employee-status.archived{background:rgba(100,116,139,.17);color:#475569}
    .employee-row-actions{display:flex;gap:6px;flex-wrap:wrap}
    .employee-row-actions button{padding:7px 9px;border-radius:9px;border:1px solid rgba(100,116,139,.24);background:var(--card,#fff);cursor:pointer;font:inherit;font-size:12px}
    .employee-row-actions button.danger{color:#b91c1c;border-color:rgba(185,28,28,.24)}
    .employee-empty{padding:28px;text-align:center;opacity:.7}
    .employee-modal{position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,.54);display:flex;align-items:center;justify-content:center;padding:18px}
    .employee-modal.hidden{display:none}
    .employee-modal-card{width:min(760px,100%);max-height:92vh;overflow:auto;background:var(--card,#fff);color:inherit;border-radius:20px;padding:20px;box-shadow:0 26px 80px rgba(15,23,42,.32)}
    .employee-modal-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:16px}
    .employee-modal-head h3{margin:0}
    .employee-modal-close{border:0;background:transparent;font-size:24px;cursor:pointer;color:inherit}
    .employee-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .employee-form-grid label{display:grid;gap:6px;font-size:13px;font-weight:700}
    .employee-form-grid .span-2{grid-column:1/-1}
    .employee-form-note{font-size:12px;opacity:.7;margin-top:4px}
    .employee-modal-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:18px}
    .employee-alert{margin:0 0 14px;padding:10px 12px;border-radius:10px;background:rgba(59,130,246,.12)}
    .employee-alert.error{background:rgba(239,68,68,.12);color:#b91c1c}
    .employee-alert.hidden{display:none}
    .employee-phase-note{padding:10px 12px;border-radius:12px;background:rgba(245,158,11,.10);font-size:12px;line-height:1.55}
    @media(max-width:760px){.employees-toolbar,.employee-form-grid{grid-template-columns:1fr}.employee-form-grid .span-2{grid-column:auto}}
  `;
  document.head.appendChild(style);
}

function ensureEmployeeSection() {
  let section = document.getElementById("page-employees");
  if (section) return section;
  const dashboard = document.getElementById("dashboard-screen");
  if (!dashboard) return null;

  section = document.createElement("section");
  section.id = "page-employees";
  section.className = "page-section hidden";
  section.innerHTML = `
    <div class="card employees-shell">
      <div class="employees-head">
        <div>
          <h2 id="employees-title">${t("الموظفون والحسابات", "Employees & Accounts")}</h2>
          <p class="subtitle" id="employees-subtitle">${t("إدارة الحسابات والأدوار وحالة الموظف من دليل مركزي واحد.", "Manage accounts, roles and employee status from one central directory.")}</p>
        </div>
        <div class="employees-actions">
          <button type="button" class="btn-secondary" id="employees-refresh">${t("تحديث", "Refresh")}</button>
          <button type="button" class="btn-primary" id="employees-add">${t("إضافة موظف", "Add employee")}</button>
        </div>
      </div>
      <div class="employee-phase-note">${t("المرحلة 1: الحسابات الحالية تبقى متوافقة أثناء نقل النظام إلى الدليل المركزي. لا يتم حذف أي سجل تذاكر أو دوام عند تعطيل أو أرشفة الموظف.", "Phase 1: current accounts remain compatible while TeleSyriana moves to the central directory. Disabling or archiving an employee does not delete ticket or attendance history.")}</div>
      <div class="employees-toolbar">
        <input id="employees-search" type="search" placeholder="${t("بحث بالاسم أو CCMS…", "Search name or CCMS…")}" />
        <select id="employees-role-filter">
          <option value="all">${t("كل الأدوار", "All roles")}</option>
          <option value="agent">${t("موظف دعم", "Agent")}</option>
          <option value="supervisor">${t("مشرف", "Supervisor")}</option>
          <option value="hr">HR</option>
          <option value="manager">${t("مدير", "Manager")}</option>
          <option value="admin">Admin</option>
        </select>
        <select id="employees-status-filter">
          <option value="all">${t("كل الحالات", "All statuses")}</option>
          <option value="active">${t("نشط", "Active")}</option>
          <option value="disabled">${t("معطّل", "Disabled")}</option>
          <option value="archived">${t("مؤرشف", "Archived")}</option>
        </select>
      </div>
      <div class="employee-table-wrap">
        <table class="employee-table">
          <thead><tr>
            <th>${t("الموظف", "Employee")}</th>
            <th>CCMS</th>
            <th>${t("الدور", "Role")}</th>
            <th>${t("المشرف", "Supervisor")}</th>
            <th>${t("الحالة", "Status")}</th>
            <th>${t("الأجر", "Rate")}</th>
            <th>${t("المنطقة الزمنية", "Timezone")}</th>
            <th>${t("إجراءات", "Actions")}</th>
          </tr></thead>
          <tbody id="employees-table-body"></tbody>
        </table>
        <div id="employees-empty" class="employee-empty hidden">${t("لا يوجد موظفون مطابقون.", "No matching employees.")}</div>
      </div>
    </div>`;
  dashboard.appendChild(section);
  return section;
}

function ensureEmployeeModal() {
  let modal = document.getElementById("employee-modal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "employee-modal";
  modal.className = "employee-modal hidden";
  modal.innerHTML = `
    <div class="employee-modal-card" role="dialog" aria-modal="true" aria-labelledby="employee-modal-title">
      <div class="employee-modal-head">
        <h3 id="employee-modal-title">${t("إضافة موظف", "Add employee")}</h3>
        <button type="button" id="employee-modal-close" class="employee-modal-close" aria-label="Close">×</button>
      </div>
      <div id="employee-modal-alert" class="employee-alert hidden"></div>
      <form id="employee-form">
        <div class="employee-form-grid">
          <label>${t("الاسم الكامل", "Full name")}<input id="employee-name" required /></label>
          <label>CCMS ID<input id="employee-id" inputmode="numeric" pattern="[0-9]{4,10}" required /></label>
          <label>${t("كلمة مرور مؤقتة", "Temporary password")}<input id="employee-password" type="password" autocomplete="new-password" /></label>
          <label>${t("الدور", "Role")}<select id="employee-role">
            <option value="agent">${t("موظف دعم", "Agent")}</option>
            <option value="supervisor">${t("مشرف", "Supervisor")}</option>
            <option value="hr">HR</option>
            <option value="manager">${t("مدير", "Manager")}</option>
            <option value="admin">Admin</option>
          </select></label>
          <label>${t("المشرف", "Supervisor")}<select id="employee-supervisor"><option value="">${t("بدون", "None")}</option></select></label>
          <label>${t("حالة الحساب", "Account status")}<select id="employee-status">
            <option value="active">${t("نشط", "Active")}</option>
            <option value="disabled">${t("معطّل", "Disabled")}</option>
            <option value="archived">${t("مؤرشف", "Archived")}</option>
          </select></label>
          <label>${t("الأجر بالساعة", "Hourly rate")}<input id="employee-rate" type="number" min="0" step="0.01" value="1.15" /></label>
          <label>${t("العملة", "Currency")}<select id="employee-currency"><option>USD</option><option>GBP</option><option>EUR</option></select></label>
          <label class="span-2">${t("المنطقة الزمنية", "Timezone")}<input id="employee-timezone" value="Asia/Damascus" placeholder="Asia/Damascus" /></label>
        </div>
        <div class="employee-form-note" id="employee-password-note">${t("عند تعديل موظف موجود، اترك كلمة المرور فارغة للاحتفاظ بكلمة المرور الحالية.", "When editing an existing employee, leave password blank to keep the current password.")}</div>
        <div class="employee-modal-actions">
          <button type="button" class="btn-secondary" id="employee-cancel">${t("إلغاء", "Cancel")}</button>
          <button type="submit" class="btn-primary" id="employee-save">${t("حفظ", "Save")}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

function ensureNavButton() {
  const nav = document.getElementById("main-nav");
  if (!nav) return null;
  let btn = document.getElementById("nav-employees");
  if (btn) return btn;
  btn = document.createElement("button");
  btn.type = "button";
  btn.id = "nav-employees";
  btn.className = "nav-link";
  btn.dataset.page = "employees";
  btn.textContent = t("الموظفون", "Employees");
  const settings = nav.querySelector('[data-page="settings"]');
  nav.insertBefore(btn, settings || nav.querySelector(".actions") || null);
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    showEmployeesPage();
  });
  return btn;
}

function showEmployeesPage() {
  if (!canManageEmployees()) return;
  document.querySelectorAll(".page-section").forEach((node) => node.classList.add("hidden"));
  document.getElementById("page-employees")?.classList.remove("hidden");
  document.querySelectorAll(".nav-link[data-page]").forEach((node) => node.classList.toggle("active", node.dataset.page === "employees"));
  refreshEmployees();
}

function supervisorName(id) {
  if (!id) return "—";
  return employees.find((row) => String(row.id) === String(id))?.name || id;
}

function filteredEmployees() {
  const q = String(document.getElementById("employees-search")?.value || "").trim().toLowerCase();
  const role = document.getElementById("employees-role-filter")?.value || "all";
  const status = document.getElementById("employees-status-filter")?.value || "all";
  return employees.filter((row) => {
    if (role !== "all" && row.role !== role) return false;
    if (status !== "all" && row.accountStatus !== status) return false;
    if (q && !`${row.name} ${row.id} ${row.role}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderEmployees() {
  const body = document.getElementById("employees-table-body");
  const empty = document.getElementById("employees-empty");
  if (!body || !empty) return;
  const rows = filteredEmployees();
  const me = getCurrentUser();
  body.innerHTML = "";
  empty.classList.toggle("hidden", rows.length > 0);

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const self = String(row.id) === String(me?.id || "");
    const status = row.accountStatus || "active";
    tr.innerHTML = `
      <td class="employee-name"><strong>${esc(row.name)}</strong><small>${esc(row.timezone || "")}</small></td>
      <td>${esc(row.id)}</td>
      <td>${esc(roleLabel(row.role))}</td>
      <td>${esc(supervisorName(row.supervisorId))}</td>
      <td><span class="employee-status ${esc(status)}">${esc(statusLabel(status))}</span></td>
      <td>${esc(row.currency || "USD")} ${Number(row.hourlyRate || 0).toFixed(2)}/h</td>
      <td>${esc(row.timezone || "—")}</td>
      <td><div class="employee-row-actions">
        <button type="button" data-employee-action="edit" data-id="${esc(row.id)}">${t("تعديل", "Edit")}</button>
        ${row.role === "agent" ? `<button type="button" data-employee-action="promote" data-id="${esc(row.id)}">${t("ترقية لمشرف", "Promote")}</button>` : ""}
        ${row.role === "supervisor" ? `<button type="button" data-employee-action="demote" data-id="${esc(row.id)}">${t("إرجاع لموظف", "Demote")}</button>` : ""}
        ${status === "active" && !self ? `<button type="button" data-employee-action="disable" data-id="${esc(row.id)}">${t("تعطيل", "Disable")}</button>` : ""}
        ${status === "disabled" ? `<button type="button" data-employee-action="reactivate" data-id="${esc(row.id)}">${t("إعادة تفعيل", "Reactivate")}</button>` : ""}
        ${status !== "archived" && !self ? `<button class="danger" type="button" data-employee-action="archive" data-id="${esc(row.id)}">${t("أرشفة", "Archive")}</button>` : ""}
      </div></td>`;
    body.appendChild(tr);
  });
}

async function refreshEmployees() {
  if (!canManageEmployees()) return;
  const btn = document.getElementById("employees-refresh");
  if (btn) btn.disabled = true;
  try {
    employees = await listEmployees({ includeDisabled: true, includeArchived: true });
    renderEmployees();
    fillSupervisorOptions();
  } catch (err) {
    console.error("employee directory refresh failed", err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function fillSupervisorOptions(selected = "") {
  const select = document.getElementById("employee-supervisor");
  if (!select) return;
  const options = employees.filter((row) => ["supervisor", "manager", "admin"].includes(row.role) && row.accountStatus === "active");
  select.innerHTML = `<option value="">${t("بدون", "None")}</option>` + options.map((row) => `<option value="${esc(row.id)}">${esc(row.name)} (${esc(row.id)})</option>`).join("");
  select.value = String(selected || "");
}

function showModalAlert(message, error = false) {
  const box = document.getElementById("employee-modal-alert");
  if (!box) return;
  box.textContent = message || "";
  box.classList.toggle("hidden", !message);
  box.classList.toggle("error", Boolean(error));
}

function openEmployeeModal(employee = null) {
  const modal = ensureEmployeeModal();
  currentEditId = employee?.id || "";
  document.getElementById("employee-modal-title").textContent = employee ? t("تعديل الموظف", "Edit employee") : t("إضافة موظف", "Add employee");
  document.getElementById("employee-name").value = employee?.name || "";
  document.getElementById("employee-id").value = employee?.id || "";
  document.getElementById("employee-id").disabled = Boolean(employee);
  document.getElementById("employee-password").value = "";
  document.getElementById("employee-role").value = employee?.role || "agent";
  document.getElementById("employee-status").value = employee?.accountStatus || "active";
  document.getElementById("employee-rate").value = Number(employee?.hourlyRate ?? 1.15);
  document.getElementById("employee-currency").value = employee?.currency || "USD";
  document.getElementById("employee-timezone").value = employee?.timezone || "Asia/Damascus";
  fillSupervisorOptions(employee?.supervisorId || "");
  showModalAlert("");
  modal.classList.remove("hidden");
  setTimeout(() => document.getElementById("employee-name")?.focus(), 20);
}

function closeEmployeeModal() {
  document.getElementById("employee-modal")?.classList.add("hidden");
  currentEditId = "";
}

async function saveEmployeeForm(event) {
  event.preventDefault();
  if (!canManageEmployees()) return;
  const actor = getCurrentUser();
  const id = currentEditId || String(document.getElementById("employee-id")?.value || "").trim();
  const password = String(document.getElementById("employee-password")?.value || "");
  const existing = employees.some((row) => String(row.id) === id);
  if (!existing && !password.trim()) return showModalAlert(t("كلمة المرور المؤقتة مطلوبة للموظف الجديد.", "Temporary password is required for a new employee."), true);

  const submit = document.getElementById("employee-save");
  if (submit) submit.disabled = true;
  try {
    await saveEmployee({
      id,
      name: document.getElementById("employee-name")?.value,
      password,
      role: document.getElementById("employee-role")?.value,
      supervisorId: document.getElementById("employee-supervisor")?.value,
      accountStatus: document.getElementById("employee-status")?.value,
      hourlyRate: document.getElementById("employee-rate")?.value,
      currency: document.getElementById("employee-currency")?.value,
      timezone: document.getElementById("employee-timezone")?.value,
    }, actor);
    closeEmployeeModal();
    await refreshEmployees();
  } catch (err) {
    showModalAlert(String(err?.message || err || t("فشل الحفظ.", "Save failed.")), true);
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function handleEmployeeAction(action, id) {
  if (!canManageEmployees()) return;
  const actor = getCurrentUser();
  const employee = employees.find((row) => String(row.id) === String(id));
  if (!employee) return;

  try {
    if (action === "edit") return openEmployeeModal(employee);
    if (action === "promote") {
      if (!confirm(t(`ترقية ${employee.name} إلى مشرف؟`, `Promote ${employee.name} to Supervisor?`))) return;
      await setEmployeeRole(id, "supervisor", actor);
    } else if (action === "demote") {
      if (!confirm(t(`إرجاع ${employee.name} إلى موظف دعم؟`, `Demote ${employee.name} to Agent?`))) return;
      await setEmployeeRole(id, "agent", actor);
    } else if (action === "disable") {
      if (!confirm(t(`تعطيل حساب ${employee.name}؟ ستبقى سجلاته محفوظة.`, `Disable ${employee.name}? Their history will remain preserved.`))) return;
      await setEmployeeStatus(id, "disabled", actor);
    } else if (action === "reactivate") {
      await setEmployeeStatus(id, "active", actor);
    } else if (action === "archive") {
      if (!confirm(t(`أرشفة ${employee.name}؟ لن يتم حذف التذاكر أو الدوام.`, `Archive ${employee.name}? Tickets and attendance will not be deleted.`))) return;
      await setEmployeeStatus(id, "archived", actor);
    }
    await refreshEmployees();
  } catch (err) {
    alert(String(err?.message || err || t("تعذر تنفيذ العملية.", "Action failed.")));
  }
}

function hookUI() {
  injectStyles();
  ensureEmployeeSection();
  ensureEmployeeModal();

  document.getElementById("employees-refresh")?.addEventListener("click", refreshEmployees);
  document.getElementById("employees-add")?.addEventListener("click", () => openEmployeeModal());
  document.getElementById("employees-search")?.addEventListener("input", renderEmployees);
  document.getElementById("employees-role-filter")?.addEventListener("change", renderEmployees);
  document.getElementById("employees-status-filter")?.addEventListener("change", renderEmployees);
  document.getElementById("employee-modal-close")?.addEventListener("click", closeEmployeeModal);
  document.getElementById("employee-cancel")?.addEventListener("click", closeEmployeeModal);
  document.getElementById("employee-form")?.addEventListener("submit", saveEmployeeForm);
  document.getElementById("employee-modal")?.addEventListener("click", (event) => {
    if (event.target?.id === "employee-modal") closeEmployeeModal();
  });
  document.getElementById("employees-table-body")?.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-employee-action]");
    if (!button) return;
    handleEmployeeAction(button.dataset.employeeAction, button.dataset.id);
  });
}

function syncVisibility() {
  const allowed = canManageEmployees();
  const nav = allowed ? ensureNavButton() : document.getElementById("nav-employees");
  nav?.classList.toggle("hidden", !allowed);
  if (!allowed) document.getElementById("page-employees")?.classList.add("hidden");
  if (allowed) refreshEmployees();
}

// Transitional guard: existing production login still lives in app.js. Until
// that large file is migrated, this prevents a centrally disabled/archived
// legacy account from bypassing the new directory. New Firestore-only users
// become fully login-capable when the app.js login migration lands in this phase.
function installLoginStatusGuard() {
  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (form?.id !== "login-form" || loginGuardBypass) return;
    const id = String(document.getElementById("ccmsId")?.value || "").trim();
    if (!id) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const employee = await getEmployee(id, { allowLegacyFallback: true }).catch(() => null);
    if (employee && employee.accountStatus !== "active") {
      const box = document.getElementById("login-error");
      if (box) {
        box.textContent = employee.accountStatus === "archived" ? t("هذا الحساب مؤرشف.", "This account is archived.") : t("هذا الحساب معطّل. تواصل مع الإدارة.", "This account is disabled. Contact management.");
        box.classList.remove("hidden");
      }
      return;
    }

    // Current hard-coded accounts continue into app.js unchanged.
    if (LEGACY_EMPLOYEE_SEED[id]) {
      loginGuardBypass = true;
      try { form.requestSubmit(); } finally { setTimeout(() => { loginGuardBypass = false; }, 0); }
      return;
    }

    // Do not pretend a newly-created account is live until app.js itself has
    // been migrated. This branch is deliberately explicit during testing.
    if (employee) {
      const box = document.getElementById("login-error");
      if (box) {
        box.textContent = t("تم إنشاء الحساب في الدليل المركزي، لكن ترحيل تسجيل الدخول ما زال قيد الاختبار في المرحلة 1.", "This account exists in the central directory; dynamic login is still being migrated in Phase 1.");
        box.classList.remove("hidden");
      }
      return;
    }

    loginGuardBypass = true;
    try { form.requestSubmit(); } finally { setTimeout(() => { loginGuardBypass = false; }, 0); }
  }, true);
}

function boot() {
  hookUI();
  syncVisibility();
  window.addEventListener("telesyriana:user-changed", syncVisibility);
  window.addEventListener("telesyriana:language-changed", () => {
    const nav = document.getElementById("nav-employees");
    if (nav) nav.textContent = t("الموظفون", "Employees");
  });
}

installLoginStatusGuard();
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
