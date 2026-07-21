// project-model.js — TeleSyriana Phase 1A pure project model

export const PROJECT_STATUSES = Object.freeze(["active", "disabled", "archived"]);
export const DEFAULT_PROJECT_ID = "ipro";

export const DEFAULT_PROJECT = Object.freeze({
  projectId: DEFAULT_PROJECT_ID,
  name: "iPro",
  accountStatus: "active",
  isDefault: true,
});

function clean(value) {
  return String(value ?? "").trim();
}

export function normaliseProjectId(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function normaliseProjectStatus(status) {
  const value = clean(status).toLowerCase();
  return PROJECT_STATUSES.includes(value) ? value : "active";
}

export function normaliseProject(input = {}) {
  const projectId = normaliseProjectId(input.projectId || input.id || input.slug || input.name);
  return {
    projectId,
    name: clean(input.name || projectId),
    accountStatus: normaliseProjectStatus(input.accountStatus || input.status),
    isDefault: input.isDefault === true || projectId === DEFAULT_PROJECT_ID,
  };
}

export function validateProject(input = {}) {
  const project = normaliseProject(input);
  if (!project.projectId) throw new Error("Project ID is required.");
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(project.projectId)) {
    throw new Error("Project ID must use 2–63 lowercase letters, numbers, hyphens or underscores.");
  }
  if (!project.name) throw new Error("Project name is required.");
  return project;
}

export function projectIsActive(project) {
  return normaliseProjectStatus(project?.accountStatus || project?.status) === "active";
}
