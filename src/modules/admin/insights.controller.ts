import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { BadRequestError } from "../../utils/errors";
import { redis } from "../../utils/redis";

// Attendance dates are stored using the marking browser's local (IST) calendar
// date, not UTC — en-CA formats as YYYY-MM-DD, which combined with the
// Asia/Kolkata timezone gives the correct "today" regardless of what
// timezone the server process itself runs in.
function todayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// ── GET /admin/insights/attendance — overall (session-cumulative) and current-month %, per standard → division ──
// Mirrors the per-division definitions used on the class Attendance tab
// (campus.attendance.controller.ts#getAttendanceSummary): "Overall" is the
// running average of each month's own % from the start of the academic
// session (June–May) through the most recent month with data; "Monthly" is
// the current calendar month's % on its own.
export const getAttendanceInsights = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const now = new Date();
    const startYear = now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1;
    const sessionStart = `${startYear}-06-01`;
    const sessionEnd = `${startYear + 1}-05-31`;
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const [standards, allRecords, holidays] = await Promise.all([
      prisma.standard.findMany({
        where: { institutionId },
        orderBy: { order: "asc" },
        select: {
          id: true,
          name: true,
          divisions: {
            orderBy: { name: "asc" },
            select: {
              id: true,
              name: true,
              students: { where: { status: "ACTIVE" }, select: { id: true } },
            },
          },
        },
      }),
      prisma.attendance.findMany({
        where: { institutionId, date: { gte: sessionStart, lte: sessionEnd } },
        select: { studentId: true, divisionId: true, date: true, status: true },
      }),
      prisma.schoolHoliday.findMany({
        where: { institutionId, date: { gte: sessionStart, lte: sessionEnd } },
        select: { date: true },
      }),
    ]);

    const holidayDates = new Set(holidays.map((h) => h.date));
    const byStudent = new Map<string, { date: string; status: string }[]>();
    for (const r of allRecords) {
      if (holidayDates.has(r.date)) continue;
      const arr = byStudent.get(r.studentId) ?? [];
      arr.push({ date: r.date, status: r.status });
      byStudent.set(r.studentId, arr);
    }

    function studentPcts(studentId: string): { overallPct: number | null; monthPct: number | null } {
      const recs = byStudent.get(studentId) ?? [];

      const monthRecs = recs.filter((r) => r.date.startsWith(currentMonthKey));
      const monthPct = monthRecs.length > 0
        ? Math.round((monthRecs.filter((r) => r.status === "P" || r.status === "L").length / monthRecs.length) * 100)
        : null;

      const byMonth = new Map<string, { p: number; a: number; l: number }>();
      for (const r of recs) {
        const mk = r.date.slice(0, 7);
        const cur = byMonth.get(mk) ?? { p: 0, a: 0, l: 0 };
        if (r.status === "P") cur.p++;
        else if (r.status === "A") cur.a++;
        else if (r.status === "L") cur.l++;
        byMonth.set(mk, cur);
      }
      const monthKeys = Array.from(byMonth.keys()).sort();
      let pctSum = 0;
      let pctCount = 0;
      let overallPct: number | null = null;
      for (const mk of monthKeys) {
        const counts = byMonth.get(mk)!;
        const total = counts.p + counts.a + counts.l;
        const pct = total > 0 ? Math.round(((counts.p + counts.l) / total) * 100) : null;
        if (pct !== null) { pctSum += pct; pctCount++; }
        overallPct = pctCount > 0 ? Math.round(pctSum / pctCount) : null;
      }
      return { overallPct, monthPct };
    }

    function avg(nums: (number | null)[]): number | null {
      const valid = nums.filter((n): n is number => n !== null);
      return valid.length > 0 ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : null;
    }

    const data = standards
      .filter((s) => s.divisions.length > 0)
      .map((s) => ({
        id: s.id,
        name: s.name,
        divisions: s.divisions.map((d) => {
          const pcts = d.students.map((st) => studentPcts(st.id));
          return {
            id: d.id,
            name: d.name,
            overallPct: avg(pcts.map((p) => p.overallPct)),
            monthPct: avg(pcts.map((p) => p.monthPct)),
            total: d.students.length,
          };
        }),
      }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/insights/fees — most recent due month's paid/pending, per standard → division ──
export const getFeeInsights = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const standards = await prisma.standard.findMany({
      where: { institutionId },
      orderBy: { order: "asc" },
      select: {
        id: true,
        name: true,
        divisions: {
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            _count: { select: { students: { where: { status: "ACTIVE" } } } },
            feeStructure: { select: { feeMonths: true } },
          },
        },
      },
    });

    const today = todayStr();
    type FeeMonth = { id: string; dueDate: string };

    // Resolve "current" fee month per division: latest due month that has
    // already reached its due date, falling back to the earliest upcoming one.
    const currentMonthIdByDivision = new Map<string, string>();
    for (const s of standards) {
      for (const d of s.divisions) {
        const months = (d.feeStructure?.feeMonths as FeeMonth[] | null) ?? [];
        if (months.length === 0) continue;
        const past = months.filter((m) => m.dueDate <= today).sort((a, b) => b.dueDate.localeCompare(a.dueDate));
        const chosen = past[0] ?? [...months].sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
        if (chosen) currentMonthIdByDivision.set(d.id, chosen.id);
      }
    }

    const feeMonthIds = Array.from(new Set(currentMonthIdByDivision.values()));
    const payments = feeMonthIds.length
      ? await prisma.studentFeePayment.findMany({
          where: { institutionId, feeMonthId: { in: feeMonthIds }, status: "PAID" },
          select: { studentId: true, feeMonthId: true, student: { select: { divisionId: true } } },
        })
      : [];

    const paidCountByDivision = new Map<string, number>();
    for (const p of payments) {
      if (!p.student.divisionId) continue;
      if (currentMonthIdByDivision.get(p.student.divisionId) !== p.feeMonthId) continue;
      paidCountByDivision.set(p.student.divisionId, (paidCountByDivision.get(p.student.divisionId) ?? 0) + 1);
    }

    const data = standards
      .filter((s) => s.divisions.some((d) => currentMonthIdByDivision.has(d.id)))
      .map((s) => ({
        id: s.id,
        name: s.name,
        divisions: s.divisions
          .filter((d) => currentMonthIdByDivision.has(d.id))
          .map((d) => {
            const total = d._count.students;
            const paid = paidCountByDivision.get(d.id) ?? 0;
            return { id: d.id, name: d.name, paid, pending: Math.max(0, total - paid), total };
          }),
      }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/insights/ai-usage — per-teacher share of the institution's AI token pool ──
export const getAiUsageInsights = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const teachers = await prisma.teacher.findMany({
      where: { institutionId },
      select: { id: true, user: { select: { name: true } } },
    });

    let usageByTeacher: Record<string, number> = {};
    if (redis && teachers.length) {
      const keys = teachers.map((t) => `ai:usage:teacher:${t.id}`);
      const values = await redis.mget(...keys);
      usageByTeacher = Object.fromEntries(
        teachers.map((t, i) => [t.id, parseInt(values[i] ?? "0", 10) || 0])
      );
    }

    const data = teachers
      .map((t) => ({ name: t.user.name ?? "Unknown", used: usageByTeacher[t.id] ?? 0 }))
      .filter((t) => t.used > 0)
      .sort((a, b) => b.used - a.used);

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
