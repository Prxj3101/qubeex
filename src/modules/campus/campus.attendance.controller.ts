import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { resolveUsers } from "../../services/userLookup.service";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { generateSignedAvatarUrlsBatch } from "../../services/storage.service";
import { resolveRequestedAcademicYear } from "../../utils/academicYear";

function requireInstitution(req: AuthRequest) {
  const { institutionId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution");
  return institutionId;
}

async function assertDivisionInInstitution(divisionId: string, institutionId: string) {
  const division = await academicDb().division.findFirst({
    where: { id: divisionId, standard: { institutionId } },
    select: { id: true },
  });
  if (!division) throw new NotFoundError("Division not found");
}

// GET /admin/campus/divisions/:divisionId/students
export const getDivisionStudents = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    await assertDivisionInInstitution(divisionId, institutionId);

    const year = await resolveRequestedAcademicYear(
      req.query.academicYearId as string | undefined,
      institutionId,
      { role: req.user!.role, userId: req.user!.userId }
    );

    let students;
    if (year.isCurrent) {
      students = await academicDb().student.findMany({
        where: { divisionId, institutionId },
        orderBy: [{ rollNo: "asc" }, { joinedAt: "asc" }],
      });
    } else {
      const enrollments = await academicDb().studentEnrollment.findMany({
        where: { divisionId, academicYearId: year.id, institutionId },
        orderBy: [{ rollNo: "asc" }, { student: { joinedAt: "asc" } }],
        include: { student: true },
      });
      // Historical roster: status/division/standard/rollNo come from that year's
      // enrollment, not the live Student row (which reflects today's state).
      students = enrollments.map((e) => ({
        ...e.student,
        rollNo: e.rollNo ?? e.student.rollNo,
        status: e.status,
        divisionId: e.divisionId,
        standardId: e.standardId,
      }));
    }

    // User names live centrally (Student may be in a tenant DB under BYOD).
    const users = await resolveUsers(students.map(s => s.userId), { id: true, name: true, email: true, mustChangePassword: true });
    const signedMap = await generateSignedAvatarUrlsBatch(students.map(s => s.avatarUrl));
    const data = students.map(s => {
      const u = users.get(s.userId);
      return {
        ...s,
        user: { name: u?.name ?? null, email: u?.email ?? null, mustChangePassword: u?.mustChangePassword ?? false },
        avatarUrl: s.avatarUrl ? (signedMap[s.avatarUrl] ?? s.avatarUrl) : null,
      };
    });

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// GET /admin/campus/divisions/:divisionId/attendance/holidays
export const getAttendanceHolidays = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    await assertDivisionInInstitution(divisionId, institutionId);

    const holidays = await academicDb().schoolHoliday.findMany({
      where: { institutionId },
      select: { date: true, name: true },
      orderBy: { date: "asc" },
    });

    res.json({ success: true, data: holidays });
  } catch (err) {
    next(err);
  }
};

// GET /admin/campus/divisions/:divisionId/attendance/daily?date=YYYY-MM-DD
export const getDailyAttendance = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const date = req.query.date as string;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestError("date query param required (YYYY-MM-DD)");
    await assertDivisionInInstitution(divisionId, institutionId);

    const [records, dayNote] = await Promise.all([
      academicDb().attendance.findMany({
        where: { divisionId, institutionId, date },
        select: { studentId: true, status: true, remark: true },
      }),
      academicDb().attendanceDayNote.findUnique({
        where: { divisionId_date: { divisionId, date } },
        select: { note: true },
      }),
    ]);

    res.json({ success: true, data: { records, dateNote: dayNote?.note ?? null } });
  } catch (err) {
    next(err);
  }
};

// GET /admin/campus/divisions/:divisionId/attendance/monthly?month=YYYY-MM
export const getMonthlyAttendance = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const month = req.query.month as string;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) throw new BadRequestError("month query param required (YYYY-MM)");
    await assertDivisionInInstitution(divisionId, institutionId);

    const records = await academicDb().attendance.findMany({
      where: {
        divisionId,
        institutionId,
        date: { gte: `${month}-01`, lte: `${month}-31` },
      },
      select: { studentId: true, date: true, status: true, remark: true },
    });

    res.json({ success: true, data: { records } });
  } catch (err) {
    next(err);
  }
};

// GET /admin/campus/divisions/:divisionId/attendance/summary
export const getAttendanceSummary = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    await assertDivisionInInstitution(divisionId, institutionId);

    // Academic session runs June–May — the cumulative % must reset at the
    // start of each session and only ever accumulate within it, never across
    // sessions and never using out-of-range historical data.
    const now = new Date();
    const startYear = now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1;
    const sessionStart = `${startYear}-06-01`;
    const sessionEnd = `${startYear + 1}-05-31`;

    const [students, allRecords, holidays] = await Promise.all([
      academicDb().student.findMany({
        where: { divisionId, institutionId },
        orderBy: [{ rollNo: "asc" }, { joinedAt: "asc" }],
      }),
      academicDb().attendance.findMany({
        where: { divisionId, institutionId, date: { gte: sessionStart, lte: sessionEnd } },
        select: { studentId: true, date: true, status: true },
      }),
      academicDb().schoolHoliday.findMany({
        where: { institutionId, date: { gte: sessionStart, lte: sessionEnd } },
        select: { date: true },
      }),
    ]);

    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    // A date later declared a holiday must not count toward attendance %,
    // even if a record was marked before the holiday was declared — this
    // matches the sheet UI, which already excludes holiday cells from its
    // own on-screen totals.
    const holidayDates = new Set(holidays.map(h => h.date));
    const validRecords = allRecords.filter(r => !holidayDates.has(r.date));

    const byStudent: Record<string, { date: string; status: string }[]> = {};
    validRecords.forEach(r => {
      if (!byStudent[r.studentId]) byStudent[r.studentId] = [];
      byStudent[r.studentId].push(r);
    });

    const summaryUsers = await resolveUsers(students.map(s => s.userId), { id: true, name: true });
    const summaryStudents = students.map(st => {
      const recs = byStudent[st.id] ?? [];

      const monthRecs = recs.filter(r => r.date.startsWith(currentMonthKey));
      const totalMonth = monthRecs.length;
      const presentMonth = monthRecs.filter(r => r.status === "P" || r.status === "L").length;
      const currentMonthPct = totalMonth > 0 ? Math.round((presentMonth / totalMonth) * 100) : null;

      const byMonth: Record<string, { p: number; a: number; l: number }> = {};
      recs.forEach(r => {
        const mk = r.date.substring(0, 7);
        if (!byMonth[mk]) byMonth[mk] = { p: 0, a: 0, l: 0 };
        if (r.status === "P") byMonth[mk].p++;
        else if (r.status === "A") byMonth[mk].a++;
        else if (r.status === "L") byMonth[mk].l++;
      });

      // monthKey strings sort chronologically within a single June–May session
      // (e.g. "2026-06" < "2026-12" < "2027-01" < "2027-05"). The cumulative %
      // through a given month is the running average of each month's own %
      // from the start of the session through that month (not a weighted
      // total of raw record counts).
      let pctSum = 0;
      let pctCount = 0;
      const monthlyStats = Object.entries(byMonth)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([monthKey, counts]) => {
          const total = counts.p + counts.a + counts.l;
          const pct = total > 0 ? Math.round(((counts.p + counts.l) / total) * 100) : null;
          if (pct !== null) { pctSum += pct; pctCount++; }
          return {
            monthKey,
            p: counts.p,
            a: counts.a,
            l: counts.l,
            pct,
            cumulativePct: pctCount > 0 ? Math.round(pctSum / pctCount) : null,
          };
        });

      // "Overall" = cumulative through the most recent month with any data —
      // i.e. the running session-to-date total, not an all-time figure.
      const overallPct = monthlyStats.length > 0 ? monthlyStats[monthlyStats.length - 1].cumulativePct : null;

      return {
        studentId: st.id,
        name: summaryUsers.get(st.userId)?.name ?? "",
        rollNo: st.rollNo ?? "",
        overallPct,
        currentMonthPct,
        monthlyStats,
      };
    });

    const validOverall = summaryStudents.map(s => s.overallPct).filter((p): p is number => p !== null);
    const validMonth = summaryStudents.map(s => s.currentMonthPct).filter((p): p is number => p !== null);
    const allMonthKeys = new Set<string>();
    summaryStudents.forEach(s => s.monthlyStats.forEach(m => allMonthKeys.add(m.monthKey)));

    const classMonthlyStats = Array.from(allMonthKeys)
      .sort()
      .map(mk => {
        const avgs = summaryStudents
          .map(s => s.monthlyStats.find(m => m.monthKey === mk)?.pct)
          .filter((p): p is number => p !== null);
        const cumAvgs = summaryStudents
          .map(s => s.monthlyStats.find(m => m.monthKey === mk)?.cumulativePct)
          .filter((p): p is number => p !== null);
        return {
          monthKey: mk,
          avg: avgs.length > 0 ? Math.round(avgs.reduce((a, b) => a + b, 0) / avgs.length) : null,
          cumulativeAvg: cumAvgs.length > 0 ? Math.round(cumAvgs.reduce((a, b) => a + b, 0) / cumAvgs.length) : null,
        };
      });

    const classStats = {
      overallPct: validOverall.length > 0
        ? Math.round(validOverall.reduce((a, b) => a + b, 0) / validOverall.length)
        : null,
      currentMonthPct: validMonth.length > 0
        ? Math.round(validMonth.reduce((a, b) => a + b, 0) / validMonth.length)
        : null,
      monthlyStats: classMonthlyStats,
    };

    res.json({ success: true, data: { students: summaryStudents, classStats } });
  } catch (err) {
    next(err);
  }
};

// GET /admin/campus/divisions/:divisionId/attendance/student-records/:studentId?year=YYYY
export const getStudentAttendanceRecords = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const studentId = req.params.studentId as string;
    const yearStr = (req.query.year as string) ?? String(new Date().getFullYear());
    const startDateParam = req.query.startDate as string | undefined;
    const endDateParam = req.query.endDate as string | undefined;

    let dateFilter: { gte: string; lte: string };
    if (startDateParam && endDateParam) {
      dateFilter = { gte: startDateParam, lte: endDateParam };
    } else {
      if (!/^\d{4}$/.test(yearStr)) throw new BadRequestError("Invalid year");
      dateFilter = { gte: `${yearStr}-01-01`, lte: `${yearStr}-12-31` };
    }
    await assertDivisionInInstitution(divisionId, institutionId);

    const records = await academicDb().attendance.findMany({
      where: {
        divisionId,
        institutionId,
        studentId,
        date: dateFilter,
      },
      select: { date: true, status: true, remark: true },
      orderBy: { date: "asc" },
    });

    res.json({ success: true, data: { records } });
  } catch (err) {
    next(err);
  }
};
