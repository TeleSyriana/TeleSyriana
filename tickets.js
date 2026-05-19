// tickets.js — TeleSyriana Phase 2 Ticket System
// Firestore collection: tickets
// Small, support-focused workflow: emergency queue, order issues, returns, escalations.

import { db, fs } from "./firebase.js";

const {
  collection,
  addDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  doc,
  updateDoc,
  setDoc,
  getDoc,
} = fs;

const USER_KEY = "telesyrianaUser";
const TICKETS_COL = "tickets";
const ORDER_RECORDS_COL = "orderRecords";

const ROLE_LEVELS = { agent: 1, supervisor: 2, manager: 3, admin: 4 };
const STAFF = {
  "0001": { id: "0001", name: "Agent Raghad", role: "agent", supervisorId: "1001" },
  "0002": { id: "0002", name: "Agent Qamar", role: "agent", supervisorId: "1001" },
  "0003": { id: "0003", name: "Agent", role: "agent", supervisorId: "1001" },
  "1001": { id: "1001", name: "Supervisor Dema", role: "supervisor" },
  "2001": { id: "2001", name: "Manager Mohammad", role: "manager" },
  "9001": { id: "9001", name: "Owner Admin", role: "admin" },
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
  address_change: "Address Change",
  product_not_arrived: "Product Not Arrived",
  item_not_genuine: "Item Not Genuine / Fake Claim",
  return: "Return",
  exchange: "Exchange",
  angry_customer: "Angry العميل",
  refund_request: "Refund Request",
  chargeback_risk: "Chargeback Risk",
  general_question: "General Question",
};

const STATUS_LABELS = {
  open: "مفتوحة",
  waiting_customer: "بانتظار العميل",
  waiting_courier: "بانتظار الشحن",
  waiting_supplier: "بانتظار المورد",
  escalated: "مصعّدة",
  resolved: "محلولة",
  closed: "مغلقة",
};

const PRIORITY_LABELS = {
  emergency: "طارئ",
  high: "عالي",
  medium: "متوسط",
  normal: "عادي",
};

let currentUser = null;
let allTickets = [];
let selectedTicketId = null;
let unsubTickets = null;
let isHooked = false;
let lastLiveShopifyOrder = null;
const sessionShopifyOrders = new Map();

const DEFAULT_SHOPIFY_BACKEND_URL = "https://telesyriana-backend.onrender.com";
const SHOPIFY_BACKEND_URL_KEY = "telesyrianaShopifyBackendUrl";
const SHOPIFY_API_KEY_STORAGE = "telesyrianaShopifyApiKey";

function el(id) { return document.getElementById(id); }
function roleLevel(u) { return ROLE_LEVELS[String(u?.role || "").toLowerCase()] || 0; }
function canSeeAll(u) { return roleLevel(u) >= ROLE_LEVELS.manager; }
function canSupervise(u) { return roleLevel(u) >= ROLE_LEVELS.supervisor; }
function canEditAll(u) { return roleLevel(u) >= ROLE_LEVELS.supervisor; }

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

function canViewTicket(ticket) {
  if (!currentUser) return false;
  if (canSeeAll(currentUser)) return true;
  if (currentUser.role === "supervisor") {
    if (ticket.assignedTo === currentUser.id || ticket.createdBy === currentUser.id) return true;
    const assigned = STAFF[ticket.assignedTo];
    return assigned?.supervisorId === currentUser.id || !ticket.assignedTo;
  }
  return ticket.assignedTo === currentUser.id || ticket.createdBy === currentUser.id;
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

async function copyText(value, label = "Text") {
  const text = String(value || "").trim();
  if (!text) {
    showTicketAlert(`${label} is empty.`, true);
    return false;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const temp = document.createElement("textarea");
      temp.value = text;
      temp.setAttribute("readonly", "");
      temp.style.position = "fixed";
      temp.style.left = "-9999px";
      document.body.appendChild(temp);
      temp.select();
      document.execCommand("copy");
      temp.remove();
    }
    showTicketAlert(`${label} copied.`);
    return true;
  } catch (err) {
    console.error("copyText failed", err);
    showTicketAlert(`Could not copy ${label}.`, true);
    return false;
  }
}

function copyButton(value, label, text = "Copy") {
  const safeValue = escapeHtml(value || "");
  const safeLabel = escapeHtml(label || "Text");
  const disabled = value ? "" : " disabled";
  return `<button type="button" class="tiny-copy-btn" data-copy="${safeValue}" data-copy-label="${safeLabel}"${disabled}>${escapeHtml(text)}</button>`;
}

function statusChip(value, label = "Status") {
  const raw = String(value || "unknown");
  return `<span class="status-chip status-${escapeHtml(raw.toLowerCase())}"><b>${escapeHtml(label)}:</b> ${escapeHtml(raw || "—")}</span>`;
}

function getShopifyBackendUrl() {
  return (localStorage.getItem(SHOPIFY_BACKEND_URL_KEY) || DEFAULT_SHOPIFY_BACKEND_URL).replace(/\/+$/, "");
}

function getShopifyApiKey() {
  return localStorage.getItem(SHOPIFY_API_KEY_STORAGE) || "";
}

function setShopifyApiKey() {
  const existing = getShopifyApiKey();
  const value = window.prompt("Enter TeleSyriana backend API key. It will be saved only in this browser.", existing);
  if (value === null) return false;
  const clean = value.trim();
  if (!clean) {
    localStorage.removeItem(SHOPIFY_API_KEY_STORAGE);
    showTicketAlert("Shopify API key cleared.");
    return false;
  }
  localStorage.setItem(SHOPIFY_API_KEY_STORAGE, clean);
  showTicketAlert("Shopify API key saved in this browser.");
  return true;
}

function normaliseShopifyStatus(v) {
  const s = String(v || "").toLowerCase();
  if (s.includes("fulfilled") || s === "success") return "fulfilled";
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("refund")) return "refunded";
  if (s.includes("progress") || s.includes("partial")) return "processing";
  if (s.includes("unfulfilled") || s.includes("open")) return "unfulfilled";
  return s || "unknown";
}

function moneyText(money) {
  if (!money) return "";
  const amount = money.amount ?? money.total ?? "";
  const currency = money.currency || money.currencyCode || "";
  return [amount, currency].filter(Boolean).join(" ").trim();
}

function addressText(address) {
  if (!address) return "";
  return [
    address.firstName, address.lastName, address.company, address.address1, address.address2,
    address.city, address.province, address.zip, address.country, address.phone
  ].filter(Boolean).join(", ");
}

function firstTracking(order) {
  const fulfilment = (order.fulfillments || []).find((f) => Array.isArray(f.tracking) && f.tracking.length) || (order.fulfillments || [])[0];
  const tracking = fulfilment?.tracking?.[0] || {};
  return {
    number: tracking.number || "",
    url: tracking.url || "",
    company: tracking.company || "",
  };
}

function normaliseShopifyOrder(apiOrder) {
  if (!apiOrder) return null;
  const order = apiOrder.order || {};
  const customer = apiOrder.customer || {};
  const tracking = firstTracking(apiOrder);
  const itemsList = (apiOrder.items || []).map((item) => ({
    title: item.title || "Item",
    variant: item.variant && item.variant !== "Default Title" ? item.variant : "",
    quantity: item.quantity || 1,
    sku: item.sku || "",
    imageUrl: item.image_url || item.imageUrl || "",
    productTitle: item.product_title || item.productTitle || "",
  }));
  const items = itemsList.map((item) => {
    const variant = item.variant ? ` - ${item.variant}` : "";
    const qty = item.quantity ? ` x${item.quantity}` : "";
    return `${item.title || "Item"}${variant}${qty}`;
  }).join(" | ");
  const imageUrl = itemsList.find((item) => item.imageUrl)?.imageUrl || "";
  const orderNumber = normaliseالطلبNumber(order.number || apiOrder.order_number || "");
  return {
    orderNumber,
    customerName: customer.name || "",
    email: customer.email || "",
    phone: customer.phone || apiOrder.shipping_address?.phone || "",
    totalPaid: moneyText(order.total_paid),
    orderDate: order.created_at ? String(order.created_at).slice(0, 10) : "",
    courier: tracking.company || "",
    trackingNumber: tracking.number || "",
    trackingUrl: tracking.url || "",
    orderالحالة: normaliseShopifyStatus(order.fulfillment_status || order.payment_status),
    deliveryالحالة: tracking.number ? "in_transit" : "unknown",
    paymentStatus: order.payment_status || "",
    fulfillmentStatus: order.fulfillment_status || "",
    items,
    itemsList,
    imageUrl,
    shippingAddress: addressText(apiOrder.shipping_address),
    billingAddress: addressText(apiOrder.billing_address),
    notes: "",
    adminUrl: apiOrder.admin_url || "",
    refundsCount: Array.isArray(apiOrder.refunds) ? apiOrder.refunds.length : 0,
    source: "shopify_live",
    raw: apiOrder,
  };
}

function rememberSessionOrder(order) {
  if (!order?.orderNumber) return;
  sessionShopifyOrders.set(normaliseالطلبNumber(order.orderNumber), order);
  lastLiveShopifyOrder = order;
}

function getSessionOrder(orderNumber) {
  return sessionShopifyOrders.get(normaliseالطلبNumber(orderNumber)) || null;
}

async function syncShopifyOrderToFirebase(order) {
  if (!order?.orderNumber) return false;
  const ref = orderDocRef(order.orderNumber);
  if (!ref) return false;
  const payload = {
    ...order,
    source: "shopify_live",
    shopifyStatus: "synced",
    shopifyStatusLabel: "Synced with Shopify",
    syncedFromShopifyAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: currentUser?.id || "shopify_lookup",
  };
  // Avoid storing an unnecessarily huge raw Shopify object in the live cache.
  delete payload.raw;
  await setDoc(ref, payload, { merge: true });
  return true;
}

async function getBestOrderData(orderNumber) {
  return getSessionOrder(orderNumber) || await getCachedالطلب(orderNumber);
}

async function fetchShopifyOrder(queryValue) {
  const queryText = cleanText(queryValue);
  if (!queryText) throw new Error("Enter an order number, email, phone, or customer name.");
  let apiKey = getShopifyApiKey();
  if (!apiKey) {
    const saved = setShopifyApiKey();
    if (!saved) throw new Error("Backend API key is required for Shopify lookup.");
    apiKey = getShopifyApiKey();
  }
  const url = `${getShopifyBackendUrl()}/api/search-orders?q=${encodeURIComponent(queryText)}`;
  const res = await fetch(url, { headers: { "x-api-key": apiKey } });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    throw new Error(data?.details || data?.error || `Shopify lookup failed (${res.status})`);
  }
  const first = (data.orders || [])[0];
  return { data, order: normaliseShopifyOrder(first) };
}

function renderShopifyLiveResult(order, message = "") {
  const box = el("shopify-live-result");
  const useBtn = el("shopify-live-use-ticket");
  if (!box) return;
  if (!order) {
    box.className = "shopify-live-result muted";
    box.textContent = message || "No Shopify order loaded yet.";
    if (useBtn) useBtn.disabled = true;
    return;
  }
  const trackingActions = `
    <div class="shopify-actions-line">
      ${copyButton(order.trackingNumber, "Tracking number", "Copy tracking")}
      ${copyButton(order.trackingUrl, "Tracking URL", "Copy tracking URL")}
      ${order.trackingUrl ? `<a class="mini-link" href="${escapeHtml(order.trackingUrl)}" target="_blank" rel="noopener">Open tracking</a>` : ""}
      ${order.adminUrl ? `<a class="mini-link" href="${escapeHtml(order.adminUrl)}" target="_blank" rel="noopener">Open Shopify</a>` : ""}
    </div>`;

  box.className = "shopify-live-result";
  box.innerHTML = `
    <div class="shopify-live-result-inner">
      ${order.imageUrl ? `<img class="shopify-live-image" src="${escapeHtml(order.imageUrl)}" alt="${escapeHtml(order.items || "Shopify product")}" loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('hidden')">` : `<div class="shopify-live-image empty">No image</div>`}
      <div class="shopify-live-copy">
        <div class="shopify-live-title">#${escapeHtml(order.orderNumber)} • ${escapeHtml(order.customerName || "No customer name")}</div>
        <div class="shopify-live-save-line ${order.firebaseSynced ? "ok" : "warn"}">
          ${order.firebaseSynced ? "✅ Saved to Firebase orderRecords" : "⚠️ Loaded from Shopify but not saved to Firebase"}
        </div>
        <div class="shopify-live-grid-result">
          <span><b>Email:</b> ${escapeHtml(order.email || "—")}</span>
          <span><b>Phone:</b> ${escapeHtml(order.phone || "—")}</span>
          <span><b>Total:</b> ${escapeHtml(order.totalPaid || "—")}</span>
          <span>${statusChip(order.paymentStatus || "—", "Payment")}</span>
          <span>${statusChip(order.fulfillmentStatus || "—", "Fulfilment")}</span>
          <span><b>Courier:</b> ${escapeHtml(order.courier || "—")}</span>
          <span><b>Tracking:</b> ${escapeHtml(order.trackingNumber || "—")}</span>
          <span><b>Order date:</b> ${escapeHtml(order.orderDate || "—")}</span>
          <span><b>Refunds:</b> ${escapeHtml(String(order.refundsCount || 0))}</span>
        </div>
        <div class="shopify-live-items"><b>Items:</b> ${escapeHtml(order.items || "—")}</div>
        ${trackingActions}
      </div>
    </div>
  `;
  if (useBtn) useBtn.disabled = false;
}

function applyOrderToTicketForm(order) {
  if (!order) return;
  rememberSessionOrder(order);
  if (el("ticket-order")) el("ticket-order").value = order.orderNumber || "";
  if (el("ticket-customer")) el("ticket-customer").value = order.customerName || "";
  if (el("ticket-email")) el("ticket-email").value = order.email || "";
  renderالطلبPreview(order);
  setTicketFormمفتوحة(true);
  showTicketAlert(`Order #${order.orderNumber} applied to the ticket form. Details are saved as structured order data, not dumped into notes.`);
}

async function searchAndApplyShopifyOrder(queryValue, applyToTicket = false) {
  const { data, order } = await fetchShopifyOrder(queryValue);
  if (!order) {
    renderShopifyLiveResult(null, `No Shopify orders found. Query used: ${data?.query_used || queryValue}`);
    showTicketAlert("No Shopify order found for this search.", true);
    return null;
  }
  rememberSessionOrder(order);
  try {
    order.firebaseSynced = await syncShopifyOrderToFirebase(order);
    if (order.firebaseSynced) rememberSessionOrder(order);
  } catch (err) {
    console.warn("Shopify order loaded but Firebase sync failed", err);
    order.firebaseSynced = false;
  }
  renderShopifyLiveResult(order);
  if (applyToTicket) applyOrderToTicketForm(order);
  showTicketAlert(order.firebaseSynced
    ? `Shopify order #${order.orderNumber} loaded and synced to Firebase.`
    : `Shopify order #${order.orderNumber} loaded. Firebase sync failed/check rules.`);
  return order;
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
  body.innerHTML = `
    <div class="order-preview-card">
      ${order.imageUrl ? `<img class="ticket-order-image" src="${escapeHtml(order.imageUrl)}" alt="${escapeHtml(order.items || "Order product")}" loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('hidden')">` : `<div class="ticket-order-image empty">No image</div>`}
      <div class="order-preview-main">
        <div class="order-preview-title">#${escapeHtml(order.orderNumber || "—")} • ${escapeHtml(order.customerName || "—")}</div>
        <div class="shopify-live-save-line ${order.firebaseSynced ? "ok" : "warn"}">${order.firebaseSynced ? "✅ Saved to Firebase" : "⚠️ Not confirmed saved to Firebase"}</div>
        <div class="structured-order-grid">
          <div><b>Email</b><span>${escapeHtml(order.email || "—")}</span></div>
          <div><b>Phone</b><span>${escapeHtml(order.phone || "—")}</span></div>
          <div><b>Total</b><span>${escapeHtml(order.totalPaid || "—")}</span></div>
          <div><b>Items</b><span>${escapeHtml(order.items || "—")}</span></div>
          <div><b>Payment</b><span>${escapeHtml(order.paymentStatus || "—")}</span></div>
          <div><b>Fulfilment</b><span>${escapeHtml(order.fulfillmentStatus || "—")}</span></div>
          <div><b>Courier</b><span>${escapeHtml(order.courier || "—")}</span></div>
          <div><b>Tracking</b><span>${escapeHtml(order.trackingNumber || "—")}</span></div>
        </div>
        <div class="shopify-actions-line">
          ${copyButton(order.trackingNumber, "Tracking number", "Copy tracking")}
          ${copyButton(order.trackingUrl, "Tracking URL", "Copy tracking URL")}
          ${order.trackingUrl ? `<a class="mini-link" href="${escapeHtml(order.trackingUrl)}" target="_blank" rel="noopener">Open tracking</a>` : ""}
          ${order.adminUrl ? `<a class="mini-link" href="${escapeHtml(order.adminUrl)}" target="_blank" rel="noopener">Open Shopify</a>` : ""}
        </div>
      </div>
    </div>
  `;
}

function orderNoteBlock(order) {
  if (!order) return "";
  return [
    `Order #${order.orderNumber || "—"} loaded from Shopify.`,
    `Customer: ${order.customerName || "—"}`,
    `Items: ${order.items || "—"}`,
    `Payment: ${order.paymentStatus || "—"}`,
    `Fulfilment: ${order.fulfillmentStatus || "—"}`,
    `Tracking: ${order.trackingNumber || "—"}${order.courier ? ` (${order.courier})` : ""}`
  ].filter(Boolean).join("\n");
}

function riskFromTypeAndالطلب(type, order) {
  if (type === "chargeback_risk" || type === "item_not_genuine") return "chargeback";
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

function showTicketAlert(message, danger = false) {
  const box = el("ticket-alert");
  if (!box) return;
  box.textContent = message;
  box.classList.remove("hidden");
  box.classList.toggle("danger", Boolean(danger));
  setTimeout(() => box.classList.add("hidden"), 3500);
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
    opt.textContent = "Unassigned";
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
    const hay = [
      ticket.orderNumber,
      ticket.customerName,
      ticket.email,
      ticket.notes,
      ticket.resolution,
      TYPE_LABELS[ticket.type],
      STATUS_LABELS[ticket.status],
      staffName(ticket.assignedTo),
    ].join(" ").toLowerCase();
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

function renderTicketList() {
  const list = el("tickets-list");
  const empty = el("tickets-empty");
  if (!list || !empty) return;

  const visible = allTickets.filter(canViewTicket);
  renderStats(visible);

  const filtered = visible.filter(ticketMatchesFilters);
  list.innerHTML = "";
  empty.classList.toggle("hidden", filtered.length > 0);

  filtered.forEach((t) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `ticket-row priority-${t.priority || "normal"}`;
    btn.classList.toggle("active", t.id === selectedTicketId);
    btn.innerHTML = `
      <div class="ticket-row-top">
        <strong>#${escapeHtml(t.orderNumber || "—")}</strong>
        <span class="ticket-priority-pill ${t.priority || "normal"}">${escapeHtml(PRIORITY_LABELS[t.priority] || "عادي")}</span>
        ${shopifyStatusPill(t)}
      </div>
      <div class="ticket-row-title">${escapeHtml(TYPE_LABELS[t.type] || t.type || "Ticket")}</div>
      <div class="ticket-row-meta">
        <span class="ticket-status-dot status-${t.status || "open"}"></span>
        <span>${escapeHtml(STATUS_LABELS[t.status] || t.status || "مفتوحة")}</span>
        <span>•</span>
        <span>${escapeHtml(staffName(t.assignedTo))}</span>
      </div>
      <div class="ticket-row-sub">${escapeHtml(t.customerName || t.email || "No customer details yet")}</div>
    `;
    btn.addEventListener("click", () => selectTicket(t.id));
    list.appendChild(btn);
  });
}

function selectTicket(id) {
  selectedTicketId = id;
  renderTicketList();
  renderTicketDetail();
  el("ticket-detail")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
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

  el("ticket-detail-title").textContent = `Ticket #${t.orderNumber || "—"}`;
  el("ticket-detail-sub").textContent = `${TYPE_LABELS[t.type] || t.type} • تم الإنشاء ${fmtDate(t.createdAt)}`;

  const pill = el("ticket-detail-priority");
  if (pill) {
    pill.textContent = PRIORITY_LABELS[t.priority] || "عادي";
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
  el("ticket-detail-notes").value = t.notes || "";
  el("ticket-detail-resolution").value = t.resolution || "";

  const info = el("ticket-info-box");
  if (info) {
    const orderData = t.orderData || {};
    info.innerHTML = `
      <div class="ticket-info-structured">
        ${orderData.imageUrl ? `<div class="ticket-info-image-wrap"><img class="ticket-info-image" src="${escapeHtml(orderData.imageUrl)}" alt="${escapeHtml(orderData.items || "Order product")}" loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('hidden')"></div>` : ""}
        <div class="structured-order-grid">
          <div><b>Customer</b><span>${escapeHtml(t.customerName || orderData.customerName || "—")}</span></div>
          <div><b>Email</b><span>${escapeHtml(t.email || orderData.email || "—")}</span></div>
          <div><b>Phone</b><span>${escapeHtml(orderData.phone || "—")}</span></div>
          <div><b>Total</b><span>${escapeHtml(orderData.totalPaid || "—")}</span></div>
          <div><b>Items</b><span>${escapeHtml(orderData.items || "—")}</span></div>
          <div><b>Payment</b><span>${escapeHtml(orderData.paymentStatus || "—")}</span></div>
          <div><b>Fulfilment</b><span>${escapeHtml(orderData.fulfillmentStatus || "—")}</span></div>
          <div><b>Courier</b><span>${escapeHtml(orderData.courier || "—")}</span></div>
          <div><b>Tracking number</b><span>${escapeHtml(orderData.trackingNumber || "—")}</span></div>
          <div><b>Delivery</b><span>${escapeHtml(orderالحالةLabel(orderData.deliveryالحالة))}</span></div>
          <div><b>Firebase</b><span>${shopifyStatusPill(t)}</span></div>
          <div><b>Risk</b><span>${escapeHtml(t.risk || "normal")}</span></div>
        </div>
        <div class="shopify-actions-line">
          ${copyButton(orderData.trackingNumber, "Tracking number", "Copy tracking")}
          ${copyButton(orderData.trackingUrl, "Tracking URL", "Copy tracking URL")}
          ${orderData.trackingUrl ? `<a class="mini-link" href="${escapeHtml(orderData.trackingUrl)}" target="_blank" rel="noopener">Open tracking</a>` : ""}
          ${orderData.adminUrl ? `<a class="mini-link" href="${escapeHtml(orderData.adminUrl)}" target="_blank" rel="noopener">Open Shopify</a>` : ""}
        </div>
        <div class="ticket-system-line">Created by: ${escapeHtml(staffName(t.createdBy))} (${escapeHtml(t.createdBy || "—")}) • Updated: ${escapeHtml(fmtDate(t.updatedAt))}</div>
      </div>
    `;
  }

  const history = el("ticket-history-box");
  if (history) history.innerHTML = `${ticketTimelineHtml(t)}${customerHistoryHtml(t)}`;

  const editable = canEditAll(currentUser) || t.assignedTo === currentUser?.id || t.createdBy === currentUser?.id;
  ["ticket-detail-status", "ticket-detail-assigned", "ticket-detail-priority-select", "ticket-detail-mood", "ticket-detail-notes", "ticket-detail-resolution"].forEach((id) => {
    const node = el(id);
    if (node) node.disabled = !editable;
  });
  if (el("ticket-save-btn")) el("ticket-save-btn").disabled = !editable;
  if (el("ticket-escalate-btn")) el("ticket-escalate-btn").disabled = !editable;
}

function hookUI() {
  if (isHooked) return;
  isHooked = true;

  document.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("[data-copy]");
    if (!btn) return;
    await copyText(btn.dataset.copy || "", btn.dataset.copyLabel || "Text");
  });

  el("ticket-new-toggle")?.addEventListener("click", () => setTicketFormمفتوحة(true));

  el("ticket-form-close")?.addEventListener("click", () => setTicketFormمفتوحة(false));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el("ticket-form")?.classList.contains("hidden")) setTicketFormمفتوحة(false);
  });

  el("ticket-refresh-btn")?.addEventListener("click", () => {
    renderTicketList();
    renderTicketDetail();
    showTicketAlert("Ticket queue refreshed.");
  });

  el("ticket-type")?.addEventListener("change", () => {
    const type = el("ticket-type")?.value;
    const priority = el("ticket-priority");
    if (priority && EMERGENCY_TYPES.has(type)) priority.value = "emergency";
  });

  el("shopify-live-settings")?.addEventListener("click", setShopifyApiKey);

  el("shopify-live-search")?.addEventListener("click", async () => {
    const btn = el("shopify-live-search");
    const oldText = btn?.textContent || "Search Shopify";
    try {
      if (btn) { btn.disabled = true; btn.textContent = "Searching..."; }
      await searchAndApplyShopifyOrder(el("shopify-live-query")?.value, false);
    } catch (err) {
      renderShopifyLiveResult(null, err?.message || "Shopify lookup failed.");
      showTicketAlert(err?.message || "Shopify lookup failed.", true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
  });

  el("shopify-live-query")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      el("shopify-live-search")?.click();
    }
  });

  el("shopify-live-use-ticket")?.addEventListener("click", () => {
    if (!lastLiveShopifyOrder) return showTicketAlert("Search Shopify first.", true);
    applyOrderToTicketForm(lastLiveShopifyOrder);
  });

  el("ticket-shopify-autofill-btn")?.addEventListener("click", async () => {
    const order = normaliseالطلبNumber(el("ticket-order")?.value);
    if (!order) return showTicketAlert("Enter an order number first.", true);
    const btn = el("ticket-shopify-autofill-btn");
    const oldText = btn?.textContent || "جلب من Shopify";
    try {
      if (btn) { btn.disabled = true; btn.textContent = "جاري الجلب..."; }
      await searchAndApplyShopifyOrder(order, true);
    } catch (err) {
      showTicketAlert(err?.message || "Shopify lookup failed.", true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
  });

  el("ticket-autofill-btn")?.addEventListener("click", async () => {
    const order = normaliseالطلبNumber(el("ticket-order")?.value);
    if (!order) return showTicketAlert("Enter an order number first.", true);
    const cached = await getBestOrderData(order);
    if (cached) {
      applyOrderToTicketForm(cached);
      showTicketAlert(cached.source === "shopify_live" ? "Shopify live order filled." : "الطلب cache found and ticket fields were filled.");
      return;
    }
    renderالطلبPreview(null);
    if (!el("ticket-notes")?.value) {
      el("ticket-notes").value = `الطلب #${order}. Please check Shopify for customer details, tracking status, delivery status, and latest customer message.`;
    }
    showTicketAlert("No cached order found. Manual ticket template filled.", true);
  });

  el("ticket-order")?.addEventListener("blur", async () => {
    const order = normaliseالطلبNumber(el("ticket-order")?.value);
    if (!order) return renderالطلبPreview(null);
    renderالطلبPreview(await getBestOrderData(order));
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

  ["ticket-search", "ticket-filter-status", "ticket-filter-priority", "ticket-filter-owner"].forEach((id) => {
    const node = el(id);
    node?.addEventListener("input", renderTicketList);
    node?.addEventListener("change", renderTicketList);
  });

  el("ticket-save-btn")?.addEventListener("click", saveSelectedTicket);
  el("ticket-escalate-btn")?.addEventListener("click", async () => {
    if (!selectedTicketId) return;
    await updateDoc(doc(db, TICKETS_COL, selectedTicketId), {
      status: "escalated",
      priority: "emergency",
      risk: "chargeback",
      updatedAt: serverTimestamp(),
      escalatedAt: serverTimestamp(),
      escalatedBy: currentUser?.id || "",
      history: addHistory(allTickets.find((x) => x.id === selectedTicketId)?.history, "مصعّدة to manager", currentUser?.id || ""),
    });
    showTicketAlert("Ticket escalated to manager.");
  });
}

async function createTicket() {
  if (!currentUser) return;
  const createBtn = document.querySelector('#ticket-form button[type="submit"]');
  const oldCreateText = createBtn?.textContent || "إنشاء التذكرة";
  if (createBtn) { createBtn.disabled = true; createBtn.textContent = "جاري الإنشاء..."; }
  const orderNumber = normaliseالطلبNumber(el("ticket-order")?.value);
  if (!orderNumber) {
    showTicketAlert("رقم الطلب مطلوب.", true);
    if (createBtn) { createBtn.disabled = false; createBtn.textContent = oldCreateText; }
    return;
  }

  const type = el("ticket-type")?.value || "general_question";
  const priority = el("ticket-priority")?.value || inferالأولوية(type);
  const assignedTo = canEditAll(currentUser)
    ? (el("ticket-assigned")?.value || "")
    : currentUser.id;
  const cachedالطلب = await getBestOrderData(orderNumber);

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
    notes: el("ticket-notes")?.value?.trim() || "",
    resolution: "",
    customerMood: inferMood(type, priority),
    risk: riskFromTypeAndالطلب(type, cachedالطلب),
    source: cachedالطلب?.source === "shopify_live" ? "shopify_live" : (cachedالطلب ? "order_cache" : "manual"),
    shopifyStatus: cachedالطلب ? "synced" : "failed",
    shopifyStatusLabel: cachedالطلب ? "Synced with Shopify" : "Failed to load from Shopify",
    orderData: cachedالطلب ? {
      customerName: cachedالطلب.customerName || "",
      email: cachedالطلب.email || "",
      phone: cachedالطلب.phone || "",
      items: cachedالطلب.items || "",
      itemsList: cachedالطلب.itemsList || [],
      imageUrl: cachedالطلب.imageUrl || "",
      totalPaid: cachedالطلب.totalPaid || "",
      orderDate: cachedالطلب.orderDate || "",
      courier: cachedالطلب.courier || "",
      trackingNumber: cachedالطلب.trackingNumber || "",
      trackingUrl: cachedالطلب.trackingUrl || "",
      paymentStatus: cachedالطلب.paymentStatus || "",
      fulfillmentStatus: cachedالطلب.fulfillmentStatus || "",
      orderالحالة: cachedالطلب.orderالحالة || "unknown",
      deliveryالحالة: cachedالطلب.deliveryالحالة || "unknown",
      shippingAddress: cachedالطلب.shippingAddress || "",
      billingAddress: cachedالطلب.billingAddress || "",
      adminUrl: cachedالطلب.adminUrl || "",
      refundsCount: cachedالطلب.refundsCount || 0,
    } : {},
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    history: addHistory([], `تم الإنشاء ticket (${TYPE_LABELS[type] || type})`, currentUser.id),
  };

  try {
    const created = await addDoc(collection(db, TICKETS_COL), payload);
    selectedTicketId = created.id;
    el("ticket-form")?.reset();
    renderالطلبPreview(null);
    fillAssigneeSelect(el("ticket-assigned"), true);
    setTicketFormمفتوحة(false);
    showTicketAlert(cachedالطلب ? `✅ Ticket saved to Firebase and linked with Shopify order #${orderNumber}.` : "تم إنشاء التذكرة، لكن لم يتم العثور على بيانات Shopify لهذا الطلب.", !cachedالطلب);
  } catch (err) {
    console.error("createTicket failed", err);
    showTicketAlert(`Ticket could not be created: ${err?.code || err?.message || "check Firestore permissions/internet"}`, true);
  } finally {
    if (createBtn) { createBtn.disabled = false; createBtn.textContent = oldCreateText; }
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
  const existing = await getCachedالطلب(orderNumber);
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
    history: addHistory(existing?.history, "تم تحديث بيانات الطلب اليدوية", currentUser?.id || ""),
    updatedByName: currentUser?.name || "",
  };
  if (!existing) payload.createdAt = serverTimestamp();
  await setDoc(orderDocRef(orderNumber), payload, { merge: true });
  showTicketAlert("الطلب cache saved. Agents can now autofill this order.");
}

async function saveSelectedTicket() {
  const t = allTickets.find((x) => x.id === selectedTicketId);
  if (!t) return showTicketAlert("Select a ticket first.", true);
  const saveBtn = el("ticket-save-btn");
  const oldText = saveBtn?.textContent || "حفظ التعديلات";
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "جاري الحفظ..."; }

  const status = el("ticket-detail-status")?.value || "open";
  const update = {
    status,
    assignedTo: el("ticket-detail-assigned")?.value || "",
    priority: el("ticket-detail-priority-select")?.value || "normal",
    customerMood: el("ticket-detail-mood")?.value || "calm",
    notes: el("ticket-detail-notes")?.value || "",
    resolution: el("ticket-detail-resolution")?.value || "",
    updatedAt: serverTimestamp(),
    updatedBy: currentUser?.id || "",
    history: addHistory(t.history, `تم الحفظ changes: status ${STATUS_LABELS[status] || status}, priority ${PRIORITY_LABELS[update.priority] || update.priority}`, currentUser?.id || ""),
  };
  if (status === "resolved" || status === "closed") {
    update.resolvedAt = serverTimestamp();
    update.resolvedBy = currentUser?.id || "";
  }

  try {
    await updateDoc(doc(db, TICKETS_COL, selectedTicketId), update);
    showTicketAlert("Ticket updated and saved.");
  } catch (err) {
    console.error("saveSelectedTicket failed", err);
    showTicketAlert(`فشل الحفظ: ${err?.code || err?.message || "تحقق من صلاحيات Firestore أو الاتصال"}`, true);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = oldText; }
  }
}

function subscribeTickets() {
  if (unsubTickets) unsubTickets();
  const q = query(collection(db, TICKETS_COL), orderBy("updatedAt", "desc"));
  unsubTickets = onSnapshot(q, (snapshot) => {
    allTickets = [];
    snapshot.forEach((d) => allTickets.push({ id: d.id, ...d.data() }));
    if (selectedTicketId && !allTickets.some((t) => t.id === selectedTicketId)) selectedTicketId = null;
    renderTicketList();
    renderTicketDetail();
  }, (err) => {
    console.error("tickets snapshot error", err);
    showTicketAlert("Could not load tickets. Check Firestore rules/indexes.", true);
  });
}

function initTickets() {
  currentUser = getCurrentUser();
  hookUI();
  fillAssigneeSelect(el("ticket-assigned"), true);
  fillAssigneeSelect(el("ticket-detail-assigned"), true);
  // Legacy manual order cache is intentionally hidden now. Live Shopify lookup + Firestore sync is the main workflow.
  el("order-admin-panel")?.classList.add("hidden");

  if (!currentUser) {
    allTickets = [];
    renderTicketList();
    renderTicketDetail();
    if (unsubTickets) unsubTickets();
    unsubTickets = null;
    return;
  }

  subscribeTickets();
}

document.addEventListener("DOMContentLoaded", initTickets);
window.addEventListener("telesyriana:user-changed", initTickets);

try { window.addEventListener("telesyriana:language-changed", () => { renderTicketList(); renderTicketDetail(); }); } catch {}
