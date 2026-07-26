import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telesyriana-phase4a-policy-'));
for (const name of ['inactivity-policy.js', 'attendance-schedule-policy.js']) {
  fs.writeFileSync(path.join(tmp, name.replace(/\.js$/, '.mjs')), fs.readFileSync(path.join(root, name), 'utf8'));
}

const inactivity = await import(pathToFileURL(path.join(tmp, 'inactivity-policy.mjs')).href);
const attendance = await import(pathToFileURL(path.join(tmp, 'attendance-schedule-policy.mjs')).href);

const fifteen = 15 * 60 * 1000;
assert.equal(inactivity.INACTIVITY_UNAVAILABLE_MS, fifteen);
assert.equal(inactivity.shouldAutoUnavailable({ status:'in_operation', lastActivityMs:1_000, nowMs:1_000 + fifteen }), true);
assert.equal(inactivity.shouldAutoUnavailable({ status:'handling', lastActivityMs:1_000, nowMs:1_000 + fifteen + 1 }), true);
assert.equal(inactivity.shouldAutoUnavailable({ status:'in_operation', lastActivityMs:1_000, nowMs:1_000 + fifteen - 1 }), false);
assert.equal(inactivity.shouldAutoUnavailable({ status:'break', lastActivityMs:1_000, nowMs:1_000 + 60 * 60 * 1000 }), false);
assert.equal(inactivity.shouldAutoUnavailable({ status:'meeting', lastActivityMs:1_000, nowMs:1_000 + 60 * 60 * 1000 }), false);
assert.equal(inactivity.shouldAutoUnavailable({ status:'unavailable', lastActivityMs:1_000, nowMs:1_000 + 60 * 60 * 1000 }), false);

const noSchedule = attendance.attendanceFromSchedule({ now:new Date('2026-07-27T08:30:00Z') });
assert.deepEqual(noSchedule, { known:false, status:'unknown', late:false, absent:false, source:'none' });

const fullTime = {
  timeZone:'Asia/Damascus',
  workDays:[1,2,3,4,5],
  start:'10:00',
  end:'18:00',
  graceMinutes:10,
  absenceAfterMinutes:15,
};
const partTime = {
  timeZone:'Asia/Damascus',
  workDays:[1,2,3,4,5],
  start:'14:00',
  end:'18:00',
  graceMinutes:10,
  absenceAfterMinutes:15,
};

// Monday 27 July 2026. Damascus is UTC+3 in July.
let result = attendance.attendanceFromSchedule({
  schedule:fullTime,
  loginTime:new Date('2026-07-27T07:05:00Z'), // 10:05 Damascus
  now:new Date('2026-07-27T08:00:00Z'),
});
assert.equal(result.status, 'present');
assert.equal(result.late, false);

result = attendance.attendanceFromSchedule({
  schedule:fullTime,
  loginTime:new Date('2026-07-27T07:20:00Z'), // 10:20 Damascus
  now:new Date('2026-07-27T08:00:00Z'),
});
assert.equal(result.status, 'late');
assert.equal(result.late, true);

result = attendance.attendanceFromSchedule({
  schedule:fullTime,
  now:new Date('2026-07-27T07:20:00Z'), // 10:20 Damascus, no login
});
assert.equal(result.status, 'absent');
assert.equal(result.absent, true);

result = attendance.attendanceFromSchedule({
  schedule:partTime,
  now:new Date('2026-07-27T08:00:00Z'), // 11:00 Damascus, before part-time shift
});
assert.equal(result.status, 'scheduled');
assert.equal(result.absent, false);

result = attendance.attendanceFromSchedule({
  schedule:fullTime,
  now:new Date('2026-07-25T08:00:00Z'), // Saturday
});
assert.equal(result.status, 'off');
assert.equal(result.absent, false);

result = attendance.attendanceFromSchedule({
  schedule:fullTime,
  now:new Date('2026-07-27T08:00:00Z'),
  explicitStatus:'present',
});
assert.equal(result.status, 'present');
assert.equal(result.source, 'explicit');

assert.equal(attendance.scheduleForEmployee({}, {}), null, 'No employee schedule must remain unknown');
assert.equal(attendance.scheduleForEmployee({ shiftSchedule:fullTime }, {})?.startMinutes, 600);

console.log(JSON.stringify({
  phase:'4a-inactivity-attendance-policy',
  inactivityMinutes: inactivity.INACTIVITY_UNAVAILABLE_MS / 60000,
  fullTimeStart:'10:00 Asia/Damascus',
  partTimeStart:'14:00 Asia/Damascus',
  result:'PASS',
}, null, 2));
