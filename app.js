// app.js — TeleSyriana Phase 1 migration loader
// Keeps the previous production app byte-for-byte in app-core.js and applies
// only the central employee-directory auth/session migration at module load.
// If an expected source marker ever changes, TeleSyriana falls back to the
// untouched core app instead of running a partially patched build.

const CORE_URL = new URL('./app-core.js', import.meta.url);
const FIREBASE_URL = new URL('./firebase.js', import.meta.url).href;
const DIRECTORY_URL = new URL('./employee-directory.js', import.meta.url).href;
const EMPLOYEES_UI_URL = new URL('./employees-ui.js', import.meta.url).href;

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) {
    throw new Error(`Phase 1 loader marker missing: ${label}`);
  }
  return source.replace(oldText, newText);
}

function replaceBetweenRequired(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Phase 1 loader start marker missing: ${label}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Phase 1 loader end marker missing: ${label}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function patchCoreApp(coreSource) {
  let source = String(coreSource || '');

  const imports = `import { db, fs } from ${JSON.stringify(FIREBASE_URL)};\nimport {\n  authenticateEmployee,\n  employeeIsActive,\n  getEmployee,\n  normaliseRole,\n  roleLevel,\n  safeEmployeePayload,\n} from ${JSON.stringify(DIRECTORY_URL)};\nimport ${JSON.stringify(EMPLOYEES_UI_URL)};`;

  source = replaceRequired(
    source,
    'import { db, fs } from "./firebase.js";',
    imports,
    'firebase import'
  );

  source = replaceBetweenRequired(
    source,
    '// Demo users\n',
    'function hasRoleAtLeast(user, role) {',
    '',
    'legacy USERS and role helpers'
  );

  const savedSessionStart = '        const u = JSON.parse(savedUser);\n        if (USERS[u.id]) {';
  const savedSessionEnd = '      }\n    }\n  } catch (err) {';
  const savedSessionReplacement = `        const u = JSON.parse(savedUser);\n        const directoryUser = await getEmployee(u?.id, { allowLegacyFallback: true });\n        if (directoryUser && employeeIsActive(directoryUser)) {\n          // Always refresh a saved browser session from the central directory so\n          // promotions, disabled accounts and profile edits apply after reload.\n          setAppLoading(30, loadingText("تحميل الصلاحيات", "Loading permissions"), loadingText("تحديث دور المستخدم من النظام…", "Refreshing the user role from the employee directory…"));\n          currentUser = safeEmployeePayload(directoryUser);\n          localStorage.setItem(USER_KEY, JSON.stringify(currentUser));\n          setAppLoading(48, loadingText("تحميل جلسة اليوم", "Loading today’s session"), loadingText("قراءة حالة الدوام الحالية…", "Reading the current work state…"));\n          await initStateForUser();\n          setAppLoading(72, loadingText("فتح لوحة التحكم", "Opening dashboard"), loadingText("تجهيز الصفحة الرئيسية…", "Preparing the home page…"));\n          showDashboard();\n          window.dispatchEvent(new Event("telesyriana:user-changed"));\n          return;\n        }\n        localStorage.removeItem(USER_KEY);\n`;

  source = replaceBetweenRequired(
    source,
    savedSessionStart,
    savedSessionEnd,
    savedSessionReplacement,
    'saved-session directory refresh'
  );

  source = replaceRequired(
    source,
    '  if (!USERS[id]) return showError("المستخدم غير موجود. جرّب 0001 أو 1001 أو 2001 أو 3001 أو 9001 أو 9002 أو 9003.");\n  if (USERS[id].password !== pw) return showError(getLanguage() === "ar" ? "كلمة المرور غير صحيحة." : "Incorrect password.");\n\n',
    '',
    'legacy login pre-checks'
  );

  const loginAssignment = '    setAppLoading(24, loadingText("تسجيل الدخول صحيح", "Login accepted"), loadingText("تحميل دور المستخدم والصلاحيات…", "Loading user role and permissions…"));\n    currentUser = safeUserPayload(id);';
  const directoryLogin = `    const auth = await authenticateEmployee(id, pw);\n    if (!auth.ok) {\n      hideAppLoading(0);\n      const authMessages = {\n        not_found: loadingText("المستخدم غير موجود.", "Employee not found."),\n        incorrect_password: loadingText("كلمة المرور غير صحيحة.", "Incorrect password."),\n        disabled: loadingText("هذا الحساب معطّل. تواصل مع الإدارة.", "This account is disabled. Contact management."),\n        archived: loadingText("هذا الحساب مؤرشف.", "This account is archived."),\n      };\n      showError(authMessages[auth.reason] || loadingText("تعذر تسجيل الدخول.", "Login unavailable."));\n      return;\n    }\n\n    setAppLoading(24, loadingText("تسجيل الدخول صحيح", "Login accepted"), loadingText("تحميل دور المستخدم والصلاحيات…", "Loading user role and permissions…"));\n    currentUser = auth.employee;`;

  source = replaceRequired(
    source,
    loginAssignment,
    directoryLogin,
    'directory login assignment'
  );

  source = replaceRequired(
    source,
    'let staffSettingsUnsub = null;\nlet issueStatsByDay = {};',
    'let staffSettingsUnsub = null;\nlet employeeAccountUnsub = null;\nlet issueStatsByDay = {};',
    'current employee watcher state'
  );

  const employeeWatcher = `function subscribeCurrentEmployeeAccount() {\n  if (!currentUser?.id) return;\n  try { employeeAccountUnsub?.(); } catch {}\n  employeeAccountUnsub = null;\n\n  const ref = doc(collection(db, "employees"), String(currentUser.id));\n  employeeAccountUnsub = onSnapshot(ref, async (snap) => {\n    if (!snap.exists() || !currentUser?.id) return;\n    try {\n      const employee = await getEmployee(currentUser.id, { allowLegacyFallback: true });\n      if (!employee) return;\n      if (!employeeIsActive(employee)) {\n        showToast(getLanguage() === "ar" ? "تم تعطيل أو أرشفة هذا الحساب من الإدارة." : "This account was disabled or archived by management.", "warning", 5000);\n        await handleLogout();\n        return;\n      }\n\n      const nextUser = safeEmployeePayload(employee);\n      const changed = ["name", "role", "supervisorId", "hourlyRate", "currency", "timezone", "language", "accountStatus"]\n        .some((key) => String(currentUser?.[key] ?? "") !== String(nextUser?.[key] ?? ""));\n      if (!changed) return;\n\n      currentUser = nextUser;\n      localStorage.setItem(USER_KEY, JSON.stringify(currentUser));\n\n      if (canViewTeamDashboard(currentUser)) subscribeSupervisorDashboard();\n      else if (supUnsub) { try { supUnsub(); } catch {} supUnsub = null; }\n\n      updateDashboardUI();\n      window.dispatchEvent(new Event("telesyriana:user-changed"));\n    } catch (err) {\n      console.warn("Employee account refresh failed", err);\n    }\n  }, (err) => console.warn("Employee account listener failed", err));\n}\n\n`;
  source = replaceRequired(
    source,
    '/* --------------------------- Widgets (Clock/Date) ------------------------ */',
    employeeWatcher + '/* --------------------------- Widgets (Clock/Date) ------------------------ */',
    'current employee watcher function'
  );

  source = replaceRequired(
    source,
    'function finishInit(now) {\n  if (canViewTeamDashboard(currentUser)) subscribeSupervisorDashboard();',
    'function finishInit(now) {\n  subscribeCurrentEmployeeAccount();\n  if (canViewTeamDashboard(currentUser)) subscribeSupervisorDashboard();',
    'start current employee watcher'
  );

  source = replaceRequired(
    source,
    '  try { if (staffSettingsUnsub) staffSettingsUnsub(); } catch {}\n  staffSettingsUnsub = null;\n  currentStaffSettings = {};',
    '  try { if (staffSettingsUnsub) staffSettingsUnsub(); } catch {}\n  staffSettingsUnsub = null;\n  try { employeeAccountUnsub?.(); } catch {}\n  employeeAccountUnsub = null;\n  currentStaffSettings = {};',
    'stop current employee watcher on logout'
  );

  if (source.includes('const USERS = {') || source.includes('safeUserPayload(id)')) {
    throw new Error('Phase 1 loader validation failed: legacy auth code remains.');
  }
  if (!source.includes('authenticateEmployee(id, pw)') || !source.includes('getEmployee(u?.id') || !source.includes('subscribeCurrentEmployeeAccount()')) {
    throw new Error('Phase 1 loader validation failed: directory auth was not injected.');
  }

  return source;
}

async function loadTeleSyriana() {
  try {
    const response = await fetch(CORE_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load core app (HTTP ${response.status}).`);
    const patchedSource = patchCoreApp(await response.text());
    const blobUrl = URL.createObjectURL(new Blob([patchedSource], { type: 'text/javascript' }));
    try {
      await import(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  } catch (err) {
    console.error('Phase 1 employee-directory loader failed. Falling back to the untouched core app.', err);
    await import(CORE_URL.href);
  }
}

await loadTeleSyriana();
