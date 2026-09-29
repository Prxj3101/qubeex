// Staff attendance (Payroll -> Attendance): daily marking, monthly sheet and
// importing punches exported from a fingerprint / RFID attendance machine.
import { Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError } from "../../utils/errors";
import { loadPayrollSettings, loadLinkedProfiles } from "../../services/payrollData.service";
import {
  STAFF_STATUSES, StaffStatus, dayType, daysOfMonth, loadHolidays, monthAttendanceLop, rebuildFromPunches,
} from "../../services/staffAttendance.service";

const requireInstitution = (req: AuthRequest): string => {
  const { institutionId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  return institutionId;
};

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");
const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM");
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM");

// Active staff, in the payroll order, with photo + designation from the linked profile.
async function listStaff(institutionId: string) {
  const staff = await academicDb().staff.findMany({
    where: { institutionId, status: "ACTIVE" },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, designation: true, staffType: true, employeeCode: true, machineId: true, userId: true, joinedAt: true, exitDate: true },
  });
  const profiles = await loadLinkedProfiles(institutionId, staff.map((s) => s.userId).filter((x): x is string => !!x));
  return staff.map((s) => {
    const p = s.userId ? profiles.get(s.userId) : undefined;
    return { ...s, avatarUrl: p?.avatarUrl ?? null, designation: s.designation || p?.designation || null };
  });
}

export const getStaffAttendanceDay = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const date = DATE.parse(req.query.date);
    const [settings, staff, rows, holidays] = await Promise.all([
      loadPayrollSettings(institutionId),
      listStaff(institutionId),
      academicDb().staffAttendance.findMany({ where: { institutionId, date } }),
      loadHolidays(institutionId, date, date),
    ]);
    const byStaff = new Map(rows.map((r) => [r.staffId, r]));
    res.json({
      success: true,
      data: {
        date,
        dayType: dayType(date, settings.attendance, new Set(holidays.keys())),
        holidayName: holidays.get(date) ?? null,
        staff: staff.map((s) => {
          const r = byStaff.get(s.id);
          return {
            id: s.id, name: s.name, designation: s.designation, staffType: s.staffType, employeeCode: s.employeeCode, machineId: s.machineId, avatarUrl: s.avatarUrl, joinedAt: s.joinedAt, exitDate: s.exitDate,
            record: r ? { status: r.status, checkIn: r.checkIn, checkOut: r.checkOut, source: r.source, note: r.note } : null,
          };
        }),
      },
    });
  } catch (err) {
    next(err);
  }
};

const saveDaySchema = z.object({
  date: DATE,
  items: z.array(z.object({
    staffId: z.string(),
    status: z.enum(STAFF_STATUSES).nullable(), // null = clear the day
    checkIn: TIME.nullable().optional(),
    checkOut: TIME.nullable().optional(),
    note: z.string().trim().max(200).nullable().optional(),
  })).min(1).max(2000),
});

// Mark by hand. A manual mark always wins over machine data for that day.
export const saveStaffAttendanceDay = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const { date, items } = saveDaySchema.parse(req.body);
    const staff = await academicDb().staff.findMany({ where: { institutionId, id: { in: items.map((i) => i.staffId) } }, select: { id: true } });
    if (staff.length !== new Set(items.map((i) => i.staffId)).size) throw new BadRequestError("Some staff were not found");

    const db = academicDb();
    const ops = items.map((i) => i.status === null
      ? db.staffAttendance.deleteMany({ where: { staffId: i.staffId, date } })
      : db.staffAttendance.upsert({
        where: { staffId_date: { staffId: i.staffId, date } },
        create: { institutionId, staffId: i.staffId, date, status: i.status, checkIn: i.checkIn ?? null, checkOut: i.checkOut ?? null, note: i.note ?? null, source: "MANUAL", markedById: req.user!.userId },
        update: {
          status: i.status, source: "MANUAL", markedById: req.user!.userId,
          ...(i.checkIn !== undefined ? { checkIn: i.checkIn } : {}),
          ...(i.checkOut !== undefined ? { checkOut: i.checkOut } : {}),
          ...(i.note !== undefined ? { note: i.note } : {}),
        },
      }));
    await db.$transaction(ops);
    res.json({ success: true, data: { count: items.length } });
  } catch (err) {
    next(err);
  }
};

export const getStaffAttendanceMonth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const month = MONTH.parse(req.query.month);
    const dates = daysOfMonth(month);
    const [settings, staff, rows, holidays] = await Promise.all([
      loadPayrollSettings(institutionId),
      listStaff(institutionId),
      academicDb().staffAttendance.findMany({ where: { institutionId, date: { gte: dates[0], lte: dates[dates.length - 1] } } }),
      loadHolidays(institutionId, dates[0], dates[dates.length - 1]),
    ]);
    const holidaySet = new Set(holidays.keys());
    const lop = await monthAttendanceLop(institutionId, month, staff, settings.attendance);
    const byStaff = new Map<string, Record<string, { s: StaffStatus; in: string | null; out: string | null; src: string }>>();
    for (const r of rows) {
      const m = byStaff.get(r.staffId) ?? {};
      m[r.date] = { s: r.status as StaffStatus, in: r.checkIn, out: r.checkOut, src: r.source };
      byStaff.set(r.staffId, m);
    }
    res.json({
      success: true,
      data: {
        month,
        days: dates.map((d) => ({ date: d, type: dayType(d, settings.attendance, holidaySet), holidayName: holidays.get(d) ?? null })),
        staff: staff.map((s) => ({
          id: s.id, name: s.name, designation: s.designation, employeeCode: s.employeeCode, machineId: s.machineId, avatarUrl: s.avatarUrl,
          joinedAt: s.joinedAt, exitDate: s.exitDate,
          days: byStaff.get(s.id) ?? {},
          summary: lop.get(s.id)?.summary ?? null,
          lopDays: lop.get(s.id)?.lopDays ?? 0,
        })),
        rules: settings.attendance,
      },
    });
  } catch (err) {
    next(err);
  }
};

const importSchema = z.object({
  punches: z.array(z.object({
    machineId: z.string().trim().min(1).max(40),
    date: DATE,
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Time must be HH:MM or HH:MM:SS"),
  })).min(1).max(50000),
});

// Punches parsed in the browser from the machine's Excel / CSV export.
// Re-importing the same file adds nothing (duplicates are skipped).
export const importStaffPunches = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const { punches } = importSchema.parse(req.body);
    const rows = punches.map((p) => ({ institutionId, machineId: p.machineId, date: p.date, time: p.time.length === 5 ? `${p.time}:00` : p.time, source: "IMPORT" }));
    const created = await academicDb().staffPunch.createMany({ data: rows, skipDuplicates: true });

    const dates = rows.map((r) => r.date).sort();
    const from = dates[0], to = dates[dates.length - 1];
    const settings = await loadPayrollSettings(institutionId);
    const { updated } = await rebuildFromPunches(institutionId, from, to, settings.attendance);

    const staff = await academicDb().staff.findMany({ where: { institutionId, machineId: { not: null } }, select: { machineId: true } });
    const known = new Set(staff.map((s) => s.machineId));
    const ids = [...new Set(rows.map((r) => r.machineId))];
    res.json({
      success: true,
      data: {
        received: rows.length,
        added: created.count,
        from, to,
        matchedIds: ids.filter((id) => known.has(id)).length,
        unknownIds: ids.filter((id) => !known.has(id)),
        daysUpdated: updated,
      },
    });
  } catch (err) {
    next(err);
  }
};

// After machine IDs are filled in, rebuild a period from the punches already stored.
export const rebuildStaffAttendance = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const { month } = z.object({ month: MONTH }).parse(req.body);
    const dates = daysOfMonth(month);
    const settings = await loadPayrollSettings(institutionId);
    const { updated } = await rebuildFromPunches(institutionId, dates[0], dates[dates.length - 1], settings.attendance);
    res.json({ success: true, data: { daysUpdated: updated } });
  } catch (err) {
    next(err);
  }
};
