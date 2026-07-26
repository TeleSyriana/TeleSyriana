import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-phase4b-watchdog-'));

fs.writeFileSync(
  path.join(tmp, 'activity-telemetry-policy.mjs'),
  fs.readFileSync(path.join(root, 'activity-telemetry-policy.js'), 'utf8'),
);
fs.writeFileSync(
  path.join(tmp, 'watchdog-policy.cjs'),
  fs.readFileSync(path.join(root, 'functions-phase4b/watchdog-policy.js'), 'utf8'),
);

const telemetry = await import(pathToFileURL(path.join(tmp, 'activity-telemetry-policy.mjs')).href);
const require = createRequire(import.meta.url);
const watchdog = require(path.join(tmp, 'watchdog-policy.cjs'));

const FIFTEEN = 15 * 60 * 1000;
assert.equal(telemetry.ACTIVITY_WATCHDOG_MS, FIFTEEN);
assert.equal(watchdog.WATCHDOG_THRESHOLD_MS, FIFTEEN);

const activityAt = Date.parse('2026-07-27T07:00:00Z');
assert.equal(telemetry.watchdogDueMs(activityAt), activityAt + FIFTEEN);

assert.equal(telemetry.shouldPublishActivity({
  lastPublishedMs: 0,
  lastActivityMs: activityAt,
  nowMs: activityAt,
}), true);
assert.equal(telemetry.shouldPublishActivity({
  lastPublishedMs: activityAt,
  lastActivityMs: activityAt + 60_000,
  nowMs: activityAt + 60_000,
}), false);
assert.equal(telemetry.shouldPublishActivity({
  lastPublishedMs: activityAt,
  lastActivityMs: activityAt + 120_000,
  nowMs: activityAt + 120_000,
}), true);

const payload = telemetry.buildActivityTelemetry({
  userId: '9001',
  role: 'agent',
  projectId: 'ipro',
  timeZone: 'Asia/Damascus',
  lastActivityMs: activityAt,
});
assert.equal(payload.userId, '9001');
assert.equal(payload.watchdogDueMs, activityAt + FIFTEEN);

const dueNow = activityAt + FIFTEEN + 1;
let verdict = watchdog.evaluateWatchdog({
  activity: { ...payload, watchdogDueMs: activityAt + FIFTEEN },
  dayRow: { status: 'in_operation' },
  nowMs: dueNow,
});
assert.equal(verdict.shouldUnavailable, true);
assert.equal(verdict.clearDue, true);

verdict = watchdog.evaluateWatchdog({
  activity: { ...payload, watchdogDueMs: activityAt + FIFTEEN },
  dayRow: { status: 'handling' },
  nowMs: dueNow,
});
assert.equal(verdict.shouldUnavailable, true);

for (const safeStatus of ['break', 'meeting', 'unavailable']) {
  verdict = watchdog.evaluateWatchdog({
    activity: { ...payload, watchdogDueMs: activityAt + FIFTEEN },
    dayRow: { status: safeStatus },
    nowMs: dueNow,
  });
  assert.equal(verdict.shouldUnavailable, false, `${safeStatus} must not be auto-unavailable`);
  assert.equal(verdict.clearDue, true);
}

verdict = watchdog.evaluateWatchdog({
  activity: { ...payload, role:'supervisor', watchdogDueMs: activityAt + FIFTEEN },
  dayRow: { status:'in_operation' },
  nowMs: dueNow,
});
assert.equal(verdict.shouldUnavailable, false);
assert.equal(verdict.reason, 'not_agent');

verdict = watchdog.evaluateWatchdog({
  activity: { ...payload, watchdogDueMs: dueNow + 60_000, lastActivityMs: dueNow },
  dayRow: { status:'in_operation' },
  nowMs: dueNow,
});
assert.equal(verdict.due, false, 'fresh transaction state must win over stale query state');

verdict = watchdog.evaluateWatchdog({
  activity: { ...payload, watchdogDueMs: activityAt + FIFTEEN },
  dayRow: null,
  nowMs: dueNow,
});
assert.equal(verdict.shouldUnavailable, false);
assert.equal(verdict.reason, 'missing_day_row');

assert.equal(watchdog.dayKeyInTimeZone('Asia/Damascus', Date.parse('2026-07-26T21:30:00Z')), '2026-07-27');
assert.equal(watchdog.dayKeyInTimeZone('not/a-zone', Date.parse('2026-07-26T21:30:00Z')), '2026-07-27');

console.log(JSON.stringify({
  phase:'4b-server-inactivity-watchdog',
  thresholdMinutes:FIFTEEN / 60000,
  telemetryMaxIntervalMinutes:telemetry.ACTIVITY_PUBLISH_MAX_INTERVAL_MS / 60000,
  trailingPublishSeconds:telemetry.ACTIVITY_TRAILING_PUBLISH_MS / 1000,
  serverEligible:['in_operation','handling'],
  protectedStatuses:['break','meeting','unavailable'],
  result:'PASS',
}, null, 2));
