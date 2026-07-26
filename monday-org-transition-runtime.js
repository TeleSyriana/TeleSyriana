// monday-org-transition-runtime.js — runtime guard for the 27 July 2026 iPro change
//
// Enforces disabled identities and publishes the employee's effective identity.
// Authentication compatibility itself is prepared before app-core.js by
// monday-auth-compat.js, so this module must never translate 2002 back to 9003.

import {
  IPRO_ORG_CHANGE_EFFECTIVE_MS,
  isIproMondayOrgChangeEffective,
  seedIdentityByCcms,
} from './employee-identity-seed.js';

const USER_KEY = 'telesyrianaUser';
let transitionTimer = null;
let logoutInProgress = false;

function clean(value) {
  return String(value ?? '').trim();
}

function readSession() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
  catch { return null; }
}

function sessionIdentity() {
  const session = readSession();
  const id = clean(session?.ccmsId || session?.id);
  return id ? seedIdentityByCcms(id) : null;
}

function showLoginError(message) {
  const box = document.getElementById('login-error');
  if (!box) return;
  box.textContent = message;
  box.classList.remove('hidden');
}

function disabledMessage(identity) {
  const isArabic = (document.body?.dataset?.language || document.documentElement.lang || 'en') === 'ar';
  if (identity?.inactiveReason === 'resigned') {
    return isArabic ? 'هذا الحساب غير نشط لأن الموظف لم يعد ضمن فريق العمل.' : 'This account is inactive because the employee is no longer on the team.';
  }
  return isArabic ? 'هذا الحساب غير نشط حالياً. تواصل مع الإدارة إذا كنت تعتقد أن هذا خطأ.' : 'This account is currently inactive. Contact management if you believe this is incorrect.';
}

function guardDisabledLogin(event) {
  if (!isIproMondayOrgChangeEffective(Date.now())) return;
  const form = event.target?.closest?.('#login-form');
  if (!form) return;
  const enteredId = clean(document.getElementById('ccmsId')?.value);
  const identity = seedIdentityByCcms(enteredId);
  if (!identity || identity.accountStatus === 'active') return;

  event.preventDefault();
  event.stopImmediatePropagation();
  showLoginError(disabledMessage(identity));
}

function forceDisabledSessionLogout() {
  if (!isIproMondayOrgChangeEffective(Date.now()) || logoutInProgress) return false;
  const identity = sessionIdentity();
  if (!identity || identity.accountStatus === 'active') return false;
  logoutInProgress = true;
  try {
    const button = document.getElementById('logout-btn');
    if (button) button.click();
    else {
      localStorage.removeItem(USER_KEY);
      window.location.reload();
    }
  } finally {
    window.setTimeout(() => { logoutInProgress = false; }, 500);
  }
  return true;
}

function publishEffectiveIdentity() {
  const session = readSession();
  const enteredId = clean(session?.ccmsId || session?.id);
  if (!enteredId) {
    window.__TS_EFFECTIVE_EMPLOYEE_IDENTITY__ = null;
    return;
  }
  const identity = seedIdentityByCcms(enteredId);
  window.__TS_EFFECTIVE_EMPLOYEE_IDENTITY__ = identity ? { ...identity } : null;
  if (identity) {
    try {
      window.dispatchEvent(new CustomEvent('telesyriana:effective-identity-changed', {
        detail: {
          employeeUid: identity.employeeUid,
          ccmsId: identity.ccmsId,
          previousCcmsIds: [...(identity.previousCcmsIds || [])],
          roleKey: identity.roleKey,
          accountStatus: identity.accountStatus,
        },
      }));
    } catch {}
  }
}

function syncSession() {
  if (forceDisabledSessionLogout()) return;
  publishEffectiveIdentity();
}

function scheduleEffectiveBoundary() {
  if (transitionTimer) clearTimeout(transitionTimer);
  const delay = IPRO_ORG_CHANGE_EFFECTIVE_MS - Date.now();
  if (delay <= 0) return;
  transitionTimer = setTimeout(() => {
    transitionTimer = null;
    window.location.reload();
  }, Math.min(delay + 250, 2_147_000_000));
}

function boot() {
  document.addEventListener('submit', guardDisabledLogin, true);
  window.addEventListener('telesyriana:user-changed', syncSession);
  window.addEventListener('storage', (event) => { if (event.key === USER_KEY) syncSession(); });
  syncSession();
  scheduleEffectiveBoundary();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
