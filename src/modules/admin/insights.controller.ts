import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { resolveUsers } from "../../services/userLookup.service";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { getCache, setCache } from "../../utils/cache";
import { getInstitutionUsersForMonth } from "../../services/userDirectory.service";
import {
  getInstitutionTeacherBreakdown,
  getTeacherUsageSummary,
  rangeToFromDate,
  bucketEvents,
  bucketGranularity,
  getInstitutionAiTokenLimit,
  getInstitutionPoolUsed,
  getInstitutionByFeatureBreakdown,
  currentMonthStartIST,
  istMonthKey,
  getInstitutionTodayTokensUsed,
} from "../../services/ai-usage.service";
import { prisma } from "../../utils/prisma";
import { computeInstitutionFeeStats, computeFeeHealthScore, computeFeeForecast, generateAiFeeForecast, getFeePeerBenchmark } from "../../services/feeInsights.service";
import { generateAiAttendanceSummary } from "../../services/attendanceInsights.service";
import { askSchoolAssistant, type AssistantMessage } from "../../services/schoolAssistant.service";
import { getChatHistory, appendChatMessages, clearChatHistory } from "../../services/aiChatHistory.service";

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

    const cacheKey = `insights:users:v7:${institutionId}:${year}-${month}`;
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
    const { institutionId, userId, role } = req.user!;
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
              students: { where: { status: "ACTIVE" }, select: { id: true, userId: true, avatarUrl: true } },
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

    const standardsData = standards
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

    // ── Absence streak alerts ─────────────────────────────────────────────────
    // Flags a student the moment they've been marked "A" for 3 or more of
    // their most recent attendance-taking days in a row — walking backward
    // from their latest dated record rather than the calendar, since
    // Sundays/holidays never have rows to begin with. A single "P"/"L"
    // anywhere in that walk breaks the streak, by design: this is meant to
    // catch a student who is *currently* missing school, not one who missed
    // a handful of days spread across the month.
    function currentAbsenceStreak(studentId: string): number {
      const recs = (byStudent.get(studentId) ?? []).slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      let streak = 0;
      for (const r of recs) {
        if (r.status === "A") streak++;
        else break;
      }
      return streak;
    }

    const STREAK_ALERT_THRESHOLD = 3;
    const streakCandidates: { studentId: string; standardId: string; divisionId: string; divisionName: string; streakLength: number }[] = [];
    for (const s of standardsData) {
      for (const d of s.divisions) {
        const division = standards.find((std) => std.id === s.id)?.divisions.find((dv) => dv.id === d.id);
        if (!division) continue;
        for (const st of division.students) {
          const streakLength = currentAbsenceStreak(st.id);
          if (streakLength >= STREAK_ALERT_THRESHOLD) {
            streakCandidates.push({ studentId: st.id, standardId: s.id, divisionId: d.id, divisionName: `${s.name} - ${d.name}`, streakLength });
          }
        }
      }
    }
    streakCandidates.sort((a, b) => b.streakLength - a.streakLength);
    const topStreaks = streakCandidates.slice(0, 10);
    const streakUserIds = standards.flatMap((s) => s.divisions.flatMap((d) => d.students)).filter((st) => topStreaks.some((t) => t.studentId === st.id));
    const userMap = await resolveUsers(streakUserIds.map((st) => st.userId), { id: true, name: true });
    const streaks = topStreaks.map((t) => {
      const student = streakUserIds.find((st) => st.id === t.studentId);
      const user = student ? userMap.get(student.userId) : undefined;
      return {
        studentId: t.studentId,
        name: user?.name ?? "Unknown",
        avatarUrl: student?.avatarUrl ?? null,
        standardId: t.standardId,
        divisionId: t.divisionId,
        divisionName: t.divisionName,
        streakLength: t.streakLength,
      };
    });

    // ── AI summary ─────────────────────────────────────────────────────────────
    // A real LLM call reading the numbers above — throttled to once per
    // institution per 12-hour window inside generateAiAttendanceSummary, so
    // an attendance save (which busts this 5-minute cache) never re-triggers
    // the model on every mark.
    const divisionsWithMonthPct = standardsData.flatMap((s) => s.divisions.map((d) => ({ name: `${s.name} - ${d.name}`, pct: d.monthPct })))
      .filter((d): d is { name: string; pct: number } => d.pct !== null);
    const worstDivisions = divisionsWithMonthPct.slice().sort((a, b) => a.pct - b.pct).slice(0, 3);
    const overallRate = avg(standardsData.flatMap((s) => s.divisions.map((d) => d.overallPct))) ?? 0;
    const monthlyRate = avg(standardsData.flatMap((s) => s.divisions.map((d) => d.monthPct))) ?? 0;
    const aiSummary = await generateAiAttendanceSummary(
      { overallRate, monthlyRate, worstDivisions, streakAlertCount: streaks.length, dayPatternInsight: null },
      { institutionId, userId, userRole: role }
    ).catch(() => null);

    const data = {
      standards: standardsData,
      streaks,
      aiSummary,
      isAiGenerated: !!aiSummary,
    };

    await setCache(cacheKey, data, INSIGHTS_CACHE_TTL_SECONDS);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/insights/fees — current-month and previous-months paid/pending, per standard → division ──
// "Monthly" = the most recent due month's paid/pending split (one entry per
// student). "Overall" = a per-student classification across every *previous*
// due month (this session, excluding the current month): a student counts as
// paid only if they've cleared every one of those previous months, otherwise
// they count as pending. This used to sum raw paid payment-rows across past
// months instead (so a class of 5 students could show "13 paid" once more
// than one month was in the window) — switched to per-student status so the
// paid+pending total always equals the division's student count, matching
// the "Monthly" split and the Overall/Monthly convention used for attendance.
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
            students: { where: { status: "ACTIVE" }, select: { id: true } },
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

    // Every past-due month per division EXCLUDING the current one (for
    // "overall"/previous-months), and the "current" month (for "monthly") —
    // matched by calendar month name (e.g. "August" while today is in
    // August) rather than due-date, since a month's due date (e.g. the 10th)
    // can still be ahead even though it's already that month and some
    // students have already paid. Falls back to the closest due date if the
    // schedule has no entry for the current calendar month. The current
    // month id is resolved first so it can be excluded from "previous".
    const previousMonthsByDivision = new Map<string, string[]>();
    const currentMonthIdByDivision = new Map<string, string>();
    for (const s of standards) {
      for (const d of s.divisions) {
        const months = (d.feeStructure?.feeMonths as FeeMonth[] | null) ?? [];
        if (months.length === 0) continue;
        const past = months.filter((m) => dueDateMs(m.dueDate) <= todayMs).sort((a, b) => dueDateMs(a.dueDate) - dueDateMs(b.dueDate));

        const thisMonth = months.find((m) => m.month === currentCalendarMonth);
        let currentId: string | undefined;
        if (thisMonth) {
          currentId = thisMonth.id;
        } else if (past.length > 0) {
          currentId = past[past.length - 1].id;
        } else {
          const earliest = [...months].sort((a, b) => dueDateMs(a.dueDate) - dueDateMs(b.dueDate))[0];
          currentId = earliest?.id;
        }
        if (currentId) currentMonthIdByDivision.set(d.id, currentId);

        const previous = past.filter((m) => m.id !== currentId);
        if (previous.length > 0) previousMonthsByDivision.set(d.id, previous.map((m) => m.id));
      }
    }

    // Must include every division's "current" month id too, not just
    // previous ones — a division with no month past due yet still has a
    // "current" (the earliest upcoming month), and students can be marked
    // paid ahead of the due date, so that month's payments still need to be
    // fetched.
    const allFeeMonthIds = Array.from(new Set([
      ...Array.from(previousMonthsByDivision.values()).flat(),
      ...Array.from(currentMonthIdByDivision.values()),
    ]));
    const payments = allFeeMonthIds.length
      ? await academicDb().studentFeePayment.findMany({
          where: { institutionId, feeMonthId: { in: allFeeMonthIds }, status: "PAID" },
          select: { studentId: true, feeMonthId: true, student: { select: { divisionId: true } } },
        })
      : [];

    const monthlyPaidByDivision = new Map<string, number>();
    // studentId → set of previous-month feeMonthIds they've paid — used to
    // classify each student as fully-paid-for-previous-months or not, rather
    // than summing raw paid rows (see comment on the endpoint above).
    const previousMonthsPaidByStudent = new Map<string, Set<string>>();
    for (const p of payments) {
      const divisionId = p.student.divisionId;
      if (!divisionId) continue;
      if (currentMonthIdByDivision.get(divisionId) === p.feeMonthId) {
        monthlyPaidByDivision.set(divisionId, (monthlyPaidByDivision.get(divisionId) ?? 0) + 1);
      }
      if (previousMonthsByDivision.get(divisionId)?.includes(p.feeMonthId)) {
        const set = previousMonthsPaidByStudent.get(p.studentId) ?? new Set<string>();
        set.add(p.feeMonthId);
        previousMonthsPaidByStudent.set(p.studentId, set);
      }
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
            const monthPaid = monthlyPaidByDivision.get(d.id) ?? 0;
            const previousMonthIds = previousMonthsByDivision.get(d.id) ?? [];

            let overallPaid: number | null = null;
            let overallPending: number | null = null;
            if (previousMonthIds.length > 0) {
              overallPaid = 0;
              for (const stu of d.students) {
                const paidSet = previousMonthsPaidByStudent.get(stu.id);
                const clearedAllPrevious = previousMonthIds.every((mid) => paidSet?.has(mid));
                if (clearedAllPrevious) overallPaid++;
              }
              overallPending = Math.max(0, total - overallPaid);
            }

            return {
              id: d.id,
              name: d.name,
              monthPaid,
              monthPending: Math.max(0, total - monthPaid),
              overallPaid,
              overallPending,
              total,
            };
          }),
      }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/insights/fees/ai — AI Fee Health Score, forecast graph, peer benchmark ──
export const getFeeAiInsights = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId, role } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const cacheKey = `insights:fee-ai:${institutionId}`;
    const cached = await getCache<unknown>(cacheKey);
    if (cached) {
      res.json({ success: true, data: cached });
      return;
    }

    const stats = await computeInstitutionFeeStats(academicDb(), institutionId);
    const { score: healthScore, label: healthLabel } = computeFeeHealthScore(stats);
    // Ask an actual LLM to read the trend and predict the next month, the
    // same way the Blackboard AI features call out to OpenAI/Groq — this is
    // a real model call, not a fixed formula. If it's unavailable (no API
    // key), the institution's token budget is used up, or the call fails for
    // any reason, fall back to the plain average-delta extrapolation so the
    // card still shows *something* rather than breaking.
    const aiForecast = await generateAiFeeForecast(stats.historical, {
      institutionId,
      userId,
      userRole: role,
    }).catch(() => null);
    const forecast = aiForecast
      ? [...stats.historical, { month: aiForecast.month, rate: Math.round(((aiForecast.low + aiForecast.high) / 2) * 10) / 10, projected: true }]
      : computeFeeForecast(stats.historical);
    // Peer benchmark loops every institution on the platform on a cache miss
    // (once a day, see feeInsights.service.ts) — never let a slow/failed
    // benchmark computation break the rest of this card.
    const peerBenchmark = await getFeePeerBenchmark(institutionId, stats).catch(() => null);

    const data = {
      healthScore,
      healthLabel,
      monthlyRate: stats.monthlyTotal > 0 ? Math.round((stats.monthlyPaid / stats.monthlyTotal) * 1000) / 10 : 0,
      overallRate: stats.overallTotal > 0 ? Math.round((stats.overallPaid / stats.overallTotal) * 1000) / 10 : 0,
      forecast,
      forecastRange: aiForecast ? { low: aiForecast.low, high: aiForecast.high } : null,
      forecastInsight: aiForecast?.insight ?? null,
      isAiGenerated: !!aiForecast,
      peerBenchmark,
    };

    await setCache(cacheKey, data, INSIGHTS_CACHE_TTL_SECONDS);
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

    // Current calendar month only — same boundary as the Redis pool counter
    // (institutionUsageRedisKey), so "Per teacher" / "Usage by Feature" here
    // always describe the same pool the top-of-card "X / limit tokens" stat
    // is counting down. This used to scan all-time, which kept showing last
    // month's (or older) numbers even after the pool had visibly reset.
    // Cache key includes the month so a cached response from August can't
    // leak into a September page load.
    const monthKey = istMonthKey(new Date());
    // v5: added todayTokensUsed — bumped so a stale v4 cache entry (without
    // it) doesn't leak through and show a missing/stale daily figure.
    const cacheKey = `insights:ai-usage:v5:${institutionId}:${monthKey}`;
    const cached = await getCache<{ data: unknown; institutionByFeature: unknown; todayTokensUsed: number }>(cacheKey);
    if (cached) {
      res.json({ success: true, ...cached });
      return;
    }

    const teachers = await academicDb().teacher.findMany({
      where: { institutionId },
      select: { id: true, userId: true, avatarUrl: true },
    });
    const teacherUsers = await resolveUsers(teachers.map((t) => t.userId), { id: true, name: true });

    const from = currentMonthStartIST();
    const to = new Date();
    const breakdown = await getInstitutionTeacherBreakdown(institutionId, from, to);
    const byTeacherId = new Map(breakdown.map((b) => [b.teacherId, b]));
    // Covers admin-triggered features too (e.g. FEE_FORECAST), which have no
    // teacherId and would otherwise never show up in "Usage by Feature".
    const institutionByFeature = await getInstitutionByFeatureBreakdown(institutionId, from, to);
    const todayTokensUsed = await getInstitutionTodayTokensUsed(institutionId);

    const data = teachers
      .map((t) => {
        const summary = byTeacherId.get(t.id);
        return {
          teacherId: t.id,
          name: teacherUsers.get(t.userId)?.name ?? "Unknown",
          avatarUrl: t.avatarUrl ?? null,
          used: summary?.totalTokens ?? 0, // kept for backward compat with the existing frontend field name
          totalTokens: summary?.totalTokens ?? 0,
          totalRequests: summary?.totalRequests ?? 0,
          successRequests: summary?.successRequests ?? 0,
          failedRequests: summary?.failedRequests ?? 0,
          byFeature: summary?.byFeature ?? [],
          isOverSoftLimit: summary?.isOverSoftLimit ?? false,
        };
      })
      // Every teacher is listed, including ones with zero usage this month —
      // the admin page shows all of them with a 0% bar rather than hiding
      // anyone who simply hasn't used AI yet this month. Sort puts active
      // teachers first, then zero-usage teachers alphabetically so the list
      // doesn't jump around as usage changes.
      .sort((a, b) => b.used - a.used || a.name.localeCompare(b.name));

    const responseBody = { data, institutionByFeature, todayTokensUsed };
    await setCache(cacheKey, responseBody, INSIGHTS_CACHE_TTL_SECONDS);
    res.json({ success: true, ...responseBody });
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/teachers/:id/ai-usage — single-teacher usage detail: pool share, feature breakdown, trend ──
export const getTeacherAiUsage = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const teacherId = req.params.id as string;

    // academicDb() (not the raw managed client) so this lookup resolves against
    // a BYOD institution's own database, matching updateTeacherAiSoftLimit.
    const teacher = await academicDb().teacher.findFirst({ where: { id: teacherId, institutionId } });
    if (!teacher) throw new NotFoundError("Teacher not found");

    // Same "current pool since last reset" boundary as the teacher's own
    // self-service widget and the admin analytics card — always the current
    // IST calendar month, not a rolling 30-day window (which kept showing
    // last month's usage days into the new month even after the pool reset).
    // `range` is kept only for the trend chart's bucketing granularity.
    const range = (req.query.range as string) ?? "1M";
    const from = currentMonthStartIST();
    const to = new Date();

    const [summary, institutionLimit, institutionPoolUsed] = await Promise.all([
      getTeacherUsageSummary(institutionId, teacherId, from, to),
      getInstitutionAiTokenLimit(institutionId),
      // Self-healing: reconciles against the AiUsageEvent log so a Redis
      // counter that fell behind can't leave this stat permanently understated.
      getInstitutionPoolUsed(institutionId),
    ]);

    const events = await prisma.aiUsageEvent.findMany({
      where: { institutionId, teacherId, createdAt: { gte: from } },
      select: { createdAt: true, totalTokens: true },
    });
    const trend = bucketEvents(events, bucketGranularity(range), from, to);

    res.json({
      success: true,
      data: {
        teacherId,
        totalRequests: summary.totalRequests,
        successRequests: summary.successRequests,
        failedRequests: summary.failedRequests,
        totalTokens: summary.totalTokens,
        institutionPoolLimit: institutionLimit,
        institutionPoolUsed,
        // 2-decimal precision (not whole-percent rounding): a single teacher's
        // share of a multi-million-token institution pool is often well under
        // 1% (e.g. 900 / 2,000,000 = 0.045%) — rounding to an integer would
        // collapse any realistic usage down to a misleading 0%.
        poolSharePct: institutionLimit > 0 ? Math.round((summary.totalTokens / institutionLimit) * 10000) / 100 : 0,
        byFeature: summary.byFeature,
        trend,
        // softLimitTokens is the *effective* limit (override, else the computed
        // even-split default) and drives isOverSoftLimit. softLimitOverride is
        // the admin's explicit setting, null when unset — the UI must use this
        // one to decide whether a limit is configured at all.
        softLimitTokens: summary.softLimitTokens,
        softLimitOverride: summary.softLimitOverride,
        isOverSoftLimit: summary.isOverSoftLimit,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/insights/parent-engagement — disengaged families ────────────
// Flags families who haven't opened Parent Mode recently (see
// ParentModeEvent, logged from the student app whenever a parent switches
// Parent Mode on). "Disengaged" here just means recency-based for now —
// students with no open in DISENGAGED_THRESHOLD_DAYS days, or who have never
// opened it at all (those sort first, ahead of merely-stale ones). Capped to
// the 10 longest-disengaged so this reads as an actionable shortlist, not a
// dump of the whole roster.
const DISENGAGED_THRESHOLD_DAYS = 15;

export const getParentEngagementInsights = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const cacheKey = `insights:parent-engagement:${institutionId}`;
    const cached = await getCache<unknown>(cacheKey);
    if (cached) {
      res.json({ success: true, data: cached });
      return;
    }

    const students = await academicDb().student.findMany({
      where: { institutionId, status: "ACTIVE" },
      select: {
        id: true,
        studentId: true,
        userId: true,
        avatarUrl: true,
        standard: { select: { id: true, name: true } },
        division: { select: { id: true, name: true } },
      },
    });

    if (students.length === 0) {
      const data = { disengaged: [] as unknown[] };
      await setCache(cacheKey, data, INSIGHTS_CACHE_TTL_SECONDS);
      res.json({ success: true, data });
      return;
    }

    // Most recent Parent Mode open per student, if any — students with no
    // row here have simply never opened it.
    const events = await academicDb().parentModeEvent.groupBy({
      by: ["studentId"],
      where: { institutionId },
      _max: { openedAt: true },
    });
    const lastOpenByStudent = new Map(events.map((e) => [e.studentId, e._max.openedAt]));

    const now = Date.now();
    const candidates = students
      // Only students actually placed in a class — an unplaced student isn't
      // something an admin can act on from this card.
      .filter((s) => s.standard && s.division)
      .map((s) => {
        const lastOpen = lastOpenByStudent.get(s.id) ?? null;
        const daysSince = lastOpen ? Math.floor((now - lastOpen.getTime()) / (1000 * 60 * 60 * 24)) : null;
        return { student: s, daysSince };
      })
      .filter((c) => c.daysSince === null || c.daysSince >= DISENGAGED_THRESHOLD_DAYS)
      .sort((a, b) => {
        // Never-opened families first, then longest-since-last-open.
        if (a.daysSince === null && b.daysSince === null) return 0;
        if (a.daysSince === null) return -1;
        if (b.daysSince === null) return 1;
        return b.daysSince - a.daysSince;
      });
      // Deliberately NOT capped here (unlike the absence-streak alert list) —
      // the admin needs to be able to search this for any specific student,
      // not just the worst offenders, so the frontend gets the full list and
      // caps how many render by default itself.

    const userMap = await resolveUsers(candidates.map((c) => c.student.userId), { id: true, name: true });

    const disengaged = candidates.map((c) => {
      const user = userMap.get(c.student.userId);
      return {
        studentId: c.student.id,
        studentCode: c.student.studentId, // human-readable ID (e.g. SFHS-01T26-0007), for search
        name: user?.name ?? "Unknown",
        avatarUrl: c.student.avatarUrl ?? null,
        standardId: c.student.standard!.id,
        divisionId: c.student.division!.id,
        divisionName: `${c.student.standard!.name} - ${c.student.division!.name}`,
        daysSinceLastOpen: c.daysSince, // null = never opened
      };
    });

    const data = { disengaged };
    await setCache(cacheKey, data, INSIGHTS_CACHE_TTL_SECONDS);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// ── POST /admin/insights/assistant/ask — AI School PA chat ─────────────────
// The frontend still sends the full running conversation each request (same
// convention as Blackboard's aiChat) so the model gets its context — but the
// backend now also persists the new user message and the reply to
// AiChatMessage, keyed to userId, so the same conversation shows up no
// matter which device the admin logs in from next. Only the LAST message in
// the array is persisted here (it's the new one); everything before it was
// already saved on a prior turn. Every question can trigger up to 2 real
// model calls (see schoolAssistant.service.ts) — both get logged as
// SCHOOL_ASSISTANT AiUsageEvents, so "Usage by Feature" reflects the true cost.
export const askAssistant = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const rawMessages = req.body?.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0 || rawMessages.length > 20) {
      throw new BadRequestError("messages must be a non-empty array of at most 20 items");
    }
    const messages: AssistantMessage[] = rawMessages.map((m) => {
      if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) {
        throw new BadRequestError("Each message needs a role of 'user'/'assistant' and non-empty content");
      }
      return { role: m.role, content: m.content.trim().slice(0, 2000) };
    });

    const newUserMessage = messages[messages.length - 1];
    const result = await askSchoolAssistant(messages, { institutionId, userId, userRole: "ADMIN" });

    const toSave: Array<{ role: "user" | "assistant"; content: string }> = [newUserMessage];
    if (result.reply) toSave.push({ role: "assistant", content: result.reply });
    await appendChatMessages(userId, institutionId, toSave).catch(() => { /* history is best-effort — never fail the chat over it */ });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/insights/assistant/history — Jarvis chat history ────────────
export const getAssistantHistory = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.user!;
    const history = await getChatHistory(userId);
    res.json({ success: true, data: { messages: history } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /admin/insights/assistant/history — clear Jarvis chat history ───
export const clearAssistantHistory = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.user!;
    await clearChatHistory(userId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};
