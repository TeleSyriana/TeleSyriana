// projects-teams-access-guard.js — final UI visibility boundary for Projects & Teams.
// Only CEO, ACM and HR may see/open this surface. Supervisor/Agent/IT stay hidden.
//
// Important performance rule: do not observe the entire dashboard DOM. Home widgets,
// clocks, presence and team tables mutate frequently; a subtree MutationObserver here
// causes needless access checks and can create render churn on weaker devices.

import { seedIdentityByCcms } from './employee-identity-seed.js';

const USER_KEY = 'telesyrianaUser';
const NAV_ID = 'nav-projects-teams-v2';
const PAGE_ID = 'page-projects-teams-v2';
const ALLOWED_ROLES = new Set(['ceo', 'acm', 'hr']);
let scheduled = false;

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

function allowed() {
  return ALLOWED_ROLES.has(effectiveRole());
}

function enforceNow() {
  scheduled = false;
  const canOpen = allowed();
  const nav = document.getElementById(NAV_ID);
  const page = document.getElementById(PAGE_ID);

  if (nav) nav.classList.toggle('hidden', !canOpen);
  if (page && !canOpen) page.classList.add('hidden');
}

function enforce() {
  if (scheduled) return;
  scheduled = true;
  const run = () => enforceNow();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
}

function blockUnauthorizedOpen(event) {
  const target = event.target?.closest?.(`#${NAV_ID}, [data-page="projects-teams-v2"]`);
  if (!target || allowed()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  enforce();
}

function boot() {
  enforceNow();
  window.addEventListener('telesyriana:user-changed', enforce);
  window.addEventListener('telesyriana:effective-identity-changed', enforce);
  window.addEventListener('telesyriana:language-changed', enforce);
  window.addEventListener('storage', (event) => { if (event.key === USER_KEY) enforce(); });
  document.addEventListener('click', blockUnauthorizedOpen, true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
