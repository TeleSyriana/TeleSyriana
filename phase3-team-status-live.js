// phase3-team-status-live.js — Phase 3 live team status + attendance surface
//
// Reads the existing agentDays collection only while Projects & Teams is visible.
// The legacy Home supervisor listener is stopped by app-core.js when leaving Home,
// so this listener replaces it on this page rather than running in parallel.
// No writes and no schema migration.

import { db, fs } from "./firebase.js";
import { CURRENT_EMPLOYEE_IDENTITY_SEED, seedIdentityByCcms } from "./employee-identity-seed.js";
import { buildLiveTeamProjection, operationalTeamForActor, projectDayKey } from "./team-live-projection.js";

const { collection, query, where, onSnapshot } = fs;
const USER_KEY = "telesyrianaUser";
const PAGE_ID = "page-projects-teams-v2";
const CARD_ID = "phase3-live-team-card";
const MANAGEMENT_ROLES = new Set(["ceo", "acm", "supervisor", "hr"]);
let teamUnsub = null;
let latestRows = [];
let latestDay = "";
let activeActorId = "";
let listenerToken = "";

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

function readSession() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }
  catch { return null; }
}

function actorIdentity() {
  const session = readSession();
  const id = clean(session?.ccmsId || session?.id);
  if (!id) return null;
  return seedIdentityByCcms(id) || null;
}

function role(actor) {
  return clean(actor?.roleKey).toLowerCase();
}

function projectPageVisible() {
  const page = document.getElementById(PAGE_ID);
  return Boolean(page && !page.classList.contains("hidden"));
}

function canUseLiveTeam(actor = actorIdentity()) {
  return Boolean(actor?.ccmsId && MANAGEMENT_ROLES.has(role(actor)));
}

function projectTimeZone(actor) {
  const team = operationalTeamForActor(actor, CURRENT_EMPLOYEE_IDENTITY_SEED, "ipro");
  const counts = new Map();
  for (const member of team) {
    const zone = clean(member.timezone);
    if (zone) counts.set(zone, (counts.get(zone) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Asia/Damascus";
}

function stopListener() {
  if (teamUnsub) {
    try { teamUnsub(); } catch {}
  }
  teamUnsub = null;
  listenerToken = "";
}

function statusLabel(status) {
  const labels = isArabic()
    ? { operating: "قيد التشغيل", break: "استراحة", meeting: "اجتماع", handling: "متابعة", unavailable: "غير متاح" }
    : { operating: "Operating", break: "Break", meeting: "Meeting", handling: "Handling", unavailable: "Unavailable" };
  return labels[status] || status;
}

function formatTime(ms, timeZone) {
  const value = Number(ms || 0);
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat(isArabic() ? "ar-SY" : "en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
}

function statusPill(status, stale = false) {
  return `<span class="p3-status ${esc(status)}${stale ? " stale" : ""}">${esc(statusLabel(status))}${stale ? ` · ${esc(t("قديم", "stale"))}` : ""}</span>`;
}

function injectStyles() {
  if (document.getElementById("phase3-live-team-styles")) return;
  const style = document.createElement("style");
  style.id = "phase3-live-team-styles";
  style.textContent = `
    #${CARD_ID}{display:grid;gap:13px}
    .p3-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}.p3-head h3{margin:0 0 4px}.p3-head p{margin:0;opacity:.66;font-size:12px}
    .p3-status-grid{display:grid;grid-template-columns:repeat(5,minmax(105px,1fr));gap:9px}.p3-attendance-grid{display:grid;grid-template-columns:repeat(4,minmax(110px,1fr));gap:9px}
    .p3-metric{padding:12px;border:1px solid rgba(100,116,139,.16);border-radius:13px;background:rgba(148,163,184,.035)}.p3-metric strong{display:block;font-size:22px;line-height:1.1}.p3-metric span{font-size:11px;opacity:.68}
    .p3-members{display:grid;gap:7px}.p3-member{display:grid;grid-template-columns:minmax(150px,1fr) 130px 110px 120px;gap:10px;align-items:center;padding:10px 11px;border:1px solid rgba(100,116,139,.13);border-radius:12px}.p3-member strong{display:block}.p3-member small{opacity:.62}
    .p3-status{display:inline-flex;justify-content:center;padding:5px 8px;border-radius:999px;font-size:11px;font-weight:800;background:rgba(148,163,184,.16)}.p3-status.operating{background:rgba(34,197,94,.13);color:#15803d}.p3-status.break{background:rgba(245,158,11,.14);color:#a16207}.p3-status.meeting,.p3-status.handling{background:rgba(59,130,246,.12);color:#1d4ed8}.p3-status.unavailable{background:rgba(100,116,139,.14)}.p3-status.stale{outline:1px dashed rgba(245,158,11,.65)}
    .p3-note{padding:10px 12px;border-radius:12px;background:rgba(59,130,246,.07);font-size:12px;line-height:1.55}.p3-error{background:rgba(239,68,68,.08)}
    @media(max-width:900px){.p3-status-grid{grid-template-columns:1fr 1fr 1fr}.p3-attendance-grid{grid-template-columns:1fr 1fr}.p3-member{grid-template-columns:1fr 110px}.p3-member .p3-secondary{display:none}}
    @media(max-width:560px){.p3-status-grid{grid-template-columns:1fr 1fr}.p3-attendance-grid{grid-template-columns:1fr 1fr}}
  `;
  document.head.appendChild(style);
}

function ensureCard() {
  const page = document.getElementById(PAGE_ID);
  const shell = page?.querySelector(".p2-shell");
  if (!shell) return null;
  let card = document.getElementById(CARD_ID);
  if (card && card.closest(`#${PAGE_ID}`)) return card;
  card = document.createElement("section");
  card.id = CARD_ID;
  card.className = "p2-card";
  const firstStats = shell.querySelector(".p2-grid");
  if (firstStats) firstStats.insertAdjacentElement("afterend", card);
  else shell.prepend(card);
  return card;
}

function metric(value, label) {
  return `<div class="p3-metric"><strong>${value === null ? "—" : esc(value)}</strong><span>${esc(label)}</span></div>`;
}

function renderWaiting(message = "") {
  const card = ensureCard();
  if (!card) return;
  card.innerHTML = `<div class="p3-head"><div><h3>${esc(t("حالة الفريق والحضور", "Live Team Status & Attendance"))}</h3><p>${esc(t("بيانات اليوم المباشرة", "Today's operational data"))}</p></div></div><div class="p3-note">${esc(message || t("جاري تحميل حالة الفريق…", "Loading team status…"))}</div>`;
}

function updateSupervisorMemberChips(projection) {
  const page = document.getElementById(PAGE_ID);
  if (!page) return;
  projection.members.forEach((member) => {
    const row = page.querySelector(`.p2-team-member[data-phase2-ccms="${CSS.escape(member.ccmsId)}"]`);
    const chip = row?.querySelector(".p2-chip");
    if (!chip) return;
    chip.textContent = member.signedIn ? statusLabel(member.status) : t("لم يسجل", "Not signed in");
    chip.title = member.stale ? t("لم يصل تحديث حديث لحالة هذا الموظف.", "This employee has no recent status update.") : "";
  });
}

function renderProjection(projection) {
  const card = ensureCard();
  if (!card) return;
  const attendanceReady = projection.attendance.coverage > 0;
  const roleKey = role(actorIdentity());
  const members = projection.members.map((member) => `
    <div class="p3-member" data-p3-member="${esc(member.ccmsId)}">
      <div><strong>${esc(member.fullName)}</strong><small>${esc(member.ccmsId)}</small></div>
      <div>${member.signedIn ? statusPill(member.status, member.stale) : `<span class="p3-status unavailable">${esc(t("لم يسجل", "Not signed in"))}</span>`}</div>
      <div class="p3-secondary"><small>${esc(t("دخول", "Login"))}</small><div>${esc(formatTime(member.loginTimeMs, projection.timeZone))}</div></div>
      <div class="p3-secondary"><small>${esc(t("الحضور", "Attendance"))}</small><div>${member.attendanceKnown ? esc(member.absent ? t("غائب", "Absent") : member.late ? t("متأخر", "Late") : t("مسجل", "Recorded")) : "—"}</div></div>
    </div>`).join("");

  card.innerHTML = `
    <div class="p3-head"><div><h3>${esc(t("حالة الفريق والحضور", "Live Team Status & Attendance"))}</h3><p>${esc(`${projection.day} · ${projection.timeZone}`)}</p></div><span class="p2-chip">${esc(t("مباشر", "Live"))}</span></div>
    <div class="p3-status-grid">
      ${metric(projection.status.operating, t("قيد التشغيل", "Operating"))}
      ${metric(projection.status.break, t("استراحة", "Break"))}
      ${metric(projection.status.meeting, t("اجتماع", "Meeting"))}
      ${metric(projection.status.handling, t("متابعة", "Handling"))}
      ${metric(projection.status.unavailable, t("غير متاح", "Unavailable"))}
    </div>
    <div class="p3-attendance-grid">
      ${metric(projection.signedIn, t("سجلوا اليوم", "Signed in today"))}
      ${metric(projection.notSignedIn, t("لم يسجلوا", "Not signed in"))}
      ${metric(attendanceReady ? projection.attendance.late : null, t("متأخر", "Late"))}
      ${metric(attendanceReady ? projection.attendance.absent : null, t("غائب", "Absent"))}
    </div>
    <div class="p3-members">${members || `<div class="p3-note">${esc(t("لا يوجد موظفون ضمن هذا الفريق.", "No Agents are assigned to this team."))}</div>`}</div>
    <div class="p3-note">${esc(attendanceReady
      ? t("Late و Absent يعتمدان على سجلات الحضور الموجودة لهذا اليوم.", "Late and Absent use the attendance records available for today.")
      : t("لن نخمن التأخير أو الغياب. ستظهر أرقام Late و Absent عند توفر حالة حضور أو جدول مناوبة صريح في البيانات.", "Late and Absent are not guessed. Those figures will appear when an explicit attendance status or shift schedule is available in the data."))}</div>`;

  if (roleKey === "supervisor") updateSupervisorMemberChips(projection);
}

function renderLatest() {
  if (!projectPageVisible()) return;
  const actor = actorIdentity();
  if (!canUseLiveTeam(actor)) return;
  try {
    const zone = projectTimeZone(actor);
    const projection = buildLiveTeamProjection(actor, {
      employees: CURRENT_EMPLOYEE_IDENTITY_SEED,
      dayRows: latestRows,
      projectId: "ipro",
      timeZone: zone,
      now: new Date(),
    });
    renderProjection(projection);
  } catch (error) {
    const card = ensureCard();
    if (card) card.innerHTML = `<div class="p3-note p3-error">${esc(String(error?.message || error))}</div>`;
  }
}

function startListener() {
  const actor = actorIdentity();
  if (!projectPageVisible() || !canUseLiveTeam(actor)) {
    stopListener();
    return;
  }
  const zone = projectTimeZone(actor);
  const day = projectDayKey(zone, new Date());
  const token = `${actor.ccmsId}|${day}|${zone}`;
  if (teamUnsub && listenerToken === token) {
    renderLatest();
    return;
  }

  stopListener();
  latestRows = [];
  latestDay = day;
  activeActorId = actor.ccmsId;
  listenerToken = token;
  renderWaiting(t("جاري تحميل حالة الفريق لهذا اليوم…", "Loading today's team status…"));

  const source = query(collection(db, "agentDays"), where("day", "==", day));
  teamUnsub = onSnapshot(source, (snapshot) => {
    if (activeActorId !== actor.ccmsId || latestDay !== day) return;
    latestRows = [];
    snapshot.forEach((docSnap) => latestRows.push({ id: docSnap.id, ...docSnap.data() }));
    renderLatest();
  }, (error) => {
    const card = ensureCard();
    if (card) card.innerHTML = `<div class="p3-head"><div><h3>${esc(t("حالة الفريق والحضور", "Live Team Status & Attendance"))}</h3></div></div><div class="p3-note p3-error">${esc(t("تعذر تحميل بيانات الفريق الحالية. بيانات المشاريع والتذاكر الأخرى ما زالت تعمل بشكل مستقل.", "Could not load current team status. Projects and Ticket data continue to work independently."))}</div>`;
    console.warn("Phase 3 team status listener failed", error);
  });
}

function syncLifecycle() {
  if (projectPageVisible()) startListener();
  else stopListener();
}

function boot() {
  injectStyles();
  document.addEventListener("click", (event) => {
    const nav = event.target?.closest?.(".nav-link[data-page]");
    if (!nav) return;
    if (nav.dataset.page === "projects-teams-v2") setTimeout(startListener, 0);
    else stopListener();
  });
  window.addEventListener("telesyriana:user-changed", () => {
    stopListener();
    setTimeout(syncLifecycle, 0);
  });
  window.addEventListener("telesyriana:language-changed", () => setTimeout(renderLatest, 0));
  window.addEventListener("beforeunload", stopListener);
  setTimeout(syncLifecycle, 0);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
