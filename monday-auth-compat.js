// monday-auth-compat.js — narrow compatibility bridge for the stable legacy login core
//
// The legacy app keeps its private USERS map inside app-core.js. Until the V2
// credential store is activated, this module exposes only the two Monday identities
// that the old login map does not yet know about. The temporary inherited entries
// exist only during saved-session restore or a login submit, then are removed on the
// next task. This avoids a permanent Object.prototype mutation.

import { fs } from './firebase.js';
import {
  IPRO_ORG_CHANGE_EFFECTIVE_MS,
  isIproMondayOrgChangeEffective,
} from './employee-identity-seed.js';

const USER_KEY = 'telesyrianaUser';
const REEMA_OLD_CCMS = '9003';
const REEMA_CCMS = '2002';
const LANA_CCMS = '9004';
const DISABLED_IDS = new Set(['2001', '9002']);

// Compatibility credentials mirror the already-approved legacy credential policy.
// Never render or log these values. V2 provisioning will replace this bridge.
const COMPAT_USERS = Object.freeze({
  [REEMA_CCMS]: Object.freeze({
    password: 'Reema2026!',
    role: 'supervisor',
    name: 'Reema Obaid',
    hourlyRate: 0,
    currency: 'USD',
  }),
  [LANA_CCMS]: Object.freeze({
    password: 'Welcome2026!',
    role: 'agent',
    name: 'Lana Safar',
    supervisorId: REEMA_CCMS,
    hourlyRate: 0,
    currency: 'USD',
  }),
});

let compatInstalled = false;
let cleanupTimer = null;

function clean(value) {
  return String(value ?? '').trim();
}

function effectiveNow() {
  return isIproMondayOrgChangeEffective(Date.now());
}

function installTemporaryCompatUsers() {
  if (!effectiveNow() || compatInstalled) return;
  compatInstalled = true;
  for (const [ccmsId, user] of Object.entries(COMPAT_USERS)) {
    Object.defineProperty(Object.prototype, ccmsId, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: user,
    });
  }
}

function removeTemporaryCompatUsers() {
  if (!compatInstalled) return;
  compatInstalled = false;
  for (const ccmsId of Object.keys(COMPAT_USERS)) {
    try { delete Object.prototype[ccmsId]; } catch {}
  }
}

function keepCompatForCurrentTask() {
  installTemporaryCompatUsers();
  if (cleanupTimer) clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    removeTemporaryCompatUsers();
  }, 0);
}

function normaliseSavedSessionBeforeLegacyRestore() {
  if (!effectiveNow()) return;
  let session = null;
  try { session = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch {}
  const id = clean(session?.ccmsId || session?.id);
  if (!id) return;

  if (DISABLED_IDS.has(id)) {
    localStorage.removeItem(USER_KEY);
    return;
  }

  if (id === REEMA_OLD_CCMS) {
    localStorage.setItem(USER_KEY, JSON.stringify({ ...session, id: REEMA_CCMS, ccmsId: REEMA_CCMS }));
  }
}

function prepareLoginForLegacyCore(event) {
  if (!effectiveNow()) return;
  const form = event.target?.closest?.('#login-form');
  if (!form) return;

  const input = document.getElementById('ccmsId');
  const enteredId = clean(input?.value);
  if (enteredId === REEMA_OLD_CCMS && input) {
    input.dataset.previousCcmsId = REEMA_OLD_CCMS;
    input.value = REEMA_CCMS;
  }

  if ([REEMA_CCMS, LANA_CCMS, REEMA_OLD_CCMS].includes(enteredId)) {
    keepCompatForCurrentTask();
  }
}

// app-core.js destructures fs.setDoc during module evaluation. Because this module
// runs first, the wrapper becomes the stable core's setDoc reference. Only the
// legacy Raghad agentDays payload needs correction from old supervisor 2001 to 2002.
const originalSetDoc = fs.setDoc;
if (!fs.__mondayOrgCompatSetDoc) {
  fs.__mondayOrgCompatSetDoc = true;
  fs.setDoc = async (reference, data, options) => {
    let next = data;
    if (
      Date.now() >= IPRO_ORG_CHANGE_EFFECTIVE_MS &&
      data &&
      clean(data.userId) === '9001' &&
      clean(data.role).toLowerCase() === 'agent' &&
      Object.prototype.hasOwnProperty.call(data, 'supervisorId')
    ) {
      next = { ...data, supervisorId: REEMA_CCMS };
    }
    return originalSetDoc(reference, next, options);
  };
}

function beforeLegacyDomReady() {
  if (!effectiveNow()) return;
  normaliseSavedSessionBeforeLegacyRestore();
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
  })();
  const id = clean(saved?.ccmsId || saved?.id);
  if (id === REEMA_CCMS || id === LANA_CCMS) keepCompatForCurrentTask();
}

// Registered before app-core.js because app.js imports this module first.
document.addEventListener('submit', prepareLoginForLegacyCore, true);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', beforeLegacyDomReady, { once: true });
} else {
  beforeLegacyDomReady();
}
