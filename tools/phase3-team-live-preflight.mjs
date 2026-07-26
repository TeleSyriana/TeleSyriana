import assert from 'node:assert/strict';
import {
  buildLiveTeamProjection,
  normalizeOperationalStatus,
  operationalTeamForActor,
  projectDayKey,
} from '../team-live-projection.js';

const employees = [
  { employeeUid:'emp_ceo', ccmsId:'0001', fullName:'CEO', roleKey:'ceo', projectIds:['*'], accountStatus:'active' },
  { employeeUid:'emp_acm', ccmsId:'1001', fullName:'ACM', roleKey:'acm', projectId:'ipro', accountStatus:'active' },
  { employeeUid:'emp_sup', ccmsId:'2001', fullName:'Supervisor', roleKey:'supervisor', projectId:'ipro', accountStatus:'active' },
  { employeeUid:'emp_hr', ccmsId:'3001', fullName:'HR', roleKey:'hr', projectId:'ipro', projectIds:['ipro'], accountStatus:'active' },
  { employeeUid:'emp_a1', ccmsId:'9001', fullName:'Agent 1', roleKey:'agent', projectId:'ipro', supervisorUid:'emp_sup', supervisorCcmsId:'2001', timezone:'Asia/Damascus', accountStatus:'active' },
  { employeeUid:'emp_a2', ccmsId:'9002', fullName:'Agent 2', roleKey:'agent', projectId:'ipro', supervisorUid:'emp_sup', supervisorCcmsId:'2001', timezone:'Asia/Damascus', accountStatus:'active' },
  { employeeUid:'emp_a3', ccmsId:'9003', fullName:'Agent 3', roleKey:'agent', projectId:'ipro', supervisorUid:'emp_sup', supervisorCcmsId:'2001', timezone:'Asia/Damascus', accountStatus:'active' },
  { employeeUid:'emp_other_sup', ccmsId:'2101', fullName:'Other Supervisor', roleKey:'supervisor', projectId:'other', accountStatus:'active' },
  { employeeUid:'emp_other_agent', ccmsId:'9101', fullName:'Other Agent', roleKey:'agent', projectId:'other', supervisorUid:'emp_other_sup', supervisorCcmsId:'2101', timezone:'Europe/London', accountStatus:'active' },
];

const acm = employees.find((row) => row.ccmsId === '1001');
const supervisor = employees.find((row) => row.ccmsId === '2001');

assert.equal(normalizeOperationalStatus('in_operation'), 'operating');
assert.equal(normalizeOperationalStatus('break'), 'break');
assert.equal(normalizeOperationalStatus('unknown'), 'unavailable');

assert.deepEqual(operationalTeamForActor(acm, employees, 'ipro').map((row) => row.ccmsId).sort(), ['9001','9002','9003']);
assert.deepEqual(operationalTeamForActor(supervisor, employees, 'ipro').map((row) => row.ccmsId).sort(), ['9001','9002','9003']);

// 21:30 UTC is already after midnight in Damascus during summer; UK management
// must still query the Syrian team's local workday.
assert.equal(projectDayKey('Asia/Damascus', new Date('2026-07-26T21:30:00Z')), '2026-07-27');

const now = new Date('2026-07-27T08:00:00Z');
const dayRows = [
  { userId:'9001', status:'in_operation', loginTime:Date.parse('2026-07-27T06:55:00Z'), updatedAt:Date.parse('2026-07-27T07:59:00Z') },
  { userId:'9002', status:'break', loginTime:Date.parse('2026-07-27T07:00:00Z'), updatedAt:Date.parse('2026-07-27T07:58:00Z') },
  { userId:'9101', status:'meeting', loginTime:Date.parse('2026-07-27T07:00:00Z'), updatedAt:Date.parse('2026-07-27T07:59:00Z') },
];

const projection = buildLiveTeamProjection(acm, { employees, dayRows, projectId:'ipro', timeZone:'Asia/Damascus', now });
assert.equal(projection.teamSize, 3);
assert.equal(projection.signedIn, 2);
assert.equal(projection.notSignedIn, 1);
assert.deepEqual(projection.status, { operating:1, break:1, meeting:0, handling:0, unavailable:1 });
assert.equal(projection.attendance.coverage, 0);
assert.equal(projection.attendance.late, null);
assert.equal(projection.attendance.absent, null);
assert.equal(projection.members.some((row) => row.ccmsId === '9101'), false, 'cross-project Agent leaked into iPro');

const explicitAttendance = buildLiveTeamProjection(supervisor, {
  employees,
  projectId:'ipro',
  timeZone:'Asia/Damascus',
  now,
  dayRows: [
    { userId:'9001', status:'in_operation', loginTime:Date.parse('2026-07-27T07:10:00Z'), updatedAt:Date.parse('2026-07-27T07:59:00Z'), attendanceStatus:'late' },
    { userId:'9002', status:'unavailable', loginTime:Date.parse('2026-07-27T06:55:00Z'), updatedAt:Date.parse('2026-07-27T07:59:00Z'), attendanceStatus:'present' },
    { userId:'9003', status:'unavailable', updatedAt:Date.parse('2026-07-27T07:59:00Z'), attendanceStatus:'absent', absent:true },
  ],
});
assert.equal(explicitAttendance.attendance.coverage, 3);
assert.equal(explicitAttendance.attendance.late, 1);
assert.equal(explicitAttendance.attendance.absent, 1);

const stale = buildLiveTeamProjection(supervisor, {
  employees,
  projectId:'ipro',
  timeZone:'Asia/Damascus',
  now,
  staleAfterMinutes:15,
  dayRows:[{ userId:'9001', status:'handling', loginTime:Date.parse('2026-07-27T06:55:00Z'), updatedAt:Date.parse('2026-07-27T07:30:00Z') }],
});
assert.equal(stale.members.find((row) => row.ccmsId === '9001').stale, true);

console.log(JSON.stringify({
  phase:'3-live-team-status-attendance',
  teamSize:projection.teamSize,
  signedIn:projection.signedIn,
  status:projection.status,
  explicitAttendance:explicitAttendance.attendance,
  damascusBoundaryDay:projectDayKey('Asia/Damascus', new Date('2026-07-26T21:30:00Z')),
  result:'PASS',
}, null, 2));
