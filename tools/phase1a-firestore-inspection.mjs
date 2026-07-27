import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const outputPath = path.join(root, 'phase1a-firestore-inspection.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-phase1a-inspection-'));

function copyAsModule(sourcePath, targetName, replacements = []) {
  let source = fs.readFileSync(path.join(root, sourcePath), 'utf8');
  for (const [from, to] of replacements) source = source.split(from).join(to);
  const target = path.join(tmp, targetName);
  fs.writeFileSync(target, source);
  return target;
}

const modelPath = copyAsModule('employee-model.js', 'employee-model.mjs');
const projectModelPath = copyAsModule('project-model.js', 'project-model.mjs');
const collectionsPath = copyAsModule('phase1a-collections.js', 'phase1a-collections.mjs');
const seedPath = copyAsModule('employee-identity-seed.js', 'employee-identity-seed.mjs', [
  ['./employee-model.js', './employee-model.mjs'],
]);
const planPath = copyAsModule('phase1a-migration-plan.js', 'phase1a-migration-plan.mjs', [
  ['./employee-identity-seed.js', './employee-identity-seed.mjs'],
  ['./project-model.js', './project-model.mjs'],
  ['./phase1a-collections.js', './phase1a-collections.mjs'],
]);

void modelPath;
void projectModelPath;
void collectionsPath;
void seedPath;

const { buildPhase1AMigrationPlan } = await import(pathToFileURL(planPath).href);
const plan = buildPhase1AMigrationPlan();

const firebaseSource = fs.readFileSync(path.join(root, 'firebase.js'), 'utf8');
const apiKey = firebaseSource.match(/apiKey:\s*["']([^"']+)["']/)?.[1] || '';
const projectId = firebaseSource.match(/projectId:\s*["']([^"']+)["']/)?.[1] || '';

if (!apiKey || !projectId) {
  throw new Error('Could not read Firebase apiKey/projectId from firebase.js');
}

function stringField(doc, key) {
  return String(doc?.fields?.[key]?.stringValue || '');
}

function safeErrorDetails(body) {
  const error = body?.error;
  if (!error || typeof error !== 'object') return null;

  const details = Array.isArray(error.details)
    ? error.details.map((detail) => {
        if (!detail || typeof detail !== 'object') return detail;
        const safe = {};
        for (const key of ['@type', 'reason', 'domain', 'metadata', 'violations']) {
          if (Object.prototype.hasOwnProperty.call(detail, key)) safe[key] = detail[key];
        }
        return safe;
      })
    : [];

  return {
    code: Number(error.code) || null,
    status: String(error.status || ''),
    message: String(error.message || ''),
    details,
  };
}

function diagnosticHeaders(response) {
  const headers = {};
  for (const name of ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

const rows = [];
const conflicts = [];
let quotaExhausted = false;
let permissionDenied = false;
let unexpectedError = false;
let stoppedEarlyReason = '';
let readCount = 0;

const planned = [
  ...plan.collections.identities.map((row) => ({ ...row, kind: 'identity' })),
  ...plan.collections.ccmsIndexes.map((row) => ({ ...row, kind: 'ccms_index' })),
  ...plan.collections.projects.map((row) => ({ ...row, kind: 'project' })),
];

for (const item of planned) {
  readCount += 1;
  const collection = encodeURIComponent(item.collection);
  const documentId = encodeURIComponent(item.documentId);
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${collection}/${documentId}?key=${encodeURIComponent(apiKey)}`;

  let response;
  let body = null;

  try {
    response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } });
    try { body = await response.json(); } catch { body = null; }
  } catch (error) {
    unexpectedError = true;
    rows.push({
      kind: item.kind,
      collection: item.collection,
      documentId: item.documentId,
      status: 'network_error',
      message: String(error?.message || error),
    });
    continue;
  }

  if (response.status === 429) quotaExhausted = true;
  if (response.status === 401 || response.status === 403) permissionDenied = true;
  if (![200, 404, 401, 403, 429].includes(response.status)) unexpectedError = true;

  const row = {
    kind: item.kind,
    collection: item.collection,
    documentId: item.documentId,
    httpStatus: response.status,
    status: response.status === 200
      ? 'exists'
      : response.status === 404
        ? 'missing'
        : response.status === 429
          ? 'quota_exhausted'
          : response.status === 401 || response.status === 403
            ? 'permission_denied'
            : 'unexpected',
  };

  if (response.status >= 400) {
    row.error = safeErrorDetails(body);
    const headers = diagnosticHeaders(response);
    if (Object.keys(headers).length) row.responseHeaders = headers;
  }

  if (response.status === 200 && item.kind === 'identity') {
    const actualCcmsId = stringField(body, 'ccmsId');
    row.actualCcmsId = actualCcmsId;
    row.expectedCcmsId = item.ccmsId;
    if (actualCcmsId && actualCcmsId !== item.ccmsId) {
      conflicts.push({
        type: 'identity_ccms_mismatch',
        employeeUid: item.employeeUid,
        expectedCcmsId: item.ccmsId,
        actualCcmsId,
      });
    }
  }

  if (response.status === 200 && item.kind === 'ccms_index') {
    const actualEmployeeUid = stringField(body, 'employeeUid');
    row.actualEmployeeUid = actualEmployeeUid;
    row.expectedEmployeeUid = item.employeeUid;
    if (actualEmployeeUid && actualEmployeeUid !== item.employeeUid) {
      conflicts.push({
        type: 'ccms_index_conflict',
        ccmsId: item.ccmsId,
        expectedEmployeeUid: item.employeeUid,
        actualEmployeeUid,
      });
    }
  }

  rows.push(row);

  // Quota exhaustion is already conclusive for this inspection. Stop immediately
  // so a single bounded diagnostic does not add 14 more useless requests.
  if (response.status === 429) {
    stoppedEarlyReason = 'quota_exhausted';
    break;
  }
}

const summary = {
  mode: 'read_only_firestore_inspection',
  writesPerformed: false,
  projectId,
  plannedDocumentCount: plan.plannedDocumentCount,
  actualReadAttempts: readCount,
  maximumReads: 15,
  stoppedEarlyReason,
  existingDocuments: rows.filter((row) => row.status === 'exists').length,
  missingDocuments: rows.filter((row) => row.status === 'missing').length,
  quotaExhausted,
  permissionDenied,
  unexpectedError,
  conflicts,
  safeToApply: !quotaExhausted && !permissionDenied && !unexpectedError && conflicts.length === 0 && readCount === plan.plannedDocumentCount,
  rows,
};

fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

if (conflicts.length || permissionDenied || unexpectedError) process.exit(3);
if (quotaExhausted) process.exit(2);
process.exit(0);
