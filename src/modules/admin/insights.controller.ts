import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { resolveUsers } from "../../services/userLookup.service";
import { BadRequestError } from "../../utils/errors";
import { redis } from "../../utils/redis";
import { getCache, setCache } from "../../utils/cache";
import { getInstitutionUsersForMonth } from "../../services/userDirectory.service";

// Both endpoints below scan full-institution history on every request (all
// attendance rows for the academic year; all status/audit events ever, with
// no lower date bound) and get hit on every Insights page view/navigation —
// a meaningful, uncached contributor to Supabase egress. Dashboard data
// doesn't need to be second-fresh, so a short TTL cache cuts repeat DB reads
// without users noticing any staleness in practice.
const INSIGHTS_CACHE_TTL_SECONDS = 300;

// ── GET /admin/insights/users?year=YYYY&month=MM — billable users for a given month ──
// Defaults to the current month. "month" is 1-12. Status reflects whether
// the user was active on at least one day of that month (see
// userDirectory.service.ts for the exact reconstruction rule).
export const getUsersInsights = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const now = new Date();
    const year = req.query.year ? parseInt(req.query.year as string, 10) : now.getFullYear();
    const month = req.query.month ? parseInt(req.query.month as string, 10) : now.getMonth() + 1;
    if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
      throw new BadRequestError("Invalid year/month");
    }

    const cacheKey = `insights:users:v3:${institutionId}:${year}-${month}`;
    const cached = await getCache<unknown>(cacheKey);
    if (cached) {
      res.json({ success: true, data: cached });
      return;
    }

    const data = await getInstitutionUsersForMonth(institutionId, year, month);
    await setCache(cacheKey, data, INSIGHTS_CACHE_TTL_SECONDS);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

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
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const cacheKey = `insights:attendance:${institutionId}:${currentMonthKey}`;
    const cached = await getCache<unknown>(cacheKey);
    if (cached) {
      res.json({ success: true, data: cached });
      return;
    }

    const startYear = now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1;
    const sessionStart = `${startYear}-06-01`;
    const sessionEnd = `${startYear + 1}-05-31`;

    const [standards, allRecords, holidays] = await Promise.all([
      academicDb().standard.findMany({
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
      academicDb().attendance.findMany({
        where: { institutionId, date: { gte: sessionStart, lte: sessionEnd } },
        select: { studentId: true, divisionId: true, date: true, status: true },
      }),
      academicDb().schoolHoliday.findMany({
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

    await setCache(cacheKey, data, INSIGHTS_CACHE_TTL_SECONDS);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/insights/fees — overall (all past-due months) and current-month paid/pending, per standard → division ──
// "Monthly" = the most recent due month's paid/pending split. "Overall" =
// cumulative paid/pending across every fee month whose due date has already
// passed this session, mirroring the Overall/Monthly split used for attendance.
export const getFeeInsights = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const standards = await academicDb().standard.findMany({
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

    const todayMs = Date.now();
    const currentCalendarMonth = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Kolkata", month: "long" });
    type FeeMonth = { id: string; month: string; dueDate: string };

    // dueDate is stored as a free-text string like "10 Aug 26" or "10 July 26"
    // (see fees.tsx), not an ISO date — it must be parsed into a real Date
    // before comparing, never compared as a string (lexicographic order bears
    // no relation to chronological order for this format).
    function dueDateMs(dueDate: string): number {
      const t = new Date(dueDate).getTime();
      return Number.isNaN(t) ? Infinity : t;
    }

    // Every past-due month per division (for "overall"), and the "current"
    // one for "monthly" — matched by calendar month name (e.g. "August"
    // while today is in August) rather than due-date, since a month's due
    // date (e.g. the 10th) can still be ahead even though it's already that
    // month and some students have already paid. Falls back to the closest
    // due date if the schedule has no entry for the current calendar month.
    const pastMonthsByDivision = new Map<string, string[]>();
    const currentMonthIdByDivision = new Map<string, string>();
    for (const s of standards) {
      for (const d of s.divisions) {
        const months = (d.feeStructure?.feeMonths as FeeMonth[] | null) ?? [];
        if (months.length === 0) continue;
        const past = months.filter((m) => dueDateMs(m.dueDate) <= todayMs).sort((a, b) => dueDateMs(a.dueDate) - dueDateMs(b.dueDate));
        if (past.length > 0) pastMonthsByDivision.set(d.id, past.map((m) => m.id));

        const thisMonth = months.find((m) => m.month === currentCalendarMonth);
        if (thisMonth) {
          currentMonthIdByDivision.set(d.id, thisMonth.id);
        } else if (past.length > 0) {
          currentMonthIdByDivision.set(d.id, past[past.length - 1].id);
        } else {
          const earliest = [...months].sort((a, b) => dueDateMs(a.dueDate) - dueDateMs(b.dueDate))[0];
          if (earliest) currentMonthIdByDivision.set(d.id, earliest.id);
        }
      }
    }

    // Must include every division's "current" month id too, not just past-due
    // ones — a division with no month past due yet still has a "current"
    // (the earliest upcoming month), and students can be marked paid ahead
    // of the due date, so that month's payments still need to be fetched.
    const allFeeMonthIds = Array.from(new Set([
      ...Array.from(pastMonthsByDivision.values()).flat(),
      ...Array.from(currentMonthIdByDivision.values()),
    ]));
    const payments = allFeeMonthIds.length
      ? await academicDb().studentFeePayment.findMany({
          where: { institutionId, feeMonthId: { in: allFeeMonthIds }, status: "PAID" },
          select: { studentId: true, feeMonthId: true, student: { select: { divisionId: true } } },
        })
      : [];

    const paidByDivision = new Map<string, { monthly: number; overallMonthIds: Set<string> }>();
    for (const p of payments) {
      const divisionId = p.student.divisionId;
      if (!divisionId) continue;
      const entry = paidByDivision.get(divisionId) ?? { monthly: 0, overallMonthIds: new Set<string>() };
      if (currentMonthIdByDivision.get(divisionId) === p.feeMonthId) entry.monthly++;
      if (pastMonthsByDivision.get(divisionId)?.includes(p.feeMonthId)) entry.overallMonthIds.add(`${p.studentId}:${p.feeMonthId}`);
      paidByDivision.set(divisionId, entry);
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
            const paidEntry = paidByDivision.get(d.id);
            const monthPaid = paidEntry?.monthly ?? 0;
            const pastMonthCount = pastMonthsByDivision.get(d.id)?.length ?? 0;
            const overallTotal = total * pastMonthCount;
            const overallPaid = paidEntry?.overallMonthIds.size ?? 0;
            return {
              id: d.id,
              name: d.name,
              monthPaid,
              monthPending: Math.max(0, total - monthPaid),
              overallPaid: pastMonthCount > 0 ? overallPaid : null,
              overallPending: pastMonthCount > 0 ? Math.max(0, overallTotal - overallPaid) : null,
              total,
            };
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

    const teachers = await academicDb().teacher.findMany({
      where: { institutionId },
      select: { id: true, userId: true },
    });
    const teacherUsers = await resolveUsers(teachers.map((t) => t.userId), { id: true, name: true });

    let usageByTeacher: Record<string, number> = {};
    if (redis && teachers.length) {
      const keys = teachers.map((t) => `ai:usage:teacher:${t.id}`);
      // Per-teacher AI usage is a nice-to-have panel — a Redis timeout should
      // render it empty, not 500 the whole analytics dashboard.
      const values = await redis.mget(...keys).catch((err) => {
        console.warn("[insights] AI-usage read failed, omitting panel:", err?.message ?? err);
        return keys.map(() => null);
      });
      usageByTeacher = Object.fromEntries(
        teachers.map((t, i) => [t.id, parseInt(values[i] ?? "0", 10) || 0])
      );
    }

    const data = teachers
      .map((t) => ({ name: teacherUsers.get(t.userId)?.name ?? "Unknown", used: usageByTeacher[t.id] ?? 0 }))
      .filter((t) => t.used > 0)
      .sort((a, b) => b.used - a.used);

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
