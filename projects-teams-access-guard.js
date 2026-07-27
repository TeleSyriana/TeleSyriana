// projects-teams-access-guard.js — final UI visibility boundary for Projects & Teams.
// Only CEO, ACM and HR may see/open this surface. Supervisor/Agent/IT stay hidden.

import { seedIdentityByCcms } from './employee-identity-seed.js';

const USER_KEY = 'telesyrianaUser';
const NAV_ID = 'nav-projects-teams-v2';
const PAGE_ID = 'page-projects-teams-v2';
const ALLOWED_ROLES = new Set(['ceo', 'acm', 'hr']);
let observer = null;

function clean(value) {
  return String(value ?? '').trim();
}

function canonicalRole(role) {
  const value = clean(role).toLowerCase();
  if (value === 'admin') return 'ceo';
  if (value === 'manager') return 'acm';
  return value;
}

function readSession() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
  catch { return null; }
}

function effectiveRole() {
  const session = readSession();
  const id = clean(session?.ccmsId || session?.id);
  const seeded = id ? seedIdentityByCcms(id) : null;
  return canonicalRole(seeded?.roleKey || session?.roleKey || session?.role);
}

function enforce() {
  const allowed = ALLOWED_ROLES.has(effectiveRole());
  const nav = document.getElementById(NAV_ID);
  const page = document.getElementById(PAGE_ID);
  if (nav && !allowed) nav.classList.add('hidden');
  if (page && !allowed) page.classList.add('hidden');
}

function boot() {
  enforce();
  window.addEventListener('telesyriana:user-changed', enforce);
  window.addEventListener('telesyriana:effective-identity-changed', enforce);
  window.addEventListener('telesyriana:language-changed', enforce);
  window.addEventListener('storage', (event) => { if (event.key === USER_KEY) enforce(); });

  const dashboard = document.getElementById('dashboard-screen');
  if (dashboard && !observer) {
    observer = new MutationObserver(enforce);
    observer.observe(dashboard, { attributes: true, childList: true, subtree: true, attributeFilter: ['class'] });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
