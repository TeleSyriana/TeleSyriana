// employees-ui.js — TeleSyriana Phase 1 account-management safety loader
// Preserves the employee management UI in employees-ui-core.js and adds only
// duplicate-CCMS protection plus self-role lockout protection.

const CORE_URL = new URL('./employees-ui-core.js', import.meta.url);
const DIRECTORY_URL = new URL('./employee-directory.js', import.meta.url).href;

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`Employees UI marker missing: ${label}`);
  return source.replace(oldText, newText);
}

function patchEmployeesUi(coreSource) {
  let source = String(coreSource || '');

  source = replaceRequired(
    source,
    '} from "./employee-directory.js";',
    `} from ${JSON.stringify(DIRECTORY_URL)};`,
    'employee directory import'
  );

  source = replaceRequired(
    source,
    '  fillRoleOptions(row?.role || "agent");\n  fillSupervisorOptions(row?.supervisorId || "");\n  const self = row && isSelf(row);\n  document.getElementById("employee-status").value = row?.accountStatus || "active";\n  document.getElementById("employee-status").disabled = Boolean(self);',
    '  fillRoleOptions(row?.role || "agent");\n  fillSupervisorOptions(row?.supervisorId || "");\n  const self = row && isSelf(row);\n  document.getElementById("employee-role").disabled = Boolean(self);\n  document.getElementById("employee-status").value = row?.accountStatus || "active";\n  document.getElementById("employee-status").disabled = Boolean(self);',
    'self role lock'
  );

  source = replaceRequired(
    source,
    '  const password = String(document.getElementById("employee-password")?.value || "");\n  if (!existing && !password.trim()) return modalAlert(t("كلمة المرور المؤقتة مطلوبة للموظف الجديد.", "Temporary password is required for a new employee."), true);\n  const requestedRole = document.getElementById("employee-role")?.value || "agent";\n  if (!allowedRoles(actor).includes(requestedRole)) return modalAlert(t("لا يمكنك تعيين هذا الدور.", "You cannot assign this role."), true);\n  const self = existing && isSelf(existing, actor);',
    '  const password = String(document.getElementById("employee-password")?.value || "");\n  if (!editingId && employees.some((row) => String(row.id) === id)) return modalAlert(t("رقم CCMS مستخدم مسبقاً. افتح الموظف الموجود للتعديل بدلاً من إنشاء حساب جديد.", "This CCMS ID already exists. Edit the existing employee instead of creating a duplicate account."), true);\n  if (!existing && !password.trim()) return modalAlert(t("كلمة المرور المؤقتة مطلوبة للموظف الجديد.", "Temporary password is required for a new employee."), true);\n  const self = existing && isSelf(existing, actor);\n  const requestedRole = self ? existing.role : (document.getElementById("employee-role")?.value || "agent");\n  if (!allowedRoles(actor).includes(requestedRole)) return modalAlert(t("لا يمكنك تعيين هذا الدور.", "You cannot assign this role."), true);',
    'duplicate CCMS and self role save protection'
  );

  if (!source.includes('This CCMS ID already exists.')) throw new Error('Employees UI validation failed: duplicate CCMS protection missing.');
  if (!source.includes('document.getElementById("employee-role").disabled = Boolean(self);')) throw new Error('Employees UI validation failed: self-role lock missing.');
  return source;
}

async function loadEmployeesUi() {
  try {
    const response = await fetch(CORE_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load Employees UI core (HTTP ${response.status}).`);
    const patchedSource = patchEmployeesUi(await response.text());
    const blobUrl = URL.createObjectURL(new Blob([patchedSource], { type: 'text/javascript' }));
    try { await import(blobUrl); }
    finally { URL.revokeObjectURL(blobUrl); }
  } catch (err) {
    console.error('Employees UI safety bridge failed. Falling back to untouched Employees UI core.', err);
    await import(CORE_URL.href);
  }
}

await loadEmployeesUi();
