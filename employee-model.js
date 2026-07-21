// employee-model.js — TeleSyriana Phase 1A pure employee identity model
//
// This module contains no Firestore or DOM dependencies. It defines the permanent
// employee identity rules that future Employees & Accounts, Projects, Chat and
// permissions will share.
//
// Important distinction:
//   employeeUid = permanent person identity (never changes on promotion)
//   ccmsId      = operational role-coded identifier (may change on promotion)

export const EMPLOYEE_ROLES = Object.freeze({
  CEO: "ceo",
  ACM: "acm",
  SUPERVISOR: "supervisor",
  HR: "hr",
  AGENT: "agent",
});

export const ACCOUNT_STATUSES = Object.freeze(["active", "disabled", "archived"]);
export const GLOBAL_PROJECT_ID = "*";
export const DEFAULT_PROJECT_ID = "ipro";

export const ROLE_CCMS_PREFIX = Object.freeze({
  [EMPLOYEE_ROLES.CEO]: "0",
  [EMPLOYEE_ROLES.ACM]: "1",
  [EMPLOYEE_ROLES.SUPERVISOR]: "2",
  [EMPLOYEE_ROLES.HR]: "3",
  [EMPLOYEE_ROLES.AGENT]: "9",
});

// Compatibility only. Existing production modules still call these roles
// "admin" and "manager". New architecture uses CEO and ACM.
export const LEGACY_ROLE_TO_CANONICAL = Object.freeze({
  admin: EMPLOYEE_ROLES.CEO,
  manager: EMPLOYEE_ROLES.ACM,
  supervisor: EMPLOYEE_ROLES.SUPERVISOR,
  hr: EMPLOYEE_ROLES.HR,
  agent: EMPLOYEE_ROLES.AGENT,
  ceo: EMPLOYEE_ROLES.CEO,
  acm: EMPLOYEE_ROLES.ACM,
});

export const CANONICAL_ROLE_TO_LEGACY = Object.freeze({
  [EMPLOYEE_ROLES.CEO]: "admin",
  [EMPLOYEE_ROLES.ACM]: "manager",
  [EMPLOYEE_ROLES.SUPERVISOR]: "supervisor",
  [EMPLOYEE_ROLES.HR]: "hr",
  [EMPLOYEE_ROLES.AGENT]: "agent",
});

function clean(value) {
  return String(value ?? "").trim();
}

export function cleanCcmsId(value) {
  return clean(value);
}

export function normaliseProjectId(value) {
  const raw = clean(value).toLowerCase();
  if (!raw) return "";
  if (raw === GLOBAL_PROJECT_ID) return GLOBAL_PROJECT_ID;
  return raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function normaliseProjectIds(values) {
  const source = Array.isArray(values) ? values : [values];
  return [...new Set(source.map(normaliseProjectId).filter(Boolean))];
}

export function normaliseCanonicalRole(role) {
  const value = clean(role).toLowerCase();
  return LEGACY_ROLE_TO_CANONICAL[value] || EMPLOYEE_ROLES.AGENT;
}

export function legacyRoleForCanonical(role) {
  return CANONICAL_ROLE_TO_LEGACY[normaliseCanonicalRole(role)] || "agent";
}

export function normaliseAccountStatus(status) {
  const value = clean(status).toLowerCase();
  return ACCOUNT_STATUSES.includes(value) ? value : "active";
}

export function roleFromCcmsId(ccmsId) {
  const id = cleanCcmsId(ccmsId);
  if (!/^\d{4}$/.test(id) || id === "0000") return null;
  const prefix = id.charAt(0);
  return Object.keys(ROLE_CCMS_PREFIX).find((role) => ROLE_CCMS_PREFIX[role] === prefix) || null;
}

export function ccmsMatchesRole(ccmsId, role) {
  const canonical = normaliseCanonicalRole(role);
  return roleFromCcmsId(ccmsId) === canonical;
}

export function assertCcmsMatchesRole(ccmsId, role) {
  const id = cleanCcmsId(ccmsId);
  if (!/^\d{4}$/.test(id) || id === "0000") {
    throw new Error("CCMS ID must be a four-digit number between 0001 and 9999.");
  }
  const canonical = normaliseCanonicalRole(role);
  const detected = roleFromCcmsId(id);
  if (!detected) {
    throw new Error(`CCMS ${id} uses a reserved role range.`);
  }
  if (detected !== canonical) {
    throw new Error(`CCMS ${id} belongs to ${detected}, not ${canonical}.`);
  }
  return id;
}

export function createEmployeeUid() {
  try {
    if (globalThis.crypto?.randomUUID) {
      return `emp_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
    }
  } catch {}

  const rand = Math.random().toString(36).slice(2, 12);
  const stamp = Date.now().toString(36);
  return `emp_${stamp}${rand}`;
}

export function isValidEmployeeUid(value) {
  return /^emp_[a-zA-Z0-9_-]{6,80}$/.test(clean(value));
}

function cleanCurrency(value) {
  const code = clean(value || "USD").toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "USD";
}

function roleProjectShape(role, input = {}) {
  const canonical = normaliseCanonicalRole(role);
  const inputProjectId = normaliseProjectId(input.projectId || input.activeProjectId || "");
  let projectIds = normaliseProjectIds(input.projectIds || input.projects || []);

  if (canonical === EMPLOYEE_ROLES.CEO) {
    return {
      projectId: GLOBAL_PROJECT_ID,
      projectIds: [GLOBAL_PROJECT_ID],
    };
  }

  if (canonical === EMPLOYEE_ROLES.HR) {
    if (inputProjectId && !projectIds.includes(inputProjectId)) projectIds.unshift(inputProjectId);
    return {
      projectId: inputProjectId || projectIds[0] || "",
      projectIds,
    };
  }

  const projectId = inputProjectId || projectIds[0] || "";
  return {
    projectId,
    projectIds: projectId ? [projectId] : [],
  };
}

export function normaliseEmployeeIdentity(input = {}, options = {}) {
  const roleKey = normaliseCanonicalRole(input.roleKey || input.role);
  const ccmsId = cleanCcmsId(input.ccmsId || input.employeeId || input.id);
  const employeeUid = clean(input.employeeUid || input.uid || options.employeeUid || "");
  const projects = roleProjectShape(roleKey, input);

  return {
    employeeUid,
    ccmsId,
    fullName: clean(input.fullName || input.name || ccmsId || employeeUid),
    name: clean(input.fullName || input.name || ccmsId || employeeUid),
    roleKey,
    legacyRole: legacyRoleForCanonical(roleKey),
    accountStatus: normaliseAccountStatus(input.accountStatus),
    projectId: projects.projectId,
    projectIds: projects.projectIds,
    supervisorUid: clean(input.supervisorUid),
    supervisorCcmsId: cleanCcmsId(input.supervisorCcmsId || input.supervisorId),
    hourlyRate: Math.max(0, Number(input.hourlyRate) || 0),
    currency: cleanCurrency(input.currency),
    timezone: clean(input.timezone || input.defaultTimezone),
    language: clean(input.language),
  };
}

export function validateEmployeeIdentity(input = {}, options = {}) {
  const employee = normaliseEmployeeIdentity(input, options);
  const errors = [];

  if (!isValidEmployeeUid(employee.employeeUid)) {
    errors.push("A permanent employeeUid is required.");
  }

  try {
    assertCcmsMatchesRole(employee.ccmsId, employee.roleKey);
  } catch (err) {
    errors.push(String(err?.message || err));
  }

  if (!employee.fullName) errors.push("Employee name is required.");

  const role = employee.roleKey;

  if (role === EMPLOYEE_ROLES.CEO) {
    if (employee.projectIds.length !== 1 || employee.projectIds[0] !== GLOBAL_PROJECT_ID) {
      errors.push("CEO must have global project access.");
    }
    if (employee.supervisorUid || employee.supervisorCcmsId) {
      errors.push("CEO cannot have a Supervisor assignment.");
    }
  }

  if (role === EMPLOYEE_ROLES.ACM || role === EMPLOYEE_ROLES.SUPERVISOR) {
    if (!employee.projectId || employee.projectIds.length !== 1) {
      errors.push(`${role} must belong to exactly one project.`);
    }
    if (employee.supervisorUid || employee.supervisorCcmsId) {
      errors.push(`${role} cannot have a Supervisor assignment.`);
    }
  }

  if (role === EMPLOYEE_ROLES.HR) {
    if (!employee.projectIds.length || employee.projectIds.includes(GLOBAL_PROJECT_ID)) {
      errors.push("HR must belong to one or more specific projects.");
    }
    if (employee.projectId && !employee.projectIds.includes(employee.projectId)) {
      errors.push("HR active project must be one of the HR assigned projects.");
    }
    if (employee.supervisorUid || employee.supervisorCcmsId) {
      errors.push("HR cannot have a Supervisor assignment.");
    }
  }

  if (role === EMPLOYEE_ROLES.AGENT) {
    if (!employee.projectId || employee.projectIds.length !== 1) {
      errors.push("Agent must belong to exactly one project.");
    }
    const supervisorRequired = options.allowPendingSupervisor !== true || employee.accountStatus === "active";
    if (supervisorRequired && !employee.supervisorUid && !employee.supervisorCcmsId) {
      errors.push("Agent must have exactly one Supervisor.");
    }
  }

  if (errors.length) {
    const error = new Error(errors.join(" "));
    error.validationErrors = errors;
    throw error;
  }

  return employee;
}

export function sameProject(employeeA, employeeB, projectId = "") {
  const explicit = normaliseProjectId(projectId);
  const a = normaliseEmployeeIdentity(employeeA);
  const b = normaliseEmployeeIdentity(employeeB);

  if (a.roleKey === EMPLOYEE_ROLES.CEO || b.roleKey === EMPLOYEE_ROLES.CEO) return true;

  const target = explicit || a.projectId;
  if (!target || target === GLOBAL_PROJECT_ID) return false;
  return a.projectIds.includes(target) && b.projectIds.includes(target);
}

export function reclassifyEmployeeIdentity(input, next = {}) {
  const current = normaliseEmployeeIdentity(input);
  if (!isValidEmployeeUid(current.employeeUid)) {
    throw new Error("Cannot reclassify an employee without a permanent employeeUid.");
  }

  const roleKey = normaliseCanonicalRole(next.roleKey || next.role || current.roleKey);
  const ccmsId = cleanCcmsId(next.ccmsId || current.ccmsId);

  // Permanent identity is intentionally copied unchanged.
  return normaliseEmployeeIdentity({
    ...current,
    ...next,
    employeeUid: current.employeeUid,
    ccmsId,
    roleKey,
  });
}

export function nextAvailableCcmsId(role, usedIds = []) {
  const canonical = normaliseCanonicalRole(role);
  const prefix = ROLE_CCMS_PREFIX[canonical];
  if (prefix == null) throw new Error("Unknown employee role.");

  const used = new Set((usedIds || []).map(cleanCcmsId));
  const start = prefix === "0" ? 1 : Number(`${prefix}001`);
  const end = Number(`${prefix}999`);

  for (let numeric = start; numeric <= end; numeric += 1) {
    const candidate = String(numeric).padStart(4, "0");
    if (!used.has(candidate)) return candidate;
  }

  throw new Error(`No available CCMS IDs remain for ${canonical}.`);
}
