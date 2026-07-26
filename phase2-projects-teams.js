// phase2-projects-teams.js — visible Projects & Teams management surface
//
// Production-safety contract:
// - local approved employee identity seed only
// - pure project/team projection modules only
// - zero Firebase/Firestore imports, reads, listeners or writes
// - current login remains owned by app-core.js
// - management surface is visible only to CEO, ACM and HR

import { CURRENT_EMPLOYEE_IDENTITY_SEED, seedIdentityByCcms } from "./employee-identity-seed.js";
import { buildProjectHierarchy } from "./project-hierarchy-shadow.js";
import { DEFAULT_PROJECT } from "./project-model.js";

const USER_KEY = "telesyrianaUser";
const NAV_ID = "nav-projects-teams-v2";
const PAGE_ID = "page-projects-teams-v2";
const VISIBLE_ROLES = new Set(["ceo", "acm", "hr"]);
let mounted = false;

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
  return clean(document.body?.dataset?.language || document.documentElement.lang || "en").toLowerCase() === "ar";
}

function t(ar, en) {
  return isArabic() ? ar : en;
}

function canonicalRole(role) {
  const value = clean(role).toLowerCase();
  if (value === "admin") return "ceo";
  if (value === "manager") return "acm";
  if (["ceo", "acm", "supervisor", "hr", "agent"].includes(value)) return value;
  return "agent";
}

function readSession() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

function actorIdentity() {
  const session = readSession();
  const id = clean(session?.ccmsId || session?.id);
  if (!id) return null;
  const seeded = seedIdentityByCcms(id);
  if (seeded) return seeded;
  return {
    employeeUid: clean(session?.employeeUid),
    ccmsId: id,
    fullName: clean(session?.fullName || session?.name || id),
    roleKey: canonicalRole(session?.roleKey || session?.role),
    projectId: clean(session?.projectId || "ipro"),
    projectIds: Array.isArray(session?.projectIds)
      ? session.projectIds.map(clean).filter(Boolean)
      : [clean(session?.projectId || "ipro")],
    accountStatus: clean(session?.accountStatus || "active"),
  };
}

function roleLabel(role) {
  const key = canonicalRole(role);
  const labels = isArabic()
    ? { ceo: "الرئيس التنفيذي", acm: "مدير الحساب", supervisor: "مشرف", hr: "الموارد البشرية", agent: "موظف دعم" }
    : { ceo: "CEO", acm: "ACM", supervisor: "Supervisor", hr: "HR", agent: "Agent" };
  return labels[key] || key;
}

function projectRows() {
  return CURRENT_EMPLOYEE_IDENTITY_SEED
    .filter((row) => row.roleKey !== "ceo" && (row.projectIds || [row.projectId]).includes(DEFAULT_PROJECT.projectId));
}

function projectHierarchy() {
  return buildProjectHierarchy(DEFAULT_PROJECT.projectId, CURRENT_EMPLOYEE_IDENTITY_SEED);
}

function canOpen(actor = actorIdentity()) {
  return Boolean(
    actor?.ccmsId &&
    actor.accountStatus !== "disabled" &&
    VISIBLE_ROLES.has(canonicalRole(actor.roleKey))
  );
}

function navLabel(actor = actorIdentity()) {
  const role = canonicalRole(actor?.roleKey);
  if (role === "acm") return t("لوحة المشروع", "Project Dashboard");
  if (role === "hr") return t("فريق المشروع", "Project People");
  return t("المشاريع والفرق", "Projects & Teams");
}

function injectStyles() {
  if (document.getElementById("phase2-projects-teams-styles")) return;
  const style = document.createElement("style");
  style.id = "phase2-projects-teams-styles";
  style.textContent = `
    #${PAGE_ID}{padding:0 0 28px}
    .p2-shell{display:grid;gap:16px}.p2-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap}
    .p2-head h2{margin:0 0 5px}.p2-chip{display:inline-flex;align-items:center;padding:6px 10px;border-radius:999px;font-size:11px;font-weight:800;background:rgba(34,197,94,.13);color:#15803d}
    .p2-banner{padding:13px 15px;border-radius:14px;background:rgba(59,130,246,.09);border:1px solid rgba(59,130,246,.16);font-size:13px;line-height:1.55}
    .p2-grid{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:10px}.p2-stat,.p2-card{border:1px solid rgba(100,116,139,.16);border-radius:16px;background:rgba(148,163,184,.035)}
    .p2-stat{padding:14px}.p2-stat strong{display:block;font-size:25px;line-height:1.05}.p2-stat span{font-size:12px;opacity:.7}
    .p2-card{padding:16px}.p2-card h3{margin:0 0 10px}.p2-card p{margin:0;line-height:1.55}
    .p2-project{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}
    .p2-project-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}.p2-mini{padding:5px 8px;border-radius:999px;background:rgba(148,163,184,.14);font-size:11px;font-weight:700}
    .p2-table-wrap{overflow:auto;border:1px solid rgba(100,116,139,.16);border-radius:16px}.p2-table{width:100%;border-collapse:collapse;min-width:680px}.p2-table th,.p2-table td{padding:11px 10px;text-align:start;border-bottom:1px solid rgba(100,116,139,.12)}.p2-table th{font-size:12px;opacity:.7}
    .p2-person strong{display:block}.p2-person small{opacity:.62}.p2-muted{opacity:.65}.p2-section-title{margin:0 0 10px}.p2-live-grid{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:10px}
    .p2-live{padding:13px;border-radius:14px;border:1px dashed rgba(100,116,139,.28)}.p2-live strong{display:block;font-size:22px}.p2-live small{opacity:.65}
    @media(max-width:900px){.p2-grid,.p2-live-grid{grid-template-columns:1fr 1fr}}
    @media(max-width:560px){.p2-grid,.p2-live-grid{grid-template-columns:1fr}}
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
  button.dataset.page = "projects-teams-v2";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    openPage();
  });
  const employeesButton = document.getElementById("nav-employees-readonly");
  mainNav.insertBefore(button, employeesButton || mainNav.querySelector('[data-page="settings"]') || null);
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
  dashboard.appendChild(page);
  return page;
}

function statsCards(entries) {
  return `<div class="p2-grid">${entries.map(([value, label]) => `<div class="p2-stat"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`).join("")}</div>`;
}

function livePlaceholder() {
  const values = [
    t("التذاكر المفتوحة", "Open tickets"),
    t("الطوارئ", "Emergency"),
    t("المحلولة اليوم", "Resolved today"),
    t("المتأخرة", "Overdue"),
  ];
  return `<div class="p2-card"><h3 class="p2-section-title">${esc(t("التشغيل المباشر", "Live operations"))}</h3>
    <div class="p2-live-grid">${values.map((label) => `<div class="p2-live"><strong>—</strong><small>${esc(label)}</small></div>`).join("")}</div>
    <p class="p2-muted" style="margin-top:10px">${esc(t("سيتم تحديث هذه البطاقات من بيانات التشغيل الحية عند توفرها.", "These cards update from live operational data when available."))}</p></div>`;
}

function peopleTable(rows) {
  const headers = isArabic() ? ["الموظف", "CCMS", "الدور", "المشرف", "الحالة"] : ["Employee", "CCMS", "Role", "Supervisor", "Status"];
  return `<div class="p2-table-wrap"><table class="p2-table"><thead><tr>${headers.map((label) => `<th>${esc(label)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => {
    const supervisor = row.supervisorCcmsId
      ? CURRENT_EMPLOYEE_IDENTITY_SEED.find((candidate) => candidate.ccmsId === row.supervisorCcmsId)
      : null;
    return `<tr data-phase2-ccms="${esc(row.ccmsId)}"><td class="p2-person"><strong>${esc(row.fullName)}</strong><small>${esc(row.employeeUid)}</small></td><td>${esc(row.ccmsId)}</td><td>${esc(roleLabel(row.roleKey))}</td><td>${esc(supervisor ? `${supervisor.fullName} (${supervisor.ccmsId})` : "—")}</td><td>${esc(row.accountStatus || "active")}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function renderCeo() {
  const hierarchy = projectHierarchy();
  const rows = projectRows();
  return `
    <div class="p2-head"><div><h2>${esc(t("المشاريع والفرق", "Projects & Teams"))}</h2><p class="subtitle">${esc(t("نظرة تنفيذية على مشاريع TeleSyriana وهيكل الموظفين.", "Executive view of TeleSyriana projects and employee structure."))}</p></div><span class="p2-chip">${esc(t("إدارة", "Management"))}</span></div>
    ${statsCards([["1", t("المشاريع النشطة", "Active projects")], [String(rows.length), t("موظفو iPro", "iPro employees")], [String(hierarchy.totals.supervisors), t("المشرفون", "Supervisors")], [String(hierarchy.totals.agents), t("الموظفون", "Agents")]])}
    <div class="p2-card p2-project"><div><h3>${esc(DEFAULT_PROJECT.name)}</h3><p>${esc(t("المشروع الافتراضي الحالي لخدمة العملاء والتذاكر.", "Current default project for customer support and ticket operations."))}</p><div class="p2-project-meta"><span class="p2-mini">ACM ${hierarchy.totals.acms}</span><span class="p2-mini">HR ${hierarchy.totals.hrs}</span><span class="p2-mini">${esc(t("مشرف", "Supervisor"))} ${hierarchy.totals.supervisors}</span><span class="p2-mini">${esc(t("موظف", "Agent"))} ${hierarchy.totals.agents}</span></div></div><span class="p2-chip">${esc(t("نشط", "Active"))}</span></div>
    <div class="p2-card"><h3>${esc(t("هيكل iPro", "iPro structure"))}</h3>${peopleTable(rows)}</div>`;
}

function renderAcm(actor) {
  const hierarchy = projectHierarchy();
  const rows = projectRows();
  return `
    <div class="p2-head"><div><h2>${esc(`${DEFAULT_PROJECT.name} ${t("— لوحة المشروع", "— Project Dashboard")}`)}</h2><p class="subtitle">${esc(`${actor.fullName} · ${actor.ccmsId}`)}</p></div><span class="p2-chip">ACM</span></div>
    ${statsCards([[String(rows.length), t("الموظفون", "Employees")], [String(hierarchy.totals.supervisors), t("المشرفون", "Supervisors")], [String(hierarchy.totals.agents), t("الموظفون", "Agents")], [String(hierarchy.totals.hrs), "HR"]])}
    ${livePlaceholder()}
    <div class="p2-card"><h3>${esc(t("فريق المشروع", "Project team"))}</h3>${peopleTable(rows)}</div>`;
}

function renderHr(actor) {
  const hierarchy = projectHierarchy();
  const rows = projectRows();
  return `
    <div class="p2-head"><div><h2>${esc(t("فريق المشروع", "Project People"))}</h2><p class="subtitle">${esc(`${actor.fullName} · ${actor.ccmsId} · ${DEFAULT_PROJECT.name}`)}</p></div><span class="p2-chip">HR</span></div>
    ${statsCards([[String(rows.length), t("الموظفون", "Employees")], [String(hierarchy.totals.acms), "ACM"], [String(hierarchy.totals.supervisors), t("المشرفون", "Supervisors")], [String(hierarchy.totals.agents), t("الموظفون", "Agents")]])}
    <div class="p2-card"><h3>${esc(t("دليل iPro", "iPro directory"))}</h3>${peopleTable(rows)}</div>`;
}

function render(actor = actorIdentity()) {
  const page = ensurePage();
  if (!page || !actor || !canOpen(actor)) return;
  const role = canonicalRole(actor.roleKey);
  if (role === "ceo") page.innerHTML = `<div class="card p2-shell">${renderCeo()}</div>`;
  else if (role === "acm") page.innerHTML = `<div class="card p2-shell">${renderAcm(actor)}</div>`;
  else page.innerHTML = `<div class="card p2-shell">${renderHr(actor)}</div>`;
  const nav = ensureNav();
  if (nav) nav.textContent = navLabel(actor);
}

function openPage() {
  const actor = actorIdentity();
  if (!canOpen(actor)) return;
  ensurePage();
  document.querySelectorAll(".page-section").forEach((section) => section.classList.add("hidden"));
  document.getElementById(PAGE_ID)?.classList.remove("hidden");
  document.querySelectorAll(".nav-link[data-page]").forEach((button) => button.classList.toggle("active", button.id === NAV_ID));
  render(actor);
}

function syncVisibility() {
  const actor = actorIdentity();
  const allowed = canOpen(actor);
  const nav = ensureNav();
  ensurePage();
  if (nav) {
    nav.textContent = allowed ? navLabel(actor) : "";
    nav.classList.toggle("hidden", !allowed);
  }
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
  window.addEventListener("telesyriana:language-changed", syncVisibility);
  window.addEventListener("storage", (event) => { if (event.key === USER_KEY) syncVisibility(); });

  const dashboard = document.getElementById("dashboard-screen");
  if (dashboard) {
    new MutationObserver(syncVisibility).observe(dashboard, { attributes: true, attributeFilter: ["class"] });
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
