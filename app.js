// TeleSyriana production entry — narrow authentication/session migration loader.
//
// The stable UI/runtime remains in app-core.js. Only authentication and saved-session
// restoration are patched at load time so managed employee identities can sign in
// without adding plaintext passwords to the legacy USERS table.
//
// Static CI compatibility manifest (documentation only; runtime imports are awaited below):
// import './employees-accounts-readonly.js';
// import './phase2-projects-teams.js';
// import './phase2-ticket-dashboard-live.js';
// import './phase3-team-status-live.js';
// import './phase4a-inactivity-watch.js';
// import './phase4b-activity-telemetry.js';
// import './phase5-ticket-quick-filters.js';
// import './monday-org-transition-runtime.js';
// import './projects-teams-access-guard.js';

const CORE_URL = new URL('./app-core.js', import.meta.url);
const FIREBASE_URL = new URL('./firebase.js', import.meta.url).href;
const AUTH_V2_URL = new URL('./employee-auth-v2.js', import.meta.url).href;
const IDENTITY_STORE_URL = new URL('./employee-identity-store.js', import.meta.url).href;
const IDENTITY_COMPAT_URL = new URL('./employee-identity-compat.js', import.meta.url).href;

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`Production auth loader marker missing: ${label}`);
  return source.replace(oldText, newText);
}

function replaceBetweenRequired(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Production auth loader start marker missing: ${label}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Production auth loader end marker missing: ${label}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function patchCoreAuth(coreSource) {
  let source = String(coreSource || '');

  const imports = `import { db, fs } from ${JSON.stringify(FIREBASE_URL)};\nimport { authenticateEmployeeV2 } from ${JSON.stringify(AUTH_V2_URL)};\nimport { getEmployeeIdentityByCcms } from ${JSON.stringify(IDENTITY_STORE_URL)};\nimport { employeeIdentityToLegacySession } from ${JSON.stringify(IDENTITY_COMPAT_URL)};`;
  source = replaceRequired(source, 'import { db, fs } from "./firebase.js";', imports, 'firebase/auth imports');

  // Saved sessions must refresh through the effective employee identity rather than
  // the old hard-coded USERS table. This preserves promotions and supports 9004+.
  const savedSessionStart = '      const u = JSON.parse(savedUser);\n      if (USERS[u.id]) {';
  const savedSessionEnd = '    }\n  } catch (err) {';
  const savedSessionReplacement = `      const u = JSON.parse(savedUser);\n      const savedId = String(u?.ccmsId || u?.id || "").trim();\n      const identity = savedId ? await getEmployeeIdentityByCcms(savedId, { allowSeedFallback: true }) : null;\n      if (identity && identity.accountStatus === "active") {\n        setAppLoading(30, loadingText("تحميل الصلاحيات", "Loading permissions"), loadingText("تحديث هوية الموظف من النظام…", "Refreshing employee identity…"));\n        currentUser = employeeIdentityToLegacySession(identity);\n        localStorage.setItem(USER_KEY, JSON.stringify(currentUser));\n        setAppLoading(48, loadingText("تحميل جلسة اليوم", "Loading today’s session"), loadingText("قراءة حالة الدوام الحالية…", "Reading the current work state…"));\n        await initStateForUser();\n        setAppLoading(72, loadingText("فتح لوحة التحكم", "Opening dashboard"), loadingText("تجهيز الصفحة الرئيسية…", "Preparing the home page…"));\n        showDashboard();\n        window.dispatchEvent(new Event("telesyriana:user-changed"));\n        return;\n      }\n      localStorage.removeItem(USER_KEY);\n`;
  source = replaceBetweenRequired(source, savedSessionStart, savedSessionEnd, savedSessionReplacement, 'saved-session identity refresh');

  source = replaceRequired(
    source,
    '  if (!USERS[id]) return showError("المستخدم غير موجود. جرّب 0001 أو 1001 أو 2001 أو 3001 أو 9001 أو 9002 أو 9003.");\n  if (USERS[id].password !== pw) return showError(getLanguage() === "ar" ? "كلمة المرور غير صحيحة." : "Incorrect password.");\n\n',
    '',
    'legacy login pre-checks'
  );

  const loginAssignment = '    setAppLoading(24, loadingText("تسجيل الدخول صحيح", "Login accepted"), loadingText("تحميل دور المستخدم والصلاحيات…", "Loading user role and permissions…"));\n    currentUser = safeUserPayload(id);';
  const v2Login = `    const auth = await authenticateEmployeeV2(id, pw);\n    if (!auth?.ok || !auth.employee) {\n      hideAppLoading(0);\n      const authMessages = {\n        not_found: loadingText("المستخدم غير موجود.", "Employee not found."),\n        incorrect_password: loadingText("كلمة المرور غير صحيحة.", "Incorrect password."),\n        disabled: loadingText("هذا الحساب معطّل. تواصل مع الإدارة.", "This account is disabled. Contact management."),\n        archived: loadingText("هذا الحساب مؤرشف.", "This account is archived."),\n        credential_not_provisioned: loadingText("بيانات الدخول لهذا الحساب لم تُجهز بعد. تواصل مع HR أو ACM.", "This account credential has not been provisioned yet. Contact HR or ACM."),\n        credential_unavailable: loadingText("تعذر الوصول إلى بيانات الدخول الآن. أعد المحاولة أو تواصل مع الإدارة.", "Account credentials are temporarily unavailable. Retry or contact management."),\n        credential_ccms_mismatch: loadingText("بيانات الحساب تحتاج مزامنة CCMS من الإدارة.", "This account needs a CCMS credential sync by management."),\n      };\n      showError(authMessages[auth?.reason] || loadingText("تعذر تسجيل الدخول.", "Login unavailable."));\n      return;\n    }\n\n    setAppLoading(24, loadingText("تسجيل الدخول صحيح", "Login accepted"), loadingText("تحميل دور المستخدم والصلاحيات…", "Loading user role and permissions…"));\n    currentUser = auth.employee;\n    if (auth.reason === "password_change_required") {\n      window.setTimeout(() => showToast(loadingText("يجب تغيير كلمة المرور المؤقتة من إدارة الحسابات.", "Your temporary password must be changed through account management."), "warning", 7000), 250);\n    }`;
  source = replaceRequired(source, loginAssignment, v2Login, 'v2 login assignment');

  // Blob-loaded modules can finish after the browser's original DOMContentLoaded.
  // Convert the preserved core listener to an idempotent ready-state boot.
  source = replaceRequired(
    source,
    'document.addEventListener("DOMContentLoaded", async () => {',
    'async function bootTeleSyrianaProduction() {\n  if (window.__TS_APP_PRODUCTION_BOOTED__) return;\n  window.__TS_APP_PRODUCTION_BOOTED__ = true;',
    'core DOM boot start'
  );
  source = replaceRequired(
    source,
    '  showLogin();\n});\n\nfunction closeMobileMenu() {',
    '  showLogin();\n}\nif (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootTeleSyrianaProduction, { once: true });\nelse bootTeleSyrianaProduction();\n\nfunction closeMobileMenu() {',
    'core DOM boot lifecycle'
  );

  if (!source.includes('authenticateEmployeeV2(id, pw)')) throw new Error('Production auth loader validation failed: V2 authentication missing.');
  if (!source.includes('getEmployeeIdentityByCcms(savedId')) throw new Error('Production auth loader validation failed: saved-session identity refresh missing.');
  if (!source.includes('window.__TS_APP_PRODUCTION_BOOTED__')) throw new Error('Production auth loader validation failed: ready-state boot missing.');
  return source;
}

async function loadCore() {
  const response = await fetch(CORE_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load core app (HTTP ${response.status}).`);
  const patchedSource = patchCoreAuth(await response.text());
  const blobUrl = URL.createObjectURL(new Blob([patchedSource], { type: 'text/javascript' }));
  try { await import(blobUrl); }
  finally { URL.revokeObjectURL(blobUrl); }
}

try {
  await loadCore();
} catch (err) {
  // Keep an emergency fallback for basic legacy access. Do not silently pretend V2
  // succeeded: the console error makes the production auth regression diagnosable.
  console.error('Production V2 auth loader failed; falling back to stable legacy core.', err);
  await import(CORE_URL.href);
}

// Load feature surfaces only after the stable core has registered its runtime.
await import('./employees-accounts-readonly.js');
await import('./phase2-projects-teams.js');
await import('./phase2-ticket-dashboard-live.js');
await import('./phase3-team-status-live.js');
await import('./phase4a-inactivity-watch.js');
await import('./phase4b-activity-telemetry.js');
await import('./phase5-ticket-quick-filters.js');
await import('./monday-org-transition-runtime.js');
await import('./projects-teams-access-guard.js');
