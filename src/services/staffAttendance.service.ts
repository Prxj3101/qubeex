// Staff attendance: turning machine punches into a day's status, knowing which
// days are working days, and working out LOP days for payroll.
//
// Dates are "YYYY-MM-DD" strings and times "HH:MM" / "HH:MM:SS" (school local
// time, as printed by the attendance machine) - no timezone maths anywhere.
import { academicDb } from "../utils/academicContext";
import type { AttendanceConfig } from "./payrollData.service";

export const STAFF_STATUSES = ["PRESENT", "LATE", "HALF_DAY", "ABSENT", "PAID_LEAVE", "UNPAID_LEAVE"] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];
export type DayType = "WORKING" | "WEEKLY_OFF" | "HOLIDAY";

export interface AttendanceSummary {
  workingDays: number;
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  paidLeave: number;
  unpaidLeave: number;
  unmarked: number; // working days with nothing marked - counted as present
}

// ── small pure helpers ────────────────────────────────────────────────────────

export const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};
const hhmm = (t: string) => t.slice(0, 5);

export function daysOfMonth(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Working day, weekly off (e.g. Sunday / 2nd & 4th Saturday) or school holiday. */
export function dayType(date: string, cfg: Pick<AttendanceConfig, "weeklyOffDays" | "offSaturdays">, holidays: Set<string>): DayType {
  if (holidays.has(date)) return "HOLIDAY";
  const d = new Date(`${date}T00:00:00Z`);
  const wd = d.getUTCDay();
  if (cfg.weeklyOffDays.includes(wd)) return "WEEKLY_OFF";
  if (wd === 6 && cfg.offSaturdays.length) {
    const nth = Math.floor((d.getUTCDate() - 1) / 7) + 1; // 1st..5th Saturday of the month
    if (cfg.offSaturdays.includes(nth)) return "WEEKLY_OFF";
  }
  return "WORKING";
}

/**
 * One person's punches for one day -> status.
 * First punch = check-in, last punch = check-out (a single punch has no check-out).
 * Late: check-in after office start + grace. Half day: worked less than halfDayMinutes.
 */
export function statusFromPunches(times: string[], cfg: Pick<AttendanceConfig, "officeStart" | "graceMinutes" | "halfDayMinutes">): { status: StaffStatus; checkIn: string | null; checkOut: string | null } {
  const sorted = [...new Set(times.map(hhmm))].sort();
  if (!sorted.length) return { status: "ABSENT", checkIn: null, checkOut: null };
  const checkIn = sorted[0];
  const checkOut = sorted.length > 1 ? sorted[sorted.length - 1] : null;
  if (checkOut && toMinutes(checkOut) - toMinutes(checkIn) < cfg.halfDayMinutes) return { status: "HALF_DAY", checkIn, checkOut };
  const late = toMinutes(checkIn) > toMinutes(cfg.officeStart) + cfg.graceMinutes;
  return { status: late ? "LATE" : "PRESENT", checkIn, checkOut };
}

/** LOP days from a month's attendance: absent + unpaid leave + half days x 0.5 (+ late rule). */
export function lopFromSummary(sum: AttendanceSummary, cfg: Pick<AttendanceConfig, "lateRuleEnabled" | "lateRuleCount">): number {
  let lop = sum.absent + sum.unpaidLeave + sum.halfDay * 0.5;
  if (cfg.lateRuleEnabled && cfg.lateRuleCount > 0) lop += Math.floor(sum.late / cfg.lateRuleCount) * 0.5;
  return lop;
}

export function summarise(
  dates: string[],
  statusByDate: Map<string, StaffStatus>,
  isWorking: (date: string) => boolean,
): AttendanceSummary {
  const sum: AttendanceSummary = { workingDays: 0, present: 0, late: 0, halfDay: 0, absent: 0, paidLeave: 0, unpaidLeave: 0, unmarked: 0 };
  for (const date of dates) {
    if (!isWorking(date)) continue;
    sum.workingDays++;
    const st = statusByDate.get(date);
    if (!st) { sum.unmarked++; continue; }
    if (st === "PRESENT") sum.present++;
    else if (st === "LATE") sum.late++;
    else if (st === "HALF_DAY") sum.halfDay++;
    else if (st === "ABSENT") sum.absent++;
    else if (st === "PAID_LEAVE") sum.paidLeave++;
    else if (st === "UNPAID_LEAVE") sum.unpaidLeave++;
  }
  return sum;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

export async function loadHolidays(institutionId: string, from: string, to: string): Promise<Map<string, string>> {
  const rows = await academicDb().schoolHoliday.findMany({ where: { institutionId, date: { gte: from, lte: to } }, select: { date: true, name: true } });
  return new Map(rows.map((r) => [r.date, r.name]));
}

const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * LOP days + summary per staff member for a payroll month, from staff attendance.
 * Only working days while the person was employed count (joining / exit dates).
 */
export async function monthAttendanceLop(
  institutionId: string,
  month: string,
  staff: { id: string; joinedAt: Date | null; exitDate: Date | null }[],
  cfg: AttendanceConfig,
): Promise<Map<string, { lopDays: number; summary: AttendanceSummary }>> {
  const dates = daysOfMonth(month);
  const from = dates[0], to = dates[dates.length - 1];
  const [holidays, rows] = await Promise.all([
    loadHolidays(institutionId, from, to),
    academicDb().staffAttendance.findMany({
      where: { institutionId, staffId: { in: staff.map((s) => s.id) }, date: { gte: from, lte: to } },
      select: { staffId: true, date: true, status: true },
    }),
  ]);
  const holidaySet = new Set(holidays.keys());
  const byStaff = new Map<string, Map<string, StaffStatus>>();
  for (const r of rows) {
    const m = byStaff.get(r.staffId) ?? new Map<string, StaffStatus>();
    m.set(r.date, r.status as StaffStatus);
    byStaff.set(r.staffId, m);
  }
  const out = new Map<string, { lopDays: number; summary: AttendanceSummary }>();
  for (const s of staff) {
    const joined = dateOnly(s.joinedAt), exit = dateOnly(s.exitDate);
    const summary = summarise(dates, byStaff.get(s.id) ?? new Map(), (d) =>
      dayType(d, cfg, holidaySet) === "WORKING" && (!joined || d >= joined) && (!exit || d <= exit));
    out.set(s.id, { lopDays: lopFromSummary(summary, cfg), summary });
  }
  return out;
}

/**
 * Rebuild staff attendance from stored punches for [from, to].
 * - Staff with a machine ID and punches on a day -> PRESENT / LATE / HALF_DAY (+ in/out times).
 * - Staff with a machine ID and no punch on a working day -> ABSENT.
 * - Days already marked by hand (MANUAL) are never touched.
 * Only the days the machine data actually covers (first to last punch date, never
 * after today) are processed - a month with punches up to the 29th must not turn
 * the 30th (not exported yet, or still in the future) into "absent" for everyone.
 */
export async function rebuildFromPunches(institutionId: string, from: string, to: string, cfg: AttendanceConfig): Promise<{ updated: number }> {
  const db = academicDb();
  const punches = await db.staffPunch.findMany({ where: { institutionId, date: { gte: from, lte: to } }, select: { machineId: true, date: true, time: true } });
  const today = new Date().toISOString().slice(0, 10);
  const punchDates = punches.map((p) => p.date).sort();
  // Machine-made rows outside the covered days carry no punches (so they can only be
  // "absent because nothing was punched") - clear them; hand-marked days stay.
  const cover = punchDates.length ? { from: punchDates[0], to: [punchDates[punchDates.length - 1], today].sort()[0] } : null;
  await db.staffAttendance.deleteMany({
    where: {
      institutionId, source: { not: "MANUAL" }, date: { gte: from, lte: to },
      ...(cover ? { OR: [{ date: { lt: cover.from } }, { date: { gt: cover.to } }] } : {}),
    },
  });
  if (!cover) return { updated: 0 };
  from = cover.from; to = cover.to;

  const [staff, existing, holidays] = await Promise.all([
    db.staff.findMany({ where: { institutionId, status: "ACTIVE", machineId: { not: null } }, select: { id: true, machineId: true, joinedAt: true, exitDate: true } }),
    db.staffAttendance.findMany({ where: { institutionId, date: { gte: from, lte: to } }, select: { staffId: true, date: true, source: true } }),
    loadHolidays(institutionId, from, to),
  ]);
  const holidaySet = new Set(holidays.keys());
  const manual = new Set(existing.filter((e) => e.source === "MANUAL").map((e) => `${e.staffId}|${e.date}`));
  const punchMap = new Map<string, string[]>(); // machineId|date -> times
  for (const p of punches) {
    const k = `${p.machineId}|${p.date}`;
    const list = punchMap.get(k) ?? [];
    list.push(p.time);
    punchMap.set(k, list);
  }

  const writes: ReturnType<typeof db.staffAttendance.upsert>[] = [];
  for (const s of staff) {
    const joined = dateOnly(s.joinedAt), exit = dateOnly(s.exitDate);
    for (const date of datesBetween(from, to)) {
      if (manual.has(`${s.id}|${date}`)) continue;
      if ((joined && date < joined) || (exit && date > exit)) continue;
      const times = punchMap.get(`${s.machineId}|${date}`) ?? [];
      if (!times.length && dayType(date, cfg, holidaySet) !== "WORKING") continue; // no punch on a day off: nothing to record
      const r = statusFromPunches(times, cfg);
      writes.push(db.staffAttendance.upsert({
        where: { staffId_date: { staffId: s.id, date } },
        create: { institutionId, staffId: s.id, date, status: r.status, checkIn: r.checkIn, checkOut: r.checkOut, source: "IMPORT" },
        update: { status: r.status, checkIn: r.checkIn, checkOut: r.checkOut, source: "IMPORT" },
      }));
    }
  }
  for (let i = 0; i < writes.length; i += 200) await db.$transaction(writes.slice(i, i + 200));
  return { updated: writes.length };
}
