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
  angry_customer: "Angry Customer",
  refund_request: "Refund Request",
  chargeback_risk: "Chargeback Risk",
  general_question: "General Question",
};

const STATUS_LABELS = {
  open: "Open",
  waiting_customer: "Waiting Customer",
  waiting_courier: "Waiting Courier",
  waiting_supplier: "Waiting Supplier",
  escalated: "Escalated",
  resolved: "Resolved",
  closed: "Closed",
};

const PRIORITY_LABELS = {
  emergency: "Emergency",
  high: "High",
  medium: "Medium",
  normal: "Normal",
};

let currentUser = null;
let allTickets = [];
let selectedTicketId = null;
let unsubTickets = null;
let isHooked = false;

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

function normaliseOrderNumber(v) {
  return String(v || "").trim().replace(/^#/, "");
}

function orderDocRef(orderNumber) {
  const order = normaliseOrderNumber(orderNumber);
  if (!order) return null;
  return doc(db, ORDER_RECORDS_COL, order);
}

async function getCachedOrder(orderNumber) {
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


function orderStatusLabel(v) {
  const labels = {
    unknown: "Unknown", unfulfilled: "Unfulfilled", processing: "Processing", fulfilled: "Fulfilled",
    cancelled: "Cancelled", refunded: "Refunded", label_created: "Label created", in_transit: "In transit",
    delivered: "Delivered", delayed: "Delayed", lost: "Lost / investigation"
  };
  return labels[v] || v || "Unknown";
}

function renderOrderPreview(order) {
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
    <div><strong>Customer:</strong> ${escapeHtml(order.customerName || "—")}</div>
    <div><strong>Email:</strong> ${escapeHtml(order.email || "—")}</div>
    <div><strong>Items:</strong> ${escapeHtml(order.items || "—")}</div>
    <div><strong>Tracking:</strong> ${escapeHtml(order.trackingNumber || "—")} ${order.courier ? `(${escapeHtml(order.courier)})` : ""}</div>
    <div><strong>Status:</strong> ${escapeHtml(orderStatusLabel(order.orderStatus))} • ${escapeHtml(orderStatusLabel(order.deliveryStatus))}</div>
  `;
}

function orderNoteBlock(order) {
  if (!order) return "";
  return [
    `Shopify order cache loaded:`,
    `Customer: ${order.customerName || "—"}`,
    `Email: ${order.email || "—"}`,
    `Phone: ${order.phone || "—"}`,
    `Items: ${order.items || "—"}`,
    `Total: ${order.totalPaid || "—"}`,
    `Tracking: ${order.trackingNumber || "—"} ${order.courier ? `(${order.courier})` : ""}`,
    `Order status: ${orderStatusLabel(order.orderStatus)}`,
    `Delivery status: ${orderStatusLabel(order.deliveryStatus)}`,
    order.notes ? `Order notes: ${order.notes}` : ""
  ].filter(Boolean).join("\n");
}

function riskFromTypeAndOrder(type, order) {
  if (type === "chargeback_risk" || type === "item_not_genuine") return "chargeback";
  if (order?.deliveryStatus === "lost" || order?.deliveryStatus === "delayed") return "high";
  if (EMERGENCY_TYPES.has(type)) return "medium";
  return "normal";
}

function canManageOrderCache(u) {
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
  if (!matches.length) return `<div class="lookup-title">Customer history</div><div>No previous tickets found for this customer.</div>`;
  return `
    <div class="lookup-title">Customer history</div>
    ${matches.map((x) => `
      <div class="history-line">#${escapeHtml(x.orderNumber || "—")} • ${escapeHtml(TYPE_LABELS[x.type] || x.type || "Ticket")} • ${escapeHtml(STATUS_LABELS[x.status] || x.status || "Open")}</div>
    `).join("")}
  `;
}

function inferPriority(type) {
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

function setTicketFormOpen(open) {
  const form = el("ticket-form");
  if (!form) return;
  form.classList.toggle("hidden", !open);
  document.body.classList.toggle("ticket-modal-open", Boolean(open));
  if (open) {
    setTimeout(() => el("ticket-order")?.focus(), 50);
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
        <span class="ticket-priority-pill ${t.priority || "normal"}">${escapeHtml(PRIORITY_LABELS[t.priority] || "Normal")}</span>
      </div>
      <div class="ticket-row-title">${escapeHtml(TYPE_LABELS[t.type] || t.type || "Ticket")}</div>
      <div class="ticket-row-meta">
        <span class="ticket-status-dot status-${t.status || "open"}"></span>
        <span>${escapeHtml(STATUS_LABELS[t.status] || t.status || "Open")}</span>
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
  el("ticket-detail-sub").textContent = `${TYPE_LABELS[t.type] || t.type} • Created ${fmtDate(t.createdAt)}`;

  const pill = el("ticket-detail-priority");
  if (pill) {
    pill.textContent = PRIORITY_LABELS[t.priority] || "Normal";
    pill.className = `ticket-priority-pill ${t.priority || "normal"}`;
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
      <div><strong>Customer:</strong> ${escapeHtml(t.customerName || orderData.customerName || "—")}</div>
      <div><strong>Email:</strong> ${escapeHtml(t.email || orderData.email || "—")}</div>
      <div><strong>Items:</strong> ${escapeHtml(orderData.items || "—")}</div>
      <div><strong>Tracking:</strong> ${escapeHtml(orderData.trackingNumber || "—")} ${orderData.courier ? `(${escapeHtml(orderData.courier)})` : ""}</div>
      <div><strong>Order status:</strong> ${escapeHtml(orderStatusLabel(orderData.orderStatus))}</div>
      <div><strong>Delivery:</strong> ${escapeHtml(orderStatusLabel(orderData.deliveryStatus))}</div>
      <div><strong>Created by:</strong> ${escapeHtml(staffName(t.createdBy))} (${escapeHtml(t.createdBy || "—")})</div>
      <div><strong>Updated:</strong> ${escapeHtml(fmtDate(t.updatedAt))}</div>
      <div><strong>Risk:</strong> ${escapeHtml(t.risk || "normal")}</div>
    `;
  }

  const history = el("ticket-history-box");
  if (history) history.innerHTML = customerHistoryHtml(t);

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

  el("ticket-new-toggle")?.addEventListener("click", () => setTicketFormOpen(true));

  el("ticket-form-close")?.addEventListener("click", () => setTicketFormOpen(false));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el("ticket-form")?.classList.contains("hidden")) setTicketFormOpen(false);
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

  el("ticket-autofill-btn")?.addEventListener("click", async () => {
    const order = normaliseOrderNumber(el("ticket-order")?.value);
    if (!order) return showTicketAlert("Enter an order number first.", true);
    const cached = await getCachedOrder(order);
    if (cached) {
      if (el("ticket-customer")) el("ticket-customer").value = cached.customerName || "";
      if (el("ticket-email")) el("ticket-email").value = cached.email || "";
      renderOrderPreview(cached);
      const existing = el("ticket-notes")?.value || "";
      if (el("ticket-notes") && !existing.includes("Shopify order cache loaded:")) {
        el("ticket-notes").value = `${existing ? existing + "\n\n" : ""}${orderNoteBlock(cached)}`;
      }
      showTicketAlert("Order cache found and ticket fields were filled.");
      return;
    }
    renderOrderPreview(null);
    if (!el("ticket-notes")?.value) {
      el("ticket-notes").value = `Order #${order}. Please check Shopify for customer details, tracking status, delivery status, and latest customer message.`;
    }
    showTicketAlert("No cached order found. Manual ticket template filled.", true);
  });

  el("ticket-order")?.addEventListener("blur", async () => {
    const order = normaliseOrderNumber(el("ticket-order")?.value);
    if (!order) return renderOrderPreview(null);
    renderOrderPreview(await getCachedOrder(order));
  });

  el("order-admin-toggle")?.addEventListener("click", () => {
    el("order-cache-form")?.classList.toggle("hidden");
  });

  el("order-cache-load")?.addEventListener("click", loadOrderCacheForm);

  el("order-cache-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await saveOrderCacheForm();
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
    });
    showTicketAlert("Ticket escalated to manager.");
  });
}

async function createTicket() {
  if (!currentUser) return;
  const createBtn = document.querySelector('#ticket-form button[type="submit"]');
  const oldCreateText = createBtn?.textContent || "Create Ticket";
  if (createBtn) { createBtn.disabled = true; createBtn.textContent = "Creating..."; }
  const orderNumber = normaliseOrderNumber(el("ticket-order")?.value);
  if (!orderNumber) { if (createBtn) { createBtn.disabled = false; createBtn.textContent = oldCreateText; } return showTicketAlert("Order number is required.", true); }

  const type = el("ticket-type")?.value || "general_question";
  const priority = el("ticket-priority")?.value || inferPriority(type);
  const assignedTo = canEditAll(currentUser)
    ? (el("ticket-assigned")?.value || "")
    : currentUser.id;
  const cachedOrder = await getCachedOrder(orderNumber);

  const payload = {
    orderNumber,
    type,
    priority,
    status: priority === "emergency" ? "open" : "open",
    assignedTo,
    createdBy: currentUser.id,
    createdByName: currentUser.name,
    customerName: el("ticket-customer")?.value?.trim() || cachedOrder?.customerName || "",
    email: el("ticket-email")?.value?.trim() || cachedOrder?.email || "",
    notes: el("ticket-notes")?.value?.trim() || (cachedOrder ? orderNoteBlock(cachedOrder) : ""),
    resolution: "",
    customerMood: inferMood(type, priority),
    risk: riskFromTypeAndOrder(type, cachedOrder),
    source: cachedOrder ? "order_cache" : "manual",
    orderData: cachedOrder ? {
      customerName: cachedOrder.customerName || "",
      email: cachedOrder.email || "",
      phone: cachedOrder.phone || "",
      items: cachedOrder.items || "",
      totalPaid: cachedOrder.totalPaid || "",
      orderDate: cachedOrder.orderDate || "",
      courier: cachedOrder.courier || "",
      trackingNumber: cachedOrder.trackingNumber || "",
      orderStatus: cachedOrder.orderStatus || "unknown",
      deliveryStatus: cachedOrder.deliveryStatus || "unknown",
      shippingAddress: cachedOrder.shippingAddress || "",
    } : {},
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    const created = await addDoc(collection(db, TICKETS_COL), payload);
    selectedTicketId = created.id;
    el("ticket-form")?.reset();
    renderOrderPreview(null);
    fillAssigneeSelect(el("ticket-assigned"), true);
    setTicketFormOpen(false);
    showTicketAlert("Ticket created successfully.");
  } catch (err) {
    console.error("createTicket failed", err);
    showTicketAlert(`Ticket could not be created: ${err?.code || err?.message || "check Firestore permissions/internet"}`, true);
  } finally {
    if (createBtn) { createBtn.disabled = false; createBtn.textContent = oldCreateText; }
  }
}

async function loadOrderCacheForm() {
  const order = normaliseOrderNumber(el("order-cache-number")?.value);
  if (!order) return showTicketAlert("Enter order number to load.", true);
  const data = await getCachedOrder(order);
  if (!data) return showTicketAlert("No order cache found for this number.", true);
  el("order-cache-customer").value = data.customerName || "";
  el("order-cache-email").value = data.email || "";
  el("order-cache-phone").value = data.phone || "";
  el("order-cache-total").value = data.totalPaid || "";
  el("order-cache-date").value = data.orderDate || "";
  el("order-cache-courier").value = data.courier || "";
  el("order-cache-tracking").value = data.trackingNumber || "";
  el("order-cache-status").value = data.orderStatus || "unknown";
  el("order-cache-delivery").value = data.deliveryStatus || "unknown";
  el("order-cache-items").value = data.items || "";
  el("order-cache-address").value = data.shippingAddress || "";
  el("order-cache-notes").value = data.notes || "";
  showTicketAlert("Order cache loaded.");
}

async function saveOrderCacheForm() {
  if (!canManageOrderCache(currentUser)) return showTicketAlert("Only supervisor, manager, or admin can save order cache.", true);
  const orderNumber = normaliseOrderNumber(el("order-cache-number")?.value);
  if (!orderNumber) { if (createBtn) { createBtn.disabled = false; createBtn.textContent = oldCreateText; } return showTicketAlert("Order number is required.", true); }
  const payload = {
    orderNumber,
    customerName: cleanText(el("order-cache-customer")?.value),
    email: cleanText(el("order-cache-email")?.value),
    phone: cleanText(el("order-cache-phone")?.value),
    totalPaid: cleanText(el("order-cache-total")?.value),
    orderDate: cleanText(el("order-cache-date")?.value),
    courier: cleanText(el("order-cache-courier")?.value),
    trackingNumber: cleanText(el("order-cache-tracking")?.value),
    orderStatus: el("order-cache-status")?.value || "unknown",
    deliveryStatus: el("order-cache-delivery")?.value || "unknown",
    items: cleanText(el("order-cache-items")?.value),
    shippingAddress: cleanText(el("order-cache-address")?.value),
    notes: cleanText(el("order-cache-notes")?.value),
    updatedAt: serverTimestamp(),
    updatedBy: currentUser?.id || "",
    updatedByName: currentUser?.name || "",
  };
  const existing = await getCachedOrder(orderNumber);
  if (!existing) payload.createdAt = serverTimestamp();
  await setDoc(orderDocRef(orderNumber), payload, { merge: true });
  showTicketAlert("Order cache saved. Agents can now autofill this order.");
}

async function saveSelectedTicket() {
  const t = allTickets.find((x) => x.id === selectedTicketId);
  if (!t) return showTicketAlert("Select a ticket first.", true);
  const saveBtn = el("ticket-save-btn");
  const oldText = saveBtn?.textContent || "Save Changes";
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving..."; }

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
    showTicketAlert(`Save failed: ${err?.code || err?.message || "check Firestore permissions/internet"}`, true);
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
  el("order-admin-panel")?.classList.toggle("hidden", !canManageOrderCache(currentUser));

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
