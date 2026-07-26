// phase5-ticket-quick-filters.js — one-tap Ticket queue/date controls
// Pure DOM enhancement; the existing Ticket engine remains authoritative.

const HOST_ID = 'phase5-ticket-quick-filters';

function el(id) { return document.getElementById(id); }
function language() {
  return (document.body?.dataset?.language || document.documentElement.lang || 'ar') === 'en' ? 'en' : 'ar';
}
function t(ar, en) { return language() === 'ar' ? ar : en; }

function ensureAllStatusOption() {
  const status = el('ticket-filter-status');
  if (!status) return;
  let option = status.querySelector('option[value="all"]');
  if (!option) {
    option = document.createElement('option');
    option.value = 'all';
    status.appendChild(option);
  }
  option.textContent = t('كل الحالات', 'All statuses');
}

function setSelect(id, value) {
  const node = el(id);
  if (!node) return;
  node.value = value;
  node.dispatchEvent(new Event('change', { bubbles: true }));
}

function resetSearch() {
  const search = el('ticket-search');
  if (!search) return;
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
}

function applyQueueFilter(kind) {
  resetSearch();
  if (kind === 'unresolved') {
    setSelect('ticket-filter-status', 'active');
    setSelect('ticket-filter-priority', 'all');
  } else if (kind === 'open') {
    setSelect('ticket-filter-status', 'open');
    setSelect('ticket-filter-priority', 'all');
  } else if (kind === 'emergency') {
    setSelect('ticket-filter-status', 'active');
    setSelect('ticket-filter-priority', 'emergency');
  } else if (kind === 'resolved') {
    setSelect('ticket-filter-status', 'resolved');
    setSelect('ticket-filter-priority', 'all');
  } else if (kind === 'all') {
    setSelect('ticket-filter-status', 'all');
    setSelect('ticket-filter-priority', 'all');
  }
  syncActiveState();
}

function applyDateFilter(kind) {
  setSelect('ticket-filter-date', kind);
  syncActiveState();
}

function queueKey() {
  const status = el('ticket-filter-status')?.value || 'active';
  const priority = el('ticket-filter-priority')?.value || 'all';
  if (status === 'active' && priority === 'all') return 'unresolved';
  if (status === 'open' && priority === 'all') return 'open';
  if (status === 'active' && priority === 'emergency') return 'emergency';
  if (status === 'resolved' && priority === 'all') return 'resolved';
  if (status === 'all' && priority === 'all') return 'all';
  return '';
}

function syncActiveState() {
  const host = el(HOST_ID);
  if (!host) return;
  const activeQueue = queueKey();
  const activeDate = el('ticket-filter-date')?.value || 'all';
  host.querySelectorAll('[data-p5-ticket-queue]').forEach((button) => {
    const active = button.dataset.p5TicketQueue === activeQueue;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  host.querySelectorAll('[data-p5-ticket-date]').forEach((button) => {
    const active = button.dataset.p5TicketDate === activeDate;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function hideDuplicatedLegacyControls() {
  ['ticket-filter-status', 'ticket-filter-date'].forEach((id) => {
    const node = el(id);
    if (!node) return;
    node.classList.add('p5-source-filter-hidden');
    node.setAttribute('aria-hidden', 'true');
    node.tabIndex = -1;
  });
  const filters = document.querySelector('#page-tickets .ticket-filters');
  if (filters) filters.classList.add('p5-ticket-filters-condensed');
}

function injectStyles() {
  if (el('phase5-ticket-quick-filter-styles')) return;
  const style = document.createElement('style');
  style.id = 'phase5-ticket-quick-filter-styles';
  style.textContent = `
    #${HOST_ID}{display:grid;gap:8px;margin:12px 0}
    .p5-ticket-filter-row{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
    .p5-ticket-filter-label{font-size:11px;font-weight:800;opacity:.62;min-width:72px}
    .p5-ticket-chip{border:1px solid rgba(100,116,139,.22);background:rgba(148,163,184,.06);border-radius:999px;padding:7px 11px;font-size:12px;font-weight:750;cursor:pointer}
    .p5-ticket-chip.active{background:rgba(59,130,246,.14);border-color:rgba(59,130,246,.34)}
    .p5-ticket-chip.emergency.active{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.35)}
    .p5-ticket-filter-note{font-size:11px;opacity:.6}
    #page-tickets .ticket-filters .p5-source-filter-hidden{display:none!important}
    #page-tickets .ticket-filters.p5-ticket-filters-condensed{grid-template-columns:minmax(220px,2fr) minmax(150px,1fr) minmax(150px,1fr)}
    @media(max-width:720px){#page-tickets .ticket-filters.p5-ticket-filters-condensed{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}

function renderLabels() {
  const host = el(HOST_ID);
  if (!host) return;
  ensureAllStatusOption();
  host.innerHTML = `
    <div class="p5-ticket-filter-row">
      <span class="p5-ticket-filter-label">${t('القائمة', 'Queue')}</span>
      <button type="button" class="p5-ticket-chip" data-p5-ticket-queue="unresolved">${t('غير المحلولة', 'Unresolved')}</button>
      <button type="button" class="p5-ticket-chip" data-p5-ticket-queue="open">${t('مفتوحة', 'Open')}</button>
      <button type="button" class="p5-ticket-chip emergency" data-p5-ticket-queue="emergency">${t('طوارئ', 'Emergency')}</button>
      <button type="button" class="p5-ticket-chip" data-p5-ticket-queue="resolved">${t('محلولة', 'Resolved')}</button>
      <button type="button" class="p5-ticket-chip" data-p5-ticket-queue="all">${t('الكل', 'All')}</button>
    </div>
    <div class="p5-ticket-filter-row">
      <span class="p5-ticket-filter-label">${t('النشاط', 'Activity')}</span>
      <button type="button" class="p5-ticket-chip" data-p5-ticket-date="all">${t('كل الأيام', 'All days')}</button>
      <button type="button" class="p5-ticket-chip" data-p5-ticket-date="today">${t('اليوم', 'Today')}</button>
      <button type="button" class="p5-ticket-chip" data-p5-ticket-date="yesterday">${t('أمس', 'Yesterday')}</button>
      <button type="button" class="p5-ticket-chip" data-p5-ticket-date="last_week">${t('آخر أسبوع', 'Last week')}</button>
      <button type="button" class="p5-ticket-chip" data-p5-ticket-date="last_month">${t('آخر شهر', 'Last month')}</button>
    </div>
    <div class="p5-ticket-filter-note">${t('فلتر التاريخ يعتمد على آخر تعديل أو نشاط في التذكرة، وليس فقط تاريخ إنشائها.', 'Date filters use the ticket’s latest update/activity, not only its creation date.')}</div>`;

  host.querySelectorAll('[data-p5-ticket-queue]').forEach((button) => {
    button.addEventListener('click', () => applyQueueFilter(button.dataset.p5TicketQueue || 'unresolved'));
  });
  host.querySelectorAll('[data-p5-ticket-date]').forEach((button) => {
    button.addEventListener('click', () => applyDateFilter(button.dataset.p5TicketDate || 'all'));
  });
  hideDuplicatedLegacyControls();
  syncActiveState();
}

function mount() {
  const filters = document.querySelector('#page-tickets .ticket-filters');
  if (!filters) return false;
  ensureAllStatusOption();
  let host = el(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    filters.insertAdjacentElement('beforebegin', host);
  }
  injectStyles();
  renderLabels();
  ['ticket-filter-status', 'ticket-filter-priority', 'ticket-filter-date'].forEach((id) => {
    const node = el(id);
    if (node && !node.dataset.p5QuickHooked) {
      node.dataset.p5QuickHooked = '1';
      node.addEventListener('change', syncActiveState);
      node.addEventListener('input', syncActiveState);
    }
  });
  return true;
}

function boot() {
  mount();
  window.addEventListener('telesyriana:language-changed', () => renderLabels());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
