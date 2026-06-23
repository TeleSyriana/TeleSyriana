// tickets.js — TeleSyriana Phase 3 Ticket System
// Firestore collection: tickets
// Small, support-focused workflow: emergency queue, order issues, returns, escalations.

import { db, fs } from "./firebase.js";

const {
  collection,
  addDoc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  doc,
  updateDoc,
  deleteDoc,
  setDoc,
  getDoc,
} = fs;

const USER_KEY = "telesyrianaUser";
const TICKETS_COL = "tickets";
const DELETED_TICKETS_COL = "deletedTickets";
const ORDER_RECORDS_COL = "orderRecords";

const ROLE_LEVELS = { agent: 1, supervisor: 2, hr: 3, manager: 3, admin: 4 };
const STAFF = {
  "0001": { id: "0001", name: "Owner Jack Smith", role: "admin" },
  "1001": { id: "1001", name: "Manager Mohammad Safar", role: "manager" },
  "2001": { id: "2001", name: "Supervisor Dema Shabar", role: "supervisor" },
  "3001": { id: "3001", name: "HR Fatima Kaka", role: "hr" },
  "9001": { id: "9001", name: "Agent Raghad Moussa", role: "agent", supervisorId: "2001" },
  "9002": { id: "9002", name: "Agent Qamar Moussa", role: "agent", supervisorId: "2001" },
  "9003": { id: "9003", name: "Agent Reema Obaid", role: "agent", supervisorId: "2001" },
};

const EMERGENCY_TYPES = new Set([
  "address_change",
  "product_not_arrived",
  "item_not_genuine",
  "angry_customer",
  "refund_request",
  "chargeback_risk",
]);

const TYPE_LABELS = {
  address_change: { ar: "تعديل العنوان", en: "Address Change" },
  product_not_arrived: { ar: "المنتج لم يصل", en: "Product Not Arrived" },
  item_not_genuine: { ar: "ادعاء المنتج غير أصلي / مزيف", en: "Item Not Genuine / Fake Claim" },
  return: { ar: "إرجاع", en: "Return" },
  exchange: { ar: "استبدال", en: "Exchange" },
  angry_customer: { ar: "عميل غاضب", en: "Angry Customer" },
  refund_request: { ar: "طلب استرداد", en: "Refund Request" },
  chargeback_risk: { ar: "خطر نزاع بنكي", en: "Chargeback Risk" },
  general_question: { ar: "سؤال عام", en: "General Question" },
};

const STATUS_LABELS = {
  open: { ar: "مفتوحة", en: "Open" },
  waiting_customer: { ar: "بانتظار العميل", en: "Waiting customer" },
  waiting_courier: { ar: "بانتظار الشحن", en: "Waiting courier" },
  waiting_supplier: { ar: "بانتظار المورد", en: "Waiting supplier" },
  escalated: { ar: "مصعّدة", en: "Escalated" },
  resolved: { ar: "محلولة", en: "Resolved" },
  closed: { ar: "مغلقة", en: "Closed" },
};

const PRIORITY_LABELS = {
  emergency: { ar: "طارئ", en: "Emergency" },
  high: { ar: "عالي", en: "High" },
  medium: { ar: "متوسط", en: "Medium" },
  normal: { ar: "عادي", en: "Normal" },
};

let currentUser = null;
let allTickets = [];
let deletedTickets = [];
let selectedTicketId = null;
let unsubTickets = null;
let unsubDeletedTickets = null;
let isHooked = false;
let currentLiveOrder = null;
let currentLiveOrderFirebaseStatus = "none";
let editingTicketCommentId = null;
let ticketOpenProgressToken = 0;
let ticketOpenProgressHideTimer = null;
let ticketScopeMaps = new Map();
let ticketTeamSearchMap = new Map();
let ticketsInitialLoading = false;
let ticketsLoadingMessage = "";
let ticketsLoadingSlow = false;
let ticketLoadSlowTimer = null;
let teamSearchTimer = null;
let teamSearchToken = 0;
let teamSearchLoading = false;
let teamSearchLastTerm = "";
let teamSearchIndexLoaded = false;
let teamSearchIndexLoading = false;
let teamSearchIndexPromise = null;
let teamSearchIndexLoadedAt = 0;

const SHOPIFY_BACKEND_URL = "https://telesyriana-backend.onrender.com";
const SHOPIFY_API_KEY_STORAGE = "telesyrianaShopifyBackendApiKey";
// Staff should not handle backend API keys. This is obfuscated only to reduce UI confusion; real security still belongs on the backend/auth layer.
const SHOPIFY_BACKEND_KEY_MASK = 37;
const SHOPIFY_BACKEND_KEY_OBFUSCATED = [100,68,21,28,16,20,17,23,22,22,23,17,20,16,4];

function defaultShopifyApiKey() {
  try { return SHOPIFY_BACKEND_KEY_OBFUSCATED.map(n => String.fromCharCode(n ^ SHOPIFY_BACKEND_KEY_MASK)).join(""); } catch { return ""; }
}

function el(id) { return document.getElementById(id); }
function ticketLang() { return ((document.body?.dataset?.language || document.documentElement.lang || 'ar') === 'en') ? 'en' : 'ar'; }
function tt(ar, en) { return ticketLang() === 'ar' ? ar : en; }

function emitTicketLoadEvent(name, detail = {}) {
  try { window.dispatchEvent(new CustomEvent(`telesyriana:tickets-${name}`, { detail })); } catch {}
}

function ticketLoadMessage(ar, en) { return tt(ar, en); }

function labelOf(map, key, fallback = '') { const item = map[key]; if (!item) return fallback || key || ''; return item[ticketLang()] || item.en || fallback || key || ''; }
function typeLabel(key) { return labelOf(TYPE_LABELS, key, key || 'Ticket'); }
function statusLabelText(key) { return labelOf(STATUS_LABELS, key, key || 'Open'); }
function priorityLabelText(key) { return labelOf(PRIORITY_LABELS, key, key || 'Normal'); }
function translateTicketsStatic() {
  const statSpans = Array.from(document.querySelectorAll('#page-tickets .ticket-stat span'));
  if (statSpans[0]) statSpans[0].textContent = tt('مفتوحة', 'Open');
  if (statSpans[1]) statSpans[1].textContent = tt('طارئ', 'Emergency');
  if (statSpans[2]) statSpans[2].textContent = tt('مصعّدة', 'Escalated');
  if (statSpans[3]) statSpans[3].textContent = tt('محلولة اليوم', 'Resolved today');
  if (el("ticket-deleted-toggle")) el("ticket-deleted-toggle").textContent = deletedFolderLabel();
  if (el("ticket-delete-btn")) el("ticket-delete-btn").textContent = tt("حذف", "Delete");
  if (el("deleted-tickets-close")) el("deleted-tickets-close").textContent = tt("إغلاق", "Close");
  if (el("deleted-tickets-title")) el("deleted-tickets-title").textContent = deletedFolderLabel();
}
function roleLevel(u) { return ROLE_LEVELS[String(u?.role || "").toLowerCase()] || 0; }
function canSeeAll(u) { return roleLevel(u) >= ROLE_LEVELS.manager; }
function canSupervise(u) { return roleLevel(u) >= ROLE_LEVELS.supervisor; }
function canEditAll(u) { return roleLevel(u) >= ROLE_LEVELS.supervisor; }
function canAccessDeletedTickets(u) {
  const role = String(u?.role || "").toLowerCase();
  return ["supervisor", "manager", "admin"].includes(role);
}
function canSoftDeleteTicket(ticket) {
  if (!currentUser || !ticket) return false;
  return canAccessDeletedTickets(currentUser) || ticket.createdBy === currentUser.id;
}
function deletedFolderLabel() { return tt("المحذوفات", "Deleted tickets"); }


function getCurrentUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    return u?.id ? u : null;
  } catch { return null; }
}

function tsToMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v === "number") return v;
  if (typeof v === "string") return Date.parse(v) || 0;
  return 0;
}

function fmtDate(v) {
  const ms = tsToMs(v);
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

function fmtPurchaseDate(v) {
  return fmtDate(v);
}

function purchaseDateLabel() {
  return tt("تاريخ الشراء", "Purchase date");
}

function purchaseAgeLabel() {
  return tt("عمر الطلب", "Order age");
}

function fmtPurchaseAge(v) {
  const ms = tsToMs(v);
  if (!ms) return "—";
  const now = Date.now();
  const diffMs = Math.max(0, now - ms);
  const days = Math.floor(diffMs / 86400000);

  if (days < 1) return tt("تم الشراء اليوم", "Bought today");
  if (days === 1) return tt("تم الشراء منذ يوم واحد", "Bought 1 day ago");
  if (days < 90) return tt(`تم الشراء منذ ${days} يوم`, `Bought ${days} days ago`);

  const months = Math.floor(days / 30);
  if (months < 12) return tt(`تم الشراء منذ أكثر من ${months} أشهر`, `Bought ${months}+ months ago`);

  const years = Math.floor(days / 365);
  return tt(`تم الشراء منذ أكثر من ${years} سنة`, `Bought ${years}+ years ago`);
}

const ACTIVE_DISPUTE_STATUSES = new Set(["needs_response", "under_review", "open", "submitted", "accepted", "active", "pending", "requires_response"]);
const WON_DISPUTE_STATUSES = new Set(["won", "prevented", "resolved_won"]);
const LOST_DISPUTE_STATUSES = new Set(["lost", "resolved_lost"]);

function disputeLabel() { return tt("النزاع البنكي", "Chargeback"); }
function disputeStatusLabel(status) {
  const s = normalizeDisputeStatus(status);
  const ar = {
    needs_response: "يحتاج رد",
    requires_response: "يحتاج رد",
    under_review: "قيد المراجعة",
    open: "مفتوح",
    submitted: "تم الإرسال",
    accepted: "نشط",
    active: "نشط",
    pending: "قيد المتابعة",
    won: "ربحنا النزاع",
    resolved_won: "ربحنا النزاع",
    lost: "خسرنا النزاع",
    resolved_lost: "خسرنا النزاع",
    prevented: "تم منعه",
    detected: "تم رصد نزاع بنكي",
    risk_detected: "تم رصد خطر نزاع بنكي",
  };
  const en = {
    needs_response: "Needs response",
    requires_response: "Needs response",
    under_review: "Under review",
    open: "Open",
    submitted: "Submitted",
    accepted: "Active",
    active: "Active",
    pending: "Pending",
    won: "Won",
    resolved_won: "Won",
    lost: "Lost",
    resolved_lost: "Lost",
    prevented: "Prevented",
    detected: "Chargeback detected",
    risk_detected: "Chargeback risk detected",
  };
  return (ticketLang() === "ar" ? ar[s] : en[s]) || (status || "—");
}
function normalizeDisputeStatus(status) {
  const raw = String(status || "").trim();
  if (!raw || raw === "—" || raw === "-") return "";
  const rawLower = raw.toLowerCase();
  if (rawLower.includes("تم رصد نزاع") || rawLower.includes("نزاع بنكي مرصود") || rawLower.includes("chargeback detected") || rawLower.includes("dispute detected")) return "detected";
  if (rawLower.includes("خطر نزاع") || rawLower.includes("chargeback risk") || rawLower.includes("dispute risk")) return "risk_detected";
  if (rawLower.includes("قيد المراجعة") || rawLower.includes("under review")) return "under_review";
  if (rawLower.includes("ربحنا") || rawLower.includes("won")) return "won";
  if (rawLower.includes("خسرنا") || rawLower.includes("lost")) return "lost";
  const snake = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const aliases = {
    needs_response: "needs_response",
    needs_respond: "needs_response",
    need_response: "needs_response",
    require_response: "requires_response",
    requires_response: "requires_response",
    under_review: "under_review",
    in_review: "under_review",
    review: "under_review",
    accepted: "accepted",
    active: "active",
    pending: "pending",
    open: "open",
    submitted: "submitted",
    won: "won",
    win: "won",
    lost: "lost",
    lose: "lost",
    prevented: "prevented",
    detected: "detected",
    risk_detected: "risk_detected",
  };
  return aliases[snake] || snake;
}
function sourceHasChargebackRisk(source) {
  if (!source) return false;
  const fields = [source.risk, source.customerMood, source.type, source.title, source.subject, source.chargebackStatus, source.disputeStatus]
    .map((v) => String(v || "").toLowerCase());
  return fields.some((v) =>
    v === "chargeback" ||
    v === "chargeback_risk" ||
    v.includes("chargeback") ||
    v.includes("dispute") ||
    v.includes("نزاع بنكي") ||
    v.includes("خطر نزاع")
  );
}
function normalizeDispute(raw) {
  if (!raw || typeof raw !== "object") return null;
  const statusSource = raw.status || raw.dispute_status || raw.disputeStatus || raw.outcome || raw.state || raw.current_status || raw.currentStatus;
  let status = normalizeDisputeStatus(statusSource);
  const activeFlag = raw.active === true || raw.is_active === true || raw.isActive === true || raw.found === true || raw.dispute_found === true || raw.disputeFound === true;
  if (!status && activeFlag) status = "active";
  const type = String(raw.type || raw.disputeType || raw.kind || raw.category || "chargeback").toLowerCase();
  const amount = raw.amount || raw.amount_money?.amount || raw.amountMoney?.amount || raw.total || raw.disputed_amount || raw.disputedAmount || "";
  const currency = raw.currency || raw.amount_money?.currency || raw.amountMoney?.currency || raw.disputed_currency || raw.disputedCurrency || "";
  return {
    id: raw.id || raw.dispute_id || raw.disputeId || "",
    type,
    status,
    activeFlag,
    reason: raw.reason || raw.network_reason_code || raw.networkReasonCode || raw.dispute_reason || raw.disputeReason || "",
    amount: amount ? `${amount} ${currency}`.trim() : "",
    evidenceDueBy: raw.evidence_due_by || raw.evidenceDueBy || raw.evidence_deadline || raw.evidenceDeadline || "",
    evidenceSentOn: raw.evidence_sent_on || raw.evidenceSentOn || "",
    finalizedOn: raw.finalized_on || raw.finalizedOn || "",
    initiatedAt: raw.initiated_at || raw.initiatedAt || raw.created_at || raw.createdAt || "",
  };
}
function collectDisputes(source) {
  if (!source) return [];
  const raw = source.rawShopify || source.raw || source;
  const orderData = source.orderData || raw.orderData || {};
  const candidates = [];
  [
    source.disputes, source.chargebacks,
    orderData.disputes, orderData.chargebacks,
    raw.disputes, raw.chargebacks,
    raw.order?.disputes, raw.order?.chargebacks,
    raw.chargeback?.disputes, raw.chargeback?.chargebacks,
    raw.disputeSummary?.disputes, raw.orderDisputeSummary?.disputes,
  ].forEach((arr) => {
    if (Array.isArray(arr)) candidates.push(...arr);
  });
  [
    source.dispute, source.chargeback, source.disputeSummary, source.orderDisputeSummary,
    orderData.dispute, orderData.chargeback, orderData.disputeSummary, orderData.orderDisputeSummary,
    raw.dispute, raw.chargeback, raw.disputeSummary, raw.orderDisputeSummary, raw.order?.disputeSummary,
    raw.chargeback?.top, raw.chargeback?.topDispute, raw.disputeSummary?.top, raw.orderDisputeSummary?.top,
  ].forEach((one) => {
    if (one && typeof one === "object") candidates.push(one);
  });
  const status = source.chargebackStatus || source.disputeStatus || orderData.chargebackStatus || orderData.disputeStatus || raw.chargeback_status || raw.dispute_status || raw.chargebackStatus || raw.disputeStatus;
  if (status) {
    candidates.push({
      status,
      type: source.chargebackType || orderData.chargebackType || raw.chargeback_type || raw.chargebackType || "chargeback",
      reason: source.chargebackReason || orderData.chargebackReason || raw.chargeback_reason || raw.chargebackReason || "",
      active: source.chargebackActive || orderData.chargebackActive || raw.chargebackActive,
    });
  }
  return candidates.map(normalizeDispute).filter(Boolean);
}
function disputeRank(d) {
  const s = normalizeDisputeStatus(d?.status);
  if (ACTIVE_DISPUTE_STATUSES.has(s) || d?.activeFlag) return 4;
  if (LOST_DISPUTE_STATUSES.has(s)) return 3;
  if (WON_DISPUTE_STATUSES.has(s)) return 2;
  return 1;
}
function chargebackSummary(source) {
  const riskFlag = sourceHasChargebackRisk(source);
  const disputes = collectDisputes(source);
  if (!disputes.length && !riskFlag) return { has: false, riskOnly: false, active: false, alert: false, cls: "none", status: "", label: tt("لا يوجد", "None"), disputes: [] };
  const sorted = disputes.slice().sort((a, b) => disputeRank(b) - disputeRank(a));
  const top = sorted[0] || (riskFlag ? { status: "detected", type: "chargeback", activeFlag: true } : null);
  const status = normalizeDisputeStatus(top?.status || (riskFlag ? "detected" : ""));
  const active = ACTIVE_DISPUTE_STATUSES.has(status) || top?.activeFlag === true || (riskFlag && !WON_DISPUTE_STATUSES.has(status));
  const won = WON_DISPUTE_STATUSES.has(status);
  const lost = LOST_DISPUTE_STATUSES.has(status);
  const riskOnly = riskFlag && !disputes.length;
  const alert = active || lost || riskOnly || status === "detected";
  const cls = lost ? "lost" : active || riskOnly || status === "detected" ? "active" : won ? "won" : "info";
  const label = riskOnly ? tt("تم رصد خطر نزاع بنكي", "Chargeback risk detected") : disputeStatusLabel(status);
  return { has: true, riskOnly, active, won, lost, alert, cls, status, label, top, disputes: sorted };
}
function ticketChargebackSource(ticket) {
  if (!ticket) return null;
  return {
    ...(ticket.orderData || {}),
    risk: ticket.risk,
    type: ticket.type,
    title: ticket.title,
    customerMood: ticket.customerMood,
    chargebackStatus: ticket.chargebackStatus || ticket.disputeStatus || ticket.orderData?.chargebackStatus || ticket.orderData?.disputeStatus,
    disputes: ticket.disputes || ticket.orderData?.disputes || [],
    chargebacks: ticket.chargebacks || ticket.orderData?.chargebacks || [],
    disputeSummary: ticket.disputeSummary || ticket.orderData?.disputeSummary,
    chargeback: ticket.chargeback || ticket.orderData?.chargeback,
    rawShopify: ticket.orderData?.rawShopify || ticket.rawShopify,
  };
}
function chargebackBadge(source, compact = false) {
  const cb = chargebackSummary(source);
  if (!cb.has) return "";
  const text = compact ? (cb.alert ? "CHARGEBACK" : cb.label) : `${disputeLabel()}: ${cb.label}`;
  return `<span class="chargeback-badge ${cb.cls}">${escapeHtml(text)}</span>`;
}
function chargebackDetailsHtml(source) {
  const cb = chargebackSummary(source);
  if (!cb.has) return `<strong>${escapeHtml(tt("لا يوجد نزاع بنكي", "No chargeback"))}</strong>`;
  if (cb.riskOnly) {
    return `<strong>${escapeHtml(tt("تم رصد خطر نزاع بنكي — لم يرجع Shopify حالة النزاع بعد.", "Chargeback risk detected — Shopify has not returned a dispute status yet."))}</strong>`;
  }
  const d = cb.top || {};
  const parts = [
    cb.label,
    d.amount,
    d.reason ? `${tt("السبب", "Reason")}: ${d.reason}` : "",
    d.evidenceDueBy ? `${tt("آخر موعد للرد", "Evidence due")}: ${fmtDate(d.evidenceDueBy)}` : "",
    d.initiatedAt ? `${tt("بدأ", "Started")}: ${fmtDate(d.initiatedAt)}` : "",
  ].filter(Boolean);
  return `<strong>${escapeHtml(parts.join(" • "))}</strong>`;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function staffName(id) {
  if (!id) return "Unassigned";
  return STAFF[id]?.name || id;
}

function visibleStaffForAssignment() {
  if (!currentUser) return [];
  if (canSeeAll(currentUser)) return Object.values(STAFF);
  if (currentUser.role === "supervisor") {
    return Object.values(STAFF).filter((s) => s.id === currentUser.id || s.supervisorId === currentUser.id);
  }
  return [currentUser];
}

function ticketSearchText(ticket) {
  const commentsText = (Array.isArray(ticket.comments) ? ticket.comments : [])
    .map((comment) => [
      comment?.text,
      commentTypeMeta(comment?.type).ar,
      commentTypeMeta(comment?.type).en,
      comment?.authorName,
      staffName(comment?.authorId),
    ].join(" "))
    .join(" ");
  return [
    ticket.orderNumber,
    ticket.customerName,
    ticket.email,
    ticket.notes,
    ticket.resolution,
    commentsText,
    typeLabel(ticket.type),
    statusLabelText(ticket.status),
    staffName(ticket.assignedTo),
  ].join(" ").toLowerCase();
}
function currentTicketSearchTerm() { return (el("ticket-search")?.value || "").trim().toLowerCase(); }
function canViewTicketBase(ticket) {
  if (!currentUser) return false;
  if (canSeeAll(currentUser)) return true;
  if (currentUser.role === "supervisor") {
    if (ticket.assignedTo === currentUser.id || ticket.createdBy === currentUser.id) return true;
    const assigned = STAFF[ticket.assignedTo];
    return assigned?.supervisorId === currentUser.id || !ticket.assignedTo;
  }
  return ticket.assignedTo === currentUser.id || ticket.createdBy === currentUser.id;
}
function canViewTicket(ticket) {
  if (canViewTicketBase(ticket)) return true;
  const q = currentTicketSearchTerm();
  // Agents keep a clean queue, but search can find an existing ticket by order/customer/email/notes.
  return Boolean(q && q.length >= 2 && ticketSearchText(ticket).includes(q));
}
function isTicketGlobalSearchActive() {
  const q = currentTicketSearchTerm();
  return Boolean(currentUser && !canSeeAll(currentUser) && q && q.length >= 2);
}
function isTicketGlobalSearchHit(ticket) {
  const q = currentTicketSearchTerm();
  return Boolean(isTicketGlobalSearchActive() && !canViewTicketBase(ticket) && ticketSearchText(ticket).includes(q));
}


function sortTicketRows(rows) {
  return rows.sort((a, b) => {
    const bm = tsToMs(b.updatedAt || b.createdAt) || Number(String(b.orderNumber || '').replace(/\D/g, '')) || 0;
    const am = tsToMs(a.updatedAt || a.createdAt) || Number(String(a.orderNumber || '').replace(/\D/g, '')) || 0;
    return bm - am;
  });
}

function mergeTicketMaps() {
  const merged = new Map();
  ticketScopeMaps.forEach((map) => map.forEach((row, id) => merged.set(id, row)));
  ticketTeamSearchMap.forEach((row, id) => merged.set(id, row));
  allTickets = sortTicketRows([...merged.values()]);
}

function ticketListenSourcesForUser(user) {
  const base = collection(db, TICKETS_COL);
  if (!user) return [];
  const role = String(user.role || '').toLowerCase();

  // Managers/admins keep the full operational queue. Agents get only their scoped tickets.
  // This is the important performance fix for staff devices.
  if (canSeeAll(user) || role === 'supervisor') return [{ key: 'team', source: base }];

  return [
    { key: 'assigned', source: query(base, where('assignedTo', '==', user.id)) },
    { key: 'created', source: query(base, where('createdBy', '==', user.id)) },
  ];
}

function setTicketsInlineLoading(active, message = '', slow = false) {
  ticketsInitialLoading = Boolean(active);
  ticketsLoadingMessage = message || '';
  ticketsLoadingSlow = Boolean(slow);
  renderTicketList();
}

function clearTicketSlowTimer() {
  if (ticketLoadSlowTimer) clearTimeout(ticketLoadSlowTimer);
  ticketLoadSlowTimer = null;
}

function clearTeamSearchResults({ keepIndex = true } = {}) {
  teamSearchLoading = false;
  teamSearchLastTerm = '';
  if (!keepIndex || !teamSearchIndexLoaded) ticketTeamSearchMap = new Map();
  mergeTicketMaps();
}

function shouldUseTeamSearchIndex() {
  return Boolean(currentUser && !canSeeAll(currentUser));
}

function queueTeamSearchIndexWarmup(delay = 1200) {
  if (!shouldUseTeamSearchIndex() || teamSearchIndexLoaded || teamSearchIndexLoading) return;
  window.setTimeout(() => {
    if (shouldUseTeamSearchIndex()) loadTeamSearchIndex({ silent: true });
  }, delay);
}

async function loadTeamSearchIndex({ silent = false } = {}) {
  if (!shouldUseTeamSearchIndex()) return;
  if (teamSearchIndexLoaded) return;
  if (teamSearchIndexPromise) return teamSearchIndexPromise;

  teamSearchIndexLoading = true;
  if (!silent) {
    teamSearchLoading = true;
    updateTicketGlobalSearchUI(allTickets.filter(canViewTicket).filter(ticketMatchesFilters));
  }

  teamSearchIndexPromise = getDocs(collection(db, TICKETS_COL))
    .then((snap) => {
      const map = new Map(ticketTeamSearchMap);
      snap.forEach((d) => {
        const row = { id: d.id, ...d.data() };
        // Keep every readable ticket in memory for search, but only reveal non-owned tickets when a search term matches.
        map.set(row.id, row);
      });
      ticketTeamSearchMap = map;
      teamSearchIndexLoaded = true;
      teamSearchIndexLoadedAt = Date.now();
      mergeTicketMaps();
    })
    .catch((err) => {
      console.error('team ticket index failed', err);
      if (!silent) showTicketAlert(tt('تعذر تحميل فهرس بحث الفريق. البحث في تذاكر الآخرين قد يكون محدوداً.', 'Could not load the team search index. Searching other people’s tickets may be limited.'), true);
    })
    .finally(() => {
      teamSearchIndexLoading = false;
      teamSearchIndexPromise = null;
      teamSearchLoading = false;
      renderTicketList();
      renderTicketDetail();
    });

  return teamSearchIndexPromise;
}

function scheduleTeamTicketSearch() {
  const q = currentTicketSearchTerm();
  if (!isTicketGlobalSearchActive()) {
    if (teamSearchTimer) clearTimeout(teamSearchTimer);
    teamSearchToken += 1;
    teamSearchLoading = false;
    teamSearchLastTerm = '';
    renderTicketList();
    renderTicketDetail();
    return;
  }

  if (teamSearchIndexLoaded) {
    teamSearchLastTerm = q;
    renderTicketList();
    renderTicketDetail();
    return;
  }

  if (q === teamSearchLastTerm && (teamSearchLoading || teamSearchIndexLoading)) return;
  if (teamSearchTimer) clearTimeout(teamSearchTimer);
  teamSearchTimer = setTimeout(() => runTeamTicketSearch(q), 350);
}

async function runTeamTicketSearch(q) {
  const token = ++teamSearchToken;
  teamSearchLoading = true;
  teamSearchLastTerm = q;
  updateTicketGlobalSearchUI(allTickets.filter(canViewTicket).filter(ticketMatchesFilters));

  await loadTeamSearchIndex({ silent: false });
  if (token !== teamSearchToken || q !== currentTicketSearchTerm()) return;

  teamSearchLoading = false;
  mergeTicketMaps();
  renderTicketList();
  renderTicketDetail();
}

function canManageTicketFields(ticket) {
  if (!currentUser || !ticket) return false;
  return canEditAll(currentUser) || ticket.assignedTo === currentUser.id || ticket.createdBy === currentUser.id;
}
function canAddTicketComment(ticket) {
  return Boolean(currentUser && ticket && canViewTicket(ticket));
}

function normaliseالطلبNumber(v) {
  return String(v || "").trim().replace(/^#/, "");
}

function orderDocRef(orderNumber) {
  const order = normaliseالطلبNumber(orderNumber);
  if (!order) return null;
  return doc(db, ORDER_RECORDS_COL, order);
}

async function getCachedالطلب(orderNumber) {
  const ref = orderDocRef(orderNumber);
  if (!ref) return null;
  const snap = await getDoc(ref);
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

function cleanText(v) {
  return String(v || "").trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


function copyText(value, label = "Copied") {
  const text = String(value || "").trim();
  if (!text) return showTicketAlert("Nothing to copy.", true);
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      showTicketAlert(label);
      return;
    }
  } catch {}
  const temp = document.createElement("textarea");
  temp.value = text;
  document.body.appendChild(temp);
  temp.select();
  document.execCommand("copy");
  temp.remove();
  showTicketAlert(label);
}

function getShopifyApiKey() {
  // Use local override only for developer testing; employees no longer see an API key popup.
  return localStorage.getItem(SHOPIFY_API_KEY_STORAGE) || defaultShopifyApiKey();
}

function setShopifyApiKey() {
  showTicketAlert("Backend API key is already configured for staff.");
  return getShopifyApiKey();
}

function firstTracking(order) {
  const f = Array.isArray(order?.fulfillments) ? order.fulfillments.find(x => Array.isArray(x.tracking) && x.tracking.length) : null;
  return f?.tracking?.[0] || {};
}

function formatAddress(a) {
  if (!a) return "";
  return [a.firstName, a.lastName, a.company, a.address1, a.address2, a.city, a.province, a.zip, a.country, a.phone].filter(Boolean).join(", ");
}

function mapShopifyOrder(raw) {
  if (!raw) return null;
  const order = raw.order || {};
  const customer = raw.customer || {};
  const items = Array.isArray(raw.items) ? raw.items : [];
  const shipping = raw.shipping_address || {};
  const track = firstTracking(raw);
  const orderNumber = normaliseالطلبNumber(order.number || order.name || raw.order_number || "");
  const totalAmount = order.total_paid?.amount || raw.total_paid?.amount || "";
  const totalCurrency = order.total_paid?.currency || raw.total_paid?.currency || "";
  const firstImage = items.find(i => i.image_url)?.image_url || "";
  return {
    orderNumber,
    customerName: customer.name || "",
    email: customer.email || "",
    phone: customer.phone || "",
    postcode: shipping.zip || shipping.postcode || shipping.postalCode || "",
    totalPaid: totalAmount ? `${totalAmount} ${totalCurrency}`.trim() : "",
    orderDate: order.processed_at || order.processedAt || order.created_at || order.createdAt || raw.processed_at || raw.processedAt || raw.created_at || raw.createdAt || raw.orderCreatedAt || "",
    courier: track.company || "",
    trackingNumber: track.number || "",
    trackingUrl: track.url || "",
    orderالحالة: String(order.fulfillment_status || "unknown").toLowerCase(),
    paymentStatus: order.payment_status || "",
    deliveryالحالة: track.number ? "in_transit" : "unknown",
    items: items.map(i => `${i.title || i.product_title || "Item"}${i.variant ? ` - ${i.variant}` : ""} x${i.quantity || 1}`).join("\n"),
    itemList: items,
    imageUrl: firstImage,
    shippingAddress: formatAddress(raw.shipping_address),
    billingAddress: formatAddress(raw.billing_address),
    adminUrl: raw.admin_url || raw.adminUrl || "",
    refunds: Array.isArray(raw.refunds) ? raw.refunds : [],
    disputes: collectDisputes(raw),
    chargebackStatus: raw.chargeback_status || raw.dispute_status || raw.disputeSummary?.status || raw.orderDisputeSummary?.status || raw.order?.disputeSummary?.status || "",
    rawShopify: raw,
    source: "live_shopify",
  };
}

function liveStatus(text, mode = "info") {
  const box = el("shopify-live-status");
  if (!box) return;
  box.textContent = text;
  box.className = `shopify-live-status ${mode}`;
}

function firebaseStatusBadge(status) {
  if (status === "saved") return `<span class="firebase-save-badge saved">✅ Saved to Firebase orderRecords</span>`;
  if (status === "failed") return `<span class="firebase-save-badge failed">⚠️ Loaded from Shopify but not saved to Firebase</span>`;
  return `<span class="firebase-save-badge pending">Firebase: not saved yet</span>`;
}

function renderShopifyLiveResult(order, firebaseStatus = currentLiveOrderFirebaseStatus) {
  const box = el("shopify-live-result");
  if (!box) return;
  if (!order) {
    box.classList.add("hidden");
    box.innerHTML = "";
    if (el("shopify-live-use-btn")) el("shopify-live-use-btn").disabled = true;
    return;
  }
  box.classList.remove("hidden");
  if (el("shopify-live-use-btn")) el("shopify-live-use-btn").disabled = false;
  const img = order.imageUrl ? `<img class="shopify-product-thumb" src="${escapeHtml(order.imageUrl)}" alt="Product image" loading="lazy" />` : `<div class="shopify-product-thumb placeholder">No image</div>`;
  box.innerHTML = `
    <div class="shopify-order-card ${chargebackSummary(order).alert ? 'chargeback-active' : ''}">
      <div class="shopify-order-card-head">
        ${img}
        <div>
          <h4>#${escapeHtml(order.orderNumber || "—")} • ${escapeHtml(order.customerName || "No customer")}</h4>
          <div class="shopify-muted">${chargebackBadge(order)} ${escapeHtml(order.email || "—")} • ${escapeHtml(order.phone || "—")}</div>
          <div class="shopify-muted">${firebaseStatusBadge(firebaseStatus)}</div>
        </div>
      </div>
      <div class="shopify-order-grid">
        <div><b>Total</b><span>${escapeHtml(order.totalPaid || "—")}</span></div>
        <div><b>Payment</b><span>${escapeHtml(order.paymentStatus || "—")}</span></div>
        <div class="chargeback-field ${chargebackSummary(order).cls}"><b>${escapeHtml(disputeLabel())}</b><span>${chargebackDetailsHtml(order)}</span></div>
        <div><b>${escapeHtml(purchaseDateLabel())}</b><span>${escapeHtml(fmtPurchaseDate(order.orderDate))}</span></div>
        <div><b>${escapeHtml(purchaseAgeLabel())}</b><span>${escapeHtml(fmtPurchaseAge(order.orderDate))}</span></div>
        <div><b>Fulfilment</b><span>${escapeHtml(order.orderالحالة || "—")}</span></div>
        <div><b>Courier</b><span>${escapeHtml(order.courier || "—")}</span></div>
        <div><b>Postcode</b><span>${escapeHtml(order.postcode || "—")}</span></div>
      </div>
      <div class="shopify-items-box"><b>Items</b><pre>${escapeHtml(order.items || "—")}</pre></div>
      <div class="shopify-tracking-box">
        <div><b>Tracking number:</b> ${escapeHtml(order.trackingNumber || "—")}</div>
        <div><b>Postcode:</b> ${escapeHtml(order.postcode || "—")}</div>
        <div><b>Tracking URL:</b> ${order.trackingUrl ? `<a href="${escapeHtml(order.trackingUrl)}" target="_blank" rel="noopener">Open tracking link</a>` : "—"}</div>
        <div class="shopify-live-actions">
          <button type="button" class="btn-secondary" data-copy-postcode>Copy postcode</button>
          <button type="button" class="btn-secondary" data-copy-tracking>Copy tracking</button>
          <button type="button" class="btn-secondary" data-copy-tracking-url>Copy tracking URL</button>
          ${order.trackingUrl ? `<button type="button" class="btn-secondary" data-open-tracking>Open tracking</button>` : ""}
          ${order.adminUrl ? `<button type="button" class="btn-secondary" data-open-shopify>Open Shopify</button>` : ""}
        </div>
      </div>
    </div>`;
  box.querySelector("[data-copy-postcode]")?.addEventListener("click", () => copyText(order.postcode, "Postcode copied."));
  box.querySelector("[data-copy-tracking]")?.addEventListener("click", () => copyText(order.trackingNumber, "Tracking number copied."));
  box.querySelector("[data-copy-tracking-url]")?.addEventListener("click", () => copyText(order.trackingUrl, "Tracking URL copied."));
  box.querySelector("[data-open-tracking]")?.addEventListener("click", () => order.trackingUrl && window.open(order.trackingUrl, "_blank", "noopener"));
  box.querySelector("[data-open-shopify]")?.addEventListener("click", () => order.adminUrl && window.open(order.adminUrl, "_blank", "noopener"));
}

async function saveLiveOrderToFirebase(order) {
  if (!order?.orderNumber) return "failed";
  const existing = await getCachedالطلب(order.orderNumber).catch(() => null);
  const payload = {
    ...order,
    shopifyStatus: "synced",
    shopifySyncStatus: "synced",
    updatedAt: serverTimestamp(),
    updatedBy: currentUser?.id || "system",
    updatedByName: currentUser?.name || "System",
  };
  if (!existing) payload.createdAt = serverTimestamp();
  try {
    await setDoc(orderDocRef(order.orderNumber), payload, { merge: true });
    currentLiveOrderFirebaseStatus = "saved";
    renderShopifyLiveResult(order, "saved");
    return "saved";
  } catch (err) {
    console.warn("Could not save Shopify order to Firebase orderRecords", err);
    currentLiveOrderFirebaseStatus = "failed";
    renderShopifyLiveResult(order, "failed");
    return "failed";
  }
}

async function searchShopifyLive({ useInTicket = false } = {}) {
  const input = el("shopify-live-query");
  const q = normaliseالطلبNumber(input?.value || el("ticket-order")?.value || "");
  if (!q) return showTicketAlert("Enter an order number first.", true);
  let apiKey = getShopifyApiKey();
  if (!apiKey) apiKey = setShopifyApiKey();
  if (!apiKey) return showTicketAlert("API key is required for Shopify live search.", true);
  const btn = el("shopify-live-search-btn");
  const restoreSearchBtn = setButtonSaving(btn, true, "Searching...");
  liveStatus("Searching Shopify...", "loading");
  renderShopifyLiveResult(null);
  try {
    const url = `${SHOPIFY_BACKEND_URL}/api/search-orders?q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { "x-api-key": apiKey } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || data.details || `HTTP ${res.status}`);
    if (!data.orders?.length) {
      currentLiveOrder = null;
      currentLiveOrderFirebaseStatus = "none";
      liveStatus(ticketLang && ticketLang() === "ar" ? `لم يتم العثور على طلب Shopify لـ ${q}.` : `No Shopify order found for ${q}.`, "warn");
      renderShopifyLiveResult(null);
      return null;
    }
    currentLiveOrder = mapShopifyOrder(data.orders[0]);
    currentLiveOrderFirebaseStatus = "pending";
    renderShopifyLiveResult(currentLiveOrder, "pending");
    liveStatus(`Loaded #${currentLiveOrder.orderNumber} from Shopify. Saving to Firebase...`, "ok");
    const saved = await saveLiveOrderToFirebase(currentLiveOrder);
    liveStatus(saved === "saved" ? `Loaded and saved #${currentLiveOrder.orderNumber}.` : `Loaded #${currentLiveOrder.orderNumber}, but Firebase save failed. Ticket can still use it.`, saved === "saved" ? "ok" : "warn");
    if (useInTicket) useLiveOrderInTicket();
    return currentLiveOrder;
  } catch (err) {
    console.error("Shopify live lookup failed", err);
    liveStatus(`Shopify search failed: ${err.message || err}`, "danger");
    showTicketAlert(`Shopify search failed: ${err.message || err}`, true);
    return null;
  } finally {
    restoreSearchBtn();
  }
}

function useLiveOrderInTicket() {
  const order = currentLiveOrder;
  if (!order) return showTicketAlert("Search Shopify first.", true);
  setTicketFormمفتوحة(true);
  if (el("ticket-order")) el("ticket-order").value = order.orderNumber || "";
  if (el("ticket-customer")) el("ticket-customer").value = order.customerName || "";
  if (el("ticket-email")) el("ticket-email").value = order.email || "";
  renderالطلبPreview(order);
  showTicketAlert("Structured Shopify order is ready for this ticket. Notes stay for the issue only.");
}


function orderالحالةLabel(v) {
  const labels = {
    unknown: "Unknown", unfulfilled: "Unfulfilled", processing: "Processing", fulfilled: "Fulfilled",
    cancelled: "Cancelled", refunded: "Refunded", label_created: "Label created", in_transit: "In transit",
    delivered: "Delivered", delayed: "Delayed", lost: "Lost / investigation"
  };
  return labels[v] || v || "Unknown";
}

function renderالطلبPreview(order) {
  const card = el("ticket-order-preview");
  const body = el("ticket-order-preview-body");
  if (!card || !body) return;
  if (!order) {
    card.classList.add("hidden");
    body.textContent = "No order loaded yet.";
    return;
  }
  card.classList.remove("hidden");
  const img = order.imageUrl ? `<img class="shopify-product-thumb small" src="${escapeHtml(order.imageUrl)}" alt="Product image" loading="lazy" />` : "";
  body.innerHTML = `
    <div class="ticket-preview-structured">
      ${img}
      <div>
        <div><strong>العميل:</strong> ${escapeHtml(order.customerName || "—")}</div>
        <div><strong>Email:</strong> ${escapeHtml(order.email || "—")}</div>
        <div><strong>Phone:</strong> ${escapeHtml(order.phone || "—")}</div>
        <div><strong>Postcode:</strong> ${escapeHtml(order.postcode || "—")}</div>
        <div><strong>Items:</strong> ${escapeHtml(order.items || "—")}</div>
        <div><strong>Total:</strong> ${escapeHtml(order.totalPaid || "—")}</div>
        <div><strong>Payment:</strong> ${escapeHtml(order.paymentStatus || "—")}</div>
        <div><strong>${escapeHtml(purchaseDateLabel())}:</strong> ${escapeHtml(fmtPurchaseDate(order.orderDate))}</div>
        <div><strong>${escapeHtml(purchaseAgeLabel())}:</strong> ${escapeHtml(fmtPurchaseAge(order.orderDate))}</div>
        <div><strong>Fulfilment:</strong> ${escapeHtml(order.orderالحالة || "—")}</div>
        <div><strong>Tracking:</strong> ${escapeHtml(order.trackingNumber || "—")} ${order.courier ? `(${escapeHtml(order.courier)})` : ""}</div>
      </div>
    </div>`;
}

function orderNoteBlock(order) {
  if (!order) return "";
  return [
    `Shopify order cache loaded:`,
    `العميل: ${order.customerName || "—"}`,
    `Email: ${order.email || "—"}`,
    `Phone: ${order.phone || "—"}`,
    `Postcode: ${order.postcode || "—"}`,
    `Items: ${order.items || "—"}`,
    `Total: ${order.totalPaid || "—"}`,
    `${tt("النزاع البنكي", "Chargeback")}: ${chargebackSummary(order).has ? chargebackSummary(order).label : tt("لا يوجد", "None")}`,
    `Tracking: ${order.trackingNumber || "—"} ${order.courier ? `(${order.courier})` : ""}`,
    `الطلب status: ${orderالحالةLabel(order.orderالحالة)}`,
    `Delivery status: ${orderالحالةLabel(order.deliveryالحالة)}`,
    order.notes ? `الطلب notes: ${order.notes}` : ""
  ].filter(Boolean).join("\n");
}

function riskFromTypeAndالطلب(type, order) {
  if (chargebackSummary(order).active || chargebackSummary(order).lost || type === "chargeback_risk" || type === "item_not_genuine") return "chargeback";
  if (order?.deliveryالحالة === "lost" || order?.deliveryالحالة === "delayed") return "high";
  if (EMERGENCY_TYPES.has(type)) return "medium";
  return "normal";
}

function canManageالطلبCache(u) {
  return roleLevel(u) >= ROLE_LEVELS.supervisor;
}

function customerHistoryHtml(ticket) {
  if (!ticket) return "";
  const email = cleanText(ticket.email).toLowerCase();
  const customer = cleanText(ticket.customerName).toLowerCase();
  const matches = allTickets
    .filter((x) => x.id !== ticket.id)
    .filter((x) => {
      const xe = cleanText(x.email).toLowerCase();
      const xc = cleanText(x.customerName).toLowerCase();
      return (email && xe === email) || (customer && xc === customer);
    })
    .slice(0, 5);
  if (!matches.length) return `<div class="lookup-title">العميل history</div><div>No previous tickets found for this customer.</div>`;
  return `
    <div class="lookup-title">العميل history</div>
    ${matches.map((x) => `
      <div class="history-line">#${escapeHtml(x.orderNumber || "—")} • ${escapeHtml(TYPE_LABELS[x.type] || x.type || "Ticket")} • ${escapeHtml(STATUS_LABELS[x.status] || x.status || "مفتوحة")}</div>
    `).join("")}
  `;
}

function addHistory(existing, event, by) {
  const row = {
    event,
    by: by || currentUser?.id || "system",
    byName: currentUser?.name || staffName(by) || "System",
    atMs: Date.now(),
  };
  return [...(Array.isArray(existing) ? existing : []), row].slice(-30);
}

function ticketTimelineHtml(ticket) {
  const rows = Array.isArray(ticket.history) ? ticket.history : [];
  const base = [
    { event: "تم الإنشاء", byName: staffName(ticket.createdBy), atMs: tsToMs(ticket.createdAt) },
    ...rows,
  ].filter((x) => x.event);
  if (!base.length) return "";
  return `<div class="lookup-title">Timeline</div>` + base.slice(-8).reverse().map((x) => `
    <div class="timeline-line"><b>${escapeHtml(x.event)}</b><span>${escapeHtml(x.byName || x.by || "System")} • ${escapeHtml(x.atMs ? new Date(x.atMs).toLocaleString() : "now")}</span></div>
  `).join("");
}

function inferالأولوية(type) {
  return EMERGENCY_TYPES.has(type) ? "emergency" : "normal";
}

function inferMood(type, priority) {
  if (type === "chargeback_risk") return "chargeback_risk";
  if (type === "angry_customer" || priority === "emergency") return "angry";
  return "calm";
}

function toast(message, danger = false) {
  let wrap = document.getElementById("ts-toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "ts-toast-wrap";
    wrap.className = "ts-toast-wrap";
    document.body.appendChild(wrap);
  }
  const item = document.createElement("div");
  item.className = `ts-toast ${danger ? "danger" : "ok"}`;
  item.textContent = message;
  wrap.appendChild(item);
  requestAnimationFrame(() => item.classList.add("show"));
  setTimeout(() => {
    item.classList.remove("show");
    setTimeout(() => item.remove(), 260);
  }, 2600);
}

function showTicketAlert(message, danger = false) {
  const box = el("ticket-alert");
  if (box) {
    box.textContent = message;
    box.classList.remove("hidden");
    box.classList.toggle("danger", Boolean(danger));
    setTimeout(() => box.classList.add("hidden"), 3500);
  }
  toast(message, danger);
}

function setButtonSaving(button, saving, savingText = "Saving...") {
  if (!button) return () => {};
  const oldText = button.textContent;
  button.disabled = Boolean(saving);
  button.classList.toggle("is-saving", Boolean(saving));
  if (saving) button.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span><span>${savingText}</span>`;
  return () => {
    button.disabled = false;
    button.classList.remove("is-saving");
    button.textContent = oldText;
  };
}

function setTicketFormمفتوحة(open) {
  const form = el("ticket-form");
  if (!form) return;
  form.classList.toggle("hidden", !open);
  document.body.classList.remove("ticket-modal-open");
  if (open) {
    renderالطلبPreview(null);
    const ticketTop = document.querySelector(".tickets-card");
    setTimeout(() => {
      form.scrollIntoView({ behavior: "smooth", block: "start" });
      el("ticket-order")?.focus();
    }, 40);
  }
}


function fillAssigneeSelect(selectEl, includeUnassigned = true) {
  if (!selectEl || !currentUser) return;
  const previous = selectEl.value;
  selectEl.innerHTML = "";
  if (includeUnassigned && canEditAll(currentUser)) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = tt("غير مسندة", "Unassigned");
    selectEl.appendChild(opt);
  }
  for (const s of visibleStaffForAssignment()) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = `${s.name} (${String(s.role).toUpperCase()} ${s.id})`;
    selectEl.appendChild(opt);
  }
  if ([...selectEl.options].some((o) => o.value === previous)) selectEl.value = previous;
  else if (!canEditAll(currentUser)) selectEl.value = currentUser.id;
}

function ticketMatchesFilters(ticket) {
  const q = (el("ticket-search")?.value || "").trim().toLowerCase();
  const status = el("ticket-filter-status")?.value || "all";
  const priority = el("ticket-filter-priority")?.value || "all";
  const owner = el("ticket-filter-owner")?.value || "all";

  if (status !== "all" && ticket.status !== status) return false;
  if (priority !== "all" && ticket.priority !== priority) return false;
  if (owner === "mine" && ticket.assignedTo !== currentUser?.id) return false;
  if (owner === "unassigned" && ticket.assignedTo) return false;

  if (q) {
    const hay = ticketSearchText(ticket);
    if (!hay.includes(q)) return false;
  }
  return true;
}

function renderStats(rows) {
  const open = rows.filter((t) => !["resolved", "closed"].includes(t.status)).length;
  const emergency = rows.filter((t) => t.priority === "emergency" && !["resolved", "closed"].includes(t.status)).length;
  const escalated = rows.filter((t) => t.status === "escalated").length;
  const resolvedToday = rows.filter((t) => {
    if (t.status !== "resolved" && t.status !== "closed") return false;
    const ms = tsToMs(t.resolvedAt || t.updatedAt);
    if (!ms) return false;
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}` === todayKey();
  }).length;

  if (el("ticket-stat-open")) el("ticket-stat-open").textContent = String(open);
  if (el("ticket-stat-emergency")) el("ticket-stat-emergency").textContent = String(emergency);
  if (el("ticket-stat-escalated")) el("ticket-stat-escalated").textContent = String(escalated);
  if (el("ticket-stat-resolved")) el("ticket-stat-resolved").textContent = String(resolvedToday);
}

function shopifyStatusMeta(t) {
  const raw = String(t?.shopifyStatus || t?.shopifySyncStatus || "").toLowerCase();
  const hasOrder = t?.source === "order_cache" || (t?.orderData && Object.keys(t.orderData || {}).length > 0);
  if (raw === "synced" || hasOrder) return { cls: "synced", ar: "متزامن مع Shopify", en: "Synced with Shopify" };
  if (raw === "failed" || raw === "not_found" || raw === "missing") return { cls: "failed", ar: "لم يتم العثور في Shopify", en: "Failed to load from Shopify" };
  return { cls: "manual", ar: "إدخال يدوي", en: "Manual entry" };
}
function currentLang() {
  return (document.body?.dataset?.language || document.documentElement.lang || "ar") === "en" ? "en" : "ar";
}
function shopifyStatusPill(t) {
  const m = shopifyStatusMeta(t);
  return `<span class="shopify-sync-pill ${m.cls}">${escapeHtml(m[currentLang()] || m.en)}</span>`;
}

function ensureTicketGlobalSearchUI() {
  const filters = document.querySelector('#page-tickets .ticket-filters');
  if (!filters || el('ticket-global-search-hint')) return;
  const hint = document.createElement('div');
  hint.id = 'ticket-global-search-hint';
  hint.className = 'ticket-global-search-hint hidden';
  filters.insertAdjacentElement('afterend', hint);
}

function updateTicketGlobalSearchUI(filteredRows = []) {
  ensureTicketGlobalSearchUI();
  const hint = el('ticket-global-search-hint');
  if (!hint) return;
  const q = currentTicketSearchTerm();
  const active = isTicketGlobalSearchActive();
  if (!active) {
    hint.classList.add('hidden');
    hint.textContent = '';
    return;
  }
  hint.classList.remove('hidden');
  if (teamSearchLoading || teamSearchIndexLoading) {
    hint.innerHTML = tt(`جاري تجهيز بحث كل الفريق عن “${escapeHtml(q)}”…`, `Preparing whole-team search for “${escapeHtml(q)}”…`);
    return;
  }
  const globalHits = filteredRows.filter(isTicketGlobalSearchHit).length;
  hint.innerHTML = globalHits
    ? tt(`تم العثور على ${globalHits} تذكرة من خارج قائمتك. يمكنك فتحها وإضافة تحديثات المتابعة.`, `Found ${globalHits} ticket(s) outside your own queue. You can open them and add handling updates.`)
    : tt(`لم يظهر تطابق خارج قائمتك. جرّب رقم الطلب الكامل أو البريد أو اسم العميل، والبحث سيشمل التذاكر القديمة وتذاكر الفريق بعد تجهيز الفهرس.`, `No outside-queue match yet. Try the full order number, email, or customer name; search includes old and team tickets after the index is ready.`);
}

function ensureTicketAccessNotice() {
  if (el('ticket-access-note')) return;
  const head = document.querySelector('#ticket-detail .ticket-detail-head');
  if (!head) return;
  const note = document.createElement('div');
  note.id = 'ticket-access-note';
  note.className = 'ticket-access-note hidden';
  head.insertAdjacentElement('afterend', note);
}

function ensureDeletedTicketsUI() {
  const actions = document.querySelector('#page-tickets .tickets-actions');
  if (actions && !el('ticket-deleted-toggle')) {
    const btn = document.createElement('button');
    btn.id = 'ticket-deleted-toggle';
    btn.type = 'button';
    btn.className = 'btn-secondary ticket-deleted-toggle hidden';
    btn.textContent = deletedFolderLabel();
    actions.insertBefore(btn, actions.firstChild);
    btn.addEventListener('click', openDeletedTicketsFolder);
  }

  if (!el('deleted-tickets-modal')) {
    const modal = document.createElement('div');
    modal.id = 'deleted-tickets-modal';
    modal.className = 'deleted-tickets-modal hidden';
    modal.innerHTML = `
      <div class="deleted-tickets-card" role="dialog" aria-modal="true" aria-labelledby="deleted-tickets-title">
        <div class="deleted-tickets-head">
          <div>
            <h3 id="deleted-tickets-title">${deletedFolderLabel()}</h3>
            <p id="deleted-tickets-subtitle">${tt('هذه القائمة للمشرفين والمدراء فقط. يمكن استعادة التذكرة أو حذفها نهائياً.', 'Only supervisors, managers, and admins can access this folder. Restore or permanently delete tickets here.')}</p>
          </div>
          <button id="deleted-tickets-close" class="btn-secondary" type="button">${tt('إغلاق', 'Close')}</button>
        </div>
        <div id="deleted-tickets-list" class="deleted-tickets-list"></div>
      </div>`;
    document.body.appendChild(modal);
    el('deleted-tickets-close')?.addEventListener('click', closeDeletedTicketsFolder);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeDeletedTicketsFolder(); });
  }

  const canAccess = canAccessDeletedTickets(currentUser);
  const toggle = el('ticket-deleted-toggle');
  if (toggle) {
    toggle.classList.toggle('hidden', !canAccess);
    if (!toggle.dataset.deletedHooked) {
      toggle.dataset.deletedHooked = '1';
      toggle.addEventListener('click', openDeletedTicketsFolder);
    }
  }
  translateTicketsStatic();
}

function renderDeletedTicketsList() {
  const list = el('deleted-tickets-list');
  if (!list) return;
  if (!canAccessDeletedTickets(currentUser)) {
    list.innerHTML = `<div class="deleted-empty">${tt('لا تملك صلاحية فتح المحذوفات.', 'You do not have access to deleted tickets.')}</div>`;
    return;
  }
  if (!deletedTickets.length) {
    list.innerHTML = `<div class="deleted-empty">${tt('لا توجد تذاكر محذوفة.', 'No deleted tickets found.')}</div>`;
    return;
  }
  const rows = deletedTickets.slice().sort((a,b) => tsToMs(b.deletedAt || b.updatedAt) - tsToMs(a.deletedAt || a.updatedAt));
  list.innerHTML = rows.map((t) => `
    <article class="deleted-ticket-row" data-deleted-id="${escapeHtml(t.id)}">
      <div class="deleted-ticket-main">
        <strong>#${escapeHtml(t.orderNumber || '—')}</strong>
        <span>${escapeHtml(typeLabel(t.type) || t.type || 'Ticket')}</span>
        <small>${escapeHtml(t.customerName || t.email || tt('بدون بيانات عميل', 'No customer details'))}</small>
        <small>${tt('حذف بواسطة', 'Deleted by')}: ${escapeHtml(t.deletedByName || staffName(t.deletedBy) || '—')} • ${escapeHtml(fmtDate(t.deletedAt))}</small>
      </div>
      <div class="deleted-ticket-actions">
        <button type="button" class="btn-secondary" data-restore-deleted="${escapeHtml(t.id)}">${tt('استعادة', 'Restore')}</button>
        <button type="button" class="btn-secondary danger" data-permanent-delete="${escapeHtml(t.id)}">${tt('حذف نهائي', 'Delete forever')}</button>
      </div>
    </article>`).join('');
  list.querySelectorAll('[data-restore-deleted]').forEach((btn) => btn.addEventListener('click', () => restoreDeletedTicket(btn.dataset.restoreDeleted)));
  list.querySelectorAll('[data-permanent-delete]').forEach((btn) => btn.addEventListener('click', () => permanentlyDeleteTicket(btn.dataset.permanentDelete)));
}

function openDeletedTicketsFolder() {
  if (!canAccessDeletedTickets(currentUser)) return showTicketAlert(tt('المحذوفات متاحة فقط للمشرف أو المدير أو الأدمن.', 'Deleted tickets are only available to supervisor, manager, or admin.'), true);
  ensureDeletedTicketsUI();
  renderDeletedTicketsList();
  el('deleted-tickets-modal')?.classList.remove('hidden');
}
function closeDeletedTicketsFolder() { el('deleted-tickets-modal')?.classList.add('hidden'); }

async function findActiveDuplicateTicket(orderNumber) {
  const normalized = normaliseالطلبNumber(orderNumber);
  if (!normalized) return null;
  const local = allTickets.find((t) => normaliseالطلبNumber(t.orderNumber) === normalized);
  if (local) return local;
  try {
    const q = query(collection(db, TICKETS_COL), where('orderNumber', '==', normalized));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const d = snap.docs[0];
      return { id: d.id, ...d.data() };
    }
  } catch (err) {
    console.warn('duplicate active check failed', err);
  }
  return null;
}

async function findDeletedDuplicateTicket(orderNumber) {
  const normalized = normaliseالطلبNumber(orderNumber);
  if (!normalized) return null;
  const local = deletedTickets.find((t) => normaliseالطلبNumber(t.orderNumber) === normalized);
  if (local) return local;
  try {
    const q = query(collection(db, DELETED_TICKETS_COL), where('orderNumber', '==', normalized));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const d = snap.docs[0];
      return { id: d.id, ...d.data() };
    }
  } catch (err) {
    console.warn('duplicate deleted check failed', err);
  }
  return null;
}

async function softDeleteSelectedTicket() {
  const t = allTickets.find((x) => x.id === selectedTicketId);
  if (!t) return showTicketAlert(tt('اختر تذكرة أولاً.', 'Select a ticket first.'), true);
  if (!canSoftDeleteTicket(t)) return showTicketAlert(tt('لا يمكنك حذف هذه التذكرة.', 'You cannot delete this ticket.'), true);
  const ok = window.confirm(tt('سيتم نقل التذكرة إلى المحذوفات. يستطيع المشرف/المدير استعادتها أو حذفها نهائياً. هل أنت متأكد؟', 'This ticket will move to Deleted tickets. A supervisor/manager/admin can restore it or delete it forever. Continue?'));
  if (!ok) return;
  const btn = el('ticket-delete-btn');
  const restoreBtn = setButtonSaving(btn, true, tt('جار الحذف...', 'Deleting...'));
  try {
    const payload = { ...t };
    delete payload.id;
    payload.originalTicketId = t.id;
    payload.deletedAt = serverTimestamp();
    payload.deletedBy = currentUser?.id || '';
    payload.deletedByName = currentUser?.name || '';
    payload.history = addHistory(t.history, tt('تم نقل التذكرة إلى المحذوفات', 'Moved ticket to deleted folder'), currentUser?.id || '');
    await setDoc(doc(db, DELETED_TICKETS_COL, t.id), payload);
    await deleteDoc(doc(db, TICKETS_COL, t.id));
    selectedTicketId = null;
    showTicketAlert(tt('تم نقل التذكرة إلى المحذوفات.', 'Ticket moved to Deleted tickets.'));
    renderTicketList();
    renderTicketDetail();
  } catch (err) {
    console.error('soft delete failed', err);
    showTicketAlert(`${tt('فشل حذف التذكرة:', 'Failed to delete ticket:')} ${err?.code || err?.message || 'unknown error'}`, true);
  } finally {
    restoreBtn();
  }
}

async function restoreDeletedTicket(id) {
  if (!canAccessDeletedTickets(currentUser)) return;
  const t = deletedTickets.find((x) => x.id === id);
  if (!t) return;
  const activeDuplicate = await findActiveDuplicateTicket(t.orderNumber);
  if (activeDuplicate) return showTicketAlert(tt('لا يمكن الاستعادة لأن هناك تذكرة نشطة بنفس رقم الطلب.', 'Cannot restore because an active ticket already exists with the same order number.'), true);
  const ok = window.confirm(tt('استعادة هذه التذكرة إلى قائمة التذاكر؟', 'Restore this ticket to the active ticket queue?'));
  if (!ok) return;
  try {
    const payload = { ...t };
    delete payload.id;
    delete payload.deletedAt;
    delete payload.deletedBy;
    delete payload.deletedByName;
    payload.restoredAt = serverTimestamp();
    payload.restoredBy = currentUser?.id || '';
    payload.updatedAt = serverTimestamp();
    payload.history = addHistory(t.history, tt('تمت استعادة التذكرة من المحذوفات', 'Restored from deleted folder'), currentUser?.id || '');
    const restoreId = t.originalTicketId || id;
    await setDoc(doc(db, TICKETS_COL, restoreId), payload);
    await deleteDoc(doc(db, DELETED_TICKETS_COL, id));
    selectedTicketId = restoreId;
    closeDeletedTicketsFolder();
    showTicketAlert(tt('تمت استعادة التذكرة.', 'Ticket restored.'));
  } catch (err) {
    console.error('restore ticket failed', err);
    showTicketAlert(`${tt('فشل استعادة التذكرة:', 'Failed to restore ticket:')} ${err?.code || err?.message || 'unknown error'}`, true);
  }
}

async function permanentlyDeleteTicket(id) {
  if (!canAccessDeletedTickets(currentUser)) return;
  const t = deletedTickets.find((x) => x.id === id);
  if (!t) return;
  const ok = window.confirm(tt('حذف نهائي؟ لا يمكن التراجع بعد هذه الخطوة.', 'Delete forever? This cannot be undone.'));
  if (!ok) return;
  try {
    await deleteDoc(doc(db, DELETED_TICKETS_COL, id));
    showTicketAlert(tt('تم حذف التذكرة نهائياً.', 'Ticket deleted forever.'));
  } catch (err) {
    console.error('permanent delete failed', err);
    showTicketAlert(`${tt('فشل الحذف النهائي:', 'Failed to delete forever:')} ${err?.code || err?.message || 'unknown error'}`, true);
  }
}

function renderTicketList() {
  const list = el("tickets-list");
  const empty = el("tickets-empty");
  if (!list || !empty) return;

  if (ticketsInitialLoading && !allTickets.length) {
    renderStats([]);
    empty.classList.add("hidden");
    updateTicketGlobalSearchUI([]);
    list.innerHTML = `
      <div class="ticket-loading-card ${ticketsLoadingSlow ? "slow" : ""}">
        <div class="ticket-loading-spinner" aria-hidden="true"></div>
        <strong>${escapeHtml(ticketsLoadingSlow ? tt("التحميل بطيء", "Loading is slow") : tt("جاري تحميل التذاكر", "Loading tickets"))}</strong>
        <span>${escapeHtml(ticketsLoadingMessage || tt("تحميل قائمة التذاكر المناسبة لحسابك…", "Loading the ticket queue for your account…"))}</span>
        ${ticketsLoadingSlow ? `<button type="button" class="btn-secondary" onclick="window.location.reload()">${escapeHtml(tt("إعادة المحاولة", "Retry"))}</button>` : ""}
      </div>`;
    return;
  }

  const visible = allTickets.filter(canViewTicket);
  renderStats(visible);

  const filtered = visible.filter(ticketMatchesFilters);
  list.innerHTML = "";
  empty.classList.toggle("hidden", filtered.length > 0);
  if (!filtered.length) {
    empty.textContent = isTicketGlobalSearchActive()
      ? tt("لم يتم العثور على تذكرة بهذا البحث في كل الفريق.", "No matching ticket found across the team.")
      : tt("لا توجد تذاكر في قائمتك الحالية.", "No tickets found in your current queue.");
  }
  updateTicketGlobalSearchUI(filtered);

  filtered.forEach((t) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const cb = chargebackSummary(ticketChargebackSource(t));
    btn.className = `ticket-row priority-${t.priority || "normal"} ${cb.alert ? "chargeback-active" : ""}`;
    const globalHit = isTicketGlobalSearchHit(t);
    btn.classList.toggle("active", t.id === selectedTicketId);
    btn.classList.toggle("global-hit", globalHit);
    btn.innerHTML = `
      <div class="ticket-row-top">
        <strong>#${escapeHtml(t.orderNumber || "—")}</strong>
        <span class="ticket-priority-pill ${t.priority || "normal"}">${escapeHtml(priorityLabelText(t.priority))}</span>
        ${globalHit ? `<span class="ticket-global-badge">${escapeHtml(tt('بحث الفريق', 'Team search'))}</span>` : ""}
        ${chargebackBadge(ticketChargebackSource(t), true)}
        ${shopifyStatusPill(t)}
      </div>
      <div class="ticket-row-title">${escapeHtml(typeLabel(t.type) || t.type || "Ticket")}</div>
      <div class="ticket-row-meta">
        <span class="ticket-status-dot status-${t.status || "open"}"></span>
        <span>${escapeHtml(statusLabelText(t.status) || t.status || tt("مفتوحة", "Open"))}</span>
        <span>•</span>
        <span>${escapeHtml(staffName(t.assignedTo))}</span>
      </div>
      <div class="ticket-row-sub">${escapeHtml(t.customerName || t.email || "No customer details yet")}</div>
    `;
    btn.addEventListener("click", () => selectTicket(t.id));
    list.appendChild(btn);
  });
}

function nextTicketFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

function ticketProgressDelay(ms = 35) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureTicketOpenProgress() {
  let panel = el("ticket-open-progress");
  if (panel) return panel;
  const host = el("page-tickets") || document.body;
  panel = document.createElement("div");
  panel.id = "ticket-open-progress";
  panel.className = "ticket-open-progress hidden";
  panel.setAttribute("role", "status");
  panel.setAttribute("aria-live", "polite");
  panel.innerHTML = `
    <div class="ticket-open-progress-head">
      <span id="ticket-open-progress-label">Opening ticket...</span>
      <strong id="ticket-open-progress-number">0%</strong>
    </div>
    <div class="ticket-open-progress-track"><div id="ticket-open-progress-fill" class="ticket-open-progress-fill"></div></div>
  `;
  host.prepend(panel);
  return panel;
}

function setTicketOpenProgress(percent, label) {
  const panel = ensureTicketOpenProgress();
  const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  panel.classList.remove("hidden", "complete");
  const fill = el("ticket-open-progress-fill");
  const number = el("ticket-open-progress-number");
  const text = el("ticket-open-progress-label");
  if (fill) fill.style.width = `${safePercent}%`;
  if (number) number.textContent = `${safePercent}%`;
  if (text) text.textContent = label || tt("جاري فتح التذكرة...", "Opening ticket...");
  if (safePercent >= 100) panel.classList.add("complete");
}

function hideTicketOpenProgress(token) {
  if (token !== ticketOpenProgressToken) return;
  if (ticketOpenProgressHideTimer) clearTimeout(ticketOpenProgressHideTimer);
  ticketOpenProgressHideTimer = setTimeout(() => {
    if (token !== ticketOpenProgressToken) return;
    el("ticket-open-progress")?.classList.add("hidden");
  }, 260);
}

async function selectTicket(id) {
  const token = ++ticketOpenProgressToken;
  selectedTicketId = id;
  if (ticketOpenProgressHideTimer) clearTimeout(ticketOpenProgressHideTimer);

  setTicketOpenProgress(0, tt("بدء فتح التذكرة...", "Starting ticket open..."));
  renderTicketList();
  setTicketOpenProgress(18, tt("تحديد التذكرة...", "Selecting ticket..."));
  await nextTicketFrame();

  if (token !== ticketOpenProgressToken) return;
  setTicketOpenProgress(45, tt("تحميل بيانات الطلب والتعليقات...", "Loading order data and comments..."));
  await ticketProgressDelay(35);

  if (token !== ticketOpenProgressToken) return;
  setTicketOpenProgress(72, tt("تجهيز التفاصيل...", "Preparing details..."));
  renderTicketDetail();
  await nextTicketFrame();

  if (token !== ticketOpenProgressToken) return;
  setTicketOpenProgress(100, tt("جاهزة", "Ready"));

  // Desktop had a horizontal jump when a ticket opened because scrollIntoView
  // tried to bring the detail panel into view inside the RTL grid. Only scroll on mobile.
  if (window.matchMedia && window.matchMedia("(max-width: 900px)").matches) {
    el("ticket-detail")?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
  }
  hideTicketOpenProgress(token);
}


function commentTypeMeta(type) {
  const labels = {
    customer_response: { ar: "رد العميل", en: "Customer response", cls: "customer" },
    agent_response: { ar: "رد الموظف", en: "Agent response", cls: "agent" },
    internal_note: { ar: "ملاحظة داخلية", en: "Internal note", cls: "internal" },
    decision: { ar: "قرار / الإجراء التالي", en: "Decision / next action", cls: "decision" },
  };
  return labels[type] || labels.internal_note;
}

function normaliseTicketComments(ticket) {
  const comments = Array.isArray(ticket?.comments) ? ticket.comments.filter(Boolean) : [];
  if (comments.length) return comments;
  const legacy = String(ticket?.notes || "").trim();
  if (!legacy) return [];
  return [{
    type: "internal_note",
    text: legacy,
    authorId: ticket?.createdBy || "",
    authorName: ticket?.createdByName || staffName(ticket?.createdBy) || "System",
    createdAt: ticket?.createdAt || ticket?.updatedAt || Date.now(),
    legacy: true,
  }];
}

function ticketCommentKey(comment, index = 0) {
  return String(comment?.id || `${tsToMs(comment?.createdAt) || 0}_${comment?.authorId || "unknown"}_${index}`);
}

function canEditTicketComment(ticket, comment) {
  if (!currentUser || !ticket || !comment || comment.legacy) return false;
  if (canEditAll(currentUser)) return true;
  if (comment.authorId && comment.authorId === currentUser.id) return true;
  return Boolean(canManageTicketFields(ticket));
}

function renderTicketComments(ticket) {
  const list = el("ticket-comments-list");
  const title = el("ticket-comments-title");
  const subtitle = el("ticket-comments-subtitle");
  const addBtn = el("ticket-comment-add-btn");
  const textBox = el("ticket-comment-text");

  if (title) title.textContent = tt("ملاحظات داخلية / سجل المتابعة", "Internal notes / Handling log");
  if (subtitle) subtitle.textContent = tt(
    "سجل كل رد من العميل، رد الموظف، ملاحظة داخلية، أو قرار مطلوب.",
    "Log every customer response, agent reply, internal note, or required decision."
  );
  if (addBtn) addBtn.textContent = tt("إضافة تعليق", "Add comment");
  if (textBox) textBox.placeholder = tt("اكتب آخر تحديث أو القرار المطلوب...", "Write the latest update or decision...");

  const typeSelect = el("ticket-comment-type");
  if (typeSelect) {
    const value = typeSelect.value || "internal_note";
    const types = ["customer_response", "agent_response", "internal_note", "decision"];
    typeSelect.innerHTML = types
      .map((key) => {
        const meta = commentTypeMeta(key);
        return `<option value="${key}">${escapeHtml(meta[currentLang()] || meta.en)}</option>`;
      })
      .join("");
    typeSelect.value = types.includes(value) ? value : "internal_note";
  }

  if (!list) return;
  const comments = normaliseTicketComments(ticket);
  if (!comments.length) {
    editingTicketCommentId = null;
    list.innerHTML = `<div class="ticket-comments-empty">${tt("لا توجد ملاحظات بعد.", "No comments yet.")}</div>`;
    return;
  }

  list.innerHTML = comments
    .map((comment, originalIndex) => ({ comment, originalIndex, key: ticketCommentKey(comment, originalIndex) }))
    .sort((a, b) => tsToMs(a.comment.createdAt) - tsToMs(b.comment.createdAt))
    .map(({ comment, key }) => {
      const meta = commentTypeMeta(comment.type);
      const label = meta[currentLang()] || meta.en;
      const author = comment.authorName || staffName(comment.authorId) || "—";
      const isEditing = editingTicketCommentId === key;
      const editable = canEditTicketComment(ticket, comment);
      const editedLabel = comment.editedAt
        ? `<span class="ticket-comment-edited">${escapeHtml(tt("تم التعديل", "Edited"))} • ${escapeHtml(fmtDate(comment.editedAt))}</span>`
        : "";
      const editButton = editable && !isEditing
        ? `<button type="button" class="ticket-comment-edit-btn" data-comment-edit="${escapeHtml(key)}" aria-label="${escapeHtml(tt('تعديل التعليق', 'Edit comment'))}" title="${escapeHtml(tt('تعديل التعليق', 'Edit comment'))}">✎</button>`
        : "";
      const body = isEditing
        ? `
          <textarea class="ticket-comment-edit-input" rows="4">${escapeHtml(comment.text || "")}</textarea>
          <div class="ticket-comment-edit-actions">
            <button type="button" class="btn-primary" data-comment-save="${escapeHtml(key)}">${escapeHtml(tt("حفظ التعديل", "Save edit"))}</button>
            <button type="button" class="btn-secondary" data-comment-cancel="${escapeHtml(key)}">${escapeHtml(tt("إلغاء", "Cancel"))}</button>
          </div>
        `
        : `<div class="ticket-comment-text">${escapeHtml(comment.text || "").replace(/\n/g, "<br>")}</div>`;
      return `
        <article class="ticket-comment-card ${meta.cls}" data-comment-card="${escapeHtml(key)}">
          <div class="ticket-comment-top">
            <div class="ticket-comment-titleline">
              <span class="ticket-comment-type">${escapeHtml(label)}</span>
              ${editedLabel}
            </div>
            <div class="ticket-comment-actions-line">
              <span class="ticket-comment-meta">${escapeHtml(author)} • ${escapeHtml(fmtDate(comment.createdAt))}</span>
              ${editButton}
            </div>
          </div>
          ${body}
        </article>
      `;
    })
    .join("");
}

async function saveTicketCommentEdit(commentKey, nextText, btn = null) {
  const ticket = allTickets.find((x) => x.id === selectedTicketId);
  if (!ticket) return showTicketAlert(tt("اختر تذكرة أولاً.", "Select a ticket first."), true);
  if (!canAddTicketComment(ticket)) return showTicketAlert(tt("لا يمكنك تعديل تعليق على هذه التذكرة.", "You cannot edit a comment on this ticket."), true);

  const text = String(nextText || "").trim();
  if (!text) return showTicketAlert(tt("التعليق لا يمكن أن يكون فارغاً.", "Comment cannot be empty."), true);

  const existing = Array.isArray(ticket.comments) && ticket.comments.length ? ticket.comments : normaliseTicketComments(ticket);
  let changed = false;
  let previousText = "";
  const comments = existing.map((comment, index) => {
    const key = ticketCommentKey(comment, index);
    if (key !== String(commentKey)) return comment;
    if (!canEditTicketComment(ticket, comment)) return comment;
    changed = true;
    previousText = comment.text || "";
    return {
      ...comment,
      id: comment.id || key,
      text,
      editedAt: Date.now(),
      editedBy: currentUser?.id || "",
      editedByName: currentUser?.name || "",
    };
  });

  if (!changed) return showTicketAlert(tt("لم يتم العثور على التعليق أو لا تملك صلاحية تعديله.", "Comment was not found or you do not have permission to edit it."), true);
  if (previousText.trim() === text) {
    editingTicketCommentId = null;
    renderTicketComments(ticket);
    return;
  }

  const restoreBtn = setButtonSaving(btn, true, tt("جاري الحفظ...", "Saving..."));
  try {
    const update = {
      comments,
      updatedAt: serverTimestamp(),
      updatedBy: currentUser?.id || "",
      history: addHistory(ticket.history, `${tt("تعديل تعليق", "Edited comment")}: ${text.slice(0, 60)}`, currentUser?.id || ""),
    };
    await updateDoc(doc(db, TICKETS_COL, selectedTicketId), update);
    allTickets = allTickets.map((row) => row.id === selectedTicketId ? { ...row, ...update, comments, updatedAt: Date.now() } : row);
    editingTicketCommentId = null;
    renderTicketList();
    renderTicketDetail();
    showTicketAlert(tt("تم تعديل التعليق.", "Comment updated."));
  } catch (err) {
    console.error("saveTicketCommentEdit failed", err);
    showTicketAlert(`Failed to update comment: ${err?.code || err?.message || "unknown error"}`, true);
  } finally {
    restoreBtn();
  }
}


async function addTicketComment() {
  const ticket = allTickets.find((x) => x.id === selectedTicketId);
  if (!ticket) return showTicketAlert(tt("اختر تذكرة أولاً.", "Select a ticket first."), true);
  if (!canAddTicketComment(ticket)) return showTicketAlert(tt("لا يمكنك إضافة تعليق على هذه التذكرة.", "You cannot add a comment to this ticket."), true);

  const type = el("ticket-comment-type")?.value || "internal_note";
  const text = String(el("ticket-comment-text")?.value || "").trim();
  if (!text) return showTicketAlert(tt("اكتب تعليقاً قبل الحفظ.", "Write a comment before saving."), true);

  const btn = el("ticket-comment-add-btn");
  const restoreBtn = setButtonSaving(btn, true, tt("جاري الإضافة...", "Adding..."));
  const newComment = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    text,
    authorId: currentUser?.id || "",
    authorName: currentUser?.name || "",
    createdAt: Date.now(),
  };
  const existing = Array.isArray(ticket.comments) && ticket.comments.length ? ticket.comments : normaliseTicketComments(ticket);
  const comments = [...existing, newComment];

  try {
    const update = {
      comments,
      updatedAt: serverTimestamp(),
      updatedBy: currentUser?.id || "",
      history: addHistory(ticket.history, `${commentTypeMeta(type).en}: ${text.slice(0, 60)}`, currentUser?.id || ""),
    };
    await updateDoc(doc(db, TICKETS_COL, selectedTicketId), update);
    allTickets = allTickets.map((row) => row.id === selectedTicketId ? { ...row, ...update, comments, updatedAt: Date.now() } : row);
    if (el("ticket-comment-text")) el("ticket-comment-text").value = "";
    renderTicketList();
    renderTicketDetail();
    showTicketAlert(tt("تمت إضافة التعليق.", "Comment added."));
  } catch (err) {
    console.error("addTicketComment failed", err);
    showTicketAlert(`Failed to save comment: ${err?.code || err?.message || "unknown error"}`, true);
  } finally {
    restoreBtn();
  }
}

function renderTicketDetail() {
  const detail = el("ticket-detail");
  const empty = el("ticket-detail-empty");
  const t = allTickets.find((x) => x.id === selectedTicketId);

  if (!detail || !empty) return;
  if (!t || !canViewTicket(t)) {
    detail.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }

  detail.classList.remove("hidden");
  empty.classList.add("hidden");
  ensureTicketAccessNotice();

  const searchOnlyAccess = isTicketGlobalSearchHit(t);
  const manageFields = canManageTicketFields(t);
  const allowComments = canAddTicketComment(t);
  const accessNote = el('ticket-access-note');
  if (accessNote) {
    accessNote.classList.toggle('hidden', !searchOnlyAccess);
    accessNote.textContent = searchOnlyAccess
      ? tt('تم فتح هذه التذكرة من بحث الفريق. يمكنك قراءة التفاصيل وإضافة تعليقات متابعة، أما تغيير الحالة أو التعيين يبقى للمسؤول أو صاحب التذكرة.', 'Opened from team search. You can read details and add handling comments; status or assignment changes stay restricted to the owner or supervisor.')
      : '';
  }

  el("ticket-detail-title").textContent = `Ticket #${t.orderNumber || "—"}`;
  el("ticket-detail-sub").textContent = `${typeLabel(t.type) || t.type} • ${tt("تم الإنشاء", "Created")} ${fmtDate(t.createdAt)}`;

  const pill = el("ticket-detail-priority");
  if (pill) {
    pill.textContent = priorityLabelText(t.priority) || tt("عادي", "Normal");
    pill.className = `ticket-priority-pill ${t.priority || "normal"}`;
  }
  const syncPill = el("ticket-detail-shopify");
  if (syncPill) {
    const meta = shopifyStatusMeta(t);
    syncPill.textContent = meta[currentLang()] || meta.en;
    syncPill.className = `shopify-sync-pill ${meta.cls}`;
  }

  fillAssigneeSelect(el("ticket-detail-assigned"), true);
  el("ticket-detail-status").value = t.status || "open";
  el("ticket-detail-assigned").value = t.assignedTo || "";
  el("ticket-detail-priority-select").value = t.priority || "normal";
  el("ticket-detail-mood").value = t.customerMood || "calm";
  renderTicketComments(t);
  el("ticket-detail-resolution").value = t.resolution || "";

  const info = el("ticket-info-box");
  if (info) {
    const orderData = t.orderData || {};
    const hasShopifyData = Boolean(orderData.orderNumber || orderData.customerName || orderData.items || orderData.adminUrl || t.shopifyStatus);
    const img = orderData.imageUrl
      ? `<img class="shopify-product-thumb ticket-detail-img" src="${escapeHtml(orderData.imageUrl)}" alt="Product image" loading="lazy" />`
      : `<div class="shopify-product-thumb ticket-detail-img placeholder">No image</div>`;

    if (!hasShopifyData) {
      info.innerHTML = `<div class="ticket-shopify-empty">No linked Shopify order yet.</div>`;
    } else {
      info.innerHTML = `
        <section class="ticket-shopify-card ${chargebackSummary(ticketChargebackSource(t)).alert ? 'chargeback-active' : ''}">
          <div class="ticket-shopify-head">
            ${img}
            <div class="ticket-shopify-title-block">
              <div class="ticket-shopify-label">Linked Shopify Order</div>
              <h3>#${escapeHtml(t.orderNumber || orderData.orderNumber || "—")}</h3>
              <p>${escapeHtml(t.type ? (typeLabel(t.type) || t.type) : tt("تذكرة دعم", "Support ticket"))}</p>
              ${shopifyStatusPill(t)}
              ${chargebackBadge(ticketChargebackSource(t))}
            </div>
          </div>

          <div class="ticket-shopify-fields">
            <div class="field-card wide"><span>Customer</span><strong>${escapeHtml(t.customerName || orderData.customerName || "—")}</strong></div>
            <div class="field-card"><span>Email</span><strong>${escapeHtml(t.email || orderData.email || "—")}</strong></div>
            <div class="field-card"><span>Phone</span><strong>${escapeHtml(orderData.phone || "—")}</strong></div>
            <div class="field-card"><span>Postcode</span><strong>${escapeHtml(orderData.postcode || "—")}</strong></div>
            <div class="field-card"><span>Total</span><strong>${escapeHtml(orderData.totalPaid || "—")}</strong></div>
            <div class="field-card"><span>Payment</span><strong>${escapeHtml(orderData.paymentStatus || "—")}</strong></div>
            <div class="field-card chargeback-field ${chargebackSummary(ticketChargebackSource(t)).cls}"><span>${escapeHtml(disputeLabel())}</span>${chargebackDetailsHtml(ticketChargebackSource(t))}</div>
            <div class="field-card"><span>${escapeHtml(purchaseDateLabel())}</span><strong>${escapeHtml(fmtPurchaseDate(orderData.orderDate || t.orderDate))}</strong></div>
            <div class="field-card"><span>${escapeHtml(purchaseAgeLabel())}</span><strong>${escapeHtml(fmtPurchaseAge(orderData.orderDate || t.orderDate))}</strong></div>
            <div class="field-card"><span>Fulfilment</span><strong>${escapeHtml(orderData.orderالحالة || "—")}</strong></div>
            <div class="field-card"><span>Courier</span><strong>${escapeHtml(orderData.courier || "—")}</strong></div>
            <div class="field-card"><span>Tracking</span><strong>${escapeHtml(orderData.trackingNumber || "—")}</strong></div>
            <div class="field-card"><span>Risk</span><strong>${escapeHtml(t.risk || "normal")}</strong></div>
            <div class="field-card"><span>Updated</span><strong>${escapeHtml(fmtDate(t.updatedAt))}</strong></div>
            <div class="field-card wide items-card"><span>Items</span><pre>${escapeHtml(orderData.items || "—")}</pre></div>
          </div>

          <div class="ticket-shopify-actions">
            <button type="button" class="btn-secondary" data-detail-copy-postcode ${orderData.postcode ? "" : "disabled"}>Copy postcode</button>
            <button type="button" class="btn-secondary" data-detail-copy-tracking ${orderData.trackingNumber ? "" : "disabled"}>Copy tracking</button>
            <button type="button" class="btn-secondary" data-detail-copy-url ${orderData.trackingUrl ? "" : "disabled"}>Copy tracking URL</button>
            ${orderData.trackingUrl ? `<button type="button" class="btn-secondary" data-detail-open-tracking>Open tracking</button>` : ""}
            ${orderData.adminUrl ? `<button type="button" class="btn-secondary" data-detail-open-shopify>Open Shopify</button>` : ""}
          </div>
        </section>`;
    }

    info.querySelector("[data-detail-copy-postcode]")?.addEventListener("click", () => copyText(orderData.postcode, "Postcode copied."));
    info.querySelector("[data-detail-copy-tracking]")?.addEventListener("click", () => copyText(orderData.trackingNumber, "Tracking number copied."));
    info.querySelector("[data-detail-copy-url]")?.addEventListener("click", () => copyText(orderData.trackingUrl, "Tracking URL copied."));
    info.querySelector("[data-detail-open-tracking]")?.addEventListener("click", () => orderData.trackingUrl && window.open(orderData.trackingUrl, "_blank", "noopener"));
    info.querySelector("[data-detail-open-shopify]")?.addEventListener("click", () => orderData.adminUrl && window.open(orderData.adminUrl, "_blank", "noopener"));
  }

  const history = el("ticket-history-box");
  if (history) history.innerHTML = `${ticketTimelineHtml(t)}${customerHistoryHtml(t)}`;

  ["ticket-detail-status", "ticket-detail-assigned", "ticket-detail-priority-select", "ticket-detail-mood", "ticket-detail-resolution"].forEach((id) => {
    const node = el(id);
    if (node) node.disabled = !manageFields;
  });
  ["ticket-comment-type", "ticket-comment-text", "ticket-comment-add-btn"].forEach((id) => {
    const node = el(id);
    if (node) node.disabled = !allowComments;
  });
  if (el("ticket-save-btn")) el("ticket-save-btn").disabled = !manageFields;
  if (el("ticket-escalate-btn")) el("ticket-escalate-btn").disabled = !manageFields;
  if (el("ticket-delete-btn")) {
    el("ticket-delete-btn").classList.toggle("hidden", !canSoftDeleteTicket(t));
    el("ticket-delete-btn").disabled = !canSoftDeleteTicket(t);
    el("ticket-delete-btn").textContent = tt("حذف", "Delete");
  }
}

function hookUI() {
  if (isHooked) return;
  isHooked = true;
  ensureDeletedTicketsUI();
  el('ticket-deleted-toggle')?.addEventListener('click', openDeletedTicketsFolder);
  ensureTicketGlobalSearchUI();

  el("ticket-new-toggle")?.addEventListener("click", () => setTicketFormمفتوحة(true));

  el("ticket-form-close")?.addEventListener("click", () => setTicketFormمفتوحة(false));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el("ticket-form")?.classList.contains("hidden")) setTicketFormمفتوحة(false);
  });

  el("ticket-refresh-btn")?.addEventListener("click", () => {
    renderTicketList();
    renderTicketDetail();
    showTicketAlert(tt("تم تحديث قائمة التذاكر.", "Ticket queue refreshed."));
  });

  el("ticket-type")?.addEventListener("change", () => {
    const type = el("ticket-type")?.value;
    const priority = el("ticket-priority");
    if (priority && EMERGENCY_TYPES.has(type)) priority.value = "emergency";
  });

  el("shopify-api-key-btn")?.addEventListener("click", setShopifyApiKey);
  el("shopify-live-search-btn")?.addEventListener("click", () => searchShopifyLive());
  el("shopify-live-use-btn")?.addEventListener("click", useLiveOrderInTicket);
  el("shopify-live-query")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); searchShopifyLive(); }
  });

  el("ticket-autofill-btn")?.addEventListener("click", async () => {
    const order = normaliseالطلبNumber(el("ticket-order")?.value);
    if (!order) return showTicketAlert("Enter an order number first.", true);
    if (el("shopify-live-query")) el("shopify-live-query").value = order;
    const live = await searchShopifyLive({ useInTicket: true });
    if (live) return;
    const cached = await getCachedالطلب(order);
    if (cached) {
      currentLiveOrder = cached;
      currentLiveOrderFirebaseStatus = "saved";
      if (el("ticket-customer")) el("ticket-customer").value = cached.customerName || "";
      if (el("ticket-email")) el("ticket-email").value = cached.email || "";
      renderالطلبPreview(cached);
      renderShopifyLiveResult(cached, "saved");
      showTicketAlert("Loaded from Firebase orderRecords.");
      return;
    }
    renderالطلبPreview(null);
    showTicketAlert("No Shopify/Firebase order found. You can still create a manual ticket.", true);
  });

  el("ticket-order")?.addEventListener("blur", async () => {
    const order = normaliseالطلبNumber(el("ticket-order")?.value);
    if (!order) return renderالطلبPreview(null);
    renderالطلبPreview(await getCachedالطلب(order));
  });

  el("order-admin-toggle")?.addEventListener("click", () => {
    el("order-cache-form")?.classList.toggle("hidden");
  });

  el("order-cache-load")?.addEventListener("click", loadالطلبCacheForm);

  el("order-cache-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await saveالطلبCacheForm();
  });

  el("ticket-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await createTicket();
  });

  ["ticket-filter-status", "ticket-filter-priority", "ticket-filter-owner"].forEach((id) => {
    const node = el(id);
    node?.addEventListener("input", renderTicketList);
    node?.addEventListener("change", renderTicketList);
  });

  const ticketSearch = el("ticket-search");
  ticketSearch?.addEventListener("input", () => {
    renderTicketList();
    scheduleTeamTicketSearch();
  });
  ticketSearch?.addEventListener("change", () => {
    renderTicketList();
    scheduleTeamTicketSearch();
  });

  el("ticket-save-btn")?.addEventListener("click", saveSelectedTicket);
  el("ticket-comment-add-btn")?.addEventListener("click", addTicketComment);
  el("ticket-comments-list")?.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const editBtn = target.closest("[data-comment-edit]");
    if (editBtn) {
      editingTicketCommentId = editBtn.getAttribute("data-comment-edit") || "";
      const ticket = allTickets.find((x) => x.id === selectedTicketId);
      if (ticket) renderTicketComments(ticket);
      return;
    }
    const cancelBtn = target.closest("[data-comment-cancel]");
    if (cancelBtn) {
      editingTicketCommentId = null;
      const ticket = allTickets.find((x) => x.id === selectedTicketId);
      if (ticket) renderTicketComments(ticket);
      return;
    }
    const saveBtn = target.closest("[data-comment-save]");
    if (saveBtn) {
      const card = saveBtn.closest(".ticket-comment-card");
      const input = card?.querySelector(".ticket-comment-edit-input");
      saveTicketCommentEdit(saveBtn.getAttribute("data-comment-save") || "", input?.value || "", saveBtn);
    }
  });
  el("ticket-comment-text")?.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      addTicketComment();
    }
  });
  el("ticket-delete-btn")?.addEventListener("click", softDeleteSelectedTicket);
  el("ticket-escalate-btn")?.addEventListener("click", async () => {
    if (!selectedTicketId) return;
    const btn = el("ticket-escalate-btn");
    const restoreEscalateBtn = setButtonSaving(btn, true, "Escalating...");
    try {
      const update = {
        status: "escalated",
        priority: "emergency",
        risk: "chargeback",
        updatedAt: serverTimestamp(),
        escalatedAt: serverTimestamp(),
        escalatedBy: currentUser?.id || "",
        history: addHistory(allTickets.find((x) => x.id === selectedTicketId)?.history, "مصعّدة to manager", currentUser?.id || ""),
      };
      await updateDoc(doc(db, TICKETS_COL, selectedTicketId), update);
      allTickets = allTickets.map((row) => row.id === selectedTicketId ? { ...row, ...update, updatedAt: Date.now() } : row);
      renderTicketList();
      renderTicketDetail();
      showTicketAlert("Ticket escalated to manager.");
    } catch (err) {
      console.error("escalate failed", err);
      showTicketAlert(`Failed to save: ${err?.code || err?.message || "unknown error"}`, true);
    } finally {
      restoreEscalateBtn();
    }
  });
}

async function createTicket() {
  if (!currentUser) return;
  const createBtn = document.querySelector('#ticket-form button[type="submit"]');
  const restoreCreateBtn = setButtonSaving(createBtn, true, "جاري الإنشاء...");
  const orderNumber = normaliseالطلبNumber(el("ticket-order")?.value);
  if (!orderNumber) {
    showTicketAlert("رقم الطلب مطلوب.", true);
    restoreCreateBtn();
    return;
  }

  const activeDuplicate = await findActiveDuplicateTicket(orderNumber);
  if (activeDuplicate) {
    selectedTicketId = activeDuplicate.id;
    setTicketFormمفتوحة(false);
    renderTicketList();
    renderTicketDetail();
    showTicketAlert(tt("هذه التذكرة موجودة بالفعل. تم فتح التذكرة الموجودة بدلاً من إنشاء تكرار.", "This ticket already exists. The existing ticket was opened instead of creating a duplicate."), true);
    restoreCreateBtn();
    return;
  }
  const deletedDuplicate = await findDeletedDuplicateTicket(orderNumber);
  if (deletedDuplicate) {
    showTicketAlert(tt("توجد تذكرة محذوفة بنفس رقم الطلب. اطلب من المشرف استعادتها بدلاً من إنشاء تكرار.", "A deleted ticket already exists with this order number. Ask a supervisor to restore it instead of creating a duplicate."), true);
    restoreCreateBtn();
    return;
  }

  const type = el("ticket-type")?.value || "general_question";
  const priority = el("ticket-priority")?.value || inferالأولوية(type);
  const assignedTo = canEditAll(currentUser)
    ? (el("ticket-assigned")?.value || "")
    : currentUser.id;
  const cachedFromDb = await getCachedالطلب(orderNumber);
  const cachedالطلب = (currentLiveOrder && currentLiveOrder.orderNumber === orderNumber) ? currentLiveOrder : cachedFromDb;

  const initialNote = el("ticket-notes")?.value?.trim() || "";
  const initialComments = initialNote ? [{
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: "internal_note",
    text: initialNote,
    authorId: currentUser.id,
    authorName: currentUser.name,
    createdAt: Date.now(),
  }] : [];

  const payload = {
    orderNumber,
    type,
    priority,
    status: priority === "emergency" ? "open" : "open",
    assignedTo,
    createdBy: currentUser.id,
    createdByName: currentUser.name,
    customerName: el("ticket-customer")?.value?.trim() || cachedالطلب?.customerName || "",
    email: el("ticket-email")?.value?.trim() || cachedالطلب?.email || "",
    notes: initialNote,
    comments: initialComments,
    resolution: "",
    customerMood: inferMood(type, priority),
    risk: riskFromTypeAndالطلب(type, cachedالطلب),
    source: cachedالطلب?.source || (cachedالطلب ? "order_cache" : "manual"),
    shopifyStatus: cachedالطلب ? "synced" : "failed",
    shopifyStatusLabel: cachedالطلب ? "Synced with Shopify" : "Failed to load from Shopify",
    orderData: cachedالطلب ? {
      customerName: cachedالطلب.customerName || "",
      email: cachedالطلب.email || "",
      phone: cachedالطلب.phone || "",
      postcode: cachedالطلب.postcode || "",
      items: cachedالطلب.items || "",
      totalPaid: cachedالطلب.totalPaid || "",
      orderDate: cachedالطلب.orderDate || "",
      courier: cachedالطلب.courier || "",
      trackingNumber: cachedالطلب.trackingNumber || "",
      orderالحالة: cachedالطلب.orderالحالة || "unknown",
      deliveryالحالة: cachedالطلب.deliveryالحالة || "unknown",
      shippingAddress: cachedالطلب.shippingAddress || "",
      billingAddress: cachedالطلب.billingAddress || "",
      imageUrl: cachedالطلب.imageUrl || "",
      trackingUrl: cachedالطلب.trackingUrl || "",
      paymentStatus: cachedالطلب.paymentStatus || "",
      adminUrl: cachedالطلب.adminUrl || "",
      itemList: cachedالطلب.itemList || [],
      refunds: cachedالطلب.refunds || [],
      disputes: cachedالطلب.disputes || [],
      chargebackStatus: cachedالطلب.chargebackStatus || "",
    } : {},
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    history: addHistory([], `Created ticket (${typeLabel(type) || type})`, currentUser.id),
  };

  try {
    const created = await addDoc(collection(db, TICKETS_COL), payload);
    selectedTicketId = created.id;
    el("ticket-form")?.reset();
    renderالطلبPreview(null);
    currentLiveOrder = null;
    renderShopifyLiveResult(null);
    fillAssigneeSelect(el("ticket-assigned"), true);
    setTicketFormمفتوحة(false);
    showTicketAlert(cachedالطلب ? "تم إنشاء التذكرة وربطها ببيانات Shopify." : "تم إنشاء التذكرة، لكن لم يتم العثور على بيانات Shopify لهذا الطلب.", !cachedالطلب);
  } catch (err) {
    console.error("createTicket failed", err);
    showTicketAlert(`Ticket could not be created: ${err?.code || err?.message || "check Firestore permissions/internet"}`, true);
  } finally {
    restoreCreateBtn();
  }
}

async function loadالطلبCacheForm() {
  const order = normaliseالطلبNumber(el("order-cache-number")?.value);
  if (!order) return showTicketAlert("Enter order number to load.", true);
  const data = await getCachedالطلب(order);
  if (!data) return showTicketAlert("No order cache found for this number.", true);
  el("order-cache-customer").value = data.customerName || "";
  el("order-cache-email").value = data.email || "";
  el("order-cache-phone").value = data.phone || "";
  el("order-cache-total").value = data.totalPaid || "";
  el("order-cache-date").value = data.orderDate || "";
  el("order-cache-courier").value = data.courier || "";
  el("order-cache-tracking").value = data.trackingNumber || "";
  el("order-cache-status").value = data.orderالحالة || "unknown";
  el("order-cache-delivery").value = data.deliveryالحالة || "unknown";
  el("order-cache-items").value = data.items || "";
  el("order-cache-address").value = data.shippingAddress || "";
  el("order-cache-notes").value = data.notes || "";
  showTicketAlert("الطلب cache loaded.");
}

async function saveالطلبCacheForm() {
  if (!canManageالطلبCache(currentUser)) return showTicketAlert("Only supervisor, manager, or admin can save order cache.", true);
  const orderNumber = normaliseالطلبNumber(el("order-cache-number")?.value);
  if (!orderNumber) return showTicketAlert("الطلب number is required.", true);
  const payload = {
    orderNumber,
    customerName: cleanText(el("order-cache-customer")?.value),
    email: cleanText(el("order-cache-email")?.value),
    phone: cleanText(el("order-cache-phone")?.value),
    totalPaid: cleanText(el("order-cache-total")?.value),
    orderDate: cleanText(el("order-cache-date")?.value),
    courier: cleanText(el("order-cache-courier")?.value),
    trackingNumber: cleanText(el("order-cache-tracking")?.value),
    orderالحالة: el("order-cache-status")?.value || "unknown",
    deliveryالحالة: el("order-cache-delivery")?.value || "unknown",
    items: cleanText(el("order-cache-items")?.value),
    shippingAddress: cleanText(el("order-cache-address")?.value),
    notes: cleanText(el("order-cache-notes")?.value),
    updatedAt: serverTimestamp(),
    updatedBy: currentUser?.id || "",
    updatedByName: currentUser?.name || "",
  };
  const existing = await getCachedالطلب(orderNumber);
  if (!existing) payload.createdAt = serverTimestamp();
  try {
    await setDoc(orderDocRef(orderNumber), payload, { merge: true });
    showTicketAlert("Saved successfully.");
  } catch (err) {
    console.error("save order cache failed", err);
    showTicketAlert(`Failed to save: ${err?.code || err?.message || "unknown error"}`, true);
  } finally {
    restoreCacheBtn();
  }
}

async function saveSelectedTicket() {
  const t = allTickets.find((x) => x.id === selectedTicketId);
  if (!t) return showTicketAlert("Select a ticket first.", true);
  const saveBtn = el("ticket-save-btn");
  const restoreSaveBtn = setButtonSaving(saveBtn, true, "جاري الحفظ...");

  const status = el("ticket-detail-status")?.value || "open";
  const assignedTo = el("ticket-detail-assigned")?.value || "";
  const priority = el("ticket-detail-priority-select")?.value || "normal";
  const customerMood = el("ticket-detail-mood")?.value || "calm";
  const resolution = el("ticket-detail-resolution")?.value || "";
  const update = {
    status,
    assignedTo,
    priority,
    customerMood,
    resolution,
    updatedAt: serverTimestamp(),
    updatedBy: currentUser?.id || "",
    history: addHistory(t.history, `Saved changes: status ${statusLabelText(status) || status}, priority ${priorityLabelText(priority) || priority}`, currentUser?.id || ""),
  };
  if (status === "resolved" || status === "closed") {
    update.resolvedAt = serverTimestamp();
    update.resolvedBy = currentUser?.id || "";
  }

  try {
    await updateDoc(doc(db, TICKETS_COL, selectedTicketId), update);
    allTickets = allTickets.map((row) => row.id === selectedTicketId ? { ...row, ...update, updatedAt: Date.now() } : row);
    renderTicketList();
    renderTicketDetail();
    showTicketAlert("Saved successfully.");
  } catch (err) {
    console.error("saveSelectedTicket failed", err);
    showTicketAlert(`فشل الحفظ: ${err?.code || err?.message || "تحقق من صلاحيات Firestore أو الاتصال"}`, true);
  } finally {
    restoreSaveBtn();
  }
}

function subscribeDeletedTickets() {
  if (unsubDeletedTickets) unsubDeletedTickets();
  if (!canAccessDeletedTickets(currentUser)) {
    deletedTickets = [];
    renderDeletedTicketsList();
    return;
  }
  const q = query(collection(db, DELETED_TICKETS_COL), orderBy("deletedAt", "desc"));
  unsubDeletedTickets = onSnapshot(q, (snapshot) => {
    deletedTickets = [];
    snapshot.forEach((d) => deletedTickets.push({ id: d.id, ...d.data() }));
    renderDeletedTicketsList();
  }, (err) => {
    console.error("deleted tickets snapshot error", err);
    showTicketAlert(tt("تعذر تحميل المحذوفات. تحقق من صلاحيات Firestore.", "Could not load deleted tickets. Check Firestore permissions."), true);
  });
}

function subscribeTickets() {
  if (unsubTickets) {
    try { unsubTickets(); } catch {}
  }

  ticketScopeMaps = new Map();
  ticketTeamSearchMap = new Map();
  teamSearchIndexLoaded = false;
  teamSearchIndexLoading = false;
  teamSearchIndexPromise = null;
  teamSearchIndexLoadedAt = 0;
  mergeTicketMaps();

  const sources = ticketListenSourcesForUser(currentUser);
  if (!sources.length) {
    setTicketsInlineLoading(false);
    renderTicketList();
    renderTicketDetail();
    return;
  }

  setTicketsInlineLoading(true, ticketLoadMessage('تحميل قائمة التذاكر حسب صلاحية هذا الحساب…', 'Loading the ticket queue for this account…'));
  emitTicketLoadEvent('loading', {
    percent: 84,
    message: ticketLoadMessage('تحميل تذاكر هذا الموظف فقط لتسريع الأجهزة الضعيفة…', 'Loading only this staff member’s scoped tickets for faster startup…'),
  });

  clearTicketSlowTimer();
  ticketLoadSlowTimer = setTimeout(() => {
    if (!ticketsInitialLoading) return;
    setTicketsInlineLoading(true, ticketLoadMessage('الاتصال أو صلاحيات Firestore تأخرت. يمكنك الانتظار أو إعادة المحاولة.', 'Connection or Firestore permissions are taking longer than normal. You can wait or retry.'), true);
    emitTicketLoadEvent('loading', {
      percent: 92,
      message: ticketLoadMessage('التذاكر تأخرت أكثر من المعتاد على هذا الجهاز…', 'Tickets are taking longer than normal on this device…'),
    });
  }, 10_000);

  let loadedScopes = 0;
  let initialReadyEmitted = false;
  const unsubs = sources.map(({ key, source }) => onSnapshot(source, (snapshot) => {
    const map = new Map();
    snapshot.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }));
    if (!ticketScopeMaps.has(key)) loadedScopes += 1;
    ticketScopeMaps.set(key, map);

    mergeTicketMaps();
    if (selectedTicketId && !allTickets.some((t) => t.id === selectedTicketId)) selectedTicketId = null;

    if (!initialReadyEmitted && loadedScopes >= sources.length) {
      initialReadyEmitted = true;
      clearTicketSlowTimer();
      ticketsInitialLoading = false;
      ticketsLoadingSlow = false;
      ticketsLoadingMessage = '';
      emitTicketLoadEvent('ready', {
        count: allTickets.length,
        message: ticketLoadMessage(`تم تحميل ${allTickets.length} تذكرة.`, `Loaded ${allTickets.length} ticket(s).`),
      });
      queueTeamSearchIndexWarmup(1200);
    }

    renderTicketList();
    renderTicketDetail();
  }, (err) => {
    console.error('tickets snapshot error', err);
    showTicketAlert(tt('تعذر تحميل التذاكر. تحقق من صلاحيات Firestore أو الاتصال.', 'Could not load tickets. Check Firestore rules or connection.'), true);
    emitTicketLoadEvent('error', {
      message: `${tt('تعذر تحميل التذاكر:', 'Could not load tickets:')} ${err?.code || err?.message || 'unknown error'}`,
    });
    clearTicketSlowTimer();
    ticketsInitialLoading = false;
    ticketsLoadingSlow = false;
    renderTicketList();
  }));

  unsubTickets = () => {
    clearTicketSlowTimer();
    if (teamSearchTimer) clearTimeout(teamSearchTimer);
    unsubs.forEach((fn) => { try { fn(); } catch {} });
    ticketScopeMaps = new Map();
    ticketTeamSearchMap = new Map();
    teamSearchLoading = false;
    teamSearchIndexLoaded = false;
    teamSearchIndexLoading = false;
    teamSearchIndexPromise = null;
    teamSearchIndexLoadedAt = 0;
    ticketsInitialLoading = false;
    ticketsLoadingSlow = false;
  };
}


function initTickets() {
  currentUser = getCurrentUser();
  hookUI();
  translateTicketsStatic();
  fillAssigneeSelect(el("ticket-assigned"), true);
  fillAssigneeSelect(el("ticket-detail-assigned"), true);
  el("order-admin-panel")?.classList.remove("hidden");

  if (!currentUser) {
    allTickets = [];
    ticketScopeMaps = new Map();
    ticketTeamSearchMap = new Map();
    teamSearchLoading = false;
    teamSearchIndexLoaded = false;
    teamSearchIndexLoading = false;
    teamSearchIndexPromise = null;
    teamSearchIndexLoadedAt = 0;
    ticketsInitialLoading = false;
    clearTicketSlowTimer();
    renderTicketList();
    updateTicketGlobalSearchUI([]);
    renderTicketDetail();
    if (unsubTickets) unsubTickets();
    if (unsubDeletedTickets) unsubDeletedTickets();
    unsubTickets = null;
    unsubDeletedTickets = null;
    ensureDeletedTicketsUI();
    return;
  }

  ensureDeletedTicketsUI();
  subscribeTickets();
  subscribeDeletedTickets();
}

document.addEventListener("DOMContentLoaded", initTickets);
window.addEventListener("telesyriana:user-changed", initTickets);

try { window.addEventListener("telesyriana:language-changed", () => { translateTicketsStatic(); fillAssigneeSelect(el("ticket-assigned"), true); fillAssigneeSelect(el("ticket-detail-assigned"), true); renderTicketList(); renderTicketDetail(); renderDeletedTicketsList(); }); } catch {}
