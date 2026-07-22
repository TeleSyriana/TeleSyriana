// project-directory.js — TeleSyriana Phase 1A project storage foundation
//
// Not wired into production navigation yet. Phase 2 will expose this through the
// CEO Projects UI. Removal is represented by archive/disable so historical ticket,
// payroll and chat records remain attributable to their project.

import { db, fs } from "./firebase.js";
import {
  DEFAULT_PROJECT,
  DEFAULT_PROJECT_ID,
  normaliseProject,
  normaliseProjectStatus,
  projectIsActive,
  validateProject,
} from "./project-model.js";
import { normaliseCanonicalRole } from "./employee-model.js";

const { collection, doc, getDoc, getDocs, serverTimestamp, setDoc } = fs;

export const PROJECTS_COL = "projects";

function clean(value) {
  return String(value ?? "").trim();
}

function actorRole(actor = null) {
  return normaliseCanonicalRole(actor?.roleKey || actor?.role);
}

function assertCEO(actor = null) {
  if (!clean(actor?.employeeUid || actor?.uid || actor?.ccmsId || actor?.id) || actorRole(actor) !== "ceo") {
    throw new Error("CEO permission is required to manage projects.");
  }
}

function projectPayload(project, actor = null, { isCreate = false } = {}) {
  const row = validateProject(project);
  const payload = {
    projectId: row.projectId,
    name: row.name,
    accountStatus: row.accountStatus,
    isDefault: row.isDefault,
    updatedAt: serverTimestamp(),
    updatedByUid: clean(actor?.employeeUid || actor?.uid),
    updatedByCcmsId: clean(actor?.ccmsId || actor?.id),
    updatedByName: clean(actor?.fullName || actor?.name),
  };

  if (isCreate) {
    payload.createdAt = serverTimestamp();
    payload.createdByUid = clean(actor?.employeeUid || actor?.uid);
    payload.createdByCcmsId = clean(actor?.ccmsId || actor?.id);
    payload.createdByName = clean(actor?.fullName || actor?.name);
  }

  return payload;
}

export async function getProject(projectId, options = {}) {
  const id = String(projectId || "").trim().toLowerCase();
  if (!id) return null;

  try {
    const snap = await getDoc(doc(db, PROJECTS_COL, id));
    if (snap.exists()) return normaliseProject({ ...snap.data(), projectId: id });
  } catch (err) {
    console.warn("Project lookup failed.", err);
  }

  if (options.allowDefaultFallback !== false && id === DEFAULT_PROJECT_ID) {
    return { ...DEFAULT_PROJECT };
  }
  return null;
}

export async function listProjects(options = {}) {
  const includeDisabled = options.includeDisabled === true;
  const includeArchived = options.includeArchived === true;
  const rows = new Map([[DEFAULT_PROJECT_ID, { ...DEFAULT_PROJECT }]]);

  try {
    const snap = await getDocs(collection(db, PROJECTS_COL));
    snap.forEach((item) => {
      const row = normaliseProject({ ...item.data(), projectId: item.id });
      if (row.projectId) rows.set(row.projectId, row);
    });
  } catch (err) {
    console.warn("Project list failed; using iPro compatibility fallback.", err);
  }

  return Array.from(rows.values())
    .filter((row) => includeDisabled || row.accountStatus !== "disabled")
    .filter((row) => includeArchived || row.accountStatus !== "archived")
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveProject(input = {}, actor = null) {
  assertCEO(actor);
  const project = validateProject(input);
  const existing = await getProject(project.projectId, { allowDefaultFallback: false });

  await setDoc(
    doc(db, PROJECTS_COL, project.projectId),
    projectPayload(project, actor, { isCreate: !existing }),
    { merge: true }
  );

  return project;
}

export async function setProjectStatus(projectId, status, actor = null) {
  assertCEO(actor);
  const existing = await getProject(projectId, { allowDefaultFallback: true });
  if (!existing) throw new Error("Project not found.");

  const nextStatus = normaliseProjectStatus(status);
  if (existing.projectId === DEFAULT_PROJECT_ID && nextStatus === "archived") {
    throw new Error("The default iPro project cannot be archived during Phase 1A migration.");
  }

  await setDoc(doc(db, PROJECTS_COL, existing.projectId), {
    accountStatus: nextStatus,
    updatedAt: serverTimestamp(),
    updatedByUid: clean(actor?.employeeUid || actor?.uid),
    updatedByCcmsId: clean(actor?.ccmsId || actor?.id),
    updatedByName: clean(actor?.fullName || actor?.name),
  }, { merge: true });

  return { ...existing, accountStatus: nextStatus };
}

export async function ensureDefaultIProProject(actor = null) {
  // Explicit migration helper only. It is not called at app startup.
  const existing = await getProject(DEFAULT_PROJECT_ID, { allowDefaultFallback: false });
  if (existing) return existing;

  if (actor) assertCEO(actor);
  await setDoc(doc(db, PROJECTS_COL, DEFAULT_PROJECT_ID), projectPayload(DEFAULT_PROJECT, actor, { isCreate: true }), { merge: true });
  return { ...DEFAULT_PROJECT };
}

export { projectIsActive };
