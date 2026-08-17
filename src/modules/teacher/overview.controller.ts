// src/modules/teacher/overview.controller.ts
import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { academicDb } from "../../utils/academicContext";
import { resolveUsers } from "../../services/userLookup.service";
import { redis } from "../../utils/redis";
import {
  getTeacherUsageSummary,
  getInstitutionAiTokenLimit,
  rangeToFromDate,
  bucketEvents,
  bucketGranularity,
} from "../../services/ai-usage.service";

function calcPct(present: number, absent: number, late: number): number | null {
  const total = present + absent + late;
  return total > 0 ? Math.round(((present + late) / total) * 100) : null;
}

export async function getOverview(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution associated with this account" });
      return;
    }

    const teacher = await academicDb().teacher.findFirst({
      where: { userId, institutionId },
    });
    if (!teacher) {
      res.status(404).json({ success: false, error: "Teacher profile not found" });
      return;
    }
    const teacherPrefix = teacher.prefix;
    // Teacher.name (central User) + institution name (central) are stitched in —
    // Teacher may live in a tenant DB under BYOD with no User/Institution table.
    const [teacherUserMap, institutionRow] = await Promise.all([
      resolveUsers([teacher.userId], { id: true, name: true }),
      prisma.institution.findUnique({ where: { id: institutionId }, select: { name: true } }),
    ]);
    const teacherName = teacherUserMap.get(teacher.userId)?.name ?? "";
    const institutionName = institutionRow?.name ?? "";

    const [assignmentRows, testsConducted, classTeacherDivision, auditLogRows] = await Promise.all([
      academicDb().divisionAssignment.findMany({
        where: { teacherId: teacher.id, institutionId },
        select: { divisionId: true, subjectId: true },
      }),
      academicDb().taskTest.count({
        where: { teacherId: teacher.id, institutionId, status: { in: ["ACTIVE", "COMPLETED"] } },
      }),
      academicDb().division.findFirst({
        where: { institutionId, classTeacherId: teacher.id },
        select: { id: true, name: true, standard: { select: { name: true } } },
      }),
      prisma.auditLog.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: { id: true, action: true, category: true, severity: true, details: true, ip: true, createdAt: true },
      }),
    ]);

    const classesAssigned = new Set(assignmentRows.map((a) => a.divisionId)).size;
    const subjectsTeaching = new Set(
      assignmentRows.filter((a) => a.subjectId).map((a) => a.subjectId)
    ).size;

    let avgAttendancePct: number | null = null;
    let attendanceTrend: { month: string; attendance: number; students: number }[] = [];
    let shortAttendance: { name: string; rollNo: string; pct: number; avatarUrl: string | null }[] = [];

    if (classTeacherDivision) {
      const divisionId = classTeacherDivision.id;

      const [allRecords, students] = await Promise.all([
        academicDb().attendance.findMany({
          where: { divisionId, institutionId },
          select: { studentId: true, date: true, status: true },
        }),
        academicDb().student.findMany({
          where: { divisionId, institutionId },
          select: { id: true, rollNo: true, userId: true, avatarUrl: true },
        }),
      ]);

      // ── Class-wide average (straight ratio across all records) ──
      let tP = 0, tA = 0, tL = 0;
      allRecords.forEach((r) => {
        if (r.status === "P") tP++;
        else if (r.status === "A") tA++;
        else if (r.status === "L") tL++;
      });
      avgAttendancePct = calcPct(tP, tA, tL);

      // ── 12-month academic-year trend (Jun 1 -> May 31) ──
      const now = new Date();
      const curMonth = now.getMonth();
      const curYear = now.getFullYear();
      const startYear = curMonth >= 5 ? curYear : curYear - 1;

      attendanceTrend = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(startYear, 5 + i, 1); // Jun = index 5
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const recs = allRecords.filter((r) => r.date.startsWith(monthKey));
        let p = 0, a = 0, l = 0;
        const studentIds = new Set<string>();
        recs.forEach((r) => {
          studentIds.add(r.studentId);
          if (r.status === "P") p++;
          else if (r.status === "A") a++;
          else if (r.status === "L") l++;
        });
        const pct = calcPct(p, a, l);
        return {
          month: d.toLocaleString("en-US", { month: "short" }),
          attendance: pct ?? 0,
          students: studentIds.size,
        };
      });

      // ── Per-student overall pct, filtered < 75% ──
      const byStudent: Record<string, { p: number; a: number; l: number }> = {};
      allRecords.forEach((r) => {
        if (!byStudent[r.studentId]) byStudent[r.studentId] = { p: 0, a: 0, l: 0 };
        if (r.status === "P") byStudent[r.studentId].p++;
        else if (r.status === "A") byStudent[r.studentId].a++;
        else if (r.status === "L") byStudent[r.studentId].l++;
      });

      const studentUsers = await resolveUsers(students.map((s) => s.userId), { id: true, name: true });
      shortAttendance = students
        .map((s) => {
          const c = byStudent[s.id] ?? { p: 0, a: 0, l: 0 };
          const pct = calcPct(c.p, c.a, c.l);
          return { name: studentUsers.get(s.userId)?.name ?? "Unknown", rollNo: s.rollNo ?? "", pct, avatarUrl: s.avatarUrl ?? null };
        })
        .filter((s): s is { name: string; rollNo: string; pct: number; avatarUrl: string | null } => s.pct !== null && s.pct < 75)
        .sort((a, b) => a.pct - b.pct);
    }

    res.json({
      success: true,
      data: {
        teacher: {
          name: teacherName,
          prefix: teacherPrefix,
          institutionName,
          classTeacherDivisionName: classTeacherDivision
            ? `${classTeacherDivision.standard.name} - ${classTeacherDivision.name}`
            : null,
        },
        stats: {
          classesAssigned,
          subjectsTeaching,
          testsConducted,
          avgAttendancePct,
        },
        attendanceTrend,
        shortAttendance,
        auditLogs: auditLogRows.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() })),
      },
    });
  } catch (err) {
    next(err);
  }
}

// Self-service — a teacher's own AI usage against the shared institution pool.
// Scoped entirely from the JWT's userId; there is no :id param, so a teacher
// can never query another teacher's usage through this route.
export async function getMyAiUsage(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution associated with this account" });
      return;
    }

    const teacher = await academicDb().teacher.findFirst({ where: { userId, institutionId } });
    if (!teacher) {
      res.status(404).json({ success: false, error: "Teacher profile not found" });
      return;
    }

    const range = (req.query.range as string) ?? "1M";
    const from = rangeToFromDate(range as "7D" | "1M" | "3M" | "6M" | "YTD");
    const to = new Date();

    const [summary, institutionLimit, poolUsedRaw] = await Promise.all([
      getTeacherUsageSummary(institutionId, teacher.id, from, to),
      getInstitutionAiTokenLimit(institutionId),
      redis?.get(`ai:usage:institution:${institutionId}`) ?? Promise.resolve(null),
    ]);

    const events = await prisma.aiUsageEvent.findMany({
      where: { institutionId, teacherId: teacher.id, createdAt: { gte: from } },
      select: { createdAt: true, totalTokens: true },
    });
    const trend = bucketEvents(events, bucketGranularity(range), from, to);

    const institutionPoolUsed = Number(poolUsedRaw ?? 0) || 0;

    res.json({
      success: true,
      data: {
        totalRequests: summary.totalRequests,
        successRequests: summary.successRequests,
        failedRequests: summary.failedRequests,
        totalTokens: summary.totalTokens,
        institutionPoolLimit: institutionLimit,
        institutionPoolUsed,
        poolSharePct: institutionLimit > 0 ? Math.round((summary.totalTokens / institutionLimit) * 10000) / 100 : 0,
        byFeature: summary.byFeature,
        trend,
        softLimitTokens: summary.softLimitTokens,
        softLimitOverride: summary.softLimitOverride,
        isOverSoftLimit: summary.isOverSoftLimit,
      },
    });
  } catch (err) {
    next(err);
  }
}
