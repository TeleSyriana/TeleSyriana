// Secure management-only credential provisioning UI.
// Passwords are entered at runtime and sent directly to the existing hashed credential layer.
// No plaintext password is stored in source code or localStorage.

import {
  getEmployeeCredentialState,
  provisionTemporaryEmployeeCredential,
} from './employee-auth-v2.js';
import { seedIdentityByCcms } from './employee-identity-seed.js';

const USER_KEY = 'telesyrianaUser';
const PANEL_ID = 'credential-provisioning-panel';
const MANAGEMENT_ROLES = new Set(['admin', 'manager', 'ceo', 'acm', 'hr']);

function clean(value) {
  return String(value ?? '').trim();
}

function readActor() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

function actorRole(actor) {
  return clean(actor?.roleKey || actor?.role).toLowerCase();
}

function canProvision(actor = readActor()) {
  return Boolean(actor && MANAGEMENT_ROLES.has(actorRole(actor)));
}

function isArabic() {
  return (document.documentElement.lang || document.body?.dataset?.language || 'ar').toLowerCase() === 'ar';
}

function setStatus(message, type = 'info') {
  const el = document.getElementById('credential-provisioning-status');
  if (!el) return;
  el.textContent = message;
  el.dataset.type = type;
}

async function provision(event) {
  event.preventDefault();
  const actor = readActor();
  if (!canProvision(actor)) return;

  const ccmsInput = document.getElementById('credential-provisioning-ccms');
  const passwordInput = document.getElementById('credential-provisioning-password');
  const submit = document.getElementById('credential-provisioning-submit');
  const ccmsId = clean(ccmsInput?.value).replace(/\D+/g, '');
  const password = String(passwordInput?.value || '');
  const ar = isArabic();

  if (!ccmsId || !password) {
    setStatus(ar ? 'أدخل رقم CCMS وكلمة المرور المؤقتة.' : 'Enter a CCMS ID and temporary password.', 'error');
    return;
  }

  const identity = seedIdentityByCcms(ccmsId);
  if (!identity) {
    setStatus(ar ? 'لم يتم العثور على موظف بهذا الرقم.' : 'No employee was found with that CCMS ID.', 'error');
    return;
  }
  if (identity.accountStatus !== 'active') {
    setStatus(ar ? 'الحساب غير نشط ولا يمكن تجهيز كلمة مرور له.' : 'This account is not active and cannot be provisioned.', 'error');
    return;
  }

  submit.disabled = true;
  setStatus(ar ? 'جاري تجهيز بيانات الدخول المشفّرة…' : 'Provisioning encrypted credentials…');
  try {
    const existing = await getEmployeeCredentialState(identity.employeeUid);
    if (existing?.exists) {
      const proceed = window.confirm(ar
        ? 'يوجد بالفعل Credential لهذا الموظف. هل تريد استبداله بكلمة مرور مؤقتة جديدة؟'
        : 'A credential already exists for this employee. Replace it with a new temporary password?');
      if (!proceed) {
        setStatus(ar ? 'تم الإلغاء.' : 'Cancelled.');
        return;
      }
    }

    await provisionTemporaryEmployeeCredential(identity, password, actor);
    if (passwordInput) passwordInput.value = '';
    setStatus(
      ar
        ? `تم تجهيز ${identity.fullName} (${identity.ccmsId}) بنجاح. يمكنها تسجيل الدخول الآن ويجب تغيير كلمة المرور بعد أول دخول.`
        : `${identity.fullName} (${identity.ccmsId}) is provisioned. They can sign in now and must change the temporary password after first login.`,
      'success'
    );
  } catch (error) {
    console.error('Credential provisioning failed', error);
    setStatus(
      ar ? `فشل تجهيز الحساب: ${error?.message || error}` : `Credential provisioning failed: ${error?.message || error}`,
      'error'
    );
  } finally {
    submit.disabled = false;
  }
}

function ensurePanel() {
  const actor = readActor();
  let panel = document.getElementById(PANEL_ID);
  if (!canProvision(actor)) {
    panel?.remove();
    return;
  }

  const settingsPage = document.getElementById('page-settings');
  if (!settingsPage || panel) return;

  const ar = isArabic();
  panel = document.createElement('section');
  panel.id = PANEL_ID;
  panel.className = 'card';
  panel.style.marginTop = '16px';
  panel.innerHTML = `
    <h2>${ar ? 'تجهيز بيانات دخول موظف' : 'Provision employee login'}</h2>
    <p class="subtitle">${ar ? 'للـ CEO / ACM / HR فقط. كلمة المرور تُشفّر قبل حفظها ولا تُخزّن داخل GitHub.' : 'CEO / ACM / HR only. The password is hashed before storage and is never stored in GitHub.'}</p>
    <form id="credential-provisioning-form">
      <label>${ar ? 'رقم الموظف CCMS' : 'Employee CCMS'}
        <input id="credential-provisioning-ccms" type="text" inputmode="numeric" dir="ltr" autocomplete="off" placeholder="9004" required />
      </label>
      <label>${ar ? 'كلمة المرور المؤقتة' : 'Temporary password'}
        <input id="credential-provisioning-password" type="password" dir="ltr" autocomplete="new-password" required />
      </label>
      <button id="credential-provisioning-submit" class="btn-primary" type="submit">${ar ? 'تجهيز الحساب' : 'Provision account'}</button>
      <div id="credential-provisioning-status" style="margin-top:10px;font-size:13px"></div>
    </form>`;
  settingsPage.appendChild(panel);
  panel.querySelector('#credential-provisioning-form')?.addEventListener('submit', provision);
}

function refresh() {
  ensurePanel();
}

window.addEventListener('telesyriana:user-changed', refresh);
document.addEventListener('click', (event) => {
  if (event.target?.closest?.('[data-page="settings"]')) window.setTimeout(refresh, 0);
});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh, { once: true });
else refresh();
