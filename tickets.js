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

const ROLE_LEVELS = { agent: 1, supervisor: 2, hr: 3, manager: 3, admin: 4 };
const STAFF = {
  "0001": { id: "0001", name: "Owner Jack Smith", role: "admin" },
  "1001": { id: "1001", name: "Manager Mohammad Safar", role: "manager" },
  "2001": { id: "2001", name: "Supervisor Dema Shabar", role: "supervisor" },
  "3001": { id: "3001", name: "HR Fatima Kaka", role: "hr" },
  "9001": { id: "9001", name: "Agent Raghad Moussa", role: "agent", supervisorId: "2001" },
  "9002": { id: "9002", name: "Agent Qamar Moussa", role: "agent", supervisorId: "2001" },
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
let currentLiveOrder = null;
let currentLiveOrderFirebaseStatus = "none";

const SHOPIFY_BACKEND_URL = "https://telesyriana-backend.onrender.com";
const SHOPIFY_API_KEY_STORAGE = "telesyrianaShopifyBackendApiKey";
// Staff should not handle backend API keys. This is obfuscated only to reduce UI confusion; real security still belongs on the backend/auth layer.
const SHOPIFY_BACKEND_KEY_MASK = 37;
const SHOPIFY_BACKEND_KEY_OBFUSCATED = [100,68,21,28,16,20,17,23,22,22,23,17,20,16,4];

function defaultShopifyApiKey() {
  try { return SHOPIFY_BACKEND_KEY_OBFUSCATED.map(n => String.fromCharCode(n ^ SHOPIFY_BACKEND_KEY_MASK)).join(""); } catch { return ""; }
}

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
    orderDate: order.created_at || order.createdAt || "",
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
    <div class="shopify-order-card">
      <div class="shopify-order-card-head">
        ${img}
        <div>
          <h4>#${escapeHtml(order.orderNumber || "—")} • ${escapeHtml(order.customerName || "No customer")}</h4>
          <div class="shopify-muted">${escapeHtml(order.email || "—")} • ${escapeHtml(order.phone || "—")}</div>
          <div class="shopify-muted">${firebaseStatusBadge(firebaseStatus)}</div>
        </div>
      </div>
      <div class="shopify-order-grid">
        <div><b>Total</b><span>${escapeHtml(order.totalPaid || "—")}</span></div>
        <div><b>Payment</b><span>${escapeHtml(order.paymentStatus || "—")}</span></div>
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
      liveStatus(`No Shopify order found for ${q}.`, "warn");
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
    `Tracking: ${order.trackingNumber || "—"} ${order.courier ? `(${order.courier})` : ""}`,
    `الطلب status: ${orderالحالةLabel(order.orderالحالة)}`,
    `Delivery status: ${orderالحالةLabel(order.deliveryالحالة)}`,
    order.notes ? `الطلب notes: ${order.notes}` : ""
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

  // Desktop had a horizontal jump when a ticket opened because scrollIntoView
  // tried to bring the detail panel into view inside the RTL grid. Only scroll on mobile.
  if (window.matchMedia && window.matchMedia("(max-width: 900px)").matches) {
    el("ticket-detail")?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
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
    const hasShopifyData = Boolean(orderData.orderNumber || orderData.customerName || orderData.items || orderData.adminUrl || t.shopifyStatus);
    const img = orderData.imageUrl
      ? `<img class="shopify-product-thumb ticket-detail-img" src="${escapeHtml(orderData.imageUrl)}" alt="Product image" loading="lazy" />`
      : `<div class="shopify-product-thumb ticket-detail-img placeholder">No image</div>`;

    if (!hasShopifyData) {
      info.innerHTML = `<div class="ticket-shopify-empty">No linked Shopify order yet.</div>`;
    } else {
      info.innerHTML = `
        <section class="ticket-shopify-card">
          <div class="ticket-shopify-head">
            ${img}
            <div class="ticket-shopify-title-block">
              <div class="ticket-shopify-label">Linked Shopify Order</div>
              <h3>#${escapeHtml(t.orderNumber || orderData.orderNumber || "—")}</h3>
              <p>${escapeHtml(t.type ? (TYPE_LABELS[t.type] || t.type) : "Support ticket")}</p>
              ${shopifyStatusPill(t)}
            </div>
          </div>

          <div class="ticket-shopify-fields">
            <div class="field-card wide"><span>Customer</span><strong>${escapeHtml(t.customerName || orderData.customerName || "—")}</strong></div>
            <div class="field-card"><span>Email</span><strong>${escapeHtml(t.email || orderData.email || "—")}</strong></div>
            <div class="field-card"><span>Phone</span><strong>${escapeHtml(orderData.phone || "—")}</strong></div>
            <div class="field-card"><span>Postcode</span><strong>${escapeHtml(orderData.postcode || "—")}</strong></div>
            <div class="field-card"><span>Total</span><strong>${escapeHtml(orderData.totalPaid || "—")}</strong></div>
            <div class="field-card"><span>Payment</span><strong>${escapeHtml(orderData.paymentStatus || "—")}</strong></div>
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

  ["ticket-search", "ticket-filter-status", "ticket-filter-priority", "ticket-filter-owner"].forEach((id) => {
    const node = el(id);
    node?.addEventListener("input", renderTicketList);
    node?.addEventListener("change", renderTicketList);
  });

  el("ticket-save-btn")?.addEventListener("click", saveSelectedTicket);
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

  const type = el("ticket-type")?.value || "general_question";
  const priority = el("ticket-priority")?.value || inferالأولوية(type);
  const assignedTo = canEditAll(currentUser)
    ? (el("ticket-assigned")?.value || "")
    : currentUser.id;
  const cachedFromDb = await getCachedالطلب(orderNumber);
  const cachedالطلب = (currentLiveOrder && currentLiveOrder.orderNumber === orderNumber) ? currentLiveOrder : cachedFromDb;

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
  const notes = el("ticket-detail-notes")?.value || "";
  const resolution = el("ticket-detail-resolution")?.value || "";
  const update = {
    status,
    assignedTo,
    priority,
    customerMood,
    notes,
    resolution,
    updatedAt: serverTimestamp(),
    updatedBy: currentUser?.id || "",
    history: addHistory(t.history, `تم الحفظ changes: status ${STATUS_LABELS[status] || status}, priority ${PRIORITY_LABELS[priority] || priority}`, currentUser?.id || ""),
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
  el("order-admin-panel")?.classList.remove("hidden");

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
