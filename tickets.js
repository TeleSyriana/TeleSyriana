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
} = fs;

const USER_KEY = "telesyrianaUser";
const TICKETS_COL = "tickets";

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
        <strong>#${t.orderNumber || "—"}</strong>
        <span class="ticket-priority-pill ${t.priority || "normal"}">${PRIORITY_LABELS[t.priority] || "Normal"}</span>
      </div>
      <div class="ticket-row-title">${TYPE_LABELS[t.type] || t.type || "Ticket"}</div>
      <div class="ticket-row-meta">
        <span>${STATUS_LABELS[t.status] || t.status || "Open"}</span>
        <span>•</span>
        <span>${staffName(t.assignedTo)}</span>
      </div>
      <div class="ticket-row-sub">${t.customerName || t.email || "No customer details yet"}</div>
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
    info.innerHTML = `
      <div><strong>Customer:</strong> ${t.customerName || "—"}</div>
      <div><strong>Email:</strong> ${t.email || "—"}</div>
      <div><strong>Created by:</strong> ${staffName(t.createdBy)} (${t.createdBy || "—"})</div>
      <div><strong>Updated:</strong> ${fmtDate(t.updatedAt)}</div>
      <div><strong>Risk:</strong> ${t.risk || "normal"}</div>
    `;
  }

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

  el("ticket-new-toggle")?.addEventListener("click", () => {
    const form = el("ticket-form");
    if (form) form.classList.toggle("hidden");
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

  el("ticket-autofill-btn")?.addEventListener("click", () => {
    const order = normaliseOrderNumber(el("ticket-order")?.value);
    if (!order) return showTicketAlert("Enter an order number first.", true);
    if (!el("ticket-notes")?.value) {
      el("ticket-notes").value = `Order #${order}. Please check Shopify for customer details, tracking status, delivery status, and latest customer message.`;
    }
    showTicketAlert("Basic order template filled. Shopify API autofill can be added later.");
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
  const orderNumber = normaliseOrderNumber(el("ticket-order")?.value);
  if (!orderNumber) return showTicketAlert("Order number is required.", true);

  const type = el("ticket-type")?.value || "general_question";
  const priority = el("ticket-priority")?.value || inferPriority(type);
  const assignedTo = canEditAll(currentUser)
    ? (el("ticket-assigned")?.value || "")
    : currentUser.id;

  const payload = {
    orderNumber,
    type,
    priority,
    status: priority === "emergency" ? "open" : "open",
    assignedTo,
    createdBy: currentUser.id,
    createdByName: currentUser.name,
    customerName: el("ticket-customer")?.value?.trim() || "",
    email: el("ticket-email")?.value?.trim() || "",
    notes: el("ticket-notes")?.value?.trim() || "",
    resolution: "",
    customerMood: inferMood(type, priority),
    risk: priority === "emergency" ? "chargeback" : "normal",
    source: "manual",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  await addDoc(collection(db, TICKETS_COL), payload);
  el("ticket-form")?.reset();
  fillAssigneeSelect(el("ticket-assigned"), true);
  showTicketAlert("Ticket created successfully.");
}

async function saveSelectedTicket() {
  const t = allTickets.find((x) => x.id === selectedTicketId);
  if (!t) return;

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

  await updateDoc(doc(db, TICKETS_COL, selectedTicketId), update);
  showTicketAlert("Ticket updated.");
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
