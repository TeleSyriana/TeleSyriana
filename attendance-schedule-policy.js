// attendance-schedule-policy.js — pure shift/attendance rules for Phase 4A
//
// Attendance is calculated only when an explicit schedule exists. Missing rows
// alone never make someone Late or Absent.

const DAY_INDEX = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });

function clean(value) {
  return String(value ?? "").trim();
}

function toMs(value) {
  if (!value) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseClock(value) {
  const match = clean(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function localParts(value, timeZone) {
  const ms = toMs(value);
  if (!ms) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      dateKey: `${map.year}-${map.month}-${map.day}`,
      weekday: DAY_INDEX[map.weekday],
      minutes: Number(map.hour) * 60 + Number(map.minute),
    };
  } catch {
    return null;
  }
}

export function normaliseShiftSchedule(schedule = {}) {
  const timeZone = clean(schedule.timeZone || schedule.timezone);
  const startMinutes = parseClock(schedule.start || schedule.startTime || schedule.shiftStart);
  const endMinutes = parseClock(schedule.end || schedule.endTime || schedule.shiftEnd);
  const workDays = Array.isArray(schedule.workDays)
    ? [...new Set(schedule.workDays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    : [];
  const graceMinutes = Math.max(0, Number(schedule.graceMinutes ?? schedule.lateGraceMinutes ?? 0) || 0);
  const absenceAfterMinutes = Math.max(graceMinutes, Number(schedule.absenceAfterMinutes ?? graceMinutes) || graceMinutes);

  if (!timeZone || startMinutes === null || !workDays.length) return null;
  return {
    timeZone,
    startMinutes,
    endMinutes,
    workDays,
    graceMinutes,
    absenceAfterMinutes,
  };
}

export function scheduleForEmployee(employee = {}, dayRow = {}) {
  return normaliseShiftSchedule(
    dayRow.shiftSchedule ||
    employee.shiftSchedule ||
    employee.schedule ||
    {}
  );
}

export function attendanceFromSchedule({
  schedule,
  loginTime,
  now = new Date(),
  explicitStatus = "",
  explicitLate,
  explicitAbsent,
} = {}) {
  const explicit = clean(explicitStatus).toLowerCase();
  if (explicit === "late") return { known: true, status: "late", late: true, absent: false, source: "explicit" };
  if (explicit === "absent") return { known: true, status: "absent", late: false, absent: true, source: "explicit" };
  if (["present", "recorded", "on_time", "ontime"].includes(explicit)) return { known: true, status: "present", late: false, absent: false, source: "explicit" };
  if (explicitAbsent === true) return { known: true, status: "absent", late: false, absent: true, source: "explicit" };
  if (explicitLate === true) return { known: true, status: "late", late: true, absent: false, source: "explicit" };

  const normalized = normaliseShiftSchedule(schedule || {});
  if (!normalized) return { known: false, status: "unknown", late: false, absent: false, source: "none" };

  const nowLocal = localParts(now, normalized.timeZone);
  if (!nowLocal) return { known: false, status: "unknown", late: false, absent: false, source: "none" };
  if (!normalized.workDays.includes(nowLocal.weekday)) {
    return { known: true, status: "off", late: false, absent: false, source: "schedule" };
  }

  const loginMs = toMs(loginTime);
  if (loginMs) {
    const loginLocal = localParts(loginMs, normalized.timeZone);
    if (!loginLocal || loginLocal.dateKey !== nowLocal.dateKey) {
      const absent = nowLocal.minutes >= normalized.startMinutes + normalized.absenceAfterMinutes;
      return absent
        ? { known: true, status: "absent", late: false, absent: true, source: "schedule" }
        : { known: true, status: "scheduled", late: false, absent: false, source: "schedule" };
    }
    const late = loginLocal.minutes > normalized.startMinutes + normalized.graceMinutes;
    return { known: true, status: late ? "late" : "present", late, absent: false, source: "schedule" };
  }

  const absent = nowLocal.minutes >= normalized.startMinutes + normalized.absenceAfterMinutes;
  return absent
    ? { known: true, status: "absent", late: false, absent: true, source: "schedule" }
    : { known: true, status: "scheduled", late: false, absent: false, source: "schedule" };
}
