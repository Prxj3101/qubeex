import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { r2KeyFromUrl, downloadFromR2 } from "../../services/storage.service";
import { z } from "zod";
import { loadPayrollSettings } from "../../services/payrollData.service";
import { StaffStatus, dayType, daysOfMonth, loadHolidays, monthAttendanceLop } from "../../services/staffAttendance.service";

// Self-service — scoped entirely from the JWT's userId via the linked Staff
// row. There is no :staffId param anywhere in this file, so a teacher can
// never address another staff member's payslips.
export const listMyPayslips = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const staff = await academicDb().staff.findFirst({ where: { userId, institutionId } });
    if (!staff) throw new NotFoundError("Staff profile not found");

    const payslips = await academicDb().payslip.findMany({
      where: { staffId: staff.id, institutionId, payrollRun: { status: "PUBLISHED" } },
      include: { payrollRun: { select: { month: true, publishedAt: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: payslips });
  } catch (err) {
    next(err);
  }
};

export const redirectToMyPayslipPdf = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;

    const staff = await academicDb().staff.findFirst({ where: { userId, institutionId } });
    if (!staff) throw new NotFoundError("Staff profile not found");

    const payslip = await academicDb().payslip.findFirst({
      where: { id, staffId: staff.id, institutionId, payrollRun: { status: "PUBLISHED" } },
    });
    if (!payslip || !payslip.pdfUrl) throw new NotFoundError("Payslip not found");

    const r2Key = r2KeyFromUrl(payslip.pdfUrl);
    if (!r2Key) throw new NotFoundError("Payslip not found");
    const buffer = await downloadFromR2(r2Key);
    res.setHeader("Content-Type", "application/pdf");
    res.send(buffer);
  } catch (err) {
    next(err);
  }
};

const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM");

// The teacher's OWN staff attendance for one month (read only) - so the LOP on a
// payslip can be explained day by day. Scoped from the JWT like the payslip routes.
// Schools that don't track staff attendance get { tracked: false } and the UI hides it.
export const getMyAttendance = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const month = MONTH.parse(req.query.month);

    const db = academicDb();
    const staff = await db.staff.findFirst({ where: { userId, institutionId }, select: { id: true, joinedAt: true, exitDate: true } });
    if (!staff) throw new NotFoundError("Staff profile not found");

    const settings = await loadPayrollSettings(institutionId);
    const anyRow = await db.staffAttendance.findFirst({ where: { institutionId }, select: { id: true } });
    if (!settings.attendance.lopEnabled && !anyRow) {
      res.json({ success: true, data: { tracked: false } });
      return;
    }

    const dates = daysOfMonth(month);
    const [rows, holidays, lop, payslip] = await Promise.all([
      db.staffAttendance.findMany({ where: { institutionId, staffId: staff.id, date: { gte: dates[0], lte: dates[dates.length - 1] } } }),
      loadHolidays(institutionId, dates[0], dates[dates.length - 1]),
      monthAttendanceLop(institutionId, month, [staff], settings.attendance),
      db.payslip.findFirst({
        where: { staffId: staff.id, institutionId, payrollRun: { month, status: "PUBLISHED" } },
        select: { lopDays: true, lopSource: true },
      }),
    ]);
    const holidaySet = new Set(holidays.keys());
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const a = settings.attendance;
    res.json({
      success: true,
      data: {
        tracked: true,
        month,
        joinedAt: staff.joinedAt,
        exitDate: staff.exitDate,
        days: dates.map((d) => {
          const r = byDate.get(d);
          return {
            date: d, type: dayType(d, a, holidaySet), holidayName: holidays.get(d) ?? null,
            record: r ? { status: r.status as StaffStatus, checkIn: r.checkIn, checkOut: r.checkOut, source: r.source } : null,
          };
        }),
        summary: lop.get(staff.id)?.summary ?? null,
        lopDays: lop.get(staff.id)?.lopDays ?? 0,
        // What the published payslip actually used (it can differ if the accountant typed LOP by hand).
        payslip: payslip ? { lopDays: payslip.lopDays, lopSource: payslip.lopSource } : null,
        rules: {
          lopEnabled: a.lopEnabled, officeStart: a.officeStart, graceMinutes: a.graceMinutes, halfDayMinutes: a.halfDayMinutes,
          lateRuleEnabled: a.lateRuleEnabled, lateRuleCount: a.lateRuleCount,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};
