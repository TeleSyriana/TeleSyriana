// employees-accounts-readonly.js — visible Phase 1 employee directory preview
//
// Production-safe integration rules:
// - zero Firestore imports and zero database reads/writes
// - existing seven approved Phase 1A identity seed rows only
// - visible to CEO, ACM and HR only
// - no Add/Edit/Promote/Disable/Archive controls
// - current login/authentication remains owned by app-core.js

import {
  CURRENT_EMPLOYEE_IDENTITY_SEED,
  seedIdentityByCcms,
} from "./employee-identity-seed.js";

const USER_KEY = "telesyrianaUser";
const PAGE_ID = "page-employees-readonly";
const NAV_ID = "nav-employees-readonly";
const MANAGEMENT_ROLES = new Set(["ceo", "acm", "hr"]);

let mounted = false;
let currentRows = [];

function clean(value) {
  return String(value ?? "").trim();
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}

function isArabic() {
  const lang = clean(document.body?.dataset?.language || document.documentElement.lang || "en").toLowerCase();
  return lang === "ar";
}

function t(ar, en) {
  return isArabic() ? ar : en;
}

function readSession() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

function canonicalRole(role) {
  const value = clean(role).toLowerCase();
  if (value === "admin") return "ceo";
  if (value === "manager") return "acm";
  if (["ceo", "acm", "supervisor", "hr", "agent"].includes(value)) return value;
  return "agent";
}

function actorIdentity() {
  const session = readSession();
  if (!session?.id) return null;
  const seeded = seedIdentityByCcms(session.id);
  if (seeded) return seeded;

  return {
    employeeUid: clean(session.employeeUid),
    ccmsId: clean(session.ccmsId || session.id),
    fullName: clean(session.fullName || session.name || session.id),
    roleKey: canonicalRole(session.roleKey || session.role),
    projectId: clean(session.projectId || "ipro"),
    projectIds: Array.isArray(session.projectIds) ? session.projectIds.map(clean).filter(Boolean) : [clean(session.projectId || "ipro")],
    accountStatus: clean(session.accountStatus || "active"),
  };
}

function canOpen(actor = actorIdentity()) {
  return Boolean(actor?.ccmsId && MANAGEMENT_ROLES.has(canonicalRole(actor.roleKey)));
}

function roleLabel(role) {
  const key = canonicalRole(role);
  const labels = isArabic()
    ? { ceo: "الرئيس التنفيذي", acm: "مدير الحساب", supervisor: "مشرف", hr: "الموارد البشرية", agent: "موظف دعم" }
    : { ceo: "CEO", acm: "ACM", supervisor: "Supervisor", hr: "HR", agent: "Agent" };
  return labels[key] || key;
}

function statusLabel(status) {
  const key = clean(status || "active").toLowerCase();
  const labels = isArabic()
    ? { active: "نشط", disabled: "معطّل", archived: "مؤرشف" }
    : { active: "Active", disabled: "Disabled", archived: "Archived" };
  return labels[key] || key;
}

function projectLabel(projectId) {
  const id = clean(projectId);
  if (id === "*") return t("كل المشاريع", "All projects");
  if (id === "ipro") return "iPro";
  return id || "—";
}

function scopedRows(actor) {
  const role = canonicalRole(actor?.roleKey);
  const actorProjects = Array.isArray(actor?.projectIds) && actor.projectIds.length
    ? actor.projectIds.map(clean)
    : [clean(actor?.projectId)].filter(Boolean);

  return CURRENT_EMPLOYEE_IDENTITY_SEED
    .filter((row) => {
      if (role === "ceo") return true;
      if (canonicalRole(row.roleKey) === "ceo") return false;
      const rowProjects = Array.isArray(row.projectIds) && row.projectIds.length
        ? row.projectIds.map(clean)
        : [clean(row.projectId)].filter(Boolean);
      return rowProjects.some((projectId) => actorProjects.includes(projectId));
    })
    .map((row) => ({ ...row, projectIds: [...(row.projectIds || [])], directorySource: "compatibility" }))
    .sort((a, b) => a.ccmsId.localeCompare(b.ccmsId));
}

function supervisorName(row) {
  const supervisor = row?.supervisorUid
    ? CURRENT_EMPLOYEE_IDENTITY_SEED.find((item) => item.employeeUid === row.supervisorUid)
    : CURRENT_EMPLOYEE_IDENTITY_SEED.find((item) => item.ccmsId === row?.supervisorCcmsId);
  return supervisor ? `${supervisor.fullName} (${supervisor.ccmsId})` : "—";
}

function injectStyles() {
  if (document.getElementById("employees-readonly-styles")) return;
  const style = document.createElement("style");
  style.id = "employees-readonly-styles";
  style.textContent = `
    #${PAGE_ID}{padding:0 0 28px}
    .employees-ro-shell{display:grid;gap:16px}
    .employees-ro-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
    .employees-ro-head h2{margin:0 0 5px}
    .employees-ro-badge{display:inline-flex;align-items:center;gap:6px;padding:7px 11px;border-radius:999px;background:rgba(245,158,11,.14);color:#a16207;font-size:12px;font-weight:800}
    .employees-ro-banner{padding:13px 15px;border-radius:14px;background:rgba(59,130,246,.10);border:1px solid rgba(59,130,246,.18);font-size:13px;line-height:1.6}
    .employees-ro-stats{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:10px}
    .employees-ro-stat{padding:13px;border-radius:14px;border:1px solid rgba(100,116,139,.16);background:rgba(148,163,184,.04)}
    .employees-ro-stat strong{display:block;font-size:23px;line-height:1.1}.employees-ro-stat span{font-size:12px;opacity:.7}
    .employees-ro-toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 180px 180px;gap:10px}
    .employees-ro-toolbar input,.employees-ro-toolbar select{width:100%;box-sizing:border-box}
    .employees-ro-table-wrap{overflow:auto;border:1px solid rgba(100,116,139,.16);border-radius:16px}
    .employees-ro-table{width:100%;border-collapse:collapse;min-width:1050px}
    .employees-ro-table th,.employees-ro-table td{padding:12px 11px;text-align:start;border-bottom:1px solid rgba(100,116,139,.13);vertical-align:middle}
    .employees-ro-table th{font-size:12px;opacity:.7;white-space:nowrap}
    .employees-ro-name strong{display:block}.employees-ro-name small{display:block;opacity:.62;margin-top:3px}
    .employees-ro-pill{display:inline-flex;padding:5px 9px;border-radius:999px;font-size:11px;font-weight:800;background:rgba(148,163,184,.16)}
    .employees-ro-pill.active{background:rgba(34,197,94,.14);color:#15803d}
    .employees-ro-pill.compatibility{background:rgba(245,158,11,.15);color:#a16207}
    .employees-ro-empty{padding:28px;text-align:center;opacity:.7}
    @media(max-width:800px){.employees-ro-stats{grid-template-columns:1fr 1fr}.employees-ro-toolbar{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}

function ensureNav() {
  const mainNav = document.getElementById("main-nav");
  if (!mainNav) return null;
  let button = document.getElementById(NAV_ID);
  if (button) return button;

  button = document.createElement("button");
  button.type = "button";
  button.id = NAV_ID;
  button.className = "nav-link hidden";
  button.dataset.page = "employees-readonly";
  button.textContent = t("الموظفون والحسابات", "Employees & Accounts");
  mainNav.insertBefore(button, mainNav.querySelector('[data-page="settings"]') || mainNav.querySelector(".actions") || null);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    openPage();
  });
  return button;
}

function ensurePage() {
  const dashboard = document.getElementById("dashboard-screen");
  if (!dashboard) return null;
  let page = document.getElementById(PAGE_ID);
  if (page) return page;

  page = document.createElement("section");
  page.id = PAGE_ID;
  page.className = "page-section hidden";
  page.innerHTML = `
    <div class="card employees-ro-shell">
      <div class="employees-ro-head">
        <div>
          <h2 id="employees-ro-title"></h2>
          <p id="employees-ro-subtitle" class="subtitle"></p>
        </div>
        <span class="employees-ro-badge" id="employees-ro-mode"></span>
      </div>
      <div id="employees-ro-banner" class="employees-ro-banner"></div>
      <div class="employees-ro-stats">
        <div class="employees-ro-stat"><strong id="employees-ro-total">0</strong><span id="employees-ro-total-label"></span></div>
        <div class="employees-ro-stat"><strong id="employees-ro-active">0</strong><span id="employees-ro-active-label"></span></div>
        <div class="employees-ro-stat"><strong id="employees-ro-supervisors">0</strong><span id="employees-ro-supervisors-label"></span></div>
        <div class="employees-ro-stat"><strong id="employees-ro-agents">0</strong><span id="employees-ro-agents-label"></span></div>
      </div>
      <div class="employees-ro-toolbar">
        <input id="employees-ro-search" type="search" />
        <select id="employees-ro-role-filter"></select>
        <select id="employees-ro-status-filter"></select>
      </div>
      <div class="employees-ro-table-wrap">
        <table class="employees-ro-table">
          <thead><tr id="employees-ro-head-row"></tr></thead>
          <tbody id="employees-ro-body"></tbody>
        </table>
        <div id="employees-ro-empty" class="employees-ro-empty hidden"></div>
      </div>
    </div>`;
  dashboard.appendChild(page);

  page.querySelector("#employees-ro-search")?.addEventListener("input", renderTable);
  page.querySelector("#employees-ro-role-filter")?.addEventListener("change", renderTable);
  page.querySelector("#employees-ro-status-filter")?.addEventListener("change", renderTable);
  return page;
}

function refreshText() {
  const nav = ensureNav();
  if (nav) nav.textContent = t("الموظفون والحسابات", "Employees & Accounts");
  if (!ensurePage()) return;

  document.getElementById("employees-ro-title").textContent = t("الموظفون والحسابات", "Employees & Accounts");
  document.getElementById("employees-ro-subtitle").textContent = t("معاينة هيكل CCMS والمشروع والفريق قبل تفعيل الإدارة الدائمة.", "Preview the CCMS, project and team structure before permanent account management is activated.");
  document.getElementById("employees-ro-mode").textContent = t("للعرض فقط", "View only");
  document.getElementById("employees-ro-banner").textContent = t(
    "مرحلة الانتقال قيد التنفيذ. هذه الصفحة لا تنشئ أو تعدّل أو تعطل أي حساب، ولا تستخدم Firestore. ستُفتح الإجراءات بعد اكتمال فحص وترحيل الهوية الدائمة.",
    "Migration is still pending. This page cannot create, edit or disable accounts and makes no Firestore requests. Actions will unlock only after the permanent identity migration is safely completed."
  );
  document.getElementById("employees-ro-total-label").textContent = t("الموظفون الظاهرون", "Visible employees");
  document.getElementById("employees-ro-active-label").textContent = t("الحسابات النشطة", "Active accounts");
  document.getElementById("employees-ro-supervisors-label").textContent = t("المشرفون", "Supervisors");
  document.getElementById("employees-ro-agents-label").textContent = t("موظفو الدعم", "Agents");

  const search = document.getElementById("employees-ro-search");
  if (search) search.placeholder = t("بحث بالاسم أو CCMS أو المشروع…", "Search name, CCMS or project…");

  const role = document.getElementById("employees-ro-role-filter");
  if (role) {
    const selected = role.value || "all";
    role.innerHTML = `
      <option value="all">${t("كل الأدوار", "All roles")}</option>
      <option value="ceo">CEO</option>
      <option value="acm">ACM</option>
      <option value="supervisor">${t("مشرف", "Supervisor")}</option>
      <option value="hr">HR</option>
      <option value="agent">${t("موظف دعم", "Agent")}</option>`;
    role.value = Array.from(role.options).some((option) => option.value === selected) ? selected : "all";
  }

  const status = document.getElementById("employees-ro-status-filter");
  if (status) {
    const selected = status.value || "all";
    status.innerHTML = `
      <option value="all">${t("كل الحالات", "All statuses")}</option>
      <option value="active">${t("نشط", "Active")}</option>
      <option value="disabled">${t("معطّل", "Disabled")}</option>
      <option value="archived">${t("مؤرشف", "Archived")}</option>`;
    status.value = Array.from(status.options).some((option) => option.value === selected) ? selected : "all";
  }

  const headers = isArabic()
    ? ["الموظف", "CCMS", "الدور", "المشروع", "المشرف", "الحالة", "الأجر", "المنطقة الزمنية", "الدليل"]
    : ["Employee", "CCMS", "Role", "Project", "Supervisor", "Status", "Rate", "Timezone", "Directory"];
  document.getElementById("employees-ro-head-row").innerHTML = headers.map((label) => `<th>${esc(label)}</th>`).join("");
  document.getElementById("employees-ro-empty").textContent = t("لا توجد نتائج مطابقة.", "No matching employees.");
}

function filteredRows() {
  const query = clean(document.getElementById("employees-ro-search")?.value).toLowerCase();
  const role = clean(document.getElementById("employees-ro-role-filter")?.value || "all");
  const status = clean(document.getElementById("employees-ro-status-filter")?.value || "all");

  return currentRows.filter((row) => {
    if (role !== "all" && canonicalRole(row.roleKey) !== role) return false;
    if (status !== "all" && clean(row.accountStatus) !== status) return false;
    if (!query) return true;
    const haystack = [row.fullName, row.ccmsId, row.roleKey, row.projectId, ...(row.projectIds || [])].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function renderTable() {
  const body = document.getElementById("employees-ro-body");
  const empty = document.getElementById("employees-ro-empty");
  if (!body || !empty) return;

  const rows = filteredRows();
  body.innerHTML = rows.map((row) => {
    const projects = row.roleKey === "ceo"
      ? projectLabel("*")
      : (row.projectIds?.length ? row.projectIds : [row.projectId]).map(projectLabel).join(", ");
    const status = clean(row.accountStatus || "active");
    return `<tr data-employee-ccms="${esc(row.ccmsId)}">
      <td class="employees-ro-name"><strong>${esc(row.fullName)}</strong><small>${esc(row.employeeUid)}</small></td>
      <td>${esc(row.ccmsId)}</td>
      <td>${esc(roleLabel(row.roleKey))}</td>
      <td>${esc(projects)}</td>
      <td>${esc(supervisorName(row))}</td>
      <td><span class="employees-ro-pill ${esc(status)}">${esc(statusLabel(status))}</span></td>
      <td>${esc(row.currency || "USD")} ${Number(row.hourlyRate || 0).toFixed(2)}/h</td>
      <td>${esc(row.timezone || "—")}</td>
      <td><span class="employees-ro-pill compatibility">${esc(t("توافق مؤقت", "Compatibility"))}</span></td>
    </tr>`;
  }).join("");
  empty.classList.toggle("hidden", rows.length > 0);
}

function render(actor = actorIdentity()) {
  if (!actor || !canOpen(actor)) return;
  currentRows = scopedRows(actor);
  refreshText();

  document.getElementById("employees-ro-total").textContent = String(currentRows.length);
  document.getElementById("employees-ro-active").textContent = String(currentRows.filter((row) => row.accountStatus === "active").length);
  document.getElementById("employees-ro-supervisors").textContent = String(currentRows.filter((row) => row.roleKey === "supervisor").length);
  document.getElementById("employees-ro-agents").textContent = String(currentRows.filter((row) => row.roleKey === "agent").length);
  renderTable();
}

function openPage() {
  const actor = actorIdentity();
  if (!canOpen(actor)) return;
  ensurePage();
  document.querySelectorAll(".page-section").forEach((section) => section.classList.add("hidden"));
  document.getElementById(PAGE_ID)?.classList.remove("hidden");
  document.querySelectorAll(".nav-link[data-page]").forEach((button) => {
    button.classList.toggle("active", button.id === NAV_ID);
  });
  render(actor);
}

function syncVisibility() {
  const actor = actorIdentity();
  const allowed = canOpen(actor);
  const nav = ensureNav();
  ensurePage();
  nav?.classList.toggle("hidden", !allowed);
  if (!allowed) document.getElementById(PAGE_ID)?.classList.add("hidden");
  if (allowed) render(actor);
}

function boot() {
  if (mounted) return;
  mounted = true;
  injectStyles();
  ensureNav();
  ensurePage();
  syncVisibility();

  document.getElementById("main-nav")?.addEventListener("click", (event) => {
    const button = event.target?.closest?.(".nav-link[data-page]");
    if (!button || button.id === NAV_ID) return;
    document.getElementById(PAGE_ID)?.classList.add("hidden");
    document.getElementById(NAV_ID)?.classList.remove("active");
  });

  window.addEventListener("telesyriana:user-changed", syncVisibility);
  window.addEventListener("telesyriana:language-changed", () => {
    refreshText();
    renderTable();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === USER_KEY) syncVisibility();
  });

  const dashboard = document.getElementById("dashboard-screen");
  if (dashboard) {
    new MutationObserver(syncVisibility).observe(dashboard, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
