// employees-accounts-v2.js — Phase 1B visible Employees & Accounts page
//
// IMPORTANT: this module does not auto-boot and is not wired into production
// navigation yet. The integration step will explicitly mount/open it only after
// Phase 1A migration and login compatibility gates are ready.

import {
  EMPLOYEE_ROLES,
  normaliseCanonicalRole,
} from "./employee-model.js";
import {
  employeeIdentityToLegacySession,
  legacySessionToEmployeeIdentity,
} from "./employee-identity-compat.js";
import {
  getEmployeesAccountsContext,
  listEligibleSupervisors,
  nextManagedCcmsId,
  setManagedEmployeeStatus,
  updateManagedEmployee,
} from "./employee-management-service.js";
import {
  createManagedEmployeeAccount,
  demoteManagedEmployeeAccount,
  promoteManagedEmployeeAccount,
  resetManagedEmployeeTemporaryPassword,
} from "./employee-account-provisioning.js";
import {
  credentialPromptText,
  requestTemporaryPassword,
} from "./employee-credential-prompt.js";
import {
  canManageEmployeeTarget,
  canModifyDirectoryRow,
  canOpenEmployeesAccounts,
} from "./employee-management-policy.js";

const USER_KEY = "telesyrianaUser";
let pageState = {
  actor: null,
  context: null,
  editingUid: "",
  mounted: false,
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}

function language() {
  return (document.body?.dataset?.language || document.documentElement.lang || "en") === "ar" ? "ar" : "en";
}

function t(ar, en) {
  return language() === "ar" ? ar : en;
}

function roleLabel(role) {
  const key = normaliseCanonicalRole(role);
  const labels = language() === "ar"
    ? { ceo: "الرئيس التنفيذي", acm: "مدير الحساب", supervisor: "مشرف", hr: "الموارد البشرية", agent: "موظف دعم" }
    : { ceo: "CEO", acm: "ACM", supervisor: "Supervisor", hr: "HR", agent: "Agent" };
  return labels[key] || key;
}

function statusLabel(status) {
  const labels = language() === "ar"
    ? { active: "نشط", disabled: "معطّل", archived: "مؤرشف" }
    : { active: "Active", disabled: "Disabled", archived: "Archived" };
  return labels[String(status || "active")] || status || "—";
}

function sourceLabel(source) {
  return source === "firestore"
    ? t("دائم", "Permanent")
    : t("توافق مؤقت", "Compatibility");
}

function currentLegacySession() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }
  catch { return null; }
}

export function resolveEmployeesAccountsActor(session = currentLegacySession()) {
  if (!session) return null;
  try {
    const identity = legacySessionToEmployeeIdentity(session, { allowPendingSupervisor: true });
    return identity || null;
  } catch {
    return null;
  }
}

function injectStyles() {
  if (document.getElementById("employees-v2-styles")) return;
  const style = document.createElement("style");
  style.id = "employees-v2-styles";
  style.textContent = `
    #page-employees-v2{padding:0 0 28px}.empv2-shell{display:grid;gap:16px}
    .empv2-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap}
    .empv2-head h2{margin:0 0 4px}.empv2-actions,.empv2-row-actions,.empv2-modal-actions{display:flex;gap:8px;flex-wrap:wrap}
    .empv2-banner{padding:12px 14px;border-radius:14px;font-size:13px;line-height:1.55;background:rgba(59,130,246,.10);border:1px solid rgba(59,130,246,.16)}
    .empv2-banner.warn{background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.25)}
    .empv2-stats{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:10px}.empv2-stat{padding:12px;border-radius:14px;border:1px solid rgba(100,116,139,.16)}.empv2-stat strong{display:block;font-size:22px}.empv2-stat small{opacity:.7}
    .empv2-toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 170px 170px;gap:10px}.empv2-toolbar input,.empv2-toolbar select,.empv2-form-grid input,.empv2-form-grid select{width:100%;box-sizing:border-box}
    .empv2-table-wrap{overflow:auto;border:1px solid rgba(100,116,139,.16);border-radius:16px}.empv2-table{width:100%;border-collapse:collapse;min-width:1240px}.empv2-table th,.empv2-table td{padding:11px 10px;text-align:start;border-bottom:1px solid rgba(100,116,139,.13);vertical-align:middle}.empv2-table th{font-size:12px;opacity:.72;white-space:nowrap}
    .empv2-name strong{display:block}.empv2-name small{opacity:.65}.empv2-pill{display:inline-flex;padding:5px 9px;border-radius:999px;font-size:11px;font-weight:800;background:rgba(148,163,184,.16)}.empv2-pill.active,.empv2-pill.permanent{background:rgba(34,197,94,.14);color:#15803d}.empv2-pill.disabled,.empv2-pill.compatibility{background:rgba(245,158,11,.15);color:#a16207}
    .empv2-row-actions button{padding:7px 9px;border-radius:9px;border:1px solid rgba(100,116,139,.24);background:var(--card,#fff);color:inherit;cursor:pointer;font:inherit;font-size:12px}.empv2-row-actions button:disabled{opacity:.42;cursor:not-allowed}.empv2-row-actions button.danger{color:#b91c1c}.empv2-empty{padding:28px;text-align:center;opacity:.7}
    .empv2-modal{position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:18px}.empv2-modal.hidden{display:none}.empv2-modal-card{width:min(820px,100%);max-height:92vh;overflow:auto;background:var(--card,#fff);color:inherit;border-radius:20px;padding:20px;box-shadow:0 26px 80px rgba(15,23,42,.32)}
    .empv2-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:15px}.empv2-modal-head h3{margin:0}.empv2-modal-close{border:0;background:transparent;color:inherit;font-size:25px;cursor:pointer}.empv2-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.empv2-form-grid label{display:grid;gap:6px;font-size:13px;font-weight:700}.empv2-span-2{grid-column:1/-1}.empv2-note{font-size:12px;opacity:.72;line-height:1.5}.empv2-alert{padding:10px 12px;border-radius:11px;margin-bottom:12px;background:rgba(59,130,246,.12)}.empv2-alert.error{background:rgba(239,68,68,.12);color:#b91c1c}.empv2-alert.hidden{display:none}.empv2-modal-actions{justify-content:flex-end;margin-top:18px}
    @media(max-width:800px){.empv2-stats{grid-template-columns:1fr 1fr}.empv2-toolbar,.empv2-form-grid{grid-template-columns:1fr}.empv2-span-2{grid-column:auto}}
  `;
  document.head.appendChild(style);
}

function ensurePage(container = document.getElementById("dashboard-screen")) {
  let page = document.getElementById("page-employees-v2");
  if (page) return page;
  if (!container) return null;

  page = document.createElement("section");
  page.id = "page-employees-v2";
  page.className = "page-section hidden";
  page.innerHTML = `
    <div class="card empv2-shell">
      <div class="empv2-head">
        <div><h2>${t("الموظفون والحسابات", "Employees & Accounts")}</h2><p class="subtitle">${t("هوية دائمة، CCMS حسب الدور، ومشاريع وفرق مضبوطة.", "Permanent identity, role-coded CCMS, projects and controlled teams.")}</p></div>
        <div class="empv2-actions"><button type="button" class="btn-secondary" id="empv2-refresh">${t("تحديث", "Refresh")}</button><button type="button" class="btn-primary" id="empv2-add">${t("إضافة موظف", "Add employee")}</button></div>
      </div>
      <div id="empv2-banner" class="empv2-banner"></div>
      <div class="empv2-stats"><div class="empv2-stat"><strong id="empv2-total">0</strong><small>${t("الموظفون", "Employees")}</small></div><div class="empv2-stat"><strong id="empv2-active">0</strong><small>${t("نشط", "Active")}</small></div><div class="empv2-stat"><strong id="empv2-permanent">0</strong><small>${t("هوية دائمة", "Permanent")}</small></div><div class="empv2-stat"><strong id="empv2-compat">0</strong><small>${t("توافق مؤقت", "Compatibility")}</small></div></div>
      <div class="empv2-toolbar"><input id="empv2-search" type="search" placeholder="${t("بحث بالاسم أو CCMS أو المشروع…", "Search name, CCMS or project…")}" /><select id="empv2-role-filter"><option value="all">${t("كل الأدوار", "All roles")}</option><option value="ceo">CEO</option><option value="acm">ACM</option><option value="supervisor">${t("مشرف", "Supervisor")}</option><option value="hr">HR</option><option value="agent">${t("موظف دعم", "Agent")}</option></select><select id="empv2-status-filter"><option value="all">${t("كل الحالات", "All statuses")}</option><option value="active">${t("نشط", "Active")}</option><option value="disabled">${t("معطّل", "Disabled")}</option><option value="archived">${t("مؤرشف", "Archived")}</option></select></div>
      <div class="empv2-table-wrap"><table class="empv2-table"><thead><tr><th>${t("الموظف", "Employee")}</th><th>CCMS</th><th>${t("الدور", "Role")}</th><th>${t("المشروع", "Project")}</th><th>${t("المشرف", "Supervisor")}</th><th>${t("الحالة", "Status")}</th><th>${t("الدليل", "Directory")}</th><th>${t("الأجر", "Rate")}</th><th>${t("إجراءات", "Actions")}</th></tr></thead><tbody id="empv2-body"></tbody></table><div id="empv2-empty" class="empv2-empty hidden">${t("لا توجد نتائج.", "No matching employees.")}</div></div>
    </div>`;
  container.appendChild(page);
  return page;
}

function ensureModal() {
  let modal = document.getElementById("empv2-modal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "empv2-modal";
  modal.className = "empv2-modal hidden";
  modal.innerHTML = `
    <div class="empv2-modal-card" role="dialog" aria-modal="true">
      <div class="empv2-modal-head"><h3 id="empv2-modal-title"></h3><button id="empv2-close" type="button" class="empv2-modal-close">×</button></div>
      <div id="empv2-alert" class="empv2-alert hidden"></div>
      <form id="empv2-form"><div class="empv2-form-grid">
        <label>${t("الاسم الكامل", "Full name")}<input id="empv2-name" required /></label>
        <label>CCMS<input id="empv2-ccms" readonly /></label>
        <label>${t("الدور", "Role")}<select id="empv2-role"></select></label>
        <label>${t("المشروع الرئيسي", "Primary project")}<select id="empv2-project"></select></label>
        <label id="empv2-projects-wrap" class="empv2-span-2">${t("مشاريع HR", "HR projects")}<select id="empv2-projects" multiple size="4"></select></label>
        <label id="empv2-supervisor-wrap">${t("المشرف", "Supervisor")}<select id="empv2-supervisor"></select></label>
        <label id="empv2-password-wrap" class="empv2-span-2">${t("كلمة المرور المؤقتة", "Temporary password")}<input id="empv2-password" type="password" autocomplete="new-password" minlength="8" /><small class="empv2-note">${t("8 أحرف على الأقل. تُخزّن بشكل مشفّر ولا تُحفظ كنص صريح.", "Minimum 8 characters. Stored as a salted hash, never plaintext.")}</small></label>
        <label>${t("الأجر بالساعة", "Hourly rate")}<input id="empv2-rate" type="number" min="0" step="0.01" value="1.15" /></label>
        <label>${t("العملة", "Currency")}<select id="empv2-currency"><option>USD</option><option>GBP</option><option>EUR</option></select></label>
        <label>${t("المنطقة الزمنية", "Timezone")}<input id="empv2-timezone" value="Asia/Damascus" /></label>
      </div><p class="empv2-note">${t("هوية الموظف الداخلية لا تتغير عند الترقية. تغيير الدور يتم من أزرار الترقية/التخفيض حتى يتغير CCMS بأمان.", "The permanent employee UID never changes. Role changes use Promote/Demote so CCMS is reclassified safely.")}</p><div class="empv2-modal-actions"><button id="empv2-cancel" type="button" class="btn-secondary">${t("إلغاء", "Cancel")}</button><button id="empv2-save" type="submit" class="btn-primary">${t("حفظ", "Save")}</button></div></form>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

function supervisorName(row) {
  const rows = pageState.context?.employees || [];
  const supervisor = rows.find((item) => item.employeeUid === row.supervisorUid || item.ccmsId === row.supervisorCcmsId);
  return supervisor?.fullName || row.supervisorCcmsId || "—";
}

function projectsText(row) {
  if (row.roleKey === EMPLOYEE_ROLES.CEO) return t("كل المشاريع", "All projects");
  return (row.projectIds || []).join(", ") || row.projectId || "—";
}

function directoryWritable() {
  const health = pageState.context?.directoryHealth;
  return Boolean(health && !health.migrationPending && health.accountProvisioningReady);
}

function filteredRows() {
  const rows = pageState.context?.employees || [];
  const q = String(document.getElementById("empv2-search")?.value || "").trim().toLowerCase();
  const role = document.getElementById("empv2-role-filter")?.value || "all";
  const status = document.getElementById("empv2-status-filter")?.value || "all";
  return rows.filter((row) => {
    if (role !== "all" && row.roleKey !== role) return false;
    if (status !== "all" && row.accountStatus !== status) return false;
    if (!q) return true;
    return `${row.fullName} ${row.ccmsId} ${row.roleKey} ${(row.projectIds || []).join(" ")}`.toLowerCase().includes(q);
  });
}

function render() {
  const context = pageState.context;
  if (!context) return;
  const rows = filteredRows();
  const body = document.getElementById("empv2-body");
  const empty = document.getElementById("empv2-empty");
  if (!body || !empty) return;

  const health = context.directoryHealth;
  const writable = directoryWritable();
  const banner = document.getElementById("empv2-banner");
  const waitingMigration = health.migrationPending;
  const waitingProvisioning = !waitingMigration && !health.accountProvisioningReady;
  banner.classList.toggle("warn", waitingMigration || waitingProvisioning);
  banner.textContent = waitingMigration
    ? t("الترحيل الدائم ما زال معلّقاً بسبب جاهزية Firestore. حسابات التوافق ظاهرة للقراءة فقط ولن نسمح بتعديلها أو إنشاء حالة مختلطة.", "Permanent migration is still pending because Firestore is not ready. Compatibility accounts are view-only; unsafe mixed-directory writes are disabled.")
    : waitingProvisioning
      ? t("الدليل الدائم جاهز، لكن إنشاء الحسابات ما زال مقفلاً حتى يكتمل اختبار ربط تسجيل الدخول وكلمات المرور المشفّرة.", "The permanent directory is ready, but account writes remain locked until the hashed-credential login bridge is fully validated.")
      : t("الدليل الدائم وربط الحسابات جاهزان. يمكن إدارة الحسابات ضمن صلاحيات المشروع.", "Permanent directory and account provisioning are ready. Accounts can be managed within project permissions.");

  document.getElementById("empv2-add").disabled = !writable;
  document.getElementById("empv2-total").textContent = String(context.employees.length);
  document.getElementById("empv2-active").textContent = String(context.employees.filter((row) => row.accountStatus === "active").length);
  document.getElementById("empv2-permanent").textContent = String(health.firestoreCount);
  document.getElementById("empv2-compat").textContent = String(health.compatibilityCount);

  body.innerHTML = "";
  empty.classList.toggle("hidden", rows.length > 0);
  rows.forEach((row) => {
    const manageable = canManageEmployeeTarget(pageState.actor, row);
    const rowWritable = writable && canModifyDirectoryRow(pageState.actor, row);
    const isAgent = row.roleKey === EMPLOYEE_ROLES.AGENT;
    const isSupervisor = row.roleKey === EMPLOYEE_ROLES.SUPERVISOR;
    const status = row.accountStatus || "active";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="empv2-name"><strong>${esc(row.fullName)}</strong><small>${esc(row.employeeUid)}</small></td><td>${esc(row.ccmsId)}</td><td>${esc(roleLabel(row.roleKey))}</td><td>${esc(projectsText(row))}</td><td>${esc(supervisorName(row))}</td><td><span class="empv2-pill ${esc(status)}">${esc(statusLabel(status))}</span></td><td><span class="empv2-pill ${row.directorySource === "firestore" ? "permanent" : "compatibility"}">${esc(sourceLabel(row.directorySource))}</span></td><td>${esc(row.currency || "USD")} ${Number(row.hourlyRate || 0).toFixed(2)}/h</td><td><div class="empv2-row-actions">
      ${manageable ? `<button data-act="edit" data-uid="${esc(row.employeeUid)}" ${rowWritable ? "" : "disabled"}>${t("تعديل", "Edit")}</button>` : ""}
      ${manageable && row.directorySource === "firestore" ? `<button data-act="reset-password" data-uid="${esc(row.employeeUid)}" ${rowWritable ? "" : "disabled"}>${t("كلمة مرور جديدة", "Reset password")}</button>` : ""}
      ${manageable && isAgent ? `<button data-act="promote" data-uid="${esc(row.employeeUid)}" ${rowWritable ? "" : "disabled"}>${t("ترقية", "Promote")}</button>` : ""}
      ${manageable && isSupervisor ? `<button data-act="demote" data-uid="${esc(row.employeeUid)}" ${rowWritable ? "" : "disabled"}>${t("تخفيض", "Demote")}</button>` : ""}
      ${manageable && status === "active" ? `<button data-act="disable" data-uid="${esc(row.employeeUid)}" ${rowWritable ? "" : "disabled"}>${t("تعطيل", "Disable")}</button>` : ""}
      ${manageable && status === "disabled" ? `<button data-act="reactivate" data-uid="${esc(row.employeeUid)}" ${rowWritable ? "" : "disabled"}>${t("إعادة تفعيل", "Reactivate")}</button>` : ""}
      ${manageable && status !== "archived" ? `<button class="danger" data-act="archive" data-uid="${esc(row.employeeUid)}" ${rowWritable ? "" : "disabled"}>${t("أرشفة", "Archive")}</button>` : ""}
    </div></td>`;
    body.appendChild(tr);
  });
}

function modalAlert(message = "", error = false) {
  const box = document.getElementById("empv2-alert");
  if (!box) return;
  box.textContent = message;
  box.classList.toggle("hidden", !message);
  box.classList.toggle("error", Boolean(error));
}

function roleOptions(selected = "agent") {
  const select = document.getElementById("empv2-role");
  if (!select) return;
  const roles = pageState.context?.allowedCreationRoles || [];
  select.innerHTML = roles.map((role) => `<option value="${esc(role)}">${esc(roleLabel(role))}</option>`).join("");
  select.value = roles.includes(selected) ? selected : roles[0] || "agent";
}

function projectOptions(selected = "") {
  const projects = pageState.context?.projects || [];
  const primary = document.getElementById("empv2-project");
  const multiple = document.getElementById("empv2-projects");
  const html = projects.filter((row) => row.accountStatus === "active").map((row) => `<option value="${esc(row.projectId)}">${esc(row.name || row.projectId)}</option>`).join("");
  primary.innerHTML = html;
  multiple.innerHTML = html;
  primary.value = selected || projects.find((row) => row.accountStatus === "active")?.projectId || "";
}

async function refreshSupervisorOptions(selected = "") {
  const select = document.getElementById("empv2-supervisor");
  const projectId = document.getElementById("empv2-project")?.value || "";
  if (!select) return;
  try {
    const rows = projectId ? await listEligibleSupervisors(pageState.actor, projectId) : [];
    select.innerHTML = `<option value="">${t("اختر المشرف", "Choose Supervisor")}</option>` + rows.map((row) => `<option value="${esc(row.employeeUid)}" data-ccms="${esc(row.ccmsId)}">${esc(row.fullName)} (${esc(row.ccmsId)})</option>`).join("");
    select.value = selected || "";
  } catch {
    select.innerHTML = `<option value="">${t("لا يوجد مشرف متاح", "No Supervisor available")}</option>`;
  }
}

async function syncRoleFields() {
  const role = document.getElementById("empv2-role")?.value || "agent";
  const hr = role === EMPLOYEE_ROLES.HR;
  const agent = role === EMPLOYEE_ROLES.AGENT;
  document.getElementById("empv2-projects-wrap")?.classList.toggle("hidden", !hr);
  document.getElementById("empv2-supervisor-wrap")?.classList.toggle("hidden", !agent);
  try { document.getElementById("empv2-ccms").value = await nextManagedCcmsId(role); }
  catch { document.getElementById("empv2-ccms").value = ""; }
  if (agent) await refreshSupervisorOptions();
}

async function openModal(row = null) {
  if (!directoryWritable()) return;
  ensureModal();
  pageState.editingUid = row?.employeeUid || "";
  document.getElementById("empv2-modal-title").textContent = row ? t("تعديل الموظف", "Edit employee") : t("إضافة موظف", "Add employee");
  document.getElementById("empv2-name").value = row?.fullName || "";
  roleOptions(row?.roleKey || "agent");
  document.getElementById("empv2-role").disabled = Boolean(row);
  projectOptions(row?.projectId || "");
  document.getElementById("empv2-rate").value = Number(row?.hourlyRate ?? 1.15);
  document.getElementById("empv2-currency").value = row?.currency || "USD";
  document.getElementById("empv2-timezone").value = row?.timezone || "Asia/Damascus";
  const passwordWrap = document.getElementById("empv2-password-wrap");
  const passwordInput = document.getElementById("empv2-password");
  passwordWrap?.classList.toggle("hidden", Boolean(row));
  if (passwordInput) passwordInput.value = "";
  const multiple = document.getElementById("empv2-projects");
  Array.from(multiple.options).forEach((opt) => { opt.selected = (row?.projectIds || []).includes(opt.value); });
  await syncRoleFields();
  if (row) document.getElementById("empv2-ccms").value = row.ccmsId;
  await refreshSupervisorOptions(row?.supervisorUid || "");
  modalAlert();
  document.getElementById("empv2-modal").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("empv2-modal")?.classList.add("hidden");
  pageState.editingUid = "";
}

async function saveForm(event) {
  event.preventDefault();
  if (!directoryWritable()) return;
  const save = document.getElementById("empv2-save");
  if (save) save.disabled = true;
  try {
    const roleKey = document.getElementById("empv2-role")?.value || "agent";
    const projectId = document.getElementById("empv2-project")?.value || "";
    const projectIds = roleKey === EMPLOYEE_ROLES.HR
      ? Array.from(document.getElementById("empv2-projects")?.selectedOptions || []).map((opt) => opt.value)
      : [projectId];
    const supervisorSelect = document.getElementById("empv2-supervisor");
    const supervisorUid = roleKey === EMPLOYEE_ROLES.AGENT ? supervisorSelect?.value || "" : "";
    const selectedSupervisor = supervisorSelect?.selectedOptions?.[0];
    const supervisorCcmsId = roleKey === EMPLOYEE_ROLES.AGENT ? selectedSupervisor?.dataset?.ccms || "" : "";
    const payload = {
      fullName: document.getElementById("empv2-name")?.value,
      roleKey,
      ccmsId: document.getElementById("empv2-ccms")?.value,
      projectId,
      projectIds,
      supervisorUid,
      supervisorCcmsId,
      hourlyRate: document.getElementById("empv2-rate")?.value,
      currency: document.getElementById("empv2-currency")?.value,
      timezone: document.getElementById("empv2-timezone")?.value,
      accountStatus: "active",
    };

    if (pageState.editingUid) {
      await updateManagedEmployee(pageState.actor, pageState.editingUid, payload);
    } else {
      await createManagedEmployeeAccount(pageState.actor, payload, {
        temporaryPassword: document.getElementById("empv2-password")?.value || "",
      });
    }
    closeModal();
    await refreshContext();
  } catch (error) {
    modalAlert(String(error?.message || error || t("فشل الحفظ.", "Save failed.")), true);
  } finally {
    if (save) save.disabled = false;
  }
}

async function action(type, employeeUid) {
  const row = pageState.context?.employees?.find((item) => item.employeeUid === employeeUid);
  if (!directoryWritable() || !row || !canManageEmployeeTarget(pageState.actor, row) || !canModifyDirectoryRow(pageState.actor, row)) return;
  try {
    if (type === "edit") return openModal(row);
    if (type === "reset-password") {
      const temporaryPassword = await requestTemporaryPassword({
        title: t("كلمة مرور مؤقتة جديدة", "New temporary password"),
        message: credentialPromptText(row.fullName, "reset"),
      });
      if (!temporaryPassword) return;
      await resetManagedEmployeeTemporaryPassword(pageState.actor, employeeUid, temporaryPassword);
    } else if (type === "promote") {
      if (!confirm(t(`ترقية ${row.fullName} من ${row.ccmsId} إلى مشرف مع CCMS جديد؟`, `Promote ${row.fullName} from ${row.ccmsId} to Supervisor with a new CCMS?`))) return;
      const temporaryPassword = await requestTemporaryPassword({
        title: t("ترقية وتغيير CCMS", "Promotion and CCMS change"),
        message: credentialPromptText(row.fullName, "promotion"),
      });
      if (!temporaryPassword) return;
      await promoteManagedEmployeeAccount(pageState.actor, employeeUid, { temporaryPassword });
    } else if (type === "demote") {
      const supervisors = await listEligibleSupervisors(pageState.actor, row.projectId);
      const eligible = supervisors.filter((sup) => sup.employeeUid !== employeeUid);
      if (!eligible.length) throw new Error(t("لا يوجد مشرف آخر في نفس المشروع لاستلام الموظف.", "No other Supervisor in this project is available for the demoted Agent."));
      const target = eligible[0];
      if (!confirm(t(`سيتم تخفيض ${row.fullName} إلى Agent وتعيينه إلى ${target.fullName}. متابعة؟`, `Demote ${row.fullName} to Agent and assign to ${target.fullName}?`))) return;
      const temporaryPassword = await requestTemporaryPassword({
        title: t("تخفيض وتغيير CCMS", "Demotion and CCMS change"),
        message: credentialPromptText(row.fullName, "demotion"),
      });
      if (!temporaryPassword) return;
      await demoteManagedEmployeeAccount(pageState.actor, employeeUid, {
        supervisorUid: target.employeeUid,
        supervisorCcmsId: target.ccmsId,
        temporaryPassword,
      });
    } else if (type === "disable") {
      if (!confirm(t(`تعطيل ${row.fullName}؟ ستبقى كل السجلات محفوظة.`, `Disable ${row.fullName}? All history will remain preserved.`))) return;
      await setManagedEmployeeStatus(pageState.actor, employeeUid, "disabled");
    } else if (type === "reactivate") {
      await setManagedEmployeeStatus(pageState.actor, employeeUid, "active");
    } else if (type === "archive") {
      if (!confirm(t(`أرشفة ${row.fullName}؟ لن يتم حذف التاريخ.`, `Archive ${row.fullName}? Historical data will not be deleted.`))) return;
      await setManagedEmployeeStatus(pageState.actor, employeeUid, "archived");
    }
    await refreshContext();
  } catch (error) {
    alert(String(error?.message || error || t("تعذر تنفيذ العملية.", "Action failed.")));
  }
}

async function refreshContext() {
  const refresh = document.getElementById("empv2-refresh");
  if (refresh) refresh.disabled = true;
  try {
    pageState.context = await getEmployeesAccountsContext(pageState.actor);
    render();
  } finally {
    if (refresh) refresh.disabled = false;
  }
}

function hook() {
  if (pageState.mounted) return;
  pageState.mounted = true;
  document.getElementById("empv2-refresh")?.addEventListener("click", refreshContext);
  document.getElementById("empv2-add")?.addEventListener("click", () => openModal());
  document.getElementById("empv2-search")?.addEventListener("input", render);
  document.getElementById("empv2-role-filter")?.addEventListener("change", render);
  document.getElementById("empv2-status-filter")?.addEventListener("change", render);
  document.getElementById("empv2-close")?.addEventListener("click", closeModal);
  document.getElementById("empv2-cancel")?.addEventListener("click", closeModal);
  document.getElementById("empv2-form")?.addEventListener("submit", saveForm);
  document.getElementById("empv2-role")?.addEventListener("change", syncRoleFields);
  document.getElementById("empv2-project")?.addEventListener("change", () => refreshSupervisorOptions());
  document.getElementById("empv2-body")?.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-act]");
    if (button && !button.disabled) action(button.dataset.act, button.dataset.uid);
  });
  document.getElementById("empv2-modal")?.addEventListener("click", (event) => { if (event.target?.id === "empv2-modal") closeModal(); });
}

export async function mountEmployeesAccountsV2({ container, actor } = {}) {
  injectStyles();
  ensurePage(container || document.getElementById("dashboard-screen"));
  ensureModal();
  hook();

  pageState.actor = actor || resolveEmployeesAccountsActor();
  if (!pageState.actor || !canOpenEmployeesAccounts(pageState.actor)) {
    throw new Error("Employees & Accounts is available only to CEO, ACM and HR.");
  }
  return document.getElementById("page-employees-v2");
}

export async function openEmployeesAccountsV2(options = {}) {
  await mountEmployeesAccountsV2(options);
  document.querySelectorAll(".page-section").forEach((node) => node.classList.add("hidden"));
  document.getElementById("page-employees-v2")?.classList.remove("hidden");
  await refreshContext();
  return pageState.context;
}

export function closeEmployeesAccountsV2() {
  document.getElementById("page-employees-v2")?.classList.add("hidden");
}

// Useful for the later controlled login integration: enrich a legacy saved session
// with employeeUid/project/roleKey without exposing credentials.
export function legacySessionWithIdentity(session = currentLegacySession()) {
  const identity = resolveEmployeesAccountsActor(session);
  return identity ? employeeIdentityToLegacySession(identity) : session;
}
